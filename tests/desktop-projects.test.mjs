import {
  deepEqual,
  equal,
  match,
  notEqual,
  ok,
  rejects,
} from "node:assert/strict";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createFixture } from "./support/fixture.mjs";
import { waitFor } from "./support/wait.mjs";

/** @param {Awaited<ReturnType<typeof createFixture>>} fixture @param {string} threadId @param {{bundle?: string, env?: Record<string, string>}} [options] */
async function desktop(fixture, threadId, options = {}) {
  const bundle = options.bundle ?? resolve("dist/desktop");
  const client = new Client({ name: "desktop-project-test", version: "1.0.0" });
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => value !== undefined),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(bundle, "dist/server.mjs")],
    cwd: fixture.root,
    env: {
      ...env,
      AGORA_CONNECTION: "",
      AGORA_STATE_DIR: join(fixture.root, "state"),
      ...options.env,
    },
    stderr: "pipe",
  });
  fixture.after(() => client.close());
  await client.connect(transport);
  /** @param {string} name @param {Record<string, unknown>} [args] @param {string} [thread] */
  async function raw(name, args = {}, thread = threadId) {
    return client.callTool({
      name,
      arguments: args,
      _meta: { threadId: thread },
    });
  }
  /** @param {string} name @param {Record<string, unknown>} [args] */
  async function call(name, args = {}) {
    const result = await raw(name, args);
    ok(!result.isError, JSON.stringify(result.content));
    ok(result.structuredContent);
    return JSON.parse(JSON.stringify(result.structuredContent));
  }
  /** @param {string} projectId @param {Record<string, unknown>} [command] */
  async function panel(projectId, command) {
    const { state } = await call("agora_panel", {
      expectedThread: threadId,
      expectedProject: projectId,
      ...(command ? { command } : {}),
    });
    return state;
  }
  return { client, transport, call, raw, panel, bundle };
}

/** @param {string} url */
async function portClosed(url) {
  await waitFor(
    async () => {
      try {
        await fetch(new URL("/api/state", url), {
          signal: AbortSignal.timeout(250),
        });
        return undefined;
      } catch {
        return true;
      }
    },
    { description: "owned project service to close", timeoutMs: 5000 },
  );
}

/** @param {string} root @param {string} projectId */
async function connection(root, projectId) {
  return JSON.parse(
    await readFile(
      join(root, "state/projects", projectId, "connection.json"),
      "utf8",
    ),
  );
}

test("desktop projects open without an external service and isolate panels, executions and saved history", async (context) => {
  const fixture = await createFixture(context, "agora-projects-");
  const a = join(fixture.root, "first.md");
  const b = join(fixture.root, "second.md");
  await writeFile(a, "# First\n\nOriginal sentence.\n");
  await writeFile(b, "# Second\n\nOther manuscript.\n");
  const host = await desktop(fixture, "first-thread");
  const opened = await host.call("agora_open_document", { path: a });
  equal(typeof opened.projectId, "string");
  const alias = join(fixture.root, "alias.md");
  await symlink(a, alias);
  const repeated = await Promise.all([
    host.call("agora_open_document", { path: alias }),
    host.call("agora_open_document", { path: a }),
  ]);
  for (const value of repeated) equal(value.projectId, opened.projectId);
  const initial = await host.panel(opened.projectId);
  const draft = initial.draft.replace("First", "Human title");
  const start = draft.indexOf("Original sentence.");
  const waiting = await host.panel(opened.projectId, {
    action: "generate",
    revision: initial.revision,
    draft,
    comments: [
      {
        id: "rewrite",
        start,
        end: start + "Original sentence.".length,
        quote: "Original sentence.",
        instruction: "Replace with Revised sentence.",
      },
    ],
    requestId: "first-generation",
  });
  equal(waiting.round.phase, "waiting");
  const second = await host.call("agora_open_document", { path: b });
  notEqual(second.projectId, opened.projectId);
  const claim = await host.call("agora_claim_next", {
    projectId: opened.projectId,
  });
  equal(claim.status, "claimed");
  equal(claim.projectId, opened.projectId);
  equal(await readFile(claim.candidatePath, "utf8"), draft);
  await writeFile(
    claim.candidatePath,
    draft.replace("Original sentence.", "Revised sentence."),
  );
  await host.call("agora_submit_candidate", { executionId: claim.executionId });
  const review = await host.panel(opened.projectId);
  equal(review.round.phase, "review");
  equal(review.round.changes.length, 1);
  const untouched = await host.panel(second.projectId);
  equal(untouched.round, null);
  equal(untouched.draft, "# Second\n\nOther manuscript.\n");
  const chosen = await host.panel(opened.projectId, {
    action: "choose",
    revision: review.revision,
    roundId: review.round.id,
    changeId: review.round.changes[0].id,
    keep: true,
  });
  const applied = await host.panel(opened.projectId, {
    action: "apply",
    revision: chosen.revision,
    operationId: "project-apply",
    preview: chosen.round.preview,
  });
  equal(applied.versions.length, 2);
  equal(await readFile(a, "utf8"), "# Human title\n\nRevised sentence.\n");
  equal(await readFile(b, "utf8"), "# Second\n\nOther manuscript.\n");
  const connections = await Promise.all([
    connection(fixture.root, opened.projectId),
    connection(fixture.root, second.projectId),
  ]);
  await host.client.close();
  await Promise.all(connections.map(({ url }) => portClosed(url)));
  const restarted = await desktop(fixture, "next-thread");
  const restored = await restarted.call("agora_open_document", { path: a });
  equal(restored.projectId, opened.projectId);
  const state = await restarted.panel(restored.projectId);
  equal(state.draft, applied.draft);
  deepEqual(state.versions, applied.versions);
  await restarted.client.close();
  const reopened = await desktop(fixture, "next-thread");
  equal(
    (await reopened.call("agora_open_document")).projectId,
    opened.projectId,
  );
});

test("desktop projects reject unopened identities and another active conversation", async (context) => {
  const fixture = await createFixture(context, "agora-project-ownership-");
  const path = join(fixture.root, "copy.md");
  await writeFile(path, "# Bound manuscript\n");
  const first = await desktop(fixture, "owner");
  const opened = await first.call("agora_open_document", { path });
  const second = await desktop(fixture, "other");
  for (const result of [
    await second.raw("agora_open_document", { path }),
    await second.raw("agora_claim_next", { projectId: opened.projectId }),
    await first.raw(
      "agora_panel",
      { expectedThread: "other", expectedProject: opened.projectId },
      "other",
    ),
  ])
    equal(result.isError, true);
  equal((await first.panel(opened.projectId)).draft, "# Bound manuscript\n");
  const active = await connection(fixture.root, opened.projectId);
  await first.client.close();
  await portClosed(active.url);
  equal(
    (await second.call("agora_open_document", { path })).projectId,
    opened.projectId,
  );
});

test("desktop projects retain drafts and history after the original moves without allowing unsafe apply", async (context) => {
  const fixture = await createFixture(context, "agora-project-moved-");
  const path = join(fixture.root, "copy.md");
  const moved = join(fixture.root, "moved.md");
  await writeFile(path, "# Original\n\nSentence.\n");
  const host = await desktop(fixture, "owner");
  const { projectId } = await host.call("agora_open_document", { path });
  const initial = await host.panel(projectId);
  const saved = await host.panel(projectId, {
    action: "save",
    revision: initial.revision,
    draft: "# Saved\n\nSentence.\n",
    comments: [],
  });
  const applied = await host.panel(projectId, {
    action: "apply",
    revision: saved.revision,
    operationId: "before-move",
    preview: saved.draft,
  });
  equal(applied.versions.length, 2);
  await rename(path, moved);
  const retained = await host.panel(projectId);
  equal(retained.draft, applied.draft);
  deepEqual(retained.versions, applied.versions);
  equal((await host.raw("agora_open_document", { path })).isError, true);
  const draft = "# Working draft\n\nSentence.\n";
  const edited = await host.panel(projectId, {
    action: "save",
    revision: retained.revision,
    draft,
    comments: [],
  });
  equal((await host.panel(projectId)).draft, draft);
  const missing = await host.raw("agora_panel", {
    expectedThread: "owner",
    expectedProject: projectId,
    command: {
      action: "apply",
      revision: edited.revision,
      operationId: "missing-original",
      preview: draft,
    },
  });
  equal(missing.isError, true);
  await rejects(readFile(path), { code: "ENOENT" });
  equal(await readFile(moved, "utf8"), applied.draft);
  const external = "# External replacement\n";
  await writeFile(path, external);
  const conflicting = await host.raw("agora_panel", {
    expectedThread: "owner",
    expectedProject: projectId,
    command: {
      action: "apply",
      revision: edited.revision,
      operationId: "conflicting-original",
      preview: draft,
    },
  });
  equal(conflicting.isError, true);
  equal(await readFile(path, "utf8"), external);
  equal(await readFile(moved, "utf8"), applied.draft);
  const unchanged = await host.panel(projectId);
  equal(unchanged.draft, draft);
  deepEqual(unchanged.versions, applied.versions);
  await rename(path, join(fixture.root, "external.md"));
  await host.panel(projectId, {
    action: "generate",
    revision: unchanged.revision,
    draft,
    comments: [
      {
        id: "rewrite",
        start: draft.indexOf("Sentence."),
        end: draft.indexOf("Sentence.") + "Sentence.".length,
        quote: "Sentence.",
        instruction: "Rewrite this sentence.",
      },
    ],
    requestId: "after-move",
  });
  const claim = await host.call("agora_claim_next", { projectId });
  equal(claim.status, "claimed");
  equal(await readFile(claim.candidatePath, "utf8"), draft);
  await host.call("agora_submit_candidate", {
    projectId,
    executionId: claim.executionId,
  });
  equal((await host.panel(projectId)).round.phase, "empty");
});

test("desktop projects retain drafts and history but reject apply after an original parent becomes a symlink", async (context) => {
  const fixture = await createFixture(context, "agora-project-parent-symlink-");
  const directory = join(fixture.root, "original");
  const moved = join(fixture.root, "moved");
  const other = join(fixture.root, "other");
  await mkdir(directory);
  await mkdir(other);
  const path = join(directory, "copy.md");
  await writeFile(path, "# Original\n\nSentence.\n");
  const host = await desktop(fixture, "owner");
  const { projectId } = await host.call("agora_open_document", { path });
  const initial = await host.panel(projectId);
  const saved = await host.panel(projectId, {
    action: "save",
    revision: initial.revision,
    draft: "# Saved\n\nSentence.\n",
    comments: [],
  });
  const applied = await host.panel(projectId, {
    action: "apply",
    revision: saved.revision,
    operationId: "before-parent-move",
    preview: saved.draft,
  });
  equal(applied.versions.length, 2);
  await rename(directory, moved);
  await writeFile(join(other, "copy.md"), applied.draft);
  await symlink(other, directory);
  const retained = await host.panel(projectId);
  equal(retained.draft, applied.draft);
  deepEqual(retained.versions, applied.versions);
  const edited = await host.panel(projectId, {
    action: "save",
    revision: retained.revision,
    draft: "# Working draft\n\nSentence.\n",
    comments: [],
  });
  const rejected = await host.raw("agora_panel", {
    expectedThread: "owner",
    expectedProject: projectId,
    command: {
      action: "apply",
      revision: edited.revision,
      operationId: "changed-original-path",
      preview: edited.draft,
    },
  });
  equal(rejected.isError, true);
  equal(await readFile(join(moved, "copy.md"), "utf8"), applied.draft);
  equal(await readFile(join(other, "copy.md"), "utf8"), applied.draft);
  const unchanged = await host.panel(projectId);
  equal(unchanged.draft, edited.draft);
  deepEqual(unchanged.versions, applied.versions);
  equal(unchanged.applyStatus, null);
});

test("desktop projects report claimed executions finished after the original disappears", async (context) => {
  const fixture = await createFixture(context, "agora-project-missing-finish-");
  const path = join(fixture.root, "copy.md");
  const moved = join(fixture.root, "moved.md");
  const draft = "# Copy\n\nSentence.\n";
  await writeFile(path, draft);
  const host = await desktop(fixture, "owner");
  const { projectId } = await host.call("agora_open_document", { path });
  const initial = await host.panel(projectId);
  await host.panel(projectId, {
    action: "generate",
    revision: initial.revision,
    draft,
    comments: [
      {
        id: "rewrite",
        start: draft.indexOf("Sentence."),
        end: draft.indexOf("Sentence.") + "Sentence.".length,
        quote: "Sentence.",
        instruction: "Rewrite this sentence.",
      },
    ],
    requestId: "before-move",
  });
  const claim = await host.call("agora_claim_next", { projectId });
  equal(claim.status, "claimed");
  await rename(path, moved);
  const other = join(fixture.root, "other.md");
  await writeFile(other, "# Other project\n");
  const next = await host.call("agora_open_document", { path: other });
  equal(
    (
      await host.raw("agora_finish_execution", {
        projectId: next.projectId,
        executionId: claim.executionId,
        outcome: "cancelled",
      })
    ).isError,
    true,
  );
  const finished = await host.call("agora_finish_execution", {
    projectId,
    executionId: claim.executionId,
    outcome: "cancelled",
  });
  equal(finished.status, "finished");
  const state = await host.panel(projectId);
  equal(state.round.phase, "interrupted");
  equal(state.round.executionEnded, true);
  equal(state.round.executionId, claim.executionId);
  equal(state.draft, draft);
  deepEqual(state.versions, initial.versions);
  await rejects(readFile(path), { code: "ENOENT" });
  equal(await readFile(moved, "utf8"), draft);
  equal((await host.panel(next.projectId)).round, null);
});

test("desktop projects reject persisted original identity mismatches on open", async (context) => {
  const fixture = await createFixture(context, "agora-project-identity-");
  const path = join(fixture.root, "copy.md");
  const other = join(fixture.root, "other.md");
  await writeFile(path, "# Bound manuscript\n");
  await writeFile(other, "# Other manuscript\n");
  const first = await desktop(fixture, "owner");
  const { projectId } = await first.call("agora_open_document", { path });
  const active = await connection(fixture.root, projectId);
  await first.client.close();
  await portClosed(active.url);
  const db = new DatabaseSync(
    join(fixture.root, "state/projects", projectId, "document.sqlite"),
  );
  try {
    db.prepare(
      "UPDATE document SET body = json_set(body, '$.originalPath', ?) WHERE id = 1",
    ).run(other);
  } finally {
    db.close();
  }
  const restarted = await desktop(fixture, "owner");
  equal((await restarted.raw("agora_open_document", { path })).isError, true);
  equal(await readFile(path, "utf8"), "# Bound manuscript\n");
  equal(await readFile(other, "utf8"), "# Other manuscript\n");
});

test("desktop parent death closes services and preserves the unknown execution until its original project reports an end", async (context) => {
  const fixture = await createFixture(context, "agora-project-interrupted-");
  const path = join(fixture.root, "copy.md");
  const other = join(fixture.root, "other.md");
  await writeFile(path, "# Copy\n\nSentence.\n");
  await writeFile(other, "# Other\n");
  const host = await desktop(fixture, "owner");
  const { projectId } = await host.call("agora_open_document", { path });
  const initial = await host.panel(projectId);
  await host.panel(projectId, {
    action: "generate",
    revision: initial.revision,
    draft: initial.draft,
    comments: [
      {
        id: "note",
        start: 8,
        end: 17,
        quote: "Sentence.",
        instruction: "Rewrite",
      },
    ],
    requestId: "interrupted-generation",
  });
  const claim = await host.call("agora_claim_next", { projectId });
  equal(claim.status, "claimed");
  const before = await connection(fixture.root, projectId);
  ok(host.transport.pid);
  process.kill(host.transport.pid, "SIGKILL");
  await portClosed(before.url);
  const resumed = await desktop(fixture, "new-owner");
  await resumed.call("agora_open_document", { path });
  const interrupted = await resumed.panel(projectId);
  equal(interrupted.round.phase, "interrupted");
  equal(interrupted.round.executionEnded, false);
  equal(interrupted.round.executionId, claim.executionId);
  equal(
    (
      await resumed.raw("agora_panel", {
        expectedThread: "new-owner",
        expectedProject: projectId,
        command: {
          action: "retry",
          revision: interrupted.revision,
          roundId: interrupted.round.id,
          requestId: "retry",
        },
      })
    ).isError,
    true,
  );
  const next = await resumed.call("agora_open_document", { path: other });
  await resumed.call("agora_finish_execution", {
    projectId,
    executionId: claim.executionId,
    outcome: "cancelled",
  });
  equal((await resumed.panel(projectId)).round.executionEnded, true);
  equal((await resumed.panel(next.projectId)).round, null);
  equal(await readFile(path, "utf8"), initial.draft);
});

test("a service child crash cannot transfer a project while its original desktop conversation remains active", async (context) => {
  const fixture = await createFixture(context, "agora-project-child-crash-");
  const path = join(fixture.root, "copy.md");
  const pidPath = join(fixture.root, "service.pid");
  const preload = join(fixture.root, "record-service.mjs");
  await writeFile(path, "# Reserved project\n");
  await writeFile(
    preload,
    `
import {writeFileSync} from 'node:fs';
if (process.argv[1]?.endsWith('/service.mjs')) writeFileSync(${JSON.stringify(pidPath)},String(process.pid));
`,
  );
  const owner = await desktop(fixture, "owner", {
    env: {
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${pathToFileURL(preload).href}`,
    },
  });
  const { projectId } = await owner.call("agora_open_document", { path });
  const before = await connection(fixture.root, projectId);
  const childPid = Number(await readFile(pidPath, "utf8"));
  process.kill(childPid, "SIGKILL");
  await portClosed(before.url);
  equal(
    (await owner.raw("agora_open_document", { path }, "other-thread")).isError,
    true,
  );
  const other = await desktop(fixture, "other-process");
  equal((await other.raw("agora_open_document", { path })).isError, true);
  equal((await owner.panel(projectId)).draft, "# Reserved project\n");
  const recovered = await connection(fixture.root, projectId);
  await owner.client.close();
  await portClosed(recovered.url);
  equal(
    (await other.call("agora_open_document", { path })).projectId,
    projectId,
  );
});

test("desktop startup failure is actionable and the installed bundle runs outside the repository", async (context) => {
  const fixture = await createFixture(context, "agora-project-package-");
  const bundle = join(fixture.root, "installed");
  await mkdir(bundle);
  const { cp } = await import("node:fs/promises");
  await cp("dist/desktop", bundle, { recursive: true });
  const host = await desktop(fixture, "owner", { bundle });
  const missing = await host.raw("agora_open_document");
  equal(missing.isError, true);
  match(JSON.stringify(missing.content), /路径|Markdown/);
  const invalid = await host.raw("agora_open_document", {
    path: join(fixture.root, "missing.md"),
  });
  equal(invalid.isError, true);
  const unsupported = join(fixture.root, "copy.txt");
  await writeFile(unsupported, "# Not a Markdown path\n");
  for (const invalidPath of ["relative.md", fixture.root, unsupported])
    equal(
      (await host.raw("agora_open_document", { path: invalidPath })).isError,
      true,
    );
  const path = join(fixture.root, "valid.md");
  await copyFile("tests/fixtures/a01/original.md", path);
  const { projectId } = await host.call("agora_open_document", { path });
  equal((await host.panel(projectId)).versions.length, 1);
});

test("desktop parent death during service initialization leaves no orphan or locked project", async (context) => {
  const fixture = await createFixture(context, "agora-project-startup-death-");
  const path = join(fixture.root, "copy.md");
  const pidPath = join(fixture.root, "child.pid");
  const preload = join(fixture.root, "slow-service.mjs");
  await writeFile(path, "# Startup\n");
  await writeFile(
    preload,
    `
import {writeFileSync} from 'node:fs';
import {setTimeout} from 'node:timers/promises';
if (process.argv[1]?.endsWith('/service.mjs')) {
  writeFileSync(${JSON.stringify(pidPath)},String(process.pid));
  await setTimeout(500);
}
`,
  );
  const host = await desktop(fixture, "owner", {
    env: {
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${pathToFileURL(preload).href}`,
    },
  });
  const opening = host
    .raw("agora_open_document", { path })
    .catch(() => undefined);
  const childPid = await waitFor(
    async () => {
      try {
        return Number(await readFile(pidPath, "utf8"));
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return undefined;
        throw error;
      }
    },
    { description: "owned service initialization", timeoutMs: 5000 },
  );
  ok(host.transport.pid);
  process.kill(host.transport.pid, "SIGKILL");
  await opening;
  await waitFor(
    async () => {
      try {
        process.kill(childPid, 0);
        return undefined;
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH")
          return true;
        throw error;
      }
    },
    {
      description: "initializing service exit after parent death",
      timeoutMs: 5000,
    },
  );
  const resumed = await desktop(fixture, "next-owner");
  const { projectId } = await resumed.call("agora_open_document", { path });
  equal((await resumed.panel(projectId)).draft, "# Startup\n");
});
