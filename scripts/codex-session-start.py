import json
import subprocess
import sys


def git(cwd, *args):
    return subprocess.check_output(
        ["git", "--no-optional-locks", *args],
        cwd=cwd,
        text=True,
        stderr=subprocess.DEVNULL,
    ).rstrip("\n")


def main():
    try:
        payload = json.load(sys.stdin)
        cwd = payload.get("cwd") if isinstance(payload, dict) else None
        if not isinstance(cwd, str) or not cwd:
            return
        root = git(cwd, "rev-parse", "--show-toplevel")
        branch = git(root, "branch", "--show-current")
        head = git(root, "rev-parse", "--short", "HEAD")
        dirty = bool(git(root, "status", "--porcelain", "-z"))
    except (ValueError, OSError, subprocess.CalledProcessError):
        return

    context = f"Agora 工作树：{root}\n分支：{branch or '分离 HEAD'}，HEAD：{head}。"
    if dirty:
        context += (
            "\n工作树已有改动。动手前先确认已接受的基线，"
            "按 docs/development.md 将清单保存到仓库外。"
        )
    else:
        context += "\n工作树干净。动手前记录已接受的基线提交。"
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": context,
        }
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
