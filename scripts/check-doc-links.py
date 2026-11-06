from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import unquote, urlsplit

root = Path(__file__).resolve().parents[1]
tracked = subprocess.check_output(
    ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "*.md"],
    cwd=root,
)
files = sorted({root / name for name in tracked.decode().split("\0") if name})

links = 0
errors = []
for source in files:
    for number, line in enumerate(source.read_text(encoding="utf-8").splitlines(), 1):
        for address in re.findall(r"\]\(([^\s)]+)\)", line):
            url = urlsplit(address)
            if url.scheme or url.netloc:
                continue
            links += 1
            target = (source.parent / unquote(url.path)).resolve() if url.path else source
            if not target.is_relative_to(root) or not target.is_file():
                errors.append(f"{source.relative_to(root)}:{number}: missing file: {address}")
                continue
            if not url.fragment or target.suffix != ".md":
                continue
            headings = re.findall(r"^#{1,6} +(.+)$", target.read_text(encoding="utf-8"), re.M)
            anchors = {re.sub(r"[^\w\s-]", "", title.lower()).replace(" ", "-") for title in headings}
            if unquote(url.fragment) not in anchors:
                errors.append(f"{source.relative_to(root)}:{number}: missing heading: {address}")

if errors:
    sys.exit("\n".join(errors))
print(f"Checked {len(files)} Markdown files and {links} local links.")
