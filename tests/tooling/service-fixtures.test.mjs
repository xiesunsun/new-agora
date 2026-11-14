import { deepEqual, equal, match, rejects, throws } from "node:assert/strict";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { createFixture } from "../support/fixture.mjs";
import { startService } from "../support/service.mjs";
import { waitFor } from "../support/wait.mjs";

test("fixture closes acquired resources in reverse order before removing its directory", async (context) => {
  const fixture = await createFixture(context, "agora-cleanup-order-");
  /** @type {string[]} */
  const order = [];
  fixture.after(async () => {
    await access(fixture.root);
    order.push("service");
  });
  fixture.after(async () => {
    await access(fixture.root);
    order.push("browser");
  });
  await fixture.close();
  await fixture.close();
  deepEqual(order, ["browser", "service"]);
  await rejects(access(fixture.root), { code: "ENOENT" });
});

test("failed fixture cleanup still closes other resources and preserves its directory", async (context) => {
  /** @type {Array<() => void | Promise<unknown>>} */
  const hooks = [];
  const fixture = await createFixture(
    {
      after: (hook) => {
        hooks.push(hook);
      },
    },
    "agora-cleanup-failure-",
  );
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  /** @type {string[]} */
  const order = [];
  fixture.after(() => {
    order.push("service");
  });
  fixture.after(() => {
    order.push("browser");
    throw new Error("browser close failed");
  });
  await rejects(async () => hooks[0](), /cleanup failed/i);
  deepEqual(order, ["browser", "service"]);
  await access(fixture.root);
});

test("partial fixture initialization releases already acquired resources", async (context) => {
  /** @type {Array<() => void | Promise<unknown>>} */
  const hooks = [];
  const fixture = await createFixture(
    {
      after: (hook) => {
        hooks.push(hook);
      },
    },
    "agora-partial-setup-",
  );
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  let closed = false;
  fixture.after(() => {
    closed = true;
  });
  await hooks[0]();
  equal(closed, true);
  await rejects(access(fixture.root), { code: "ENOENT" });
});

test("readiness waits for an actual value and reports bounded diagnostic failure", async () => {
  let attempts = 0;
  equal(
    await waitFor(async () => (++attempts === 3 ? false : undefined), {
      description: "a false value",
      timeoutMs: 1000,
    }),
    false,
  );
  await rejects(
    waitFor(async () => undefined, {
      description: "missing report",
      timeoutMs: 30,
      diagnostics: () => "child is still running",
    }),
    /missing report.*child is still running/s,
  );
});

/** @param {import('node:test').TestContext} context @param {string} preload */
async function serviceFixture(context, preload = "") {
  const fixture = await createFixture(context, "agora-service-fixture-");
  const document = join(fixture.root, "copy.md");
  const runtime = join(fixture.root, "runtime");
  const pidPath = join(fixture.root, "service.pid");
  await writeFile(document, "# Test manuscript\n");
  const module = join(fixture.root, "preload.mjs");
  await writeFile(
    module,
    `import { writeFileSync } from 'node:fs';
    writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
    ${preload}`,
  );
  return {
    fixture,
    document,
    runtime,
    pidPath,
    env: {
      ...process.env,
      NODE_OPTIONS:
        `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(module).href}`.trim(),
    },
  };
}

test("built service readiness tolerates startup beyond the former three second budget", async (context) => {
  const f = await serviceFixture(
    context,
    "await new Promise(resolve => setTimeout(resolve, 3200));",
  );
  const service = await startService(f.fixture, f.document, f.runtime, {
    env: f.env,
  });
  equal((await service.request("/api/state")).draft, "# Test manuscript\n");
  await service.stop();
  await service.stop();
  const pid = Number(await readFile(f.pidPath, "utf8"));
  throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("built service early exit retains its real startup error", async (context) => {
  const f = await serviceFixture(context);
  await rejects(
    startService(f.fixture, join(f.fixture.root, "missing.md"), f.runtime),
    /ENOENT/,
  );
});

test("built service signal exit retains output and signal instead of timing out", async (context) => {
  const f = await serviceFixture(
    context,
    "process.stderr.write('signal fixture\\n'); process.kill(process.pid, 'SIGTERM');",
  );
  await rejects(
    startService(f.fixture, f.document, f.runtime, { env: f.env }),
    /SIGTERM.*signal fixture/s,
  );
});

test("a service that never becomes ready is stopped and its output is retained", async (context) => {
  const f = await serviceFixture(
    context,
    "process.stderr.write('waiting fixture\\n'); setInterval(() => {}, 1000); await new Promise(() => {});",
  );
  await rejects(
    startService(f.fixture, f.document, f.runtime, { env: f.env }),
    /waiting fixture/,
  );
  const pid = Number(await readFile(f.pidPath, "utf8"));
  throws(() => process.kill(pid, 0), { code: "ESRCH" });
  const output = await readFile(join(f.runtime, "service.log"), "utf8");
  match(output, /waiting fixture/);
});
