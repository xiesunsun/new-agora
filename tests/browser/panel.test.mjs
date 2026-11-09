import { deepEqual, equal, ok } from "node:assert/strict";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createManagedRun } from "../../dev/runtime/src/index.mjs";
import { chromium } from "playwright";
import { startService } from "../support/service.mjs";

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
  const root = await mkdtemp(
    join(ownRun?.root ?? tmpdir(), "agora-panel-browser-"),
  );
  context.after(() => rm(root, { recursive: true, force: true }));
  const document = join(root, "manuscript.md");
  if (body === undefined)
    await copyFile(
      new URL("../fixtures/a01/original.md", import.meta.url),
      document,
    );
  else await writeFile(document, body);
  const service = await startService(context, document, join(root, "runtime"));
  const browser = await chromium.launch();
  context.after(() => browser.close());
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  /** @type {string[]} */ const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(service.url);
  await page.locator("#paper[data-mode]").waitFor();
  return { ...service, page, document, errors };
}
/** @param {import('playwright').Page} page @param {number} index @param {number} [length] */
async function selectProse(page, index, length = 8) {
  await page.locator(".prose").nth(index).scrollIntoViewIfNeeded();
  await page
    .locator(".prose")
    .nth(index)
    .evaluate((node, length) => {
      const text = node.firstChild;
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
    await page
      .getByRole("textbox", { name: "文稿标题", exact: true })
      .isEditable(),
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
  const editor = page.getByRole("textbox", { name: "文稿标题", exact: true });
  await editor.focus();
  await page.evaluate(() => {
    const first = document.querySelector("h1.prose")?.firstChild,
      last = document.querySelectorAll(".prose")[2]?.firstChild;
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
  equal(await editor.evaluate((node) => node === document.activeElement), true);
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

test("unsupported Markdown edits retain BOM, CRLF and literal markup across autosave and apply", async (context) => {
  const original = "\uFEFF# **标题**\r\n\r\n- 一项\r\n- 二项\r\n";
  const {
    page,
    request,
    document: targetPath,
    errors,
  } = await setup(context, original);
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
  equal(await editor.evaluate((node) => node === document.activeElement), true);
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
      .locator(".prose")
      .nth(1)
      .evaluate((node) => node === document.activeElement),
    true,
  );
  deepEqual(
    (await request("/api/state")).comments.map(
      /** @param {{instruction:string}} note */ (note) => note.instruction,
    ),
    ["第一条意见", "第二条意见"],
  );
  const title = page.getByRole("textbox", { name: "文稿标题", exact: true });
  await title.focus();
  await title.press("End");
  await page.keyboard.insertText("新");
  const offset = await page.evaluate(() => window.getSelection()?.focusOffset);
  await page.waitForTimeout(800);
  equal(
    await title.evaluate((node) => node === document.activeElement),
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
  await page
    .getByRole("textbox", { name: "文稿标题", exact: true })
    .fill("人类标题");
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
    .getByRole("textbox", { name: "文稿标题", exact: true })
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
    await page
      .getByRole("textbox", { name: "文稿标题", exact: true })
      .textContent(),
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
  } = await setup(context, "\uFEFF# 标题\r\n\r\n- 甲🙂\n- 乙\r\n尾\r末");
  const editor = page.getByRole("textbox", { name: "工作稿正文", exact: true });
  await editor.focus();
  await editor.press("ControlOrMeta+End");
  await editor.press("!");
  await editor.press("?");
  await page.waitForTimeout(700);
  equal(
    (await request("/api/state")).draft,
    "\uFEFF# 标题\r\n\r\n- 甲🙂\n- 乙\r\n尾\r末!?",
  );
  await page.keyboard.press("ControlOrMeta+s");
  await page.waitForFunction(() =>
    document
      .querySelector("#dock-state")
      ?.textContent?.includes("已写入原文件"),
  );
  deepEqual(
    await readFile(targetPath),
    Buffer.from("\uFEFF# 标题\r\n\r\n- 甲🙂\n- 乙\r\n尾\r末!?", "utf8"),
  );
  await page.reload();
  await editor.waitFor();
  equal(
    (await request("/api/state")).draft,
    "\uFEFF# 标题\r\n\r\n- 甲🙂\n- 乙\r\n尾\r末!?",
  );
  equal(await editor.inputValue(), "\uFEFF# 标题\n\n- 甲🙂\n- 乙\n尾\n末!?");
  deepEqual(errors, []);
});

for (const direction of /** @type {const} */ (["forward", "backward"])) {
  test(`exact editor maps ${direction} UTF-16 selections to raw anchors and restores history and composer focus`, async (context) => {
    const { page, request, errors } = await setup(
      context,
      "\uFEFF# 标题\r\n\r\n- 甲🙂\n- 乙\r\n",
    );
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
  await page
    .getByRole("textbox", { name: "文稿标题", exact: true })
    .fill("用户已改稿");
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
