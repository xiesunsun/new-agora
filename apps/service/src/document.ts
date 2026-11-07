import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { viewSchema } from "../../../packages/contracts/src/index.js";
import type {
  Change,
  Comment,
  PanelCommand,
  View,
  WorkerCommand,
  WorkerResult,
} from "../../../packages/contracts/src/index.js";
import {
  applyChanges,
  changesBetween,
} from "../../../packages/text/src/index.js";
import { readMarkdown, replaceMarkdown, writeAtomically } from "./files.js";

type RoundSeed = {
  base: string;
  comments: Comment[];
  candidatePath: string;
};

type Round = RoundSeed &
  (
    | { phase: "waiting" }
    | { phase: "editing"; executionId: string }
    | { phase: "empty"; candidate: string }
    | {
        phase: "review";
        candidate: string;
        changes: Change[];
        decisions: Record<string, "keep" | "discard">;
      }
  );

type Version = View["versions"][number];

type ApplyCommand = Extract<PanelCommand, { action: "apply" }>;
type GenerateCommand = Extract<PanelCommand, { action: "generate" }>;

type PendingApply = {
  operationId: string;
  revision: number;
  before: string;
  preview: string;
};

type Document = {
  originalPath: string;
  threadId: string | null;
  revision: number;
  draft: string;
  comments: Comment[];
  versions: [Version, ...Version[]];
  round: Round | null;
  generationReceipts: { requestId: string; fingerprint: string }[];
  submittedExecutions: string[];
  pendingApply: PendingApply | null;
  appliedReceipts: { operationId: string; fingerprint: string }[];
  appliedVersion: number | null;
};

export class CommandError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class DocumentService {
  private readonly db: DatabaseSync;
  private readonly runtimeDir: string;
  private state: Document;

  constructor(db: DatabaseSync, originalPath: string, runtimeDir: string) {
    this.db = db;
    this.runtimeDir = runtimeDir;
    db.exec(`
      CREATE TABLE IF NOT EXISTS document (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        body TEXT NOT NULL
      ) STRICT
    `);
    const row = db.prepare("SELECT body FROM document WHERE id = 1").get();
    if (row) {
      if (typeof row.body !== "string") throw new Error("文稿记录无效。");
      const saved = JSON.parse(row.body) as Document;
      if (saved.originalPath !== originalPath) {
        throw new Error("此运行目录已经绑定另一份文稿。");
      }
      this.state = saved;
      this.reconcileApply(false);
      return;
    }

    const body = readBoundedMarkdown(originalPath);
    this.state = {
      originalPath,
      threadId: null,
      revision: 0,
      draft: body,
      comments: [],
      versions: [{ number: 1, body }],
      round: null,
      generationReceipts: [],
      submittedExecutions: [],
      pendingApply: null,
      appliedReceipts: [],
      appliedVersion: null,
    };
    this.persist(this.state);
  }

  view(): View {
    const state = this.state;
    const round = state.round;
    let projectedRound: View["round"] = null;
    if (round?.phase === "review") {
      projectedRound = {
        phase: round.phase,
        changes: round.changes,
        decisions: round.decisions,
        preview: reviewPreview(round),
      };
    } else if (round) {
      projectedRound = { phase: round.phase };
    }
    return {
      documentName: basename(state.originalPath),
      revision: state.revision,
      draft: state.draft,
      comments: state.comments,
      versions: state.versions,
      round: projectedRound,
      applyStatus: state.pendingApply
        ? {
            phase: "checking",
            operationId: state.pendingApply.operationId,
            revision: state.pendingApply.revision,
          }
        : state.appliedVersion === null
          ? null
          : { phase: "applied", version: state.appliedVersion },
    };
  }

  panel(command: PanelCommand): View {
    if (command.action === "generate") return this.generate(command);
    if (command.action === "apply") return this.apply(command);

    const state = this.state;
    this.expectRevision(command.revision);
    if (state.pendingApply) throw new CommandError(409, "原文件写入待核对。");
    if (command.action === "save") {
      this.expectEditable();
      checkDraft(command.draft, command.comments);
      this.update({
        draft: command.draft,
        comments: command.comments,
        round: null,
        appliedVersion: null,
      });
    } else {
      const round = state.round;
      if (round?.phase !== "review") {
        throw new CommandError(409, "当前没有可审阅的建议。");
      }
      if (!round.changes.some(({ id }) => id === command.changeId)) {
        throw new CommandError(400, "找不到这项修改。");
      }
      const updated: Extract<Round, { phase: "review" }> = {
        ...round,
        decisions: {
          ...round.decisions,
          [command.changeId]: command.keep ? "keep" : "discard",
        },
      };
      if (!viewSchema.shape.draft.safeParse(reviewPreview(updated)).success) {
        throw new CommandError(400, "保留这些修改会让文稿超出长度限制。");
      }
      this.update({ round: updated });
    }
    return this.view();
  }

  worker(command: WorkerCommand): WorkerResult {
    const state = this.state;
    if (command.action === "bind") {
      if (state.threadId !== null) this.expectThread(command.threadId);
      if (command.path) {
        let requestedPath: string;
        try {
          requestedPath = realpathSync(command.path);
        } catch {
          throw new CommandError(400, "找不到指定的文稿路径。");
        }
        if (requestedPath !== state.originalPath) {
          throw new CommandError(400, "文稿路径与此运行目录的绑定不符。");
        }
      }
      if (state.threadId === null)
        this.persist({ ...state, threadId: command.threadId });
      return { status: "bound" };
    }
    this.expectThread(command.threadId);
    const round = state.round;

    if (command.action === "claim") {
      if (round?.phase !== "waiting") return { status: "idle" };
      const executionId = randomUUID();
      this.update({ round: { ...round, phase: "editing", executionId } });
      return {
        status: "claimed",
        executionId,
        candidatePath: round.candidatePath,
        comments: round.comments,
      };
    }

    if (state.submittedExecutions.includes(command.executionId)) {
      return { status: "submitted" };
    }
    if (
      round?.phase !== "editing" ||
      round.executionId !== command.executionId
    ) {
      throw new CommandError(409, "此次执行已经失效。");
    }
    const candidate = readBoundedMarkdown(round.candidatePath);
    const changes = changesBetween(round.base, candidate);
    const seed = {
      base: round.base,
      comments: round.comments,
      candidatePath: round.candidatePath,
    };
    this.update({
      round: changes.length
        ? { ...seed, phase: "review", candidate, changes, decisions: {} }
        : { ...seed, phase: "empty", candidate },
      submittedExecutions: [...state.submittedExecutions, command.executionId],
    });
    return { status: "submitted" };
  }

  private generate(command: GenerateCommand): View {
    const state = this.state;
    const fingerprint = digest(JSON.stringify(command));
    const receipt = state.generationReceipts.find(
      ({ requestId }) => requestId === command.requestId,
    );
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) {
        throw new CommandError(409, "此生成编号已经用于另一项请求。");
      }
      return this.view();
    }
    this.expectRevision(command.revision);
    this.expectEditable();
    checkDraft(command.draft, command.comments);
    if (command.comments.length === 0) {
      throw new CommandError(400, "请先添加批注。");
    }

    const comments = command.comments.map((comment) =>
      anchorComment(command.draft, comment),
    );
    const candidateDir = join(this.runtimeDir, randomUUID());
    mkdirSync(candidateDir, { mode: 0o700 });
    const candidatePath = join(candidateDir, "candidate.md");
    writeAtomically(candidatePath, command.draft, 0o600);

    this.update({
      draft: command.draft,
      comments,
      appliedVersion: null,
      round: { phase: "waiting", base: command.draft, comments, candidatePath },
      generationReceipts: [
        ...state.generationReceipts,
        { requestId: command.requestId, fingerprint },
      ],
    });
    return this.view();
  }

  private apply(command: ApplyCommand): View {
    const state = this.state;
    const receipt = state.appliedReceipts.find(
      ({ operationId }) => operationId === command.operationId,
    );
    if (receipt) {
      if (receipt.fingerprint !== digest(command.preview)) {
        throw new CommandError(409, "此写入编号已经用于另一项请求。");
      }
      return this.view();
    }

    const pending = state.pendingApply;
    if (pending) {
      if (
        pending.operationId !== command.operationId ||
        pending.preview !== command.preview
      ) {
        throw new CommandError(409, "请先核对上一次写入。");
      }
      if (command.revision !== pending.revision)
        this.expectRevision(command.revision);
    } else {
      this.expectRevision(command.revision);
      if (
        state.round?.phase === "waiting" ||
        state.round?.phase === "editing"
      ) {
        throw new CommandError(409, "请等待改稿完成。");
      }
      const projected = this.view();
      const preview =
        projected.round?.phase === "review"
          ? projected.round.preview
          : state.draft;
      if (command.preview !== preview) {
        throw new CommandError(409, "预览已变动，请核对后再应用。");
      }

      const before = readMarkdown(state.originalPath);
      if (before !== this.currentVersion().body) {
        throw new CommandError(409, "原文件已经变动，写入已停止。");
      }
      this.update({
        pendingApply: {
          operationId: command.operationId,
          revision: command.revision,
          before,
          preview,
        },
      });
    }
    this.reconcileApply(true);
    return this.view();
  }

  private reconcileApply(retry: boolean): void {
    const state = this.state;
    const pending = state.pendingApply;
    if (!pending) return;

    let actual: string;
    try {
      actual = readMarkdown(state.originalPath);
      if (retry && actual === pending.before && actual !== pending.preview) {
        replaceMarkdown(state.originalPath, pending.before, pending.preview);
        actual = readMarkdown(state.originalPath);
      }
    } catch {
      return;
    }
    if (actual !== pending.preview) return;

    const latest = this.currentVersion();
    const version = actual === latest.body ? latest.number : latest.number + 1;
    this.update({
      draft: actual,
      comments: [],
      round: null,
      pendingApply: null,
      appliedVersion: version,
      versions:
        version === latest.number
          ? state.versions
          : [...state.versions, { number: version, body: actual }],
      appliedReceipts: [
        ...state.appliedReceipts,
        {
          operationId: pending.operationId,
          fingerprint: digest(pending.preview),
        },
      ],
    });
  }

  private expectThread(threadId: string): void {
    if (this.state.threadId !== threadId) {
      throw new CommandError(403, "此文稿属于另一个对话，或尚未绑定。");
    }
  }

  private expectRevision(revision: number): void {
    if (this.state.revision !== revision) {
      throw new CommandError(409, "文稿已变动，请刷新后重试。");
    }
  }

  private expectEditable(): void {
    if (this.state.pendingApply)
      throw new CommandError(409, "原文件写入待核对。");
    const phase = this.state.round?.phase;
    if (phase && phase !== "empty") {
      throw new CommandError(409, "请先完成本轮改稿和审阅。");
    }
  }

  private currentVersion(): Version {
    const versions = this.state.versions;
    return versions.at(-1) ?? versions[0];
  }

  private update(patch: Partial<Document>): void {
    this.persist({
      ...this.state,
      ...patch,
      revision: this.state.revision + 1,
    });
  }

  private persist(state: Document): void {
    this.db
      .prepare(
        "INSERT INTO document (id, body) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body",
      )
      .run(JSON.stringify(state));
    this.state = state;
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function readBoundedMarkdown(path: string): string {
  const body = readMarkdown(path);
  if (!viewSchema.shape.draft.safeParse(body).success) {
    throw new CommandError(400, "文稿超出长度限制。");
  }
  return body;
}

function reviewPreview(round: Extract<Round, { phase: "review" }>): string {
  const kept = round.changes.filter(({ id }) => round.decisions[id] === "keep");
  return applyChanges(
    round.base,
    round.changes,
    kept.map(({ id }) => id),
  );
}

function checkDraft(draft: string, comments: Comment[]): void {
  if (Buffer.from(draft).toString("utf8") !== draft) {
    throw new CommandError(400, "工作稿包含无效的 Unicode 字符。");
  }
  if (new Set(comments.map(({ id }) => id)).size !== comments.length) {
    throw new CommandError(400, "批注编号重复。");
  }
}

function anchorComment(draft: string, comment: Comment): Comment {
  if (
    comment.end > comment.start &&
    comment.end <= draft.length &&
    draft.slice(comment.start, comment.end) === comment.quote
  ) {
    return comment;
  }
  const start = draft.indexOf(comment.quote);
  if (start < 0 || draft.indexOf(comment.quote, start + 1) >= 0) {
    throw new CommandError(400, "找不到批注选区，请重新选择。");
  }
  return { ...comment, start, end: start + comment.quote.length };
}
