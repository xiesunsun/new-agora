import { ok } from "node:assert/strict";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { waitFor } from "./wait.mjs";

/** @param {import('./fixture.mjs').Cleanup} context @param {string} document @param {string} runtime @param {{env?: NodeJS.ProcessEnv, timeoutMs?: number}} [options] */
export async function startService(context, document, runtime, options = {}) {
  await mkdir(runtime, { recursive: true });
  const logPath = join(runtime, "service.log");
  const log = createWriteStream(logPath, { flags: "a" });
  const logFinished = finished(log);
  void logFinished.catch(() => {});
  let output = "";
  /** @type {Error | undefined} */
  let startupError;
  log.on("error", (error) => {
    startupError = error;
  });
  const child = spawn(
    process.execPath,
    ["dist/run.js", "--file", document, "--runtime", runtime],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env ?? process.env,
    },
  );
  child.on("error", (error) => {
    startupError = error;
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      output = (output + String(chunk)).slice(-16000);
    });
    stream.pipe(log, { end: false });
  }
  const stopped = new Promise((resolve) =>
    child.once("close", () => resolve(true)),
  );
  /** @type {Promise<void> | undefined} */
  let stopping;
  const stop = () =>
    (stopping ??= (async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      if (
        !(await Promise.race([stopped, delay(5000, false, { ref: false })]))
      ) {
        child.kill("SIGKILL");
        if (
          !(await Promise.race([stopped, delay(5000, false, { ref: false })]))
        )
          throw new Error(
            `Service did not stop: ${child.pid}; log: ${logPath}`,
          );
      }
      log.end();
      await logFinished;
    })());
  context.after(stop);
  let connection;
  try {
    connection = await waitFor(
      async () => {
        if (startupError) throw startupError;
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error(
            `Service exited (${child.signalCode ?? child.exitCode}).`,
          );
        try {
          return JSON.parse(
            await readFile(join(runtime, "connection.json"), "utf8"),
          );
        } catch (error) {
          if (!(
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          ))
            throw error;
          return undefined;
        }
      },
      {
        description: "built service connection",
        timeoutMs: options.timeoutMs,
        diagnostics: () => output,
      },
    );
  } catch (error) {
    await stop();
    const evidence = process.env.AGORA_TEST_EVIDENCE_DIR;
    if (evidence) {
      await mkdir(evidence, { recursive: true });
      await copyFile(logPath, join(evidence, `service-${randomUUID()}.log`));
    }
    throw new Error(`${String(error)}\nService log: ${logPath}\n${output}`, {
      cause: error,
    });
  }
  const { url, workerToken } = connection;
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
