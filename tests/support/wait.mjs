import { setTimeout as delay } from "node:timers/promises";

/**
 * @template T
 * @param {() => Promise<T | undefined>} read
 * @param {{description: string, timeoutMs?: number, diagnostics?: () => string}} options
 * @returns {Promise<T>}
 */
export async function waitFor(
  read,
  { description, timeoutMs = 15000, diagnostics },
) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    const remaining = deadline - performance.now();
    if (remaining <= 0)
      throw new Error(
        `Timed out waiting for ${description}. ${diagnostics?.() ?? ""}`,
      );
    await delay(Math.min(25, remaining));
  }
}
