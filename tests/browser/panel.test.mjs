import { equal, ok } from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";
import { startService } from "../support/service.mjs";

test("the built browser panel opens the test manuscript in an editable field", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agora-panel-smoke-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const source = new URL("../fixtures/a01/original.md", import.meta.url);
  const document = join(root, "manuscript.md");
  await copyFile(source, document);

  const { url } = await startService(context, document, join(root, "runtime"));
  const browser = await chromium.launch();
  context.after(() => browser.close());
  const page = await browser.newPage();
  /** @type {string[]} */
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const response = await page.goto(url);
  equal(response?.status(), 200, url);

  const editor = page.getByRole("textbox", { name: "工作稿正文" });
  try {
    await editor.waitFor({ state: "visible", timeout: 5000 });
  } catch (error) {
    throw new Error(
      `Editor did not mount at ${url}. ${pageErrors.join("\n")}`,
      { cause: error },
    );
  }
  ok(await editor.isEditable());
  equal(await editor.inputValue(), await readFile(source, "utf8"));
});
