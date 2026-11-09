import type {
  Comment,
  CommentDraft,
  PanelCommand,
  PanelTransport,
  View,
} from "../../../../packages/contracts/src/index.js";

export type DraftInput = Pick<
  View,
  "draft" | "draftRevision" | "comments" | "commentDraft"
>;
export type Anchor = Pick<
  CommentDraft,
  "start" | "end" | "quote" | "focusOffset" | "direction"
>;
export type DestructiveAction =
  | { kind: "adopt"; version: number }
  | { kind: "cancel" }
  | { kind: "abandon" }
  | { kind: "discard-comment" }
  | { kind: "delete-comment"; id: string };
export type ConfirmationTicket = {
  id: string;
  documentId: string;
  revision: number;
  inputEpoch: number;
  action: DestructiveAction;
};
export interface InkState {
  snapshot: View | null;
  input: DraftInput | null;
  inputEpoch: number;
  dirty: boolean;
  busy: number;
  error: string | null;
  viewedVersion: number | null;
  confirmation: ConfirmationTicket | null;
  savedReceipt: number | null;
}
const clone = <T>(value: T): T => structuredClone(value);
const inputOf = (view: View): DraftInput => ({
  draft: view.draft,
  draftRevision: view.draftRevision,
  comments: clone(view.comments),
  commentDraft: clone(view.commentDraft),
});
const sameInput = (left: DraftInput, right: DraftInput) =>
  JSON.stringify(left) === JSON.stringify(right);

export function createInkController(
  transport: PanelTransport,
  options: { pollInterval?: number; autosaveDelay?: number } = {},
) {
  let state: InkState = {
    snapshot: null,
    input: null,
    inputEpoch: 0,
    dirty: false,
    busy: 0,
    error: null,
    viewedVersion: null,
    confirmation: null,
    savedReceipt: null,
  };
  let disposed = false;
  let pendingApply: {
    operationId: string;
    epoch: number;
    sourceDraftRevision: number;
  } | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let polling: ReturnType<typeof setInterval> | undefined;
  const listeners = new Set<() => void>();
  const emit = () => {
    if (!disposed) for (const listener of listeners) listener();
  };
  const requireView = () => {
    if (!state.snapshot || !state.input) throw new Error("文稿尚未载入。");
    return state.snapshot;
  };
  function accept(view: View) {
    if (
      disposed ||
      (state.snapshot &&
        (view.documentId !== state.snapshot.documentId ||
          view.revision < state.snapshot.revision))
    )
      return;
    state = {
      ...state,
      snapshot: view,
      input: state.dirty ? state.input : inputOf(view),
    };
    if (
      view.applyStatus?.phase === "applied" &&
      pendingApply &&
      view.applyStatus.operationId === pendingApply.operationId &&
      view.applyStatus.sourceDraftRevision ===
        pendingApply.sourceDraftRevision &&
      state.inputEpoch === pendingApply.epoch
    )
      state.savedReceipt = view.applyStatus.version;
    if (state.confirmation && state.confirmation.revision !== view.revision)
      state.confirmation = null;
  }
  async function refresh() {
    try {
      accept(await transport.getState());
      emit();
    } catch (error) {
      if (!disposed) {
        state.error = error instanceof Error ? error.message : "无法读取文稿。";
        emit();
      }
    }
  }
  function serialize<T>(run: () => Promise<T>): Promise<T> {
    const result = queue.then(async () => {
      if (disposed) throw new Error("面板已关闭。");
      state.busy++;
      state.error = null;
      emit();
      try {
        return await run();
      } catch (error) {
        state.error =
          error instanceof Error ? error.message : "操作失败，请重试。";
        throw error;
      } finally {
        state.busy--;
        emit();
      }
    });
    queue = result.catch(() => undefined);
    return result;
  }
  function edit(input: DraftInput) {
    state = {
      ...state,
      input,
      inputEpoch: state.inputEpoch + 1,
      dirty: true,
      savedReceipt: null,
      confirmation: null,
    };
    clearTimeout(timer);
    timer = setTimeout(() => {
      void flush().catch(() => undefined);
    }, options.autosaveDelay ?? 450);
    emit();
  }
  async function saveCaptured(input: DraftInput, epoch: number) {
    const view = requireView();
    if (sameInput(inputOf(view), input)) {
      if (state.inputEpoch === epoch) state.dirty = false;
      return inputOf(view);
    }
    let saved: View;
    try {
      saved = await transport.run({
        action: "save",
        revision: view.revision,
        ...clone(input),
      });
    } catch (error) {
      const canonical = await transport.getState().catch(() => null);
      if (!canonical || !sameInput(inputOf(canonical), input)) throw error;
      saved = canonical;
    }
    accept(saved);
    if (state.inputEpoch === epoch) {
      state.dirty = false;
      state.input = inputOf(saved);
    }
    return inputOf(saved);
  }
  function flush() {
    clearTimeout(timer);
    const input = clone(state.input);
    const epoch = state.inputEpoch;
    return serialize(async () => {
      if (input) await saveCaptured(input, epoch);
    });
  }
  async function dispatch(command: PanelCommand) {
    if (disposed) throw new Error("面板已关闭。");
    const result = await transport.run(command);
    accept(result);
    return result;
  }
  function beginComment(
    anchor: Anchor,
    editingCommentId: string | null = null,
  ) {
    const view = requireView();
    const input = state.input!;
    const existing = input.comments.find(
      (comment) => comment.id === editingCommentId,
    );
    edit({
      ...clone(input),
      commentDraft: {
        ...anchor,
        id: crypto.randomUUID(),
        editingCommentId,
        sourceRevision: view.draftRevision,
        instruction: existing?.instruction ?? "",
      },
    });
  }
  function finishComment() {
    clearTimeout(timer);
    const input = clone(state.input);
    const epoch = state.inputEpoch;
    if (!input?.commentDraft?.instruction.trim())
      return Promise.reject(new Error("请写下批注意见。"));
    const draft = input.commentDraft;
    const id = draft.editingCommentId ?? draft.id;
    const comment: Comment = {
      id,
      start: draft.start,
      end: draft.end,
      quote: draft.quote,
      instruction: draft.instruction.trim(),
      revision:
        (input.comments.find((value) => value.id === id)?.revision ?? -1) + 1,
      resolved: true,
      focusOffset: draft.focusOffset,
      direction: draft.direction,
    };
    const submitted = {
      ...input,
      comments: [...input.comments.filter((value) => value.id !== id), comment],
      commentDraft: null,
    };
    return serialize(async () => {
      await saveCaptured(submitted, epoch);
      return id;
    });
  }
  function generate() {
    const input = clone(state.input);
    const epoch = state.inputEpoch;
    clearTimeout(timer);
    return serialize(async () => {
      if (!input) return;
      if (input.commentDraft) throw new Error("先完成或取消当前批注。");
      if (input.comments.some((comment) => !comment.resolved))
        throw new Error("请将失去定位的批注重新关联到原文。");
      const persisted = await saveCaptured(input, epoch);
      const view = requireView();
      await dispatch({
        action: "generate",
        revision: view.revision,
        ...persisted,
        requestId: crypto.randomUUID(),
      });
    });
  }
  function choose(changeId: string, choice: "keep" | "discard") {
    const roundId = requireView().round?.id;
    return serialize(async () => {
      const view = requireView();
      if (!roundId || view.round?.id !== roundId)
        throw new Error("本轮建议已变化。");
      await dispatch({
        action: "choose",
        revision: view.revision,
        roundId,
        changeId,
        keep: choice === "keep",
      });
    });
  }
  function apply() {
    const input = clone(state.input);
    const epoch = state.inputEpoch;
    const operationId = crypto.randomUUID();
    clearTimeout(timer);
    return serialize(async () => {
      if (!input) return;
      const persisted = await saveCaptured(input, epoch);
      const view = requireView();
      const preview =
        view.round?.phase === "review" ? view.round.preview : persisted.draft;
      pendingApply = {
        operationId,
        epoch,
        sourceDraftRevision: persisted.draftRevision,
      };
      try {
        await dispatch({
          action: "apply",
          revision: view.revision,
          operationId,
          preview,
        });
      } catch (error) {
        await refresh();
        throw error;
      }
    });
  }
  function roundAction(action: "retry" | "cancel" | "abandon") {
    const roundId = requireView().round?.id;
    return serialize(async () => {
      const view = requireView();
      if (!roundId || view.round?.id !== roundId)
        throw new Error("本轮任务已变化。");
      if (action === "retry")
        await dispatch({
          action,
          revision: view.revision,
          roundId,
          requestId: crypto.randomUUID(),
        });
      else await dispatch({ action, revision: view.revision, roundId });
    });
  }
  function prepareDestructive(
    action: DestructiveAction,
    present = true,
  ): ConfirmationTicket | null {
    const view = requireView();
    const ticket = {
      id: crypto.randomUUID(),
      documentId: view.documentId,
      revision: view.revision,
      inputEpoch: state.inputEpoch,
      action,
    };
    state.confirmation = ticket;
    if (present) emit();
    return ticket;
  }
  async function confirmDestructive(
    ticket: ConfirmationTicket | null,
  ): Promise<boolean> {
    if (
      !ticket ||
      state.confirmation?.id !== ticket.id ||
      ticket.revision !== state.snapshot?.revision ||
      ticket.inputEpoch !== state.inputEpoch
    )
      return false;
    state.confirmation = null;
    const action = ticket.action;
    if (action.kind === "discard-comment" || action.kind === "delete-comment") {
      const before = clone(state.input);
      if (!before) return false;
      const next =
        action.kind === "discard-comment"
          ? { ...before, commentDraft: null }
          : {
              ...before,
              comments: before.comments.filter(
                (comment) => comment.id !== action.id,
              ),
            };
      edit(next);
      try {
        await flush();
      } catch (error) {
        const current = clone(state.input ?? before);
        if (action.kind === "discard-comment" && !current.commentDraft)
          current.commentDraft = before.commentDraft;
        if (
          action.kind === "delete-comment" &&
          !current.comments.some((comment) => comment.id === action.id)
        ) {
          const index = before.comments.findIndex(
              (comment) => comment.id === action.id,
            ),
            note = before.comments[index];
          if (note)
            current.comments.splice(
              Math.min(index, current.comments.length),
              0,
              note,
            );
        }
        state.input = current;
        state.inputEpoch++;
        state.dirty =
          !state.snapshot || !sameInput(inputOf(state.snapshot), current);
        emit();
        throw error;
      }
      return true;
    }
    if (action.kind === "cancel" || action.kind === "abandon") {
      await roundAction(action.kind);
      return true;
    }
    return serialize(async () => {
      if (
        ticket.revision !== state.snapshot?.revision ||
        ticket.inputEpoch !== state.inputEpoch
      )
        return false;
      await dispatch({
        action: "adopt",
        revision: ticket.revision,
        version: action.version,
      });
      state.dirty = false;
      state.input = inputOf(requireView());
      state.inputEpoch++;
      state.viewedVersion = null;
      state.savedReceipt = null;
      return true;
    });
  }
  const ready = refresh();
  if ((options.pollInterval ?? 700) > 0)
    polling = setInterval(() => {
      void refresh();
    }, options.pollInterval ?? 700);
  return {
    ready,
    read: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh,
    flush,
    editBody(draft: string) {
      if (state.input)
        edit({
          ...clone(state.input),
          draft,
          draftRevision: state.input.draftRevision + 1,
        });
    },
    beginComment,
    editComment(instruction: string) {
      if (state.input?.commentDraft)
        edit({
          ...clone(state.input),
          commentDraft: { ...state.input.commentDraft, instruction },
        });
    },
    reanchorComment(id: string, anchor: Anchor) {
      if (state.input)
        edit({
          ...clone(state.input),
          comments: state.input.comments.map((comment) =>
            comment.id === id
              ? {
                  ...comment,
                  ...anchor,
                  resolved: true,
                  revision: comment.revision + 1,
                }
              : comment,
          ),
        });
    },
    finishComment,
    generate,
    choose,
    apply,
    retry: () => roundAction("retry"),
    recheck() {
      const operationId = requireView().applyStatus?.operationId;
      return serialize(async () => {
        if (operationId) await dispatch({ action: "recheck", operationId });
      });
    },
    browseVersion(version: number | null) {
      state.viewedVersion = version;
      emit();
    },
    prepareDestructive,
    confirmDestructive,
    dismissDestructive() {
      state.confirmation = null;
      emit();
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      clearInterval(polling);
      listeners.clear();
    },
  };
}
export type InkController = ReturnType<typeof createInkController>;
