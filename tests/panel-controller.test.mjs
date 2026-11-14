import { test } from "node:test";
import { deepEqual, equal, rejects } from "node:assert/strict";
import { register } from "node:module";
register("./panel-loader.mjs", import.meta.url);
const { createPanelController } =
  await import("../apps/panel/src/editor/controller.js");
/** @returns {import('../packages/contracts/src/index.js').View} */
const initial = () => ({
  documentId: "doc",
  documentName: "稿件",
  revision: 0,
  draftRevision: 0,
  draft: "# 初稿\n\n正文。",
  comments: [],
  commentDraft: null,
  workingBase: { version: 1 },
  versions: [
    {
      number: 1,
      body: "# 初稿\n\n正文。",
      savedAt: null,
      parentVersion: null,
      operationId: null,
    },
  ],
  round: null,
  applyStatus: null,
});
/** @template T @returns {{promise: Promise<T>, resolve: (value: T) => void, reject: (reason: unknown) => void}} */
const deferred = () => {
  let resolve = (/** @type {T} */ _value) => {};
  let reject = (/** @type {unknown} */ _reason) => {};
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
test("a failed save preserves composer and prevents generation", async () => {
  const view = initial();
  /** @type {import('../packages/contracts/src/index.js').PanelCommand[]} */
  const calls = [];
  const controller = createPanelController(
    {
      getState: async () => view,
      run: async (command) => {
        calls.push(command);
        throw Error("磁盘忙");
      },
    },
    { pollInterval: 0, autosaveDelay: 60000 },
  );
  await controller.ready;
  controller.beginComment({
    start: 8,
    end: 10,
    quote: "正文",
    focusOffset: 10,
    direction: "forward",
  });
  controller.editComment("写具体些");
  await rejects(controller.finishComment());
  equal(controller.read().input?.commentDraft?.instruction, "写具体些");
  await rejects(controller.generate());
  equal(
    calls.some((command) => command.action === "generate"),
    false,
  );
  controller.dispose();
});
test("queued saves capture immutable inputs and older polls cannot replace typing", async () => {
  let view = initial();
  const pending = deferred();
  /** @type {import('../packages/contracts/src/index.js').PanelCommand[]} */
  const calls = [];
  /** @type {{promise: Promise<import('../packages/contracts/src/index.js').View>,resolve: (view: import('../packages/contracts/src/index.js').View)=>void} | null} */
  let poll = null;
  const controller = createPanelController(
    {
      getState: () => (poll ? poll.promise : Promise.resolve(view)),
      run: async (command) => {
        calls.push(command);
        if (calls.length === 1) await pending.promise;
        if (command.action !== "save") throw Error("expected save");
        view = {
          ...view,
          revision: view.revision + 1,
          draft: command.draft,
          comments: command.comments,
          commentDraft: command.commentDraft,
          draftRevision: command.draftRevision,
        };
        return view;
      },
    },
    { pollInterval: 0, autosaveDelay: 60000 },
  );
  await controller.ready;
  controller.editBody("第一次");
  const first = controller.flush();
  await tick();
  controller.editBody("第二次");
  const second = controller.flush();
  pending.resolve(undefined);
  await Promise.all([first, second]);
  deepEqual(
    calls.map((command) => ("draft" in command ? command.draft : null)),
    ["第一次", "第二次"],
  );
  poll = deferred();
  const refresh = controller.refresh();
  controller.editBody("第三次");
  poll.resolve(initial());
  await refresh;
  equal(controller.read().input?.draft, "第三次");
  equal(controller.read().snapshot?.revision, 2);
  controller.dispose();
});
test("confirmation is invalid after a later input or canonical revision", async () => {
  const view = initial();
  /** @type {import('../packages/contracts/src/index.js').PanelCommand[]} */
  const calls = [];
  const controller = createPanelController(
    {
      getState: async () => view,
      run: async (command) => {
        calls.push(command);
        return view;
      },
    },
    { pollInterval: 0, autosaveDelay: 60000 },
  );
  await controller.ready;
  const ticket = controller.prepareDestructive({ kind: "adopt", version: 1 });
  controller.editBody("新输入");
  equal(await controller.confirmDestructive(ticket), false);
  equal(calls.length, 0);
  controller.dispose();
});
test("a late apply receipt never labels newer input saved", async () => {
  let view = initial();
  const pending = deferred();
  const controller = createPanelController(
    {
      getState: async () => view,
      run: async (command) => {
        if (command.action === "save") {
          view = {
            ...view,
            revision: 1,
            draft: command.draft,
            draftRevision: command.draftRevision,
          };
          return view;
        }
        await pending.promise;
        if (command.action !== "apply") throw Error("expected apply");
        return {
          ...view,
          revision: 2,
          applyStatus: {
            phase: "applied",
            operationId: command.operationId,
            sourceDraftRevision: view.draftRevision,
            version: 2,
          },
        };
      },
    },
    { pollInterval: 0, autosaveDelay: 60000 },
  );
  await controller.ready;
  controller.editBody("待写正文");
  const applying = controller.apply();
  await tick();
  controller.editBody("更晚的输入");
  pending.resolve(undefined);
  await applying;
  equal(controller.read().savedReceipt, null);
  equal(controller.read().input?.draft, "更晚的输入");
  controller.dispose();
});
test("generate uses the canonical saved comment revisions and anchors", async () => {
  let view = initial();
  const controller = createPanelController(
    {
      getState: async () => view,
      run: async (command) => {
        if (command.action === "save") {
          view = {
            ...view,
            revision: view.revision + 1,
            draft: command.draft,
            draftRevision: command.draftRevision,
            comments: command.comments.map((comment) => ({
              ...comment,
              revision: 42,
            })),
            commentDraft: command.commentDraft,
          };
          return view;
        }
        if (command.action !== "generate") throw Error("expected generate");
        equal(command.comments[0].revision, 42);
        return view;
      },
    },
    { pollInterval: 0, autosaveDelay: 60000 },
  );
  await controller.ready;
  controller.beginComment({
    start: 7,
    end: 9,
    quote: "正文",
    focusOffset: 9,
    direction: "forward",
  });
  controller.editComment("写具体");
  await controller.finishComment();
  equal(controller.read().input?.comments[0].revision, 42);
  await controller.generate();
  controller.dispose();
});

test("rapid choices serialize canonical revisions and retain the round identity", async () => {
  const view = initial();
  view.round = {
    id: "round",
    base: view.draft,
    candidate: "新稿",
    sourceDraftRevision: 0,
    submittedComments: [],
    phase: "review",
    changes: [
      { id: "a", start: 0, end: 1, before: "#", after: "新" },
      { id: "b", start: 2, end: 3, before: "初", after: "稿" },
    ],
    decisions: {},
    preview: view.draft,
  };
  const pending = deferred();
  /** @type {import('../packages/contracts/src/index.js').PanelCommand[]} */ const commands =
    [];
  const controller = createPanelController(
    {
      getState: async () => view,
      run: async (command) => {
        commands.push(command);
        if (commands.length === 1) await pending.promise;
        if (command.action !== "choose" || view.round?.phase !== "review")
          throw Error("expected choice");
        view.revision++;
        view.round.decisions[command.changeId] = command.keep
          ? "keep"
          : "discard";
        return structuredClone(view);
      },
    },
    { pollInterval: 0 },
  );
  await controller.ready;
  const first = controller.choose("a", "keep"),
    second = controller.choose("b", "discard");
  await tick();
  equal(commands.length, 1);
  pending.resolve(undefined);
  await Promise.all([first, second]);
  deepEqual(
    commands.map((command) =>
      command.action === "choose"
        ? [command.revision, command.roundId, command.changeId]
        : null,
    ),
    [
      [0, "round", "a"],
      [1, "round", "b"],
    ],
  );
  const round = controller.read().snapshot?.round;
  deepEqual(round?.phase === "review" ? round.decisions : null, {
    a: "keep",
    b: "discard",
  });
  controller.dispose();
});

test("a canonical revision invalidates an open confirmation", async () => {
  let view = initial();
  let commands = 0;
  const controller = createPanelController(
    {
      getState: async () => view,
      run: async () => {
        commands++;
        return view;
      },
    },
    { pollInterval: 0 },
  );
  await controller.ready;
  const ticket = controller.prepareDestructive({ kind: "adopt", version: 1 });
  view = { ...view, revision: 1 };
  await controller.refresh();
  equal(controller.read().confirmation, null);
  equal(await controller.confirmDestructive(ticket), false);
  equal(commands, 0);
  controller.dispose();
});

test("an unknown apply response refreshes and rechecks the original operation without another write", async () => {
  let view = initial();
  /** @type {import('../packages/contracts/src/index.js').PanelCommand[]} */ const commands =
    [];
  const controller = createPanelController(
    {
      getState: async () => view,
      run: async (command) => {
        commands.push(command);
        if (command.action === "save") {
          view = {
            ...view,
            revision: 1,
            draft: command.draft,
            draftRevision: command.draftRevision,
          };
          return view;
        }
        if (command.action === "apply") {
          view = {
            ...view,
            revision: 2,
            applyStatus: {
              phase: "checking",
              operationId: command.operationId,
              revision: 2,
              sourceDraftRevision: view.draftRevision,
            },
          };
          throw Error("连接中断");
        }
        if (command.action === "recheck") {
          view = {
            ...view,
            revision: 3,
            applyStatus: {
              phase: "applied",
              operationId: command.operationId,
              sourceDraftRevision: view.draftRevision,
              version: 2,
            },
          };
          return view;
        }
        throw Error("unexpected command");
      },
    },
    { pollInterval: 0, autosaveDelay: 60000 },
  );
  await controller.ready;
  controller.editBody("新正文");
  await rejects(controller.apply());
  const status = controller.read().snapshot?.applyStatus;
  equal(status?.phase, "checking");
  await controller.recheck();
  equal(controller.read().savedReceipt, 2);
  deepEqual(
    commands.map((command) => command.action),
    ["save", "apply", "recheck"],
  );
  equal(
    "operationId" in commands[1] ? commands[1].operationId : null,
    status?.operationId,
  );
  equal(
    "operationId" in commands[2] ? commands[2].operationId : null,
    status?.operationId,
  );
  controller.dispose();
});

test("failed discard and deletion preserve the original composer and confirmed comment", async () => {
  for (const kind of ["discard-comment", "delete-comment"]) {
    const view = initial();
    view.comments = [
      {
        id: "note",
        start: 7,
        end: 9,
        quote: "正文",
        instruction: "保留的批注",
        revision: 0,
        resolved: true,
        focusOffset: 9,
        direction: "forward",
      },
    ];
    view.commentDraft = {
      id: "composer",
      editingCommentId: null,
      sourceRevision: 0,
      start: 7,
      end: 9,
      quote: "正文",
      instruction: "尚未完成的输入",
      focusOffset: 9,
      direction: "forward",
    };
    const controller = createPanelController(
      {
        getState: async () => view,
        run: async () => {
          throw Error("保存失败");
        },
      },
      { pollInterval: 0, autosaveDelay: 60000 },
    );
    await controller.ready;
    const ticket = controller.prepareDestructive(
      kind === "discard-comment"
        ? { kind: "discard-comment" }
        : { kind: "delete-comment", id: "note" },
    );
    await rejects(controller.confirmDestructive(ticket));
    equal(controller.read().input?.commentDraft?.instruction, "尚未完成的输入");
    equal(controller.read().input?.comments[0]?.instruction, "保留的批注");
    controller.dispose();
  }
});

test("disposing during a save prevents a queued generation from dispatching", async () => {
  let view = initial();
  const pending = deferred();
  /** @type {string[]} */ const commands = [];
  const controller = createPanelController(
    {
      getState: async () => view,
      run: async (command) => {
        commands.push(command.action);
        if (command.action === "save") {
          await pending.promise;
          view = {
            ...view,
            revision: 1,
            draft: command.draft,
            draftRevision: command.draftRevision,
          };
        }
        return view;
      },
    },
    { pollInterval: 0, autosaveDelay: 60000 },
  );
  await controller.ready;
  controller.editBody("关闭前输入");
  const generating = controller.generate();
  await tick();
  controller.dispose();
  pending.resolve(undefined);
  await rejects(generating);
  deepEqual(commands, ["save"]);
});
