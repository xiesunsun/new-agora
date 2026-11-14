import { lstat, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** @typedef {{version: 1, kind: 'mock'|'test', pid: number, createdAt: string, taskId?: string} & ({state: 'active'} | {state: 'retained', reason: string})} Owner */

export function stateRoot() {
  const root =
    process.env.AGORA_STATE_DIR ??
    join(
      process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
      "agora",
    );
  if (!isAbsolute(root))
    throw new Error(
      "AGORA_STATE_DIR and XDG_STATE_HOME must be absolute paths",
    );
  return root;
}

/** @param {unknown} value @returns {Owner} */
function parseOwner(value) {
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== 1 ||
    !("kind" in value) ||
    (value.kind !== "mock" && value.kind !== "test") ||
    !("pid" in value) ||
    typeof value.pid !== "number" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    !("createdAt" in value) ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    ("taskId" in value && typeof value.taskId !== "string")
  )
    throw new Error("Invalid managed run owner");
  /** @type {Pick<Owner, "version" | "kind" | "pid" | "createdAt" | "taskId">} */
  const base = {
    version: /** @type {const} */ (1),
    kind: value.kind,
    pid: value.pid,
    createdAt: value.createdAt,
    ...("taskId" in value && typeof value.taskId === "string"
      ? { taskId: value.taskId }
      : {}),
  };
  if ("state" in value && value.state === "active")
    return { ...base, state: "active" };
  if (
    "state" in value &&
    value.state === "retained" &&
    "reason" in value &&
    typeof value.reason === "string" &&
    value.reason.trim()
  )
    return { ...base, state: "retained", reason: value.reason };
  throw new Error("Invalid managed run state");
}

/** @param {string} name @param {string} [state] */
export async function inspectRun(name, state = stateRoot()) {
  if (!/^(mock|test)-[A-Za-z0-9]+$/.test(name))
    throw new Error("Pass one exact managed run name");
  const runs = join(state, "runs");
  const root = join(runs, name);
  for (const path of [runs, root]) {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Managed run path must be a real directory");
  }
  if ((await realpath(root)) !== join(await realpath(runs), name))
    throw new Error("Managed run escapes runs directory");
  const marker = join(root, "owner.json");
  const stat = await lstat(marker);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("Managed run marker must be a real file");
  const owner = parseOwner(JSON.parse(await readFile(marker, "utf8")));
  if (!name.startsWith(`${owner.kind}-`))
    throw new Error("Managed run kind does not match its name");
  return { root, owner };
}

/** @param {number} pid */
export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH")
      return false;
    if (error instanceof Error && "code" in error && error.code === "EPERM")
      return true;
    throw error;
  }
}
