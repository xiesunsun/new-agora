import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { finishTestProcesses } from "./test-processes.mjs";
import { stateRoot } from "../dev/runtime/src/index.mjs";
import { inspectRun, isAlive } from "../dev/runtime/src/owners.mjs";

try {
  const { values } = parseArgs({ options: { remove: { type: "string" } } });
  if (values.remove !== undefined) {
    const run = await inspectRun(values.remove);
    if (isAlive(run.owner.pid))
      throw new Error(`Run owner PID ${run.owner.pid} is alive`);
    if (run.owner.kind === "test") {
      const processes = await finishTestProcesses(run.root);
      if (processes.survivors.length || processes.uncertain.length)
        throw new Error(
          `Cannot safely remove test run: ${JSON.stringify(processes)}`,
        );
    }
    await rm(run.root, { recursive: true });
    console.log(`Removed ${values.remove}`);
  } else {
    const names = await readdir(join(stateRoot(), "runs")).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    console.log(`Managed runs in ${join(stateRoot(), "runs")}`);
    for (const name of names.sort()) {
      try {
        const { owner } = await inspectRun(name);
        console.log(
          `${name}\t${owner.state}\tPID ${owner.pid} ${isAlive(owner.pid) ? "alive" : "dead"}\t${owner.state === "retained" ? owner.reason : ""}`,
        );
      } catch (error) {
        console.log(`${name}\tunrecognized\t${String(error)}`);
      }
    }
  }
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
}
