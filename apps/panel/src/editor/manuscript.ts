import { Crepe } from "@milkdown/crepe";
import { editorViewCtx, parserCtx, serializerCtx } from "@milkdown/kit/core";
import type { Ctx } from "@milkdown/kit/ctx";
import { $prose } from "@milkdown/kit/utils";
import {
  EditorState,
  Plugin,
  PluginKey,
  TextSelection,
} from "@milkdown/kit/prose/state";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { Mapping } from "@milkdown/kit/prose/transform";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import type { EditorView } from "@milkdown/kit/prose/view";
import { linkTooltipAPI } from "@milkdown/kit/component/link-tooltip";
import { undoCommand } from "@milkdown/kit/plugin/history";
import { callCommand } from "@milkdown/kit/utils";
import type { Nodes, Root } from "mdast";
import type { Anchor } from "./controller.js";
import { parseMarkdown, renderMarkdown } from "./markdown.js";
import type { MarkdownBlock } from "./markdown.js";
import { projectSource, sourceSnapshot } from "./manuscript-source.js";
import type { SourceSnapshot } from "./manuscript-source.js";

type Edge = "start" | "end";
type Point = [Node, number];
export type ManuscriptMapping = Pick<
  ReturnType<typeof renderMarkdown>,
  "root" | "blocks" | "sourcePoint" | "pointAt" | "rangeFor"
>;
export type ManuscriptNote = {
  key: string;
  anchor: Pick<Anchor, "end">;
  dom: HTMLElement;
};
export type ManuscriptPresentation =
  | { kind: "working"; editable: boolean; note: ManuscriptNote | null }
  | { kind: "parked" };
type NoteState = {
  note: ManuscriptNote | null;
  pos: number;
  feedback: { key: string; pos: number; dom: HTMLElement } | null;
};
type Span = { pos: number; value: string; from: number; end: number };
type IndexedBlock = Omit<MarkdownBlock, "node" | "wrapper"> & {
  pos: number;
  after: number;
};
type SourceIndex = {
  spans: Span[];
  sourceOrder: Span[];
  blocks: IndexedBlock[];
};
type SyntaxNode = { type: string; value?: string; children?: SyntaxNode[] };
type Options = {
  source: string;
  publish(body: string): void;
  ready(): void;
  settle(): void;
  report(message: string | null): void;
};
export interface Manuscript {
  readonly ready: Promise<void>;
  readonly mapping: ManuscriptMapping;
  readonly nativeRoot: HTMLElement | null;
  readonly source: string;
  readonly recoverySource: string | null;
  readonly interacting: boolean;
  sync(body: string, presentation: ManuscriptPresentation): void;
  settled<T>(run: () => T | Promise<T>): Promise<T>;
  selection(allowCollapsed?: boolean): Anchor | null;
  restore(anchor: Anchor | null, caret?: boolean): void;
  feedback(anchor: Pick<Anchor, "end">, dom: HTMLElement): void;
  undo(): void;
  destroy(): void;
}
let sessionNumber = 0;
const nodeTags: Record<string, string> = {
  paragraph: "p",
  heading: "heading",
  bullet_list: "ul",
  ordered_list: "ol",
  list_item: "li",
  task_list_item: "li",
  blockquote: "blockquote",
  code_block: "pre",
  table: "table",
  table_row: "tr",
  table_header_row: "tr",
  table_cell: "td",
  table_header: "th",
  hr: "hr",
};

export function unsupportedSource(body: string): string | null {
  let reason: string | null = null;
  const visit = (node: Nodes) => {
    if (node.type === "footnoteDefinition" || node.type === "footnoteReference")
      reason = "脚注";
    if (node.type === "html" && node.value.trim() !== "<br />") reason = "HTML";
    if (node.type === "image" || node.type === "imageReference")
      reason = "图片";
    if (node.type === "link" || node.type === "definition") {
      try {
        if (
          !["http:", "https:", "mailto:"].includes(
            new URL(node.url, "https://agora.invalid").protocol,
          )
        )
          reason = "特殊链接";
      } catch {
        reason = "特殊链接";
      }
    }
    if ("children" in node) for (const child of node.children) visit(child);
  };
  visit(parseMarkdown(body));
  return reason;
}

function normalizeEmptyParagraphs(tree: Root): Root {
  const placeholder = (node: SyntaxNode) =>
    node.type === "html" && node.value?.trim() === "<br />";
  function visit(node: SyntaxNode, parent?: SyntaxNode) {
    if (
      placeholder(node) &&
      ["root", "blockquote", "listItem"].includes(parent?.type ?? "")
    ) {
      node.type = "paragraph";
      delete node.value;
      node.children = [];
    } else if (
      ["paragraph", "tableCell"].includes(node.type) &&
      node.children?.length === 1 &&
      placeholder(node.children[0])
    )
      node.children = [];
    for (const child of node.children ?? []) visit(child, node);
  }
  visit(tree);
  return tree;
}

function buildIndex(doc: ProseNode, source: string): SourceIndex {
  const reference = renderMarkdown(
    source,
    normalizeEmptyParagraphs(parseMarkdown(source)),
  );
  const paths = new Map<Element, string>();
  const children = (node: Element): Element[] =>
    [...node.children].flatMap((child) =>
      child.matches("input[type=checkbox]")
        ? []
        : child.matches("section.block,div.markdown-table,thead,tbody")
          ? children(child)
          : [child],
    );
  function path(node: Element, value: string) {
    paths.set(node, value);
    children(node).forEach((child, i) =>
      path(
        child,
        `${value}/${i}:${/^H[1-6]$/.test(child.tagName) ? "heading" : child.tagName.toLowerCase()}`,
      ),
    );
  }
  path(reference.root, "");
  const references = new Map<
    string,
    { block: MarkdownBlock; chars: Omit<Span, "pos">[] }
  >();
  for (const block of reference.blocks) {
    const chars: Omit<Span, "pos">[] = [];
    const walker = document.createTreeWalker(block.node, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!(node instanceof Text)) continue;
      for (let i = 0; i < node.length; i++) {
        const from = reference.sourcePoint(node, i, "start"),
          end = reference.sourcePoint(node, i + 1, "end");
        if (from !== null && end !== null)
          chars.push({ value: node.data[i], from, end });
      }
    }
    const key = paths.get(block.node);
    if (key !== undefined) references.set(key, { block, chars });
  }
  const spans: Span[] = [],
    blocks: IndexedBlock[] = [];
  function visit(
    parent: ProseNode,
    parentPos: number,
    route: string,
    topAfter?: number,
  ) {
    parent.forEach((node, offset, i) => {
      if (node.isInline) return;
      const pos = parentPos + offset,
        key = `${route}/${i}:${nodeTags[node.type.name] ?? node.type.name}`,
        after = topAfter ?? pos + node.nodeSize;
      if (!node.isTextblock) {
        visit(node, pos + 1, key, after);
        return;
      }
      const expected = references.get(key);
      if (!expected) return;
      const actual: { pos: number; value: string }[] = [];
      node.descendants((leaf, relative) => {
        if (leaf.isText)
          for (let j = 0; j < leaf.text!.length; j++)
            actual.push({ pos: pos + 1 + relative + j, value: leaf.text![j] });
        else if (leaf.isLeaf)
          actual.push({
            pos: pos + 1 + relative,
            value: leaf.type.name === "hardbreak" ? "\n" : "\uFFFC",
          });
      });
      let front = 0;
      while (
        front < actual.length &&
        front < expected.chars.length &&
        actual[front].value === expected.chars[front].value
      ) {
        spans.push({ pos: actual[front].pos, ...expected.chars[front] });
        front++;
      }
      let a = actual.length - 1,
        b = expected.chars.length - 1;
      while (
        a >= front &&
        b >= front &&
        actual[a].value === expected.chars[b].value
      ) {
        spans.push({ pos: actual[a].pos, ...expected.chars[b] });
        a--;
        b--;
      }
      blocks.push({
        from: expected.block.from,
        end: expected.block.end,
        raw: expected.block.raw,
        text: node.textContent,
        tag: expected.block.tag,
        prefix: "",
        subtitle: false,
        pos,
        after,
      });
    });
  }
  visit(doc, 0, "");
  spans.sort((a, b) => a.pos - b.pos);
  return {
    spans,
    sourceOrder: [...spans].sort((a, b) => a.from - b.from || a.pos - b.pos),
    blocks,
  };
}

function existingLink(state: EditorState) {
  const { from, to, $from } = state.selection,
    type = state.schema.marks.link;
  let mark = $from.marks().find((value) => value.type === type);
  if (!mark)
    state.doc.nodesBetween(from, to, (node) => {
      mark ??= node.marks.find((value) => value.type === type);
    });
  if (!mark) return null;
  const segments: { start: number; end: number; linked: boolean }[] = [];
  $from.parent.forEach((node, offset) =>
    segments.push({
      start: $from.start() + offset,
      end: $from.start() + offset + node.nodeSize,
      linked: Boolean(mark!.isInSet(node.marks)),
    }),
  );
  const seed = segments.findIndex(
    (value) => value.linked && value.start <= from && value.end >= from,
  );
  if (seed < 0) return null;
  let first = seed,
    last = seed;
  while (first > 0 && segments[first - 1].linked) first--;
  while (last + 1 < segments.length && segments[last + 1].linked) last++;
  return to <= segments[last].end
    ? { mark, from: segments[first].start, to: segments[last].end }
    : null;
}

export function createManuscript(
  host: HTMLDivElement,
  options: Options,
): Manuscript {
  const session = `manuscript-${++sessionNumber}`,
    noteKey = new PluginKey<NoteState>(session);
  host.inert = true;
  host.dataset.editorSession = session;
  let disposed = false,
    active = false,
    replacing = false,
    publishPending = false;
  let body = options.source,
    published = body,
    latestBody = body,
    nativeRevision = 0,
    replacement = 0;
  let diagnostic: string | null = null;
  let recoverySource: string | null = null;
  let presentation: ManuscriptPresentation = {
    kind: "working",
    editable: true,
    note: null,
  };
  let runtime: {
    view: EditorView;
    ctx: Ctx;
    snapshot: SourceSnapshot;
    index: SourceIndex;
  } | null = null;
  let pendingMapping = new Mapping(),
    dragFrame = 0,
    feedbackTimer: ReturnType<typeof setTimeout> | undefined;
  const cleanup: (() => void)[] = [];
  const compositionWaiters = new Set<() => void>();
  const crepe = new Crepe({
    root: host,
    defaultValue: body,
    features: {
      [Crepe.Feature.TopBar]: false,
      [Crepe.Feature.Toolbar]: true,
      [Crepe.Feature.AI]: false,
      [Crepe.Feature.Latex]: false,
      [Crepe.Feature.ImageBlock]: false,
      [Crepe.Feature.CodeMirror]: false,
    },
    featureConfigs: {
      [Crepe.Feature.Toolbar]: {
        boldLabel: "加粗",
        italicLabel: "斜体",
        codeLabel: "行内代码",
        linkLabel: "链接",
        strikethroughLabel: "删除线",
        buildToolbar(builder) {
          const item = builder
            .getGroup("function")
            .group.items.find((value) => value.key === "link");
          if (!item) throw new Error("缺少链接操作");
          item.onRun = (context) => {
            const view = context.get(editorViewCtx),
              api = context.get(linkTooltipAPI.key),
              link = existingLink(view.state);
            if (link) api.editLink(link.mark, link.from, link.to);
            else
              api.addLink(view.state.selection.from, view.state.selection.to);
          };
        },
      },
      [Crepe.Feature.LinkTooltip]: { inputPlaceholder: "输入链接地址" },
      [Crepe.Feature.BlockEdit]: {
        textGroup: {
          label: "正文结构",
          text: { label: "正文" },
          h1: { label: "一级标题" },
          h2: { label: "二级标题" },
          h3: { label: "三级标题" },
          h4: { label: "四级标题" },
          h5: { label: "五级标题" },
          h6: { label: "六级标题" },
          quote: { label: "引用" },
          divider: { label: "分隔线" },
        },
        listGroup: {
          label: "列表",
          bulletList: { label: "无序列表" },
          orderedList: { label: "有序列表" },
          taskList: { label: "待办列表" },
        },
        advancedGroup: {
          label: "插入",
          image: null,
          codeBlock: { label: "代码块" },
          table: { label: "表格" },
        },
      },
    },
  });
  function report(message: string | null) {
    diagnostic = message;
    host.dataset.sourceState = message ? "recovery" : "ready";
    options.report(message);
  }
  function publish() {
    publishPending = false;
    if (!disposed && active && !diagnostic && body !== published) {
      published = body;
      options.publish(body);
    }
  }
  function queuePublish() {
    if (!publishPending) {
      publishPending = true;
      queueMicrotask(publish);
    }
  }
  function readonly() {
    crepe.setReadonly(
      presentation.kind !== "working" || !presentation.editable,
    );
    host.dataset.readonly = String(
      presentation.kind !== "working" || !presentation.editable,
    );
  }
  crepe.editor.use(
    $prose(
      (context) =>
        new Plugin<NoteState>({
          key: noteKey,
          filterTransaction: (tr) =>
            !active ||
            replacing ||
            !tr.docChanged ||
            (presentation.kind === "working" && presentation.editable),
          state: {
            init: () => ({ note: null, pos: 0, feedback: null }),
            apply(tr, state) {
              if (active && !replacing && tr.docChanged) {
                pendingMapping.appendMapping(tr.mapping);
                nativeRevision++;
              }
              const next: NoteState | undefined = tr.getMeta(noteKey);
              return (
                next ?? {
                  ...state,
                  pos: tr.mapping.map(state.pos, -1),
                  feedback: state.feedback
                    ? {
                        ...state.feedback,
                        pos: tr.mapping.map(state.feedback.pos, -1),
                      }
                    : null,
                }
              );
            },
          },
          props: {
            attributes: {
              class: "prose",
              role: "textbox",
              "aria-label": "工作稿正文",
              "aria-multiline": "true",
              "data-editor-session": session,
            },
            nodeViews: {
              image(node) {
                const dom = document.createElement("span");
                dom.className = "markdown-image";
                dom.setAttribute("role", "img");
                dom.setAttribute("aria-label", node.attrs.alt || "图片");
                dom.textContent = `![${node.attrs.alt || ""}](${node.attrs.src || ""})`;
                dom.contentEditable = "false";
                return { dom };
              },
            },
            decorations(state) {
              const current = noteKey.getState(state);
              if (!current) return null;
              const widgets: Decoration[] = [];
              const add = (pos: number, dom: HTMLElement, key: string) => {
                dom.contentEditable = "false";
                widgets.push(
                  Decoration.widget(
                    Math.min(pos, state.doc.content.size),
                    () => dom,
                    {
                      key,
                      side: 1,
                      stopEvent: () => true,
                      ignoreSelection: true,
                    },
                  ),
                );
              };
              if (current.note)
                add(current.pos, current.note.dom, current.note.key);
              if (current.feedback)
                add(
                  current.feedback.pos,
                  current.feedback.dom,
                  current.feedback.key,
                );
              return DecorationSet.create(state.doc, widgets);
            },
          },
          view: () => ({
            update(native, previous) {
              if (
                !active ||
                replacing ||
                !runtime ||
                native.state.doc.eq(previous.doc)
              )
                return;
              try {
                const canonical = context.get(serializerCtx)(native.state.doc);
                recoverySource = canonical;
                const snapshot = projectSource(
                  runtime.snapshot,
                  native.state.doc,
                  canonical,
                  pendingMapping,
                );
                const index = buildIndex(native.state.doc, snapshot.body);
                runtime.snapshot = snapshot;
                runtime.index = index;
                body = snapshot.body;
                pendingMapping = new Mapping();
                recoverySource = null;
                report(null);
                queuePublish();
              } catch (error) {
                report(
                  error instanceof Error
                    ? error.message
                    : "当前编辑暂时无法保存，可撤销最近编辑后继续。",
                );
              }
            },
          }),
        }),
    ),
  );
  function sourceAt(pos: number, edge: Edge) {
    const spans = runtime?.index.spans ?? [];
    const exact = spans.find((span) => span.pos === pos),
      before = spans.find((span) => span.pos + 1 === pos);
    return edge === "start"
      ? (exact?.from ?? before?.end ?? null)
      : (before?.end ?? exact?.from ?? null);
  }
  function modelAt(offset: number, edge: Edge) {
    const spans = runtime?.index.sourceOrder ?? [];
    const exact = spans.find((span) => span.from === offset);
    const before = [...spans]
      .reverse()
      .find((span) => span.from < offset && span.end >= offset);
    if (edge === "start") {
      if (before && offset < before.end) return before.pos;
      if (exact) return exact.pos;
      return before ? before.pos + 1 : null;
    }
    return before ? before.pos + 1 : (exact?.pos ?? null);
  }
  function pointAt(offset: number, edge: Edge): Point | null {
    if (diagnostic) return null;
    const pos = modelAt(offset, edge);
    if (pos === null || !runtime) return null;
    const point = runtime.view.domAtPos(pos, edge === "start" ? 1 : -1);
    return [point.node, point.offset];
  }
  function notePosition(anchor: Pick<Anchor, "end">) {
    if (!runtime) return 0;
    if (diagnostic)
      return (
        runtime.view.state.doc.firstChild?.nodeSize ??
        runtime.view.state.doc.content.size
      );
    const block = runtime.index.blocks.find(
      (value) => anchor.end >= value.from && anchor.end <= value.end,
    );
    if (block) return block.after;
    const pos = modelAt(anchor.end, "end");
    if (pos === null)
      return (
        runtime.view.state.doc.firstChild?.nodeSize ??
        runtime.view.state.doc.content.size
      );
    const resolved = runtime.view.state.doc.resolve(pos);
    return resolved.depth
      ? resolved.after(1)
      : runtime.view.state.doc.content.size;
  }
  function present() {
    if (!runtime || disposed) return;
    readonly();
    const { view } = runtime,
      current = noteKey.getState(view.state)!;
    const note = presentation.kind === "working" ? presentation.note : null,
      pos = note ? notePosition(note.anchor) : 0;
    if (
      current.note?.key === note?.key &&
      current.note?.dom === note?.dom &&
      current.pos === pos
    )
      return;
    view.dispatch(
      view.state.tr
        .setMeta(noteKey, { ...current, note, pos })
        .setMeta("addToHistory", false),
    );
  }
  async function waitComposition() {
    if (runtime?.view.composing)
      await new Promise<void>((resolve) => compositionWaiters.add(resolve));
    await Promise.resolve();
  }
  async function replaceSource(
    next: string,
    checkpoint: number,
    identity: number,
  ) {
    await ready;
    await waitComposition();
    if (!runtime || disposed || identity !== replacement || next === body)
      return;
    if (diagnostic) {
      report("存在尚未保存的编辑，请先撤销最近编辑后再切换文稿。");
      return;
    }
    if (nativeRevision !== checkpoint) return;
    const doc = runtime.ctx.get(parserCtx)(next);
    if (!doc) {
      report("无法打开这份 Markdown，请使用源码编辑。");
      return;
    }
    const snapshot = sourceSnapshot(next, doc),
      index = buildIndex(doc, next);
    replacing = true;
    try {
      runtime.view.updateState(
        EditorState.create({
          schema: runtime.view.state.schema,
          doc,
          plugins: runtime.view.state.plugins,
        }),
      );
      runtime.snapshot = snapshot;
      runtime.index = index;
      body = next;
      published = next;
      pendingMapping = new Mapping();
      report(null);
      present();
      options.settle();
    } finally {
      replacing = false;
    }
  }
  const ready = (async () => {
    await crepe.create();
    if (disposed) {
      await crepe.destroy();
      return;
    }
    const ctx = crepe.editor.ctx,
      view = ctx.get(editorViewCtx);
    runtime = {
      view,
      ctx,
      snapshot: sourceSnapshot(body, view.state.doc),
      index: buildIndex(view.state.doc, body),
    };
    active = true;
    host.inert = false;
    host.dataset.editorState = "ready";
    readonly();
    present();
    const onCompositionEnd = () =>
      queueMicrotask(() => {
        for (const done of compositionWaiters) done();
        compositionWaiters.clear();
        publish();
      });
    host.addEventListener("compositionend", onCompositionEnd);
    cleanup.push(() =>
      host.removeEventListener("compositionend", onCompositionEnd),
    );
    const startDrag = (event: PointerEvent) => {
      if (
        event.button !== 0 ||
        !(event.target instanceof Element) ||
        !view.dom.contains(event.target) ||
        event.target.closest(".note-entry,.note-peek,.note-collapse")
      )
        return;
      cancelAnimationFrame(dragFrame);
      host.dataset.dragging = "true";
    };
    const settleDrag = () => {
      cancelAnimationFrame(dragFrame);
      dragFrame = requestAnimationFrame(() => {
        delete host.dataset.dragging;
        if (!disposed) options.settle();
      });
    };
    host.addEventListener("pointerdown", startDrag, true);
    document.addEventListener("pointerup", settleDrag);
    document.addEventListener("pointercancel", settleDrag);
    window.addEventListener("blur", settleDrag);
    cleanup.push(() => {
      host.removeEventListener("pointerdown", startDrag, true);
      document.removeEventListener("pointerup", settleDrag);
      document.removeEventListener("pointercancel", settleDrag);
      window.removeEventListener("blur", settleDrag);
    });
    const labelLinks = () => {
      for (const [selector, label] of [
        [".link-edit-button", "编辑链接地址"],
        [".link-remove-button", "删除链接"],
        [".link-icon", "复制链接"],
        [".link-edit .confirm", "确认链接地址"],
      ])
        for (const node of host.querySelectorAll(selector)) {
          node.setAttribute("role", "button");
          node.setAttribute("aria-label", label);
          node.setAttribute("tabindex", "0");
        }
      for (const input of host.querySelectorAll(".milkdown-link-edit input"))
        input.setAttribute("aria-label", "链接地址");
    };
    const observer = new MutationObserver(() => {
      labelLinks();
      options.settle();
    });
    observer.observe(host, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-show"],
    });
    labelLinks();
    const activateLink = (event: KeyboardEvent) => {
      if (
        ["Enter", " "].includes(event.key) &&
        event.target instanceof HTMLElement &&
        event.target.matches(
          '.milkdown-link-preview [role="button"],.milkdown-link-edit [role="button"]',
        )
      ) {
        event.preventDefault();
        event.stopPropagation();
        event.target.click();
      }
    };
    host.addEventListener("keydown", activateLink);
    cleanup.push(() => {
      observer.disconnect();
      host.removeEventListener("keydown", activateLink);
    });
    report(null);
    options.ready();
    if (latestBody !== body)
      void replaceSource(latestBody, nativeRevision, ++replacement);
  })();
  void ready.catch((error) => {
    if (!disposed) {
      host.dataset.editorState = "failed";
      report(
        error instanceof Error
          ? error.message
          : "编辑器未能打开，请使用源码编辑。",
      );
    }
  });
  const mapping: ManuscriptMapping = {
    root: host,
    get blocks() {
      return (diagnostic ? [] : (runtime?.index.blocks ?? [])).flatMap(
        (block) => {
          const node = runtime?.view.nodeDOM(block.pos);
          return node instanceof HTMLElement
            ? [{ ...block, node, wrapper: host }]
            : [];
        },
      );
    },
    sourcePoint(node, offset, edge) {
      if (
        !runtime ||
        diagnostic ||
        !runtime.view.dom.contains(node) ||
        node.parentElement?.closest(".note-entry,.note-peek,.note-collapse")
      )
        return null;
      try {
        return sourceAt(
          runtime.view.posAtDOM(node, offset, edge === "start" ? 1 : -1),
          edge,
        );
      } catch {
        return null;
      }
    },
    pointAt,
    rangeFor(start, end) {
      const from = pointAt(start, "start"),
        to = pointAt(end, "end");
      if (!from || !to) return null;
      const range = document.createRange();
      range.setStart(...from);
      range.setEnd(...to);
      return range;
    },
  };
  return {
    ready,
    mapping,
    get nativeRoot() {
      return runtime?.view.dom ?? null;
    },
    get source() {
      return body;
    },
    get recoverySource() {
      return recoverySource;
    },
    get interacting() {
      return (
        host.dataset.dragging === "true" ||
        Boolean(
          host.querySelector(
            '.milkdown-link-edit[data-show="true"],.milkdown-link-preview[data-show="true"]',
          ),
        )
      );
    },
    sync(next, value) {
      if (disposed) return;
      presentation = value;
      present();
      latestBody = next;
      if (next !== body)
        void replaceSource(next, nativeRevision, ++replacement);
    },
    async settled(run) {
      await ready;
      await waitComposition();
      if (disposed) throw new Error("编辑器已关闭");
      publish();
      if (diagnostic) throw new Error(diagnostic);
      return run();
    },
    selection(allowCollapsed = false) {
      if (!runtime || diagnostic) return null;
      const selection = runtime.view.state.selection;
      if (
        !(selection instanceof TextSelection) ||
        (!allowCollapsed && selection.empty)
      )
        return null;
      let start = sourceAt(selection.from, "start"),
        end = sourceAt(selection.to, "end");
      if (start === null || end === null) return null;
      const textPositions = new Set(
        runtime.index.spans.map((span) => span.pos),
      );
      let unmapped = false;
      runtime.view.state.doc.nodesBetween(
        selection.from,
        selection.to,
        (node, pos) => {
          if (node.isText)
            for (
              let i = Math.max(0, selection.from - pos);
              i < Math.min(node.nodeSize, selection.to - pos);
              i++
            )
              if (!textPositions.has(pos + i)) unmapped = true;
        },
      );
      if (unmapped) return null;
      const quote = body.slice(start, end);
      if (!selection.empty) {
        start += quote.length - quote.trimStart().length;
        end -= quote.length - quote.trimEnd().length;
        if (end <= start) return null;
      }
      const backward = selection.anchor > selection.head;
      return {
        start,
        end,
        quote: body.slice(start, end),
        focusOffset: backward ? start : end,
        direction: backward ? "backward" : "forward",
      };
    },
    restore(anchor, caret = false) {
      if (!runtime || disposed) return;
      if (!anchor) {
        runtime.view.focus();
        return;
      }
      const from = modelAt(caret ? anchor.focusOffset : anchor.start, "start"),
        to = caret ? from : modelAt(anchor.end, "end");
      if (from === null || to === null) return;
      runtime.view.dispatch(
        runtime.view.state.tr
          .setSelection(
            TextSelection.create(
              runtime.view.state.doc,
              anchor.direction === "backward" && !caret ? to : from,
              anchor.direction === "backward" && !caret ? from : to,
            ),
          )
          .setMeta("addToHistory", false),
      );
      runtime.view.focus();
    },
    feedback(anchor, dom) {
      if (!runtime || disposed) return;
      const { view } = runtime,
        current = noteKey.getState(view.state)!;
      clearTimeout(feedbackTimer);
      const key = `feedback-${nativeRevision}`;
      view.dispatch(
        view.state.tr
          .setMeta(noteKey, {
            ...current,
            feedback: { key, pos: notePosition(anchor), dom },
          })
          .setMeta("addToHistory", false),
      );
      feedbackTimer = setTimeout(() => {
        if (!runtime || disposed) return;
        const value = noteKey.getState(view.state)!;
        if (value.feedback?.key === key)
          view.dispatch(
            view.state.tr
              .setMeta(noteKey, { ...value, feedback: null })
              .setMeta("addToHistory", false),
          );
      }, 550);
    },
    undo() {
      if (runtime && !disposed)
        crepe.editor.action(callCommand(undoCommand.key));
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      active = false;
      replacement++;
      cancelAnimationFrame(dragFrame);
      clearTimeout(feedbackTimer);
      for (const done of cleanup) done();
      for (const done of compositionWaiters) done();
      compositionWaiters.clear();
      if (runtime) void crepe.destroy();
    },
  };
}
