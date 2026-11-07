import { deepStrictEqual, equal, throws } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("../../scripts/worktree-baseline.py", import.meta.url),
);

test("an external baseline compares tracked and untracked files without staging", async (context) => {
  const temp = await mkdtemp(join(tmpdir(), "agora-baseline-"));
  context.after(() => rm(temp, { recursive: true, force: true }));
  const repo = join(temp, "repo");
  const manifest = join(temp, "before.json");
  await mkdir(repo);
  /** @type {import("node:child_process").ExecFileSyncOptionsWithStringEncoding} */
  const options = { cwd: repo, encoding: "utf8" };
  execFileSync("git", ["init", "-q"], options);
  await writeFile(join(repo, "tracked"), "before");
  await writeFile(join(repo, "draft.md"), "existing draft");
  await writeFile(join(repo, ".gitignore"), "ignored\n");
  execFileSync("git", ["add", "tracked", ".gitignore"], options);

  execFileSync("python3", [script, "capture", manifest], options);
  const captured = await readFile(manifest, "utf8");
  throws(() =>
    execFileSync("python3", [script, "capture", manifest], {
      ...options,
      stdio: "pipe",
    }),
  );
  equal(await readFile(manifest, "utf8"), captured);
  throws(() =>
    execFileSync("python3", [script, "capture", join(repo, "inside.json")], {
      ...options,
      stdio: "pipe",
    }),
  );

  await writeFile(join(repo, "tracked"), "after");
  await unlink(join(repo, "draft.md"));
  await writeFile(join(repo, "new.md"), "new draft");
  await writeFile(join(repo, "ignored"), "ignored fixture");
  const report = execFileSync("python3", [script, "diff", manifest], options);
  deepStrictEqual(report.trim().split("\n"), [
    "D\tdraft.md",
    "A\tnew.md",
    "M\ttracked",
  ]);
  equal(execFileSync("git", ["show", ":tracked"], options), "before");
});
