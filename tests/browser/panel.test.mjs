import { deepEqual, equal, ok } from "node:assert/strict";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { createManagedRun } from "../../dev/runtime/src/index.mjs";
import { chromium } from "playwright";
import { startService } from "../support/service.mjs";
import { createFixture } from "../support/fixture.mjs";

const ownRun = process.env.AGORA_TEST_EVIDENCE_DIR
  ? undefined
  : await createManagedRun("test");
const evidenceDir =
  process.env.AGORA_TEST_EVIDENCE_DIR ?? join(ownRun?.root ?? "", "evidence");
after(async () => {
  await ownRun?.release();
});

/** @param {import('node:test').TestContext} context @param {string} [body] */
async function setup(context, body) {
  const resources = await createFixture(
    context,
    "agora-panel-browser-",
    ownRun?.root,
  );
  const { root } = resources;
  const document = join(root, "manuscript.md");
  if (body === undefined)
    await copyFile(
      new URL("../fixtures/a01/original.md", import.meta.url),
      document,
    );
  else await writeFile(document, body);
  const service = await startService(
    resources,
    document,
    join(root, "runtime"),
  );
  const browser = await chromium.launch();
  resources.after(() => browser.close());
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  /** @type {string[]} */ const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(service.url);
  await page.locator("#paper[data-mode]").waitFor();
  if (await page.locator(".manuscript-editor").count())
    await page
      .locator('.manuscript-editor[data-editor-state="ready"]')
      .waitFor();
  return { ...service, page, document, errors };
}
/** @param {import('playwright').Page} page @param {number} index @param {number} [length] */
async function selectProse(page, index, length = 8) {
  const blocks = page.locator(
    ".manuscript-editor .ProseMirror > :is(h1,h2,h3,h4,h5,h6,p), #manuscript > .block > .prose",
  );
  await blocks.nth(index).scrollIntoViewIfNeeded();
  await blocks.nth(index).evaluate((node, length) => {
    const native = node.closest(".ProseMirror");
    if (native instanceof HTMLElement) native.focus();
    const text = document
      .createTreeWalker(node, NodeFilter.SHOW_TEXT)
      .nextNode();
    if (!text) throw Error("empty source");
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, Math.min(length, text.textContent?.length ?? 0));
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, length);
  await page
    .getByRole("button", { name: "为选中文字写批注", exact: true })
    .waitFor({ state: "visible" });
}
/** @param {import('playwright').Page} page @param {string} name */
async function dockAction(page, name) {
  await page
    .getByRole("button", { name: "Agora · 打开文稿操作", exact: true })
    .click();
  await page.getByRole("button", { name, exact: true }).click();
}

/** @param {import('playwright').Page} page @param {string} scene */
async function captureScene(page, scene) {
  const original = page.viewportSize();
  const y = await page.evaluate(() => scrollY);
  await mkdir(evidenceDir, { recursive: true });
  for (const width of [1280, 760, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(40);
    if (
      scene === "orbit" &&
      (await page.locator("#brand").getAttribute("aria-expanded")) !== "true"
    )
      await page.locator("#brand").click();
    await page.screenshot({
      path: join(evidenceDir, `${scene}-${width}.png`),
      fullPage: true,
    });
  }
  if (original) await page.setViewportSize(original);
  await page.evaluate(
    (y) => window.scrollTo({ top: y, behavior: "instant" }),
    y,
  );
}

test("panel preserves note IME, geometry, settled readback, save and history through the built service", async (context) => {
  const {
    page,
    document: targetPath,
    request,
    errors,
  } = await setup(
    context,
    "# 交付计划\n\n项目安排\n\n周五完成初稿。周末复核材料。下周一交付。\n\n负责人会在会议后汇总意见。",
  );
  equal(
    await page.locator(".manuscript-editor .ProseMirror > h1").isEditable(),
    true,
  );
  await captureScene(page, "writing");
  await selectProse(page, 2, 7);
  for (const width of [1280, 760, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(80);
    const pen = page.getByRole("button", {
      name: "为选中文字写批注",
      exact: true,
    });
    await pen.waitFor({ state: "visible" });
    const geometry = await pen.evaluate((node) => {
      const pen = node.getBoundingClientRect();
      const obstacles = [...document.querySelectorAll(".prose")].flatMap(
        (node) => {
          const range = document.createRange();
          range.selectNodeContents(node);
          return [...range.getClientRects()];
        },
      );
      obstacles.push(
        ...[...document.querySelectorAll(".note-node,#dock button")]
          .filter((node) => node.getClientRects().length)
          .map((node) => node.getBoundingClientRect()),
      );
      return {
        width: pen.width,
        height: pen.height,
        clear: obstacles.every(
          (other) =>
            pen.left >= other.right ||
            pen.right <= other.left ||
            pen.top >= other.bottom ||
            pen.bottom <= other.top,
        ),
        overflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    ok(geometry.clear, `pen overlaps text at ${width}`);
    ok(geometry.width >= 44 && geometry.height >= 44);
    equal(geometry.overflow, false);
    await mkdir(evidenceDir, { recursive: true });
    await page.screenshot({
      path: join(evidenceDir, `pen-${width}.png`),
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page
    .getByRole("button", { name: "为选中文字写批注", exact: true })
    .click();
  const composer = page.getByRole("textbox", { name: "批注意见", exact: true });
  await composer.fill("把初稿提前到周四，保留交付日期");
  await captureScene(page, "composer");
  await composer.dispatchEvent("compositionstart");
  await composer.dispatchEvent("keydown", {
    key: "Enter",
    isComposing: true,
    keyCode: 229,
  });
  equal(await composer.isVisible(), true);
  await composer.dispatchEvent("compositionend");
  await composer.dispatchEvent("keydown", {
    key: "Enter",
    isComposing: true,
    keyCode: 229,
  });
  equal(await composer.isVisible(), true);
  equal((await request("/api/state")).comments.length, 0);
  await composer.dispatchEvent("keyup", { key: "Enter", isComposing: false });
  await composer.press("Enter");
  await composer
    .waitFor({ state: "detached", timeout: 3000 })
    .catch(async (error) => {
      throw new Error(
        `${error.message} UI notice ${await page.locator("#notice").textContent()} state ${JSON.stringify(await request("/api/state"))}`,
      );
    });
  await page.waitForFunction(() =>
    document.activeElement?.classList.contains("note-node"),
  );
  await page.evaluate(() => window.dispatchEvent(new Event("resize")));
  await page.waitForTimeout(80);
  equal(
    await page.evaluate(() =>
      document.activeElement?.classList.contains("note-node"),
    ),
    true,
  );
  await page.locator(".note-node").click();
  await captureScene(page, "peek");
  await page.getByRole("button", { name: "删除这条批注", exact: true }).click();
  equal(
    await page
      .getByRole("button", { name: "继续编辑", exact: true })
      .evaluate((node) => node === document.activeElement),
    true,
  );
  await captureScene(page, "delete-dialog");
  await page.getByRole("button", { name: "继续编辑", exact: true }).click();
  equal(await page.locator(".note-peek").isVisible(), true);
  await page
    .getByRole("button", { name: "Agora · 打开文稿操作", exact: true })
    .click();
  await captureScene(page, "orbit");
  await page
    .getByRole("button", { name: "按本轮全部批注改稿", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector("#paper")?.getAttribute("data-mode") ===
      "generating",
  );
  await request("/api/worker", { action: "bind", threadId: "browser-test" });
  const claimed = await request("/api/worker", {
    action: "claim",
    threadId: "browser-test",
  });
  equal(claimed.status, "claimed");
  await writeFile(
    claimed.candidatePath,
    "# 交付方案\n\n项目安排\n\n周四完成初稿。周末复核材料。下周二交付。\n\n负责人会在会议后汇总意见。",
  );
  await request("/api/worker", {
    action: "submit",
    threadId: "browser-test",
    executionId: claimed.executionId,
  });
  await page
    .getByRole("button", { name: "接受第 1 处修改", exact: true })
    .waitFor();
  await page.screenshot({
    path: join(evidenceDir, "review.png"),
    fullPage: true,
  });
  await captureScene(page, "review");
  while (
    await page.locator('.review-decision[data-choice="pending"]').count()
  ) {
    const pending = page
      .locator('.review-decision[data-choice="pending"]')
      .first();
    const index = Number(await pending.getAttribute("data-review-index"));
    const accepts = page.getByRole("button", {
      name: `${index === 0 || index === 1 ? "接受" : "保留原文"}第 ${index + 1} 处修改`,
      exact: true,
    });
    if (!(await accepts.isVisible())) {
      const selector = page.getByRole("button", {
        name: `选择第 ${index + 1} 处修改操作`,
        exact: true,
      });
      if (await selector.count()) await selector.click();
    }
    await accepts.click();
    await page.waitForTimeout(80);
  }
  const before = await request("/api/state");
  await page.locator(".review-receipt-node").first().click();
  await page.getByLabel("原文", { exact: true }).first().waitFor();
  equal((await request("/api/state")).revision, before.revision);
  deepEqual(
    (await request("/api/state")).round.decisions,
    before.round.decisions,
  );
  await page.screenshot({
    path: join(evidenceDir, "readback.png"),
    fullPage: true,
  });
  await captureScene(page, "readback");
  await page.keyboard.press("Escape");
  await dockAction(page, "保存");
  await page.waitForFunction(() =>
    document
      .querySelector("#dock-state")
      ?.textContent?.includes("已写入原文件"),
  );
  const saved = await request("/api/state");
  equal(saved.versions.length, 2);
  equal(await readFile(targetPath, "utf8"), saved.versions[1].body);
  ok(saved.versions[1].body.includes("周四完成初稿"));
  ok(saved.versions[1].body.includes("下周一交付"));
  const editor = page.locator(".manuscript-editor .ProseMirror > h1");
  await editor.focus();
  await page.evaluate(() => {
    const first = document.querySelector(".ProseMirror > h1")?.firstChild,
      last = document.querySelectorAll(".ProseMirror > :is(h1,h2,p)")[2]
        ?.firstChild;
    if (!first || !last) throw Error("missing selection blocks");
    const range = document.createRange();
    range.setStart(first, 2);
    range.setEnd(last, 5);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
  });
  const selectionBefore = await page.evaluate(() => {
    const selection = window.getSelection();
    return {
      start: selection?.getRangeAt(0).startOffset,
      end: selection?.getRangeAt(0).endOffset,
      text: selection?.toString(),
    };
  });
  await dockAction(page, "查看版本轨迹 · 当前 V2");
  const versions = page.getByRole("listbox", {
    name: "已保存版本",
    exact: true,
  });
  await captureScene(page, "history");
  await versions.press("Home");
  await page.getByRole("button", { name: "返回工作稿", exact: true }).click();
  equal(
    await editor.evaluate(
      (node) =>
        node === document.activeElement ||
        node.closest(".ProseMirror") === document.activeElement,
    ),
    true,
  );
  const selectionAfter = await page.evaluate(() => {
    const selection = window.getSelection();
    return {
      start: selection?.getRangeAt(0).startOffset,
      end: selection?.getRangeAt(0).endOffset,
      text: selection?.toString(),
    };
  });
  deepEqual(
    selectionAfter,
    selectionBefore,
    "history restores both selection endpoints and selected text",
  );
  await dockAction(page, "查看版本轨迹 · 当前 V2");
  await versions.press("Home");
  await page.getByRole("button", { name: "从此版继续写", exact: true }).click();
  equal(
    await page
      .locator("#confirmation")
      .evaluate((node) => node instanceof HTMLDialogElement && node.open),
    false,
  );
  await page.waitForFunction(
    () => document.querySelector("#version-label")?.textContent === "V1",
  );
  await page
    .getByRole("button", { name: "Agora · 打开文稿操作", exact: true })
    .click();
  equal(
    await page.getByRole("button", { name: "保存", exact: true }).isVisible(),
    false,
  );
  equal((await request("/api/state")).versions.length, 2);
  equal(await readFile(targetPath, "utf8"), saved.versions[1].body);
  deepEqual(errors, []);
});

test("Markdown requirements render lists and inline formatting and annotate the exact repeated source", async (context) => {
  const original =
    "\uFEFF# 需求清单\r\n\r\n## 1. 项目目标\r\n\r\n第一处 **重复🙂内容**。\r\n\r\n- 前置 **重复🙂内容** 和 [项目链接](https://example.com/project) 完成。\r\n- 支持原文编辑。\r\n\r\n### 验收\r\n\r\n> 保留 `原始格式`。\r\n";
  const {
    page,
    request,
    document: targetPath,
    errors,
  } = await setup(context, original);
  equal(
    await page.getByRole("heading", { name: "需求清单", exact: true }).count(),
    1,
  );
  const manuscript = page.getByRole("textbox", {
    name: "工作稿正文",
    exact: true,
  });
  equal(await manuscript.locator("ul li").count(), 2);
  equal(await manuscript.locator("strong").count(), 2);
  equal(
    await page
      .getByRole("link", { name: "项目链接", exact: true })
      .getAttribute("href"),
    "https://example.com/project",
  );
  equal(
    await page.getByRole("heading", { name: "验收", exact: true }).count(),
    1,
  );
  equal(await page.locator("blockquote code").textContent(), "原始格式");
  equal(await page.locator(".exact-editor").count(), 0);
  await manuscript
    .locator("ul li")
    .first()
    .evaluate((node) => {
      const first = node.querySelector("strong")?.firstChild,
        last = node.querySelector("a")?.firstChild;
      if (!first || !last) throw Error("missing rendered inline content");
      {
        const native = document.querySelector(
          ".manuscript-editor .ProseMirror",
        );
        if (native instanceof HTMLElement) native.focus();
      }
      const range = document.createRange();
      range.setStart(first, 0);
      range.setEnd(last, last.textContent?.length ?? 0);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
  await page
    .getByRole("button", { name: "为选中文字写批注", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "批注意见", exact: true })
    .fill("只修改列表里的这一处");
  await page.getByRole("button", { name: "完成批注", exact: true }).click();
  await page
    .getByRole("textbox", { name: "批注意见", exact: true })
    .waitFor({ state: "detached" });
  await page.waitForTimeout(700);
  const state = await request("/api/state");
  const start = original.indexOf("重复🙂内容", original.indexOf("- 前置"));
  const end = original.indexOf("项目链接", start) + "项目链接".length;
  equal(state.comments.length, 1);
  deepEqual(
    {
      start: state.comments[0].start,
      end: state.comments[0].end,
      quote: state.comments[0].quote,
    },
    { start, end, quote: original.slice(start, end) },
  );
  equal(state.draft, original);
  equal(await readFile(targetPath, "utf8"), original);
  await page.reload();
  await page.getByRole("heading", { name: "需求清单", exact: true }).waitFor();
  await page.locator(".note-node").waitFor({ state: "visible" });
  equal(await page.locator(".note-node").count(), 1);
  deepEqual(errors, []);
});

test("Markdown mode recognizes setext headings, thematic breaks, strikethrough and entities", async (context) => {
  const { page, request, errors } = await setup(
    context,
    "Title\n=====\n\n---\n\nA &amp; B and ~~deleted~~.\n",
  );
  equal(
    await page.getByRole("heading", { name: "Title", exact: true }).count(),
    1,
  );
  equal(await page.locator("#manuscript hr").count(), 1);
  equal(await page.locator("#manuscript del").textContent(), "deleted");
  ok((await page.locator("#manuscript").textContent())?.includes("A & B"));
  equal((await request("/api/state")).versions.length, 1);
  deepEqual(errors, []);
});

for (const fence of ["~~~", "```"]) {
  test(`Markdown retains an unclosed code fence ending in ${fence}`, async (context) => {
    const opening = fence === "~~~" ? "```js" : "````js";
    const { page, errors } = await setup(
      context,
      `${opening}\nhello\n${fence}`,
    );
    equal(await page.locator("pre code").textContent(), `hello\n${fence}`);
    deepEqual(errors, []);
  });
}

test("Markdown resolves nested references and never activates raw HTML or dangerous links", async (context) => {
  const original =
    "# Links\n\n> [project]: https://example.com/project\n\n[项目][project] and [危险](javascript:alert%281%29).\n\n<script>window.markdownExecuted=true</script>\n";
  const { page, errors } = await setup(context, original);
  equal(
    await page
      .getByRole("link", { name: "项目", exact: true })
      .getAttribute("href"),
    "https://example.com/project",
  );
  equal(await page.getByRole("link", { name: "危险", exact: true }).count(), 0);
  equal(await page.locator("#manuscript script").count(), 0);
  equal(
    await page.evaluate(() => Reflect.get(window, "markdownExecuted")),
    undefined,
  );
  deepEqual(errors, []);
});

test("Markdown annotation maps escaped content after a repeated quote marker instead of the container syntax", async (context) => {
  const original = "> a\n> \\> a";
  const { page, request, errors } = await setup(context, original);
  await page.locator("blockquote p").evaluate((node) => {
    const native = node.closest(".ProseMirror");
    if (native instanceof HTMLElement) native.focus();
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    let text = walker.nextNode();
    while (text && !text.textContent?.includes(">")) text = walker.nextNode();
    if (!text) throw Error("missing quoted text");
    const start = text.textContent?.indexOf(">") ?? -1;
    if (start < 0) throw Error("missing escaped marker");
    const range = document.createRange();
    range.setStart(text, start);
    range.setEnd(text, start + 1);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await page
    .getByRole("button", { name: "为选中文字写批注", exact: true })
    .click();
  const composer = page.getByRole("textbox", { name: "批注意见", exact: true });
  await composer.waitFor();
  await page.waitForTimeout(700);
  const note = (await request("/api/state")).commentDraft,
    start = original.indexOf("\\>");
  deepEqual(
    { start: note.start, end: note.end, quote: note.quote },
    { start, end: start + 2, quote: "\\>" },
  );
  await composer.press("Escape");
  deepEqual(errors, []);
});

test("Markdown annotations preserve exact entities, escapes, code and table-cell UTF-16 source ranges", async (context) => {
  const original =
    "# Mapping\r\n\r\nA &amp; B and \\*literal\\*.\r\n\r\n` a  b `\r\n\r\n```js\r\nconst x = 1;\r\n```\r\n\r\n| 名称 | 内容 |\r\n| --- | --- |\r\n| 项目 | 🙂&amp; |\r\n";
  const { page, request, errors } = await setup(context, original);
  for (const item of [
    {
      selector:
        ".manuscript-editor .ProseMirror > p, .markdown-document > .block p",
      visible: "&",
      source: "&amp;",
    },
    {
      selector:
        ".manuscript-editor .ProseMirror > p, .markdown-document > .block p",
      visible: "*literal*",
      source: "\\*literal\\*",
    },
    { selector: "p code", visible: "a  b", source: "a  b" },
    { selector: "pre code", visible: "const x", source: "const x" },
    { selector: "td:last-child p", visible: "🙂&", source: "🙂&amp;" },
  ]) {
    const target = page
      .locator(item.selector)
      .filter({ hasText: item.visible })
      .first();
    await target.scrollIntoViewIfNeeded();
    await target.evaluate((node, visible) => {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const text = walker.currentNode,
          start = text.textContent?.indexOf(visible) ?? -1;
        if (start < 0) continue;
        {
          const native = document.querySelector(
            ".manuscript-editor .ProseMirror",
          );
          if (native instanceof HTMLElement) native.focus();
        }
        const range = document.createRange();
        range.setStart(text, start);
        range.setEnd(text, start + visible.length);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        return;
      }
      throw Error("missing rendered selection");
    }, item.visible);
    await page
      .getByRole("button", { name: "为选中文字写批注", exact: true })
      .click({ timeout: 3000 })
      .catch(async (error) => {
        throw new Error(
          `Cannot annotate ${JSON.stringify(item.source)}: ${error.message}`,
        );
      });
    const composer = page.getByRole("textbox", {
      name: "批注意见",
      exact: true,
    });
    await composer.waitFor();
    await page.waitForTimeout(700);
    const note = (await request("/api/state")).commentDraft,
      start = original.indexOf(item.source);
    deepEqual(
      { start: note.start, end: note.end, quote: note.quote },
      { start, end: start + item.source.length, quote: item.source },
    );
    await composer.press("Escape");
    await composer.waitFor({ state: "detached" });
  }
  equal((await request("/api/state")).draft, original);
  deepEqual(errors, []);
});

test("Markdown source view offers a clickable annotation action with raw UTF-16 offsets", async (context) => {
  const original =
    "\uFEFF# **标题**\r\n\r\n- 甲🙂\n- 乙\r\n\r\n<!-- 保留源码 -->";
  const { page, request, errors } = await setup(context, original);
  equal(
    await page.getByRole("button", { name: "编辑原文", exact: true }).count(),
    1,
  );
  await page.getByRole("button", { name: "编辑原文", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "工作稿正文", exact: true });
  await editor.evaluate((node) => {
    if (!(node instanceof HTMLTextAreaElement))
      throw Error("expected source editor");
    const start = node.value.indexOf("乙");
    node.focus();
    node.setSelectionRange(start, start + 1);
    node.dispatchEvent(new Event("select"));
  });
  await page
    .getByRole("button", { name: "为选中文字写批注", exact: true })
    .click();
  const composer = page.getByRole("textbox", { name: "批注意见", exact: true });
  await composer.waitFor();
  await page.waitForTimeout(700);
  const note = (await request("/api/state")).commentDraft;
  deepEqual(
    { start: note.start, end: note.end, quote: note.quote },
    {
      start: original.indexOf("乙"),
      end: original.indexOf("乙") + 1,
      quote: "乙",
    },
  );
  await composer.press("Escape");
  await composer.waitFor({ state: "detached" });
  await page.getByRole("button", { name: "返回文稿", exact: true }).click();
  equal(
    await page.getByRole("heading", { name: "标题", exact: true }).count(),
    1,
  );
  equal((await request("/api/state")).draft, original);
  deepEqual(errors, []);
});

test("unsupported Markdown edits retain BOM, CRLF and literal markup across autosave and apply", async (context) => {
  const original =
    "\uFEFF# **标题**\r\n\r\n- 一项\r\n- 二项\r\n<!-- 保留源码 -->\r\n";
  const {
    page,
    request,
    document: targetPath,
    errors,
  } = await setup(context, original);
  await page.getByRole("button", { name: "编辑原文", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "工作稿正文", exact: true });
  await editor.waitFor();
  ok(await editor.isEditable());
  await editor.focus();
  await editor.press("ControlOrMeta+End");
  await editor.press("ArrowLeft");
  await editor.press("!");
  await page.waitForTimeout(700);
  const draft = await request("/api/state");
  equal(draft.draft, original.slice(0, -2) + "!\r\n");
  equal(
    await editor.evaluate(
      (node) =>
        node === document.activeElement ||
        node.closest(".ProseMirror") === document.activeElement,
    ),
    true,
  );
  await dockAction(page, "保存");
  await page.waitForFunction(() =>
    document
      .querySelector("#dock-state")
      ?.textContent?.includes("已写入原文件"),
  );
  equal(await readFile(targetPath, "utf8"), draft.draft);
  deepEqual(errors, []);
});

test("grouped comments remain individually reachable and composer cancellation restores its source", async (context) => {
  const { page, request, errors } = await setup(
    context,
    "# 批注组\n\n同一行文字容纳两条不同意见。",
  );
  for (const instruction of ["第一条意见", "第二条意见"]) {
    await selectProse(page, 1, 5);
    await page
      .getByRole("button", { name: "为选中文字写批注", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "批注意见", exact: true })
      .fill(instruction);
    await page.getByRole("button", { name: "完成批注", exact: true }).click();
    await page
      .getByRole("textbox", { name: "批注意见", exact: true })
      .waitFor({ state: "detached" });
  }
  equal(await page.locator(".note-node").count(), 1);
  await page.locator(".note-node").focus();
  await dockAction(page, "查看版本轨迹 · 当前 V1");
  await page.getByRole("button", { name: "返回工作稿", exact: true }).click();
  equal(
    await page.evaluate(() =>
      document.activeElement?.classList.contains("note-node"),
    ),
    true,
    "history returns focus to the grouped note",
  );
  await page.locator(".note-node").click();
  equal(await page.locator(".note-preview-body").textContent(), "第二条意见");
  await page
    .getByRole("button", { name: "查看这条意见：第一条意见", exact: true })
    .click();
  equal(await page.locator(".note-preview-body").textContent(), "第一条意见");
  await page
    .getByRole("button", { name: "查看这条意见：第二条意见", exact: true })
    .click();
  await page.getByRole("button", { name: "修改这条批注", exact: true }).click();
  const composer = page.getByRole("textbox", { name: "批注意见", exact: true });
  await composer.fill("未提交的修改");
  await composer.press("Escape");
  await page.getByRole("button", { name: "继续编辑", exact: true }).click();
  equal(await composer.inputValue(), "未提交的修改");
  equal(
    await composer.evaluate((node) => node === document.activeElement),
    true,
  );
  await composer.press("Escape");
  await page.getByRole("button", { name: "放弃输入", exact: true }).click();
  await composer.waitFor({ state: "detached" });
  equal(
    await page
      .getByRole("textbox", { name: "工作稿正文", exact: true })
      .evaluate((node) => node === document.activeElement),
    true,
  );
  deepEqual(
    (await request("/api/state")).comments.map(
      /** @param {{instruction:string}} note */ (note) => note.instruction,
    ),
    ["第一条意见", "第二条意见"],
  );
  const title = page.locator(".manuscript-editor .ProseMirror > h1");
  await title.focus();
  await title.press("End");
  await page.keyboard.insertText("新");
  const offset = await page.evaluate(() => window.getSelection()?.focusOffset);
  await page.waitForTimeout(800);
  equal(
    await title.evaluate(
      (node) =>
        node === document.activeElement ||
        node.closest(".ProseMirror") === document.activeElement,
    ),
    true,
    "canonical comment reanchoring preserves the active editor",
  );
  equal(
    await page.evaluate(() => window.getSelection()?.focusOffset),
    offset,
    "canonical comment reanchoring preserves the caret",
  );
  deepEqual(errors, []);
});

test("discarding every suggestion ends review directly and preserves human edits and notes", async (context) => {
  const {
    page,
    request,
    document: targetPath,
    errors,
  } = await setup(context, "# 原标题\n\n周五完成初稿。");
  await page.locator(".manuscript-editor .ProseMirror > h1").fill("人类标题");
  await selectProse(page, 1, 7);
  await page
    .getByRole("button", { name: "为选中文字写批注", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "批注意见", exact: true })
    .fill("提前初稿");
  await page.getByRole("button", { name: "完成批注", exact: true }).click();
  await page
    .getByRole("textbox", { name: "批注意见", exact: true })
    .waitFor({ state: "detached" });
  await dockAction(page, "按本轮全部批注改稿");
  await page.waitForFunction(
    () =>
      document.querySelector("#paper")?.getAttribute("data-mode") ===
      "generating",
  );
  const waiting = await request("/api/state");
  await page.keyboard.press("ControlOrMeta+Shift+Enter");
  equal(
    await page
      .locator("#confirmation")
      .evaluate((node) => node instanceof HTMLDialogElement && node.open),
    false,
  );
  equal((await request("/api/state")).round.id, waiting.round.id);
  await request("/api/worker", { action: "bind", threadId: "discard-test" });
  const claimed = await request("/api/worker", {
    action: "claim",
    threadId: "discard-test",
  });
  await writeFile(claimed.candidatePath, "# 人类标题\n\n周四完成初稿。");
  await request("/api/worker", {
    action: "submit",
    threadId: "discard-test",
    executionId: claimed.executionId,
  });
  await page
    .getByRole("button", { name: "保留原文第 1 处修改", exact: true })
    .click();
  await page.locator(".review-receipt-node").waitFor();
  await dockAction(page, "结束审阅");
  await page.waitForFunction(
    () =>
      document.querySelector("#paper")?.getAttribute("data-mode") === "writing",
  );
  equal(
    await page
      .locator("#confirmation")
      .evaluate((node) => node instanceof HTMLDialogElement && node.open),
    false,
  );
  equal((await request("/api/state")).comments.length, 1);
  await dockAction(page, "保存");
  await page.waitForFunction(() =>
    document
      .querySelector("#dock-state")
      ?.textContent?.includes("已写入原文件"),
  );
  equal(await readFile(targetPath, "utf8"), "# 人类标题\n\n周五完成初稿。");
  equal((await request("/api/state")).comments.length, 1);
  deepEqual(errors, []);
});

test("editing after an ended cancellation starts a fresh generation from the edited draft", async (context) => {
  const { page, request, errors } = await setup(
    context,
    "# 生成恢复\n\n周五完成初稿。",
  );
  await selectProse(page, 1, 7);
  await page
    .getByRole("button", { name: "为选中文字写批注", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "批注意见", exact: true })
    .fill("提前初稿");
  await page.getByRole("button", { name: "完成批注", exact: true }).click();
  await page
    .getByRole("textbox", { name: "批注意见", exact: true })
    .waitFor({ state: "detached" });
  await dockAction(page, "按本轮全部批注改稿");
  await request("/api/worker", { action: "bind", threadId: "cancel-test" });
  const claimed = await request("/api/worker", {
    action: "claim",
    threadId: "cancel-test",
  });
  await page.waitForFunction(
    () => document.querySelector("#dock-state")?.textContent === "正在改稿",
  );
  await dockAction(page, "停止生成");
  await page.getByRole("button", { name: "停止生成", exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector("#paper")?.getAttribute("data-mode") === "writing",
  );
  await captureScene(page, "interrupted");
  await page
    .locator(".manuscript-editor .ProseMirror > h1")
    .fill("修改后的标题");
  await page.waitForTimeout(800);
  await writeFile(
    claimed.candidatePath,
    "# 不应发布的迟到稿\n\n周四完成初稿。",
  );
  await request("/api/worker", {
    action: "submit",
    threadId: "cancel-test",
    executionId: claimed.executionId,
  });
  await page.waitForTimeout(800);
  equal(
    await page.locator(".manuscript-editor .ProseMirror > h1").textContent(),
    "修改后的标题",
  );
  equal(await page.locator(".review-window").count(), 0);
  const before = await request("/api/state");
  equal(before.round.executionEnded, true);
  await dockAction(page, "重新生成");
  await page.waitForFunction(
    () =>
      document.querySelector("#paper")?.getAttribute("data-mode") ===
      "generating",
  );
  const after = await request("/api/state");
  ok(after.round.id !== before.round.id);
  equal(after.round.base, "# 修改后的标题\n\n周五完成初稿。");
  equal(after.round.phase, "waiting");
  deepEqual(errors, []);
});

test("normal-motion choice animates the committed block and reduced motion renders immediately", async (context) => {
  const { page, request } = await setup(
    context,
    "# 动效\n\n第一句原文。第二句原文。",
  );
  await request("/api/worker", { action: "bind", threadId: "motion-test" });
  const before = await request("/api/state");
  await request("/api/panel", {
    action: "generate",
    revision: before.revision,
    draft: before.draft,
    draftRevision: before.draftRevision,
    comments: [
      {
        id: "motion-note",
        start: 6,
        end: 12,
        quote: "第一句原文。",
        instruction: "改写两句",
        revision: 0,
        resolved: true,
        focusOffset: 12,
        direction: "forward",
      },
    ],
    commentDraft: null,
    requestId: "motion-round",
  });
  const claimed = await request("/api/worker", {
    action: "claim",
    threadId: "motion-test",
  });
  await writeFile(claimed.candidatePath, "# 动效\n\n第一句改稿。第二句改稿。");
  await request("/api/worker", {
    action: "submit",
    threadId: "motion-test",
    executionId: claimed.executionId,
  });
  await page
    .getByRole("button", { name: "接受第 1 处修改", exact: true })
    .waitFor();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page
    .getByRole("button", { name: "接受第 1 处修改", exact: true })
    .click();
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .some((animation) => animation.effect?.getTiming().duration === 160),
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page
    .getByRole("button", { name: "保留原文第 2 处修改", exact: true })
    .click();
  equal(
    await page.evaluate(
      () =>
        document
          .getAnimations()
          .filter(
            (animation) =>
              animation.playState === "running" &&
              animation.effect?.getTiming().duration === 160,
          ).length,
    ),
    0,
  );
  const after = await request("/api/state");
  equal(after.round.decisions[after.round.changes[0].id], "keep");
  equal(after.round.decisions[after.round.changes[1].id], "discard");
});

test("exact editor preserves mixed raw separators and BOM through sequential edits, save and reopen", async (context) => {
  const {
    page,
    request,
    document: targetPath,
    errors,
  } = await setup(
    context,
    "\uFEFF# 标题\r\n\r\n- 甲🙂\n- 乙\r\n尾\r末\r\n\r\n<!-- 保留源码 -->",
  );
  await page.getByRole("button", { name: "编辑原文", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "工作稿正文", exact: true });
  await editor.focus();
  await editor.evaluate((node) => {
    if (!(node instanceof HTMLTextAreaElement))
      throw Error("expected exact source editor");
    const end = node.value.indexOf("末") + 1;
    node.setSelectionRange(end, end);
  });
  await editor.press("!");
  await editor.press("?");
  await page.waitForTimeout(700);
  equal(
    (await request("/api/state")).draft,
    "\uFEFF# 标题\r\n\r\n- 甲🙂\n- 乙\r\n尾\r末!?\r\n\r\n<!-- 保留源码 -->",
  );
  await page.keyboard.press("ControlOrMeta+s");
  await page.waitForFunction(() =>
    document
      .querySelector("#dock-state")
      ?.textContent?.includes("已写入原文件"),
  );
  deepEqual(
    await readFile(targetPath),
    Buffer.from(
      "\uFEFF# 标题\r\n\r\n- 甲🙂\n- 乙\r\n尾\r末!?\r\n\r\n<!-- 保留源码 -->",
      "utf8",
    ),
  );
  await page.reload();
  await page.getByRole("button", { name: "编辑原文", exact: true }).click();
  await editor.waitFor();
  equal(
    (await request("/api/state")).draft,
    "\uFEFF# 标题\r\n\r\n- 甲🙂\n- 乙\r\n尾\r末!?\r\n\r\n<!-- 保留源码 -->",
  );
  equal(
    await editor.inputValue(),
    "\uFEFF# 标题\n\n- 甲🙂\n- 乙\n尾\n末!?\n\n<!-- 保留源码 -->",
  );
  deepEqual(errors, []);
});

for (const direction of /** @type {const} */ (["forward", "backward"])) {
  test(`exact editor maps ${direction} UTF-16 selections to raw anchors and restores history and composer focus`, async (context) => {
    const { page, request, errors } = await setup(
      context,
      "\uFEFF# 标题\r\n\r\n- 甲🙂\n- 乙\r\n\r\n<!-- 保留源码 -->",
    );
    await page.getByRole("button", { name: "编辑原文", exact: true }).click();
    const editor = page.getByRole("textbox", {
      name: "工作稿正文",
      exact: true,
    });
    await editor.evaluate((node, direction) => {
      if (!(node instanceof HTMLTextAreaElement))
        throw Error("expected raw editor");
      node.focus();
      node.setSelectionRange(15, 16, direction);
    }, direction);
    await page.keyboard.press("ControlOrMeta+Shift+m");
    const composer = page.getByRole("textbox", {
      name: "批注意见",
      exact: true,
    });
    await composer.waitFor();
    await page.waitForTimeout(700);
    const draft = (await request("/api/state")).commentDraft;
    deepEqual(
      {
        start: draft.start,
        end: draft.end,
        quote: draft.quote,
        focusOffset: draft.focusOffset,
        direction: draft.direction,
      },
      {
        start: 17,
        end: 18,
        quote: "乙",
        focusOffset: direction === "backward" ? 17 : 18,
        direction,
      },
    );
    await composer.press("Escape");
    await composer.waitFor({ state: "detached" });
    await page.waitForFunction(() =>
      document.activeElement?.classList.contains("exact-editor"),
    );
    const endpoint = direction === "backward" ? 15 : 16;
    deepEqual(
      await editor.evaluate((node) => {
        if (!(node instanceof HTMLTextAreaElement))
          throw Error("expected raw editor");
        return [
          node.selectionStart,
          node.selectionEnd,
          node === document.activeElement,
        ];
      }),
      [endpoint, endpoint, true],
    );
    await editor.evaluate((node, direction) => {
      if (!(node instanceof HTMLTextAreaElement))
        throw Error("expected raw editor");
      node.setSelectionRange(15, 16, direction);
    }, direction);
    await page.keyboard.press("ControlOrMeta+Shift+h");
    await page.getByRole("button", { name: "返回工作稿", exact: true }).click();
    deepEqual(
      await editor.evaluate((node) => {
        if (!(node instanceof HTMLTextAreaElement))
          throw Error("expected raw editor");
        return [
          node.selectionStart,
          node.selectionEnd,
          node.selectionDirection,
          node === document.activeElement,
        ];
      }),
      [15, 16, direction, true],
    );
    await page.keyboard.press("ControlOrMeta+Shift+m");
    await composer.fill("保留这一个字");
    await composer.evaluate((node) => {
      if (!(node instanceof HTMLTextAreaElement))
        throw Error("expected note editor");
      node.setSelectionRange(1, 3, "backward");
    });
    await composer.press("Escape");
    await page.getByRole("button", { name: "继续编辑", exact: true }).click();
    deepEqual(
      await composer.evaluate((node) => {
        if (!(node instanceof HTMLTextAreaElement))
          throw Error("expected note editor");
        return [
          node.selectionStart,
          node.selectionEnd,
          node.selectionDirection,
          node === document.activeElement,
        ];
      }),
      [1, 3, "backward", true],
    );
    await composer.press("Enter");
    await composer.waitFor({ state: "detached" });
    const saved = await request("/api/state");
    const note = saved.comments[0];
    deepEqual(
      [note.start, note.end, note.quote, note.focusOffset, note.direction],
      [17, 18, "乙", direction === "backward" ? 17 : 18, direction],
    );
    equal(saved.draft.slice(note.start, note.end), "乙");
    await page.reload();
    await page.getByRole("button", { name: "编辑原文", exact: true }).click();
    await editor.waitFor();
    const reopened = (await request("/api/state")).comments[0];
    deepEqual(
      [reopened.start, reopened.end, reopened.quote, reopened.direction],
      [17, 18, "乙", direction],
    );
    deepEqual(errors, []);
  });
}

test("all-discarded review saves actual human edits once and keeps comments", async (context) => {
  const {
    page,
    request,
    document: targetPath,
    errors,
  } = await setup(context, "# 原稿");
  await page.locator(".manuscript-editor .ProseMirror > h1").fill("用户已改稿");
  await selectProse(page, 0, 5);
  await page
    .getByRole("button", { name: "为选中文字写批注", exact: true })
    .click();
  const composer = page.getByRole("textbox", { name: "批注意见", exact: true });
  await composer.fill("改一下标题");
  await composer.press("Enter");
  await composer.waitFor({ state: "detached" });
  await dockAction(page, "按本轮全部批注改稿");
  await request("/api/worker", { action: "bind", threadId: "discard-save" });
  const claimed = await request("/api/worker", {
    action: "claim",
    threadId: "discard-save",
  });
  await writeFile(claimed.candidatePath, "# 建议稿");
  await request("/api/worker", {
    action: "submit",
    threadId: "discard-save",
    executionId: claimed.executionId,
  });
  await page
    .getByRole("button", { name: "保留原文第 1 处修改", exact: true })
    .click();
  await page.locator(".review-receipt-node").waitFor();
  const before = await request("/api/state");
  equal(before.round.preview, "# 用户已改稿");
  equal(before.versions.length, 1);
  equal(await page.locator("#save-document").isEnabled(), true);
  equal(await page.locator("#document-save").getAttribute("hidden"), null);
  await page.keyboard.press("ControlOrMeta+s");
  await page.waitForFunction(() =>
    document
      .querySelector("#dock-state")
      ?.textContent?.includes("已写入原文件"),
  );
  equal(await readFile(targetPath, "utf8"), "# 用户已改稿");
  const after = await request("/api/state");
  equal(after.versions.length, 2);
  equal(after.versions[1].body, "# 用户已改稿");
  deepEqual(after.comments, before.comments);
  await page.keyboard.press("ControlOrMeta+s");
  equal((await request("/api/state")).versions.length, 2);
  deepEqual(errors, []);
});

test("all-discarded review of an unedited adopted version offers no save and preserves the newer disk version", async (context) => {
  const {
    page,
    request,
    document: targetPath,
    errors,
  } = await setup(context, "# V1原稿");
  const initial = await request("/api/state");
  const edited = await request("/api/panel", {
    action: "save",
    revision: initial.revision,
    draft: "# V2已保存稿",
    draftRevision: initial.draftRevision,
    comments: [],
    commentDraft: null,
  });
  await request("/api/panel", {
    action: "apply",
    revision: edited.revision,
    operationId: "seed-v2",
    preview: "# V2已保存稿",
  });
  await page.reload();
  await page.locator("#paper[data-mode]").waitFor();
  if (await page.locator(".manuscript-editor").count())
    await page
      .locator('.manuscript-editor[data-editor-state="ready"]')
      .waitFor();
  await dockAction(page, "查看版本轨迹 · 当前 V2");
  await page
    .getByRole("listbox", { name: "已保存版本", exact: true })
    .press("Home");
  await page.getByRole("button", { name: "从此版继续写", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector("#version-label")?.textContent === "V1",
  );
  await selectProse(page, 0, 4);
  await page
    .getByRole("button", { name: "为选中文字写批注", exact: true })
    .click();
  const composer = page.getByRole("textbox", { name: "批注意见", exact: true });
  await composer.fill("建议改写");
  await composer.press("Enter");
  await composer.waitFor({ state: "detached" });
  await dockAction(page, "按本轮全部批注改稿");
  await request("/api/worker", { action: "bind", threadId: "adopt-discard" });
  const claimed = await request("/api/worker", {
    action: "claim",
    threadId: "adopt-discard",
  });
  await writeFile(claimed.candidatePath, "# V1建议稿");
  await request("/api/worker", {
    action: "submit",
    threadId: "adopt-discard",
    executionId: claimed.executionId,
  });
  await page
    .getByRole("button", { name: "保留原文第 1 处修改", exact: true })
    .click();
  await page.locator(".review-receipt-node").waitFor();
  equal(await page.locator("#save-document").isEnabled(), false);
  equal(await page.locator("#document-save").getAttribute("hidden"), "");
  const before = await request("/api/state");
  await page.keyboard.press("ControlOrMeta+s");
  const after = await request("/api/state");
  equal(after.revision, before.revision);
  equal(after.versions.length, 2);
  equal(await readFile(targetPath, "utf8"), "# V2已保存稿");
  deepEqual(after.comments, before.comments);
  deepEqual(errors, []);
});

test("native recovery retains a rejected definition-crossing edit outside the manuscript until undo", async (context) => {
  const original = "甲\n\n[ref]: https://example.com\r\n\r\n乙";
  const {
    page,
    request,
    document: target,
    errors,
  } = await setup(context, original);
  const native = page.getByRole("textbox", { name: "工作稿正文", exact: true });
  await native.focus();
  await native
    .locator("p")
    .first()
    .evaluate((node) => {
      const selection = window.getSelection();
      selection?.selectAllChildren(node);
      selection?.collapseToEnd();
    });
  await page.keyboard.press("Delete");
  equal(await native.textContent(), "甲乙");
  const notice = page.locator(".editor-notice");
  await notice
    .getByText("这次编辑跨过了 Markdown 引用定义，请使用源码编辑。", {
      exact: true,
    })
    .waitFor();
  equal(await native.isEditable(), true);
  equal(await native.textContent(), "甲乙");
  equal(await page.locator("#manuscript .editor-notice").count(), 0);
  await notice.getByText("查看可恢复的 Markdown", { exact: true }).click();
  equal(
    (
      await notice
        .getByRole("textbox", { name: "待恢复的 Markdown", exact: true })
        .inputValue()
    ).trim(),
    "甲乙",
  );
  equal((await request("/api/state")).draft, original);
  equal(await readFile(target, "utf8"), original);
  await notice
    .getByRole("button", { name: "撤销最近编辑", exact: true })
    .click();
  await notice.waitFor({ state: "hidden" });
  equal((await request("/api/state")).draft, original);
  equal(await native.locator("p").count(), 2);
  equal(await native.isEditable(), true);
  deepEqual(errors, []);
});

test("rich native editor keeps clear-all spaces editable, maps the prefix and retains undo across notes", async (context) => {
  const { page, request, errors } = await setup(context, "# 原稿\n\n正文。");
  const editor = page.getByRole("textbox", { name: "工作稿正文", exact: true });
  const session = await editor.getAttribute("data-editor-session");
  const hiddenPopups = await page
    .locator(
      '.manuscript-editor :is(.milkdown-toolbar,.milkdown-link-preview,.milkdown-link-edit,.milkdown-slash-menu)[data-show="false"]',
    )
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        display: getComputedStyle(node).display,
        height: node.getBoundingClientRect().height,
      })),
    );
  ok(hiddenPopups.length >= 3);
  ok(
    hiddenPopups.every(
      (popup) => popup.display === "none" && popup.height === 0,
    ),
  );
  await editor.press("ControlOrMeta+a");
  await editor.press("Backspace");
  await page.keyboard.insertText("zheshi ");
  ok(await editor.isEditable());
  await page.waitForTimeout(700);
  equal((await request("/api/state")).draft, "zheshi ");
  equal(await page.locator(".editor-notice:visible").count(), 0);
  await editor.evaluate((node) => {
    if (!(node instanceof HTMLElement)) throw Error("expected native editor");
    node.focus();
    const text = node.querySelector("p")?.firstChild;
    if (!text) throw Error("missing rewritten paragraph");
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 6);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
  });
  await page
    .getByRole("button", { name: "为选中文字写批注", exact: true })
    .click();
  const composer = page.getByRole("textbox", { name: "批注意见", exact: true });
  await composer.fill("保留这个词");
  await composer.press("Enter");
  await composer.waitFor({ state: "detached" });
  await page.waitForTimeout(700);
  const saved = await request("/api/state");
  deepEqual(
    [saved.comments[0].start, saved.comments[0].end, saved.comments[0].quote],
    [0, 6, "zheshi"],
  );
  await page
    .getByRole("button", { name: "查看批注：保留这个词", exact: true })
    .click();
  await page.getByRole("button", { name: "关闭批注", exact: true }).click();
  await editor.press("ControlOrMeta+End");
  await page.keyboard.insertText("继续");
  await page.waitForTimeout(700);
  await editor.press("ControlOrMeta+z");
  await page.waitForTimeout(700);
  equal((await request("/api/state")).draft, "zheshi ");
  equal(await editor.getAttribute("data-editor-session"), session);
  await editor.press("ControlOrMeta+End");
  await editor.press("Enter");
  await editor.press("Enter");
  await page.keyboard.insertText("保留空段落");
  await dockAction(page, "保存");
  await page.waitForFunction(() =>
    document
      .querySelector("#dock-state")
      ?.textContent?.includes("已写入原文件"),
  );
  await page.reload();
  await page.locator('.manuscript-editor[data-editor-state="ready"]').waitFor();
  ok(await editor.isEditable());
  ok((await request("/api/state")).draft.includes("<br />"));
  deepEqual(errors, []);
});

test("native link destination editing persists and undo keeps the same editor", async (context) => {
  const original = "# 链接\n\n查看[项目](https://example.com/old)。";
  const { page, request, errors } = await setup(context, original);
  const editor = page.getByRole("textbox", { name: "工作稿正文", exact: true });
  const session = await editor.getAttribute("data-editor-session");
  await page.getByRole("link", { name: "项目", exact: true }).click();
  await page.getByRole("button", { name: "编辑链接地址", exact: true }).click();
  await page
    .getByRole("textbox", { name: "链接地址", exact: true })
    .fill("https://example.com/new");
  await page.getByRole("button", { name: "确认链接地址", exact: true }).click();
  await page.waitForTimeout(700);
  ok((await request("/api/state")).draft.includes("https://example.com/new"));
  equal(
    await page
      .getByRole("link", { name: "项目", exact: true })
      .getAttribute("href"),
    "https://example.com/new",
  );
  await editor.press("ControlOrMeta+z");
  await page.waitForTimeout(700);
  equal((await request("/api/state")).draft, original);
  equal(await editor.getAttribute("data-editor-session"), session);
  deepEqual(errors, []);
});

test("rich review retains Markdown structures, same-ID reconsideration and verified-save motion", async (context) => {
  const original =
    "# 需求\n\n## 相机界面\n\n- **快门**操作。\n- 查看[项目](https://example.com)。\n\n尾部 &amp; 原样。";
  const {
    page,
    request,
    document: targetPath,
    errors,
  } = await setup(context, original);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const initial = await request("/api/state");
  const quote = "相机界面",
    start = original.indexOf(quote);
  const notes = [
    {
      id: "rich-review-note",
      start,
      end: start + quote.length,
      quote,
      instruction: "优化标题和快门描述",
      resolved: true,
    },
  ];
  await request("/api/panel", {
    action: "save",
    revision: initial.revision,
    draftRevision: initial.draftRevision,
    draft: original,
    comments: notes,
    commentDraft: null,
  });
  await page.reload();
  await page.locator('.manuscript-editor[data-editor-state="ready"]').waitFor();
  await dockAction(page, "按本轮全部批注改稿");
  await request("/api/worker", {
    action: "bind",
    threadId: "rich-review-worker",
  });
  const claim = await request("/api/worker", {
    action: "claim",
    threadId: "rich-review-worker",
  });
  equal(claim.status, "claimed");
  const candidate = original
    .replace("相机界面", "拍摄界面")
    .replace("**快门**操作。", "**快门**只负责拍摄。");
  await writeFile(claim.candidatePath, candidate);
  await request("/api/worker", {
    action: "submit",
    threadId: "rich-review-worker",
    executionId: claim.executionId,
  });
  await page
    .locator('.review-decision[data-choice="pending"]')
    .first()
    .waitFor();
  ok((await page.locator("#manuscript ul li").count()) >= 2);
  ok(
    (await page.locator("#manuscript strong").allTextContents()).includes(
      "快门",
    ),
  );
  equal(
    await page
      .locator(".review-proposal")
      .getByRole("link", { name: "项目", exact: true })
      .getAttribute("href"),
    "https://example.com",
  );
  const originalSize = await page
    .locator(".review-original h2")
    .evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize));
  const proposedSize = await page
    .locator(".review-proposal h2")
    .evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize));
  ok(originalSize < proposedSize);
  await page.locator('[aria-label="接受第 1 处修改"]').click();
  equal(await readFile(targetPath, "utf8"), original);
  const receipt = page.locator(
    '.review-decision[data-review-index="0"] .review-node',
  );
  await receipt.click();
  await page.locator('[aria-label="保留原文第 1 处修改"]').click();
  equal(await readFile(targetPath, "utf8"), original);
  const review = (await request("/api/state")).round;
  for (let index = 0; index < review.changes.length; index++) {
    const choice = review.decisions[review.changes[index].id];
    if (choice)
      await page
        .locator(`.review-decision[data-review-index="${index}"] .review-node`)
        .click();
    await page.locator(`[aria-label="接受第 ${index + 1} 处修改"]`).click();
  }
  const preview = (await request("/api/state")).round.preview;
  await dockAction(page, "保存");
  await page.waitForFunction(() =>
    document.querySelector("#brand")?.classList.contains("confirmed"),
  );
  const result = await request("/api/state");
  equal(await readFile(targetPath, "utf8"), preview);
  equal(result.versions.at(-1).body, preview);
  ok(preview.endsWith("尾部 &amp; 原样。"));
  deepEqual(errors, []);
});

/** @param {Awaited<ReturnType<typeof setup>>} fixture @param {string} original @param {string} candidate */
async function submitInlineReview({ page, request }, original, candidate) {
  const state = await request("/api/state");
  const start = original.indexOf("旧词");
  await request("/api/panel", {
    action: "save",
    revision: state.revision,
    draftRevision: state.draftRevision,
    draft: original,
    comments: [
      {
        id: "inline-review-note",
        start,
        end: start + 2,
        quote: "旧词",
        instruction: "改成新稿",
        resolved: true,
      },
    ],
    commentDraft: null,
  });
  await page.reload();
  await page.locator('.manuscript-editor[data-editor-state="ready"]').waitFor();
  await dockAction(page, "按本轮全部批注改稿");
  await request("/api/worker", {
    action: "bind",
    threadId: "inline-review-worker",
  });
  const claim = await request("/api/worker", {
    action: "claim",
    threadId: "inline-review-worker",
  });
  equal(claim.status, "claimed");
  await writeFile(claim.candidatePath, candidate);
  await request("/api/worker", {
    action: "submit",
    threadId: "inline-review-worker",
    executionId: claim.executionId,
  });
  await page
    .locator('.review-decision[data-choice="pending"]')
    .first()
    .waitFor();
}

test("inline review preserves standalone bold link and code context", async (context) => {
  const original =
    "# 富文本审阅核对\n\n**保留加粗。**\n\n[保留链接。](https://example.com/check)\n\n`保留代码。`\n\n旧词\n";
  const fixture = await setup(context, original);
  const { page, errors } = fixture;
  await submitInlineReview(fixture, original, original.replace("旧词", "新稿"));
  deepEqual(await page.locator("#manuscript strong").allTextContents(), [
    "保留加粗。",
  ]);
  equal(
    await page
      .getByRole("link", { name: "保留链接。", exact: true })
      .getAttribute("href"),
    "https://example.com/check",
  );
  deepEqual(await page.locator("#manuscript code").allTextContents(), [
    "保留代码。",
  ]);
  equal(
    await page
      .locator(".review-reading :is(p,h1,h2,section.block,.markdown-reading)")
      .count(),
    0,
  );
  deepEqual(errors, []);
});

for (const [kind, text, selector] of [
  ["plain", "旧词", ".review-fragment"],
  ["bold", "**旧词**", "strong .review-fragment"],
  [
    "link",
    "[旧词](https://example.com/check)",
    "a[href='https://example.com/check'] .review-fragment",
  ],
  ["code", "`旧词`", "code .review-fragment"],
]) {
  test(`inline review retains whole ${kind} text highlights and same-ID reconsideration`, async (context) => {
    const original = `# 审阅\n\n${text}\n`;
    const fixture = await setup(context, original);
    const { page, request, document: targetPath, errors } = fixture;
    await submitInlineReview(
      fixture,
      original,
      original.replace("旧词", "新稿"),
    );
    const round = (await request("/api/state")).round;
    equal(round.changes.length, 1);
    const id = round.changes[0].id;
    deepEqual(
      await page
        .locator(`.review-original ${selector}[data-review-ref="${id}"]`)
        .allTextContents(),
      ["旧词"],
    );
    deepEqual(
      await page
        .locator(`.review-proposal ${selector}[data-review-ref="${id}"]`)
        .allTextContents(),
      ["新稿"],
    );
    equal(await page.locator(".review-format").count(), 0);
    await page
      .getByRole("button", { name: "接受第 1 处修改", exact: true })
      .click();
    await page.locator(".review-receipt-node").waitFor();
    equal((await request("/api/state")).round.decisions[id], "keep");
    equal(await page.locator(".review-selected").textContent(), "新稿");
    deepEqual(
      await page
        .locator(`.review-selected ${selector}[data-review-ref="${id}"]`)
        .allTextContents(),
      ["新稿"],
    );
    await page.locator(".review-receipt-node").click();
    equal((await request("/api/state")).round.changes[0].id, id);
    deepEqual(
      await page
        .locator(`.review-proposal ${selector}[data-review-ref="${id}"]`)
        .allTextContents(),
      ["新稿"],
    );
    await page
      .getByRole("button", { name: "保留原文第 1 处修改", exact: true })
      .click();
    equal((await request("/api/state")).round.decisions[id], "discard");
    equal(await page.locator(".review-selected").textContent(), "旧词");
    deepEqual(
      await page
        .locator(`.review-selected ${selector}[data-review-ref="${id}"]`)
        .allTextContents(),
      ["旧词"],
    );
    equal(await readFile(targetPath, "utf8"), original);
    deepEqual(errors, []);
  });
}

for (const [kind, text] of [
  ["fenced", "```md\n[^example]: literal text\n```"],
  ["indented", "    [^example]: literal text"],
  ["inline", "`[^example]: literal text`"],
  ["escaped", "\\[^example]: literal text"],
  ["midparagraph", "文字 [^example]: literal text"],
]) {
  test(`native footnote classification supports ${kind} literals`, async (context) => {
    const original = `# 代码文本\n\n${text}\n`;
    const { page, request, errors } = await setup(context, original);
    equal(
      await page
        .getByRole("textbox", { name: "工作稿正文", exact: true })
        .count(),
      1,
    );
    equal(
      await page.getByRole("button", { name: "编辑原文", exact: true }).count(),
      0,
    );
    equal((await request("/api/state")).draft, original);
    deepEqual(errors, []);
  });
}

for (const [kind, text] of [
  ["multiword", "[^example]: actual footnote text"],
  ["nested", "> [^example]: actual footnote text"],
  ["reference", "正文[^example]。\n\n[^example]: https://example.com/check"],
]) {
  test(`native footnote classification protects ${kind} footnotes`, async (context) => {
    const original = `# 脚注\n\n${text}\n`;
    const { page, request, errors } = await setup(context, original);
    equal(
      await page
        .getByRole("textbox", { name: "工作稿正文", exact: true })
        .count(),
      0,
    );
    equal(
      await page.getByRole("button", { name: "编辑原文", exact: true }).count(),
      1,
    );
    equal((await request("/api/state")).draft, original);
    deepEqual(errors, []);
  });
}
