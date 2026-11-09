import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { startService } from "./support/service.mjs";

/** @param {import("node:test").TestContext} context @param {string} [body] */
async function setup(context, body = "# 稿件\n\n第一句。第二句。\n") {
  const root = await mkdtemp(join(tmpdir(), "agora-ink-service-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "copy.md");
  await writeFile(file, body);
  const runtime = join(root, "runtime");
  const service = await startService(context, file, runtime);
  const state = () => service.request("/api/state");
  /** @param {object} command */
  const panel = (command) => service.request("/api/panel", command);
  /** @param {object} command */
  const worker = (command) =>
    service.request("/api/worker", { ...command, threadId: "ink-test" });
  await worker({ action: "bind" });
  async function generate(requestId = "generation") {
    const view = await state();
    return panel({
      action: "generate",
      revision: view.revision,
      draft: view.draft,
      draftRevision: view.draftRevision ?? 0,
      commentDraft: null,
      comments: [
        {
          id: "note",
          start: 6,
          end: 9,
          quote: "第一句",
          instruction: "重写首句",
        },
      ],
      requestId,
    });
  }
  return {
    ...service,
    root,
    file,
    runtime,
    state,
    panel,
    worker,
    generate,
    body,
  };
}

test("Ink refuses undecided apply, preserves round identity on restart, then saves one receipt", async (context) => {
  const s = await setup(context);
  const waiting = await s.generate();
  const claim = await s.worker({ action: "claim" });
  await writeFile(claim.candidatePath, "# 稿件\n\n改后的首句。第二句。\n");
  await s.worker({ action: "submit", executionId: claim.executionId });
  let review = await s.state();
  await rejects(
    s.panel({
      action: "apply",
      revision: review.revision,
      operationId: "early",
      preview: review.round.preview,
    }),
  );
  equal(review.round.id, waiting.round.id);
  equal(review.round.base, s.body);
  const changes = review.round.changes;
  await s.stop();
  const reopened = await startService(context, s.file, s.runtime);
  review = await reopened.request("/api/state");
  deepStrictEqual(review.round.changes, changes);
  for (const change of changes)
    review = await reopened.request("/api/panel", {
      action: "choose",
      revision: review.revision,
      roundId: review.round.id,
      changeId: change.id,
      keep: true,
    });
  const command = {
    action: "apply",
    revision: review.revision,
    operationId: "accepted",
    preview: review.round.preview,
  };
  const applied = await reopened.request("/api/panel", command);
  equal(applied.applyStatus.operationId, "accepted");
  equal(applied.applyStatus.sourceDraftRevision, review.draftRevision);
  equal(applied.versions.length, 2);
  ok(applied.versions[1].savedAt);
  equal(applied.versions[1].operationId, "accepted");
  equal(await readFile(s.file, "utf8"), command.preview);
  deepStrictEqual(
    (await reopened.request("/api/panel", command)).versions,
    applied.versions,
  );
  deepStrictEqual(applied.comments, []);
});

test("cancelled claimed execution blocks every generate until late submit gives terminal evidence", async (context) => {
  const s = await setup(context);
  const waiting = await s.generate();
  const claim = await s.worker({ action: "claim" });
  const editing = await s.state();
  let interrupted = await s.panel({
    action: "cancel",
    revision: editing.revision,
    roundId: waiting.round.id,
  });
  equal(interrupted.round.phase, "interrupted");
  equal(interrupted.round.executionEnded, false);
  await rejects(s.generate("fresh-before-terminal"));
  await rejects(
    s.panel({
      action: "retry",
      revision: interrupted.revision,
      roundId: interrupted.round.id,
      requestId: "retry-before-terminal",
    }),
  );
  const edited = await s.panel({
    action: "save",
    revision: interrupted.revision,
    draft: s.body + "人类编辑。",
    comments: interrupted.comments,
  });
  equal(edited.round?.phase, "interrupted");
  equal(edited.round.executionEnded, false);
  await rejects(s.generate("edited-before-terminal"));
  await writeFile(claim.candidatePath, "迟到改稿");
  await s.worker({ action: "submit", executionId: claim.executionId });
  interrupted = await s.state();
  ok(interrupted.round === null || interrupted.round.phase !== "review");
  equal(interrupted.draft, s.body + "人类编辑。");
  const next = await s.generate("after-terminal");
  equal(next.round.phase, "waiting");
  ok(next.round.id !== waiting.round.id);
});

test("history adoption switches working base without file write or version and rejects stale adoption", async (context) => {
  const s = await setup(context);
  const initial = await s.state();
  const saved = await s.panel({
    action: "save",
    revision: initial.revision,
    draft: s.body + "新增。",
    comments: [],
  });
  const applied = await s.panel({
    action: "apply",
    revision: saved.revision,
    operationId: "second",
    preview: saved.draft,
  });
  const adopted = await s.panel({
    action: "adopt",
    revision: applied.revision,
    version: 1,
  });
  equal(adopted.draft, s.body);
  equal(adopted.workingBase.version, 1);
  equal(adopted.applyStatus, null);
  equal(adopted.versions.length, 2);
  equal(await readFile(s.file, "utf8"), saved.draft);
  await rejects(
    s.panel({ action: "adopt", revision: applied.revision, version: 2 }),
  );
  deepStrictEqual(await s.state(), adopted);
  await rejects(
    s.panel({
      action: "apply",
      revision: adopted.revision,
      operationId: "unedited-adopt",
      preview: adopted.draft,
    }),
  );
});

test("abandon and all-discard save preserve comments, worker failure enables frozen-input retry", async (context) => {
  const s = await setup(context);
  await s.generate();
  let claim = await s.worker({ action: "claim" });
  await s.worker({
    action: "finish",
    executionId: claim.executionId,
    outcome: "failed",
  });
  let view = await s.state();
  equal(view.round.phase, "interrupted");
  equal(view.round.executionEnded, true);
  view = await s.panel({
    action: "retry",
    revision: view.revision,
    roundId: view.round.id,
    requestId: "retry",
  });
  claim = await s.worker({ action: "claim" });
  await writeFile(claim.candidatePath, s.body.replace("第一句", "新首句"));
  await s.worker({ action: "submit", executionId: claim.executionId });
  view = await s.state();
  const note = view.comments;
  const abandoned = await s.panel({
    action: "abandon",
    revision: view.revision,
    roundId: view.round.id,
  });
  deepStrictEqual(abandoned.comments, note);
  equal(abandoned.draft, s.body);
  equal(abandoned.round, null);
});

test(
  "operation recheck never retries a failed write and later explicit save uses a new operation",
  { skip: process.getuid?.() === 0 },
  async (context) => {
    const s = await setup(context);
    const dir = join(s.root, "locked");
    await mkdir(dir);
    const target = join(dir, "copy.md");
    await writeFile(target, s.body);
    const service = await startService(
      context,
      target,
      join(s.root, "locked-runtime"),
    );
    const initial = await service.request("/api/state");
    const saved = await service.request("/api/panel", {
      action: "save",
      revision: initial.revision,
      draft: s.body + "新增。",
      comments: [],
    });
    const operation = {
      action: "apply",
      revision: saved.revision,
      operationId: "failed-write",
      preview: saved.draft,
    };
    await chmod(dir, 0o500);
    const pending = await service.request("/api/panel", operation);
    equal(pending.applyStatus.phase, "checking");
    await chmod(dir, 0o700);
    const checked = await service.request("/api/panel", {
      action: "recheck",
      operationId: operation.operationId,
    });
    equal(checked.applyStatus.phase, "not-written");
    equal(await readFile(target, "utf8"), s.body);
    equal(checked.versions.length, 1);
    await rejects(
      service.request("/api/panel", {
        ...operation,
        revision: checked.revision,
      }),
    );
    const applied = await service.request("/api/panel", {
      ...operation,
      operationId: "explicit-next",
      revision: checked.revision,
    });
    equal(applied.versions.length, 2);
    equal(await readFile(target, "utf8"), saved.draft);
    await rejects(
      service.request("/api/panel", {
        action: "recheck",
        operationId: "unrelated",
      }),
    );
  },
);

test("adoption persistence failure preserves draft, comments and version lineage", async (context) => {
  const s = await setup(context);
  const initial = await s.state();
  const saved = await s.panel({
    action: "save",
    revision: initial.revision,
    draft: s.body + "更改。",
    comments: [],
  });
  const db = new DatabaseSync(join(s.runtime, "document.sqlite"));
  context.after(() => db.close());
  db.exec(
    "CREATE TRIGGER reject_update BEFORE UPDATE ON document BEGIN SELECT RAISE(FAIL, 'persistence failure'); END",
  );
  await rejects(
    s.panel({ action: "adopt", revision: saved.revision, version: 1 }),
  );
  deepStrictEqual(await s.state(), saved);
  equal(await readFile(s.file, "utf8"), s.body);
});

test("legacy persisted review IDs and unknown timestamps survive validated migration", async (context) => {
  const s = await setup(context);
  await s.stop();
  const db = new DatabaseSync(join(s.runtime, "document.sqlite"));
  const old = {
    originalPath: await realpath(s.file),
    threadId: "ink-test",
    revision: 9,
    draft: s.body,
    comments: [],
    versions: [{ number: 1, body: s.body }],
    round: {
      phase: "review",
      base: s.body,
      candidatePath: join(s.runtime, "candidate.md"),
      comments: [],
      candidate: s.body + "新增。",
      changes: [
        {
          id: "preserved-id",
          start: s.body.length,
          end: s.body.length,
          before: "",
          after: "新增。",
        },
      ],
      decisions: { "preserved-id": "keep" },
    },
    generationReceipts: [],
    submittedExecutions: ["old-execution"],
    pendingApply: null,
    appliedReceipts: [],
    appliedVersion: null,
  };
  db.prepare("UPDATE document SET body = ?").run(JSON.stringify(old));
  db.close();
  const reopened = await startService(context, s.file, s.runtime);
  const view = await reopened.request("/api/state");
  equal(view.versions[0].savedAt, null);
  deepStrictEqual(view.round.changes, old.round.changes);
  deepStrictEqual(view.round.decisions, old.round.decisions);
  equal(view.round.preview, s.body + "新增。");
});

test("history adoption after confirmation can replace a review without writing", async (context) => {
  const s = await setup(context);
  await s.generate();
  const claim = await s.worker({ action: "claim" });
  await writeFile(claim.candidatePath, s.body + "机器建议。");
  await s.worker({ action: "submit", executionId: claim.executionId });
  const review = await s.state();
  const adopted = await s.panel({
    action: "adopt",
    revision: review.revision,
    version: 1,
  });
  equal(adopted.round, null);
  deepStrictEqual(adopted.comments, []);
  equal(adopted.draft, s.body);
  equal(await readFile(s.file, "utf8"), s.body);
  equal(adopted.versions.length, 1);
});

test("new and repaired annotations on newly typed text stay resolved", async (context) => {
  const s = await setup(context);
  const initial = await s.state();
  const draft = s.body + "新增的选区。";
  const start = draft.indexOf("新增的选区");
  const note = {
    id: "new-note",
    start,
    end: start + 5,
    quote: "新增的选区",
    instruction: "缩短",
  };
  const saved = await s.panel({
    action: "save",
    revision: initial.revision,
    draft,
    comments: [note],
  });
  equal(saved.comments[0].resolved, true);
  equal(saved.comments[0].start, start);
  const changed = draft.replace("新增的选区", "修复的选区");
  const repaired = await s.panel({
    action: "save",
    revision: saved.revision,
    draft: changed,
    comments: [{ ...saved.comments[0], quote: "修复的选区" }],
  });
  equal(repaired.comments[0].resolved, true);
  ok(repaired.comments[0].revision > saved.comments[0].revision);
});

test("all-discard review saves human edits and preserves unchanged submitted comments", async (context) => {
  const s = await setup(context);
  const initial = await s.state();
  await s.panel({
    action: "save",
    revision: initial.revision,
    draft: s.body.replace("稿件", "人类标题"),
    comments: [],
  });
  await s.generate();
  const claim = await s.worker({ action: "claim" });
  const base = await readFile(claim.candidatePath, "utf8");
  await writeFile(claim.candidatePath, base.replace("第一句", "机器首句"));
  await s.worker({ action: "submit", executionId: claim.executionId });
  let view = await s.state();
  const submitted = view.comments;
  for (const change of view.round.changes)
    view = await s.panel({
      action: "choose",
      revision: view.revision,
      roundId: view.round.id,
      changeId: change.id,
      keep: false,
    });
  const applied = await s.panel({
    action: "apply",
    revision: view.revision,
    operationId: "discard-save",
    preview: view.round.preview,
  });
  equal(await readFile(s.file, "utf8"), base);
  deepStrictEqual(applied.comments, submitted);
  equal(applied.versions.length, 2);
});

test("restart preserves unknown execution gate and only its own terminal report unlocks it", async (context) => {
  const s = await setup(context);
  await s.generate();
  const claim = await s.worker({ action: "claim" });
  await s.stop();
  const restarted = await startService(context, s.file, s.runtime);
  const state = await restarted.request("/api/state");
  equal(state.round.phase, "interrupted");
  equal(state.round.executionEnded, false);
  await rejects(
    restarted.request("/api/worker", {
      action: "finish",
      threadId: "ink-test",
      executionId: "unrelated",
      outcome: "failed",
    }),
  );
  await rejects(
    restarted.request("/api/panel", {
      action: "generate",
      revision: state.revision,
      draft: state.draft,
      comments: state.comments,
      requestId: "restart-new",
    }),
  );
  await restarted.request("/api/worker", {
    action: "finish",
    threadId: "ink-test",
    executionId: claim.executionId,
    outcome: "cancelled",
  });
  const ended = await restarted.request("/api/state");
  equal(ended.round.executionEnded, true);
});

test("an unresolved claimed execution cannot disappear through abandon or history adoption", async (context) => {
  const s = await setup(context);
  await s.generate();
  await s.worker({ action: "claim" });
  const editing = await s.state();
  const interrupted = await s.panel({
    action: "cancel",
    revision: editing.revision,
    roundId: editing.round.id,
  });
  await rejects(
    s.panel({
      action: "abandon",
      revision: interrupted.revision,
      roundId: interrupted.round.id,
    }),
  );
  await rejects(
    s.panel({ action: "adopt", revision: interrupted.revision, version: 1 }),
  );
  deepStrictEqual(await s.state(), interrupted);
});

for (const original of [
  "\uFEFF# 稿件\r\n\r\n第一句😀。第二句。\r\n",
  "# 稿件\n\n| 第一列 | 第二列 |\n| --- | --- |\n| 第一字 | 第二字 |\n",
]) {
  test(
    "real review and write retain exact Unicode and Markdown bytes " +
      JSON.stringify(original.slice(0, 8)),
    async (context) => {
      const s = await setup(context, original);
      const initial = await s.state();
      const quote = original.includes("第一句") ? "第一句" : "第一字";
      const start = original.indexOf(quote);
      await s.panel({
        action: "generate",
        revision: initial.revision,
        draft: original,
        comments: [
          {
            id: "exact",
            start,
            end: start + quote.length,
            quote,
            instruction: "修改这三个字",
          },
        ],
        requestId: "exact-bytes",
      });
      const claim = await s.worker({ action: "claim" });
      const expected = original.replace(quote, "修改后");
      await writeFile(claim.candidatePath, expected);
      await s.worker({ action: "submit", executionId: claim.executionId });
      let view = await s.state();
      for (const change of view.round.changes)
        view = await s.panel({
          action: "choose",
          revision: view.revision,
          roundId: view.round.id,
          changeId: change.id,
          keep: true,
        });
      const result = await s.panel({
        action: "apply",
        revision: view.revision,
        operationId: "exact-write",
        preview: view.round.preview,
      });
      deepStrictEqual(await readFile(s.file), Buffer.from(expected));
      equal(result.versions[1].body, expected);
    },
  );
}

test("editing adopted history writes against latest disk checkpoint and records its actual parent", async (context) => {
  const s = await setup(context);
  const first = await s.state();
  let view = await s.panel({
    action: "save",
    revision: first.revision,
    draft: s.body + "第二版。",
    comments: [],
  });
  view = await s.panel({
    action: "apply",
    revision: view.revision,
    operationId: "history-v2",
    preview: view.draft,
  });
  view = await s.panel({
    action: "adopt",
    revision: view.revision,
    version: 1,
  });
  view = await s.panel({
    action: "save",
    revision: view.revision,
    draft: view.draft + "历史分支编辑。",
    draftRevision: view.draftRevision + 1,
    comments: [],
  });
  view = await s.panel({
    action: "apply",
    revision: view.revision,
    operationId: "history-v3",
    preview: view.draft,
  });
  equal(view.versions.length, 3);
  equal(view.versions[2].parentVersion, 1);
  equal(view.workingBase.version, 3);
  equal(await readFile(s.file, "utf8"), s.body + "历史分支编辑。");
});

test(
  "recheck retains unrelated disk evidence and registers late matching readback only once",
  { skip: process.getuid?.() === 0 },
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), "agora-ink-recheck-"));
    const directory = join(root, "manuscript");
    await mkdir(directory);
    const file = join(directory, "copy.md");
    await writeFile(file, "原始稿件");
    context.after(async () => {
      await chmod(directory, 0o700);
      await rm(root, { recursive: true, force: true });
    });
    const s = await startService(context, file, join(root, "runtime"));
    const original = await s.request("/api/state");
    const saved = await s.request("/api/panel", {
      action: "save",
      revision: original.revision,
      draft: "预定写入",
      comments: [],
    });
    await chmod(directory, 0o500);
    const pending = await s.request("/api/panel", {
      action: "apply",
      revision: saved.revision,
      operationId: "unknown-write",
      preview: saved.draft,
    });
    equal(pending.applyStatus.phase, "checking");
    await chmod(directory, 0o700);
    await writeFile(file, "不相关的外部修改");
    const operation = { action: "recheck", operationId: "unknown-write" };
    const unresolved = await s.request("/api/panel", operation);
    equal(unresolved.applyStatus.phase, "checking");
    equal(await readFile(file, "utf8"), "不相关的外部修改");
    await writeFile(file, saved.draft);
    const settled = await s.request("/api/panel", operation);
    equal(settled.applyStatus.phase, "applied");
    equal(settled.versions.length, 2);
    deepStrictEqual(
      (await s.request("/api/panel", operation)).versions,
      settled.versions,
    );
  },
);

test("discarding all suggestions after history adoption never restores the original or creates a version", async (context) => {
  const s = await setup(context);
  let view = await s.state();
  view = await s.panel({
    action: "save",
    revision: view.revision,
    draft: s.body + "第二版。",
    comments: [],
  });
  view = await s.panel({
    action: "apply",
    revision: view.revision,
    operationId: "adopt-base-v2",
    preview: view.draft,
  });
  const diskV2 = view.draft;
  view = await s.panel({
    action: "adopt",
    revision: view.revision,
    version: 1,
  });
  await s.generate();
  const claim = await s.worker({ action: "claim" });
  await writeFile(claim.candidatePath, s.body.replace("第一句", "建议首句"));
  await s.worker({ action: "submit", executionId: claim.executionId });
  view = await s.state();
  for (const change of view.round.changes)
    view = await s.panel({
      action: "choose",
      revision: view.revision,
      roundId: view.round.id,
      changeId: change.id,
      keep: false,
    });
  await rejects(
    s.panel({
      action: "apply",
      revision: view.revision,
      operationId: "discard-adopted",
      preview: view.round.preview,
    }),
  );
  equal(await readFile(s.file, "utf8"), diskV2);
  equal((await s.state()).versions.length, 2);
});

test("legacy successful apply receipts recognize exact replay with unknown original revision", async (context) => {
  const s = await setup(context);
  await s.stop();
  const db = new DatabaseSync(join(s.runtime, "document.sqlite"));
  const preview = s.body + "已写内容。";
  await writeFile(s.file, preview);
  const { createHash } = await import("node:crypto");
  const old = {
    originalPath: await realpath(s.file),
    threadId: "ink-test",
    revision: 8,
    draft: preview,
    comments: [],
    versions: [
      { number: 1, body: s.body },
      { number: 2, body: preview },
    ],
    round: null,
    generationReceipts: [],
    submittedExecutions: [],
    pendingApply: null,
    appliedReceipts: [
      {
        operationId: "legacy-success",
        fingerprint: createHash("sha256").update(preview).digest("hex"),
      },
    ],
    appliedVersion: 2,
  };
  db.prepare("UPDATE document SET body = ?").run(JSON.stringify(old));
  db.close();
  const restarted = await startService(context, s.file, s.runtime);
  const replay = await restarted.request("/api/panel", {
    action: "apply",
    revision: 6,
    operationId: "legacy-success",
    preview,
  });
  equal(replay.applyStatus.phase, "applied");
  equal(replay.applyStatus.operationId, "legacy-success");
  equal(replay.applyStatus.version, 2);
  equal(replay.versions.length, 2);
  const checked = await restarted.request("/api/panel", {
    action: "recheck",
    operationId: "legacy-success",
  });
  deepStrictEqual(checked.applyStatus, replay.applyStatus);
  await rejects(
    restarted.request("/api/panel", {
      action: "apply",
      revision: 6,
      operationId: "legacy-success",
      preview: "不同内容",
    }),
  );
  equal(await readFile(s.file, "utf8"), preview);
});

test("legacy annotation focus metadata is normalized before a leftward anchor move and restart", async (context) => {
  const s = await setup(context, "prefix quote suffix");
  const initial = await s.state();
  const saved = await s.panel({
    action: "save",
    revision: initial.revision,
    draft: initial.draft,
    comments: [
      {
        id: "legacy-focus",
        start: 7,
        end: 12,
        quote: "quote",
        instruction: "重写",
      },
    ],
  });
  const moved = await s.panel({
    action: "save",
    revision: saved.revision,
    draft: "quote suffix",
    comments: saved.comments,
  });
  equal(moved.comments[0].start, 0);
  equal(moved.comments[0].end, 5);
  equal(moved.comments[0].focusOffset, 5);
  equal(moved.comments[0].resolved, true);
  await rejects(
    s.panel({
      action: "save",
      revision: moved.revision,
      draft: "\ud800",
      comments: moved.comments,
    }),
  );
  deepStrictEqual(await s.state(), moved);
  await s.stop();
  const reopened = await startService(context, s.file, s.runtime);
  const restored = await reopened.request("/api/state");
  deepStrictEqual(restored.comments, moved.comments);
  equal(restored.draft, "quote suffix");
});
