import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import type { Mapping } from "@milkdown/kit/prose/transform";
import type { RootContent } from "mdast";
import { parseMarkdown } from "./markdown-syntax.js";

export interface SourceEnvelope {
  from: number;
  end: number;
  nativeFrom: number;
  nativeEnd: number;
  node: ProseNode;
  transient: boolean;
}

export interface SourceSnapshot {
  body: string;
  doc: ProseNode;
  envelopes: readonly SourceEnvelope[];
  origin: Readonly<{ body: string; doc: ProseNode }>;
}

const nativeKinds: Partial<Record<RootContent["type"], string>> = {
  paragraph: "paragraph",
  heading: "heading",
  blockquote: "blockquote",
  code: "code_block",
  thematicBreak: "hr",
  table: "table",
};

function sourceKind(node: RootContent): string | null {
  if (node.type === "definition") return null;
  if (node.type === "list")
    return node.ordered ? "ordered_list" : "bullet_list";
  if (node.type === "html" && node.value.trim() === "<br />")
    return "paragraph";
  const kind = nativeKinds[node.type];
  if (!kind) throw new Error("此段 Markdown 需要使用源码编辑。");
  return kind;
}

export function sourceSnapshot(body: string, doc: ProseNode): SourceSnapshot {
  const sources = parseMarkdown(body).children.flatMap((node) => {
    const kind = sourceKind(node);
    return kind ? [{ node, kind }] : [];
  });
  const envelopes: SourceEnvelope[] = [];
  let nativeFrom = 0;
  doc.forEach((node, _offset, index) => {
    const source = sources[index];
    const transient =
      !source &&
      index === doc.childCount - 1 &&
      node.type.name === "paragraph" &&
      node.content.size === 0;
    if (!transient && (!source || source.kind !== node.type.name))
      throw new Error("此段 Markdown 的结构无法准确映射，请使用源码编辑。");
    const from = source?.node.position?.start.offset ?? body.length;
    const end = source?.node.position?.end.offset ?? body.length;
    envelopes.push({
      from,
      end,
      nativeFrom,
      nativeEnd: nativeFrom + node.nodeSize,
      node,
      transient,
    });
    nativeFrom += node.nodeSize;
  });
  if (sources.length > envelopes.length)
    throw new Error("此段 Markdown 包含未映射的结构，请使用源码编辑。");
  return { body, doc, envelopes, origin: { body, doc } };
}

export function projectSource(
  previous: SourceSnapshot,
  doc: ProseNode,
  canonical: string,
  mapping: Mapping,
): SourceSnapshot {
  if (doc.eq(previous.doc)) return { ...previous, doc };
  if (doc.eq(previous.origin.doc))
    return {
      ...sourceSnapshot(previous.origin.body, doc),
      origin: previous.origin,
    };
  const next = sourceSnapshot(canonical, doc);
  const represented = next.envelopes.filter((block) => !block.transient);
  const old = previous.envelopes.filter((block) => !block.transient);
  const bom = previous.body.startsWith("\uFEFF") ? "\uFEFF" : "";
  if (!represented.length)
    return { ...sourceSnapshot(bom, doc), origin: previous.origin };
  const newline = previous.body.match(/\r\n|\n|\r/)?.[0] ?? "\n";
  const chunks = represented.map((block) => {
    const original = old.find((value) => {
      const start = mapping.mapResult(value.nativeFrom, 1);
      const end = mapping.mapResult(value.nativeEnd, -1);
      return (
        !start.deletedAcross &&
        !end.deletedAcross &&
        start.pos === block.nativeFrom &&
        end.pos === block.nativeEnd &&
        value.node.eq(block.node)
      );
    });
    return original
      ? previous.body.slice(original.from, original.end)
      : canonical.slice(block.from, block.end).replace(/\r\n|\n|\r/g, newline);
  });
  const boundaries = new Map<number, string[]>();
  const boundaryPositions = new Set([
    ...represented.map((block) => block.nativeFrom),
    represented.at(-1)!.nativeEnd,
  ]);
  const gap = (from: number, end: number, position: number, side: -1 | 1) => {
    const raw = previous.body.slice(from, end).replace(/^\uFEFF/, "");
    if (!raw) return;
    const target = mapping.map(position, side);
    if (!boundaryPositions.has(target)) {
      if (raw.trim())
        throw new Error("这次编辑跨过了 Markdown 引用定义，请使用源码编辑。");
      return;
    }
    const values = boundaries.get(target) ?? [];
    values.push(raw);
    boundaries.set(target, values);
  };
  const removedAllContent =
    old.length > 0 &&
    old.every(
      (value) =>
        mapping.mapResult(value.nativeFrom + 1, 1).deletedAcross &&
        mapping.mapResult(value.nativeEnd - 1, -1).deletedAcross,
    );
  if (!removedAllContent) {
    let sourceFrom = 0;
    old.forEach((block, index) => {
      gap(sourceFrom, block.from, block.nativeFrom, index === 0 ? -1 : 1);
      sourceFrom = block.end;
    });
    gap(sourceFrom, previous.body.length, old.at(-1)?.nativeEnd ?? 0, 1);
  }
  const pieces = [
    bom,
    boundaries.get(represented[0].nativeFrom)?.join("") ?? "",
  ];
  represented.forEach((block, index) => {
    if (index)
      pieces.push(
        boundaries.get(block.nativeFrom)?.join("") ?? `${newline}${newline}`,
      );
    pieces.push(chunks[index]);
  });
  pieces.push(
    boundaries.get(represented.at(-1)!.nativeEnd)?.join("") ??
      (previous.body.endsWith("\n") || previous.body.endsWith("\r")
        ? newline
        : ""),
  );
  return { ...sourceSnapshot(pieces.join(""), doc), origin: previous.origin };
}
