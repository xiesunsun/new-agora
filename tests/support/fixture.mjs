import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** @typedef {{after(cleanup: () => void | Promise<unknown>): void}} Cleanup */

/** @param {Cleanup} context @param {string} prefix @param {string} [parent] */
export async function createFixture(context, prefix, parent = tmpdir()) {
  const root = await mkdtemp(join(parent, prefix));
  /** @type {Array<() => void | Promise<unknown>>} */
  const resources = [];
  /** @type {Promise<void> | undefined} */
  let closing;
  function close() {
    closing ??= (async () => {
      const failures = [];
      for (const cleanup of [...resources].reverse()) {
        try {
          await cleanup();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length)
        throw new AggregateError(
          failures,
          `Fixture cleanup failed; retained ${root}`,
        );
      await rm(root, { recursive: true });
    })();
    return closing;
  }
  context.after(close);
  return {
    root,
    /** @param {() => void | Promise<unknown>} cleanup */
    after(cleanup) {
      if (closing) throw new Error("Fixture is already closing");
      resources.push(cleanup);
    },
    close,
  };
}
