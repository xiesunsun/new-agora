import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Comment,
  PanelTransport,
  View,
} from "../../../packages/contracts/src/index.js";
import {
  editDraft,
  editorText,
  isAnchored,
  selectedPassage,
  type Draft,
} from "./draft.js";
import {
  Brand,
  CommentEditor,
  ReviewList,
  VersionHistory,
} from "./workspace-parts.js";

type Mode = "draft" | "preview" | "history";
type Action = "save" | "generate" | "choose" | "apply";

type Session = {
  view: View;
  draft: Draft;
  mode: Mode;
};

function hasLocalEdits({ draft, view }: Session) {
  return draft.body !== view.draft || draft.comments !== view.comments;
}

function statusText(view: View, dirty: boolean, pending: Action | null) {
  if (view.applyStatus?.phase === "checking") return "正在核对写入结果";
  if (pending === "apply") return "正在写入原文件";
  if (view.round?.phase === "waiting") return "等待 Codex";
  if (view.round?.phase === "editing") return "正在改稿";
  if (view.round?.phase === "review") return "修改建议可审阅";
  if (view.round?.phase === "empty") return "没有新建议";
  if (dirty) return "草稿有未保存的修改";
  if (view.applyStatus?.phase === "applied")
    return `已写入原文件 · V${view.applyStatus.version}`;
  return "草稿已保存";
}

export function Workbench({ transport }: { transport: PanelTransport }) {
  const [session, setSession] = useState<Session | null>(null);
  const [pending, setPending] = useState<Action | null>(null);
  const [error, setError] = useState("");
  const [selection, setSelection] = useState<[number, number]>([0, 0]);
  const [commentForm, setCommentForm] = useState<Comment | null>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const inFlight = useRef(false);
  const generation = useRef<{ draft: Draft; revision: number; id: string }>(
    null,
  );
  const application = useRef<{ preview: string; revision: number; id: string }>(
    null,
  );

  const accept = useCallback((next: View, submitted?: Draft) => {
    setSession((current) => {
      if (current && current.view.revision > next.revision) return current;
      if (current && current.view.revision === next.revision && !submitted)
        return current;

      let mode: Mode = current?.mode ?? "draft";
      if (next.round?.phase === "review") {
        if (current?.view.round?.phase !== "review" && mode !== "history")
          mode = "preview";
      } else if (mode === "preview") {
        mode = "draft";
      }

      const draft =
        current && hasLocalEdits(current) && current.draft !== submitted
          ? current.draft
          : { body: next.draft, comments: next.comments };
      return { view: next, draft, mode };
    });
  }, []);

  const refresh = useCallback(async () => {
    try {
      accept(await transport.getState());
      setError("");
    } catch (cause) {
      setError(message(cause));
    }
  }, [accept, transport]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const phase = session?.view.round?.phase;
  const checking = session?.view.applyStatus?.phase === "checking";
  useEffect(() => {
    if (phase !== "waiting" && phase !== "editing" && !checking) return;

    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        if (!inFlight.current) {
          const next = await transport.getState();
          if (active) accept(next);
        }
      } catch (cause) {
        if (active) setError(message(cause));
      } finally {
        if (active) timer = setTimeout(poll, 650);
      }
    }
    timer = setTimeout(poll, 650);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [accept, checking, phase, transport]);

  async function perform(action: Action, work: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(action);
    setError("");
    try {
      await work();
    } catch (cause) {
      setError(message(cause));
    } finally {
      inFlight.current = false;
      setPending(null);
    }
  }

  if (!session) {
    return (
      <div className="app-shell">
        <header className="topbar">
          <Brand />
        </header>
        <main className="loading-view">
          <h1>打开文稿</h1>
          <p role={error ? "alert" : "status"}>{error || "正在读取文稿…"}</p>
          {error && (
            <button className="button" onClick={() => void refresh()}>
              重试
            </button>
          )}
        </main>
      </div>
    );
  }

  const { view, draft, mode } = session;
  const pendingWrite =
    view.applyStatus?.phase === "checking" ? view.applyStatus : null;
  const review = view.round?.phase === "review" ? view.round : null;
  const waiting = phase === "waiting" || phase === "editing";
  const busy = pending !== null || checking;
  const locked = waiting || review !== null || busy;
  const dirty = hasLocalEdits(session);
  const canSelect = selection[0] !== selection[1];
  const unanchored = draft.comments.some(
    (comment) => !isAnchored(draft.body, comment),
  );
  const preview = review?.preview ?? draft.body;
  const currentVersion = view.versions.at(-1)?.number;

  function changeMode(next: Mode) {
    setSession((current) => current && { ...current, mode: next });
  }

  function changeDraft(next: Draft) {
    setSession((current) => current && { ...current, draft: next });
  }

  function closeComment() {
    setCommentForm(null);
    editor.current?.focus();
  }

  function beginComment() {
    const passage = selectedPassage(draft.body, ...selection);
    if (passage.quote.trim()) {
      setCommentForm({
        ...passage,
        id: crypto.randomUUID(),
        instruction: "",
      });
    }
  }

  function saveComment(comment: Comment) {
    const comments = draft.comments.some((entry) => entry.id === comment.id)
      ? draft.comments.map((entry) =>
          entry.id === comment.id ? comment : entry,
        )
      : [...draft.comments, comment];
    changeDraft({ ...draft, comments });
    closeComment();
  }

  async function save() {
    const next = await transport.run({
      action: "save",
      revision: view.revision,
      draft: draft.body,
      comments: draft.comments,
    });
    accept(next, draft);
    return next;
  }

  async function generate() {
    if (unanchored) {
      setError("有批注的原文已改变，请重新选择对应的文字。");
      return;
    }
    const retry = generation.current;
    const requestId =
      retry?.draft === draft && retry.revision === view.revision
        ? retry.id
        : crypto.randomUUID();
    generation.current = { draft, revision: view.revision, id: requestId };
    const next = await transport.run({
      action: "generate",
      revision: view.revision,
      draft: draft.body,
      comments: draft.comments,
      requestId,
    });
    generation.current = null;
    accept(next, draft);
  }

  async function choose(changeId: string, keep: boolean) {
    const next = await transport.run({
      action: "choose",
      revision: view.revision,
      changeId,
      keep,
    });
    accept(next);
  }

  async function apply() {
    if (pendingWrite) {
      const next = await transport.run({
        action: "apply",
        operationId: pendingWrite.operationId,
        revision: pendingWrite.revision,
        preview,
      });
      if (next.applyStatus?.phase === "applied") application.current = null;
      accept(next);
      return;
    }
    const revision = dirty && !review ? (await save()).revision : view.revision;
    const retry = application.current;
    const operationId =
      retry?.preview === preview && retry.revision === revision
        ? retry.id
        : crypto.randomUUID();
    application.current = { preview, revision, id: operationId };
    const next = await transport.run({
      action: "apply",
      revision,
      operationId,
      preview,
    });
    if (next.applyStatus?.phase === "applied") application.current = null;
    accept(next);
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <Brand />
        {currentVersion !== undefined && (
          <span className="version-chip">已存版本 V{currentVersion}</span>
        )}
      </header>
      <main className="workspace">
        <div className="document-heading">
          <p className="eyebrow">文稿协作</p>
          <h1>{view.documentName}</h1>
          <p>在文稿中留下批注，审阅修改后再写回原文件。</p>
        </div>

        {error && (
          <div className="notice" role="alert">
            <span>{error}</span>
            <button className="text-button" onClick={() => void refresh()}>
              重新读取进度
            </button>
          </div>
        )}

        <div className="workspace-grid">
          <section className="document-card" aria-label="文稿">
            <div className="document-toolbar">
              <nav className="tabs" aria-label="文稿视图">
                <button
                  aria-pressed={mode === "draft"}
                  onClick={() => changeMode("draft")}
                >
                  工作稿
                </button>
                {review && (
                  <button
                    aria-pressed={mode === "preview"}
                    onClick={() => changeMode("preview")}
                  >
                    应用预览
                  </button>
                )}
                <button
                  aria-pressed={mode === "history"}
                  onClick={() => changeMode("history")}
                >
                  历史版本
                </button>
              </nav>
              <span className="file-kind">Markdown</span>
            </div>
            {mode === "draft" && (
              <>
                <textarea
                  ref={editor}
                  aria-label="工作稿正文"
                  className="document-editor"
                  spellCheck={false}
                  readOnly={locked || commentForm !== null}
                  value={editorText(draft.body)}
                  onChange={(event) =>
                    changeDraft(editDraft(draft, event.target.value))
                  }
                  onSelect={(event) => {
                    const target = event.currentTarget;
                    setSelection([target.selectionStart, target.selectionEnd]);
                  }}
                />
                <footer className="document-footer">
                  <span>选中正文可添加批注</span>
                  <button
                    className="button"
                    disabled={locked || !dirty || commentForm !== null}
                    onClick={() =>
                      void perform("save", async () => void (await save()))
                    }
                  >
                    保存草稿
                  </button>
                </footer>
              </>
            )}
            {mode === "preview" && review && (
              <div className="preview">
                <p className="pane-caption">预览仅纳入已保留的建议。</p>
                <pre className="document-text" aria-label="应用预览正文">
                  {review.preview}
                </pre>
              </div>
            )}
            {mode === "history" && <VersionHistory versions={view.versions} />}
          </section>

          <aside
            className="side-card"
            aria-label={review ? "审阅建议" : "文稿批注"}
          >
            <div className="side-heading">
              <p className="eyebrow">{review ? "审阅" : "批注"}</p>
              <h2>{review ? "修改建议" : "修改意见"}</h2>
              <p>
                {review
                  ? "逐项保留或舍弃，预览会随选择更新。"
                  : "可以收集多处意见，再一起生成建议。"}
              </p>
            </div>
            {review ? (
              <ReviewList
                round={review}
                busy={busy}
                onChoose={(id, keep) =>
                  void perform("choose", () => choose(id, keep))
                }
              />
            ) : (
              <>
                {draft.comments.length ? (
                  <ol className="cards" aria-label="批注">
                    {draft.comments.map((comment, index) => (
                      <li key={comment.id} className="note-card">
                        <div className="card-label">
                          <span>批注 {index + 1}</span>
                          {!isAnchored(draft.body, comment) && (
                            <span>需重新选段</span>
                          )}
                        </div>
                        <blockquote>{comment.quote}</blockquote>
                        <p>{comment.instruction}</p>
                        {!locked && (
                          <div className="note-actions">
                            {!isAnchored(draft.body, comment) && (
                              <button
                                className="text-button"
                                disabled={
                                  !canSelect ||
                                  mode !== "draft" ||
                                  commentForm !== null
                                }
                                onClick={() =>
                                  changeDraft({
                                    ...draft,
                                    comments: draft.comments.map((entry) =>
                                      entry.id === comment.id
                                        ? {
                                            ...entry,
                                            ...selectedPassage(
                                              draft.body,
                                              ...selection,
                                            ),
                                          }
                                        : entry,
                                    ),
                                  })
                                }
                              >
                                使用当前选区
                              </button>
                            )}
                            <button
                              className="text-button"
                              disabled={commentForm !== null}
                              onClick={() => setCommentForm(comment)}
                            >
                              编辑
                            </button>
                            <button
                              className="text-button"
                              disabled={commentForm !== null}
                              onClick={() =>
                                changeDraft({
                                  ...draft,
                                  comments: draft.comments.filter(
                                    (entry) => entry.id !== comment.id,
                                  ),
                                })
                              }
                            >
                              撤回
                            </button>
                          </div>
                        )}
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="empty-note">先在工作稿中选中一段文字。</p>
                )}
                {commentForm ? (
                  <CommentEditor
                    key={commentForm.id}
                    comment={commentForm}
                    onSave={saveComment}
                    onCancel={closeComment}
                  />
                ) : (
                  <button
                    className="button add-comment"
                    disabled={locked || !canSelect || mode !== "draft"}
                    onClick={beginComment}
                  >
                    <span aria-hidden="true">+</span> 添加批注
                  </button>
                )}
              </>
            )}
            <footer className="side-footer">
              <p className="status" role="status">
                <span aria-hidden="true" />
                {statusText(view, dirty, pending)}
              </p>
              {!review && (
                <button
                  className="button primary"
                  disabled={
                    locked || !draft.comments.length || commentForm !== null
                  }
                  onClick={() => void perform("generate", generate)}
                >
                  生成修改建议
                </button>
              )}
              <button
                className={review ? "button primary" : "button"}
                disabled={
                  pending !== null ||
                  waiting ||
                  mode === "history" ||
                  commentForm !== null
                }
                onClick={() => void perform("apply", apply)}
              >
                {pendingWrite ? "重新核对写入" : "应用到原文件"}
              </button>
            </footer>
          </aside>
        </div>
      </main>
    </div>
  );
}

function message(cause: unknown) {
  return cause instanceof Error ? cause.message : "操作暂未完成，请重试。";
}
