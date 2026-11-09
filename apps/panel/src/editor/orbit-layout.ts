export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
type OrbitName = "ai" | "version" | "apply";
const size = 44;
const gap = 60;
const inset = 4;
const rect = (x: number, y: number, width = size) => ({
  x,
  y,
  width,
  height: size,
});

export function orbitLayout({
  anchor,
  article,
  viewport,
  placement,
}: {
  anchor: { x: number; y: number };
  article: { right: number };
  viewport: { width: number; height: number };
  placement: string;
}) {
  const clampX = (x: number, width = size) =>
    Math.max(inset, Math.min(viewport.width - width - inset, x));
  const clampY = (y: number) =>
    Math.max(inset, Math.min(viewport.height - size - inset, y));
  const arc = {
    ai: rect(anchor.x - 44, anchor.y - 62),
    version: rect(anchor.x - 44, anchor.y + 62),
    apply: rect(anchor.x - 104, anchor.y),
  };
  const clear = Object.values(arc).every(
    (r) =>
      r.x >= article.right + inset &&
      r.x >= inset &&
      r.x + size <= viewport.width - inset &&
      r.y >= inset &&
      r.y + size <= viewport.height - inset,
  );
  const mode = placement === "header" ? "header" : clear ? "arc" : "rail";
  let slots: Record<OrbitName, Rect>;
  if (mode === "header") {
    slots = Object.fromEntries(
      (["ai", "version", "apply"] as const).map((name, index) => [
        name,
        rect(clampX(anchor.x - gap * (index + 1)), clampY(anchor.y)),
      ]),
    ) as Record<OrbitName, Rect>;
  } else if (mode === "arc") slots = arc;
  else {
    const x = clampX(Math.max(anchor.x, article.right + 8));
    const pitch = Math.min(
      gap,
      Math.floor((viewport.height - size - inset * 2) / 4),
    );
    const occupied = [anchor.y];
    slots = { ...arc };
    for (const [name, preferred] of [
      ["ai", -1],
      ["version", 1],
      ["apply", 2],
    ] as const) {
      const candidates = [preferred, -1, 1, -2, 2, -3, 3, -4, 4].map(
        (step) => anchor.y + step * pitch,
      );
      const y = candidates.find(
        (y) =>
          y >= inset &&
          y + size <= viewport.height - inset &&
          occupied.every((other) => Math.abs(y - other) >= size + 8),
      );
      if (y === undefined)
        throw new RangeError("Viewport cannot fit the orbit rail");
      slots[name] = rect(x, y);
      occupied.push(slots[name].y);
    }
  }
  const all = [rect(anchor.x, anchor.y), ...Object.values(slots)];
  const bounds = {
    x: Math.min(...all.map((r) => r.x)),
    y: Math.min(...all.map((r) => r.y)),
    right: Math.max(...all.map((r) => r.x + r.width)),
    bottom: Math.max(...all.map((r) => r.y + r.height)),
  };
  return { mode, slots, corridor: bounds };
}
