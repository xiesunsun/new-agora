import { isUtf8 } from "node:buffer";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

function readMarkdownFile(path: string): { body: string; mode: number } {
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("只能打开普通 Markdown 文件。");
    const bytes = readFileSync(fd);
    if (!isUtf8(bytes)) throw new Error("文稿须为 UTF-8 编码。");
    return { body: bytes.toString("utf8"), mode: stat.mode & 0o777 };
  } finally {
    closeSync(fd);
  }
}

export function readMarkdown(path: string): string {
  return readMarkdownFile(path).body;
}

export function replaceMarkdown(
  path: string,
  expected: string,
  body: string,
): void {
  const current = readMarkdownFile(path);
  if (current.body !== expected) throw new Error("原文件已经变动。");
  writeAtomically(path, body, current.mode, expected);
}

export function writeAtomically(
  path: string,
  body: string,
  mode: number,
  expected?: string,
): void {
  const directory = dirname(path);
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${randomUUID()}.tmp`,
  );
  const fd = openSync(temporaryPath, "wx", mode);
  try {
    try {
      fchmodSync(fd, mode);
      writeFileSync(fd, body, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (expected !== undefined && readMarkdown(path) !== expected) {
      throw new Error("原文件已经变动。");
    }
    renameSync(temporaryPath, path);
    const directoryFd = openSync(directory, "r");
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}
