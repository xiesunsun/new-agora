import { copyFile, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { startService } from "../apps/service/src/server.js";
import { startScriptedWorker } from "../apps/worker/src/index.js";

const { values } = parseArgs({
  options: {
    file: { type: "string" },
    runtime: { type: "string" },
    port: { type: "string", default: "0" },
  },
});

const demo = values.file === undefined && values.runtime === undefined;
if (!demo && (!values.file || !values.runtime)) {
  throw new Error(
    "Pass --file and --runtime together, or omit both to use the A01 test copy.",
  );
}

const port = z.coerce.number().int().min(0).max(65535).parse(values.port);
const paths =
  values.file && values.runtime
    ? {
        originalPath: resolve(values.file),
        runtimeDir: resolve(values.runtime),
      }
    : await demoPaths();
const { originalPath, runtimeDir } = paths;

async function demoPaths() {
  const temp = await mkdtemp(join(tmpdir(), "agora-a01-"));
  const originalPath = join(temp, "manuscript.md");
  await copyFile(
    new URL("../tests/fixtures/a01/original.md", import.meta.url),
    originalPath,
  );
  return { originalPath, runtimeDir: join(temp, "runtime") };
}

const panelDir = fileURLToPath(new URL("./panel/", import.meta.url));
const service = await startService({
  originalPath,
  runtimeDir,
  panelDir,
  port,
});

const controller = new AbortController();
async function stop() {
  controller.abort();
  await service.close();
}
process.once("SIGINT", () => {
  void stop();
});
process.once("SIGTERM", () => {
  void stop();
});

console.log(`Agora: ${service.url}`);
console.log(`Markdown: ${originalPath}`);
console.log(`Runtime: ${runtimeDir}`);

if (demo) {
  const connection = z
    .object({ workerToken: z.string() })
    .parse(
      JSON.parse(await readFile(join(runtimeDir, "connection.json"), "utf8")),
    );
  void startScriptedWorker(
    service.url,
    connection.workerToken,
    controller.signal,
  ).catch(async (error: unknown) => {
    if (controller.signal.aborted) return;
    console.error(error);
    process.exitCode = 1;
    await stop();
  });
}
