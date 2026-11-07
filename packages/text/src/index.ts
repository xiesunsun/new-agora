import { diffLines } from "diff";

export type TextChange = {
  id: string;
  start: number;
  end: number;
  before: string;
  after: string;
};

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
