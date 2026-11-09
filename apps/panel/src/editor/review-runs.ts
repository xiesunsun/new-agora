export interface ReviewRun {
  kind: "equal" | "delete" | "insert";
  text: string;
}
export function reviewRuns(before: string, after: string): ReviewRun[] {
  const runs: ReviewRun[] = [];
  let cellsLeft = 750000;
  const append = (kind: ReviewRun["kind"], tokens: string[]) => {
    const text = tokens.join("");
    if (!text) return;
    const previous = runs.at(-1);
    if (previous?.kind === kind) previous.text += text;
    else runs.push({ kind, text });
  };
  function compare(left: string[], right: string[], depth = 0) {
    let start = 0;
    while (
      start < left.length &&
      start < right.length &&
      left[start] === right[start]
    )
      start++;
    append("equal", left.slice(0, start));
    left = left.slice(start);
    right = right.slice(start);
    let tail = 0;
    while (
      tail < left.length &&
      tail < right.length &&
      left.at(-tail - 1) === right.at(-tail - 1)
    )
      tail++;
    const suffix = tail ? left.slice(-tail) : [];
    if (tail) {
      left = left.slice(0, -tail);
      right = right.slice(0, -tail);
    }
    const cells = (left.length + 1) * (right.length + 1);
    if (!left.length || !right.length) {
      append("delete", left);
      append("insert", right);
    } else if (cells <= cellsLeft) {
      cellsLeft -= cells;
      const width = right.length + 1;
      const lengths = new Uint32Array(cells);
      for (let a = left.length - 1; a >= 0; a--) {
        for (let b = right.length - 1; b >= 0; b--) {
          lengths[a * width + b] =
            left[a] === right[b]
              ? lengths[(a + 1) * width + b + 1] + 1
              : Math.max(
                  lengths[(a + 1) * width + b],
                  lengths[a * width + b + 1],
                );
        }
      }
      let a = 0,
        b = 0;
      while (a < left.length || b < right.length) {
        if (a < left.length && b < right.length && left[a] === right[b]) {
          append("equal", [left[a++]]);
          b++;
        } else if (
          a < left.length &&
          (b === right.length ||
            lengths[(a + 1) * width + b] >= lengths[a * width + b + 1])
        )
          append("delete", [left[a++]]);
        else append("insert", [right[b++]]);
      }
    } else {
      let anchor: { a: number; b: number } | null = null;
      if (depth < 20 && left.length >= 12 && right.length >= 12) {
        const positions = new Map<string, number>();
        for (let index = 0; index <= right.length - 12; index += 4) {
          const key = right.slice(index, index + 12).join("");
          if (!positions.has(key)) positions.set(key, index);
        }
        for (let probe = 0; probe < 33 && !anchor; probe++) {
          const fraction = probe === 0 ? 0.5 : probe / 32;
          const a = Math.floor((left.length - 12) * fraction);
          const b = positions.get(left.slice(a, a + 12).join(""));
          if (b !== undefined) anchor = { a, b };
        }
      }
      if (anchor) {
        compare(left.slice(0, anchor.a), right.slice(0, anchor.b), depth + 1);
        append("equal", left.slice(anchor.a, anchor.a + 12));
        compare(
          left.slice(anchor.a + 12),
          right.slice(anchor.b + 12),
          depth + 1,
        );
      } else {
        append("delete", left);
        append("insert", right);
      }
    }
    append("equal", suffix);
  }
  compare(Array.from(before), Array.from(after));
  return runs;
}
