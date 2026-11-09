import { equal, match, ok, rejects, throws } from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  access,
  copyFile,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createManagedRun } from "../../dev/runtime/src/index.mjs";
import {
  createTestProcessScope,
  finishTestProcesses,
} from "../../scripts/test-processes.mjs";

const cleaner = fileURLToPath(
  new URL("../../scripts/clean-development.mjs", import.meta.url),
);
const processModule = new URL(
  "../../scripts/test-processes.mjs",
  import.meta.url,
).href;
const runtimeModule = new URL(
  "../../dev/runtime/src/index.mjs",
  import.meta.url,
).href;
const identityScript = fileURLToPath(
  new URL("../../scripts/process-identity.py", import.meta.url),
);

/** @param {import('node:test').TestContext} context */
async function fixture(context) {
  const run = await createManagedRun("test");
  const scope = createTestProcessScope(run.root, process.env);
  context.after(async () => {
    const report = await finishTestProcesses(scope);
    if (report.survivors.length || report.uncertain.length) {
      await run.retain(JSON.stringify(report));
      throw new Error(`Fixture cleanup incomplete: ${JSON.stringify(report)}`);
    }
    await run.release();
  });
  return { run, scope };
}

/** @param {NodeJS.ProcessEnv} env @param {string} [body] */
async function start(env, body = "setInterval(() => {}, 1000)") {
  const child = spawn(
    process.execPath,
    ["-e", `process.stdout.write('ready\\n'); ${body}`],
    {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    },
  );
  await new Promise((resolve, reject) => {
    child.stdout.once("data", resolve);
    child.once("error", reject);
    child.once("exit", (code) =>
      reject(new Error(`Fixture exited before ready: ${code}`)),
    );
  });
  return child;
}

/** @param {NodeJS.ProcessEnv} env @param {string} body */
async function evaluate(env, body) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", body], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  equal(code, 0, stderr);
  return stdout;
}

test("concurrent scopes reap only their own detached children", async (context) => {
  const first = await fixture(context);
  const second = await fixture(context);
  const owned = await start(first.scope.env);
  const sentinel = await start(second.scope.env);
  const report = await finishTestProcesses(first.scope);
  ok(report.leaked.includes(/** @type {number} */ (owned.pid)));
  equal(report.survivors.length, 0);
  equal(report.uncertain.length, 0);
  throws(() => process.kill(/** @type {number} */ (owned.pid), 0), {
    code: "ESRCH",
  });
  equal(process.kill(/** @type {number} */ (sentinel.pid), 0), true);
});

test("nested scopes retain outer membership and never own their creator", async (context) => {
  const { run, scope } = await fixture(context);
  const witness = join(run.root, "nested.json");
  const child = await start(
    { ...scope.env, AGORA_NESTED_WITNESS: witness },
    `
    (async () => {
      const { createManagedRun } = await import(${JSON.stringify(runtimeModule)});
      const { createTestProcessScope, finishTestProcesses } = await import(${JSON.stringify(processModule)});
      const { spawn } = await import('node:child_process');
      const { writeFileSync } = await import('node:fs');
      const run = await createManagedRun('test');
      const scope = createTestProcessScope(run.root, process.env);
      const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000)'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'], env: scope.env });
      await new Promise(resolve => child.stdout.once('data', resolve));
      const report = await finishTestProcesses(scope);
      writeFileSync(process.env.AGORA_NESTED_WITNESS, JSON.stringify({ parent: process.pid, child: child.pid, report, nodeOptions: scope.env.NODE_OPTIONS }));
      await run.release();
      setInterval(() => {}, 1000);
    })();
  `,
  );
  for (let attempt = 0; attempt < 100; attempt++) {
    if (
      await access(witness).then(
        () => true,
        () => false,
      )
    )
      break;
    await delay(25);
  }
  const result = JSON.parse(await readFile(witness, "utf8"));
  ok(result.report.leaked.includes(result.child));
  ok(!result.report.leaked.includes(child.pid));
  equal(result.report.survivors.length, 0);
  equal(result.report.uncertain.length, 0);
  equal(result.nodeOptions.split(`--import=${processModule}`).length - 1, 1);
  equal(process.kill(/** @type {number} */ (child.pid), 0), true);
  const report = await finishTestProcesses(scope);
  ok(report.leaked.includes(/** @type {number} */ (child.pid)));
  throws(() => process.kill(/** @type {number} */ (child.pid), 0), {
    code: "ESRCH",
  });
});

test("cleanup reaps registered children after the owning runner dies", async (context) => {
  const { run, scope } = await fixture(context);
  const state = join(run.root, "recovery-state");
  const result = JSON.parse(
    await evaluate(
      { ...scope.env, AGORA_STATE_DIR: state },
      `
    import { createManagedRun } from ${JSON.stringify(runtimeModule)};
    import { createTestProcessScope } from ${JSON.stringify(processModule)};
    import { spawn } from 'node:child_process';
    const run = await createManagedRun('test');
    const scope = createTestProcessScope(run.root, process.env);
    const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000)'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'], env: scope.env });
    await new Promise(resolve => child.stdout.once('data', resolve));
    child.stdout.destroy(); child.unref();
    await run.retain('Interrupted test runner');
    console.log(JSON.stringify({root: run.root, pid: child.pid}));
  `,
    ),
  );
  const marker = join(result.root, "processes/scope.json");
  const valid = await readFile(marker, "utf8");
  await writeFile(marker, "{}");
  const refused = spawnSync(
    process.execPath,
    [cleaner, "--remove", basename(result.root)],
    {
      env: { ...scope.env, AGORA_STATE_DIR: state },
      encoding: "utf8",
    },
  );
  equal(refused.status, 1);
  match(refused.stderr, /Cannot safely remove test run/);
  equal(process.kill(result.pid, 0), true);
  await access(result.root);
  await writeFile(marker, valid);
  const recovered = execFileSync(
    process.execPath,
    [cleaner, "--remove", basename(result.root)],
    {
      env: { ...scope.env, AGORA_STATE_DIR: state },
      encoding: "utf8",
    },
  );
  match(recovered, /Removed/);
  throws(() => process.kill(result.pid, 0), { code: "ESRCH" });
  await rejects(access(result.root));
});

test("missing birth identity retains the run and leaves its live process untouched", async (context) => {
  const { run, scope } = await fixture(context);
  const child = await start(scope.env);
  const registry = join(run.root, "processes");
  const originals = new Map();
  for (const name of await readdir(registry)) {
    if (name === "scope.json") continue;
    const path = join(registry, name);
    const raw = await readFile(path, "utf8");
    const record = JSON.parse(raw);
    originals.set(path, raw);
    await writeFile(
      path,
      JSON.stringify({ ...record, birth: null, group: null }),
    );
  }
  try {
    const report = await finishTestProcesses(scope);
    ok(report.uncertain.length > 0);
    equal(process.kill(/** @type {number} */ (child.pid), 0), true);
  } finally {
    for (const [path, raw] of originals) await writeFile(path, raw);
  }
});

test("process birth identity includes kernel precision", () => {
  const [identity] = JSON.parse(
    execFileSync("python3", [identityScript, String(process.pid)], {
      encoding: "utf8",
    }),
  );
  equal(identity.pid, process.pid);
  equal(identity.state, "alive");
  match(
    identity.birth,
    process.platform === "darwin"
      ? /^darwin:[0-9]+:[0-9]+$/
      : /^linux:[0-9a-f-]+:[0-9]+$/,
  );
  ok(!identity.birth.includes(new Date().toDateString()));
});

test("unrelated kernel processes with group zero do not block cleanup", async (context) => {
  const { run, scope } = await fixture(context);
  const module = join(run.root, "test-processes.mjs");
  await copyFile(fileURLToPath(processModule), module);
  await writeFile(
    join(run.root, "process-identity.py"),
    `import json, subprocess, sys
values = json.loads(subprocess.check_output([sys.executable, ${JSON.stringify(identityScript)}, *sys.argv[1:]]))
if sys.argv[1:] == ['--all']:
    values.append({'pid': 2, 'ppid': 0, 'pgid': 0, 'birth': 'linux:00000000-0000-0000-0000-000000000000:1', 'state': 'alive'})
print(json.dumps(values))
`,
  );
  const report = JSON.parse(
    await evaluate(
      { ...scope.env, AGORA_STATE_DIR: join(run.root, "probe-state") },
      `
    import { createManagedRun } from ${JSON.stringify(runtimeModule)};
    import { createTestProcessScope, finishTestProcesses } from ${JSON.stringify(pathToFileURL(module).href)};
    const run = await createManagedRun('test');
    const scope = createTestProcessScope(run.root, process.env);
    const report = await finishTestProcesses(scope);
    if (report.uncertain.length) await run.retain(JSON.stringify(report));
    else await run.release();
    console.log(JSON.stringify(report));
  `,
    ),
  );
  equal(report.uncertain.length, 0, JSON.stringify(report));
  equal(report.leaked.length, 0);
  equal(report.survivors.length, 0);
});

test("a group lease survives its leader and escalates TERM-resistant members", async (context) => {
  const { scope } = await fixture(context);
  const leader = await start(
    scope.env,
    `
    const { spawn } = require('node:child_process');
    spawn('/bin/sh', ['-c', 'trap "" TERM; sleep 60 & wait'], {stdio: 'ignore'});
    setTimeout(() => process.exit(0), 450);
  `,
  );
  await new Promise((resolve) => leader.once("close", resolve));
  const report = await finishTestProcesses(scope);
  ok(report.leaked.length >= 2, JSON.stringify(report));
  equal(report.survivors.length, 0);
  equal(report.uncertain.length, 0);
  for (const pid of report.leaked)
    throws(() => process.kill(pid, 0), { code: "ESRCH" });
});
