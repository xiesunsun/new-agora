import { deepStrictEqual, equal, ok } from "node:assert/strict";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startService } from "./support/service.mjs";

const fixture = new URL("./fixtures/a01/", import.meta.url);

test("A01 keeps a selected suggestion and the human title in the file and V2", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agora-a01-test-"));
  const document = join(root, "manuscript.md");
  await copyFile(new URL("original.md", fixture), document);
  const original = await readFile(document, "utf8");
  const expected = await readFile(new URL("expected.md", fixture), "utf8");
  const runtime = join(root, "runtime");
  context.after(() => rm(root, { recursive: true, force: true }));
  const { request } = await startService(context, document, runtime);

  const panel = "/api/panel";
  const threadId = "a01-test";
  const mcp = new Client({ name: "agora-a01-test", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/desktop/dist/server.mjs"],
    env: { AGORA_CONNECTION: join(runtime, "connection.json") },
  });
  context.after(() => mcp.close());
  await mcp.connect(transport);
  const panelResource = await mcp.readResource({
    uri: "ui://agora-a01/panel.html",
  });
  ok(
    "text" in panelResource.contents[0] &&
      panelResource.contents[0].text.includes('id="app"'),
  );
  /** @param {string} name @param {Record<string, unknown>} [args] */
  async function call(name, args = {}) {
    const result = await mcp.callTool({
      name,
      arguments: args,
      _meta: { threadId },
    });
    ok(!result.isError, JSON.stringify(result.content));
    return result.structuredContent;
  }
  await call("agora_open_document", { path: document });
  deepStrictEqual(await call("agora_claim_next"), {
    status: "idle",
  });
  const initial = await request("/api/state");
  deepStrictEqual(initial.versions, [{ number: 1, body: original }]);

  const draft = original.replace("# 方案", "# 交付方案");
  const comments = [
    { id: "first", quote: "本周完成初稿", instruction: "改成周四上午完成初稿" },
    { id: "second", quote: "周五前交付", instruction: "改成下周一交付" },
  ].map((comment) => {
    const start = draft.indexOf(comment.quote);
    return { ...comment, start, end: start + comment.quote.length };
  });
  const waiting = await request(panel, {
    action: "generate",
    revision: initial.revision,
    draft,
    comments,
    requestId: "a01-generation",
  });
  equal(waiting.round.phase, "waiting");

  const claim = await call("agora_claim_next");
  ok(claim && typeof claim === "object" && "status" in claim);
  equal(claim.status, "claimed");
  ok("candidatePath" in claim && typeof claim.candidatePath === "string");
  ok("comments" in claim && "executionId" in claim);
  equal((await request("/api/state")).round.phase, "editing");
  equal(await readFile(claim.candidatePath, "utf8"), draft);
  deepStrictEqual(claim.comments, comments);
  await writeFile(
    claim.candidatePath,
    draft
      .replace("本周完成初稿", "周四上午完成初稿")
      .replace("周五前交付", "下周一交付"),
  );
  await call("agora_submit_candidate", {
    executionId: claim.executionId,
  });

  const review = await request("/api/state");
  equal(review.round.phase, "review");
  const [first, second] = review.round.changes;
  equal(review.round.changes.length, 2);
  equal(await readFile(document, "utf8"), original);
  deepStrictEqual(review.versions, [{ number: 1, body: original }]);

  const kept = await request(panel, {
    action: "choose",
    revision: review.revision,
    changeId: first.id,
    keep: true,
  });
  const discarded = await request(panel, {
    action: "choose",
    revision: kept.revision,
    changeId: second.id,
    keep: false,
  });
  equal(discarded.round.preview, expected);
  deepStrictEqual((await request("/api/state")).round.decisions, {
    [first.id]: "keep",
    [second.id]: "discard",
  });
  equal(await readFile(document, "utf8"), original);

  const apply = {
    action: "apply",
    revision: discarded.revision,
    operationId: "a01-apply",
    preview: expected,
  };
  const applied = await request(panel, apply);
  deepStrictEqual(applied.applyStatus, { phase: "applied", version: 2 });
  equal(await readFile(document, "utf8"), expected);
  deepStrictEqual(applied.versions, [
    { number: 1, body: original },
    { number: 2, body: expected },
  ]);
  deepStrictEqual((await request(panel, apply)).versions, applied.versions);
});

test(
  "an interrupted apply stays pending and restart reconciles the original operation",
  {
    skip:
      process.getuid?.() === 0
        ? "requires a user subject to directory permissions"
        : false,
  },
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), "agora-write-recovery-"));
    const directory = join(root, "manuscript");
    await mkdir(directory);
    const document = join(directory, "draft.md");
    await copyFile(new URL("original.md", fixture), document);
    context.after(async () => {
      await chmod(directory, 0o700);
      await rm(root, { recursive: true, force: true });
    });
    const runtime = join(root, "runtime");
    const first = await startService(context, document, runtime);
    const original = await readFile(document, "utf8");
    const expected = original.replace("# 方案", "# 新标题");
    const initial = await first.request("/api/state");
    const draft = await first.request("/api/panel", {
      action: "save",
      revision: initial.revision,
      draft: expected,
      comments: [],
    });

    const operation = {
      action: "apply",
      revision: draft.revision,
      operationId: "interrupted-write",
      preview: expected,
    };
    await chmod(directory, 0o500);
    const checking = await first.request("/api/panel", operation);
    deepStrictEqual(checking.applyStatus, {
      phase: "checking",
      operationId: operation.operationId,
      revision: operation.revision,
    });
    deepStrictEqual(checking.versions, [{ number: 1, body: original }]);
    equal(await readFile(document, "utf8"), original);
    await first.stop();

    const resumed = await startService(context, document, runtime);
    deepStrictEqual(
      (await resumed.request("/api/state")).applyStatus,
      checking.applyStatus,
    );
    await resumed.stop();
    await chmod(directory, 0o700);
    await writeFile(document, expected);

    const verified = await startService(context, document, runtime);
    const result = await verified.request("/api/state");
    deepStrictEqual(result.applyStatus, { phase: "applied", version: 2 });
    deepStrictEqual(result.versions, [
      { number: 1, body: original },
      { number: 2, body: expected },
    ]);
    deepStrictEqual(
      (await verified.request("/api/panel", operation)).versions,
      result.versions,
    );
    await verified.stop();
  },
);
