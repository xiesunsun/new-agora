import type { Change } from "../../../../packages/contracts/src/index.js";
import { manuscriptBlocks as parts } from "./markdown-syntax.js";
import type { ManuscriptBlock } from "./markdown-syntax.js";
export interface ReviewProjectionInput {
  base: string;
  candidate: string;
  changes: Change[];
  choices: Record<string, "pending" | "keep" | "discard">;
}
type Mark = "equal" | "insert" | "delete" | "settled";
interface Span {
  tag: "text" | "edit";
  text: string;
  from: number;
  end: number;
  id?: string;
  mark?: Mark;
}
interface Lane {
  text: string;
  spans: Span[];
  blocks: ManuscriptBlock[];
  reading: ReviewReading;
}
export interface ReviewReading {
  source: string;
  marks: { from: number; end: number; id: string; mark: Mark }[];
}
export interface LaneBlock {
  raw: string;
  from: number;
  end: number;
  reading: ReviewReading;
  format: Pick<ManuscriptBlock, "tag" | "subtitle">;
  runs: { tag: "text" | "edit"; id?: string; mark?: Mark; text: string }[];
}
export interface Decision {
  change: Change;
  index: number;
  kind: "insert" | "delete" | "replace";
  choice: "pending" | "keep" | "discard";
}
interface Window {
  start: number;
  end: number;
  structural: boolean;
  decisions: Decision[];
}
type Source = { start: number; end: number };
export type ReviewPart =
  | {
      tag: "context";
      text: string;
      visible: string;
      reading: ReviewReading;
      from: number;
      end: number;
    }
  | Comparison;
export type Comparison = {
  key: string;
  source: Source;
  decisions: Decision[];
  formatChanges: string[];
} & (
  | {
      tag: "comparison";
      original: LaneBlock[];
      proposal: LaneBlock[];
      readbackId: string | null;
    }
  | { tag: "settled"; blocks: LaneBlock[] }
);
export type ReviewBlock =
  | {
      tag: "paragraph";
      index: number;
      source: Source;
      format: Pick<ManuscriptBlock, "tag" | "subtitle">;
      parts: ReviewPart[];
    }
  | { tag: "structural"; comparison: Comparison };
import { applyChanges } from "../../../../packages/text/src/index.js";
import { reviewRuns } from "./review-runs.js";

function laneDocument(
  review: ReviewProjectionInput,
  selected: string[],
  fineRuns: Map<string, { tag: Mark; text: string }[]>,
  comparing: Set<string>,
): Lane {
  const text = applyChanges(review.base, review.changes, selected);
  const spans: Span[] = [];
  let source = 0,
    offset = 0;
  for (const change of review.changes) {
    const context = review.base.slice(source, change.start);
    if (context)
      spans.push({
        tag: "text",
        text: context,
        from: offset,
        end: offset + context.length,
      });
    offset += context.length;
    const value = selected.includes(change.id) ? change.after : change.before;
    const compared = comparing.has(change.id);
    const runs: { tag: Mark; text: string }[] =
      compared && fineRuns.has(change.id)
        ? fineRuns
            .get(change.id)!
            .filter(
              (run) =>
                run.tag === "equal" ||
                run.tag ===
                  (selected.includes(change.id) ? "insert" : "delete"),
            )
        : [
            {
              tag: compared
                ? selected.includes(change.id)
                  ? "insert"
                  : "delete"
                : "settled",
              text: value,
            },
          ];
    for (const run of runs) {
      spans.push({
        tag: "edit",
        id: change.id,
        text: run.text,
        from: offset,
        end: offset + run.text.length,
        mark: run.tag,
      });
      offset += run.text.length;
    }
    source = change.end;
  }
  const tail = review.base.slice(source);
  if (tail)
    spans.push({
      tag: "text",
      text: tail,
      from: offset,
      end: offset + tail.length,
    });
  return {
    text,
    spans,
    blocks: parts(text),
    reading: {
      source: text,
      marks: spans.flatMap((span) =>
        span.tag === "edit" && span.id && span.mark
          ? [{ from: span.from, end: span.end, id: span.id, mark: span.mark }]
          : [],
      ),
    },
  };
}

function projectOffset(
  review: ReviewProjectionInput,
  selected: string[],
  position: number,
  includeInsertion: (id: string) => boolean = () => false,
) {
  let offset = position;
  for (const change of review.changes) {
    if (change.end > position) break;
    if (
      change.start === position &&
      change.end === position &&
      !includeInsertion(change.id)
    )
      continue;
    if (selected.includes(change.id))
      offset += change.after.length - change.before.length;
  }
  return offset;
}

function laneSlice(
  lane: Lane,
  from: number,
  end: number,
  owned: Set<string>,
): LaneBlock[] {
  const result: LaneBlock[] = [];
  for (const [index, block] of lane.blocks.entries()) {
    const blockEnd = lane.blocks[index + 1]?.from ?? lane.text.length;
    const start = Math.max(from, block.from),
      stop = Math.min(end, blockEnd);
    if (start >= stop) continue;
    const visibleFrom = Math.max(start, block.from + block.prefix.length);
    const visibleEnd = Math.min(stop, block.end);
    const runs: LaneBlock["runs"] = [];
    for (const span of lane.spans) {
      if (span.tag === "edit" && !owned.has(span.id ?? "")) continue;
      const a = Math.max(visibleFrom, span.from),
        b = Math.min(visibleEnd, span.end);
      const emptyEdit =
        span.tag === "edit" &&
        span.from === span.end &&
        span.from >= visibleFrom &&
        span.from <= visibleEnd &&
        (span.from < stop || stop === lane.text.length);
      const hiddenEdit =
        span.tag === "edit" && span.from < stop && span.end > start && a >= b;
      if (a < b || emptyEdit || hiddenEdit)
        runs.push({
          tag: span.tag,
          ...(span.id ? { id: span.id, mark: span.mark } : {}),
          text: a < b ? lane.text.slice(a, b) : "",
        });
    }
    result.push({
      raw: lane.text.slice(start, stop),
      from: start,
      end: stop,
      reading: lane.reading,
      format: { tag: block.tag, subtitle: block.subtitle },
      runs,
    });
  }
  return result;
}

export function reviewDocument(
  review: ReviewProjectionInput,
  { openedId = null }: { openedId?: string | null } = {},
): { blocks: ReviewBlock[] } {
  const changes = review.changes;
  const readbackId =
    changes.find(
      (change) =>
        change.id === openedId && review.choices[change.id] !== "pending",
    )?.id ?? null;
  const comparing = new Set(
    changes
      .filter(
        (change) =>
          review.choices[change.id] === "pending" || change.id === readbackId,
      )
      .map((change) => change.id),
  );
  const kept = changes
    .filter(
      (change) =>
        review.choices[change.id] === "keep" && !comparing.has(change.id),
    )
    .map((change) => change.id);
  const proposed = changes
    .filter(
      (change) =>
        review.choices[change.id] === "keep" || comparing.has(change.id),
    )
    .map((change) => change.id);
  const sourceBlocks = parts(review.base);
  const segmenter = new Intl.Segmenter("zh-CN", { granularity: "sentence" });
  const multipleSentences = (text: string) => {
    let count = 0;
    for (const part of segmenter.segment(text))
      if (part.segment.trim() && ++count > 1) return true;
    return false;
  };
  const fineRuns = new Map<string, { tag: Mark; text: string }[]>();
  let cells = 800000,
    characters = 200000;
  for (const change of changes) {
    if (!comparing.has(change.id) || !change.before || !change.after) continue;
    const cost = (change.before.length + 1) * (change.after.length + 1);
    const length = change.before.length + change.after.length;
    if (cost > cells || cost > 200000 || length > characters) continue;
    const wholeParagraph = sourceBlocks.some(
      (block) =>
        !block.prefix &&
        change.start === block.from &&
        change.end === block.end,
    );
    if (
      wholeParagraph &&
      multipleSentences(change.before) &&
      multipleSentences(change.after)
    )
      continue;
    cells -= cost;
    characters -= length;
    fineRuns.set(
      change.id,
      reviewRuns(change.before, change.after).map((run) => ({
        tag: run.kind,
        text: run.text,
      })),
    );
  }
  const original = laneDocument(review, kept, fineRuns, comparing),
    proposal = laneDocument(review, proposed, fineRuns, comparing);
  const laneFormat = (lane: Lane, selected: string[], position: number) => {
    const offset = projectOffset(review, selected, position);
    return (
      lane.blocks.find(
        (block, index) =>
          offset >= block.from &&
          offset < (lane.blocks[index + 1]?.from ?? lane.text.length),
      ) ?? lane.blocks.at(-1)!
    ).tag;
  };
  const blockAt = (position: number) => {
    const index = sourceBlocks.findIndex(
      (block, i) =>
        position >= block.from &&
        position < (sourceBlocks[i + 1]?.from ?? review.base.length),
    );
    return index < 0 ? sourceBlocks.length - 1 : index;
  };
  const sentenceCache = new Map<number, Source[]>();
  const sentences = (index: number): Source[] => {
    if (!sentenceCache.has(index)) {
      const block = sourceBlocks[index];
      const spans =
        block.raw.length > 50000
          ? [{ index: 0, segment: block.raw }]
          : Array.from(
              new Intl.Segmenter("zh-CN", { granularity: "sentence" }).segment(
                block.raw,
              ),
            );
      sentenceCache.set(
        index,
        spans.map((part) => ({
          start: block.from + part.index,
          end: block.from + part.index + part.segment.length,
        })),
      );
    }
    return sentenceCache.get(index)!;
  };
  const allIds = changes.map((change) => change.id);
  const candidate = review.candidate;
  const boundaryCache = new Map<string, (Source & { paragraph?: boolean })[]>();
  const completeContentRange = (
    text: string,
    start: number,
    end: number,
    paragraphOnly: boolean,
  ) => {
    if (!boundaryCache.has(text)) {
      const ranges: (Source & { paragraph?: boolean })[] =
        text.length > 50000
          ? []
          : Array.from(
              new Intl.Segmenter("zh-CN", { granularity: "sentence" }).segment(
                text,
              ),
              (part) => {
                const leading = part.segment.match(/^\s*/)![0].length;
                const trailing = part.segment.match(/\s*$/)![0].length;
                return {
                  start: part.index + leading,
                  end: part.index + part.segment.length - trailing,
                };
              },
            );
      for (const block of parts(text)) {
        if (!block.raw.trim()) continue;
        ranges.push({
          start: block.from + block.raw.match(/^\s*/)![0].length,
          end: block.end - block.raw.match(/\s*$/)![0].length,
          paragraph: true,
        });
      }
      boundaryCache.set(text, ranges);
    }
    const owned = text.slice(start, end);
    if (!owned.trim()) return false;
    const contentStart = start + owned.match(/^\s*/)![0].length;
    const contentEnd = end - owned.match(/\s*$/)![0].length;
    const ranges = boundaryCache
      .get(text)!
      .filter((range) => !paragraphOnly || range.paragraph);
    return (
      ranges.some((a) => a.start === contentStart) &&
      ranges.some((b) => b.end === contentEnd)
    );
  };
  const windows: Window[] = [];
  for (const [index, change] of changes.entries()) {
    const first = blockAt(change.start);
    let last = blockAt(Math.max(change.start, change.end - 1));
    const block = sourceBlocks[first];
    const structural =
      Boolean(block.structural) ||
      laneFormat(original, kept, change.start) !==
        laneFormat(proposal, proposed, change.start) ||
      first !== last ||
      /[\r\n]/.test(change.before + change.after) ||
      change.start < block.from + block.prefix.length ||
      change.end > block.end;
    if (
      structural &&
      (change.start >= block.end || change.end > sourceBlocks[last].end) &&
      last + 1 < sourceBlocks.length
    )
      last++;
    let start, end;
    const candidateStart = projectOffset(
      review,
      allIds,
      change.start,
      (id) => id !== change.id,
    );
    const exactOneSided =
      (!change.before || !change.after) &&
      ((!change.after &&
        completeContentRange(
          review.base,
          change.start,
          change.end,
          structural || Boolean(block.prefix),
        )) ||
        (!change.before &&
          completeContentRange(
            candidate,
            candidateStart,
            candidateStart + change.after.length,
            structural || Boolean(block.prefix),
          )));
    if (exactOneSided) {
      start = change.start;
      end = change.end;
    } else if (structural || block.prefix) {
      start = block.from;
      end = sourceBlocks[last + 1]?.from ?? review.base.length;
    } else {
      const spans = sentences(first);
      const a =
        spans.find(
          (span) => change.start >= span.start && change.start < span.end,
        ) ?? spans.at(-1);
      const b =
        spans.find(
          (span) =>
            Math.max(change.start, change.end - 1) >= span.start &&
            Math.max(change.start, change.end - 1) < span.end,
        ) ?? a;
      start = a?.start ?? change.start;
      end = b?.end ?? change.end;
    }
    const decision: Decision = {
      change,
      index,
      kind: !change.before ? "insert" : !change.after ? "delete" : "replace",
      choice: review.choices[change.id] ?? "pending",
    };
    windows.push({
      start,
      end,
      structural: structural || Boolean(block.prefix),
      decisions: [decision],
    });
  }
  windows.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Window[] = [];
  for (const window of windows) {
    const previous = merged.at(-1);
    if (
      previous &&
      (window.start < previous.end || window.start === previous.start)
    ) {
      previous.end = Math.max(previous.end, window.end);
      previous.structural ||= window.structural;
      previous.decisions.push(...window.decisions);
      previous.decisions.sort((a, b) => a.index - b.index);
    } else merged.push(window);
  }
  const blocks: ReviewBlock[] = [];
  function paragraph(
    index: number,
    start: number,
    end: number,
    part: ReviewPart,
  ) {
    const previous = blocks.at(-1);
    const offset = projectOffset(review, proposed, start, () => true);
    const block =
      proposal.blocks.find(
        (block, index) =>
          offset >= block.from &&
          offset < (proposal.blocks[index + 1]?.from ?? proposal.text.length),
      ) ?? proposal.blocks.at(-1)!;
    if (previous?.tag === "paragraph" && previous.index === index) {
      previous.source.end = end;
      previous.parts.push(part);
    } else
      blocks.push({
        tag: "paragraph",
        index,
        source: { start, end },
        format: { tag: block.tag, subtitle: block.subtitle },
        parts: [part],
      });
  }
  function context(from: number, end: number) {
    let cursor = from;
    while (cursor < end) {
      const index = blockAt(cursor),
        block = sourceBlocks[index];
      const stop = Math.min(
        end,
        sourceBlocks[index + 1]?.from ?? review.base.length,
      );
      const text = review.base.slice(cursor, stop);
      paragraph(index, cursor, stop, {
        tag: "context",
        text,
        reading: proposal.reading,
        from: projectOffset(
          review,
          proposed,
          Math.max(cursor, block.from + block.prefix.length),
        ),
        end: projectOffset(review, proposed, Math.min(stop, block.end)),
        visible: review.base.slice(
          Math.max(cursor, block.from + block.prefix.length),
          Math.min(stop, block.end),
        ),
      });
      cursor = stop;
    }
  }
  let cursor = 0;
  for (const window of merged) {
    context(cursor, window.start);
    const source = { start: window.start, end: window.end };
    const owned = new Set(
      window.decisions.map((decision) => decision.change.id),
    );
    const slice = (lane: Lane, selected: string[]) =>
      laneSlice(
        lane,
        projectOffset(review, selected, source.start, (id) => !owned.has(id)),
        projectOffset(review, selected, source.end, (id) => owned.has(id)),
        owned,
      );
    const originalBlocks = slice(original, kept),
      proposalBlocks = slice(proposal, proposed);
    const compared = window.decisions.some((decision) =>
      comparing.has(decision.change.id),
    );
    const formatChanges = [];
    if (
      window.decisions.some(
        ({ change }) =>
          comparing.has(change.id) &&
          (change.before.match(/\r\n|[\r\n]/g) ?? []).join("") !==
            (change.after.match(/\r\n|[\r\n]/g) ?? []).join(""),
      )
    )
      formatChanges.push("paragraph-boundary");
    if (
      originalBlocks
        .filter((block) => block.format.tag !== "p")
        .map((block) => block.format.tag)
        .join() !==
      proposalBlocks
        .filter((block) => block.format.tag !== "p")
        .map((block) => block.format.tag)
        .join()
    )
      formatChanges.push("heading");
    if (
      window.decisions.some(
        ({ change }) =>
          comparing.has(change.id) &&
          /^\s+$/.test(change.before + change.after),
      )
    )
      formatChanges.push("whitespace");
    const part: Comparison = compared
      ? {
          tag: "comparison",
          key: window.decisions.map((decision) => decision.change.id).join("-"),
          source,
          decisions: window.decisions,
          formatChanges,
          original: originalBlocks,
          proposal: proposalBlocks,
          readbackId: window.decisions.some(
            (decision) => decision.change.id === readbackId,
          )
            ? readbackId
            : null,
        }
      : {
          tag: "settled",
          key: window.decisions.map((decision) => decision.change.id).join("-"),
          source,
          decisions: window.decisions,
          formatChanges,
          blocks: proposalBlocks,
        };

    if (window.structural || formatChanges.includes("heading"))
      blocks.push({ tag: "structural", comparison: part });
    else paragraph(blockAt(window.start), window.start, window.end, part);
    cursor = window.end;
  }
  context(cursor, review.base.length);
  return { blocks };
}
