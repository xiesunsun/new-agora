import { equal, match, rejects, throws } from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  access,
  copyFile,
  mkdir,
  readFile,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createManagedRun } from "../../dev/runtime/src/index.mjs";
import {
  createTestProcessScope,
  finishTestProcesses,
} from "../../scripts/test-processes.mjs";

const runner = fileURLToPath(
  new URL("../../scripts/test.mjs", import.meta.url),
);
const cleaner = fileURLToPath(
  new URL("../../scripts/clean-development.mjs", import.meta.url),
);

/** @param {import('node:test').TestContext} context @param {string} body @param {boolean} [stateInside] @param {{git?: boolean, interrupt?: boolean, uncertainSignal?: boolean, files?: Record<string,string>, browser?: boolean, link?: boolean, namePattern?: string}} [options] */
async function execute(context, body, stateInside = false, options = {}) {
  const run = await createManagedRun("test");
  const scope = createTestProcessScope(run.root, process.env);
  const witness = join(run.root, "fixture.pid");
  const browserWitness = join(run.root, "browser.json");
  const scopeWitness = join(run.root, "scope-backup.json");
  const ready = join(run.root, "ready");
  const repo = join(run.root, "repo");
  const state = stateInside
    ? join(repo, ".generated-state")
    : join(run.root, "state");
  context.after(async () => {
    const backup = await readFile(scopeWitness, "utf8").catch(() => undefined);
    if (backup) {
      const { path, original } = JSON.parse(backup);
      await writeFile(path, original);
    }
    const names = await readdir(join(state, "runs")).catch(() => []);
    const cleanup = [];
    for (const name of names) {
      try {
        execFileSync(process.execPath, [cleaner, "--remove", name], {
          env: { ...process.env, AGORA_STATE_DIR: state },
          stdio: "pipe",
        });
      } catch (error) {
        cleanup.push(String(error));
      }
    }
    const report = await finishTestProcesses(scope);
    if (cleanup.length || report.survivors.length || report.uncertain.length) {
      const problems = JSON.stringify({ cleanup, report });
      await run.retain(problems);
      throw new Error(`Fixture cleanup incomplete: ${problems}`);
    }
    await run.release();
  });
  for (const name of ["tests/tooling", "tests/browser"])
    await mkdir(join(repo, name), { recursive: true });
  if (options.git !== false) execFileSync("git", ["init", "-q"], { cwd: repo });
  await writeFile(join(repo, "source.md"), "accepted dirty source");
  await writeFile(
    join(repo, "tests/example.test.mjs"),
    `import { test } from 'node:test';\ntest('green assertions', async () => { ${body} });\n`,
  );
  for (const [name, source] of Object.entries(options.files ?? {})) {
    await mkdir(dirname(join(repo, name)), { recursive: true });
    await writeFile(join(repo, name), source);
  }
  if (options.link)
    await symlink("../source.md", join(repo, "tests/linked.test.mjs"));
  if (options.git !== false) execFileSync("git", ["add", "."], { cwd: repo });
  await writeFile(join(repo, "source.md"), "user's uncommitted source");
  /** @type {NodeJS.ProcessEnv} */
  const env = {
    ...scope.env,
    AGORA_STATE_DIR: state,
    AGORA_FIXTURE_PID: witness,
    AGORA_BROWSER_WITNESS: browserWitness,
    AGORA_SCOPE_WITNESS: scopeWitness,
    AGORA_FIXTURE_READY: ready,
  };
  delete env.NODE_TEST_CONTEXT;
  delete env.AGORA_TEST_NAME_PATTERN;
  if (options.namePattern !== undefined)
    env.AGORA_TEST_NAME_PATTERN = options.namePattern;
  let entry = runner;
  if (options.uncertainSignal) {
    const clone = join(run.root, "runner");
    await mkdir(join(clone, "scripts"), { recursive: true });
    await mkdir(join(clone, "dev/runtime/src"), { recursive: true });
    entry = join(clone, "scripts/test.mjs");
    await copyFile(runner, entry);
    await copyFile(
      new URL("../../scripts/worktree-baseline.py", import.meta.url),
      join(clone, "scripts/worktree-baseline.py"),
    );
    await writeFile(
      join(clone, "dev/runtime/src/index.mjs"),
      `export { createManagedRun } from ${JSON.stringify(new URL("../../dev/runtime/src/index.mjs", import.meta.url).href)};`,
    );
    await writeFile(
      join(clone, "scripts/test-processes.mjs"),
      `export { createTestProcessScope, finishTestProcesses } from ${JSON.stringify(new URL("../../scripts/test-processes.mjs", import.meta.url).href)};
       export function signalTestProcesses() { return { uncertain: ['injected signal identity uncertainty'] }; }`,
    );
  }
  const child = spawn(
    process.execPath,
    [entry, ...(options.browser ? ["browser"] : [])],
    {
      cwd: repo,
      env,
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
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once(options.interrupt ? "exit" : "close", resolve);
  });
  if (options.interrupt) {
    const deadline = Date.now() + 10000;
    while (
      await access(ready).then(
        () => false,
        () => true,
      )
    ) {
      if (Date.now() > deadline)
        throw new Error("Fixture did not become ready");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    child.kill("SIGTERM");
  }
  const status = await exited;
  if (options.interrupt) {
    child.stdout.destroy();
    child.stderr.destroy();
  }
  return { status, output, repo, state, witness, browserWitness };
}

test("a clean run releases its resources and preserves accepted dirty files", async (context) => {
  const result = await execute(context, "");
  equal(result.status, 0, result.output);
  equal(
    await readFile(join(result.repo, "source.md"), "utf8"),
    "user's uncommitted source",
  );
  equal((await readdir(join(result.state, "runs"))).length, 0);
});

test("a focused runner selects matching names and preserves resource checks", async (context) => {
  const result = await execute(
    context,
    "throw new Error('unselected test must not run')",
    false,
    {
      namePattern: "focused success marker",
      files: {
        "tests/browser/focus.test.mjs":
          "import {test} from 'node:test'; test('focused success marker',()=>{});",
      },
    },
  );
  equal(result.status, 0, result.output);
  match(result.output, /Focused test pattern/);
  equal((await readdir(join(result.state, "runs"))).length, 0);
  equal(
    await readFile(join(result.repo, "source.md"), "utf8"),
    "user's uncommitted source",
  );
});

test("a focused runner rejects an invalid name pattern", async (context) => {
  const result = await execute(context, "", false, { namePattern: "[" });
  equal(result.status, 1, result.output);
  match(result.output, /Invalid regular expression/);
});

test("a focused runner with no matching names fails and keeps its selection evidence", async (context) => {
  const result = await execute(context, "", false, {
    namePattern: "does-not-match-any-test",
  });
  equal(result.status, 1, result.output);
  match(result.output, /No tests matched AGORA_TEST_NAME_PATTERN/);
  const [name] = await readdir(join(result.state, "runs"));
  const selection = JSON.parse(
    await readFile(
      join(result.state, "runs", name, "test-selection.json"),
      "utf8",
    ),
  );
  equal(selection.namePattern, "does-not-match-any-test");
});

test("the full runner discovers a failing test two directories below tests", async (context) => {
  const result = await execute(context, "", false, {
    files: {
      "tests/service/recovery/nested.test.mjs":
        "import {test} from 'node:test'; test('nested failure marker',()=>{throw new Error('nested failure marker')});",
    },
  });
  equal(result.status, 1, result.output);
  match(result.output, /nested failure marker/);
});

test("the browser runner recursively discovers its tests and excludes other directories", async (context) => {
  const result = await execute(
    context,
    "throw new Error('non-browser must not run')",
    false,
    {
      browser: true,
      files: {
        "tests/browser/editor/recovery/nested.test.mjs":
          "import {test} from 'node:test'; test('nested browser marker',()=>{throw new Error('nested browser marker')});",
        "tests/service/other.test.mjs":
          "throw new Error('service must not run');",
      },
    },
  );
  equal(result.status, 1, result.output);
  match(result.output, /nested browser marker/);
  equal(
    result.output.includes("non-browser must not run"),
    false,
    result.output,
  );
  equal(result.output.includes("service must not run"), false, result.output);
});

test("an empty browser selection fails without falling back to all tests", async (context) => {
  const result = await execute(
    context,
    "throw new Error('non-browser must not run')",
    false,
    { browser: true },
  );
  equal(result.status, 1, result.output);
  match(result.output, /No test files found in tests\/browser/);
  equal(
    result.output.includes("non-browser must not run"),
    false,
    result.output,
  );
});

test("test discovery refuses symlinks instead of skipping or following them", async (context) => {
  const result = await execute(context, "", false, { link: true });
  equal(result.status, 1, result.output);
  match(result.output, /Test discovery refuses symlink.*linked.test.mjs/);
});

test("green assertions cannot hide repository mutation", async (context) => {
  const result = await execute(
    context,
    "const { writeFileSync } = await import('node:fs'); writeFileSync('source.md', 'test clobbered source');",
  );
  equal(result.status, 1, result.output);
  match(result.output, /Tests modified the repository/);
  match(result.output, /M\s+source.md/);
  const [name] = await readdir(join(result.state, "runs"));
  const root = join(result.state, "runs", name);
  equal(
    JSON.parse(await readFile(join(root, "owner.json"), "utf8")).state,
    "retained",
  );
  await access(join(root, "test.log"));
  match(await readFile(join(root, "source-changes.txt"), "utf8"), /source.md/);
});

test(
  "green assertions cannot leave an owned process alive",
  { skip: process.platform === "win32", timeout: 15000 },
  async (context) => {
    const result = await execute(
      context,
      "const { spawn } = await import('node:child_process'); const { writeFileSync } = await import('node:fs'); const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); writeFileSync(process.env.AGORA_STATE_DIR + '/leaked.pid', String(child.pid)); child.unref();",
    );
    equal(result.status, 1, result.output);
    match(result.output, /leaked owned child processes/);
    const [name] = await readdir(join(result.state, "runs"));
    const root = join(result.state, "runs", name);
    const pid = Number(await readFile(join(root, "state/leaked.pid"), "utf8"));
    throws(() => process.kill(pid, 0), { code: "ESRCH" });
    await rejects(access(join(result.repo, "test.log")));
  },
);

test("the runner refuses repository-local state before creating output", async (context) => {
  const result = await execute(context, "", true);
  equal(result.status, 1, result.output);
  match(result.output, /outside Git repositories/);
  await rejects(access(result.state));
});

test(
  "green assertions cannot leave a raw detached Node process alive",
  { skip: process.platform === "win32", timeout: 20000 },
  async (context) => {
    const result = await execute(
      context,
      "const { spawn } = await import('node:child_process'); const { writeFileSync } = await import('node:fs'); const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }); writeFileSync(process.env.AGORA_FIXTURE_PID, String(child.pid)); child.unref();",
    );
    equal(result.status, 1, result.output);
    match(result.output, /leaked/);
    const pid = Number(await readFile(result.witness, "utf8"));
    throws(() => process.kill(pid, 0), { code: "ESRCH" });
    equal((await readdir(join(result.state, "runs"))).length, 1);
  },
);

test(
  "a detached Node grandchild remains owned after its parent exits immediately",
  { skip: process.platform === "win32", timeout: 20000 },
  async (context) => {
    const parent = `const {spawn} = require('node:child_process'); const {writeFileSync} = require('node:fs'); const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {detached: true, stdio: 'ignore'}); writeFileSync(process.env.AGORA_FIXTURE_PID, String(child.pid)); child.unref(); process.exit(0);`;
    const result = await execute(
      context,
      `
      const { spawn } = await import('node:child_process');
      const { existsSync } = await import('node:fs');
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(parent)}], {detached: true, stdio: 'ignore'});
      child.unref();
      while (!existsSync(process.env.AGORA_FIXTURE_PID)) await new Promise(resolve => setTimeout(resolve, 10));
    `,
    );
    equal(result.status, 1, result.output);
    match(result.output, /leaked/);
    const pid = Number(await readFile(result.witness, "utf8"));
    throws(() => process.kill(pid, 0), { code: "ESRCH" });
  },
);

test(
  "a real Chromium launch is reaped when its test worker is killed",
  { skip: process.platform === "win32", timeout: 30000 },
  async (context) => {
    const playwright = new URL(
      "../../node_modules/playwright/index.mjs",
      import.meta.url,
    ).href;
    const result = await execute(
      context,
      `
      const { chromium } = await import(${JSON.stringify(playwright)});
      const browser = await chromium.launch({headless: true});
      const page = await browser.newPage();
      await page.goto('data:text/html,<title>owned browser</title>');
      if (await page.title() !== 'owned browser') throw new Error('Browser did not launch');
      const { readdirSync, readFileSync, writeFileSync } = await import('node:fs');
      const scope = JSON.parse(process.env.AGORA_TEST_PROCESS_SCOPES).at(-1);
      const records = readdirSync(scope.root + '/processes').filter(name => name !== 'scope.json' && name.endsWith('.json')).map(name => JSON.parse(readFileSync(scope.root + '/processes/' + name, 'utf8')));
      const children = records.filter(record => record.ppid === process.pid && record.pid !== process.pid);
      writeFileSync(process.env.AGORA_BROWSER_WITNESS, JSON.stringify(children));
      process.kill(process.pid, 'SIGKILL');
    `,
    );
    equal(result.status, 1, result.output);
    const children = JSON.parse(await readFile(result.browserWitness, "utf8"));
    equal(
      children.length > 0,
      true,
      "Chromium creation must be registered before worker failure",
    );
    for (const child of children)
      throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
    const [name] = await readdir(join(result.state, "runs"));
    const root = join(result.state, "runs", name);
    const report = JSON.parse(
      await readFile(join(root, "process-report.json"), "utf8"),
    );
    equal(report.survivors.length, 0);
    equal(report.uncertain.length, 0);
    for (const pid of report.leaked)
      throws(() => process.kill(pid, 0), { code: "ESRCH" });
  },
);

test("a baseline failure outside Git remains cleanable", async (context) => {
  const result = await execute(context, "", false, { git: false });
  equal(result.status, 1, result.output);
  const names = await readdir(join(result.state, "runs"));
  if (!names.length) {
    equal(result.output.includes("Retained test run:"), false, result.output);
    return;
  }
  equal(names.length, 1);
  const root = join(result.state, "runs", names[0]);
  match(result.output, /Cleanup: .*pnpm clean:dev --remove test-/);
  const output = execFileSync(
    process.execPath,
    [cleaner, "--remove", basename(root)],
    {
      env: { ...process.env, AGORA_STATE_DIR: result.state },
      encoding: "utf8",
    },
  );
  match(output, /Removed test-/);
  await rejects(access(root));
});

test(
  "SIGTERM with a corrupt scope reaps its direct test group and retains diagnostics",
  { skip: process.platform === "win32", timeout: 20000 },
  async (context) => {
    const result = await execute(
      context,
      `
      const { readFileSync, writeFileSync } = await import('node:fs');
      const scope = JSON.parse(process.env.AGORA_TEST_PROCESS_SCOPES).at(-1);
      const path = scope.root + '/processes/scope.json';
      writeFileSync(process.env.AGORA_SCOPE_WITNESS, JSON.stringify({path, original: readFileSync(path, 'utf8')}));
      writeFileSync(path, '{}');
      writeFileSync(process.env.AGORA_FIXTURE_PID, String(process.pid));
      writeFileSync(process.env.AGORA_FIXTURE_READY, 'ready');
      setInterval(() => {}, 1000);
      await new Promise(() => {});
    `,
      false,
      { interrupt: true },
    );
    equal(typeof result.status, "number", result.output);
    equal(result.status === 0, false, result.output);
    const pid = Number(await readFile(result.witness, "utf8"));
    throws(() => process.kill(pid, 0), { code: "ESRCH" });
    const [name] = await readdir(join(result.state, "runs"));
    const root = join(result.state, "runs", name);
    equal(
      JSON.parse(await readFile(join(root, "owner.json"), "utf8")).state,
      "retained",
    );
    await access(join(root, "test.log"));
    const report = JSON.parse(
      await readFile(join(root, "process-report.json"), "utf8"),
    );
    match(report.uncertain.join("\n"), /Invalid test process scope descriptor/);
    match(result.output, /Retained test run:/);
    await access(join(root, "source-changes.txt"));
  },
);

test(
  "SIGTERM with an uncertain identity still stops the known direct test group",
  { skip: process.platform === "win32", timeout: 20000 },
  async (context) => {
    const result = await execute(
      context,
      `const {writeFileSync} = await import('node:fs');
       writeFileSync(process.env.AGORA_FIXTURE_PID, String(process.pid));
       writeFileSync(process.env.AGORA_FIXTURE_READY, 'ready');
       setInterval(() => {}, 1000); await new Promise(() => {});`,
      false,
      { interrupt: true, uncertainSignal: true },
    );
    equal(result.status === 0, false, result.output);
    const pid = Number(await readFile(result.witness, "utf8"));
    throws(() => process.kill(pid, 0), { code: "ESRCH" });
    const [name] = await readdir(join(result.state, "runs"));
    const report = JSON.parse(
      await readFile(
        join(result.state, "runs", name, "process-report.json"),
        "utf8",
      ),
    );
    match(report.uncertain.join("\n"), /injected signal identity uncertainty/);
  },
);
