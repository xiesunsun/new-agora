import { equal, match, ok } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { stateRoot } from "../../dev/runtime/src/index.mjs";

const config = JSON.parse(
  readFileSync(
    process.env.AGORA_HOOK_CONFIG_FOR_TEST ?? resolve(".codex/hooks.json"),
    "utf8",
  ),
);
const blockedTool = "mcp__codex_apps__github_create_pull_request";

/** @param {import('node:test').TestContext} t */
function fixture(t) {
  const base =
    process.env.TMPDIR ??
    join(stateRoot(), "tasks", "hook-launcher-tests", "scratch");
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, "hook-launcher-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const primary = join(dir, "primary repo");
  const linked = join(dir, "linked checkout");
  mkdirSync(primary);
  /** @param {string[]} args */
  function git(...args) {
    const result = spawnSync("git", args, {
      cwd: primary,
      encoding: "utf8",
    });
    equal(result.status, 0, result.stderr);
  }
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(primary, "fixture.txt"), "fixture\n");
  git("add", ".");
  git("commit", "-qm", "fixture");
  git("worktree", "add", "--detach", linked, "HEAD");
  const cwd = join(linked, "nested directory");
  mkdirSync(cwd);
  /** @param {string} root */
  function install(root) {
    mkdirSync(join(root, "scripts"), { recursive: true });
    mkdirSync(join(root, ".codex"), { recursive: true });
    for (const name of ["agora-task.py", "worktree-baseline.py"])
      copyFileSync(resolve("scripts", name), join(root, "scripts", name));
    copyFileSync(
      resolve(".codex/tool-policy.json"),
      join(root, ".codex/tool-policy.json"),
    );
  }
  /** @param {string} event @param {Record<string, unknown> | string} extra */
  function run(event, extra = {}) {
    const payload =
      typeof extra === "string"
        ? extra
        : JSON.stringify({
            hook_event_name: event,
            session_id: "fixture-session",
            cwd,
            ...extra,
          });
    const command = config.hooks[event][0].hooks[0].command;
    const result = spawnSync("/bin/sh", ["-c", command], {
      cwd,
      encoding: "utf8",
      input: payload,
      timeout: 12000,
      env: { ...process.env, AGORA_STATE_DIR: join(dir, "state") },
    });
    equal(result.status, 0, result.stderr || result.error?.message);
    return JSON.parse(result.stdout);
  }
  return { primary, linked, cwd, install, run };
}

test("PreToolUse matches only the exact restricted method", () => {
  equal(config.hooks.PreToolUse.length, 1);
  const matcher = new RegExp(config.hooks.PreToolUse[0].matcher);
  ok(matcher.test(blockedTool));
  for (const name of [
    "functions.exec",
    "exec_command",
    "web__run",
    "apply_patch",
    "mcp__codex_apps__github_create_pull_request_suffix",
    "prefix_mcp__codex_apps__github_create_pull_request",
    "mcp__other__github_create_pull_request",
  ])
    equal(matcher.test(name), false, name);
});

test("the configured launcher finds the primary implementation from a linked subdirectory", (t) => {
  const f = fixture(t);
  f.install(f.primary);
  const start = f.run("SessionStart");
  match(start.hookSpecificOutput.additionalContext, /fixture-session/);
  ok(start.hookSpecificOutput.additionalContext.includes(f.linked));
  equal(f.run("Stop").decision, undefined);
  equal(
    f.run("PreToolUse", { tool_name: blockedTool }).hookSpecificOutput
      .permissionDecision,
    "deny",
  );
});

test("the configured launcher prefers the primary and falls back to the current checkout", (t) => {
  const f = fixture(t);
  for (const [root, label] of [
    [f.primary, "primary"],
    [f.linked, "linked"],
  ]) {
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(
      join(root, "scripts/agora-task.py"),
      `print('{"systemMessage":"${label}"}')\n`,
    );
  }
  equal(f.run("SessionStart").systemMessage, "primary");
  rmSync(join(f.primary, "scripts/agora-task.py"));
  equal(f.run("SessionStart").systemMessage, "linked");
});

for (const [name, implementation] of [
  ["missing", null],
  ["crashing", "raise RuntimeError('fixture failure')\n"],
  ["invalid output", "print('not json')\n"],
]) {
  test(`a ${name} implementation warns without blocking lifecycle hooks or unrelated tools`, (t) => {
    const f = fixture(t);
    if (implementation !== null) {
      mkdirSync(join(f.primary, "scripts"), { recursive: true });
      writeFileSync(join(f.primary, "scripts/agora-task.py"), implementation);
    }
    for (const event of ["SessionStart", "Stop", "Stop"]) {
      const result = f.run(event);
      match(result.systemMessage, /Agora hook.*unavailable/i);
      equal(result.decision, undefined);
    }
    const other = f.run("PreToolUse", { tool_name: "functions.exec" });
    equal(other.decision, undefined);
    equal(other.hookSpecificOutput?.permissionDecision, undefined);
    const denied = f.run("PreToolUse", { tool_name: blockedTool });
    equal(denied.hookSpecificOutput.permissionDecision, "deny");
    match(denied.hookSpecificOutput.permissionDecisionReason, /gh pr create/);
  });
}

test("malformed input and unreadable policy produce visible nonblocking warnings", (t) => {
  const f = fixture(t);
  f.install(f.primary);
  for (const payload of ["not json", "[]", '{"hook_event_name":"Unknown"}']) {
    const result = f.run("SessionStart", payload);
    match(result.systemMessage, /Agora hook/i);
    equal(result.decision, undefined);
  }
  writeFileSync(join(f.primary, ".codex/tool-policy.json"), "not json");
  match(f.run("SessionStart").systemMessage, /Agora hook/i);
  equal(f.run("Stop").decision, undefined);
  const denied = f.run("PreToolUse", { tool_name: blockedTool });
  equal(denied.hookSpecificOutput.permissionDecision, "deny");
  match(denied.systemMessage, /Agora hook/i);
});
