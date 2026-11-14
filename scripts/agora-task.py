import argparse
import functools
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import subprocess
import sys


SCRIPT_ROOT = Path(__file__).resolve().parent
INVENTORY = runpy.run_path(str(SCRIPT_ROOT / "worktree-baseline.py"))["inventory"]
POLICY = SCRIPT_ROOT.parent / ".codex" / "tool-policy.json"


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def write(path, value, exclusive=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    content = json.dumps(value, ensure_ascii=False, indent=2) + "\n"
    if exclusive:
        with path.open("x", encoding="utf-8") as target:
            target.write(content)
    else:
        temporary = path.with_name(path.name + f".{os.getpid()}.tmp")
        try:
            temporary.write_text(content, encoding="utf-8")
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)


def git(root, *args):
    return subprocess.check_output(["git", "--no-optional-locks", *args], cwd=root, stderr=subprocess.DEVNULL).decode().rstrip("\n")


def repo(cwd):
    return Path(git(cwd, "rev-parse", "--show-toplevel")).resolve()


def identity(root):
    return str((root / git(root, "rev-parse", "--git-common-dir")).resolve())


@functools.lru_cache(maxsize=1)
def state_root():
    value = os.environ.get("AGORA_STATE_DIR")
    if value is None:
        base = Path(os.environ.get("XDG_STATE_HOME", str(Path.home() / ".local" / "state")))
        value = str(base / "agora")
    path = Path(value)
    if not path.is_absolute():
        raise ValueError("AGORA_STATE_DIR and XDG_STATE_HOME must be absolute paths")
    path = path.resolve()
    ancestor = path
    while not ancestor.exists():
        ancestor = ancestor.parent
    probe = subprocess.run(
        ["git", "-C", str(ancestor), "rev-parse", "--git-dir"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    if probe.returncode == 0:
        raise ValueError("Managed state directory must be outside Git repositories")
    return path


def state_path(*parts):
    root = state_root()
    path = root
    for part in parts:
        path = path / part
        if path.is_symlink():
            raise ValueError("Managed state path cannot contain a symlink")
    if not path.resolve().is_relative_to(root):
        raise ValueError("Managed state path leaves the state directory")
    return path


def task_dir(task_id):
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", task_id):
        raise ValueError("Task id must be safe lower-case kebab text")
    return state_path("tasks", task_id)


def session_path(session):
    return state_path("sessions", hashlib.sha256(session.encode()).hexdigest() + ".json")


def text(value, label):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} requires meaningful text")
    return value


def task_runs(task):
    runs = {}
    for marker in sorted(state_path("runs").glob("*/owner.json")):
        marker = state_path("runs", marker.parent.name, "owner.json")
        owner = read(marker)
        if owner.get("taskId") == task["id"]:
            runs[str(marker.parent.resolve())] = owner
    return runs


def validate_report(report, task, snapshot):
    if not isinstance(report, dict) or report.get("task_id") != task["id"]:
        raise ValueError("task_id must match the task")
    for field, current in (("reviewed_head", snapshot["head"]), ("reviewed_worktree_digest", snapshot["full_worktree_digest"])):
        if report.get(field) != current:
            raise ValueError(f"{field} must match current status; review again after changes")
    text(report.get("summary"), "summary")
    findings = report.get("findings", [])
    if not isinstance(findings, list):
        raise ValueError("findings must be a list")
    if not findings:
        text(report.get("no_findings_reason"), "no_findings_reason")
    root = Path(task["execution_root"])
    for finding in findings:
        text(finding.get("observation"), "finding observation")
        text(finding.get("basis"), "finding basis")
        resolution = finding.get("resolution", {})
        if resolution.get("kind") == "no-change":
            text(resolution.get("reason"), "no-change reason")
        elif resolution.get("kind") == "applied":
            paths = resolution.get("rule_paths")
            if not isinstance(paths, list) or not paths:
                raise ValueError("applied findings require rule_paths")
            for name in paths:
                path = Path(text(name, "rule path"))
                if path.is_absolute() or not (root / path).resolve().is_relative_to(root) or not (root / path).is_file():
                    raise ValueError("Applied rule paths must be existing repository-relative files")
        else:
            raise ValueError("finding resolution kind must be applied or no-change")
    checks = report.get("checks")
    if not isinstance(checks, list) or not checks:
        raise ValueError("checks must be a nonempty list with command, result, and evidence")
    evidence = {}
    for check in checks:
        text(check.get("command"), "check command")
        if check.get("result") not in ("passed", "not-run"):
            raise ValueError("Checks must be passed or explicitly not-run; failed checks prevent completion")
        if check["result"] == "not-run":
            text(check.get("reason"), "not-run reason")
        path = Path(text(check.get("evidence"), "check evidence"))
        path = path if path.is_absolute() else root / path
        evidence[str(path.resolve())] = hashlib.sha256(path.read_bytes()).hexdigest()
    resources = report.get("resources")
    if not isinstance(resources, list):
        raise ValueError("resources must be a list with explicit dispositions")
    listed = {}
    for resource in resources:
        path = Path(text(resource.get("path"), "resource path"))
        if not path.is_absolute():
            raise ValueError("Resource paths must be absolute")
        name = str(path.resolve())
        if name in listed:
            raise ValueError("Resource paths must be unique")
        text(resource.get("reason"), "resource reason")
        if resource.get("disposition") == "disposed":
            if path.exists() or path.is_symlink():
                raise ValueError(f"Disposed resource still exists: {path}")
        elif resource.get("disposition") == "retained":
            if not path.exists():
                raise ValueError(f"Retained resource is missing: {path}")
            text(resource.get("cleanup"), "retained resource exact cleanup command")
        else:
            raise ValueError("Resource disposition must be disposed or retained")
        listed[name] = resource
    surviving = task_runs(task)
    if set(surviving) - set(listed):
        raise ValueError("List every surviving task-tagged managed run in resources")
    benchmark = report.get("benchmark", {})
    if not re.fullmatch(r"[a-fA-F0-9]{40}", benchmark.get("source_commit", "")):
        raise ValueError("benchmark.source_commit must be a pinned 40-hex commit")
    sources = benchmark.get("reviewed_sources")
    if not isinstance(sources, list) or not sources:
        raise ValueError("benchmark.reviewed_sources must list the reviewed pinned sources")
    for source in sources:
        text(source, "reviewed source")
    text(benchmark.get("comparison"), "benchmark comparison with DeepSeek")
    return {"checks_sha256": digest(evidence), "resources_sha256": digest({"report": resources, "surviving_runs": surviving})}


def snapshot(task):
    root = Path(task["execution_root"])
    return {"head": git(root, "rev-parse", "HEAD"), "full_worktree_digest": digest(INVENTORY(root))}


def receipt_for(task, report, current):
    return {"version": 1, "task_binding_sha256": digest(task), "report_sha256": digest(report), **current, **validate_report(report, task, current)}


def status(task, folder):
    current = snapshot(task)
    missing = []
    receipt = folder / "receipt.json"
    reflection = folder / "reflection.json"
    complete = False
    if reflection.exists():
        try:
            expected = receipt_for(task, read(reflection), current)
            complete = receipt.exists() and read(receipt) == expected
            if not complete:
                missing.append("A current receipt is required")
        except (ValueError, OSError, TypeError, KeyError, AttributeError) as error:
            missing.append(str(error))
    else:
        missing.append("Submit --report JSON with task_id, reviewed_head, reviewed_worktree_digest, summary, findings or no_findings_reason, checks, resources, and benchmark")
    return {"task_id": task["id"], "execution_root": task["execution_root"], "owner_session": task["owner_session"], "auto_stop": task["owner_session"] is not None, "state": "complete" if complete else "stale" if receipt.exists() else "close-requested" if (folder / "close-request.json").exists() else "active", **current, "missing": missing}


def begin(args):
    root = repo(Path.cwd())
    folder = task_dir(args.task_id)
    baseline = state_path("tasks", args.task_id, "baseline.json")
    if folder.is_relative_to(root):
        raise ValueError("Task state must be outside the worktree")
    session = args.session
    if session:
        marker = read(session_path(session))
        if marker.get("binding_source") != "hook-stdin" or marker.get("git_common_dir") != identity(root):
            raise ValueError("Session must be observed by SessionStart in the same repository")
    binding = folder / "task.json"
    if binding.exists():
        task = read(binding)
        if task["execution_root"] != str(root) or (args.accepted_head and git(root, "rev-parse", "--verify", args.accepted_head + "^{commit}") != task["accepted_head"]):
            raise ValueError("Task already has a different repository or accepted baseline")
        if args.baseline and (args.baseline.resolve().is_relative_to(root) or read(args.baseline.resolve()) != read(folder / "baseline.json")):
            raise ValueError("Existing baseline differs; it cannot be overwritten")
        if session and task["owner_session"] is not None and task["owner_session"] != session:
            raise ValueError("Task already has a different session binding")
        if session and task["owner_session"] is None:
            task.update(owner_session=session, binding_source="hook-stdin")
            write(binding, task)
        print(json.dumps(status(task, folder)))
        return
    head = git(root, "rev-parse", "--verify", (args.accepted_head or "HEAD") + "^{commit}")
    task = {"version": 1, "id": args.task_id, "execution_root": str(root), "accepted_head": head, "begin_branch": git(root, "branch", "--show-current"), "owner_session": session, "binding_source": "hook-stdin" if session else "unbound-cli"}
    folder.mkdir(parents=True, exist_ok=True)
    if args.baseline:
        original = args.baseline.resolve()
        if original.is_relative_to(root):
            raise ValueError("Baseline must be outside the worktree")
        captured = read(original)
        if captured.get("head") != head or not isinstance(captured.get("files"), dict):
            raise ValueError("Baseline must contain files and match accepted_head")
        if not baseline.exists():
            write(baseline, captured, exclusive=True)
        elif read(baseline) != captured:
            raise ValueError("Existing baseline differs; it cannot be overwritten")
    elif not baseline.exists():
        subprocess.run([sys.executable, str(SCRIPT_ROOT / "worktree-baseline.py"), "capture", str(baseline)], cwd=root, check=True, stdout=subprocess.DEVNULL)
    if read(baseline).get("head") != head:
        raise ValueError("Captured baseline HEAD differs; supply an accepted external --baseline")
    write(binding, task, exclusive=True)
    print(json.dumps(status(task, folder)))


def pending(session):
    for binding in sorted(state_path("tasks").glob("*/task.json")):
        binding = task_dir(binding.parent.name) / "task.json"
        task = read(binding)
        if task.get("owner_session") != session or task.get("binding_source") != "hook-stdin":
            continue
        marker = read(session_path(session))
        if marker.get("git_common_dir") != identity(Path(task["execution_root"])):
            continue
        folder = binding.parent
        if (folder / "close-request.json").exists() and status(task, folder)["state"] != "complete":
            yield task, folder


def hook():
    payload = {}
    try:
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict):
            raise ValueError("Hook input must be an object")
        event = payload.get("hook_event_name")
        if event not in ("PreToolUse", "SessionStart", "Stop"):
            raise ValueError("Unknown hook event")
        if event == "PreToolUse":
            text(payload.get("tool_name"), "PreToolUse tool_name")
            for tool in read(POLICY)["blocked_tools"]:
                if payload.get("tool_name") == tool["name"]:
                    return {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": tool["reason"]}}
            return {}
        session = payload.get("session_id")
        if not isinstance(session, str) or not session.strip():
            raise ValueError("Hook session_id is required")
        if event == "SessionStart":
            cwd = payload.get("cwd")
            if not isinstance(cwd, str) or not cwd.strip():
                raise ValueError("SessionStart cwd is required")
            root = repo(cwd)
            write(session_path(session), {"session_id": session, "git_common_dir": identity(root), "execution_root": str(root), "binding_source": "hook-stdin"})
            dirty = bool(git(root, "status", "--porcelain", "-z"))
            context = f"Agora 工作树：{root}\n分支：{git(root, 'branch', '--show-current') or '分离 HEAD'}，HEAD：{git(root, 'rev-parse', '--short', 'HEAD')}。\nObserved hook session_id: {session}. This marker does not prove hook configuration activation elsewhere."
            context += "\n工作树已有改动。开工前将已接受的基线清单保存到仓库外。" if dirty else "\n工作树干净。动手前记录已接受的基线提交。"
            context += "\n" + "\n".join(tool["name"] + ": " + tool["reason"] for tool in read(POLICY)["blocked_tools"])
            tasks = [task["id"] for task, _ in pending(session)]
            if tasks:
                context += "\nPending explicit task closeout: " + ", ".join(tasks)
            return {"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": context}}
        if event == "Stop":
            tasks = list(pending(session))
            if not tasks:
                return {}
            warnings = []
            for task, folder in tasks:
                if payload.get("stop_hook_active"):
                    warnings.append(task["id"])
                    continue
                try:
                    write(folder / "stop-issued.json", {"version": 1}, exclusive=True)
                except FileExistsError:
                    warnings.append(task["id"])
                    continue
                return {"decision": "block", "reason": f"Explicit closeout for {task['id']} is incomplete. In {task['execution_root']}, perform reflection, compare the pinned DeepSeek sources, record applied rule paths or explain no change, record checks and resource cleanup, then run python3 scripts/agora-task.py status {task['id']} and close {task['id']} --report <file>. Do not claim completion without a current receipt."}
            return {"systemMessage": "Task closeout incomplete: " + ", ".join(warnings) + ". Continuing without another blocking reminder."}
    except (ValueError, OSError, subprocess.SubprocessError, TypeError, KeyError, AttributeError) as error:
        output = {"systemMessage": f"Agora hook warning: checks were not completed ({type(error).__name__}: {error})."}
        if isinstance(payload, dict) and payload.get("hook_event_name") == "PreToolUse" and payload.get("tool_name") == "mcp__codex_apps__github_create_pull_request":
            output["hookSpecificOutput"] = {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "Agora tool policy could not be checked. This restricted method remains denied; use gh pr create."}
        return output
    return {}


def main():
    parser = argparse.ArgumentParser(description="Explicit Agora task binding, review, and closeout receipts")
    commands = parser.add_subparsers(dest="action", required=True)
    start = commands.add_parser("begin")
    start.add_argument("task_id")
    start.add_argument("--session")
    start.add_argument("--accepted-head")
    start.add_argument("--baseline", type=Path)
    commands.add_parser("hook")
    commands.add_parser("status").add_argument("task_id")
    close = commands.add_parser("close")
    close.add_argument("task_id")
    close.add_argument("--report", "--reflection", dest="report", type=Path)
    args = parser.parse_args()
    try:
        if args.action == "hook":
            print(json.dumps(hook(), ensure_ascii=False))
        elif args.action == "begin":
            begin(args)
        else:
            folder = task_dir(args.task_id)
            task = read(folder / "task.json")
            if str(repo(Path.cwd())) != task["execution_root"]:
                raise ValueError("Run this command in the task's bound execution_root")
            if args.action == "close":
                if not (folder / "close-request.json").exists():
                    write(folder / "close-request.json", {"version": 1}, exclusive=True)
                if args.report:
                    report = read(args.report)
                    receipt = receipt_for(task, report, snapshot(task))
                    write(folder / "reflection.json", report)
                    if receipt_for(task, report, snapshot(task)) != receipt:
                        raise ValueError("Worktree or evidence changed while closing; review current status")
                    write(folder / "receipt.json", receipt)
                else:
                    print(json.dumps(status(task, folder)))
                    parser.exit(1, "Closeout requested. Submit --report JSON with reflection, checks, resources, and pinned DeepSeek comparison.\n")
            print(json.dumps(status(task, folder)))
    except (OSError, ValueError, subprocess.SubprocessError, TypeError, KeyError, AttributeError) as error:
        parser.exit(1, str(error) + "\n")


if __name__ == "__main__":
    main()
