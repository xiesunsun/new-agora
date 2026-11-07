import { match, notEqual, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

const repo = join(import.meta.dirname, "../..");
const config = ".dependency-cruiser.mjs";
const cli = join(
  repo,
  "node_modules/dependency-cruiser/bin/dependency-cruiser.mjs",
);

const scenarios = [
  {
    name: "allows private files within an owner and public imports across owners",
    files: {
      "apps/panel/index.ts": 'export { label } from "./label.js";',
      "apps/panel/excerpt.ts":
        'export { excerpt } from "../../packages/text/src/index.js";',
      "apps/panel/label.ts":
        'export { label } from "../../packages/contracts/src/index.js";',
      "packages/contracts/src/index.ts": 'export { label } from "./label.js";',
      "packages/contracts/src/label.ts": 'export const label = "Draft";',
      "packages/text/src/index.ts": 'export const excerpt = "Draft";',
    },
  },
  {
    name: "resolves workspace packages through their public exports",
    files: {
      "apps/panel/index.ts": 'export { label } from "@agora/contracts";',
      "packages/contracts/package.json":
        '{"name":"@agora/contracts","exports":"./src/index.ts","type":"module"}',
      "packages/contracts/src/index.ts": 'export const label = "Draft";',
    },
    links: { "node_modules/@agora/contracts": "packages/contracts" },
  },
  {
    name: "rejects a panel re-export of service code",
    rule: /apps-panel-imports/,
    files: {
      "apps/panel/index.ts": 'export { label } from "../service/index.js";',
      "apps/service/index.ts": 'export const label = "Draft";',
    },
  },
  {
    name: "rejects a type-only import into a shared package's private file",
    rule: /apps-worker-imports/,
    files: {
      "apps/worker/index.ts":
        'export type { Draft } from "../../packages/contracts/src/private.js";',
      "packages/contracts/src/private.ts": "export type Draft = string;",
    },
  },
  {
    name: "rejects a bridge through repository tooling",
    rule: /apps-panel-imports/,
    files: {
      "apps/panel/index.ts": 'export { label } from "../../scripts/bridge.js";',
      "scripts/bridge.ts": 'export { label } from "../apps/service/index.js";',
      "apps/service/index.ts": 'export const label = "Draft";',
    },
  },
  {
    name: "rejects a type-only cycle within an owner",
    rule: /no-cycles/,
    files: {
      "apps/service/draft.ts": 'export type { Revision } from "./revision.js";',
      "apps/service/revision.ts": 'export type { Draft } from "./draft.js";',
    },
  },
  {
    name: "rejects Node built-ins in browser-safe code",
    rule: /browser-safe-modules/,
    files: {
      "packages/text/src/index.ts": 'export { readFile } from "node:fs";',
    },
  },
  {
    name: "rejects unresolved imports",
    rule: /no-unresolved-imports/,
    files: {
      "apps/service/index.ts": 'export { label } from "./missing.js";',
    },
  },
];

for (const { name, files, links, rule } of scenarios) {
  test(name, (context) => {
    const fixture = mkdtempSync(join(tmpdir(), "agora-architecture-"));
    context.after(() => rmSync(fixture, { recursive: true, force: true }));
    for (const directory of ["apps", "packages", "plugins"]) {
      mkdirSync(join(fixture, directory));
    }
    for (const file of [config, "tsconfig.json"]) {
      copyFileSync(join(repo, file), join(fixture, file));
    }
    for (const [file, contents] of Object.entries(files)) {
      const destination = join(fixture, file);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, contents);
    }

    for (const [link, target] of Object.entries(links ?? {})) {
      const destination = join(fixture, link);
      mkdirSync(dirname(destination), { recursive: true });
      symlinkSync(join(fixture, target), destination, "junction");
    }

    const result = spawnSync(
      process.execPath,
      [cli, "--config", config, "apps", "packages", "plugins"],
      { cwd: fixture, encoding: "utf8" },
    );
    strictEqual(result.error, undefined);
    strictEqual(result.signal, null);
    const output = result.stdout + result.stderr;
    if (rule) {
      notEqual(result.status, 0, output);
      match(output, rule);
    } else {
      strictEqual(result.status, 0, output);
    }
  });
}
