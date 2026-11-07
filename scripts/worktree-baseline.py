import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess


def git(root, *args):
    return subprocess.check_output(["git", *args], cwd=root)


def inventory(root):
    paths = git(root, "ls-files", "-z", "--cached", "--others", "--exclude-standard")
    files = {}
    for name in sorted(set(os.fsdecode(paths).split("\0")) - {""}):
        path = root / name
        if not path.parent.resolve().is_relative_to(root):
            raise ValueError(f"Path leaves the worktree: {name}")
        try:
            mode = path.lstat().st_mode
        except (FileNotFoundError, NotADirectoryError):
            continue
        digest = hashlib.sha256()
        if stat.S_ISLNK(mode):
            kind = "symlink"
            digest.update(os.fsencode(os.readlink(path)))
        elif stat.S_ISREG(mode):
            kind = "executable" if mode & stat.S_IXUSR else "file"
            with path.open("rb") as source:
                for block in iter(lambda: source.read(1024 * 1024), b""):
                    digest.update(block)
        else:
            raise ValueError(f"Unsupported worktree entry: {name}")
        files[name] = {"kind": kind, "sha256": digest.hexdigest()}
    return files


def main():
    parser = argparse.ArgumentParser(description="Capture or compare an Agora worktree baseline.")
    parser.add_argument("action", choices=("capture", "diff"))
    parser.add_argument("manifest", type=Path)
    args = parser.parse_args()

    try:
        root = Path(os.fsdecode(git(None, "rev-parse", "--show-toplevel")).rstrip("\n")).resolve()
        manifest = args.manifest.resolve()
        if manifest.is_relative_to(root):
            raise ValueError("Store the baseline outside the worktree.")
        current = inventory(root)
        if args.action == "capture":
            head = subprocess.run(
                ["git", "rev-parse", "--verify", "HEAD"],
                cwd=root, capture_output=True, text=True,
            ).stdout.strip() or None
            with manifest.open("x", encoding="utf-8") as target:
                json.dump({"head": head, "files": current}, target, indent=2)
                target.write("\n")
            print(f"Captured {len(current)} files in {manifest}")
            return
        before = json.loads(manifest.read_text(encoding="utf-8"))["files"]
        for name in sorted(before.keys() | current.keys()):
            if before.get(name) != current.get(name):
                change = "A" if name not in before else "D" if name not in current else "M"
                print(f"{change}\t{name}")
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
