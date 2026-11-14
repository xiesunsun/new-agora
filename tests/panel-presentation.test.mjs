import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { register } from "node:module";
register("./panel-loader.mjs", import.meta.url);
const { reviewDocument } =
  await import("../apps/panel/src/editor/review-document.js");
const { manuscriptBlocks: parts } =
  await import("../apps/panel/src/editor/markdown-syntax.js");
const { reviewRuns } = await import("../apps/panel/src/editor/review-runs.js");
const { orbitLayout } =
  await import("../apps/panel/src/editor/orbit-layout.js");
const { rulerSlots } =
  await import("../apps/panel/src/editor/history-ruler.js");
const { choosePenPosition } =
  await import("../apps/panel/src/editor/pen-placement.js");

test("settled inline reading contains each selected sentence once and readback does not mutate choices", () => {
  /** @type {import('../apps/panel/src/editor/review-document.js').ReviewProjectionInput} */
  const review = {
    base: "甲句。乙句。",
    candidate: "甲新句。乙新句。",
    changes: [
      { id: "a", start: 0, end: 3, before: "甲句。", after: "甲新句。" },
      { id: "b", start: 3, end: 6, before: "乙句。", after: "乙新句。" },
    ],
    choices: { a: "keep", b: "discard" },
  };
  /** @type {import('../apps/panel/src/editor/review-document.js').ReviewProjectionInput} */ const input =
    review;
  const output = reviewDocument(input);
  let text = "";
  for (const block of output.blocks) {
    if (block.tag !== "paragraph") throw Error("expected paragraph");
    for (const part of block.parts) {
      if (part.tag === "context") text += part.visible;
      else if (part.tag === "settled")
        text += part.blocks
          .flatMap((block) => block.runs.map((run) => run.text))
          .join("");
      else throw Error("unexpected comparison");
    }
  }
  equal(text, "甲新句。乙句。");
  const before = structuredClone(input);
  const opened = reviewDocument(input, { openedId: "a" });
  ok(
    opened.blocks.some(
      (block) =>
        block.tag === "paragraph" &&
        block.parts.some(
          (part) => part.tag === "comparison" && part.readbackId === "a",
        ),
    ),
  );
  deepEqual(input, before);
});
test("presentation keeps raw block positions and Unicode review runs exact", () => {
  const source = "\uFEFF# 标题\r\n\r\n🙂空白  \r\n";
  const blocks = parts(source);
  let reconstructed = "",
    cursor = 0;
  for (const block of blocks) {
    equal(block.raw, source.slice(block.from, block.end));
    reconstructed += source.slice(cursor, block.from) + block.raw;
    cursor = block.end;
  }
  reconstructed += source.slice(cursor);
  equal(reconstructed, source);
  const runs = reviewRuns("🙂原句。", "🙂新句。");
  equal(
    runs
      .filter((run) => run.kind !== "insert")
      .map((run) => run.text)
      .join(""),
    "🙂原句。",
  );
  equal(
    runs
      .filter((run) => run.kind !== "delete")
      .map((run) => run.text)
      .join(""),
    "🙂新句。",
  );
});
test("the ruler wraps through the last version using bounded visual slots", () => {
  const slots = rulerSlots(1000.5, 3, 390, 214);
  ok(slots.length < 10);
  deepEqual(
    slots.map((slot) => slot.index),
    slots.map((slot) => ((slot.slot % 3) + 3) % 3),
  );
  ok(slots.every((slot) => Number.isFinite(slot.x)));
  deepEqual(rulerSlots(0, 1, 390, 214), [
    { slot: 0, index: 0, x: 195, distance: 0 },
  ]);
});
test("the orbit uses 44 pixel controls and a pen never returns a colliding placement", () => {
  for (const width of [390, 760, 1280]) {
    const layout = orbitLayout({
      anchor: { x: width - 48, y: 300 },
      article: { right: width - 100 },
      viewport: { width, height: 900 },
      placement: "side",
    });
    for (const slot of Object.values(layout.slots)) {
      equal(slot.width, 44);
      equal(slot.height, 44);
      ok(slot.x >= 4 && slot.x + 44 <= width - 4);
      ok(slot.y >= 4 && slot.y + 44 <= 896);
    }
  }
  const result = choosePenPosition(
    [{ left: 30, right: 200, top: 100, bottom: 125 }],
    [{ left: 30, right: 200, top: 100, bottom: 125 }],
    [],
    { left: 30, right: 200, top: 100, bottom: 200 },
    { width: 390, height: 900 },
  );
  ok(result);
  ok(
    result.bottom <= 97 ||
      result.top >= 128 ||
      result.left >= 203 ||
      result.right <= 27,
  );
});

test("textarea mapping retains raw UTF-16 boundaries and unchanged separators across separate edits", async () => {
  const { textareaText, editorOffset, editExactText } =
    await import("../apps/panel/src/editor/exact-text.js");
  const raw = "\uFEFF甲\r\n🙂\r乙\n丙";
  deepEqual(textareaText(raw), {
    value: "\uFEFF甲\n🙂\n乙\n丙",
    sourceOffsets: [0, 1, 2, 4, 5, 6, 7, 8, 9, 10],
  });
  equal(editorOffset(raw, 7), 6);
  equal(editorOffset(raw, 6), 5);
  equal(editExactText(raw, "\uFEFF改\n🙂\n乙\n尾"), "\uFEFF改\r\n🙂\r乙\n尾");
  equal(
    editExactText(raw, "\uFEFF甲\n🙂\n乙\n丙\n新行"),
    "\uFEFF甲\r\n🙂\r乙\n丙\r\n新行",
  );
  equal(editExactText(raw, "\uFEFF甲\n🙂\n乙\n丙"), raw);
});
