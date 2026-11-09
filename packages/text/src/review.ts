import { diffArrays } from "diff";
import type { TextChange } from "./types.js";

type Atom = { kind: "gap" | "prose" | "heading" | "sentence"; text: string };
type Hunk = Omit<TextChange, "id"> & { oldAtoms: Atom[]; newAtoms: Atom[] };
type Budget = {
  maxLength: number;
  maxAtoms: number;
  maxEditLength: number;
  timeoutMs: number;
  now: () => number;
};
const defaultBudget: Budget = {
  maxLength: 200_000,
  maxAtoms: 16_384,
  maxEditLength: 4096,
  timeoutMs: 60,
  now: Date.now,
};

function blocks(text: string): Atom[] {
  return text
    .split(/((?:\r\n|\r|\n)[ \t]*(?:\r\n|\r|\n)(?:[ \t]*(?:\r\n|\r|\n))*)/)
    .flatMap((raw, index): Atom[] => {
      if (!raw) return [];
      if (index % 2) return [{ kind: "gap", text: raw }];
      const result: Atom[] = [];
      let cursor = 0;
      const prose = (value: string): Atom => ({
        kind: /^\s+$/.test(value) ? "gap" : "prose",
        text: value,
      });
      for (const match of raw.matchAll(
        /(?:^|(?<=[\r\n]))\uFEFF?#{1,6}[ \t][^\r\n]*/g,
      )) {
        if (match.index > cursor)
          result.push(prose(raw.slice(cursor, match.index)));
        result.push({ kind: "heading", text: match[0] });
        cursor = match.index + match[0].length;
      }
      if (cursor < raw.length) result.push(prose(raw.slice(cursor)));
      return result;
    });
}

function sentences(text: string): Atom[] {
  const segmenter = new Intl.Segmenter("zh-CN", { granularity: "sentence" });
  return Array.from(segmenter.segment(text)).flatMap(({ segment }): Atom[] => {
    const leading = segment.match(/^\s*/)?.[0] ?? "";
    const trailing = segment.slice(leading.length).match(/\s*$/)?.[0] ?? "";
    const content = segment.slice(
      leading.length,
      segment.length - trailing.length,
    );
    return [
      ...(leading ? [{ kind: "gap" as const, text: leading }] : []),
      ...(content ? [{ kind: "sentence" as const, text: content }] : []),
      ...(trailing ? [{ kind: "gap" as const, text: trailing }] : []),
    ];
  });
}

export function reviewUnitsBetween(
  base: string,
  candidate: string,
): TextChange[] {
  return reviewUnitsWithinBudget(base, candidate);
}

export function reviewUnitsWithinBudget(
  base: string,
  candidate: string,
  overrides: Partial<Budget> = {},
): TextChange[] {
  if (base === candidate) return [];
  const fallback = (): TextChange[] => [
    { id: "1", start: 0, end: base.length, before: base, after: candidate },
  ];
  const budget = { ...defaultBudget, ...overrides };
  if (base.length + candidate.length > budget.maxLength) return fallback();
  const deadline = budget.now() + budget.timeoutMs;
  let remainingAtoms = budget.maxAtoms;

  function hunks(
    oldAtoms: Atom[],
    newAtoms: Atom[],
    start: number,
    cap: number,
  ): Hunk[] {
    const count = oldAtoms.length + newAtoms.length;
    remainingAtoms -= count;
    if (count > cap || remainingAtoms < 0 || budget.now() >= deadline)
      throw new Error("Review unit budget exceeded");
    const key = (value: Atom) => `${value.kind}\0${value.text}`;
    const options = {
      maxEditLength: budget.maxEditLength,
      timeout: Math.max(1, deadline - budget.now()),
    };
    const parts = diffArrays(oldAtoms.map(key), newAtoms.map(key), options);
    if (!parts || budget.now() >= deadline)
      throw new Error("Review unit deadline exceeded");
    const result: Hunk[] = [];
    let oldIndex = 0;
    let newIndex = 0;
    let cursor = start;
    let pending: Hunk | undefined;
    for (const part of parts) {
      const count = part.value.length;
      if (!part.added && !part.removed) {
        cursor += oldAtoms
          .slice(oldIndex, oldIndex + count)
          .reduce((length, value) => length + value.text.length, 0);
        oldIndex += count;
        newIndex += count;
        pending = undefined;
        continue;
      }
      if (!pending) {
        pending = {
          start: cursor,
          end: cursor,
          before: "",
          after: "",
          oldAtoms: [],
          newAtoms: [],
        };
        result.push(pending);
      }
      const values = part.added
        ? newAtoms.slice(newIndex, newIndex + count)
        : oldAtoms.slice(oldIndex, oldIndex + count);
      const text = values.map((value) => value.text).join("");
      if (part.added) {
        pending.after += text;
        pending.newAtoms.push(...values);
        newIndex += count;
      } else {
        pending.before += text;
        pending.oldAtoms.push(...values);
        oldIndex += count;
        cursor += text.length;
        pending.end = cursor;
      }
    }
    return result;
  }

  try {
    const changes: Omit<TextChange, "id">[] = [];
    for (const block of hunks(blocks(base), blocks(candidate), 0, 8192)) {
      if (
        block.oldAtoms.length !== 1 ||
        block.newAtoms.length !== 1 ||
        block.oldAtoms[0].kind !== "prose" ||
        block.newAtoms[0].kind !== "prose"
      ) {
        changes.push(block);
        continue;
      }
      for (const sentence of hunks(
        sentences(block.before),
        sentences(block.after),
        block.start,
        2048,
      )) {
        const oldContent = sentence.oldAtoms.filter(
          (value) => value.kind !== "gap",
        );
        const newContent = sentence.newAtoms.filter(
          (value) => value.kind !== "gap",
        );
        const gaps = (values: Atom[]) =>
          values
            .filter((value) => value.kind === "gap")
            .map((value) => value.text);
        if (
          oldContent.length > 1 &&
          oldContent.length === newContent.length &&
          JSON.stringify(gaps(sentence.oldAtoms)) ===
            JSON.stringify(gaps(sentence.newAtoms))
        ) {
          let cursor = sentence.start;
          for (let index = 0; index < sentence.oldAtoms.length; index++) {
            const oldAtom = sentence.oldAtoms[index];
            const newAtom = sentence.newAtoms[index];
            if (!newAtom || oldAtom.kind !== newAtom.kind)
              throw new Error("Sentence boundaries changed");
            if (oldAtom.text !== newAtom.text)
              changes.push({
                start: cursor,
                end: cursor + oldAtom.text.length,
                before: oldAtom.text,
                after: newAtom.text,
              });
            cursor += oldAtom.text.length;
          }
        } else changes.push(sentence);
      }
    }
    const units = changes.map(({ start, end, before, after }, index) => ({
      id: String(index + 1),
      start,
      end,
      before,
      after,
    }));
    let cursor = 0;
    const rebuilt: string[] = [];
    for (const unit of units) {
      if (
        unit.start < cursor ||
        unit.end < unit.start ||
        unit.before !== base.slice(unit.start, unit.end)
      )
        return fallback();
      rebuilt.push(base.slice(cursor, unit.start), unit.after);
      cursor = unit.end;
    }
    rebuilt.push(base.slice(cursor));
    return rebuilt.join("") === candidate ? units : fallback();
  } catch {
    return fallback();
  }
}
