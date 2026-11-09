import { equal, notEqual, ok } from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startService } from "./support/service.mjs";

/** @param {import('node:test').TestContext} context @param {string} [config] */
async function launch(context, config) {
  const child = spawn(
    process.execPath,
    ["dist/run.js", "--mock", ...(config ? ["--", "--config", config] : [])],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    errors += String(chunk);
  });
  const stopped = new Promise((resolve) => child.once("close", resolve));
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await stopped;
  };
  context.after(stop);
  for (let attempt = 0; attempt < 200; attempt++) {
    equal(child.exitCode, null, errors);
    const url = output.match(/Agora: (http:\/\/[^\s]+)/)?.[1];
    const document = output.match(/Markdown: (.+)/)?.[1];
    const runtime = output.match(/Runtime: (.+)/)?.[1];
    if (url && document && runtime) {
      /** @param {object} [command] @returns {Promise<import('../packages/contracts/src/index.js').View>} */
      async function request(command) {
        const response = await fetch(
          new URL(command ? "/api/panel" : "/api/state", url),
          command
            ? {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(command),
              }
            : undefined,
        );
        const state = await response.json();
        ok(response.ok, JSON.stringify(state));
        return state;
      }
      return {
        document,
        runtime,
        request,
        stop,
        configPath: output.match(/Mock config: (.+)/)?.[1],
        configDigest: output.match(/Config SHA-256: ([a-f0-9]+)/)?.[1],
      };
    }
    await delay(25);
  }
  throw new Error(`Mock launcher did not start ${errors}`);
}

/** @param {() => Promise<import('../packages/contracts/src/index.js').View>} request @param {(state: import('../packages/contracts/src/index.js').View) => boolean} predicate */
async function waitFor(request, predicate) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const state = await request();
    if (predicate(state)) return state;
    await delay(20);
  }
  throw new Error("Mock did not reach expected state");
}

/** @param {import('../packages/contracts/src/index.js').View} state */
function generation(state) {
  return {
    action: "generate",
    revision: state.revision,
    draft: state.draft,
    comments: state.comments,
    draftRevision: state.draftRevision,
    commentDraft: null,
    requestId: "mock-generation",
  };
}

test("two configured mocks use isolated manuscripts, workers and real save/version behavior", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agora-mock-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source.md");
  const original = "# 文稿\n\n原句。保留句。\n";
  await writeFile(source, original);
  const configs = await Promise.all(
    ["甲", "乙"].map(async (suffix) => {
      const path = join(root, `${suffix}.json`);
      await writeFile(
        path,
        JSON.stringify({
          manuscript: "source.md",
          comments: [{ quote: "原句。", instruction: "改写" }],
          worker: {
            threadId: `mock-${suffix}`,
            pollMs: 5,
            editMs: 10,
            rules: [{ quote: "原句。", replacement: `${suffix}句。` }],
            results: [{ kind: "rules" }],
          },
        }),
      );
      return path;
    }),
  );
  const mocks = await Promise.all(
    configs.map((config) => launch(context, config)),
  );
  notEqual(mocks[0].document, mocks[1].document);
  notEqual(mocks[0].runtime, mocks[1].runtime);
  for (const [index, mock] of mocks.entries()) {
    equal(mock.configPath, configs[index]);
    ok(mock.configDigest && /^[a-f0-9]{64}$/.test(mock.configDigest));
    const initial = await mock.request();
    equal(initial.comments.length, 1);
    equal(initial.draft, original);
    await mock.request(generation(initial));
    const review = await waitFor(
      mock.request,
      (state) => state.round?.phase === "review",
    );
    ok(review.round?.phase === "review");
    const expected =
      index === 0 ? "# 文稿\n\n甲句。保留句。\n" : "# 文稿\n\n乙句。保留句。\n";
    equal(review.round.candidate, expected);
    equal(await readFile(mock.document, "utf8"), original);
    let chosen = review;
    for (const change of review.round.changes)
      chosen = await mock.request({
        action: "choose",
        revision: chosen.revision,
        roundId: review.round.id,
        changeId: change.id,
        keep: true,
      });
    const saved = await mock.request({
      action: "apply",
      revision: chosen.revision,
      operationId: "mock-save",
      preview: expected,
    });
    equal(await readFile(mock.document, "utf8"), expected);
    equal(saved.versions.length, 2);
    equal(saved.versions[1].body, expected);
    equal(await readFile(source, "utf8"), original);
    await mock.stop();
  }
});

test("configured worker failure reports terminal evidence through the real service", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agora-mock-failure-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "source.md"), "原句。");
  const config = join(root, "failure.json");
  await writeFile(
    config,
    JSON.stringify({
      manuscript: "source.md",
      comments: [{ quote: "原句。", instruction: "改写" }],
      worker: {
        threadId: "failed-worker",
        pollMs: 5,
        editMs: 5,
        rules: [],
        results: [{ kind: "failed" }],
      },
    }),
  );
  const mock = await launch(context, config);
  await mock.request(generation(await mock.request()));
  const interrupted = await waitFor(
    mock.request,
    (state) =>
      state.round?.phase === "interrupted" && state.round.executionEnded,
  );
  ok(interrupted.round?.phase === "interrupted");
  equal(interrupted.round.executionEnded, true);
  equal(await readFile(mock.document, "utf8"), "原句。");
  equal(interrupted.versions.length, 1);
  await mock.stop();
});

test("stopping a claimed scripted worker persists a genuine cancelled receipt", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agora-mock-stop-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "source.md"), "原句。");
  const config = join(root, "slow.json");
  await writeFile(
    config,
    JSON.stringify({
      manuscript: "source.md",
      comments: [{ quote: "原句。", instruction: "改写" }],
      worker: {
        threadId: "stopped-worker",
        pollMs: 5,
        editMs: 10000,
        rules: [],
        results: [{ kind: "candidate", body: "迟到改稿。" }],
      },
    }),
  );
  const mock = await launch(context, config);
  await mock.request(generation(await mock.request()));
  const editing = await waitFor(
    mock.request,
    (state) => state.round?.phase === "editing",
  );
  ok(editing.round?.phase === "editing");
  const executionId = editing.round.executionId;
  await mock.stop();
  const resumed = await startService(context, mock.document, mock.runtime);
  const recovered = await resumed.request("/api/state");
  equal(recovered.round.phase, "interrupted");
  equal(recovered.round.executionId, executionId);
  equal(recovered.round.executionEnded, true);
  equal(await readFile(mock.document, "utf8"), "原句。");
  await resumed.stop();
});

test("desktop terminal tool reports failed and cancelled claimed executions", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agora-desktop-finish-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const document = join(root, "source.md");
  const runtime = join(root, "runtime");
  await writeFile(document, "原句。");
  const service = await startService(context, document, runtime);
  const mcp = new Client({ name: "finish-test", version: "0.1.0" });
  context.after(() => mcp.close());
  await mcp.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["dist/desktop/dist/server.mjs"],
      env: { AGORA_CONNECTION: join(runtime, "connection.json") },
    }),
  );
  /** @param {string} name @param {Record<string, unknown>} [args] @returns {Promise<Record<string, unknown>>} */
  async function call(name, args = {}) {
    const result = await mcp.callTool({
      name,
      arguments: args,
      _meta: { threadId: "finish-test" },
    });
    ok(!result.isError, JSON.stringify(result.content));
    return z.record(z.string(), z.unknown()).parse(result.structuredContent);
  }
  const tools = await mcp.listTools();
  ok(tools.tools.some((tool) => tool.name === "agora_finish_execution"));
  await call("agora_open_document");
  let state = await service.request("/api/state");
  state = await service.request("/api/panel", {
    action: "save",
    revision: state.revision,
    draft: state.draft,
    comments: [
      { id: "note", start: 0, end: 3, quote: "原句。", instruction: "改写" },
    ],
    draftRevision: state.draftRevision,
    commentDraft: null,
  });
  for (const outcome of ["failed", "cancelled"]) {
    state = await service.request("/api/panel", {
      ...generation(state),
      requestId: `desktop-${outcome}`,
    });
    const claim = await call("agora_claim_next");
    ok(claim && "executionId" in claim);
    const finished = await call("agora_finish_execution", {
      executionId: claim.executionId,
      outcome,
    });
    equal(finished?.status, "finished");
    state = await service.request("/api/state");
    ok(state.round?.phase === "interrupted");
    equal(state.round.executionEnded, true);
    equal(state.round.executionId, claim.executionId);
  }
  equal(await readFile(document, "utf8"), "原句。");
  await mcp.close();
  await service.stop();
});

test("default mock opens the accepted bookstore with its two seeded comments", async (context) => {
  const mock = await launch(context);
  const state = await mock.request();
  ok(state.draft.startsWith("# 街角书店的公共生活\n\n"));
  equal(state.comments.length, 2);
  equal(state.comments[0].quote, "这也许是街上最不费力的一种邀请");
  equal(state.comments[1].quote, "三家店对顾客都很友好");
  equal(await readFile(mock.document, "utf8"), state.draft);
  equal(state.versions.length, 1);
  await mock.stop();
});
