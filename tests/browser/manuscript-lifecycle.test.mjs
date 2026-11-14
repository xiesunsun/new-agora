import { deepEqual, equal } from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

/** @typedef {{publications:string[], reports:(string|null)[], settled:string|null, ready:number}} NativeState */
/** @typedef {{state:NativeState, pending?:Promise<void>, settle:()=>Promise<void>, replace:(body:string)=>void, disposeEarly:()=>Promise<{ready:boolean,native:boolean}>}} NativeFixture */

test("native composition flushes the latest source and rejects stale replacements without blocking save", async (context) => {
  const entry = fileURLToPath(
    new URL("../../apps/panel/src/editor/manuscript.ts", import.meta.url),
  );
  const built = await build({
    stdin: {
      contents: `
        import { createManuscript } from ${JSON.stringify(entry)};
        const state = { publications: [], reports: [], settled: null, ready: 0 };
        const host = document.createElement('div'); document.body.append(host);
        const editor = createManuscript(host, {
          source: '初稿 &amp; 原样',
          publish: body => state.publications.push(body),
          report: value => state.reports.push(value),
          ready: () => state.ready++, settle() {},
        });
        globalThis.nativeFixture = {
          state, editor,
          settle: () => editor.settled(() => { state.settled = editor.source; }),
          replace: body => editor.sync(body, {kind:'working', editable:true, note:null}),
          disposeEarly: async () => {
            const root = document.createElement('div'); document.body.append(root);
            let ready = false;
            const late = createManuscript(root, {
              source:'迟到', publish() {}, report() {}, ready() {ready=true}, settle() {},
            });
            late.destroy();
            await late.ready;
            return {ready, native:root.querySelector('.ProseMirror') !== null};
          },
        };
      `,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: "iife",
    define: {
      __VUE_OPTIONS_API__: "true",
      __VUE_PROD_DEVTOOLS__: "false",
      __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false",
    },
  });
  const browser = await chromium.launch();
  context.after(() => browser.close());
  const page = await browser.newPage();
  /** @type {string[]} */ const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addScriptTag({ content: built.outputFiles[0].text });
  await page.locator('[data-editor-state="ready"]').waitFor();
  const native = page.getByRole("textbox", { name: "工作稿正文", exact: true });
  await native.focus();
  await native.evaluate((root) => {
    const selection = window.getSelection();
    selection?.selectAllChildren(root);
    selection?.collapseToEnd();
  });
  await native.dispatchEvent("compositionstart");
  await page.evaluate(() => {
    const fixture =
      /** @type {typeof globalThis & {nativeFixture: NativeFixture}} */ (
        globalThis
      ).nativeFixture;
    fixture.replace("远端内容");
    fixture.pending = fixture.settle();
  });
  equal(
    await page.evaluate(
      () =>
        /** @type {typeof globalThis & {nativeFixture: NativeFixture}} */ (
          globalThis
        ).nativeFixture.state.settled,
    ),
    null,
  );
  await page.keyboard.insertText("新输入");
  await native.dispatchEvent("compositionend");
  await page.evaluate(async () => {
    const fixture =
      /** @type {typeof globalThis & {nativeFixture: NativeFixture}} */ (
        globalThis
      ).nativeFixture;
    await fixture.pending;
  });
  const state = await page.evaluate(
    () =>
      /** @type {typeof globalThis & {nativeFixture: NativeFixture}} */ (
        globalThis
      ).nativeFixture.state,
  );
  equal(state.settled, "初稿 & 原样新输入");
  equal(state.publications.at(-1), state.settled);
  equal(state.reports.at(-1), null);
  equal(await native.isEditable(), true);
  await page.evaluate(async () => {
    const fixture =
      /** @type {typeof globalThis & {nativeFixture: NativeFixture}} */ (
        globalThis
      ).nativeFixture;
    fixture.state.settled = null;
    await fixture.settle();
  });
  equal(
    await page.evaluate(
      () =>
        /** @type {typeof globalThis & {nativeFixture: NativeFixture}} */ (
          globalThis
        ).nativeFixture.state.settled,
    ),
    state.settled,
  );
  deepEqual(
    await page.evaluate(() =>
      /** @type {typeof globalThis & {nativeFixture: NativeFixture}} */ (
        globalThis
      ).nativeFixture.disposeEarly(),
    ),
    { ready: false, native: false },
  );
  deepEqual(errors, []);
});
