import { execFileSync, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createManagedRun } from "../dev/runtime/src/index.mjs";
import {
  createTestProcessScope,
  signalTestProcesses,
  finishTestProcesses,
} from "./test-processes.mjs";

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "browser"))
  throw new Error("Usage: node scripts/test.mjs [browser]");
const namePattern = process.env.AGORA_TEST_NAME_PATTERN;
if (namePattern) new RegExp(namePattern);
const run = await createManagedRun("test");
let completed = false;
/** @type {ReturnType<typeof createTestProcessScope> | undefined} */
let scope;
let processesFinished = false;
/** @type {string[]} */
const signalProblems = [];
const baselineScript = fileURLToPath(
  new URL("./worktree-baseline.py", import.meta.url),
);
const baseline = join(run.root, "source-before.json");
try {
  scope = createTestProcessScope(run.root, process.env);
  execFileSync("python3", [baselineScript, "capture", baseline], {
    stdio: "pipe",
  });
  const temp = join(run.root, "tmp");
  const state = join(run.root, "state");
  const evidence = join(run.root, "evidence");
  await Promise.all(
    [temp, state, evidence].map((path) => mkdir(path, { recursive: true })),
  );
  /** @param {string} folder @returns {Promise<string[]>} */
  async function discover(folder) {
    const files = [];
    const entries = await readdir(folder, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(folder, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(`Test discovery refuses symlink: ${path}`);
      if (entry.isDirectory()) files.push(...(await discover(path)));
      else if (entry.isFile() && entry.name.endsWith(".test.mjs"))
        files.push(path);
    }
    return files;
  }
  const folder = args[0] === "browser" ? "tests/browser" : "tests";
  const files = await discover(folder);
  if (!files.length) throw new Error(`No test files found in ${folder}`);
  await writeFile(
    join(run.root, "test-selection.json"),
    JSON.stringify(
      { folder, files, namePattern: namePattern ?? null },
      null,
      2,
    ) + "\n",
  );
  if (namePattern)
    console.log(`Focused test pattern: ${JSON.stringify(namePattern)}`);
  const selectionCounts = join(run.root, "selected-test-counts.jsonl");
  const selectionReporter = join(run.root, "selection-reporter.mjs");
  if (namePattern)
    await writeFile(
      selectionReporter,
      "export default async function* (events) {\n" +
        "  for await (const event of events)\n" +
        "    if (event.type === 'test:summary' && event.data.file)\n" +
        "      yield JSON.stringify(event.data.counts) + '\\n';\n" +
        "}\n",
    );
  const log = createWriteStream(join(run.root, "test.log"));
  const testArgs = namePattern
    ? [
        "--test",
        `--test-name-pattern=${namePattern}`,
        "--test-reporter=tap",
        "--test-reporter-destination=stdout",
        `--test-reporter=${selectionReporter}`,
        `--test-reporter-destination=${selectionCounts}`,
        ...files,
      ]
    : ["--test", ...files];
  const child = spawn(process.execPath, testArgs, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    env: {
      ...scope.env,
      TMPDIR: temp,
      TMP: temp,
      TEMP: temp,
      AGORA_STATE_DIR: state,
      AGORA_TEST_EVIDENCE_DIR: evidence,
    },
  });
  child.stdout.pipe(process.stdout, { end: false });
  child.stderr.pipe(process.stderr, { end: false });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let deadline;
  /** @param {NodeJS.Signals} signal */
  function signalOwned(signal) {
    let fallback = false;
    try {
      if (scope) {
        const { uncertain } = signalTestProcesses(scope, signal);
        signalProblems.push(...uncertain);
        fallback = uncertain.length > 0;
      }
    } catch (error) {
      signalProblems.push(`Test process signaling failed: ${String(error)}`);
      fallback = true;
    }
    if (
      fallback &&
      child.pid &&
      child.exitCode === null &&
      child.signalCode === null
    ) {
      try {
        if (process.platform === "win32") child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch (error) {
        if (!(
          error instanceof Error &&
          "code" in error &&
          error.code === "ESRCH"
        ))
          signalProblems.push(
            `Direct test process signaling failed: ${String(error)}`,
          );
      }
    }
  }
  /** @param {NodeJS.Signals} signal */
  function stop(signal) {
    signalOwned(signal);
    deadline ??= setTimeout(() => signalOwned("SIGKILL"), 5000);
  }
  const interrupt = () => stop("SIGINT");
  const terminate = () => stop("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      resolve(code ?? (signal === "SIGINT" ? 130 : 143)),
    );
  }).finally(() => {
    clearTimeout(deadline);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  });
  const processes = await finishTestProcesses(scope);
  processesFinished = true;
  processes.uncertain.push(...signalProblems);
  await writeFile(
    join(run.root, "process-report.json"),
    JSON.stringify(processes, null, 2) + "\n",
  );
  if (processes.survivors.length || processes.uncertain.length) {
    child.stdout.destroy();
    child.stderr.destroy();
  }
  const output = await Promise.allSettled([
    finished(child.stdout),
    finished(child.stderr),
  ]);
  log.end();
  await finished(log);
  const changes = execFileSync("python3", [baselineScript, "diff", baseline], {
    encoding: "utf8",
  });
  await writeFile(join(run.root, "source-changes.txt"), changes);
  const selectedTests = namePattern
    ? (await readFile(selectionCounts, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .reduce((total, counts) => total + counts.passed + counts.failed, 0)
    : null;
  const problems = [
    ...(code !== 0 ? [`Test process exited with code ${code}`] : []),
    ...(namePattern && code === 0 && !selectedTests
      ? [
          `No tests matched AGORA_TEST_NAME_PATTERN=${JSON.stringify(namePattern)}`,
        ]
      : []),
    ...(processes.leaked.length
      ? [
          `Test process leaked owned child processes: ${processes.leaked.join(", ")}`,
        ]
      : []),
    ...(processes.survivors.length
      ? [
          `Owned test processes survived SIGKILL: ${processes.survivors.join(", ")}`,
        ]
      : []),
    ...processes.uncertain,
    ...output.flatMap((result) =>
      result.status === "rejected"
        ? [`Test output failed: ${String(result.reason)}`]
        : [],
    ),
    ...(changes ? [`Tests modified the repository:\n${changes}`] : []),
  ];
  if (problems.length === 0) {
    await run.release();
    completed = true;
  } else {
    await run.retain(problems.join("\n"));
    console.error(problems.join("\n"));
    process.exitCode = Number(code) || 1;
  }
} catch (error) {
  if (scope && !processesFinished) {
    const processes = await finishTestProcesses(scope);
    processes.uncertain.push(...signalProblems);
    await writeFile(
      join(run.root, "process-report.json"),
      JSON.stringify(processes, null, 2) + "\n",
    );
  }
  if (scope) await run.retain(`Test runner failed: ${String(error)}`);
  else {
    await run.release();
    completed = true;
  }
  process.exitCode = 1;
  console.error(error);
} finally {
  if (!completed) {
    console.error(`Retained test run: ${run.root}`);
    console.error(
      `Cleanup: AGORA_STATE_DIR='${dirname(dirname(run.root)).replaceAll("'", "'\\''")}' pnpm clean:dev --remove ${basename(run.root)}`,
    );
  }
}
