import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  applyStatusSchema,
  commentDraftSchema,
  commentSchema,
  roundSchema,
  versionSchema,
  viewSchema,
} from "../../../packages/contracts/src/index.js";
import type {
  Comment,
  PanelCommand,
  View,
  WorkerCommand,
  WorkerResult,
} from "../../../packages/contracts/src/index.js";
import {
  applyChanges,
  reviewUnitsBetween,
  reanchorComments,
} from "../../../packages/text/src/index.js";
import { readMarkdown, replaceMarkdown, writeAtomically } from "./files.js";

const count = z.number().int().nonnegative();
const receiptSchema = z.object({
  outcome: z.enum(["applied", "not-written"]).default("applied"),
  operationId: z.string(),
  fingerprint: z.string(),
  sourceDraftRevision: count.default(0),
  revision: count.nullable().default(null),
  version: z.number().int().positive().nullable().default(null),
});
const pendingSchema = z.object({
  operationId: z.string(),
  revision: count,
  sourceDraftRevision: count.default(0),
  before: z.string(),
  preview: z.string(),
  submittedComments: z.array(commentSchema).default([]),
  cleanComments: z.boolean().default(false),
});
const storedRoundSchema = z.intersection(
  roundSchema,
  z.object({ candidatePath: z.string() }),
);
const documentSchema = z.object({
  schemaVersion: z.literal(2).default(2),
  originalPath: z.string(),
  documentId: z.string(),
  threadId: z.string().nullable(),
  revision: count,
  draft: z.string(),
  draftRevision: count.default(0),
  comments: z.array(commentSchema),
  commentDraft: commentDraftSchema.nullable().default(null),
  workingBase: z.object({ version: z.number().int().positive() }),
  versions: z.array(versionSchema).nonempty(),
  round: storedRoundSchema.nullable(),
  generationReceipts: z.array(
    z.object({ requestId: z.string(), fingerprint: z.string() }),
  ),
  submittedExecutions: z.array(z.string()),
  retiredExecutions: z
    .array(z.object({ executionId: z.string(), ended: z.boolean() }))
    .default([]),
  pendingApply: pendingSchema.nullable(),
  appliedReceipts: z.array(receiptSchema),
  applyStatus: applyStatusSchema.nullable().default(null),
});
type Document = z.infer<typeof documentSchema>;
type Round = z.infer<typeof storedRoundSchema>;
type Review = Extract<Round, { phase: "review" }>;
type Generate = Extract<PanelCommand, { action: "generate" }>;

export class CommandError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class DocumentService {
  private state: Document;
  constructor(
    private readonly db: DatabaseSync,
    originalPath: string,
    private readonly runtimeDir: string,
    resetThreadBinding = false,
  ) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS document (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL) STRICT",
    );
    const row = db.prepare("SELECT body FROM document WHERE id = 1").get();
    if (row) {
      if (typeof row.body !== "string") throw new Error("文稿记录无效。");
      this.state = migrateDocument(JSON.parse(row.body));
      if (this.state.originalPath !== originalPath)
        throw new Error("此运行目录已经绑定另一份文稿。");
      const round = this.state.round;
      if (round?.phase === "editing") {
        this.update({
          round: {
            ...round,
            phase: "interrupted",
            executionEnded: false,
            message: "执行连接已中断，等待执行结束的凭据。",
          },
          retiredExecutions: [
            ...this.state.retiredExecutions,
            { executionId: round.executionId, ended: false },
          ],
        });
      }
      if (resetThreadBinding && this.state.threadId !== null)
        this.persist({ ...this.state, threadId: null });
      this.reconcileApply(false);
      return;
    }
    const body = readBoundedMarkdown(originalPath);
    this.state = documentSchema.parse({
      originalPath,
      documentId: randomUUID(),
      threadId: null,
      revision: 0,
      draft: body,
      comments: [],
      versions: [{ number: 1, body, savedAt: new Date().toISOString() }],
      workingBase: { version: 1 },
      round: null,
      generationReceipts: [],
      submittedExecutions: [],
      pendingApply: null,
      appliedReceipts: [],
    });
    this.persist(this.state);
  }

  view(): View {
    const s = this.state;
    const round = s.round;
    return viewSchema.parse({
      documentId: s.documentId,
      documentName: basename(s.originalPath),
      revision: s.revision,
      draftRevision: s.draftRevision,
      draft: s.draft,
      comments: s.comments,
      commentDraft: s.commentDraft,
      workingBase: s.workingBase,
      versions: s.versions,
      round:
        round?.phase === "review"
          ? { ...round, preview: reviewPreview(round) }
          : round,
      applyStatus: s.pendingApply
        ? {
            phase: "checking",
            operationId: s.pendingApply.operationId,
            revision: s.pendingApply.revision,
            sourceDraftRevision: s.pendingApply.sourceDraftRevision,
          }
        : s.applyStatus,
    });
  }

  panel(command: PanelCommand): View {
    if (command.action === "recheck") {
      if (this.state.pendingApply?.operationId === command.operationId)
        this.reconcileApply(false);
      else if (
        !this.state.appliedReceipts.some(
          (r) => r.operationId === command.operationId,
        ) &&
        !(
          this.state.applyStatus?.phase === "not-written" &&
          this.state.applyStatus.operationId === command.operationId
        )
      )
        throw new CommandError(409, "找不到需要核对的写入。");
      return this.view();
    }
    if (command.action === "apply") return this.apply(command);
    if (command.action === "generate") return this.generate(command);
    if (command.action === "retry") {
      const round = this.expectRound(command.revision, command.roundId);
      if (round.phase !== "interrupted" || !round.executionEnded)
        throw new CommandError(409, "上次执行尚未确认结束。");
      if (
        this.state.draft !== round.base ||
        this.state.draftRevision !== round.sourceDraftRevision ||
        this.state.commentDraft
      )
        throw new CommandError(409, "工作稿已变动，请重新生成。");
      return this.generate({
        action: "generate",
        revision: command.revision,
        draft: round.base,
        draftRevision: round.sourceDraftRevision,
        comments: round.submittedComments,
        commentDraft: null,
        requestId: command.requestId,
      });
    }
    this.expectRevision(command.revision);
    if (this.state.pendingApply)
      throw new CommandError(409, "原文件写入待核对。");
    if (command.action === "save") {
      this.expectEditable();
      checkDraft(command.draft, command.comments);
      const changed = command.draft !== this.state.draft;
      const draftRevision = changed
        ? Math.max(command.draftRevision, this.state.draftRevision + 1)
        : this.state.draftRevision;
      const comments = command.comments.map((note) => {
        const previous = this.state.comments.find((old) => old.id === note.id);
        const sameAnchor =
          previous &&
          previous.start === note.start &&
          previous.end === note.end &&
          previous.quote === note.quote &&
          previous.resolved === note.resolved;
        const anchored = sameAnchor
          ? reanchorComments([note], this.state.draft, command.draft)[0]
          : {
              ...note,
              resolved:
                note.resolved &&
                command.draft.slice(note.start, note.end) === note.quote,
            };
        const edited =
          previous &&
          (previous.instruction !== anchored.instruction ||
            previous.quote !== anchored.quote ||
            previous.start !== anchored.start ||
            previous.end !== anchored.end ||
            previous.resolved !== anchored.resolved);
        return {
          ...anchored,
          revision: edited
            ? Math.max(note.revision, previous.revision + 1)
            : (previous?.revision ?? note.revision),
        };
      });
      this.update({
        draft: command.draft,
        draftRevision,
        comments,
        commentDraft: command.commentDraft,
        round:
          this.state.round?.phase === "interrupted" &&
          !this.state.round.executionEnded
            ? this.state.round
            : null,
        applyStatus: null,
      });
      return this.view();
    }
    if (command.action === "adopt") {
      if (this.state.retiredExecutions.some((r) => !r.ended))
        throw new CommandError(409, "上次执行尚未确认结束。");
      if (
        this.state.round?.phase === "waiting" ||
        this.state.round?.phase === "editing"
      )
        throw new CommandError(409, "请先停止生成。");
      if (this.state.commentDraft)
        throw new CommandError(409, "请先完成正在编辑的批注。");
      const version = this.state.versions.find(
        (v) => v.number === command.version,
      );
      if (!version) throw new CommandError(400, "找不到这个版本。");
      this.update({
        draft: version.body,
        draftRevision: this.state.draftRevision + 1,
        workingBase: { version: version.number },
        comments: [],
        commentDraft: null,
        round: null,
        applyStatus: null,
      });
      return this.view();
    }
    const round = this.expectRound(command.revision, command.roundId);
    if (command.action === "cancel") {
      if (round.phase !== "waiting" && round.phase !== "editing")
        throw new CommandError(409, "没有正在生成的任务。");
      const executionId = round.phase === "editing" ? round.executionId : null;
      this.update({
        round: {
          ...round,
          phase: "interrupted",
          executionId,
          executionEnded: executionId === null,
          message: executionId
            ? "已停止接收建议，等待执行结束的凭据。"
            : "已停止生成。",
        },
        retiredExecutions: executionId
          ? [...this.state.retiredExecutions, { executionId, ended: false }]
          : this.state.retiredExecutions,
      });
    } else if (command.action === "abandon") {
      if (round.phase === "interrupted" && !round.executionEnded)
        throw new CommandError(409, "上次执行尚未确认结束。");
      if (
        round.phase !== "review" &&
        round.phase !== "empty" &&
        round.phase !== "interrupted"
      )
        throw new CommandError(409, "请先停止生成。");
      this.update({ round: null, applyStatus: null });
    } else {
      if (round.phase !== "review")
        throw new CommandError(409, "当前没有可审阅的建议。");
      if (!round.changes.some((c) => c.id === command.changeId))
        throw new CommandError(400, "找不到这项修改。");
      const updated = {
        ...round,
        decisions: {
          ...round.decisions,
          [command.changeId]: command.keep
            ? ("keep" as const)
            : ("discard" as const),
        },
      };
      const preview = reviewPreview(updated);
      if (!viewSchema.shape.draft.safeParse(preview).success)
        throw new CommandError(400, "保留这些修改会让文稿超出长度限制。");
      this.update({ round: { ...updated, preview } });
    }
    return this.view();
  }

  worker(command: WorkerCommand): WorkerResult {
    const s = this.state;
    if (command.action === "bind") {
      if (s.threadId !== null) this.expectThread(command.threadId);
      if (command.path) {
        let path: string;
        try {
          path = realpathSync(command.path);
        } catch {
          throw new CommandError(400, "找不到指定的文稿路径。");
        }
        if (path !== s.originalPath)
          throw new CommandError(400, "文稿路径与此运行目录的绑定不符。");
      }
      if (s.threadId === null)
        this.persist({ ...s, threadId: command.threadId });
      return { status: "bound" };
    }
    this.expectThread(command.threadId);
    const round = s.round;
    if (command.action === "claim") {
      if (round?.phase !== "waiting") return { status: "idle" };
      const executionId = randomUUID();
      this.update({ round: { ...round, phase: "editing", executionId } });
      return {
        status: "claimed",
        executionId,
        candidatePath: round.candidatePath,
        comments: round.submittedComments,
      };
    }
    const retired = s.retiredExecutions.find(
      (r) => r.executionId === command.executionId,
    );
    if (retired) {
      if (!retired.ended)
        this.update({
          retiredExecutions: s.retiredExecutions.map((r) =>
            r.executionId === command.executionId ? { ...r, ended: true } : r,
          ),
          round:
            round?.phase === "interrupted" &&
            round.executionId === command.executionId
              ? { ...round, executionEnded: true, message: "上次执行已结束。" }
              : round,
        });
      return { status: command.action === "submit" ? "submitted" : "finished" };
    }
    if (s.submittedExecutions.includes(command.executionId))
      return { status: command.action === "submit" ? "submitted" : "finished" };
    if (round?.phase !== "editing" || round.executionId !== command.executionId)
      throw new CommandError(409, "此次执行已经失效。");
    if (command.action === "finish") {
      this.update({
        round: {
          ...round,
          phase: "interrupted",
          executionEnded: true,
          message:
            command.outcome === "failed"
              ? "执行失败，可以重试。"
              : "执行已取消。",
        },
        retiredExecutions: [
          ...s.retiredExecutions,
          { executionId: command.executionId, ended: true },
        ],
      });
      return { status: "finished" };
    }
    const candidate = readBoundedMarkdown(round.candidatePath);
    const changes = reviewUnitsBetween(round.base, candidate);
    this.update({
      round: changes.length
        ? {
            ...round,
            phase: "review",
            candidate,
            changes,
            decisions: {},
            preview: round.base,
          }
        : { ...round, phase: "empty" },
      submittedExecutions: [...s.submittedExecutions, command.executionId],
    });
    return { status: "submitted" };
  }

  private generate(command: Generate): View {
    const s = this.state;
    const fingerprint = digest(JSON.stringify(command));
    const receipt = s.generationReceipts.find(
      (r) => r.requestId === command.requestId,
    );
    if (receipt) {
      if (receipt.fingerprint !== fingerprint)
        throw new CommandError(409, "此生成编号已经用于另一项请求。");
      return this.view();
    }
    this.expectRevision(command.revision);
    this.expectEditable();
    if (s.retiredExecutions.some((r) => !r.ended))
      throw new CommandError(409, "上次执行尚未确认结束，不能开始新任务。");
    checkDraft(command.draft, command.comments);
    if (command.commentDraft)
      throw new CommandError(400, "请先完成正在编辑的批注。");
    if (!command.comments.length) throw new CommandError(400, "请先添加批注。");
    const comments = command.comments.map((c) =>
      anchorComment(command.draft, c),
    );
    const id = randomUUID();
    const directory = join(this.runtimeDir, id);
    mkdirSync(directory, { mode: 0o700 });
    const candidatePath = join(directory, "candidate.md");
    writeAtomically(candidatePath, command.draft, 0o600);
    const draftRevision =
      command.draft === s.draft
        ? s.draftRevision
        : Math.max(command.draftRevision, s.draftRevision + 1);
    this.update({
      draft: command.draft,
      draftRevision,
      comments,
      commentDraft: null,
      applyStatus: null,
      round: {
        id,
        phase: "waiting",
        base: command.draft,
        sourceDraftRevision: draftRevision,
        submittedComments: comments,
        candidatePath,
      },
      generationReceipts: [
        ...s.generationReceipts,
        { requestId: command.requestId, fingerprint },
      ],
    });
    return this.view();
  }

  private apply(command: Extract<PanelCommand, { action: "apply" }>): View {
    const s = this.state;
    const receipt = s.appliedReceipts.find(
      (r) => r.operationId === command.operationId,
    );
    if (receipt) {
      if (
        receipt.fingerprint !== digest(command.preview) ||
        (receipt.revision !== null && receipt.revision !== command.revision)
      )
        throw new CommandError(409, "此写入编号已经用于另一项请求。");
      return this.view();
    }
    if (s.pendingApply) {
      if (
        s.pendingApply.operationId !== command.operationId ||
        s.pendingApply.preview !== command.preview ||
        s.pendingApply.revision !== command.revision
      )
        throw new CommandError(409, "请先核对上一次写入。");
      this.reconcileApply(false);
      return this.view();
    }
    this.expectRevision(command.revision);
    const round = s.round;
    if (
      round?.phase === "waiting" ||
      round?.phase === "editing" ||
      round?.phase === "interrupted"
    )
      throw new CommandError(409, "请先完成本轮生成。");
    if (s.commentDraft) throw new CommandError(409, "请先完成正在编辑的批注。");
    if (
      round?.phase === "review" &&
      round.changes.some((c) => !round.decisions[c.id])
    )
      throw new CommandError(409, "请先逐项选择修改。");
    const preview = round?.phase === "review" ? reviewPreview(round) : s.draft;
    if (command.preview !== preview)
      throw new CommandError(409, "预览已变动，请核对后再应用。");
    const workingBase = s.versions.find(
      (v) => v.number === s.workingBase.version,
    );
    if (workingBase?.body === preview)
      throw new CommandError(409, "工作稿还没有需要保存的修改。");
    const before = this.readOriginal();
    if (before !== this.latestVersion().body)
      throw new CommandError(409, "原文件已经变动，写入已停止。");
    this.update({
      pendingApply: {
        operationId: command.operationId,
        revision: command.revision,
        sourceDraftRevision: s.draftRevision,
        before,
        preview,
        submittedComments: round?.submittedComments ?? [],
        cleanComments:
          round?.phase === "review" &&
          Object.values(round.decisions).includes("keep"),
      },
    });
    this.reconcileApply(true);
    return this.view();
  }

  private reconcileApply(write: boolean): void {
    const s = this.state;
    const pending = s.pendingApply;
    if (!pending) return;
    let actual: string;
    try {
      actual = this.readOriginal();
      if (write && actual === pending.before && actual !== pending.preview) {
        replaceMarkdown(s.originalPath, pending.before, pending.preview);
        actual = this.readOriginal();
      }
    } catch {
      return;
    }
    if (actual === pending.before && actual !== pending.preview) {
      if (!write)
        this.update({
          pendingApply: null,
          applyStatus: {
            phase: "not-written",
            operationId: pending.operationId,
            sourceDraftRevision: pending.sourceDraftRevision,
          },
          appliedReceipts: [
            ...s.appliedReceipts,
            {
              outcome: "not-written",
              operationId: pending.operationId,
              fingerprint: digest(pending.preview),
              revision: pending.revision,
              sourceDraftRevision: pending.sourceDraftRevision,
              version: this.latestVersion().number,
            },
          ],
        });
      return;
    }
    if (actual !== pending.preview) return;
    const latest = this.latestVersion();
    const number = actual === latest.body ? latest.number : latest.number + 1;
    this.update({
      draft: actual,
      comments: pending.cleanComments
        ? s.comments.filter(
            (c) =>
              !pending.submittedComments.some(
                (old) => old.id === c.id && old.revision === c.revision,
              ),
          )
        : s.comments,
      commentDraft: null,
      round: null,
      pendingApply: null,
      workingBase: { version: number },
      applyStatus: {
        phase: "applied",
        operationId: pending.operationId,
        sourceDraftRevision: pending.sourceDraftRevision,
        version: number,
      },
      versions:
        number === latest.number
          ? s.versions
          : [
              ...s.versions,
              {
                number,
                body: actual,
                savedAt: new Date().toISOString(),
                parentVersion: s.workingBase.version,
                operationId: pending.operationId,
              },
            ],
      appliedReceipts: [
        ...s.appliedReceipts,
        {
          outcome: "applied",
          operationId: pending.operationId,
          fingerprint: digest(pending.preview),
          sourceDraftRevision: pending.sourceDraftRevision,
          revision: pending.revision,
          version: number,
        },
      ],
    });
  }

  private readOriginal(): string {
    const path = this.state.originalPath;
    if (realpathSync(path) !== path)
      throw new CommandError(409, "原文件路径已经变动，写入已停止。");
    return readMarkdown(path);
  }

  private expectThread(threadId: string): void {
    if (this.state.threadId !== threadId)
      throw new CommandError(403, "此文稿属于另一个对话，或尚未绑定。");
  }
  private expectRevision(revision: number): void {
    if (this.state.revision !== revision)
      throw new CommandError(409, "文稿已变动，请刷新后重试。");
  }
  private expectRound(revision: number, roundId: string): Round {
    this.expectRevision(revision);
    const round = this.state.round;
    if (!round || round.id !== roundId)
      throw new CommandError(409, "本轮任务已经变动。");
    return round;
  }
  private expectEditable(): void {
    if (this.state.pendingApply)
      throw new CommandError(409, "原文件写入待核对。");
    const phase = this.state.round?.phase;
    if (phase && phase !== "empty" && phase !== "interrupted")
      throw new CommandError(409, "请先完成本轮改稿和审阅。");
  }
  private latestVersion(): Document["versions"][number] {
    const version = this.state.versions.at(-1);
    if (!version) throw new Error("文稿没有版本。");
    return version;
  }
  private update(patch: Partial<Document>): void {
    this.persist({
      ...this.state,
      ...patch,
      revision: this.state.revision + 1,
    });
  }
  private persist(state: Document): void {
    const validated = documentSchema.parse(state);
    this.db
      .prepare(
        "INSERT INTO document (id, body) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body",
      )
      .run(JSON.stringify(validated));
    this.state = validated;
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function readBoundedMarkdown(path: string): string {
  const value = readMarkdown(path);
  if (!viewSchema.shape.draft.safeParse(value).success)
    throw new CommandError(400, "文稿超出长度限制。");
  return value;
}
function reviewPreview(round: Review): string {
  return applyChanges(
    round.base,
    round.changes,
    round.changes
      .filter((c) => round.decisions[c.id] === "keep")
      .map((c) => c.id),
  );
}
function checkDraft(draft: string, comments: Comment[]): void {
  if (Buffer.from(draft).toString("utf8") !== draft)
    throw new CommandError(400, "工作稿包含无效的 Unicode 字符。");
  if (new Set(comments.map((c) => c.id)).size !== comments.length)
    throw new CommandError(400, "批注编号重复。");
}
function anchorComment(draft: string, comment: Comment): Comment {
  if (!comment.resolved)
    throw new CommandError(400, "批注已失去定位，请重新选择。");
  if (
    comment.end > comment.start &&
    draft.slice(comment.start, comment.end) === comment.quote
  )
    return comment;
  const start = draft.indexOf(comment.quote);
  if (start < 0 || draft.indexOf(comment.quote, start + 1) >= 0)
    throw new CommandError(400, "找不到批注选区，请重新选择。");
  return { ...comment, start, end: start + comment.quote.length };
}

function migrateDocument(input: unknown): Document {
  const legacy = z
    .object({
      schemaVersion: z.union([z.literal(1), z.literal(2)]).optional(),
      originalPath: z.string(),
      revision: count,
      versions: z.array(versionSchema).nonempty(),
      appliedReceipts: z.array(receiptSchema),
      appliedVersion: z.number().int().positive().nullable().optional(),
      round: z
        .object({
          phase: z.string(),
          base: z.string(),
          candidatePath: z.string(),
          comments: z.array(commentSchema).optional(),
          submittedComments: z.array(commentSchema).optional(),
          changes: z
            .array(
              z.object({
                id: z.string(),
                start: count,
                end: count,
                before: z.string(),
                after: z.string(),
              }),
            )
            .optional(),
          decisions: z
            .record(z.string(), z.enum(["keep", "discard"]))
            .optional(),
        })
        .passthrough()
        .nullable(),
    })
    .passthrough()
    .parse(input);
  const round = legacy.round;
  const normalized = round
    ? {
        id: `legacy-${digest(round.candidatePath).slice(0, 24)}`,
        submittedComments: round.submittedComments ?? round.comments ?? [],
        sourceDraftRevision: 0,
        ...round,
      }
    : null;
  if (
    normalized?.phase === "review" &&
    normalized.changes &&
    normalized.decisions
  )
    Object.assign(normalized, {
      preview: applyChanges(
        normalized.base,
        normalized.changes,
        normalized.changes
          .filter((c) => normalized.decisions?.[c.id] === "keep")
          .map((c) => c.id),
      ),
    });
  const lastReceipt = legacy.appliedReceipts.at(-1);
  const legacyStatus =
    legacy.appliedVersion && lastReceipt
      ? {
          phase: "applied",
          operationId: lastReceipt.operationId,
          sourceDraftRevision: lastReceipt.sourceDraftRevision,
          version: legacy.appliedVersion,
        }
      : null;
  return documentSchema.parse({
    applyStatus: legacyStatus,
    documentId: digest(legacy.originalPath),
    workingBase: { version: legacy.versions.at(-1)?.number ?? 1 },
    ...legacy,
    schemaVersion: 2,
    round: normalized,
  });
}
