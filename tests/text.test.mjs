import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { test } from "node:test";
import { register } from "node:module";

register("./text-loader.mjs", import.meta.url);
const text = await import("../packages/text/src/index.js");
const internal = await import("../packages/text/src/review.js");

test("review choices group whole titles and separate changed sentences", () => {
  const base = "# 旧标题。第二句\n\n旧首句。旧次句。稳定句。\n\n尾段。";
  const candidate = "# 新标题。另一句\n\n新首句。新次句。稳定句。\n\n尾段。";
  const units = text.reviewUnitsBetween(base, candidate);
  deepStrictEqual(
    units.map((unit) => [unit.before, unit.after]),
    [
      ["# 旧标题。第二句", "# 新标题。另一句"],
      ["旧首句。", "新首句。"],
      ["旧次句。", "新次句。"],
    ],
  );
  equal(
    text.applyChanges(base, units, ["1", "3"]),
    "# 新标题。另一句\n\n旧首句。新次句。稳定句。\n\n尾段。",
  );
  equal(text.applyChanges(base, units, []), base);
  equal(
    text.applyChanges(
      base,
      units,
      units.map((unit) => unit.id),
    ),
    candidate,
  );
});

test("review units preserve BOM, CRLF, emoji, spaces and paragraph additions", () => {
  const base = "\uFEFF# 旧😀标题\r\n\r\n第一句😀。  第二句。\r\n\r\n尾段\t ";
  const candidate =
    "\uFEFF# 新😀标题\r\n\r\n第一句😃。  第二句改写。\r\n\r\n尾段\t \r\n\r\n新增段落。";
  const units = text.reviewUnitsBetween(base, candidate);
  for (const unit of units)
    equal(base.slice(unit.start, unit.end), unit.before);
  equal(
    text.applyChanges(
      base,
      units,
      units.map((unit) => unit.id),
    ),
    candidate,
  );
  equal(text.applyChanges(base, units, []), base);
  const second = units.find((unit) => unit.before === "第二句。");
  ok(second);
  equal(
    text.applyChanges(base, units, [second.id]),
    "\uFEFF# 旧😀标题\r\n\r\n第一句😀。  第二句改写。\r\n\r\n尾段\t ",
  );
});

test("review exact reconstruction includes deletion, empty and whitespace changes", () => {
  for (const [base, candidate] of [
    ["", "新增"],
    ["删除", ""],
    ["相同", "相同"],
    ["甲  乙\n\n丙", "甲 乙\n\n\n丙"],
    ["# 标题\n正文。", "## 标题新\n正文改。"],
  ]) {
    const units = text.reviewUnitsBetween(base, candidate);
    equal(
      text.applyChanges(
        base,
        units,
        units.map((unit) => unit.id),
      ),
      candidate,
    );
    equal(text.applyChanges(base, units, []), base);
  }
});

test("comment anchors shift by UTF16 and refuse changed or ambiguous quotes", () => {
  const note = {
    id: "n",
    start: 3,
    end: 5,
    quote: "原文",
    resolved: true,
    focusOffset: 5,
  };
  deepStrictEqual(text.reanchorComments([note], "😀前原文后", "添😀前原文后"), [
    { ...note, start: 4, end: 6, focusOffset: 6 },
  ]);
  deepStrictEqual(text.reanchorComments([note], "😀前原文后", "😀前替换后"), [
    { ...note, resolved: false },
  ]);
  equal(note.start, 3);
  equal(
    text.reanchorComments(
      [{ ...note, resolved: false }],
      "😀前原文后",
      "添😀前原文后",
    )[0].resolved,
    false,
  );
  equal(
    text.reanchorComments([note], "😀前原文后", "原文与原文")[0].resolved,
    false,
  );
});

test("budget exhaustion returns an exact bounded whole-document choice", async () => {
  const base = "# 原标题\n\n第一句。第二句。";
  const candidate = "# 新标题\n\n第一句改。第二句改。";
  for (const budget of [
    { maxLength: 1 },
    { maxAtoms: 0 },
    { maxEditLength: 0 },
    { timeoutMs: 0 },
    {
      now: (() => {
        let tick = 0;
        return () => tick++ * 100;
      })(),
    },
  ]) {
    deepStrictEqual(internal.reviewUnitsWithinBudget(base, candidate, budget), [
      { id: "1", start: 0, end: base.length, before: base, after: candidate },
    ]);
  }
  const huge = "甲".repeat(100_001);
  deepStrictEqual(text.reviewUnitsBetween(huge, huge + "乙"), [
    { id: "1", start: 0, end: huge.length, before: huge, after: huge + "乙" },
  ]);
});

test("paragraph choices preserve independently kept changes and inserted blocks", () => {
  const base = "# 方案\n\n原首句。原次句。\n\n第二段保留。\n\n尾段删除。";
  const candidate = "# 方案\n\n新首句。原次句。\n\n第二段保留。\n\n新增段落。";
  const units = text.reviewUnitsBetween(base, candidate);
  equal(units.length, 2);
  equal(
    text.applyChanges(base, units, ["1"]),
    "# 方案\n\n新首句。原次句。\n\n第二段保留。\n\n尾段删除。",
  );
  equal(
    text.applyChanges(base, units, ["2"]),
    "# 方案\n\n原首句。原次句。\n\n第二段保留。\n\n新增段落。",
  );
  deepStrictEqual(
    Buffer.from(text.applyChanges(base, units, ["1", "2"]), "utf8"),
    Buffer.from(candidate, "utf8"),
  );
});

test("reanchoring repairs invalid legacy focus before moving an anchor left", () => {
  const note = {
    start: 7,
    end: 12,
    quote: "quote",
    resolved: true,
    focusOffset: 0,
  };
  const moved = text.reanchorComments(
    [note],
    "prefix quote suffix",
    "quote suffix",
  )[0];
  equal(moved.focusOffset, 5);
  equal(moved.start, 0);
  equal(moved.end, 5);
  equal(moved.resolved, true);
});
