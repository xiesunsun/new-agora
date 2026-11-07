import { useEffect, useRef, useState } from "react";
import type {
  Change,
  Comment,
  View,
} from "../../../packages/contracts/src/index.js";
import { changesBetween } from "../../../packages/text/src/index.js";

export function Brand() {
  return (
    <div className="brand">
      <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
        <path d="M7 24 15.8 7l9.2 17M10 18h12M16 7v17" />
      </svg>
      <span>Agora</span>
      <span className="brand-divider" aria-hidden="true" />
      <span className="brand-label">文稿工作台</span>
    </div>
  );
}

export function CommentEditor({
  comment,
  onSave,
  onCancel,
}: {
  comment: Comment;
  onSave: (comment: Comment) => void;
  onCancel: () => void;
}) {
  const [instruction, setInstruction] = useState(comment.instruction);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);

  return (
    <form
      className="comment-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (instruction.trim()) {
          onSave({ ...comment, instruction: instruction.trim() });
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") onCancel();
      }}
    >
      <blockquote>{comment.quote}</blockquote>
      <label htmlFor="comment-instruction">修改意见</label>
      <textarea
        id="comment-instruction"
        ref={input}
        rows={3}
        value={instruction}
        maxLength={2000}
        onChange={(event) => setInstruction(event.target.value)}
        placeholder="例如，把这里的时间写得更具体。"
      />
      <div className="form-actions">
        <button type="button" className="text-button" onClick={onCancel}>
          取消
        </button>
        <button className="button primary" disabled={!instruction.trim()}>
          保存批注
        </button>
      </div>
    </form>
  );
}

function DiffLines({ change }: { change: Change }) {
  return (
    <div className="diff-lines">
      {change.before && (
        <div className="diff-line removed">
          <span aria-hidden="true">−</span>
          <del aria-label="原文">{change.before}</del>
        </div>
      )}
      {change.after && (
        <div className="diff-line added">
          <span aria-hidden="true">+</span>
          <ins aria-label="修改后">{change.after}</ins>
        </div>
      )}
    </div>
  );
}

export function ReviewList({
  round,
  busy,
  onChoose,
}: {
  round: Extract<NonNullable<View["round"]>, { phase: "review" }>;
  busy: boolean;
  onChoose: (changeId: string, keep: boolean) => void;
}) {
  return (
    <ol className="cards" aria-label="修改建议">
      {round.changes.map((change, index) => {
        const kept = round.decisions[change.id] === "keep";
        const discarded = round.decisions[change.id] === "discard";
        return (
          <li key={change.id} className="change-card">
            <div className="card-label">
              <span>建议 {index + 1}</span>
              <span className={kept ? "decision kept" : "decision"}>
                {kept ? "已保留" : discarded ? "已舍弃" : "待选择"}
              </span>
            </div>
            <DiffLines change={change} />
            <div className="choice-actions">
              <button
                className="button choice"
                aria-pressed={kept}
                disabled={busy}
                onClick={() => onChoose(change.id, true)}
              >
                保留
              </button>
              <button
                className="button choice"
                aria-pressed={discarded}
                disabled={busy}
                onClick={() => onChoose(change.id, false)}
              >
                舍弃
              </button>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function VersionHistory({ versions }: { versions: View["versions"] }) {
  const [selected, select] = useState<number>();
  const version =
    versions.find((entry) => entry.number === selected) ?? versions.at(-1);
  if (!version) return <p>还没有已登记的版本。</p>;
  const previous = versions.find(
    (entry) => entry.number === version.number - 1,
  );
  const changes = previous ? changesBetween(previous.body, version.body) : [];
  return (
    <section className="history" aria-label="版本内容">
      <div className="version-picker" aria-label="选择版本">
        {versions.map((entry) => (
          <button
            key={entry.number}
            className="button choice"
            aria-pressed={entry.number === version.number}
            onClick={() => select(entry.number)}
          >
            V{entry.number}
          </button>
        ))}
      </div>
      {previous && (
        <section className="version-diff" aria-label="历史差异">
          <h3>
            V{previous.number} → V{version.number} 的变化
          </h3>
          {changes.map((change) => (
            <DiffLines key={change.id} change={change} />
          ))}
        </section>
      )}
      <h3>V{version.number} 正文</h3>
      <pre className="document-text">{version.body}</pre>
    </section>
  );
}
