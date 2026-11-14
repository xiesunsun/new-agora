import { equal, match, notEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

const repo = join(import.meta.dirname, "..");
const cli = join(
  repo,
  "node_modules/dependency-cruiser/bin/dependency-cruiser.mjs",
);
const scenarios = [
  {
    name: "mock can import the public worker and contracts entries",
    files: {
      "dev/mock/index.ts":
        'export { run } from "../../apps/worker/src/index.js"; export type { Draft } from "../../packages/contracts/src/index.js";',
      "apps/worker/src/index.ts": 'export const run = () => "done";',
      "packages/contracts/src/index.ts": "export type Draft = string;",
    },
  },
  {
    name: "mock cannot import private service code",
    rule: /dev-mock-imports/,
    files: {
      "dev/mock/index.ts":
        'export { secret } from "../../apps/service/src/private.js";',
      "apps/service/src/private.ts": 'export const secret = "private";',
    },
  },
  {
    name: "production panel cannot import mock configuration",
    rule: /apps-panel-imports/,
    files: {
      "apps/panel/src/index.ts":
        'export { fixture } from "../../../dev/mock/index.js";',
      "dev/mock/index.ts": 'export const fixture = "mock";',
    },
  },
];

for (const { name, files, rule } of scenarios) {
  test(name, (context) => {
    const root = mkdtempSync(join(tmpdir(), "agora-mock-architecture-"));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    for (const directory of ["apps", "packages", "plugins", "dev"])
      mkdirSync(join(root, directory));
    for (const file of [".dependency-cruiser.mjs", "tsconfig.json"])
      copyFileSync(join(repo, file), join(root, file));
    for (const [path, source] of Object.entries(files)) {
      const destination = join(root, path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, source);
    }
    const result = spawnSync(
      process.execPath,
      [
        cli,
        "--config",
        ".dependency-cruiser.mjs",
        "apps",
        "packages",
        "plugins",
        "dev",
      ],
      { cwd: root, encoding: "utf8" },
    );
    equal(result.error, undefined);
    equal(result.signal, null);
    const output = result.stdout + result.stderr;
    if (rule) {
      notEqual(result.status, 0, output);
      match(output, rule);
    } else equal(result.status, 0, output);
  });
}
