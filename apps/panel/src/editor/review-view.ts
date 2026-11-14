import { renderMarkdown } from "./markdown.js";
import { parseMarkdown } from "./markdown-syntax.js";
import type { ReviewReading } from "./review-document.js";

type Character = { from: number; end: number };
type MappedText = { node: Text; characters: Character[] };
type Chunk = { from: number; end: number; node: ChildNode; inline: boolean };
export interface RichReviewReading {
  extract(from: number, end: number, structural?: boolean): DocumentFragment;
}

export function createReviewReading(reading: ReviewReading): RichReviewReading {
  const tree = parseMarkdown(reading.source);
  const rendered = renderMarkdown(reading.source, tree);
  const sourceNodes = tree.children.filter(
    (node) => node.type !== "definition",
  );
  const chunks: Chunk[] = sourceNodes.flatMap((source, index) => {
    const node = rendered.root.childNodes[index];
    return node
      ? [
          {
            from: source.position?.start.offset ?? 0,
            end: source.position?.end.offset ?? 0,
            node,
            inline: source.type === "paragraph" || source.type === "heading",
          },
        ]
      : [];
  });
  const originals: MappedText[] = [];
  const walker = document.createTreeWalker(rendered.root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!(node instanceof Text)) continue;
    const characters: Character[] = [];
    for (let offset = 0; offset < node.length; offset++) {
      const from = rendered.sourcePoint(node, offset, "start"),
        end = rendered.sourcePoint(node, offset + 1, "end");
      if (from === null || end === null)
        throw new Error("审阅文字无法准确关联原文");
      characters.push({ from, end });
    }
    originals.push({ node, characters });
  }
  const texts: MappedText[] = [];
  const fine = new Set(
    reading.marks
      .filter((mark) => mark.mark === "equal")
      .map((mark) => mark.id),
  );
  for (const { node, characters } of originals) {
    const content = document.createDocumentFragment();
    let offset = 0;
    while (offset < node.length) {
      const current = characters[offset];
      const mark = reading.marks.find(
        (value) =>
          current && value.from < current.end && value.end > current.from,
      );
      let end = offset + 1;
      while (end < node.length) {
        const character = characters[end];
        const next = reading.marks.find(
          (value) =>
            character &&
            value.from < character.end &&
            value.end > character.from,
        );
        if (next !== mark) break;
        end++;
      }
      const text = document.createTextNode(node.data.slice(offset, end));
      texts.push({ node: text, characters: characters.slice(offset, end) });
      if (mark) {
        const kind =
          !fine.has(mark.id) && mark.mark !== "settled" ? "whole" : mark.mark;
        const fragment = document.createElement(
          kind === "insert" ? "ins" : kind === "delete" ? "del" : "span",
        );
        fragment.className = `review-fragment ${kind}-fragment`;
        fragment.dataset.reviewRef = mark.id;
        fragment.append(text);
        content.append(fragment);
      } else content.append(text);
      offset = end;
    }
    node.replaceWith(content);
  }
  function pointAt(
    offset: number,
    edge: "start" | "end",
  ): [Node, number] | null {
    if (edge === "start") {
      for (const entry of texts) {
        const i = entry.characters.findIndex((value) => value.end > offset);
        if (i >= 0) return [entry.node, i];
      }
      const last = texts.at(-1);
      return last ? [last.node, last.node.length] : null;
    }
    for (const entry of [...texts].reverse())
      for (let i = entry.characters.length - 1; i >= 0; i--)
        if (entry.characters[i].from < offset) return [entry.node, i + 1];
    const first = texts[0];
    return first ? [first.node, 0] : null;
  }
  return {
    extract(from, end, structural = false) {
      const result = document.createDocumentFragment();
      if (from >= end) return result;
      const selected = chunks.filter(
        (chunk) => chunk.end > from && chunk.from < end,
      );
      if (structural || selected.some((chunk) => !chunk.inline)) {
        for (const chunk of selected) {
          const node = chunk.node.cloneNode(true);
          if (node instanceof HTMLElement) {
            node.classList.add("review-rich-block");
            for (const prose of node.querySelectorAll(".markdown-reading"))
              prose.removeAttribute("tabindex");
          }
          result.append(node);
        }
        return result;
      }
      const first = pointAt(from, "start"),
        last = pointAt(end, "end");
      if (!first || !last) return result;
      const range = document.createRange();
      range.setStart(...first);
      range.setEnd(...last);
      let content: Node = range.cloneContents();
      const common = range.commonAncestorContainer;
      const parent = common instanceof Element ? common : common.parentElement;
      const prose = parent?.closest(".markdown-reading");
      for (
        let ancestor = parent;
        ancestor && prose && ancestor !== prose;
        ancestor = ancestor.parentElement
      ) {
        const wrapper = ancestor.cloneNode(false);
        wrapper.appendChild(content);
        content = wrapper;
      }
      result.append(content);
      return result;
    },
  };
}
