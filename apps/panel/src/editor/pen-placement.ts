export interface Bounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}
export function choosePenPosition(
  selectionRects: Bounds[],
  proseRects: Bounds[],
  blockedRects: Bounds[],
  textBounds: { left: number; right: number; top?: number; bottom?: number },
  viewport: { width: number; height: number },
) {
  const size = 44;
  const inset = 8;
  const inflate = (rect: Bounds) => ({
    left: rect.left - 3,
    top: rect.top - 3,
    right: rect.right + 3,
    bottom: rect.bottom + 3,
  });
  const obstacles = [...proseRects, ...blockedRects].map(inflate);
  const overlaps = (a: Bounds, b: Bounds) =>
    a.left < b.right &&
    a.right > b.left &&
    a.top < b.bottom &&
    a.bottom > b.top;
  const first = selectionRects[0],
    last = selectionRects.at(-1);
  if (
    !first ||
    !last ||
    viewport.width < size + inset * 2 ||
    viewport.height < size + inset * 2
  )
    return null;
  const candidates: Bounds[] = [];
  const add = (left: number, top: number) => {
    left = Math.max(inset, Math.min(viewport.width - inset - size, left));
    top = Math.max(inset, Math.min(viewport.height - inset - size, top));
    const rect = { left, top, right: left + size, bottom: top + size };
    if (
      textBounds.top !== undefined &&
      textBounds.bottom !== undefined &&
      (top + size < textBounds.top || top > textBounds.bottom)
    )
      return;
    if (!obstacles.some((obstacle) => overlaps(rect, obstacle)))
      candidates.push(rect);
  };
  for (const rect of selectionRects) {
    add(rect.right - size, rect.top - size - 6);
    add(rect.right - size, rect.bottom + 6);
    add(textBounds.right + 6, rect.top - 6);
    add(textBounds.left - size - 6, rect.top - 6);
  }
  candidates.sort(
    (a, b) =>
      Math.hypot(
        a.left + size / 2 - last.right,
        a.top + size / 2 - last.bottom,
      ) -
      Math.hypot(
        b.left + size / 2 - last.right,
        b.top + size / 2 - last.bottom,
      ),
  );
  return candidates[0] ?? null;
}
