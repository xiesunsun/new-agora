import { equal, ok } from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** @param {string} path @param {import("node:child_process").ChildProcess} child */
async function connectionAt(path, child) {
  for (let attempt = 0; attempt < 100; attempt++) {
    equal(
      child.exitCode,
      null,
      "built service exited before publishing its connection",
    );
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        throw error;
      await delay(30);
    }
  }
  throw new Error("built service did not publish its connection");
}

/** @param {import("node:test").TestContext} context @param {string} document @param {string} runtime */
export async function startService(context, document, runtime) {
  const child = spawn(
    process.execPath,
    ["dist/run.js", "--file", document, "--runtime", runtime],
    {
      stdio: "ignore",
    },
  );
  const stopped = new Promise((resolve) => child.once("close", resolve));
  const stop = async () => {
    child.kill();
    await stopped;
  };
  context.after(stop);
  const { url, workerToken } = await connectionAt(
    join(runtime, "connection.json"),
    child,
  );
  /** @param {string} path @param {object} [command] */
  async function request(path, command) {
    const response = await fetch(
      new URL(path, url),
      command && {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(path === "/api/worker"
            ? { authorization: `Bearer ${workerToken}` }
            : {}),
        },
        body: JSON.stringify(command),
      },
    );
    const data = await response.json();
    ok(response.ok, JSON.stringify(data));
    return data;
  }

  return { request, stop, url };
}
