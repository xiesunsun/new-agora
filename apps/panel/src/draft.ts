import type { Comment } from "../../../packages/contracts/src/index.js";

export type Draft = {
  body: string;
  comments: Comment[];
};

export function editorText(body: string): string {
  return body.replace(/\r\n?/g, "\n");
}

function sourceOffset(body: string, position: number): number {
  let offset = 0;
  for (let visible = 0; visible < position && offset < body.length; visible++) {
    offset += body.startsWith("\r\n", offset) ? 2 : 1;
  }
  return offset;
}

export function selectedPassage(body: string, start: number, end: number) {
  const sourceStart = sourceOffset(body, start);
  const sourceEnd = sourceOffset(body, end);
  return {
    start: sourceStart,
    end: sourceEnd,
    quote: body.slice(sourceStart, sourceEnd),
  };
}

export function editDraft(draft: Draft, visibleBody: string): Draft {
  const before = editorText(draft.body);
  if (visibleBody === before) return draft;

  let start = 0;
  while (start < before.length && before[start] === visibleBody[start]) start++;

  let end = before.length;
  let nextEnd = visibleBody.length;
  while (
    end > start &&
    nextEnd > start &&
    before[end - 1] === visibleBody[nextEnd - 1]
  ) {
    end--;
    nextEnd--;
  }

  const sourceStart = sourceOffset(draft.body, start);
  const sourceEnd = sourceOffset(draft.body, end);
  const newline = draft.body.match(/\r\n|\n|\r/)?.[0] ?? "\n";
  const insert = visibleBody.slice(start, nextEnd).replaceAll("\n", newline);
  const shift = insert.length - (sourceEnd - sourceStart);
  return {
    body:
      draft.body.slice(0, sourceStart) + insert + draft.body.slice(sourceEnd),
    comments: draft.comments.map((comment) => {
      if (comment.end <= sourceStart) return comment;
      if (comment.start >= sourceEnd) {
        return {
          ...comment,
          start: comment.start + shift,
          end: comment.end + shift,
        };
      }
      return { ...comment, start: sourceStart, end: sourceStart };
    }),
  };
}

export function isAnchored(body: string, comment: Comment): boolean {
  return body.slice(comment.start, comment.end) === comment.quote;
}
