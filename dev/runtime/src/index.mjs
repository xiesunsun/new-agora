import { spawnSync } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { inspectRun, stateRoot } from "./owners.mjs";
export { stateRoot } from "./owners.mjs";

/** @param {'mock'|'test'} kind */
export async function createManagedRun(kind) {
  if (kind !== "mock" && kind !== "test")
    throw new Error("Unknown managed run kind");
  const state = stateRoot();
  let ancestor = state;
  for (;;) {
    try {
      ancestor = await realpath(ancestor);
      break;
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
      ancestor = dirname(ancestor);
    }
  }
  const repository = spawnSync(
    "git",
    ["-C", ancestor, "rev-parse", "--git-dir"],
    {
      stdio: "ignore",
    },
  );
  if (repository.error) throw repository.error;
  if (repository.status === 0)
    throw new Error("Managed state directory must be outside Git repositories");
  const runs = join(state, "runs");
  await mkdir(runs, { recursive: true });
  if ((await lstat(runs)).isSymbolicLink())
    throw new Error("Managed runs directory cannot be a symlink");
  const root = await mkdtemp(join(runs, `${kind}-`));
  /** @type {import('./owners.mjs').Owner} */
  let owner = {
    version: 1,
    kind,
    pid: process.pid,
    createdAt: new Date().toISOString(),
    state: "active",
    ...(process.env.AGORA_TASK_ID ? { taskId: process.env.AGORA_TASK_ID } : {}),
  };
  try {
    await writeFile(
      join(root, "owner.json"),
      JSON.stringify(owner, null, 2) + "\n",
      { flag: "wx" },
    );
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  let released = false;
  let pending = Promise.resolve();
  /** @param {() => Promise<void>} action */
  function serialize(action) {
    const operation = pending.then(action);
    pending = operation.catch(() => {});
    return operation;
  }
  async function validate() {
    const current = await inspectRun(basename(root), state);
    if (
      current.owner.pid !== owner.pid ||
      current.owner.createdAt !== owner.createdAt ||
      current.owner.kind !== owner.kind ||
      current.owner.taskId !== owner.taskId ||
      current.owner.state !== owner.state ||
      (current.owner.state === "retained" &&
        owner.state === "retained" &&
        current.owner.reason !== owner.reason)
    )
      throw new Error("Managed run ownership changed");
  }
  return {
    root,
    release: () =>
      serialize(async () => {
        if (released) return;
        await validate();
        await rm(root, { recursive: true });
        released = true;
      }),
    /** @param {string} reason */
    retain: (reason) =>
      serialize(async () => {
        if (released) throw new Error("Managed run has already been released");
        if (!reason.trim())
          throw new Error("Retaining a run requires a reason");
        await validate();
        const retained = {
          ...owner,
          state: /** @type {const} */ ("retained"),
          reason,
        };
        await writeFile(
          join(root, "owner.json"),
          JSON.stringify(retained, null, 2) + "\n",
        );
        owner = retained;
      }),
  };
}
