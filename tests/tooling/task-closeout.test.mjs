import { equal, deepEqual, match } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const script = resolve("scripts/agora-task.py");
/**
 * @typedef {{command: string, result: string, evidence: string, reason?: string}} Check
 * @typedef {{path: string, disposition: string, reason: string, cleanup?: string}} Resource
 * @typedef {{observation: string, basis: string, resolution: {kind: string, rule_paths?: string[], reason?: string}}} Finding
 * @typedef {{[key: string]: unknown, task_id: string, reviewed_head: string, reviewed_worktree_digest: string, summary: string, no_findings_reason: string, checks: Check[], resources: Resource[], findings?: Finding[], benchmark: {source_commit: string, reviewed_sources: string[], comparison: string}}} Reflection
 */

/** @param {import('node:test').TestContext} t */
function fixture(t) {
  const base = join(
    process.env.AGORA_STATE_DIR ?? join(homedir(), ".local/state/agora"),
    "tasks/task-closeout-tests/scratch",
  );
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, "fixture-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo");
  mkdirSync(repo);
  const state = join(dir, "state");
  /** @param {string[]} args */
  function git(...args) {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(repo, "rule.md"), "Use explicit ownership.\n");
  git("add", ".");
  git("commit", "-qm", "fixture");
  /** @param {string[]} args */
  function run(...args) {
    return spawnSync("python3", [script, ...args], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, AGORA_STATE_DIR: state },
    });
  }
  /** @param {unknown} payload */
  function hook(payload) {
    const result = spawnSync("python3", [script, "hook"], {
      cwd: repo,
      encoding: "utf8",
      input:
        typeof payload === "string"
          ? payload
          : JSON.stringify(
              typeof payload === "object" &&
                payload !== null &&
                !Array.isArray(payload)
                ? { cwd: repo, ...payload }
                : payload,
            ),
      env: { ...process.env, AGORA_STATE_DIR: state },
    });
    equal(result.status, 0, result.stderr);
    return result.stdout.trim() ? JSON.parse(result.stdout) : {};
  }
  function status() {
    const result = run("status", "example");
    equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }
  /** @returns {Reflection} */
  function report() {
    const snapshot = status();
    const evidence = join(dir, "checks.log");
    writeFileSync(evidence, "CLI fixture passed.\n");
    return {
      task_id: "example",
      reviewed_head: snapshot.head,
      reviewed_worktree_digest: snapshot.full_worktree_digest,
      summary: "Verified explicit task closeout behavior.",
      no_findings_reason:
        "No additional repository rules were justified by the reviewed change.",
      checks: [
        {
          command: "node --test tests/tooling/task-closeout.test.mjs",
          result: "passed",
          evidence,
        },
      ],
      resources: [],
      benchmark: {
        source_commit: "a".repeat(40),
        reviewed_sources: [
          "https://github.com/deepseek-ai/DeepSeek-V3/blob/" +
            "a".repeat(40) +
            "/README.md",
        ],
        comparison:
          "Compared explicit evidence and local ownership against the pinned DeepSeek sources.",
      },
    };
  }
  /** @param {unknown} value */
  function close(value) {
    const path = join(dir, "report.json");
    writeFileSync(path, JSON.stringify(value));
    return run("close", "example", "--report", path);
  }
  return { repo, dir, state, git, run, hook, status, report, close };
}

test("ordinary hooks remain silent, invalid inputs warn, and the exact blocked tool uses deny JSON", (t) => {
  const f = fixture(t);
  deepEqual(f.hook({ hook_event_name: "Stop", session_id: "observed" }), {});
  match(f.hook("not json").systemMessage, /Agora hook warning/);
  match(f.hook([]).systemMessage, /Agora hook warning/);
  match(
    f.hook({ hook_event_name: "SubagentStop" }).systemMessage,
    /Agora hook warning/,
  );
  deepEqual(
    f.hook({
      hook_event_name: "PreToolUse",
      tool_name: "mcp__other__github_create_pull_request",
    }),
    {},
  );
  const denied = f.hook({
    hook_event_name: "PreToolUse",
    tool_name: "mcp__codex_apps__github_create_pull_request",
  });
  equal(denied.hookSpecificOutput.permissionDecision, "deny");
  match(denied.hookSpecificOutput.permissionDecisionReason, /gh/);
});

test("begin is idempotent, preserves its baseline, and rejects unobserved or foreign sessions", (t) => {
  const f = fixture(t);
  equal(f.run("begin", "bad/id").status, 1);
  equal(f.run("begin", "example", "--session", "native-chat-uuid").status, 1);
  const start = f.hook({
    hook_event_name: "SessionStart",
    session_id: "observed",
    source: "resume",
  });
  match(start.hookSpecificOutput.additionalContext, /observed/);
  equal(f.run("begin", "example", "--session", "observed").status, 0);
  const path = join(f.state, "tasks/example/baseline.json");
  const before = readFileSync(path, "utf8");
  writeFileSync(join(f.repo, "later.txt"), "changed");
  equal(f.run("begin", "example", "--session", "observed").status, 0);
  equal(readFileSync(path, "utf8"), before);
  equal(f.run("begin", "example").status, 0);
  equal(f.status().owner_session, "observed");
  const foreign = join(f.dir, "foreign");
  mkdirSync(foreign);
  spawnSync("git", ["init", "-q", foreign]);
  f.hook({
    hook_event_name: "SessionStart",
    session_id: "foreign",
    cwd: foreign,
  });
  equal(f.run("begin", "foreign-task", "--session", "foreign").status, 1);
});

test("explicit close intent nudges its observed session once and protects reentrant Stop", (t) => {
  const f = fixture(t);
  f.hook({ hook_event_name: "SessionStart", session_id: "owner" });
  equal(f.run("begin", "example", "--session", "owner").status, 0);
  equal(f.run("close", "example").status, 1);
  deepEqual(f.hook({ hook_event_name: "Stop", session_id: "other" }), {});
  deepEqual(
    f.hook({
      hook_event_name: "Stop",
      session_id: "owner",
      stop_hook_active: true,
    }).decision,
    undefined,
  );
  const block = f.hook({
    hook_event_name: "Stop",
    session_id: "owner",
    cwd: "/does-not-exist",
  });
  equal(block.decision, "block");
  match(block.reason, /DeepSeek/);
  const repeated = f.hook({ hook_event_name: "Stop", session_id: "owner" });
  equal(repeated.decision, undefined);
  match(repeated.systemMessage, /incomplete/i);
  equal(existsSync(join(f.state, "tasks/example/receipt.json")), false);
});

test("unbound CLI tasks can close but never infer ownership for Stop", (t) => {
  const f = fixture(t);
  equal(f.run("begin", "example").status, 0);
  equal(f.status().auto_stop, false);
  equal(f.run("close", "example").status, 1);
  deepEqual(
    f.hook({ hook_event_name: "Stop", session_id: "native-chat-uuid" }),
    {},
  );
  equal(f.close(f.report()).status, 0);
  equal(f.status().state, "complete");
});

test("final receipts bind report contents, HEAD, inventory, evidence, and resource state", (t) => {
  const f = fixture(t);
  equal(f.run("begin", "example").status, 0);
  equal(f.run("close", "example").status, 1);
  writeFileSync(
    join(f.repo, "fix.txt"),
    "reflection may fix rules after intent",
  );
  const report = f.report();
  equal(f.close(report).status, 0);
  equal(f.close(report).status, 0);
  equal(f.status().state, "complete");
  writeFileSync(join(f.repo, "fix.txt"), "newer");
  equal(f.status().state, "stale");
  equal(f.close(report).status, 1);
  equal(f.close(f.report()).status, 0);
  f.git("add", ".");
  f.git("commit", "-qm", "after review");
  equal(f.status().state, "stale");
  equal(f.close(f.report()).status, 0);
  const reflection = join(f.state, "tasks/example/reflection.json");
  const changed = JSON.parse(readFileSync(reflection, "utf8"));
  changed.summary = "Altered after receipt.";
  writeFileSync(reflection, JSON.stringify(changed));
  equal(f.status().state, "stale");
});

test("reports reject missing, failed, invented evidence, and invalid rule findings", (t) => {
  const f = fixture(t);
  equal(f.run("begin", "example").status, 0);
  for (const field of [
    "summary",
    "checks",
    "resources",
    "benchmark",
    "no_findings_reason",
    "reviewed_head",
    "reviewed_worktree_digest",
  ]) {
    const report = f.report();
    delete report[field];
    equal(f.close(report).status, 1, field);
  }
  let report = f.report();
  report.checks[0].result = "failed";
  equal(f.close(report).status, 1);
  report = f.report();
  report.checks[0].evidence += ".missing";
  equal(f.close(report).status, 1);
  report = f.report();
  report.findings = [
    {
      observation: "Rule needed.",
      basis: "Reviewed implementation.",
      resolution: { kind: "applied", rule_paths: ["../outside.md"] },
    },
  ];
  equal(f.close(report).status, 1);
  report.findings[0].resolution.rule_paths = ["rule.md"];
  equal(f.close(report).status, 0);
  report = f.report();
  report.checks[0] = {
    command: "host hook activation",
    result: "not-run",
    reason: "Requires host trust approval.",
    evidence: report.checks[0].evidence,
  };
  equal(f.close(report).status, 0);
});

test("surviving task resources require retention with reason and an exact cleanup command", (t) => {
  const f = fixture(t);
  equal(f.run("begin", "example").status, 0);
  const resource = join(f.state, "runs/test-owned");
  mkdirSync(resource, { recursive: true });
  writeFileSync(
    join(resource, "owner.json"),
    JSON.stringify({
      version: 1,
      kind: "test",
      pid: process.pid,
      createdAt: new Date().toISOString(),
      state: "retained",
      reason: "Review evidence",
      taskId: "example",
    }),
  );
  let report = f.report();
  equal(f.close(report).status, 1);
  report.resources = [
    { path: resource, disposition: "disposed", reason: "Removed" },
  ];
  equal(f.close(report).status, 1);
  report.resources[0] = {
    path: resource,
    disposition: "retained",
    reason: "Review evidence",
  };
  equal(f.close(report).status, 1);
  report.resources[0].cleanup = "pnpm clean:dev --remove test-owned";
  equal(f.close(report).status, 0);
  rmSync(resource, { recursive: true });
  equal(f.status().state, "stale");
  report = f.report();
  report.resources = [
    { path: resource, disposition: "disposed", reason: "Removed owned run." },
  ];
  equal(f.close(report).status, 0);
});

test("begin can bind an observed session later without replacing the accepted baseline", (t) => {
  const f = fixture(t);
  equal(f.run("begin", "example").status, 0);
  const baseline = readFileSync(
    join(f.state, "tasks/example/baseline.json"),
    "utf8",
  );
  f.git("commit", "--allow-empty", "-qm", "later HEAD");
  equal(f.run("begin", "example").status, 0);
  f.hook({ hook_event_name: "SessionStart", session_id: "later-session" });
  equal(f.run("begin", "example", "--session", "later-session").status, 0);
  equal(f.status().auto_stop, true);
  equal(
    readFileSync(join(f.state, "tasks/example/baseline.json"), "utf8"),
    baseline,
  );
});

test("begin can reuse an external accepted inventory and rejects replacement baselines", (t) => {
  const f = fixture(t);
  const baseline = join(f.dir, "before.json");
  const capture = spawnSync(
    "python3",
    [resolve("scripts/worktree-baseline.py"), "capture", baseline],
    { cwd: f.repo, encoding: "utf8" },
  );
  equal(capture.status, 0, capture.stderr);
  const accepted = f.git("rev-parse", "HEAD");
  writeFileSync(join(f.repo, "already-in-flight.txt"), "Another owner's edit.");
  f.git("add", ".");
  f.git("commit", "-qm", "intervening work");
  equal(
    f.run(
      "begin",
      "example",
      "--accepted-head",
      accepted,
      "--baseline",
      baseline,
    ).status,
    0,
  );
  equal(
    readFileSync(join(f.state, "tasks/example/baseline.json"), "utf8"),
    readFileSync(baseline, "utf8"),
  );
  const other = join(f.dir, "other.json");
  writeFileSync(other, JSON.stringify({ head: accepted, files: {} }));
  equal(f.run("begin", "example", "--baseline", other).status, 1);
});

test("fresh completed tasks allow Stop and changed external check evidence invalidates receipts", (t) => {
  const f = fixture(t);
  f.hook({ hook_event_name: "SessionStart", session_id: "owner" });
  equal(f.run("begin", "example", "--session", "owner").status, 0);
  const report = f.report();
  equal(f.close(report).status, 0);
  deepEqual(f.hook({ hook_event_name: "Stop", session_id: "owner" }), {});
  writeFileSync(report.checks[0].evidence, "Evidence changed after review.");
  equal(f.status().state, "stale");
  equal(
    f.hook({ hook_event_name: "Stop", session_id: "owner" }).decision,
    "block",
  );
});

test("task and session state cannot write inside a Git checkout", (t) => {
  const f = fixture(t);
  const state = join(f.repo, "generated-state");
  const options = {
    cwd: f.repo,
    encoding: /** @type {const} */ ("utf8"),
    env: { ...process.env, AGORA_STATE_DIR: state },
  };
  const started = spawnSync("python3", [script, "begin", "example"], options);
  equal(started.status, 1);
  equal(existsSync(state), false);
  const observed = spawnSync("python3", [script, "hook"], {
    ...options,
    input: JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "fixture-session",
      cwd: f.repo,
    }),
  });
  equal(observed.status, 0);
  match(JSON.parse(observed.stdout).systemMessage, /outside Git repositories/);
  equal(existsSync(state), false);
});

test("task and session directories reject symlink escapes", (t) => {
  const f = fixture(t);
  mkdirSync(f.state, { recursive: true });
  symlinkSync(f.repo, join(f.state, "tasks"));
  equal(f.run("begin", "example").status, 1);
  equal(existsSync(join(f.repo, "example")), false);
  symlinkSync(f.repo, join(f.state, "sessions"));
  const observed = f.hook({
    hook_event_name: "SessionStart",
    session_id: "fixture-session",
  });
  match(observed.systemMessage, /state path/i);
  deepEqual(
    spawnSync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd: f.repo,
      encoding: "utf8",
    }).stdout,
    "",
  );
});

test("a dangling baseline symlink cannot create an external file", (t) => {
  const f = fixture(t);
  const folder = join(f.state, "tasks/example");
  const outside = join(f.dir, "unexpected-baseline.json");
  mkdirSync(folder, { recursive: true });
  symlinkSync(outside, join(folder, "baseline.json"));
  const result = f.run("begin", "example");
  equal(result.status, 1);
  match(result.stderr, /state path.*symlink/i);
  equal(existsSync(outside), false);
});
