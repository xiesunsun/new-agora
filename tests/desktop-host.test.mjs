import { equal } from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { chromium } from "playwright";

const sdk = `
export class App {
 constructor() { window.testHost = {app:this,messages:[],requests:[],roundId:'round-1'}; }
 async callServerTool(request) { const h=window.testHost;h.requests.push(request);return {structuredContent:{state:{documentId:'doc',documentName:'copy.md',revision:2,draftRevision:0,draft:'正文',comments:[],commentDraft:null,workingBase:{version:1},versions:[{number:1,body:'正文',savedAt:null,parentVersion:null,operationId:null}],round:{phase:'waiting',id:h.roundId,base:'正文',submittedComments:[],sourceDraftRevision:0},applyStatus:null}}}; }
 async connect() { window.testHost.connected=true; }
}
export class OpenAIExtensions {
 constructor() { this.message={send:async message=>{window.testHost.messages.push(message);return {};}}; }
}
`;

test("desktop wakes each queued generation and retry once and cleans up its mount", async (context) => {
  const result = await build({
    entryPoints: ["plugins/desktop/src/host.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    plugins: [
      {
        name: "host-sdk-boundary",
        setup(builder) {
          builder.onResolve(
            {
              filter:
                /^@(?:modelcontextprotocol\/ext-apps|openai\/mcp-extensions\/app)$/,
            },
            (args) => ({ path: args.path, namespace: "sdk-stub" }),
          );
          builder.onLoad({ filter: /.*/, namespace: "sdk-stub" }, () => ({
            contents: sdk,
            loader: "js",
          }));
        },
      },
    ],
  });
  const browser = await chromium.launch();
  context.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent("<div id='app'></div>");
  await page.addScriptTag({
    content:
      "window.AgoraPanel={mountPanel(transport){window.testHost.transport=transport;return()=>{window.testHost.cleaned=true;};}};",
  });
  await page.addScriptTag({
    type: "module",
    content: result.outputFiles[0].text,
  });
  await page.waitForFunction(() => Reflect.get(window, "testHost")?.connected);
  await page.evaluate(() =>
    Reflect.get(window, "testHost").app.ontoolresult({
      structuredContent: { threadId: "test-thread", projectId: "a".repeat(64) },
    }),
  );
  await page.evaluate(async () => {
    const host = Reflect.get(window, "testHost");
    await host.transport.run({
      action: "generate",
      revision: 0,
      requestId: "generate",
      draft: "正文",
      draftRevision: 0,
      comments: [],
      commentDraft: null,
    });
    host.roundId = "round-2";
    await host.transport.run({
      action: "retry",
      revision: 1,
      roundId: "round-1",
      requestId: "retry",
    });
    await host.transport.run({
      action: "retry",
      revision: 1,
      roundId: "round-1",
      requestId: "retry",
    });
  });
  equal(
    await page.evaluate(() => Reflect.get(window, "testHost").messages.length),
    2,
  );
  equal(
    await page.evaluate(() =>
      Reflect.get(window, "testHost").requests.every(
        /** @param {{arguments:{expectedProject:string}}} request */
        (request) => request.arguments.expectedProject === "a".repeat(64),
      ),
    ),
    true,
  );
  equal(
    await page.evaluate(() =>
      Reflect.get(window, "testHost").messages.every(
        /** @param {{content:Array<{text:string}>}} message */ (message) =>
          message.content[0].text.includes("projectId: " + "a".repeat(64)),
      ),
    ),
    true,
  );
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  equal(
    await page.evaluate(() => Reflect.get(window, "testHost").cleaned),
    true,
  );
});
