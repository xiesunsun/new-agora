import { equal, match } from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createManagedRun } from "../../dev/runtime/src/index.mjs";

const checker = fileURLToPath(
  new URL("../../scripts/check-repository.py", import.meta.url),
);

test("repository gate accepts intentional sources and rejects pollution through its CLI", async (context) => {
  const run = await createManagedRun("test");
  context.after(() => run.release());
  const repo = join(run.root, "repo");
  await mkdir(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const valid = [
    "package.json",
    "pnpm-lock.yaml",
    ".github/workflows/check.yml",
    ".codex/tool-policy.json",
    "docs/README.md",
    "evidence/review/README.md",
    "tests/fixtures/draft.md",
  ];
  for (const name of valid) {
    await mkdir(dirname(join(repo, name)), { recursive: true });
    await writeFile(join(repo, name), "intentional fixture");
  }
  execFileSync("git", ["add", "."], { cwd: repo });
  equal(spawnSync("python3", [checker], { cwd: repo }).status, 0);
  const directory = join(repo, "unowned-empty-directory");
  await mkdir(directory);
  const empty = spawnSync("python3", [checker], {
    cwd: repo,
    encoding: "utf8",
  });
  equal(empty.status, 1);
  match(empty.stderr, /unowned-empty-directory/);
  await rm(directory, { recursive: true });
  for (const name of [
    "scratch.md",
    "apps/service/runtime.sqlite-wal",
    "dev/mock/connection.json",
    "scripts/__pycache__/module.pyc",
    "tests/browser/screenshots/capture.png",
    "evidence/review/capture.png",
    "evidence/review/check.log",
  ]) {
    const path = join(repo, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "unintended output");
    const result = spawnSync("python3", [checker], {
      cwd: repo,
      encoding: "utf8",
    });
    equal(result.status, 1);
    match(result.stderr, new RegExp(name.replaceAll(".", "\\.")));
  }
  execFileSync("git", ["add", "."], { cwd: repo });
  equal(
    spawnSync("python3", [checker], { cwd: repo }).status,
    1,
    "tracked pollution is rejected too",
  );
});
