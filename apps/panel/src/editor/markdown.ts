import type { Definition, Nodes, Root } from "mdast";
import { parseMarkdown } from "./markdown-syntax.js";
export { parseMarkdown } from "./markdown-syntax.js";
import { decodeString } from "micromark-util-decode-string";
import type { ManuscriptBlock } from "./markdown-syntax.js";

export type MarkdownBlock = ManuscriptBlock & {
  node: HTMLElement;
  wrapper: HTMLElement;
};
type Point = [Node, number];
type Edge = "start" | "end";
type SourceCharacter = { value: string; from: number; end: number };
type MappedText = { node: Text; characters: SourceCharacter[] };

function sourceLines(raw: string, from: number) {
  const lines: { text: string; from: number; end: number; next: number }[] = [];
  let offset = 0;
  for (const match of raw.matchAll(/\r\n|\r|\n/g)) {
    lines.push({
      text: raw.slice(offset, match.index),
      from: from + offset,
      end: from + match.index,
      next: from + match.index + match[0].length,
    });
    offset = match.index + match[0].length;
  }
  lines.push({
    text: raw.slice(offset),
    from: from + offset,
    end: from + raw.length,
    next: from + raw.length,
  });
  return lines;
}

function sourceCharacters(
  raw: string,
  from: number,
  decode: boolean,
  inlineCode: boolean,
  quoteDepth = 0,
): SourceCharacter[] {
  const characters: SourceCharacter[] = [];
  for (const [index, line] of sourceLines(raw, from).entries()) {
    let start = 0,
      end = line.text.length;
    if (decode && index > 0) {
      start = line.text.match(/^[ \t]*/)?.[0].length ?? 0;
      for (
        let quote = 0;
        quote < quoteDepth && line.text[start] === ">";
        quote++
      ) {
        start++;
        start += line.text.slice(start).match(/^[ \t]*/)?.[0].length ?? 0;
      }
    }
    if (decode && line.next > line.end)
      while (end > start && /[ \t]/.test(line.text[end - 1])) end--;
    let position = start;
    const plain = (stop: number) => {
      while (position < stop) {
        characters.push({
          value: line.text[position],
          from: line.from + position,
          end: line.from + position + 1,
        });
        position++;
      }
    };
    const content = line.text.slice(start, end);
    const tokens =
      /\\[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]|&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]*);/gi;
    for (const match of content.matchAll(tokens)) {
      plain(start + match.index);
      const token = match[0],
        value = decode ? decodeString(token) : token;
      if (value === token) plain(position + token.length);
      else {
        for (let character = 0; character < value.length; character++)
          characters.push({
            value: value[character],
            from: line.from + position,
            end: line.from + position + token.length,
          });
        position += token.length;
      }
    }
    plain(end);
    if (line.next > line.end)
      characters.push({
        value: inlineCode ? " " : "\n",
        from: line.end,
        end: line.next,
      });
  }
  return characters;
}

function codeCharacters(
  raw: string,
  from: number,
  value: string,
): SourceCharacter[] | null {
  if (!value) return [];
  const opening = raw.match(/^ {0,3}(`{3,}|~{3,})[^\r\n]*(?:\r\n|\n|\r)/);
  const prefix = opening?.[0].length ?? 0;
  let lines = sourceLines(raw.slice(prefix), from + prefix);
  const values = value.split("\n");
  const closing = lines.at(-1)?.text.match(/^[ \t>]*(`+|~+)[ \t]*$/);
  if (
    opening &&
    closing &&
    closing[1][0] === opening[1][0] &&
    closing[1].length >= opening[1].length &&
    lines.length === values.length + 1
  )
    lines = lines.slice(0, -1);
  if (lines.length !== values.length) return null;
  const characters: SourceCharacter[] = [];
  for (const [index, line] of lines.entries()) {
    const text = values[index],
      skipped = line.text.length - text.length;
    if (
      skipped < 0 ||
      !line.text.endsWith(text) ||
      !/^[ \t>]*$/.test(line.text.slice(0, skipped))
    )
      return null;
    for (let character = 0; character < text.length; character++)
      characters.push({
        value: text[character],
        from: line.from + skipped + character,
        end: line.from + skipped + character + 1,
      });
    if (index < lines.length - 1)
      characters.push({ value: "\n", from: line.end, end: line.next });
  }
  return characters;
}

function safeHref(value: string): boolean {
  try {
    return ["http:", "https:", "mailto:"].includes(
      new URL(value, "https://agora.invalid/").protocol,
    );
  } catch {
    return false;
  }
}

export function renderMarkdown(body: string, tree: Root = parseMarkdown(body)) {
  const root = document.createElement("div");
  root.className = "markdown-document";
  const blocks: MarkdownBlock[] = [];
  const texts: MappedText[] = [];
  const byNode = new Map<Text, MappedText>();
  const definitions = new Map<string, Definition>();
  const collectDefinitions = (node: Nodes) => {
    if (
      node.type === "definition" &&
      !definitions.has(node.identifier.toLowerCase())
    )
      definitions.set(node.identifier.toLowerCase(), node);
    if ("children" in node)
      for (const child of node.children) collectDefinitions(child);
  };
  collectDefinitions(tree);
  let quoteDepth = 0;
  const bounds = (node: Nodes) => ({
    from: node.position?.start.offset ?? 0,
    end: node.position?.end.offset ?? 0,
  });
  function appendText(
    parent: HTMLElement,
    value: string,
    from: number,
    end: number,
    decode = true,
    inlineCode = false,
    code = false,
  ) {
    let characters = code
      ? codeCharacters(body.slice(from, end), from, value)
      : sourceCharacters(
          body.slice(from, end),
          from,
          decode,
          inlineCode,
          quoteDepth,
        );
    if (
      inlineCode &&
      characters?.[0]?.value === " " &&
      characters.at(-1)?.value === " " &&
      characters.some((character) => character.value !== " ")
    )
      characters = characters.slice(1, -1);
    const exact =
      characters?.map((character) => character.value).join("") === value;
    if (!exact)
      characters = sourceCharacters(body.slice(from, end), from, false, false);
    if (!characters) return;
    const node = document.createTextNode(
      characters.map((character) => character.value).join(""),
    );
    if (exact) parent.append(node);
    else {
      const source = document.createElement("span");
      source.className = "markdown-raw-fragment";
      source.append(node);
      parent.append(source);
    }
    if (characters.length) {
      const mapped = { node, characters };
      texts.push(mapped);
      byNode.set(node, mapped);
    }
  }
  function block(tag: string, node: Nodes, parent: HTMLElement) {
    const wrapper = document.createElement("section"),
      host = document.createElement(tag);
    wrapper.className = "block";
    host.className = "prose markdown-reading";
    host.tabIndex = 0;
    host.setAttribute("aria-readonly", "true");
    wrapper.append(host);
    parent.append(wrapper);
    const source = bounds(node),
      raw = body.slice(source.from, source.end);
    blocks.push({
      ...source,
      raw,
      prefix: "",
      text: raw,
      tag: tag === "h1" || tag === "h2" ? tag : "p",
      subtitle: false,
      node: host,
      wrapper,
    });
    return host;
  }
  function children(node: Nodes, parent: HTMLElement) {
    if ("children" in node)
      for (const child of node.children) render(child, parent);
  }
  function render(node: Nodes, parent: HTMLElement) {
    const source = bounds(node);
    switch (node.type) {
      case "heading":
        children(node, block(`h${node.depth}`, node, parent));
        break;
      case "paragraph":
        children(node, block("p", node, parent));
        break;
      case "text":
        appendText(parent, node.value, source.from, source.end);
        break;
      case "strong":
      case "emphasis":
      case "delete": {
        const host = document.createElement(
          node.type === "strong"
            ? "strong"
            : node.type === "emphasis"
              ? "em"
              : "del",
        );
        children(node, host);
        parent.append(host);
        break;
      }
      case "link":
      case "linkReference": {
        const definition =
          node.type === "linkReference"
            ? definitions.get(node.identifier.toLowerCase())
            : node;
        const host = document.createElement(
          definition && safeHref(definition.url) ? "a" : "span",
        );
        if (host instanceof HTMLAnchorElement && definition) {
          host.href = definition.url;
          host.target = "_blank";
          host.rel = "noopener noreferrer";
          if (definition.title) host.title = definition.title;
        }
        children(node, host);
        parent.append(host);
        break;
      }
      case "list": {
        const host = document.createElement(node.ordered ? "ol" : "ul");
        host.className = "markdown-list";
        if (
          host instanceof HTMLOListElement &&
          node.start !== null &&
          node.start !== undefined
        )
          host.start = node.start;
        children(node, host);
        parent.append(host);
        break;
      }
      case "listItem": {
        const host = document.createElement("li");
        if (typeof node.checked === "boolean") {
          const check = document.createElement("input");
          check.type = "checkbox";
          check.disabled = true;
          check.checked = node.checked;
          check.setAttribute("aria-label", node.checked ? "已完成" : "未完成");
          host.append(check);
          host.className = "markdown-task";
        }
        children(node, host);
        parent.append(host);
        break;
      }
      case "blockquote": {
        const host = document.createElement("blockquote");
        quoteDepth++;
        children(node, host);
        quoteDepth--;
        parent.append(host);
        break;
      }
      case "inlineCode": {
        const host = document.createElement("code");
        const raw = body.slice(source.from, source.end),
          fence = raw.match(/^`+/)?.[0].length ?? 0;
        appendText(
          host,
          node.value,
          source.from + fence,
          source.end - fence,
          false,
          true,
        );
        parent.append(host);
        break;
      }
      case "code": {
        const host = block("pre", node, parent),
          code = document.createElement("code");
        host.classList.add("markdown-code");
        appendText(
          code,
          node.value,
          source.from,
          source.end,
          false,
          false,
          true,
        );
        host.append(code);
        break;
      }
      case "table": {
        const overflow = document.createElement("div"),
          table = document.createElement("table");
        overflow.className = "markdown-table";
        for (const [rowIndex, row] of node.children.entries()) {
          const tr = document.createElement("tr");
          for (const [index, cell] of row.children.entries()) {
            const td = document.createElement(rowIndex ? "td" : "th");
            const align = node.align?.[index];
            if (align) td.style.textAlign = align;
            children(cell, block("p", cell, td));
            tr.append(td);
          }
          table.append(tr);
        }
        overflow.append(table);
        parent.append(overflow);
        break;
      }
      case "thematicBreak":
        parent.append(document.createElement("hr"));
        break;
      case "break":
        parent.append(document.createElement("br"));
        break;
      case "html":
        appendText(
          parent.classList.contains("markdown-reading")
            ? parent
            : block("pre", node, parent),
          node.value,
          source.from,
          source.end,
          false,
        );
        break;
      case "image":
      case "imageReference": {
        const host = document.createElement("span");
        host.className = "markdown-image";
        host.setAttribute("role", "img");
        host.setAttribute("aria-label", node.alt || "图片");
        appendText(
          host,
          body.slice(source.from, source.end),
          source.from,
          source.end,
          false,
        );
        parent.append(host);
        break;
      }
      case "definition":
        break;
      default:
        if ("children" in node) children(node, parent);
        else if ("value" in node && typeof node.value === "string")
          appendText(parent, node.value, source.from, source.end, false);
        else
          appendText(
            parent,
            body.slice(source.from, source.end),
            source.from,
            source.end,
            false,
          );
    }
  }
  for (const node of tree.children) render(node, root);

  function sourcePoint(
    container: Node,
    offset: number,
    edge: Edge,
  ): number | null {
    if (!root.contains(container)) return null;
    const mapped =
      container instanceof Text ? byNode.get(container) : undefined;
    if (mapped) {
      if (edge === "start")
        return mapped.characters[offset]?.from ?? mapped.characters.at(-1)!.end;
      return mapped.characters[offset - 1]?.end ?? mapped.characters[0].from;
    }
    for (const entry of edge === "start" ? texts : [...texts].reverse()) {
      const range = document.createRange();
      range.selectNodeContents(entry.node);
      const relation = range.comparePoint(container, offset);
      if (
        (edge === "start" && relation <= 0) ||
        (edge === "end" && relation >= 0)
      )
        return edge === "start"
          ? entry.characters[0].from
          : entry.characters.at(-1)!.end;
    }
    return null;
  }
  function pointAt(offset: number, edge: Edge): Point | null {
    if (edge === "start") {
      for (const entry of texts) {
        const index = entry.characters.findIndex(
          (character) => character.end > offset,
        );
        if (index >= 0) return [entry.node, index];
      }
      const last = texts.at(-1);
      return last ? [last.node, last.node.length] : null;
    }
    for (let index = texts.length - 1; index >= 0; index--) {
      const entry = texts[index];
      for (
        let character = entry.characters.length - 1;
        character >= 0;
        character--
      )
        if (entry.characters[character].from < offset)
          return [entry.node, character + 1];
    }
    return texts[0] ? [texts[0].node, 0] : null;
  }
  function rangeFor(start: number, end: number): Range | null {
    const first = pointAt(start, "start"),
      last = pointAt(end, "end");
    if (!first || !last) return null;
    const range = document.createRange();
    range.setStart(...first);
    range.setEnd(...last);
    return range;
  }
  return { root, blocks, sourcePoint, pointAt, rangeFor };
}
