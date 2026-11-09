import { diffLines } from "diff";

import type { TextChange } from "./types.js";
export type { TextChange } from "./types.js";

export function changesBetween(before: string, after: string): TextChange[] {
  const parts = diffLines(before, after, { maxEditLength: 4096 });
  if (!parts) {
    return [{ id: "1", start: 0, end: before.length, before, after }];
  }
  const changes: TextChange[] = [];
  let offset = 0;
  let pending: TextChange | undefined;

  for (const part of parts) {
    if (!part.added && !part.removed) {
      pending = undefined;
      offset += part.value.length;
      continue;
    }
    if (!pending) {
      pending = {
        id: String(changes.length + 1),
        start: offset,
        end: offset,
        before: "",
        after: "",
      };
      changes.push(pending);
    }
    if (part.added) {
      pending.after += part.value;
    } else {
      offset += part.value.length;
      pending.end = offset;
      pending.before += part.value;
    }
  }
  return changes;
}

export function applyChanges(
  base: string,
  changes: readonly TextChange[],
  kept: readonly string[],
): string {
  const selected = new Set(kept);
  const result: string[] = [];
  let offset = 0;
  for (const change of changes) {
    if (!selected.has(change.id)) continue;
    result.push(base.slice(offset, change.start), change.after);
    offset = change.end;
  }
  result.push(base.slice(offset));
  return result.join("");
}

export { reviewUnitsBetween } from "./review.js";

export type CommentAnchor = {
  start: number;
  end: number;
  quote: string;
  resolved: boolean;
  focusOffset: number;
};

export function reanchorComments<T extends CommentAnchor>(
  comments: readonly T[],
  before: string,
  after: string,
): T[] {
  let left = 0;
  while (
    left < before.length &&
    left < after.length &&
    before[left] === after[left]
  )
    left++;
  let oldRight = before.length;
  let newRight = after.length;
  while (
    oldRight > left &&
    newRight > left &&
    before[oldRight - 1] === after[newRight - 1]
  ) {
    oldRight--;
    newRight--;
  }
  const delta = after.length - before.length;
  return comments.map((source) => {
    const note = {
      ...source,
      focusOffset:
        source.focusOffset >= source.start && source.focusOffset <= source.end
          ? source.focusOffset
          : source.end,
    };
    if (!note.resolved) return { ...note };
    if (
      !note.quote ||
      note.start < 0 ||
      note.end < note.start ||
      before.slice(note.start, note.end) !== note.quote
    )
      return { ...note, resolved: false };
    if (note.end <= left) return { ...note };
    if (
      note.start >= oldRight &&
      after.slice(note.start + delta, note.end + delta) === note.quote
    )
      return {
        ...note,
        start: note.start + delta,
        end: note.end + delta,
        focusOffset: note.focusOffset + delta,
      };
    const first = after.indexOf(note.quote);
    const prefix = before.slice(Math.max(0, note.start - 12), note.start);
    const suffix = before.slice(note.end, note.end + 12);
    const unique = first >= 0 && after.indexOf(note.quote, first + 1) < 0;
    const context =
      unique &&
      ((prefix &&
        after.slice(Math.max(0, first - prefix.length), first) === prefix) ||
        (suffix &&
          after.slice(
            first + note.quote.length,
            first + note.quote.length + suffix.length,
          ) === suffix));
    return context
      ? {
          ...note,
          start: first,
          end: first + note.quote.length,
          focusOffset: first + note.focusOffset - note.start,
        }
      : { ...note, resolved: false };
  });
}
