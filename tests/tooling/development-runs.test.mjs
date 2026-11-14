import { deepEqual, equal, ok, rejects } from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createManagedRun, stateRoot } from "../../dev/runtime/src/index.mjs";

/** @param {import('node:test').TestContext} context */
async function fixture(context) {
  const base = join(
    process.env.AGORA_STATE_DIR ?? join(homedir(), ".local/state/agora"),
    "tasks/development-lifecycle-tests",
  );
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "fixture-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** @param {string} root */
async function runs(root) {
  return readdir(join(root, "runs")).catch(() => []);
}

test("mock SIGTERM removes its owned manuscript and runtime", async (context) => {
  const root = await fixture(context);
  const child = spawn(process.execPath, ["dist/run.js", "--mock"], {
    env: { ...process.env, AGORA_STATE_DIR: root },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    output += String(chunk);
  });
  const closed = new Promise((resolve) => child.once("close", resolve));
  context.after(async () => {
    child.kill("SIGTERM");
    await closed;
  });
  for (
    let attempt = 0;
    attempt < 200 && !output.includes("Agora: ");
    attempt++
  ) {
    equal(child.exitCode, null, output);
    await delay(25);
  }
  ok(output.includes("Agora: "), output);
  equal((await runs(root)).length, 1, "mock allocates one managed run");
  child.kill("SIGTERM");
  equal(await closed, 0, output);
  deepEqual(await runs(root), []);
});

/** @param {string} root @param {string[]} args */
function clean(root, args = []) {
  return spawnSync(
    process.execPath,
    ["scripts/clean-development.mjs", ...args],
    { env: { ...process.env, AGORA_STATE_DIR: root }, encoding: "utf8" },
  );
}

/** @param {string} root @param {string} code */
function evaluate(root, code) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    env: { ...process.env, AGORA_STATE_DIR: root },
    encoding: "utf8",
  });
}

test("managed handles validate ownership, retain a reason, and release idempotently", async (context) => {
  const root = await fixture(context);
  const previous = process.env.AGORA_STATE_DIR;
  process.env.AGORA_STATE_DIR = root;
  context.after(() => {
    if (previous === undefined) delete process.env.AGORA_STATE_DIR;
    else process.env.AGORA_STATE_DIR = previous;
  });
  equal(stateRoot(), root);
  const run = await createManagedRun("test");
  context.after(() => rm(run.root, { recursive: true, force: true }));
  const marker = join(run.root, "owner.json");
  const original = await readFile(marker, "utf8");
  await writeFile(
    marker,
    original.replace(`"pid": ${process.pid}`, '"pid": 1'),
  );
  await rejects(run.release(), /ownership changed/);
  await writeFile(marker, original);
  await rejects(run.retain("  "), /reason/);
  await run.retain("inspect failed check");
  equal(
    JSON.parse(await readFile(marker, "utf8")).reason,
    "inspect failed check",
  );
  await run.release();
  await run.release();
  await rejects(access(run.root));
});

test("an owned handle retains and releases its allocation after the environment changes", async (context) => {
  const root = await fixture(context);
  const result = evaluate(
    root,
    `import {createManagedRun} from './dev/runtime/src/index.mjs';
     const run = await createManagedRun('mock');
     process.env.AGORA_STATE_DIR += '/different-state';
     await run.retain('Inspect original allocation');
     await run.release();
     console.log(run.root);`,
  );
  equal(result.status, 0, result.stderr);
  await rejects(access(result.stdout.trim()));
  await rejects(access(join(root, "different-state")));
});

test("cleanup lists owner status and removes only a dead, recognized exact run", async (context) => {
  const root = await fixture(context);
  const created = evaluate(
    root,
    `import {createManagedRun} from './dev/runtime/src/index.mjs'; const run = await createManagedRun('mock'); await run.retain('inspection'); console.log(run.root);`,
  );
  equal(created.status, 0, created.stderr);
  const path = created.stdout.trim();
  const name = basename(path);
  const listed = clean(root);
  equal(listed.status, 0);
  ok(listed.stdout.includes(`${name}\tretained`));
  ok(listed.stdout.includes("dead"));
  equal(clean(root, ["--remove", name]).status, 0);
  await rejects(access(path));
  for (const forbidden of ["../outside", path, "mock-*", "unknown-run", name])
    equal(clean(root, ["--remove", forbidden]).status, 1);
});

test("cleanup rejects active owners, symlink roots, symlink markers, and unmarked directories", async (context) => {
  const root = await fixture(context);
  const runsPath = join(root, "runs");
  await mkdir(runsPath);
  const outside = join(root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "keep"), "untouched");
  await symlink(outside, join(runsPath, "mock-link"));
  equal(clean(root, ["--remove", "mock-link"]).status, 1);
  await mkdir(join(runsPath, "test-active"));
  const owner = {
    version: 1,
    kind: "test",
    pid: process.pid,
    createdAt: new Date().toISOString(),
    state: "active",
  };
  await writeFile(
    join(runsPath, "test-active", "owner.json"),
    JSON.stringify(owner),
  );
  ok(clean(root).stdout.includes("alive"));
  equal(clean(root, ["--remove", "test-active"]).status, 1);
  await mkdir(join(runsPath, "test-marker"));
  await symlink(
    join(runsPath, "test-active", "owner.json"),
    join(runsPath, "test-marker", "owner.json"),
  );
  equal(clean(root, ["--remove", "test-marker"]).status, 1);
  await mkdir(join(runsPath, "test-unknown"));
  equal(clean(root, ["--remove", "test-unknown"]).status, 1);
  equal(await readFile(join(outside, "keep"), "utf8"), "untouched");
  await rm(runsPath, { recursive: true });
  await symlink(outside, runsPath);
  const created = evaluate(
    root,
    `import {createManagedRun} from './dev/runtime/src/index.mjs'; await createManagedRun('test');`,
  );
  equal(created.status, 1);
  deepEqual(await readdir(outside), ["keep"]);
});

test("mock startup failures remove allocated files and preserve the configured source", async (context) => {
  const root = await fixture(context);
  const source = join(root, "source.md");
  await writeFile(source, "原句。原句。");
  for (const manuscript of ["missing.md", "source.md"]) {
    const config = join(root, "scenario.json");
    await writeFile(
      config,
      JSON.stringify({
        manuscript,
        comments: [{ quote: "原句。", instruction: "改写" }],
        worker: {
          threadId: "test",
          pollMs: 5,
          editMs: 5,
          rules: [],
          results: [{ kind: "rules" }],
        },
      }),
    );
    const result = spawnSync(
      process.execPath,
      ["dist/run.js", "--mock", "--config", config, "--retain-run"],
      {
        env: { ...process.env, AGORA_STATE_DIR: root },
        encoding: "utf8",
        timeout: 5000,
      },
    );
    equal(result.status, 1, result.stderr);
    deepEqual(await runs(root), []);
    equal(await readFile(source, "utf8"), "原句。原句。");
  }
});

test("explicit manuscript and runtime survive launcher shutdown", async (context) => {
  const root = await fixture(context);
  const source = join(root, "source.md");
  const runtime = join(root, "runtime");
  await writeFile(source, "keep the source");
  const child = spawn(
    process.execPath,
    ["dist/run.js", "--file", source, "--runtime", runtime],
    {
      env: { ...process.env, AGORA_STATE_DIR: root },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    output += String(chunk);
  });
  const closed = new Promise((resolve) => child.once("close", resolve));
  context.after(async () => {
    child.kill("SIGTERM");
    await closed;
  });
  for (
    let attempt = 0;
    attempt < 200 && !output.includes("Agora: ");
    attempt++
  ) {
    equal(child.exitCode, null, output);
    await delay(25);
  }
  ok(output.includes("Agora: "), output);
  child.kill("SIGINT");
  equal(await closed, 0, output);
  equal(await readFile(source, "utf8"), "keep the source");
  await access(runtime);
  deepEqual(await runs(root), []);
});

test("managed allocation refuses Git-local state and symlink aliases before writing", async (context) => {
  const root = await fixture(context);
  const repo = join(root, "repo");
  await mkdir(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const alias = join(root, "alias");
  await symlink(repo, alias);
  const runtime = new URL("../../dev/runtime/src/index.mjs", import.meta.url)
    .href;
  for (const location of [repo, alias]) {
    const state = join(location, "generated-state");
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { createManagedRun } from ${JSON.stringify(runtime)}; await createManagedRun('mock');`,
      ],
      {
        cwd: root,
        env: { ...process.env, AGORA_STATE_DIR: state },
        encoding: "utf8",
      },
    );
    equal(result.status, 1, result.stderr);
    ok(result.stderr.includes("outside Git repositories"));
    await rejects(access(state));
  }
});
