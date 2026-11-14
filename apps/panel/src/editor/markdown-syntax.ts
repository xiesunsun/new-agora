import type { Nodes, Root } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

export function parseMarkdown(body: string): Root {
  const bom = body.startsWith("\uFEFF") ? 1 : 0;
  const tree = fromMarkdown(body.slice(bom), {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  if (bom) {
    const visit = (node: Nodes) => {
      if (node.position?.start.offset !== undefined)
        node.position.start.offset += bom;
      if (node.position?.end.offset !== undefined)
        node.position.end.offset += bom;
      if ("children" in node) for (const child of node.children) visit(child);
    };
    visit(tree);
  }
  return tree;
}

export interface ManuscriptBlock {
  raw: string;
  from: number;
  end: number;
  prefix: string;
  text: string;
  tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "p";
  subtitle: boolean;
  structural?: boolean;
}

export function manuscriptBlocks(text: string): ManuscriptBlock[] {
  const nodes = parseMarkdown(text).children;
  if (!nodes.length)
    return [
      {
        raw: text,
        from: 0,
        end: text.length,
        prefix: "",
        text,
        tag: "p",
        subtitle: false,
      },
    ];
  return nodes.map((node, index) => {
    const from = index === 0 ? 0 : (node.position?.start.offset ?? 0);
    const end = node.position?.end.offset ?? from;
    const raw = text.slice(from, end);
    const prefixEnd =
      node.type === "heading"
        ? (node.children[0]?.position?.start.offset ?? end)
        : (node.position?.start.offset ?? from);
    const prefix = text.slice(from, prefixEnd);
    const tag =
      node.type === "heading"
        ? node.depth === 1
          ? "h1"
          : node.depth === 2
            ? "h2"
            : node.depth === 3
              ? "h3"
              : node.depth === 4
                ? "h4"
                : node.depth === 5
                  ? "h5"
                  : "h6"
        : "p";
    const block: ManuscriptBlock = {
      raw,
      from,
      end,
      prefix,
      text: raw.slice(prefix.length),
      tag,
      subtitle: index === 1 && text.startsWith("# ") && !prefix,
      structural: node.type !== "paragraph" && node.type !== "heading",
    };
    return block;
  });
}
