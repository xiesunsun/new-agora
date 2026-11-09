import os
from pathlib import Path
import re
import subprocess
import sys


ROOT_FILES = {
    ".dependency-cruiser.mjs", ".gitignore", ".oxlintrc.json", ".prettierignore",
    "AGENTS.md", "README.md", "package.json", "pnpm-lock.yaml", "tsconfig.json",
}
ROOT_DIRECTORIES = {
    ".github", ".codex", "apps", "packages", "plugins", "dev", "scripts",
    "tests", "docs", "evidence",
}
LOCAL_DIRECTORIES = {".git", ".agents", "node_modules", "dist", "coverage"}
RUNTIME_FILE = re.compile(r"(?:\.(?:sqlite(?:3)?|db)(?:-(?:journal|wal|shm))?|\.log|\.pyc)$", re.I)


def violations(name):
    path = Path(name)
    if path.parts[0] not in ROOT_DIRECTORIES and name not in ROOT_FILES:
        yield "unknown repository root entry"
    if (
        any(part in {"__pycache__", "screenshots", "playwright-report", "test-results"} for part in path.parts)
        or path.name in {"connection.json", ".DS_Store"}
        or RUNTIME_FILE.search(path.name)
    ):
        yield "runtime output belongs outside the repository"
    if path.parts[0] == "evidence" and path.name not in {"README.md", "index.md"}:
        yield "evidence contains generated output instead of a Markdown index"


def main():
    try:
        root = Path(subprocess.check_output(["git", "rev-parse", "--show-toplevel"]).decode().strip())
        names = subprocess.check_output(
            ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd=root,
        )
        failures = []
        for entry in root.iterdir():
            if entry.is_dir() and entry.name not in ROOT_DIRECTORIES | LOCAL_DIRECTORIES:
                failures.append(f"{entry.name}/: unknown repository root directory")
        for name in sorted(set(os.fsdecode(names).split("\0")) - {""}):
            if not os.path.lexists(Path(root) / name):
                continue
            failures.extend(f"{name}: {reason}" for reason in violations(name))
        if failures:
            print("\n".join(failures), file=sys.stderr)
            return 1
        print("Repository contains only declared source, configuration, documentation, and fixtures.")
        return 0
    except (OSError, subprocess.CalledProcessError) as error:
        print(error, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
