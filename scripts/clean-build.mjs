import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

if (process.argv.length !== 2)
  throw new Error("Usage: node scripts/clean-build.mjs");
for (const folder of ["dist", "coverage"])
  await rm(fileURLToPath(new URL(`../${folder}`, import.meta.url)), {
    recursive: true,
    force: true,
  });
