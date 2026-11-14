import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { startService } from "./server.js";

const { values } = parseArgs({
  options: { file: { type: "string" }, runtime: { type: "string" } },
});
const originalPath = z.string().min(1).parse(values.file);
const runtimeDir = z.string().min(1).parse(values.runtime);
let service: Awaited<ReturnType<typeof startService>> | undefined;
let closing = false;
let stopped: Promise<void> | undefined;
const startup = Promise.resolve().then(async () => {
  if (closing || !process.connected) return;
  service = await startService({
    originalPath,
    runtimeDir,
    port: 0,
    panelDir: fileURLToPath(new URL("./browser/", import.meta.url)),
    resetThreadBinding: true,
  });
  if (closing || !process.connected) await service.close();
  else process.send?.({ type: "ready" });
});

function stop(): Promise<void> {
  closing = true;
  stopped ??= startup
    .catch(() => {})
    .then(async () => {
      await service?.close();
      process.stdin.pause();
      if (process.connected) process.disconnect();
    });
  return stopped;
}
const shutdown = () => {
  void stop().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
};
process.once("disconnect", shutdown);
process.stdin.once("end", shutdown);
process.stdin.resume();
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
try {
  await startup;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
  await stop();
}
