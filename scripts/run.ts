import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { startService } from "../apps/service/src/server.js";
import { startScriptedWorker } from "../apps/worker/src/index.js";
import { viewSchema } from "../packages/contracts/src/index.js";
import { prepareMock } from "../dev/mock/index.js";

const { values } = parseArgs({
  args: process.argv.slice(2).filter((value) => value !== "--"),
  options: {
    file: { type: "string" },
    runtime: { type: "string" },
    port: { type: "string", default: "0" },
    mock: { type: "boolean", default: false },
    config: { type: "string" },
    "retain-run": { type: "boolean", default: false },
  },
});

const explicit = values.file !== undefined || values.runtime !== undefined;
if (
  explicit &&
  (!values.file || !values.runtime || values.mock || values.config)
) {
  throw new Error(
    "Pass --file and --runtime together. Mock configuration cannot be used with an explicit manuscript.",
  );
}
const port = z.coerce.number().int().min(0).max(65535).parse(values.port);
const controller = new AbortController();
let mock: Awaited<ReturnType<typeof prepareMock>> | undefined;
let service: Awaited<ReturnType<typeof startService>> | undefined;
let worker: Promise<void> | undefined;
let stopping: Promise<void> | undefined;
let started = false;
async function stop(): Promise<void> {
  stopping ??= (async () => {
    controller.abort();
    try {
      await worker;
    } finally {
      try {
        await service?.close();
      } finally {
        if (mock) {
          if (started && values["retain-run"]) {
            await mock.retain("Requested with --retain-run");
            console.log(`Retained run: ${mock.root}`);
            console.log(
              `Cleanup: AGORA_STATE_DIR='${dirname(dirname(mock.root)).replaceAll("'", "'\\''")}' pnpm clean:dev --remove ${basename(mock.root)}`,
            );
          } else await mock.release();
        }
      }
    }
  })();
  return stopping;
}
async function start() {
  mock = explicit
    ? undefined
    : await prepareMock(
        values.config
          ? resolve(values.config)
          : fileURLToPath(
              new URL(
                values.mock
                  ? "../dev/mock/bookstore.json"
                  : "../dev/mock/a01.json",
                import.meta.url,
              ),
            ),
      );
  const paths = mock ?? {
    originalPath: resolve(values.file ?? ""),
    runtimeDir: resolve(values.runtime ?? ""),
  };
  const { originalPath, runtimeDir } = paths;
  const panelDir = fileURLToPath(new URL("./panel/", import.meta.url));
  service = await startService({
    originalPath,
    runtimeDir,
    panelDir,
    port,
  });
  const currentService = service;
  if (mock) {
    if (mock.comments.length) {
      const response = await fetch(new URL("/api/state", currentService.url));
      const state = viewSchema.parse(await response.json());
      const saved = await fetch(new URL("/api/panel", currentService.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "save",
          revision: state.revision,
          draftRevision: 0,
          draft: state.draft,
          comments: mock.comments,
          commentDraft: null,
        }),
      });
      if (!saved.ok) {
        throw new Error(`Mock seed failed: ${await saved.text()}`);
      }
    }
    const connection = z
      .object({ workerToken: z.string() })
      .parse(
        JSON.parse(await readFile(join(runtimeDir, "connection.json"), "utf8")),
      );
    worker = startScriptedWorker(
      currentService.url,
      connection.workerToken,
      controller.signal,
      mock.worker,
    ).catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
      void stop();
    });
  }
  console.log(`Agora: ${currentService.url}`);
  console.log(`Markdown: ${originalPath}`);
  console.log(`Runtime: ${runtimeDir}`);

  if (mock) {
    console.log(`Mock config: ${mock.configPath}`);
    console.log(`Config SHA-256: ${mock.configDigest}`);
  }
  started = true;
}
const startup = start();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    controller.abort();
    void startup
      .catch(() => {})
      .then(stop)
      .catch((error: unknown) => {
        console.error(error);
        process.exitCode = 1;
      });
  });
}
try {
  await startup;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
  await stop();
}
