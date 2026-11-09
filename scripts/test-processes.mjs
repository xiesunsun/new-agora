import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

/** @typedef {{pid: number, birth: string}} Identity */
/** @typedef {{root: string, scopeId: string, creator: Identity}} Descriptor */
/** @typedef {Descriptor & {env: NodeJS.ProcessEnv}} Scope */
/** @typedef {{pid: number, state: 'alive', birth: string, ppid: number, pgid: number} | {pid: number, state: 'dead'|'unknown'}} ProcessInfo */
/** @typedef {{scopeId: string, observerId: string, pid: number, birth: string|null, ppid: number, pgid: number, group: Identity|null}} Record */

const environmentKey = "AGORA_TEST_PROCESS_SCOPES";
const identityScript = fileURLToPath(
  new URL("./process-identity.py", import.meta.url),
);
const preloadOption = `--import=${import.meta.url}`;
const observerId = randomUUID();
/** @type {Map<string, Descriptor>} */
const scopes = new Map();
/** @type {Map<import('node:child_process').ChildProcess, Descriptor[]>} */
const pending = new Map();
/** @type {Map<number, {leader: Identity, membersOf: Descriptor[]}>} */
const groups = new Map();
/** @type {Set<string>} */
const written = new Set();

/** @param {unknown} pid @returns {pid is number} */
function validPid(pid) {
  return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0;
}

/** @param {unknown} value @returns {value is Identity} */
function validIdentity(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    "pid" in value &&
    validPid(value.pid) &&
    "birth" in value &&
    typeof value.birth === "string" &&
    /^(darwin:[0-9]+:[0-9]+|linux:[0-9a-f-]+:[0-9]+)$/.test(value.birth)
  );
}

/** @param {string} path @param {boolean} directory */
function realEntry(path, directory) {
  const stat = lstatSync(path);
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile())
  )
    throw new Error(`Invalid test process registry entry: ${path}`);
}

/** @param {string} root */
function ownedRoot(root) {
  if (
    !isAbsolute(root) ||
    !/^test-[A-Za-z0-9]+$/.test(basename(root)) ||
    basename(dirname(root)) !== "runs"
  )
    throw new Error("Test process scope requires an owned test run");
  realEntry(dirname(root), true);
  realEntry(root, true);
  if (realpathSync(root) !== join(realpathSync(dirname(root)), basename(root)))
    throw new Error("Test process scope escapes its run directory");
  realEntry(join(root, "owner.json"), false);
  const owner = JSON.parse(readFileSync(join(root, "owner.json"), "utf8"));
  if (owner.version !== 1 || owner.kind !== "test" || !validPid(owner.pid))
    throw new Error("Invalid test process scope owner");
  return owner.pid;
}

/** @param {string} root @returns {Descriptor} */
function readScope(root) {
  const ownerPid = ownedRoot(root);
  const registry = join(root, "processes");
  realEntry(registry, true);
  realEntry(join(registry, "scope.json"), false);
  const value = JSON.parse(readFileSync(join(registry, "scope.json"), "utf8"));
  if (
    value.version !== 1 ||
    typeof value.scopeId !== "string" ||
    !/^[0-9a-f-]{36}$/.test(value.scopeId) ||
    !validIdentity(value.creator) ||
    value.creator.pid !== ownerPid
  )
    throw new Error("Invalid test process scope descriptor");
  return { root, scopeId: value.scopeId, creator: value.creator };
}

/** @param {number[]|'all'} pids @returns {ProcessInfo[]} */
function probe(pids) {
  if (Array.isArray(pids) && pids.length === 0) return [];
  const value = JSON.parse(
    execFileSync(
      "python3",
      [identityScript, ...(pids === "all" ? ["--all"] : pids.map(String))],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5000,
      },
    ),
  );
  if (
    !Array.isArray(value) ||
    value.some(
      (item) =>
        !validPid(item.pid) ||
        (item.state !== "dead" &&
          item.state !== "unknown" &&
          !(
            item.state === "alive" &&
            Number.isSafeInteger(item.ppid) &&
            validPid(item.pgid) &&
            validIdentity(item)
          )),
    )
  )
    throw new Error("Invalid process identity response");
  return value;
}

/** @param {Descriptor} scope @param {Record} record */
function persist(scope, record) {
  if (record.pid === scope.creator.pid && record.birth === scope.creator.birth)
    return;
  const key = `${scope.scopeId}:${record.pid}:${record.birth}:${record.group?.birth ?? ""}`;
  if (written.has(key)) return;
  const registry = join(scope.root, "processes");
  realEntry(registry, true);
  const name = randomUUID();
  const temporary = join(registry, `.${name}.tmp`);
  writeFileSync(temporary, JSON.stringify(record) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  renameSync(temporary, join(registry, `${name}.json`));
  written.add(key);
}

/** @param {ProcessInfo} info @param {Identity|null} group @param {Descriptor[]} membersOf */
function remember(info, group, membersOf) {
  if (info.state === "dead") return;
  for (const scope of membersOf) {
    if (!scopes.has(scope.scopeId)) continue;
    persist(scope, {
      scopeId: scope.scopeId,
      observerId,
      pid: info.pid,
      birth: info.state === "alive" ? info.birth : null,
      ppid: info.state === "alive" ? info.ppid : process.pid,
      pgid: info.state === "alive" ? info.pgid : info.pid,
      group,
    });
  }
}

/** @param {number} pid @param {Descriptor[]} membersOf */
function observe(pid, membersOf) {
  const [info] = probe([pid]);
  if (!info) throw new Error(`Missing process identity for PID ${pid}`);
  const group =
    info.state === "alive" && info.pid === info.pgid
      ? { pid: info.pid, birth: info.birth }
      : null;
  remember(info, group, membersOf);
  if (group) groups.set(group.pid, { leader: group, membersOf });
}

function witnessGroups() {
  if (groups.size === 0) return;
  const snapshot = probe("all");
  for (const [pid, { leader: group, membersOf }] of groups) {
    const leader = snapshot.find((info) => info.pid === pid);
    if (
      leader?.state !== "alive" ||
      leader.birth !== group.birth ||
      leader.pgid !== pid
    ) {
      groups.delete(pid);
      continue;
    }
    for (const member of snapshot) {
      if (member.state === "alive" && member.pgid === pid)
        remember(member, group, membersOf);
    }
  }
}

function flushPending() {
  for (const [child, membersOf] of pending) {
    if (child.pid) observe(child.pid, membersOf);
    pending.delete(child);
  }
  witnessGroups();
}

channel("child_process").subscribe((message) => {
  if (
    scopes.size === 0 ||
    typeof message !== "object" ||
    message === null ||
    !("process" in message)
  )
    return;
  const child = /** @type {import('node:child_process').ChildProcess} */ (
    message.process
  );
  const membersOf = [...scopes.values()];
  pending.set(child, membersOf);
  child.once("spawn", () => {
    pending.delete(child);
    if (child.pid) observe(child.pid, membersOf);
  });
  child.once("error", () => pending.delete(child));
});
process.on("exit", flushPending);
setInterval(witnessGroups, 200).unref();

/** @param {NodeJS.ProcessEnv} env @returns {Descriptor[]} */
function inheritedScopes(env) {
  const values = JSON.parse(env[environmentKey] ?? "[]");
  if (!Array.isArray(values))
    throw new Error("Invalid inherited test process scopes");
  return values.map((value) => {
    if (typeof value?.root !== "string")
      throw new Error("Invalid inherited test process scope");
    const scope = readScope(value.root);
    if (scope.scopeId !== value.scopeId)
      throw new Error("Mismatched inherited test process scope");
    return scope;
  });
}

for (const scope of inheritedScopes(process.env))
  scopes.set(scope.scopeId, scope);
if (scopes.size) observe(process.pid, [...scopes.values()]);

/** @param {string} root @param {NodeJS.ProcessEnv} env @returns {Scope} */
export function createTestProcessScope(root, env) {
  if (ownedRoot(root) !== process.pid)
    throw new Error("Only the test run owner can create its process scope");
  const [creator] = probe([process.pid]);
  if (creator?.state !== "alive")
    throw new Error("Cannot establish test runner birth identity");
  const scope = {
    root,
    scopeId: randomUUID(),
    creator: { pid: creator.pid, birth: creator.birth },
  };
  const registry = join(root, "processes");
  mkdirSync(registry, { mode: 0o700 });
  writeFileSync(
    join(registry, "scope.json"),
    JSON.stringify({
      version: 1,
      scopeId: scope.scopeId,
      creator: scope.creator,
    }) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  const inherited = inheritedScopes(env);
  const options = env.NODE_OPTIONS ?? "";
  return {
    ...scope,
    env: {
      ...env,
      [environmentKey]: JSON.stringify([...inherited, scope]),
      NODE_OPTIONS: options.split(/\s+/).includes(preloadOption)
        ? options
        : `${options} ${preloadOption}`.trim(),
    },
  };
}

/** @param {Descriptor} scope @returns {Record[]} */
function records(scope) {
  const verified = readScope(scope.root);
  if (verified.scopeId !== scope.scopeId)
    throw new Error("Test process scope changed");
  const registry = join(scope.root, "processes");
  return readdirSync(registry)
    .filter(
      (name) => name !== "scope.json" && !/^\.[0-9a-f-]+\.tmp$/.test(name),
    )
    .map((name) => {
      if (!/^[0-9a-f-]{36}\.json$/.test(name))
        throw new Error("Unknown test process registry entry");
      realEntry(join(registry, name), false);
      const record = JSON.parse(readFileSync(join(registry, name), "utf8"));
      if (
        record.scopeId !== scope.scopeId ||
        typeof record.observerId !== "string" ||
        !/^[0-9a-f-]{36}$/.test(record.observerId) ||
        !validPid(record.pid) ||
        !(record.birth === null || validIdentity(record)) ||
        !Number.isSafeInteger(record.ppid) ||
        !validPid(record.pgid) ||
        !(
          record.group === null ||
          (validIdentity(record.group) && record.group.pid === record.pgid)
        ) ||
        (record.pid === scope.creator.pid &&
          record.birth === scope.creator.birth)
      )
        throw new Error("Invalid owned test process record");
      return record;
    });
}

/** @param {Descriptor} scope */
function inspect(scope) {
  const entries = records(scope);
  const snapshot = probe("all");
  const byPid = new Map(snapshot.map((info) => [info.pid, info]));
  const absent = entries
    .filter((entry) => !byPid.has(entry.pid))
    .map((entry) => entry.pid);
  for (const info of probe([...new Set(absent)])) byPid.set(info.pid, info);
  /** @type {Map<number, ProcessInfo & {state: 'alive'}>} */
  const alive = new Map();
  /** @type {Set<string>} */
  const uncertain = new Set();
  /** @type {Map<number, Identity>} */
  const leases = new Map();
  for (const entry of entries) {
    const info = byPid.get(entry.pid);
    if (
      info?.state === "unknown" ||
      !info ||
      (info.state === "alive" && entry.birth === null)
    )
      uncertain.add(`Cannot verify birth identity of PID ${entry.pid}`);
    if (info?.state === "alive" && info.birth === entry.birth)
      alive.set(info.pid, info);
    if (
      entry.group &&
      entry.pid === entry.group.pid &&
      entry.birth === entry.group.birth
    )
      leases.set(entry.group.pid, entry.group);
  }
  /** @type {Map<number, Identity>} */
  const authorizedGroups = new Map();
  for (const [pgid, lease] of leases) {
    const witness = entries.find(
      (entry) =>
        entry.group?.pid === pgid &&
        entry.group.birth === lease.birth &&
        alive.get(entry.pid)?.pgid === pgid &&
        alive.get(entry.pid)?.birth === entry.birth,
    );
    const members = snapshot.filter(
      (info) => info.state === "alive" && info.pgid === pgid,
    );
    if (!witness) {
      if (members.length)
        uncertain.add(`Process group ${pgid} has no matching owned witness`);
      continue;
    }
    authorizedGroups.set(pgid, {
      pid: witness.pid,
      birth: /** @type {string} */ (witness.birth),
    });
    for (const info of members) {
      if (info.state !== "alive") continue;
      persist(scope, {
        scopeId: scope.scopeId,
        observerId,
        pid: info.pid,
        birth: info.birth,
        ppid: info.ppid,
        pgid: info.pgid,
        group: lease,
      });
      alive.set(info.pid, info);
    }
  }
  return { alive, authorizedGroups, uncertain: [...uncertain] };
}

/** @param {Descriptor} scope @param {NodeJS.Signals} signal */
export function signalTestProcesses(scope, signal) {
  flushPending();
  const state = inspect(scope);
  const targets = [
    ...[...state.authorizedGroups].map(([pgid, witness]) => ({
      target: -pgid,
      witness,
      pgid,
    })),
    ...[...state.alive.values()]
      .filter((info) => !state.authorizedGroups.has(info.pgid))
      .map((info) => ({ target: info.pid, witness: info, pgid: info.pgid })),
  ];
  const latest = new Map(
    probe(targets.map((target) => target.witness.pid)).map((info) => [
      info.pid,
      info,
    ]),
  );
  for (const { target, witness, pgid } of targets) {
    const info = latest.get(witness.pid);
    if (
      info?.state !== "alive" ||
      info.birth !== witness.birth ||
      (target < 0 && info.pgid !== pgid)
    )
      continue;
    try {
      process.kill(target, signal);
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ESRCH"
      ))
        state.uncertain.push(
          `Cannot signal owned PID or group ${target}: ${String(error)}`,
        );
    }
  }
  return state;
}

/** @param {Descriptor|string} scopeOrRoot */
export async function finishTestProcesses(scopeOrRoot) {
  /** @type {number[]} */
  let leaked = [];
  try {
    const scope =
      typeof scopeOrRoot === "string" ? readScope(scopeOrRoot) : scopeOrRoot;
    flushPending();
    const initial = inspect(scope);
    leaked = [...initial.alive.keys()];
    const uncertain = new Set(initial.uncertain);
    for (const signal of /** @type {const} */ (["SIGTERM", "SIGKILL"])) {
      const deadline = Date.now() + (signal === "SIGTERM" ? 500 : 2000);
      do {
        const state = signalTestProcesses(scope, signal);
        leaked = [...new Set([...leaked, ...state.alive.keys()])];
        for (const problem of state.uncertain) uncertain.add(problem);
        if (!state.alive.size) break;
        await delay(25);
      } while (Date.now() < deadline);
    }
    const final = inspect(scope);
    leaked = [...new Set([...leaked, ...final.alive.keys()])];
    for (const problem of final.uncertain) uncertain.add(problem);
    if (
      readdirSync(join(scope.root, "processes")).some((name) =>
        name.endsWith(".tmp"),
      )
    )
      uncertain.add("Incomplete test process registry write");
    scopes.delete(scope.scopeId);
    return {
      leaked,
      survivors: [...final.alive.keys()],
      uncertain: [...uncertain],
    };
  } catch (error) {
    return { leaked, survivors: [], uncertain: [String(error)] };
  }
}
