import type {
  Comment,
  CommentDraft,
  View,
} from "../../../../packages/contracts/src/index.js";
import type {
  Anchor,
  ConfirmationTicket,
  DestructiveAction,
  PanelController,
} from "./controller.js";
import { parts, reviewDocument } from "./review-document.js";
import type {
  Comparison,
  Decision,
  LaneBlock,
  ManuscriptBlock,
  ReviewBlock,
} from "./review-document.js";
import { orbitLayout } from "./orbit-layout.js";
import { createHistoryRuler } from "./history-ruler.js";
import { choosePenPosition } from "./pen-placement.js";
import type { Bounds } from "./pen-placement.js";
import { markup } from "./markup.js";
import { editExactText, editorOffset, textareaText } from "./exact-text.js";

type Block = ManuscriptBlock & { node?: HTMLElement; wrapper?: HTMLElement };
type FieldSelection = [number, number, "forward" | "backward" | "none"];
type Bookmark = {
  x: number;
  y: number;
  focus: HTMLElement | null;
  block: number;
  endBlock: number;
  fieldSelection: FieldSelection | null;
  start: number;
  end: number;
  note: string | null;
  selected: Anchor | null;
  review: string | null;
};
function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function action(
  label: string,
  glyph: string,
  run: () => void,
  className = "icon-button",
) {
  const node = element("button", glyph, className);
  node.type = "button";
  node.setAttribute("aria-label", label);
  node.addEventListener("click", run);
  return node;
}
function icon(name: "pen" | "tab") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", name === "tab" ? "0 0 18 21" : "0 0 20 20");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add(name === "pen" ? "pen-icon" : "note-tab-svg");
  const path = document.createElementNS(svg.namespaceURI, "path");
  path.setAttribute(
    "d",
    name === "pen"
      ? "M4 16l1.5-5L13 3.5 17 7l-7.5 7.5L4 16Z M11.5 5l4 4M5.5 11l4 3.5"
      : "M3 2h8l4 4v13H3Z M11 2v4h4M6 10h6M6 13h4",
  );
  svg.append(path);
  return svg;
}
export function supportsProse(text: string) {
  return (
    !/[\r\uFEFF\t]/.test(text) &&
    !/(^|\n)(?:\s*[-*+] |\s*\d+[.)] |\s*```|\s*~~~|\s*\| |\s{4}|#{3,6} |\s*<|\[.+\]:)/.test(
      text,
    ) &&
    !/[`*_[\]\\<>]|!\[/.test(text)
  );
}
export function mountEditor(root: HTMLElement, controller: PanelController) {
  root.innerHTML = markup;
  function id<T extends HTMLElement>(
    name: string,
    constructor: { new (): T },
  ): T {
    const node = root.querySelector(`#${name}`);
    if (!(node instanceof constructor)) throw new Error(`缺少面板元素 ${name}`);
    return node;
  }
  const paper = id("paper", HTMLElement),
    manuscript = id("manuscript", HTMLElement),
    margin = id("margin", HTMLElement);
  const dock = id("dock", HTMLElement),
    brand = id("brand", HTMLButtonElement),
    nav = id("document-actions", HTMLElement);
  const generateButton = id("generate-round", HTMLButtonElement),
    saveButton = id("save-document", HTMLButtonElement),
    historyButton = id("history-toggle", HTMLButtonElement);
  id("history-close", HTMLButtonElement).setAttribute(
    "aria-label",
    "返回工作稿",
  );
  const history = id("history", HTMLElement),
    viewport = id("film-reel", HTMLElement),
    strip = id("filmstrip", HTMLElement);
  const dialog = id("confirmation", HTMLDialogElement),
    cancelButton = id("confirmation-cancel", HTMLButtonElement),
    confirmButton = id("confirmation-confirm", HTMLButtonElement);
  const selectionHost = id("selection-action", HTMLElement),
    notice = id("notice", HTMLElement);
  const rangeFocus = root.querySelector("#range-focus");
  const abort = new AbortController();
  let state = controller.read();
  let blocks: Block[] = [],
    activeReview: string | null = null,
    noteId: string | null = null,
    focusedNoteId: string | null = null,
    noteGroup: string[] = [],
    selected: Anchor | null = null;
  let renderKey = "",
    composing = false,
    reveal: "closed" | "peek" | "pinned" = "closed",
    bookmark: Bookmark | null = null;
  let reviewAnimations: Animation[] = [];
  function cancelReviewMotion() {
    for (const animation of reviewAnimations) animation.cancel();
    reviewAnimations = [];
  }
  let geometryFrame = 0,
    chromeFrame = 0,
    completionTimer = 0,
    dockTimer = 0,
    compositionTimer = 0;
  let modalFocus: HTMLElement | null = null,
    modalSelection: FieldSelection | null = null,
    ticket: ConfirmationTicket | null = null;
  const timers = new Set<number>();
  const later = (run: () => void, delay: number) => {
    const value = window.setTimeout(() => {
      timers.delete(value);
      run();
    }, delay);
    timers.add(value);
    return value;
  };
  const run = (promise: Promise<unknown>) => {
    void promise.catch(() => undefined);
  };
  const getView = (): View => {
    if (!state.snapshot) throw new Error("文稿尚未载入");
    return state.snapshot;
  };
  const historical = () => state.viewedVersion !== null;
  const review = () =>
    !historical() && state.snapshot?.round?.phase === "review"
      ? state.snapshot.round
      : null;
  const locked = () =>
    historical() ||
    Boolean(
      state.snapshot?.round &&
      !["empty", "interrupted"].includes(state.snapshot.round.phase),
    ) ||
    state.snapshot?.applyStatus?.phase === "checking";
  const editable = () => !locked() && !state.input?.commentDraft;
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const ruler = createHistoryRuler({
    viewport,
    strip,
    onSelect(version) {
      controller.browseVersion(Number(version));
    },
    onSettle(version) {
      id("history-live", HTMLElement).textContent =
        `正在查看 V${version} · 只读`;
    },
  });
  function currentNote(): Comment | CommentDraft | null {
    return !historical()
      ? (state.input?.commentDraft ??
          state.input?.comments.find((value) => value.id === noteId) ??
          null)
      : null;
  }
  function textOffset(
    node: HTMLElement,
    container: Node,
    offset: number,
  ): number {
    if (!node.childElementCount) {
      const range = document.createRange();
      range.selectNodeContents(node);
      range.setEnd(container, offset);
      return range.toString().length;
    }
    const path: number[] = [];
    for (
      let child: Node | null = container;
      child && child !== node;
      child = child.parentNode
    ) {
      const parent = child.parentNode;
      if (!parent) return 0;
      path.unshift(Array.from<Node>(parent.childNodes).indexOf(child));
    }
    const copy = node.cloneNode(true);
    if (!(copy instanceof HTMLElement)) return 0;
    copy.contentEditable = "false";
    copy.setAttribute("aria-hidden", "true");
    copy.style.cssText = `position:fixed;left:-100000px;top:0;opacity:0;pointer-events:none;width:${node.getBoundingClientRect().width}px`;
    let target: Node = copy;
    for (const index of path) target = target.childNodes[index];
    const marker = `\uE000${crypto.randomUUID()}\uE001`,
      point = document.createRange();
    point.setStart(target, offset);
    point.collapse(true);
    point.insertNode(document.createTextNode(marker));
    root.append(copy);
    const index = copy.innerText.indexOf(marker);
    copy.remove();
    return Math.max(0, index);
  }
  function pointInText(node: HTMLElement, offset: number): [Node, number] {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    let remaining = Math.max(0, offset),
      last: Text | null = null;
    while (walker.nextNode()) {
      const text = walker.currentNode;
      if (!(text instanceof Text)) continue;
      last = text;
      if (node.childElementCount) {
        const start = textOffset(node, text, 0);
        if (offset <= start + text.length)
          return [text, Math.max(0, offset - start)];
      } else {
        if (remaining <= text.length) return [text, remaining];
        remaining -= text.length;
      }
    }
    return last ? [last, last.length] : [node, 0];
  }
  function rangeFragments(range: Range | null): DOMRect[] {
    if (!range) return [];
    const walker = document.createTreeWalker(manuscript, NodeFilter.SHOW_TEXT),
      rects: DOMRect[] = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (
        !(node instanceof Text) ||
        !node.parentElement?.closest(".prose") ||
        !range.intersectsNode(node)
      )
        continue;
      const fragment = document.createRange();
      fragment.setStart(
        node,
        node === range.startContainer ? range.startOffset : 0,
      );
      fragment.setEnd(
        node,
        node === range.endContainer ? range.endOffset : node.length,
      );
      rects.push(
        ...[...fragment.getClientRects()].filter(
          (rect) => rect.width > 0 && rect.height > 0,
        ),
      );
    }
    return rects;
  }
  function textRange(anchor: Anchor & { resolved?: boolean }): Range | null {
    if (anchor.resolved === false || historical() || review()) return null;
    const first = blocks.find(
      (block) =>
        anchor.start >= block.from + block.prefix.length &&
        anchor.start <= block.end,
    );
    const last = blocks.find(
      (block) =>
        anchor.end >= block.from + block.prefix.length &&
        anchor.end <= block.end,
    );
    if (!first?.node || !last?.node) return null;
    const range = document.createRange();
    range.setStart(
      ...pointInText(
        first.node,
        anchor.start - first.from - first.prefix.length,
      ),
    );
    range.setEnd(
      ...pointInText(last.node, anchor.end - last.from - last.prefix.length),
    );
    return range;
  }
  function captureSelection(): Anchor | null {
    if (locked() || state.input?.commentDraft) return null;
    const fallback =
      manuscript.querySelector<HTMLTextAreaElement>(".exact-editor");
    if (fallback && fallback.selectionStart !== fallback.selectionEnd) {
      const offsets = textareaText(state.input!.draft).sourceOffsets,
        start = offsets[fallback.selectionStart],
        end = offsets[fallback.selectionEnd];
      return {
        start,
        end,
        quote: state.input!.draft.slice(start, end),
        focusOffset: fallback.selectionDirection === "backward" ? start : end,
        direction:
          fallback.selectionDirection === "backward" ? "backward" : "forward",
      };
    }
    const selection = window.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0),
      first = blocks.find((block) =>
        block.node?.contains(range.startContainer),
      ),
      last = blocks.find((block) => block.node?.contains(range.endContainer));
    if (!first?.node || !last?.node || !state.input) return null;
    let start =
        first.from +
        first.prefix.length +
        textOffset(first.node, range.startContainer, range.startOffset),
      end =
        last.from +
        last.prefix.length +
        textOffset(last.node, range.endContainer, range.endOffset);
    const raw = state.input.draft.slice(start, end);
    start += raw.length - raw.trimStart().length;
    end -= raw.length - raw.trimEnd().length;
    if (end <= start) return null;
    const backward =
      selection.focusNode === range.startContainer &&
      selection.focusOffset === range.startOffset;
    return {
      start,
      end,
      quote: state.input.draft.slice(start, end),
      focusOffset: backward ? start : end,
      direction: backward ? "backward" : "forward",
    };
  }
  function selectionEndpoint(anchor: Anchor) {
    const offset =
      anchor.focusOffset >= anchor.start && anchor.focusOffset <= anchor.end
        ? anchor.focusOffset
        : anchor.end;
    const block = blocks.find(
      (value) => offset >= value.from && offset <= value.end,
    );
    if (!block?.node) return { offset, rect: null };
    const range = document.createRange();
    range.setStart(
      ...pointInText(
        block.node,
        Math.max(0, offset - block.from - block.prefix.length),
      ),
    );
    range.collapse(true);
    const fallback = textRange(anchor);
    const fragments = rangeFragments(fallback);
    return {
      offset,
      rect:
        [...range.getClientRects()].find((rect) => rect.height > 0) ??
        (anchor.direction === "backward" ? fragments[0] : fragments.at(-1)) ??
        null,
    };
  }
  function positionSelection() {
    const host = selectionHost;
    if (!selected || locked() || !host.firstChild) {
      host.hidden = true;
      return;
    }
    const endpoint = selectionEndpoint(selected);
    const block = blocks.find(
      (value) => endpoint.offset >= value.from && endpoint.offset <= value.end,
    );
    const bounds = block?.node?.getBoundingClientRect();
    const fragments = endpoint.rect ? [endpoint.rect] : [];
    if (
      !bounds ||
      !fragments.length ||
      endpoint.rect!.bottom < 8 ||
      endpoint.rect!.top > innerHeight - 8
    ) {
      host.hidden = true;
      return;
    }
    const proseRects: DOMRect[] = [];
    for (const prose of manuscript.querySelectorAll(".prose")) {
      const range = document.createRange();
      range.selectNodeContents(prose);
      proseRects.push(
        ...[...range.getClientRects()].filter(
          (rect) => rect.width && rect.height,
        ),
      );
    }
    const blocked = [
      ...root.querySelectorAll(
        ".note-node,.review-node,#dock button,#history,.note-entry,.note-peek,.mode-bar,.preview-tools",
      ),
    ]
      .filter((node) => node.getClientRects().length)
      .map((node) => node.getBoundingClientRect());
    let slot = manuscript.querySelector(".selection-slot");
    let position: Bounds | null = null;
    if (slot) {
      const rect = slot.getBoundingClientRect();
      position = choosePenPosition(
        [rect],
        proseRects,
        blocked,
        { left: rect.left + 50, right: rect.right - 50 },
        { width: innerWidth, height: innerHeight },
      );
      const target = {
        left: rect.left,
        top: rect.top,
        right: rect.left + 44,
        bottom: rect.top + 44,
      };
      const clear = [...proseRects, ...blocked].every(
        (other) =>
          target.left >= other.right + 3 ||
          target.right <= other.left - 3 ||
          target.top >= other.bottom + 3 ||
          target.bottom <= other.top - 3,
      );
      if (
        clear &&
        target.top >= 8 &&
        target.bottom <= innerHeight - 8 &&
        target.left >= 8 &&
        target.right <= innerWidth - 8
      )
        position = target;
    } else
      position = choosePenPosition(fragments, proseRects, blocked, bounds, {
        width: innerWidth,
        height: innerHeight,
      });
    if (!position) {
      if (!slot) {
        if (!block?.wrapper) {
          host.hidden = true;
          return;
        }
        slot = element("div", undefined, "selection-slot");
        slot.setAttribute("aria-hidden", "true");
        block.wrapper.append(slot);
        host.hidden = true;
        scheduleGeometry();
        return;
      }
      const rect = slot.getBoundingClientRect();
      const target = {
        left: rect.left,
        top: rect.top,
        right: rect.left + 44,
        bottom: rect.top + 44,
      };
      const clear = [...proseRects, ...blocked].every(
        (other) =>
          target.left >= other.right + 3 ||
          target.right <= other.left - 3 ||
          target.top >= other.bottom + 3 ||
          target.bottom <= other.top - 3,
      );
      if (
        !clear ||
        target.left < 8 ||
        target.right > innerWidth - 8 ||
        target.top < 8 ||
        target.bottom > innerHeight - 8
      ) {
        host.hidden = true;
        return;
      }
      position = target;
    }
    const origin = paper.getBoundingClientRect();
    host.style.left = `${position.left - origin.left}px`;
    host.style.top = `${position.top - origin.top}px`;
    host.hidden = false;
  }

  function refreshSelection() {
    if (
      dialog.open ||
      composing ||
      document.activeElement?.closest(".note-entry")
    )
      return;
    const selection = captureSelection();
    if (
      selection?.start !== selected?.start ||
      selection?.end !== selected?.end ||
      selection?.focusOffset !== selected?.focusOffset
    )
      manuscript.querySelector(".selection-slot")?.remove();
    if (!selection) {
      if (!selectionHost.contains(document.activeElement)) {
        selected = null;
        selectionHost.hidden = true;
      }
      return;
    }
    selected = selection;
    const pen = action(
      "为选中文字写批注",
      "",
      () => {
        if (selected) openSelection(selected);
      },
      "pen-trigger",
    );
    pen.replaceChildren(icon("pen"));
    pen.addEventListener("pointerdown", (event) => event.preventDefault());
    selectionHost.replaceChildren(pen);
    positionSelection();
  }
  function openSelection(anchor: Anchor) {
    if (locked()) return;
    noteId = null;
    selected = null;
    controller.beginComment(anchor);
    window.getSelection()?.removeAllRanges();
    const field = manuscript.querySelector<HTMLTextAreaElement>(
      ".note-entry textarea",
    );
    field?.focus({ preventScroll: true });
    field?.scrollIntoView({ block: "nearest", behavior: "instant" });
  }
  function highlight(note: (Anchor & { resolved?: boolean }) | null) {
    rangeFocus?.replaceChildren();
    if (!note) return;
    const range = textRange(note);
    if (!range) return;
    const origin = paper.getBoundingClientRect();
    for (const rect of rangeFragments(range)) {
      if (!rect.width) continue;
      const path = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "path",
      );
      path.setAttribute(
        "d",
        `M${rect.left - origin.left} ${rect.bottom - origin.top + 3}H${rect.right - origin.left}`,
      );
      rangeFocus?.append(path);
    }
  }
  function scheduleGeometry() {
    cancelAnimationFrame(geometryFrame);
    geometryFrame = requestAnimationFrame(refreshGeometry);
  }
  function refreshGeometry() {
    const focusedNote =
      margin.contains(document.activeElement) &&
      document.activeElement instanceof HTMLElement
        ? document.activeElement.dataset.notes?.split(",")[0]
        : null;
    margin.replaceChildren();
    if (historical() || review()) {
      highlight(null);
      return;
    }
    const origin = paper.getBoundingClientRect(),
      edge = manuscript.getBoundingClientRect().right - origin.left;
    const entries = (state.input?.comments ?? [])
      .map((note) => ({
        note,
        y: textRange(note)?.getClientRects()[0]?.top ?? origin.top + 96,
      }))
      .sort((a, b) => a.y - b.y);
    const groups: { y: number; notes: Comment[] }[] = [];
    for (const entry of entries) {
      const group = groups.at(-1);
      if (group && entry.y - group.y < 44) group.notes.push(entry.note);
      else groups.push({ y: entry.y, notes: [entry.note] });
    }
    for (const group of groups) {
      const note =
        group.notes.find((value) => value.id === (noteId ?? focusedNoteId)) ??
        group.notes[0];
      const button = action(
        group.notes.length > 1
          ? `查看这一行的 ${group.notes.length} 条批注`
          : `查看批注：${note.instruction}`,
        "",
        () => {
          noteId = note.id;
          noteGroup = group.notes.map((value) => value.id);
          focusedNoteId = note.id;
          renderKey = "";
          render();
        },
        `note-node${noteId === note.id ? " active" : ""}${note.resolved ? "" : " detached"}`,
      );
      button.replaceChildren(icon("tab"));
      if (group.notes.length > 1)
        button.append(
          element("span", String(group.notes.length), "note-count"),
        );
      button.dataset.notes = group.notes.map((value) => value.id).join(",");
      button.style.top = `${group.y - origin.top + 12}px`;
      button.style.left = `${Math.min(innerWidth - origin.left - 52, edge + (innerWidth <= 800 ? 4 : 20))}px`;
      button.disabled = locked();
      button.setAttribute("aria-expanded", String(note.id === noteId));
      button.addEventListener("pointerdown", (event) => event.preventDefault());
      button.addEventListener("pointerenter", () => highlight(note));
      button.addEventListener("pointerleave", () => highlight(currentNote()));
      button.addEventListener("focus", () => highlight(note));
      margin.append(button);
      if (focusedNote && group.notes.some((note) => note.id === focusedNote))
        button.focus({ preventScroll: true });
    }
    highlight(currentNote());
    positionSelection();
  }
  function restoreDraftEditor(anchor: Anchor) {
    const offset = anchor.focusOffset ?? anchor.end,
      block = blocks.find(
        (block) => offset >= block.from && offset <= block.end,
      );
    if (block?.node) {
      block.node.focus({ preventScroll: true });
      const range = document.createRange();
      range.setStart(
        ...pointInText(
          block.node,
          Math.max(0, offset - block.from - block.prefix.length),
        ),
      );
      range.collapse(true);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    } else {
      const field =
        manuscript.querySelector<HTMLTextAreaElement>(".exact-editor");
      field?.focus({ preventScroll: true });
      if (field && state.input) {
        const position = editorOffset(state.input.draft, offset);
        field.setSelectionRange(position, position);
      }
    }
  }
  function cancelComment() {
    const draft = state.input?.commentDraft;
    if (!draft) return;
    const original =
      state.input?.comments.find((value) => value.id === draft.editingCommentId)
        ?.instruction ?? "";
    if (draft.instruction !== original && draft.instruction.trim())
      requestConfirmation({ kind: "discard-comment" });
    else {
      const next = controller.prepareDestructive(
        { kind: "discard-comment" },
        false,
      );
      run(
        controller.confirmDestructive(next).then((ok) => {
          if (ok) restoreDraftEditor(draft);
        }),
      );
    }
  }
  function noteEntry(draft: CommentDraft) {
    const entry = element("div", undefined, "note-entry"),
      row = element("div", undefined, "field-row"),
      field = element("textarea");
    field.setAttribute("aria-label", "批注意见");
    field.rows = 1;
    field.value = draft.instruction;
    let inComposition = false,
      settling = false;
    const resize = () => {
      field.style.height = "auto";
      field.style.height = `${field.scrollHeight}px`;
    };
    const finish = () => {
      if (inComposition || settling || !field.value.trim()) return;
      controller.editComment(field.value);
      const height = entry.getBoundingClientRect().height,
        anchorTop = blocks
          .find((block) => draft.end >= block.from && draft.end <= block.end)
          ?.node?.getBoundingClientRect().top;
      run(
        controller.finishComment().then((id) => {
          focusedNoteId = id;
          noteId = null;
          renderKey = "";
          render();
          const saved = state.input?.comments.find((note) => note.id === id),
            block = blocks.find(
              (block) =>
                saved && saved.end >= block.from && saved.end <= block.end,
            );
          if (block?.wrapper && !reduced()) {
            const spacer = element("div", undefined, "note-collapse");
            spacer.style.setProperty("--collapse-height", `${height}px`);
            block.wrapper.append(spacer);
            later(() => spacer.remove(), 550);
          }
          const after = block?.node?.getBoundingClientRect().top;
          if (anchorTop !== undefined && after !== undefined)
            window.scrollBy({ top: after - anchorTop, behavior: "instant" });
          if (saved && !reduced()) {
            for (const rect of rangeFragments(textRange(saved))) {
              const pulse = element("span", undefined, "note-source-response"),
                origin = paper.getBoundingClientRect();
              pulse.style.left = `${rect.left - origin.left}px`;
              pulse.style.top = `${rect.top - origin.top}px`;
              pulse.style.width = `${rect.width}px`;
              pulse.style.height = `${rect.height}px`;
              pulse.setAttribute("aria-hidden", "true");
              paper.append(pulse);
              later(() => pulse.remove(), 550);
            }
          }
          refreshGeometry();
          const node = [
            ...margin.querySelectorAll<HTMLButtonElement>(".note-node"),
          ].find((node) => node.dataset.notes?.split(",").includes(id));
          node?.focus({ preventScroll: true });
          node?.classList.add("note-completed");
          clearTimeout(completionTimer);
          completionTimer = later(
            () => node?.classList.remove("note-completed"),
            550,
          );
        }),
      );
    };
    const complete = action(
        draft.editingCommentId ? "完成批注修改" : "完成批注",
        "完成",
        finish,
        "note-complete",
      ),
      cancel = action("取消本次批注编辑", "取消", cancelComment, "note-cancel");
    complete.disabled = !field.value.trim();
    field.addEventListener("input", (event) => {
      if (!(event instanceof InputEvent && event.isComposing) && !inComposition)
        controller.editComment(field.value);
      complete.disabled = !field.value.trim();
      resize();
    });
    field.addEventListener("compositionstart", () => {
      inComposition = true;
    });
    field.addEventListener("compositionend", () => {
      inComposition = false;
      settling = true;
      controller.editComment(field.value);
      complete.disabled = !field.value.trim();
      resize();
      clearTimeout(compositionTimer);
      compositionTimer = later(() => {
        settling = false;
      }, 0);
    });
    field.addEventListener("keyup", (event) => {
      if (event.key === "Enter" && !inComposition && !event.isComposing)
        settling = false;
    });
    field.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.stopPropagation();
        if (
          event.isComposing ||
          inComposition ||
          settling ||
          event.keyCode === 229 ||
          event.shiftKey
        )
          return;
        event.preventDefault();
        finish();
      } else if (event.key === "Escape" && !inComposition) {
        event.preventDefault();
        event.stopPropagation();
        cancelComment();
      }
    });
    const actions = element("div", undefined, "note-entry-actions");
    actions.append(cancel, complete);
    row.append(icon("pen"), field, actions);
    entry.append(row);
    later(resize, 0);
    return entry;
  }
  function notePeek(note: Comment) {
    const peek = element("div", undefined, "note-peek");
    if (noteGroup.length > 1) {
      const choices = element("div", undefined, "note-choices");
      for (const id of noteGroup) {
        const item = state.input?.comments.find((value) => value.id === id);
        if (!item) continue;
        const button = action(
          `查看这条意见：${item.instruction}`,
          item.quote.slice(0, 28),
          () => {
            noteId = item.id;
            focusedNoteId = item.id;
            renderKey = "";
            render();
          },
          `note-choice${item.id === note.id ? " selected" : ""}`,
        );
        button.addEventListener("pointerenter", () => highlight(item));
        button.addEventListener("pointerleave", () => highlight(currentNote()));
        choices.append(button);
      }
      peek.append(choices);
    }

    peek.dataset.noteId = note.id;
    if (!note.resolved)
      peek.append(
        element("span", "原句已变动，请选择新的原文关联", "note-preview-quote"),
      );
    peek.append(element("p", note.instruction, "note-preview-body"));
    const actions = element("div", undefined, "note-peek-actions");
    const edit = action(
      note.resolved ? "修改这条批注" : "将批注关联到当前选区",
      "",
      () => {
        if (!note.resolved) {
          if (selected) {
            controller.reanchorComment(note.id, selected);
            run(controller.flush());
          } else showNotice("先选择新的原文，再点这个页签关联。");
        } else {
          noteId = null;
          controller.beginComment(note, note.id);
          manuscript
            .querySelector<HTMLTextAreaElement>(".note-entry textarea")
            ?.focus();
        }
      },
      "edit-note",
    );
    edit.replaceChildren(icon("pen"));
    actions.append(
      edit,
      action(
        "删除这条批注",
        "删除",
        () => requestConfirmation({ kind: "delete-comment", id: note.id }),
        "delete-note",
      ),
      action(
        "关闭批注",
        "关闭",
        () => {
          noteId = null;
          renderKey = "";
          render();
        },
        "delete-note",
      ),
    );
    peek.append(actions);
    return peek;
  }
  function plainBlock(block: Block, readOnly: boolean) {
    const wrapper = element("section", undefined, "block"),
      prose = element(
        block.tag,
        block.text,
        `prose${block.subtitle ? " subtitle" : ""}`,
      );
    prose.contentEditable = readOnly ? "false" : "plaintext-only";
    prose.setAttribute("aria-readonly", String(readOnly));
    if (!readOnly) {
      prose.setAttribute("role", "textbox");
      prose.setAttribute(
        "aria-label",
        block.tag === "h1"
          ? "文稿标题"
          : `编辑：${block.text.slice(0, 22) || "空白段落"}`,
      );
      prose.setAttribute("aria-multiline", "true");
      prose.spellcheck = false;
    }
    block.node = prose;
    block.wrapper = wrapper;
    wrapper.append(prose);
    return wrapper;
  }
  function positionReviewMarks() {
    manuscript.style.paddingBottom = "0px";
    for (const windowNode of manuscript.querySelectorAll<HTMLElement>(
      ".review-window",
    )) {
      const origin = windowNode.getBoundingClientRect();
      const columns: { top: number; bottom: number }[][] = [],
        marks: { node: HTMLElement; column: number }[] = [];
      for (const host of windowNode.querySelectorAll<HTMLElement>(
        ".review-decision",
      )) {
        if (host.dataset.choice !== "pending") continue;
        const node = host.querySelector<HTMLElement>(".review-node");
        const reference = `[data-review-ref="${CSS.escape(host.dataset.change ?? "")}"]`;
        const lineRects = (side: string) =>
          [...windowNode.querySelectorAll(`.review-${side} ${reference}`)]
            .flatMap((fragment) => [...fragment.getClientRects()])
            .filter((rect) => rect.height > 0);
        const original = lineRects("original"),
          proposal = lineRects("proposal");
        const fallback = windowNode
          .querySelector(".review-lane-reading")
          ?.getBoundingClientRect();
        const first =
          host.dataset.kind === "insert"
            ? (proposal[0] ?? original[0] ?? fallback)
            : (original[0] ?? proposal[0] ?? fallback);
        const last =
          host.dataset.kind === "delete"
            ? (original.at(-1) ?? first)
            : (proposal.at(-1) ?? original.at(-1) ?? first);
        if (!node || !first || !last) continue;
        const top = Math.min(first.top, last.top) - origin.top;
        const bottom = Math.max(first.bottom, last.bottom) - origin.top;
        let column = columns.findIndex((intervals) =>
          intervals.every(
            (interval) =>
              top >= interval.bottom + 4 || bottom <= interval.top - 4,
          ),
        );
        if (column < 0) {
          column = columns.length;
          columns.push([]);
        }
        columns[column].push({ top, bottom });
        const width = 1,
          height = Math.max(1, bottom - top);
        marks.push({ node, column });
        node.style.top = `${top}px`;
        node.style.width = `${width}px`;
        node.style.height = `${height}px`;
      }
      const spacing = Math.min(
        8,
        Math.max(0, origin.left - 40) / Math.max(1, columns.length - 1),
      );
      for (const { node, column } of marks)
        node.style.left = `${-32 - column * spacing}px`;
    }
    const reading = manuscript.getBoundingClientRect();
    const receipts: {
      node: HTMLElement;
      preferredTop: number;
      height: number;
      width: number;
      index: number;
    }[] = [];
    for (const host of manuscript.querySelectorAll<HTMLElement>(
      ".review-decision",
    )) {
      if (host.dataset.choice === "pending") continue;
      const node = host.querySelector<HTMLElement>(".review-node");
      const windowNode = host.closest<HTMLElement>(".review-window");
      if (!node || !windowNode) continue;
      const reference = `[data-review-ref="${CSS.escape(host.dataset.change ?? "")}"]`;
      const side = host.dataset.choice === "keep" ? "proposal" : "original";
      const fragments = [
        ...windowNode.querySelectorAll(`.review-selected ${reference}`),
        ...windowNode.querySelectorAll(`.review-${side} ${reference}`),
        ...windowNode.querySelectorAll(reference),
      ];
      const anchor =
        fragments.flatMap((fragment) => [...fragment.getClientRects()])[0] ??
        windowNode.getBoundingClientRect();
      const size = node.getBoundingClientRect();
      receipts.push({
        node,
        preferredTop: anchor.top + anchor.height / 2 - size.height / 2,
        height: size.height,
        width: size.width,
        index: Number(host.dataset.reviewIndex),
      });
    }
    receipts.sort(
      (a, b) => a.preferredTop - b.preferredTop || a.index - b.index,
    );
    const brand = id("brand", HTMLButtonElement).getBoundingClientRect();
    let bottom = -Infinity;
    for (const { node, preferredTop, height, width } of receipts) {
      let top = Math.max(preferredTop, bottom + 4);
      const left = Math.min(reading.right + 4, innerWidth - 8 - width);
      if (
        brand.width > 0 &&
        brand.height > 0 &&
        brand.bottom > 0 &&
        brand.top < innerHeight &&
        left < brand.right &&
        left + width > brand.left &&
        top < brand.bottom + 4 &&
        top + height > brand.top - 4
      )
        top = brand.bottom + 4;
      const containingBlock = node.offsetParent;
      if (!(containingBlock instanceof HTMLElement)) continue;
      const origin = containingBlock.getBoundingClientRect();
      const x =
        origin.left + containingBlock.clientLeft - containingBlock.scrollLeft;
      const y =
        origin.top + containingBlock.clientTop - containingBlock.scrollTop;
      node.style.left = `${left - x}px`;
      node.style.top = `${top - y}px`;
      bottom = top + height;
    }
    manuscript.style.paddingBottom = `${Math.max(0, bottom + 4 - reading.bottom)}px`;
  }

  function reviewLane(
    blocks: LaneBlock[],
    side: "original" | "proposal" | "selected",
    structural: boolean,
    label = "",
  ) {
    const lane = element("div", undefined, `review-lane review-${side}`);
    lane.setAttribute(
      "aria-label",
      side === "original"
        ? "原文"
        : side === "proposal"
          ? "建议"
          : "已选择的正文",
    );
    if (label) lane.append(element("span", label, "review-lane-label"));
    const fineIds = new Set(
      blocks.flatMap((block) =>
        block.runs.filter((run) => run.mark === "equal").map((run) => run.id),
      ),
    );
    for (const block of blocks) {
      if (!block.runs.some((run) => run.text.trim())) continue;
      const node = element(
        structural ? block.format.tag : "span",
        undefined,
        `${structural ? "prose " : ""}review-lane-reading${block.format.subtitle ? " subtitle" : ""}`,
      );
      for (const run of block.runs) {
        if (run.tag === "text") node.append(document.createTextNode(run.text));
        else {
          const mark =
            !fineIds.has(run.id) && side !== "selected" ? "whole" : run.mark;
          const fragment = element(
            mark === "delete" ? "del" : mark === "insert" ? "ins" : "span",
            run.text,
            `review-fragment ${mark}-fragment`,
          );
          fragment.dataset.reviewRef = run.id;
          const locate = () => markReview(run.id, true),
            clear = () => markReview(run.id, false);
          fragment.addEventListener("pointerenter", locate);
          fragment.addEventListener("pointerleave", clear);
          node.append(fragment);
        }
      }
      lane.append(node);
    }
    if (
      side !== "selected" &&
      !blocks.some((block) => block.runs.some((run) => run.text.trim()))
    ) {
      const raw = blocks.map((block) => block.raw).join("");
      const empty = element(
        "span",
        raw.length
          ? raw.trim()
            ? "仅格式"
            : "仅空白"
          : side === "original"
            ? "原处无文字"
            : "此处删去",
        "review-empty",
      );
      lane.append(empty);
    }
    return lane;
  }

  function reviewDecision(
    decision: Decision,
    showControls = true,
    showCue = true,
    multiple = false,
  ) {
    const { change, index, kind, choice } = decision;
    const host = element(
      "div",
      undefined,
      `review-decision${choice === "pending" ? (showControls ? " active" : "") : ` resolved${activeReview === change.id ? " open" : ""}`}`,
    );
    host.dataset.change = change.id;
    host.dataset.choice = choice;
    host.dataset.kind = kind;
    host.dataset.reviewIndex = String(index);
    const label = `第 ${index + 1} 处${kind === "insert" ? "新增" : kind === "delete" ? "删除" : "替换"}${choice === "pending" ? "建议" : choice === "keep" ? "，已接受" : "，已保留原文"}`;
    const toggle =
      choice === "pending"
        ? element("span")
        : action(label, "", () =>
            setActiveReview(activeReview === change.id ? null : change.id),
          );
    toggle.className =
      choice === "pending"
        ? "review-node review-locator"
        : "review-node review-receipt-node chosen";
    if (choice === "pending") {
      toggle.tabIndex = -1;
      toggle.setAttribute("role", "img");
      toggle.setAttribute("aria-label", label);
    }
    toggle.removeAttribute("data-tip");
    if (choice !== "pending")
      toggle.setAttribute("aria-expanded", String(activeReview === change.id));
    if (choice !== "pending") {
      toggle.setAttribute("aria-label", `${label}，查看原文与建议`);
      toggle.replaceChildren(icon("tab"));
    }
    host.append(toggle);
    const locate = () => markReview(change.id, true),
      clear = () => markReview(change.id, false);
    host.addEventListener("pointerenter", locate);
    host.addEventListener("pointerleave", clear);
    host.addEventListener("focusin", locate);
    host.addEventListener("focusout", clear);
    if (!showControls || (choice !== "pending" && activeReview !== change.id))
      return host;
    const context = element("div", undefined, "review-context");
    const controls = element("div", undefined, "review-actions");
    if (multiple || choice !== "pending") {
      const outcome =
        choice === "pending" ? "" : choice === "keep" ? "已接受" : "已保留原文";
      controls.append(
        element(
          "span",
          `${multiple ? `第 ${index + 1} 处${outcome ? " · " : ""}` : ""}${outcome}`,
          "review-outcome",
        ),
      );
    }
    if (showCue && choice === "pending" && kind !== "replace")
      controls.append(
        element("span", kind === "insert" ? "新增" : "删去", "review-cue"),
      );
    for (const [label, value] of [
      ["接受", "keep"],
      ["保留原文", "discard"],
    ] as const) {
      const button = element("button", label);
      button.dataset.choice = value;
      button.setAttribute("aria-pressed", String(choice === value));
      button.setAttribute("aria-label", `${label}第 ${index + 1} 处修改`);
      button.disabled = state.busy > 0;
      button.addEventListener("click", () => chooseReview(change.id, value));
      controls.append(button);
    }
    context.append(controls);
    host.append(context);
    return host;
  }

  function reviewWindow(part: Comparison, structural = false) {
    const wrapper = element(
      "section",
      undefined,
      `review-window${part.tag === "settled" ? " review-settled" : ""}${structural ? " review-structural" : ""}`,
    );
    wrapper.dataset.reviewWindow = part.key;
    if (part.tag === "settled")
      wrapper.append(reviewLane(part.blocks, "selected", structural));
    else {
      const pending = part.decisions.filter(
        (decision) => decision.choice === "pending",
      );
      const headingLabel = (blocks: LaneBlock[]) =>
        part.formatChanges.includes("heading")
          ? ({ h1: " · 一级标题", h2: " · 二级标题", p: " · 正文" }[
              blocks.find((block) => block.runs.some((run) => run.text.trim()))
                ?.format.tag ?? "p"
            ] ?? "")
          : "";
      if (
        part.readbackId ||
        pending.some((decision) => decision.kind !== "insert") ||
        part.original.some((block) => block.runs.some((run) => run.text.trim()))
      )
        wrapper.append(
          reviewLane(
            part.original,
            "original",
            structural,
            part.readbackId ? `原文${headingLabel(part.original)}` : "",
          ),
        );
      if (
        part.readbackId ||
        pending.some((decision) => decision.kind !== "delete") ||
        part.proposal.some((block) => block.runs.some((run) => run.text.trim()))
      )
        wrapper.append(
          reviewLane(
            part.proposal,
            "proposal",
            structural,
            part.readbackId ? `建议${headingLabel(part.proposal)}` : "",
          ),
        );
    }
    const visibleChange = (id: string) =>
      part.tag !== "settled" &&
      [...part.original, ...part.proposal].some((block) =>
        block.runs.some(
          (run) =>
            run.tag === "edit" &&
            run.id === id &&
            run.mark !== "equal" &&
            run.text.trim(),
        ),
      );
    const invisibleComparison =
      part.tag !== "settled" &&
      part.decisions.some(
        ({ change, choice }) =>
          (choice === "pending" || change.id === part.readbackId) &&
          !visibleChange(change.id),
      );
    if (part.formatChanges.length && invisibleComparison) {
      const indicator = element(
        "span",
        part.formatChanges.includes("heading") ? "标题格式" : "换行与空白",
        "review-format",
      );
      wrapper.append(indicator);
    }
    for (const { change, choice } of part.decisions) {
      if (
        !wrapper.querySelector(`[data-review-ref="${CSS.escape(change.id)}"]`)
      ) {
        const anchor = element(
          "span",
          "",
          `review-fragment boundary-fragment${choice === "pending" ? "" : " settled-boundary"}`,
        );
        anchor.dataset.reviewRef = change.id;
        (wrapper.querySelector(".review-lane-reading") ?? wrapper).append(
          anchor,
        );
      }
    }
    const controls = element("div", undefined, "review-controls");
    const active =
      part.decisions.find((decision) => decision.change.id === activeReview) ??
      part.decisions.find((decision) => decision.choice === "pending");
    const pending = part.decisions.filter(
      (decision) => decision.choice === "pending",
    );
    if (
      pending.length > 1 ||
      (pending.length && part.tag === "comparison" && part.readbackId)
    ) {
      const targets = element("div", undefined, "review-targets");
      targets.setAttribute("aria-label", "选择这段中的修改");
      for (const decision of pending) {
        const button = action(
          `选择第 ${decision.index + 1} 处修改操作`,
          "",
          () => setActiveReview(decision.change.id, "selector"),
          "review-target",
        );
        button.replaceChildren(
          document.createTextNode(`建议 ${decision.index + 1}`),
        );
        button.dataset.reviewTarget = decision.change.id;
        button.setAttribute("aria-pressed", String(decision === active));
        button.removeAttribute("data-tip");
        button.disabled = state.busy > 0;
        const locate = () => markReview(decision.change.id, true),
          clear = () => markReview(decision.change.id, false);
        button.addEventListener("pointerenter", locate);
        button.addEventListener("pointerleave", clear);
        button.addEventListener("focus", locate);
        button.addEventListener("blur", clear);
        targets.append(button);
      }
      controls.append(targets);
    }
    for (const decision of part.decisions)
      controls.append(
        reviewDecision(
          decision,
          decision === active,
          visibleChange(decision.change.id),
          part.decisions.length > 1,
        ),
      );
    wrapper.append(controls);
    return wrapper;
  }

  function renderReviewBlock(block: ReviewBlock) {
    if (block.tag === "structural") return reviewWindow(block.comparison, true);
    const host = element("section", undefined, "block review-paragraph");
    const prose = element(
      block.format.tag === "p" ? "div" : block.format.tag,
      undefined,
      `prose review-reading${block.format.subtitle ? " subtitle" : ""}`,
    );
    prose.setAttribute("aria-readonly", "true");
    for (const part of block.parts) {
      if (part.tag === "context")
        prose.append(document.createTextNode(part.visible));
      else prose.append(reviewWindow(part));
    }
    const empty = block.parts.every((part) =>
      part.tag === "context"
        ? !part.visible
        : part.tag === "settled" &&
          !part.blocks.some((block) => block.runs.some((run) => run.text)),
    );
    if (empty) prose.classList.add("review-empty-reading");
    host.append(prose);
    return host;
  }

  function markReview(changeId: string | undefined, marked: boolean) {
    if (!changeId) return;
    for (const node of manuscript.querySelectorAll(
      `[data-review-ref="${CSS.escape(changeId)}"], [data-change="${CSS.escape(changeId)}"]`,
    ))
      node.classList.toggle("located", marked);
  }
  function reviewAnchor(
    changeId: string,
    preferredSide: "original" | "proposal",
  ) {
    const fragments = [
      ...manuscript.querySelectorAll(
        `[data-review-ref="${CSS.escape(changeId)}"]`,
      ),
    ];
    fragments.sort(
      (a, b) =>
        Number(Boolean(b.closest(`.review-${preferredSide}`))) -
        Number(Boolean(a.closest(`.review-${preferredSide}`))),
    );
    for (const node of fragments) {
      const rects = [...node.getClientRects()],
        line = rects.findIndex(
          (rect) => rect.bottom > 0 && rect.top < innerHeight,
        );
      if (line >= 0) {
        const side = node.closest(".review-proposal")
          ? "proposal"
          : node.closest(".review-original")
            ? "original"
            : "selected";
        return {
          top: rects[line].top,
          side,
          fragmentIndex: fragments
            .filter((fragment) => fragment.closest(`.review-${side}`))
            .indexOf(node),
          line,
          control: false,
        };
      }
    }
    const host = manuscript.querySelector(
        `[data-change="${CSS.escape(changeId)}"]`,
      ),
      control = [...(host?.querySelectorAll("button") ?? [])].find((node) => {
        const rect = node.getBoundingClientRect();
        return rect.bottom > 0 && rect.top < innerHeight;
      });
    return control
      ? {
          top: control.getBoundingClientRect().top,
          side: preferredSide,
          fragmentIndex: 0,
          line: 0,
          control: true,
        }
      : null;
  }
  function restoreReviewAnchor(
    changeId: string,
    anchor: ReturnType<typeof reviewAnchor>,
    preferredSide: "original" | "proposal",
  ) {
    const node = manuscript.querySelector<HTMLElement>(
      `[data-change="${CSS.escape(changeId)}"] .review-node`,
    );
    if (!anchor) return node;
    const fragments = [
        ...manuscript.querySelectorAll(
          `[data-review-ref="${CSS.escape(changeId)}"]`,
        ),
      ],
      side = anchor.side === "selected" ? preferredSide : anchor.side,
      sameSide = fragments.filter((fragment) =>
        fragment.closest(`.review-${side}`),
      ),
      selected = fragments.filter((fragment) =>
        fragment.closest(".review-selected"),
      ),
      candidates = sameSide.length
        ? sameSide
        : selected.length
          ? selected
          : fragments,
      fragment =
        candidates[Math.min(anchor.fragmentIndex, candidates.length - 1)],
      rects = fragment ? [...fragment.getClientRects()] : [],
      rect = anchor.control
        ? node?.getBoundingClientRect()
        : (rects[Math.min(anchor.line, rects.length - 1)] ??
          node?.getBoundingClientRect());
    if (rect) {
      const delta = rect.top - anchor.top;
      if (Math.abs(delta) > 0.25)
        window.scrollBy({ top: delta, behavior: "instant" });
    }
    return node;
  }
  function setActiveReview(changeId: string | null, focus = "receipt") {
    cancelReviewMotion();
    const target = changeId ?? activeReview;
    if (!target) return;
    const side =
        review()?.decisions[target] === "keep" ? "proposal" : "original",
      anchor = reviewAnchor(target, side);
    activeReview = changeId;
    renderKey = "";
    render();
    positionReviewMarks();
    const receipt = restoreReviewAnchor(target, anchor, side),
      control =
        focus === "selector"
          ? manuscript.querySelector<HTMLElement>(
              `[data-review-target="${CSS.escape(target)}"]`,
            )
          : receipt;
    (control ?? receipt)?.focus({ preventScroll: true });
  }
  function chooseReview(changeId: string, choice: "keep" | "discard") {
    cancelReviewMotion();
    const oldHost = manuscript.querySelector(
        `[data-change="${CSS.escape(changeId)}"]`,
      ),
      oldBlock =
        oldHost?.closest(".review-paragraph") ??
        oldHost?.closest(".review-structural"),
      oldHeight = oldBlock?.getBoundingClientRect().height;
    const side = choice === "keep" ? "proposal" : "original",
      anchor = reviewAnchor(changeId, side);
    run(
      controller.choose(changeId, choice).then(() => {
        activeReview = null;
        renderKey = "";
        render();
        restoreReviewAnchor(changeId, anchor, side)?.focus({
          preventScroll: true,
        });
        const host = manuscript.querySelector(
            `[data-change="${CSS.escape(changeId)}"]`,
          ),
          block =
            host?.closest(".review-paragraph") ??
            host?.closest(".review-structural"),
          newHeight = block?.getBoundingClientRect().height;
        if (block && oldHeight && newHeight && !reduced())
          reviewAnimations.push(
            block.animate(
              [
                {
                  height: `${oldHeight}px`,
                  boxSizing: "border-box",
                  opacity: 0.65,
                },
                {
                  height: `${newHeight}px`,
                  boxSizing: "border-box",
                  opacity: 1,
                },
              ],
              { duration: 160, easing: "ease-out" },
            ),
          );
      }),
    );
  }
  function renderManuscript() {
    cancelReviewMotion();
    manuscript.replaceChildren();
    const view = getView(),
      round = review();
    const body = historical()
      ? (view.versions.find((version) => version.number === state.viewedVersion)
          ?.body ?? "")
      : (state.input?.draft ?? view.draft);
    blocks = parts(body);
    if (round) {
      const choices = Object.fromEntries(
        round.changes.map((change) => [
          change.id,
          round.decisions[change.id] ?? "pending",
        ]),
      );
      for (const block of reviewDocument(
        { ...round, choices },
        { openedId: activeReview },
      ).blocks)
        manuscript.append(renderReviewBlock(block));
    } else if (!supportsProse(body)) {
      const description = element(
        "p",
        "此文稿包含复杂 Markdown。原文编辑保留全部格式与换行。",
        "exact-description",
      );
      const field = element("textarea", undefined, "exact-editor");
      field.setAttribute("aria-label", "工作稿正文");
      field.value = body;
      field.readOnly = !editable();
      field.spellcheck = false;
      field.addEventListener("input", () => {
        if (!composing) {
          const next = editExactText(state.input!.draft, field.value);
          renderKey = bodyKey(next);
          controller.editBody(next);
          field.style.height = `${field.scrollHeight}px`;
        }
      });
      field.addEventListener("select", refreshSelection);
      field.addEventListener("compositionstart", () => {
        composing = true;
      });
      field.addEventListener("compositionend", () => {
        composing = false;
        const next = editExactText(state.input!.draft, field.value);
        renderKey = bodyKey(next);
        controller.editBody(next);
      });
      manuscript.append(description, field);
      later(() => {
        field.style.height = `${Math.max(320, field.scrollHeight)}px`;
      }, 0);
    } else
      for (const block of blocks)
        manuscript.append(plainBlock(block, !editable()));
    const note = currentNote();
    if (note && !historical() && !round) {
      const block = blocks.find(
        (value) => note.end >= value.from && note.end <= value.end,
      );
      const host =
        block?.wrapper ??
        blocks.find((value) => value.wrapper)?.wrapper ??
        manuscript;
      host.append(
        state.input?.commentDraft
          ? noteEntry(state.input.commentDraft)
          : noteId && "resolved" in note
            ? notePeek(note)
            : element("span"),
      );
    }
    paper.classList.toggle("view-history", historical());
    manuscript.setAttribute("aria-busy", String(state.busy > 0));
    selectionHost.hidden = true;
    scheduleGeometry();
  }
  function saveEditor() {
    if (composing || !editable() || !state.input) return;
    const next = blocks
      .map((block) => block.prefix + (block.node?.innerText ?? block.text))
      .join("\n\n");
    if (next === state.input.draft) return;
    let offset = 0;
    for (const block of blocks) {
      block.text = block.node?.innerText ?? block.text;
      block.raw = block.prefix + block.text;
      block.from = offset;
      block.end = offset + block.raw.length;
      offset = block.end + 2;
    }
    renderKey = bodyKey(next);
    controller.editBody(next);
    selected = null;
    selectionHost.hidden = true;
    scheduleGeometry();
  }
  function bodyKey(body?: string) {
    const view = state.snapshot;
    if (!view) return "";
    return JSON.stringify({
      body:
        body ??
        (historical()
          ? view.versions.find(
              (version) => version.number === state.viewedVersion,
            )?.body
          : state.input?.draft),
      version: state.viewedVersion,
      round: view.round,
      composer: state.input?.commentDraft?.id ?? null,
      note: noteId,
      noteResolved: noteId
        ? state.input?.comments.find((note) => note.id === noteId)?.resolved
        : null,
      noteContent: noteId
        ? state.input?.comments.find((note) => note.id === noteId)?.instruction
        : null,
      activeReview,
      locked: locked(),
    });
  }
  function positionBrand() {
    const anchor = id("brand-anchor", HTMLElement).getBoundingClientRect(),
      origin = paper.getBoundingClientRect();
    const travel = Math.min(280, innerHeight * 0.32),
      progress = Math.max(0, Math.min(1, (scrollY - 12) / travel)),
      eased = progress * progress * (3 - 2 * progress),
      outward = Math.min(1, Math.max(0, scrollY / 48)),
      lateral = outward * outward * (3 - 2 * outward);
    const startX = anchor.left - 7,
      sideX = Math.min(
        innerWidth - 48,
        origin.right + (innerWidth - origin.right - 44) / 2,
      ),
      x = Math.max(
        4,
        Math.min(innerWidth - 48, startX + (sideX - startX) * lateral),
      ),
      y = Math.max(
        8,
        (anchor.top - 7) * (1 - eased) + (innerHeight / 2 - 22) * eased,
      );
    dock.dataset.placement =
      scrollY <= 12 ? "header" : y < 88 ? "edge" : "side";
    dock.dataset.travelling = String(scrollY > 0 && progress < 1);
    dock.style.setProperty("--dock-progress", String(eased));
    dock.style.setProperty("--dock-x", `${x}px`);
    dock.style.setProperty("--dock-y", `${y}px`);
    positionActions();
  }
  function positionActions() {
    if (reveal === "closed") return;
    const rect = dock.getBoundingClientRect(),
      layout = orbitLayout({
        anchor: { x: rect.left, y: rect.top },
        article: manuscript.getBoundingClientRect(),
        viewport: { width: innerWidth, height: innerHeight },
        placement: dock.dataset.placement ?? "header",
      });
    dock.dataset.layout = layout.mode;
    const place = (
      node: HTMLElement,
      slot: { x: number; y: number; width: number },
    ) => {
      node.style.left = `${slot.x - rect.left}px`;
      node.style.top = `${slot.y - rect.top}px`;
      node.style.width = `${slot.width}px`;
    };
    place(generateButton, layout.slots.ai);
    place(id("document-save", HTMLElement), layout.slots.apply);
    place(historyButton, layout.slots.version);
    const bridge = root.querySelector<SVGSVGElement>("#orbit-corridor");
    if (bridge) {
      const box = layout.corridor;
      bridge.style.left = `${box.x - rect.left}px`;
      bridge.style.top = `${box.y - rect.top}px`;
      bridge.style.width = `${box.right - box.x}px`;
      bridge.style.height = `${box.bottom - box.y}px`;
      bridge.setAttribute(
        "viewBox",
        `0 0 ${box.right - box.x} ${box.bottom - box.y}`,
      );
      bridge.querySelector("rect")?.setAttribute("width", "100%");
      bridge.querySelector("rect")?.setAttribute("height", "100%");
    }
  }
  function setReveal(next: typeof reveal, focus = false) {
    clearTimeout(dockTimer);
    reveal = next;
    dock.dataset.reveal = next;
    nav.hidden = next === "closed";
    brand.setAttribute("aria-expanded", String(next !== "closed"));
    positionActions();
    if (focus) {
      const target = [
        ...nav.querySelectorAll<HTMLButtonElement>(".satellite:not(:disabled)"),
      ].find((node) => node.getClientRects().length);
      target?.focus({ preventScroll: true });
    }
  }
  function showNotice(message: string) {
    notice.textContent = message;
    notice.classList.add("visible");
  }
  function taskAction() {
    const round = getView().round;
    if (!round || (round.phase === "interrupted" && round.executionEnded)) {
      noteId = null;
      selected = null;
      renderKey = "";
    }
    setReveal("closed");
    if (getView().applyStatus?.phase === "checking") {
      run(controller.recheck());
      return;
    }
    if (round?.phase === "waiting" || round?.phase === "editing")
      requestConfirmation({ kind: "cancel" });
    else if (round?.phase === "review" || round?.phase === "empty") {
      const allDiscarded =
        round.phase === "review" &&
        round.changes.every(
          (change) => round.decisions[change.id] === "discard",
        );
      if (round.phase === "empty" || allDiscarded)
        run(
          controller.confirmDestructive(
            controller.prepareDestructive({ kind: "abandon" }, false),
          ),
        );
      else requestConfirmation({ kind: "abandon" });
    } else if (round?.phase === "interrupted") {
      if (round.executionEnded) {
        const unchanged =
          state.input?.draft === round.base &&
          state.input?.draftRevision === round.sourceDraftRevision &&
          JSON.stringify(state.input?.comments) ===
            JSON.stringify(round.submittedComments);
        run(unchanged ? controller.retry() : controller.generate());
      } else showNotice("生成中断，待核对。原执行结束前无法重新生成。");
    } else run(controller.generate());
  }
  function captureFieldSelection(field: HTMLTextAreaElement): FieldSelection {
    const { selectionStart, selectionEnd, selectionDirection } = field;
    const offsets = field.classList.contains("exact-editor")
      ? textareaText(state.input!.draft).sourceOffsets
      : null;
    return [
      offsets ? offsets[selectionStart] : selectionStart,
      offsets ? offsets[selectionEnd] : selectionEnd,
      selectionDirection,
    ];
  }
  function restoreFieldSelection(
    field: HTMLTextAreaElement,
    selection: FieldSelection,
  ) {
    const [start, end, direction] = selection;
    const body = field.classList.contains("exact-editor")
      ? state.input!.draft
      : null;
    field.setSelectionRange(
      body === null ? start : editorOffset(body, start),
      body === null ? end : editorOffset(body, end),
      direction,
    );
  }
  function requestConfirmation(action: DestructiveAction) {
    modalFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    modalSelection =
      modalFocus instanceof HTMLTextAreaElement
        ? captureFieldSelection(modalFocus)
        : null;
    controller.prepareDestructive(action);
  }
  function restoreModalFocus() {
    const target = modalFocus?.isConnected
      ? modalFocus
      : (manuscript.querySelector<HTMLTextAreaElement>(
          ".note-entry textarea",
        ) ?? brand);
    target.focus({ preventScroll: true });
    if (target instanceof HTMLTextAreaElement && modalSelection)
      restoreFieldSelection(target, modalSelection);
    modalFocus = null;
    modalSelection = null;
  }
  function renderConfirmation() {
    ticket = state.confirmation;
    if (!ticket) {
      if (dialog.open) {
        dialog.close();
        restoreModalFocus();
      }
      return;
    }
    const action = ticket.action;
    const base = getView().versions.find(
        (version) => version.number === getView().workingBase.version,
      ),
      discardable: string[] = [];
    if (state.input?.draft !== base?.body) discardable.push("未保存的正文");
    if (state.input?.comments.length)
      discardable.push(`${state.input.comments.length} 条批注`);
    if (getView().round?.phase === "review") discardable.push("本轮建议与选择");
    if (state.input?.commentDraft) discardable.push("未完成的批注");
    dialog.dataset.excerpt = String(action.kind === "delete-comment");
    const details =
      action.kind === "adopt"
        ? {
            title: `从 V${action.version} 继续写？`,
            detail: `${discardable.join("、")}将被替换。已保存的版本始终保留。切换不会写入原文件。`,
            confirm: "从此版继续写",
          }
        : action.kind === "cancel"
          ? {
              title: "停止本轮生成？",
              detail: "本轮结果将不再接收。工作稿和批注会保留。",
              confirm: "停止生成",
            }
          : action.kind === "abandon"
            ? {
                title: "结束本轮审阅？",
                detail: "本轮建议与选择将被放弃。工作稿和批注会保留。",
                confirm: "结束审阅",
              }
            : action.kind === "delete-comment"
              ? {
                  title: "删除这条批注？",
                  detail:
                    state.input?.comments.find((note) => note.id === action.id)
                      ?.instruction ?? "",
                  confirm: "删除",
                }
              : {
                  title: "放弃本次批注输入？",
                  detail: "未完成的输入将被放弃。",
                  confirm: "放弃输入",
                };
    id("confirmation-title", HTMLElement).textContent = details.title;
    id("confirmation-consequence", HTMLElement).textContent = details.detail;
    confirmButton.textContent = details.confirm;
    if (!dialog.open) {
      dialog.showModal();
      cancelButton.focus();
    }
  }
  function captureBookmark(): Bookmark {
    const selection = window.getSelection(),
      range = selection?.rangeCount ? selection.getRangeAt(0) : null,
      index = blocks.findIndex(
        (block) => range && block.node?.contains(range.startContainer),
      );
    const block = blocks[index];
    const endBlock = blocks.findIndex(
      (block) => range && block.node?.contains(range.endContainer),
    );
    const last = blocks[endBlock];
    const focus = document.activeElement;
    return {
      x: scrollX,
      y: scrollY,
      focus:
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null,
      block: index,
      endBlock,
      fieldSelection:
        focus instanceof HTMLTextAreaElement
          ? captureFieldSelection(focus)
          : null,
      start:
        range && block?.node
          ? textOffset(block.node, range.startContainer, range.startOffset)
          : 0,
      end:
        range && last?.node
          ? textOffset(last.node, range.endContainer, range.endOffset)
          : 0,
      note: noteId,
      selected,
      review: activeReview,
    };
  }
  function openHistory() {
    if (historical()) return;
    bookmark = captureBookmark();
    noteId = null;
    selected = null;
    setReveal("closed");
    controller.browseVersion(getView().workingBase.version);
    viewport.focus({ preventScroll: true });
  }
  function closeHistory() {
    if (!historical()) return;
    const saved = bookmark;
    noteId = saved?.note ?? null;
    selected = saved?.selected ?? null;
    activeReview = saved?.review ?? null;
    controller.browseVersion(null);
    refreshGeometry();
    if (saved) {
      const node = blocks[saved.block]?.node;
      const target = saved.focus?.isConnected
        ? saved.focus
        : saved.focus instanceof HTMLTextAreaElement
          ? (manuscript.querySelector<HTMLTextAreaElement>(
              saved.focus.classList.contains("exact-editor")
                ? ".exact-editor"
                : ".note-entry textarea",
            ) ?? brand)
          : saved.focus?.classList.contains("note-node")
            ? ([
                ...margin.querySelectorAll<HTMLButtonElement>(".note-node"),
              ].find((node) =>
                node.dataset.notes
                  ?.split(",")
                  .includes(saved.note ?? focusedNoteId ?? ""),
              ) ?? brand)
            : (node ?? brand);
      target.focus({ preventScroll: true });
      if (node) {
        const range = document.createRange();
        range.setStart(...pointInText(node, saved.start));
        range.setEnd(
          ...pointInText(blocks[saved.endBlock]?.node ?? node, saved.end),
        );
        window.getSelection()?.removeAllRanges();
        window.getSelection()?.addRange(range);
      }
      if (target instanceof HTMLTextAreaElement && saved.fieldSelection)
        restoreFieldSelection(target, saved.fieldSelection);
      window.scrollTo({ left: saved.x, top: saved.y, behavior: "instant" });
    }
    bookmark = null;
  }
  function finishAdoption() {
    bookmark = null;
    noteId = null;
    activeReview = null;
    selected = null;
    focusedNoteId = null;
    noteGroup = [];
    renderKey = "";
    render();
    window.scrollTo({ top: 0, behavior: "instant" });
    blocks[0]?.node?.focus();
  }
  function requestAdopt(version: number) {
    const view = getView(),
      base = view.versions.find(
        (value) => value.number === view.workingBase.version,
      );
    if (
      state.input?.draft !== base?.body ||
      state.input?.comments.length ||
      view.round
    )
      requestConfirmation({ kind: "adopt", version });
    else
      run(
        controller
          .confirmDestructive(
            controller.prepareDestructive({ kind: "adopt", version }, false),
          )
          .then((ok) => {
            if (ok) finishAdoption();
          }),
      );
  }
  function renderChrome() {
    const view = getView(),
      round = view.round,
      pending =
        round?.phase === "review"
          ? round.changes.filter((change) => !round.decisions[change.id]).length
          : 0;
    const phase = historical()
      ? "history"
      : view.applyStatus?.phase === "checking"
        ? "applying"
        : round?.phase === "review"
          ? "review"
          : round?.phase === "waiting" || round?.phase === "editing"
            ? "generating"
            : state.input?.commentDraft
              ? "annotating"
              : "writing";
    paper.dataset.mode = phase;
    brand.dataset.state =
      view.applyStatus?.phase === "checking"
        ? "busy"
        : round?.phase === "editing"
          ? "busy"
          : round?.phase === "waiting"
            ? "waiting"
            : round?.phase === "interrupted"
              ? "attention"
              : pending
                ? "result"
                : "idle";
    brand.title = view.documentName;
    const badge = id("pending-badge", HTMLElement);
    badge.textContent = String(pending);
    badge.hidden = pending === 0;
    badge.setAttribute("aria-label", `${pending} 处待选建议`);
    const task =
      view.applyStatus?.phase === "checking"
        ? "重新核对写入"
        : round?.phase === "waiting" || round?.phase === "editing"
          ? "停止生成"
          : round?.phase === "review"
            ? "结束审阅"
            : round?.phase === "empty"
              ? "结束本轮"
              : round?.phase === "interrupted"
                ? "重新生成"
                : "按本轮全部批注改稿";
    generateButton.setAttribute("aria-label", task);
    id("generate-label", HTMLElement).textContent = task;
    id("task-glyph", HTMLElement).textContent =
      view.applyStatus?.phase === "checking"
        ? "↻"
        : round?.phase === "waiting" || round?.phase === "editing"
          ? "■"
          : round?.phase === "review" || round?.phase === "empty"
            ? "↗"
            : round?.phase === "interrupted"
              ? "↻"
              : "AI";
    generateButton.disabled =
      historical() ||
      Boolean(state.input?.commentDraft) ||
      ((!round || round.phase === "interrupted") &&
        Boolean(state.input?.comments.some((note) => !note.resolved))) ||
      (round?.phase === "interrupted" && !round.executionEnded) ||
      (!round &&
        !state.input?.comments.length &&
        view.applyStatus?.phase !== "checking");
    const base = view.versions.find(
        (version) => version.number === view.workingBase.version,
      ),
      hasEdits = state.input?.draft !== base?.body;
    const canSave =
      !historical() &&
      !state.input?.commentDraft &&
      pending === 0 &&
      (round?.phase === "review" ? round.preview !== base?.body : hasEdits) &&
      phase !== "generating" &&
      view.applyStatus?.phase !== "checking";
    id("document-save", HTMLElement).hidden =
      !canSave && view.applyStatus?.phase !== "checking";
    saveButton.disabled = !canSave;
    saveButton.setAttribute(
      "aria-busy",
      String(view.applyStatus?.phase === "checking"),
    );
    dock.dataset.applying = String(view.applyStatus?.phase === "checking");
    id("version-label", HTMLElement).textContent =
      `V${view.workingBase.version}`;
    historyButton.setAttribute(
      "aria-label",
      `查看版本轨迹 · 当前 V${view.workingBase.version}`,
    );
    const message =
      state.error ??
      (view.applyStatus?.phase === "checking"
        ? "正在核对写入结果"
        : view.applyStatus?.phase === "not-written"
          ? "未写入原文件。核对后可重新保存。"
          : state.savedReceipt
            ? `已写入原文件 · V${state.savedReceipt}`
            : round?.phase === "waiting"
              ? "等待 Codex"
              : round?.phase === "editing"
                ? "正在改稿"
                : round?.phase === "interrupted"
                  ? round.message
                  : round?.phase === "empty"
                    ? "没有新建议"
                    : "");
    const status = id("dock-state", HTMLElement);
    status.textContent = message;
    status.hidden = !message;
    if (
      state.error ||
      view.applyStatus?.phase === "checking" ||
      round?.phase === "interrupted"
    ) {
      showNotice(message);
      if (
        view.applyStatus?.phase === "checking" &&
        !notice.querySelector("button")
      )
        notice.append(
          action("核对这次写入", "核对写入", () => run(controller.recheck())),
        );
    } else {
      notice.textContent = "";
      notice.classList.remove("visible");
    }
    id("history-close", HTMLButtonElement).setAttribute(
      "aria-label",
      round?.phase === "review" ? "返回审阅" : "返回工作稿",
    );
    const returnLabel = id("history-close", HTMLButtonElement).querySelector(
      "span",
    );
    if (returnLabel)
      returnLabel.textContent =
        round?.phase === "review" ? "返回审阅" : "返回工作稿";
    history.hidden = !historical();
    document.body.classList.toggle("history-open", historical());
    const mode = id("mode-bar", HTMLElement);
    mode.hidden = !historical();
    mode.textContent = historical() ? `V${state.viewedVersion} · 正在查看` : "";
    ruler.update({
      versions: view.versions.map((version) => ({
        id: String(version.number),
        number: version.number,
        text: version.body,
        time: version.savedAt,
        parentVersionId:
          version.parentVersion === null ? null : String(version.parentVersion),
      })),
      selectedId: String(state.viewedVersion),
      savedHeadId: String(view.versions.at(-1)?.number),
      enabled: historical() && !dialog.open,
      reducedMotion: reduced(),
    });
    id("history-adopt", HTMLButtonElement).disabled =
      Boolean(
        (view.round && ["waiting", "editing"].includes(view.round.phase)) ||
        (view.round?.phase === "interrupted" && !view.round.executionEnded),
      ) ||
      Boolean(state.input?.commentDraft) ||
      view.applyStatus?.phase === "checking";
    renderConfirmation();
    positionBrand();
  }
  function render() {
    state = controller.read();
    if (!state.snapshot) {
      manuscript.textContent = state.error ?? "正在打开文稿…";
      return;
    }
    const key = bodyKey();
    if (key !== renderKey && !composing) {
      renderKey = key;
      renderManuscript();
    }
    renderChrome();
    scheduleGeometry();
    if (review()) positionReviewMarks();
  }
  manuscript.addEventListener(
    "pointerdown",
    (event) => {
      if (
        event.target instanceof HTMLElement &&
        event.target.closest(".prose") &&
        noteId
      ) {
        noteId = null;
        manuscript.querySelector(".note-peek")?.remove();
        renderKey = bodyKey();
        scheduleGeometry();
      }
    },
    { signal: abort.signal },
  );
  manuscript.addEventListener(
    "compositionstart",
    (event) => {
      if (event.target instanceof HTMLElement && event.target.matches(".prose"))
        composing = true;
    },
    { signal: abort.signal },
  );
  manuscript.addEventListener(
    "compositionend",
    (event) => {
      if (
        event.target instanceof HTMLElement &&
        event.target.matches(".prose")
      ) {
        composing = false;
        saveEditor();
      }
    },
    { signal: abort.signal },
  );
  manuscript.addEventListener(
    "input",
    (event) => {
      if (
        event.target instanceof HTMLElement &&
        event.target.matches(".prose") &&
        !(event instanceof InputEvent && event.isComposing)
      )
        saveEditor();
    },
    { signal: abort.signal },
  );
  manuscript.addEventListener(
    "beforeinput",
    (event) => {
      if (
        event.target instanceof HTMLElement &&
        event.target.closest(".prose") &&
        !editable()
      )
        event.preventDefault();
    },
    { signal: abort.signal },
  );
  document.addEventListener(
    "selectionchange",
    () => {
      cancelAnimationFrame(chromeFrame);
      chromeFrame = requestAnimationFrame(refreshSelection);
    },
    { signal: abort.signal },
  );
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.isComposing || event.keyCode === 229) return;
      const mod = event.metaKey || event.ctrlKey;
      if (dialog.open) {
        if (mod && ["s", "m", "h", "Enter"].includes(event.key))
          event.preventDefault();
        return;
      }
      if (mod && event.shiftKey && event.key.toLowerCase() === "m") {
        const anchor = captureSelection();
        if (anchor) {
          event.preventDefault();
          openSelection(anchor);
        }
      } else if (mod && event.shiftKey && event.key === "Enter") {
        event.preventDefault();
        const round = getView().round;
        if (
          !historical() &&
          (!round ||
            round.phase === "empty" ||
            (round.phase === "interrupted" && round.executionEnded)) &&
          getView().applyStatus?.phase !== "checking"
        )
          run(controller.generate());
      } else if (mod && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (!historical() && !saveButton.disabled) run(controller.apply());
      } else if (mod && event.shiftKey && event.key.toLowerCase() === "h") {
        event.preventDefault();
        if (historical()) closeHistory();
        else openHistory();
      } else if (event.key === "Escape") {
        if (reveal !== "closed") {
          setReveal("closed");
          brand.focus();
        } else if (state.input?.commentDraft) cancelComment();
        else if (noteId) {
          noteId = null;
          renderKey = "";
          render();
        } else if (historical()) closeHistory();
        else if (activeReview) setActiveReview(null);
      }
    },
    { signal: abort.signal },
  );
  brand.addEventListener("pointerdown", (event) => event.preventDefault(), {
    signal: abort.signal,
  });
  historyButton.addEventListener(
    "pointerdown",
    (event) => event.preventDefault(),
    { signal: abort.signal },
  );
  brand.addEventListener(
    "click",
    () => setReveal(reveal === "pinned" ? "closed" : "pinned"),
    { signal: abort.signal },
  );
  brand.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setReveal("pinned", true);
      }
    },
    { signal: abort.signal },
  );
  dock.addEventListener(
    "pointerenter",
    (event) => {
      clearTimeout(dockTimer);
      if (event.pointerType === "mouse" && reveal === "closed")
        setReveal("peek");
    },
    { signal: abort.signal },
  );
  dock.addEventListener(
    "pointerleave",
    () => {
      if (reveal === "peek")
        dockTimer = later(() => {
          if (!dock.contains(document.activeElement)) setReveal("closed");
        }, 180);
    },
    { signal: abort.signal },
  );
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (dialog.open) return;
      if (
        event.target instanceof Element &&
        !event.target.closest("#dock") &&
        reveal !== "closed"
      )
        setReveal("closed");
    },
    { signal: abort.signal },
  );
  generateButton.addEventListener("click", taskAction, {
    signal: abort.signal,
  });
  saveButton.addEventListener(
    "click",
    () => {
      setReveal("closed");
      run(controller.apply());
    },
    { signal: abort.signal },
  );
  historyButton.addEventListener(
    "click",
    () => (historical() ? closeHistory() : openHistory()),
    { signal: abort.signal },
  );
  id("history-close", HTMLButtonElement).addEventListener(
    "click",
    closeHistory,
    { signal: abort.signal },
  );
  id("history-adopt", HTMLButtonElement).addEventListener(
    "click",
    () => {
      if (state.viewedVersion !== null) requestAdopt(state.viewedVersion);
    },
    { signal: abort.signal },
  );
  cancelButton.addEventListener(
    "click",
    () => controller.dismissDestructive(),
    { signal: abort.signal },
  );
  confirmButton.addEventListener(
    "click",
    () => {
      const action = ticket?.action,
        draft = state.input?.commentDraft;
      run(
        controller.confirmDestructive(ticket).then((ok) => {
          if (!ok) return;
          if (action?.kind === "adopt") finishAdoption();
          else if (action?.kind === "discard-comment" && draft)
            restoreDraftEditor(draft);
        }),
      );
    },
    { signal: abort.signal },
  );
  dialog.addEventListener(
    "cancel",
    (event) => {
      event.preventDefault();
      controller.dismissDestructive();
    },
    { signal: abort.signal },
  );
  window.addEventListener(
    "resize",
    () => {
      positionBrand();
      scheduleGeometry();
      if (review()) positionReviewMarks();
    },
    { signal: abort.signal },
  );
  window.addEventListener(
    "scroll",
    () => {
      setReveal("closed");
      positionBrand();
      positionSelection();
      if (review()) positionReviewMarks();
    },
    { signal: abort.signal, passive: true },
  );
  const observer = new ResizeObserver(() => {
    scheduleGeometry();
    if (review()) positionReviewMarks();
  });
  observer.observe(manuscript);
  document.fonts.addEventListener("loadingdone", scheduleGeometry, {
    signal: abort.signal,
  });
  const unsubscribe = controller.subscribe(render);
  render();
  return () => {
    unsubscribe();
    cancelReviewMotion();
    abort.abort();
    observer.disconnect();
    ruler.destroy();
    controller.dispose();
    cancelAnimationFrame(geometryFrame);
    cancelAnimationFrame(chromeFrame);
    for (const timer of timers) clearTimeout(timer);
    document.body.classList.remove("history-open");
    if (dialog.open) dialog.close();
    root.replaceChildren();
  };
}
