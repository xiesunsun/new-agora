export interface RulerVersion {
  id: string;
  number: number;
  text: string;
  time: string | null;
  parentVersionId: string | null;
  previousSavedHeadId?: string | null;
}
interface RulerInput {
  versions: RulerVersion[];
  selectedId?: string | null;
  savedHeadId?: string | null;
  enabled: boolean;
  reducedMotion?: boolean;
}
interface Gesture {
  id: number;
  x: number;
  y: number;
  last: number;
  time: number;
  velocity: number;
  moved: boolean;
  type: string;
}
const mod = (value: number, count: number) => ((value % count) + count) % count;
export function rulerSlots(
  position: number,
  count: number,
  width: number,
  pitch: number,
) {
  if (!count) return [];
  if (count === 1) return [{ slot: 0, index: 0, x: width / 2, distance: 0 }];
  const radius = Math.ceil(width / pitch / 2) + 2;
  const center = Math.round(position);
  return Array.from({ length: radius * 2 + 1 }, (_, offset) => {
    const slot = center - radius + offset;
    return {
      slot,
      index: mod(slot, count),
      x: width / 2 + (slot - position) * pitch,
      distance: Math.abs(slot - position),
    };
  });
}
export function createHistoryRuler({
  viewport,
  strip,
  onSelect,
  onSettle = () => {},
  clock = window,
}: {
  viewport: HTMLElement;
  strip: HTMLElement;
  onSelect: (id: string) => void;
  onSettle?: (id: string | null) => void;
  clock?: Window;
}) {
  const doc = viewport.ownerDocument;
  const semantics = doc.createElement("div");
  semantics.className = "history-live";
  strip.after(semantics);
  viewport.tabIndex = 0;
  viewport.setAttribute("role", "listbox");
  viewport.setAttribute("aria-label", "已保存版本");
  let versions: RulerVersion[] = [];
  let selectedId: string | null = null,
    position = 0,
    pitch = 214,
    enabled = false,
    reduced = false;
  let frame: number | null = null,
    quiet: number | null = null,
    clickTimer: number | undefined;
  let gesture: Gesture | null = null,
    destroyed = false,
    suppressClick = false;
  let width = 0,
    target: number | null = null,
    signature = "",
    selectedHeadId: string | null = null;
  const slots = new Map<number, HTMLElement>(),
    options = new Map<string, HTMLElement>(),
    listeners: (() => void)[] = [];
  const listen = <K extends keyof HTMLElementEventMap>(
    name: K,
    run: (event: HTMLElementEventMap[K]) => void,
    config?: AddEventListenerOptions,
  ) => {
    viewport.addEventListener(name, run, config);
    listeners.push(() => viewport.removeEventListener(name, run, config));
  };
  const cancelMotion = () => {
    if (frame !== null) clock.cancelAnimationFrame(frame);
    if (quiet !== null) clock.clearTimeout(quiet);
    frame = quiet = target = null;
  };
  const cancel = () => {
    cancelMotion();
    const pointer = gesture?.id;
    gesture = null;
    if (pointer !== undefined && viewport.hasPointerCapture?.(pointer))
      viewport.releasePointerCapture(pointer);
    suppressClick = false;
    clock.clearTimeout(clickTimer);
    clickTimer = undefined;
  };
  function description(version: RulerVersion, headId?: string | null) {
    const date =
      version.time === null || version.time === undefined
        ? null
        : new Date(version.time);
    const time =
      date && Number.isFinite(date.getTime())
        ? date.toLocaleString("zh-CN", { hour12: false })
        : "时间未记录";
    const parent = versions.find(
      (value) => value.id === version.parentVersionId,
    );
    const previous = versions.find(
      (value) => value.id === version.previousSavedHeadId,
    );
    const origin = parent ? `基于 V${parent.number}` : "来源未记录";
    return `V${version.number} · ${time} · ${origin}${previous ? ` · 前一次原文件 V${previous.number}` : ""}${version.id === headId ? " · 最新已保存" : ""}`;
  }
  function paint(select = true) {
    if (!enabled || destroyed || !versions.length) return;
    width = viewport.clientWidth;
    pitch =
      Number.parseFloat(
        clock.getComputedStyle?.(viewport).getPropertyValue("--ruler-pitch"),
      ) || 214;
    if (Math.abs(position) > 100000)
      position -= Math.trunc(position / versions.length) * versions.length;
    const current = versions[mod(Math.round(position), versions.length)];
    viewport.style.setProperty("--ruler-offset", `${-position * pitch}px`);
    viewport.dataset.position = String(position);
    viewport.setAttribute("aria-activedescendant", options.get(current.id)!.id);
    for (const version of versions)
      options
        .get(version.id)!
        .setAttribute("aria-selected", String(version.id === current.id));
    const retained = new Set();
    for (const item of rulerSlots(position, versions.length, width, pitch)) {
      retained.add(item.slot);
      let page = slots.get(item.slot);
      const version = versions[item.index];
      if (!page || page.dataset.versionId !== version.id) {
        page?.remove();
        page = doc.createElement("div");
        page.className = "frame";
        page.dataset.slot = String(item.slot);
        page.dataset.versionId = version.id;
        page.setAttribute("aria-hidden", "true");
        page.title = description(version, selectedHeadId);
        const thumb = doc.createElement("span");
        thumb.className = "thumb";
        const title = doc.createElement("span");
        title.className = "thumb-title";
        const body = doc.createElement("span");
        body.className = "thumb-body";
        const lines = version.text
          .replace(/^#{1,6} /gm, "")
          .trim()
          .split("\n");
        title.textContent = lines.shift() ?? "";
        body.textContent = lines.join("\n").trim().slice(0, 520);
        thumb.append(title, body);
        const caption = doc.createElement("span");
        caption.className = "frame-caption";
        const number = doc.createElement("b");
        number.textContent = `V${version.number}`;
        const time = doc.createElement("time");
        time.className = "frame-time";
        const date =
          version.time === null || version.time === undefined
            ? null
            : new Date(version.time);
        time.textContent =
          date && Number.isFinite(date.getTime())
            ? date.toLocaleTimeString("zh-CN", {
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
              })
            : "时间未记录";
        if (date && Number.isFinite(date.getTime())) {
          time.dateTime = date.toISOString();
          time.title = date.toLocaleString("zh-CN");
        }
        caption.append(number, time);
        page.append(thumb, caption);
        strip.append(page);
        slots.set(item.slot, page);
      }
      page.style.left = `${item.x}px`;
      page.style.setProperty(
        "--page-nearness",
        String(Math.max(0, 1 - item.distance)),
      );
      page.setAttribute(
        "aria-pressed",
        String(item.slot === Math.round(position)),
      );
    }
    for (const [key, page] of slots)
      if (!retained.has(key)) {
        page.remove();
        slots.delete(key);
      }
    if (select && current.id !== selectedId) {
      selectedId = current.id;
      onSelect(current.id);
    }
  }
  function settle(destination = Math.round(position)) {
    cancelMotion();
    if (!enabled || destroyed) return;
    target = destination;
    if (reduced) {
      position = destination;
      target = null;
      paint();
      onSettle(selectedId);
      return;
    }
    let previous: number | null = null;
    const tick = (time: number) => {
      frame = null;
      if (!enabled || destroyed || target === null) return;
      const elapsed = previous === null ? 16 : Math.min(50, time - previous);
      previous = time;
      position += (target - position) * (1 - Math.exp(-elapsed / 65));
      if (Math.abs(target - position) < 0.002) {
        position = target;
        target = null;
        paint();
        onSettle(selectedId);
        return;
      }
      paint();
      if (enabled && !destroyed && target !== null)
        frame = clock.requestAnimationFrame(tick);
    };
    frame = clock.requestAnimationFrame(tick);
  }
  listen(
    "wheel",
    (event) => {
      if (
        !enabled ||
        destroyed ||
        versions.length < 2 ||
        !event.cancelable ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        ![0, 1, 2].includes(event.deltaMode) ||
        !Number.isFinite(event.deltaX) ||
        !Number.isFinite(event.deltaY)
      )
        return;
      const delta =
        Math.abs(event.deltaX) > Math.abs(event.deltaY)
          ? event.deltaX
          : event.deltaY;
      if (!delta) return;
      event.preventDefault();
      cancelMotion();
      const unit =
        event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? viewport.clientHeight
            : 1;
      position += (delta * unit) / pitch;
      paint();
      quiet = clock.setTimeout(() => {
        quiet = null;
        settle();
      }, 110);
    },
    { passive: false },
  );
  listen("pointerdown", (event) => {
    if (
      !enabled ||
      destroyed ||
      versions.length < 2 ||
      event.button !== 0 ||
      event.isPrimary === false
    )
      return;
    cancelMotion();
    suppressClick = false;
    clock.clearTimeout(clickTimer);
    clickTimer = undefined;
    gesture = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      last: event.clientX,
      time: event.timeStamp,
      velocity: 0,
      moved: false,
      type: event.pointerType,
    };
  });
  listen("pointermove", (event) => {
    if (!enabled || !gesture || gesture.id !== event.pointerId) return;
    const dx = event.clientX - gesture.x,
      dy = event.clientY - gesture.y;
    if (!gesture.moved) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 8) return;
      if (Math.abs(dy) > Math.abs(dx)) {
        cancel();
        return;
      }
      gesture.moved = true;
      viewport.setPointerCapture(event.pointerId);
    }
    event.preventDefault();
    const elapsed = Math.max(1, event.timeStamp - gesture.time);
    gesture.velocity = (gesture.last - event.clientX) / pitch / elapsed;
    position += (gesture.last - event.clientX) / pitch;
    gesture.last = event.clientX;
    gesture.time = event.timeStamp;
    paint();
  });
  listen("pointerup", (event) => {
    if (!gesture || gesture.id !== event.pointerId) return;
    const ended = gesture;
    gesture = null;
    if (viewport.hasPointerCapture?.(event.pointerId))
      viewport.releasePointerCapture(event.pointerId);
    if (!ended.moved || !enabled) return;
    suppressClick = true;
    clock.clearTimeout(clickTimer);
    clickTimer = clock.setTimeout(() => {
      suppressClick = false;
    }, 400);
    const travel =
      !reduced && ended.type === "touch" && event.timeStamp - ended.time < 80
        ? Math.max(-1.5, Math.min(1.5, ended.velocity * 120))
        : 0;
    settle(Math.round(position + travel));
  });
  for (const name of ["pointercancel", "lostpointercapture"] as const)
    listen(name, () => {
      if (!gesture) return;
      const moved = gesture.moved;
      cancel();
      if (moved) {
        suppressClick = true;
        clickTimer = clock.setTimeout(() => {
          suppressClick = false;
        }, 400);
      }
    });
  listen("click", (event) => {
    if (suppressClick) {
      suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (!enabled || destroyed || gesture?.moved) return;
    const page =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-slot]")
        : null;
    if (page && strip.contains(page)) settle(Number(page.dataset.slot));
  });
  listen("keydown", (event) => {
    if (
      !enabled ||
      destroyed ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      !versions.length
    )
      return;
    const current = Math.round(position),
      index = mod(current, versions.length);
    const next =
      event.key === "ArrowRight"
        ? current + 1
        : event.key === "ArrowLeft"
          ? current - 1
          : event.key === "Home"
            ? current - index
            : event.key === "End"
              ? current + versions.length - 1 - index
              : null;
    if (next === null) return;
    event.preventDefault();
    settle(versions.length === 1 ? 0 : next);
  });
  listen("blur", cancel);
  return {
    update(input: RulerInput) {
      if (destroyed) return;
      const nextSignature = input.versions
        .map((version) => version.id)
        .join("|");
      const changed = signature !== nextSignature;
      const wasEnabled = enabled;
      selectedHeadId = input.savedHeadId ?? null;
      enabled = Boolean(input.enabled);
      reduced = Boolean(input.reducedMotion);
      if (!enabled) {
        cancel();
        return;
      }
      if (changed) {
        cancel();
        versions = input.versions;
        signature = nextSignature;
        for (const option of options.values()) option.remove();
        options.clear();
        for (const version of versions) {
          const option = doc.createElement("div");
          option.id = `history-option-${encodeURIComponent(version.id)}`;
          option.setAttribute("role", "option");
          option.textContent = description(version, input.savedHeadId);
          semantics.append(option);
          options.set(version.id, option);
        }
        for (const page of slots.values()) page.remove();
        slots.clear();
      }
      if (changed || !wasEnabled || selectedId !== input.selectedId) {
        cancelMotion();
        const index = versions.findIndex(
          (version) => version.id === input.selectedId,
        );
        position =
          index < 0
            ? 0
            : index +
              Math.round((position - index) / versions.length) *
                versions.length;
        selectedId = input.selectedId ?? null;
      }
      paint(false);
    },
    cancel,
    destroy() {
      cancel();
      destroyed = true;
      enabled = false;
      for (const remove of listeners) remove();
      semantics.remove();
      for (const page of slots.values()) page.remove();
      slots.clear();
    },
  };
}
