import { deepEqual, ok } from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

test("native source compiler preserves untouched Markdown and accepts typing transients", async (context) => {
  const compiler = fileURLToPath(
    new URL(
      "../../apps/panel/src/editor/manuscript-source.ts",
      import.meta.url,
    ),
  );
  const built = await build({
    stdin: {
      contents: `
        import { Crepe } from '@milkdown/crepe';
        import { editorViewCtx, serializerCtx } from '@milkdown/kit/core';
        import { sourceSnapshot, projectSource } from ${JSON.stringify(compiler)};
        globalThis.sourceGate = async () => {
          const results = [];
          async function fixture(body, run) {
            const root = document.createElement('div'); document.body.append(root);
            const crepe = new Crepe({ root, defaultValue: body, features: {
              [Crepe.Feature.TopBar]: false, [Crepe.Feature.Toolbar]: false,
              [Crepe.Feature.AI]: false, [Crepe.Feature.Latex]: false,
              [Crepe.Feature.CodeMirror]: false, [Crepe.Feature.ImageBlock]: false,
            }});
            try {
              await crepe.create();
              const view = crepe.editor.action(ctx => ctx.get(editorViewCtx));
              const serialize = doc => crepe.editor.action(ctx => ctx.get(serializerCtx)(doc));
              let snapshot = sourceSnapshot(body, view.state.doc);
              const apply = tr => {
                const state = view.state.apply(tr);
                snapshot = projectSource(snapshot, state.doc, serialize(state.doc), tr.mapping);
                view.updateState(state);
                return snapshot.body;
              };
              await run({ view, apply, source: () => snapshot.body });
            } finally { await crepe.destroy(); root.remove(); }
          }
          await fixture('\\uFEFF# 标题\\r\\n\\r\\n&#x7532; &amp; 乙\\n\\n* 保留列表\\r\\n', ({view,apply,source}) => {
            const before = source();
            const body = apply(view.state.tr.insertText('新', 2));
            results.push({name:'raw-neighbors',before,body});
          });
          await fixture('首段\\r\\n\\r\\n&#x7532; &amp; 乙\\n\\n末段', ({view,apply}) => {
            const tr = view.state.tr.insertText('一', 1);
            tr.insertText('二', tr.doc.content.size - 1);
            results.push({name:'disjoint',body:apply(tr)});
          });
          await fixture('[链接][ref]\\n\\n[ref]: https://example.com "保持定义"\\r\\n\\r\\n末段', ({view,apply}) => {
            results.push({name:'definition',body:apply(view.state.tr.insertText('新', view.state.doc.content.size - 1))});
          });
          await fixture('甲\\n\\n[ref]: https://example.com\\r\\n\\r\\n乙', ({view,apply}) => {
            try { results.push({name:'definition-join',body:apply(view.state.tr.join(3))}); }
            catch(error) { results.push({name:'definition-join',body:error.message}); }
          });
          await fixture('甲\\n\\n[ref]: https://example.com\\r\\n\\r\\n乙', ({view,apply}) => {
            const paragraph = view.state.schema.nodes.paragraph.create(null, view.state.schema.text('覆写'));
            results.push({name:'full-replacement',body:apply(view.state.tr.replaceWith(0, view.state.doc.content.size, paragraph))});
          });
          await fixture('[ref]: https://example.com "保留"\\r\\n', ({view,apply}) => {
            results.push({name:'source-only',body:apply(view.state.tr.insertText('新增',1))});
          });
          await fixture('首段\\n\\n保留 &amp; 原样', ({view,apply}) => {
            const strong = view.state.schema.marks.strong;
            results.push({name:'mark-only',body:apply(view.state.tr.addMark(1, 3, strong.create()))});
          });
          await fixture('原文\\n\\n后文', ({view,apply}) => {
            apply(view.state.tr.delete(0, view.state.doc.content.size));
            let body = apply(view.state.tr.insertText('zheshi', 1));
            body = apply(view.state.tr.insertText(' ', 7));
            const paragraph = view.state.schema.nodes.paragraph.create();
            body = apply(view.state.tr.insert(view.state.doc.content.size, paragraph));
            body = apply(view.state.tr.insertText('继续', view.state.doc.content.size - 1));
            results.push({name:'reset-space-enter',body});
          });
          await fixture('前文\\n\\n* 第一项\\n* 第二项\\n\\n尾部 &amp; 原样', ({view,apply}) => {
            const text = view.state.doc.textContent;
            let pos = 0;
            view.state.doc.descendants((node,offset) => {if(node.isText && node.text==='第一项')pos=offset+1;});
            results.push({name:'list',body:apply(view.state.tr.insertText('新',pos))});
          });
          await fixture('| 甲 | 乙 |\\n| -- | -- |\\n| 一 | 二 |\\n\\n尾部 &amp; 原样', ({view,apply}) => {
            let pos = 0;
            view.state.doc.descendants((node,offset) => {if(node.isText && node.text==='一')pos=offset+1;});
            results.push({name:'table',body:apply(view.state.tr.insertText('新',pos))});
          });
          await fixture('重复 &amp; 字\\n\\n重复 &#x26; 字\\n\\n重复 & 字', ({view,apply}) => {
            results.push({name:'repeated',body:apply(view.state.tr.insertText('新',1))});
          });
          await fixture('首段 &amp; 原样\\r\\n\\r\\n尾段', ({view,apply,source}) => {
            const before = source();
            const tr = view.state.tr.insertText('新', 1);
            const inverse = tr.steps[0].invert(view.state.doc);
            apply(tr);
            results.push({name:'undo',before,body:apply(view.state.tr.step(inverse))});
          });
          await fixture('前段\\r\\n\\r\\n后段\\n\\n尾部 &amp; 原样', ({view,apply}) => {
            apply(view.state.tr.split(2));
            results.push({name:'split',body:apply(view.state.tr.join(3))});
          });
          return results;
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
  await page.addScriptTag({ content: built.outputFiles[0].text });
  const result = await page.evaluate(async () => {
    const testWindow =
      /** @type {Window & {sourceGate?: () => Promise<{name:string,body:string,before?:string}[]>}} */ (
        window
      );
    if (!testWindow.sourceGate)
      throw new Error("Missing source compiler fixture");
    return testWindow.sourceGate();
  });
  const bodies = Object.fromEntries(
    result.map(({ name, body }) => [name, body]),
  );
  ok(bodies["raw-neighbors"].startsWith("\uFEFF# 标新题\r\n\r\n"));
  ok(bodies["raw-neighbors"].endsWith("&#x7532; &amp; 乙\n\n* 保留列表\r\n"));
  ok(bodies.disjoint.includes("\r\n\r\n&#x7532; &amp; 乙\n\n"));
  ok(
    bodies.definition.includes('[ref]: https://example.com "保持定义"\r\n\r\n'),
  );
  deepEqual(
    bodies["definition-join"],
    "这次编辑跨过了 Markdown 引用定义，请使用源码编辑。",
  );
  deepEqual(bodies["full-replacement"], "覆写");
  deepEqual(
    bodies["source-only"],
    '[ref]: https://example.com "保留"\r\n新增\r\n',
  );
  ok(bodies["mark-only"].startsWith("**首段**\n\n"));
  ok(bodies["mark-only"].endsWith("保留 &amp; 原样"));
  deepEqual(bodies["reset-space-enter"], "zheshi \n\n继续");
  ok(bodies.list.includes("第新一项"));
  ok(bodies.list.endsWith("尾部 &amp; 原样"));
  ok(bodies.table.includes("一新"));
  ok(bodies.table.endsWith("尾部 &amp; 原样"));
  ok(bodies.repeated.endsWith("重复 &#x26; 字\n\n重复 & 字"));
  deepEqual(bodies.undo, result.find(({ name }) => name === "undo")?.before);
  deepEqual(bodies.split, "前段\r\n\r\n后段\n\n尾部 &amp; 原样");
});
