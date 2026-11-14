import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { closeSync, constants, fchmodSync, openSync } from "node:fs";
import {
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { extname, isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { workerResultSchema } from "../../../packages/contracts/src/index.js";
import { readConnection, requestService } from "./connection.js";
import type { Connection } from "./connection.js";

type OwnedService = {
  child: ChildProcess;
  connection: Connection;
  stop(): Promise<void>;
};
type ProjectOwner = {
  threadId: string;
  database: DatabaseSync;
  opening: number;
  established: boolean;
};
const lastProjectSchema = z.object({ path: z.string().min(1) });
const readySchema = z.object({ type: z.literal("ready") });
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const running = (child: ChildProcess) =>
  child.exitCode === null && child.signalCode === null;

function projectRoot(): string {
  const root =
    process.env.AGORA_STATE_DIR ||
    (process.env.XDG_STATE_HOME
      ? join(process.env.XDG_STATE_HOME, "agora")
      : join(homedir(), ".local/state/agora"));
  if (!isAbsolute(root)) throw new Error("Agora 状态目录必须是绝对路径。");
  return join(root, "projects");
}

export class DesktopProjects {
  private readonly root = projectRoot();
  private readonly services = new Map<string, OwnedService>();
  private readonly starting = new Map<string, Promise<OwnedService>>();
  private readonly owned = new Set<OwnedService>();
  private readonly opened = new Map<string, Map<string, string>>();
  private readonly active = new Map<string, string>();
  private readonly executions = new Map<string, string>();
  private readonly owners = new Map<string, ProjectOwner>();
  private closing = false;
  private closed: Promise<void> | undefined;

  async open(threadId: string, path?: string) {
    if (!path) {
      const current = this.active.get(threadId);
      path = current ? this.opened.get(threadId)?.get(current) : undefined;
      if (!path) {
        try {
          path = lastProjectSchema.parse(
            JSON.parse(await readFile(this.threadPath(threadId), "utf8")),
          ).path;
        } catch {
          throw new Error("请提供要打开的 Markdown 绝对路径。");
        }
      }
    }
    if (!isAbsolute(path)) throw new Error("请提供 Markdown 的绝对路径。");
    let canonical: string;
    try {
      canonical = await realpath(path);
      if (!(await stat(canonical)).isFile()) throw new Error("not a file");
    } catch {
      throw new Error("找不到可读取的 Markdown 文稿，请核对路径。");
    }
    if (![".md", ".markdown"].includes(extname(canonical).toLowerCase()))
      throw new Error("请选择 Markdown 文稿（.md 或 .markdown）。");
    const projectId = hash(canonical);
    await this.bind(threadId, projectId, canonical);
    const projects = this.opened.get(threadId) ?? new Map<string, string>();
    projects.set(projectId, canonical);
    this.opened.set(threadId, projects);
    this.active.set(threadId, projectId);
    const threads = join(this.root, "threads");
    await mkdir(threads, { recursive: true, mode: 0o700 });
    const temporary = join(threads, `${randomUUID()}.json`);
    await writeFile(temporary, JSON.stringify({ path: canonical }), {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, this.threadPath(threadId));
    return { threadId, projectId };
  }

  async get(threadId: string, projectId?: string, executionId?: string) {
    const known = executionId
      ? this.executions.get(`${threadId}/${executionId}`)
      : undefined;
    if (known && projectId && known !== projectId)
      throw new Error("执行编号与项目身份不符。");
    if (executionId && !known && !projectId)
      throw new Error("请携带原执行的 projectId 核对所属项目。");
    const selected = projectId ?? known ?? this.active.get(threadId);
    const path = selected
      ? this.opened.get(threadId)?.get(selected)
      : undefined;
    if (!selected || !path)
      throw new Error("请先在当前 Codex 对话打开这个 Markdown 项目。");
    return {
      projectId: selected,
      connection: await this.bind(threadId, selected, path),
    };
  }

  rememberExecution(threadId: string, executionId: string, projectId: string) {
    this.executions.set(`${threadId}/${executionId}`, projectId);
  }

  close(): Promise<void> {
    this.closing = true;
    this.closed ??= (async () => {
      const results = await Promise.allSettled(
        [...this.owned].map((service) => service.stop()),
      );
      await Promise.allSettled(this.starting.values());
      for (const owner of this.owners.values()) owner.database.close();
      this.owners.clear();
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length)
        throw new AggregateError(
          failures.map((result) => result.reason),
          "项目服务未能全部关闭。",
        );
    })();
    return this.closed;
  }

  private threadPath(threadId: string) {
    return join(this.root, "threads", `${hash(threadId)}.json`);
  }

  private async bind(threadId: string, projectId: string, path: string) {
    if (this.closing) throw new Error("Agora 正在关闭，请重新打开项目。");
    const owner = await this.reserve(threadId, projectId);
    if (this.closing) throw new Error("Agora 正在关闭，请重新打开项目。");
    owner.opening++;
    try {
      let service = this.services.get(projectId);
      if (!service || !running(service.child)) {
        let startup = this.starting.get(projectId);
        if (!startup) {
          startup = this.start(projectId, path);
          this.starting.set(projectId, startup);
        }
        try {
          service = await startup;
          this.services.set(projectId, service);
        } finally {
          if (this.starting.get(projectId) === startup)
            this.starting.delete(projectId);
        }
      }
      await requestService(
        service.connection,
        "/api/worker",
        workerResultSchema,
        { action: "bind", threadId },
      );
      owner.established = true;
      return service.connection;
    } finally {
      owner.opening--;
      if (
        !owner.established &&
        owner.opening === 0 &&
        this.owners.get(projectId) === owner
      ) {
        this.owners.delete(projectId);
        owner.database.close();
        await this.services.get(projectId)?.stop();
      }
    }
  }

  private async reserve(threadId: string, projectId: string) {
    const runtime = join(this.root, projectId);
    await mkdir(runtime, { recursive: true, mode: 0o700 });
    if (this.closing) throw new Error("Agora 正在关闭。");
    const existing = this.owners.get(projectId);
    if (existing) {
      if (existing.threadId !== threadId)
        throw new Error("此项目已在另一活动对话中打开。");
      return existing;
    }
    const path = join(runtime, "desktop-owner.sqlite");
    const fd = openSync(
      path,
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      fchmodSync(fd, 0o600);
    } finally {
      closeSync(fd);
    }
    const database = new DatabaseSync(path);
    try {
      database.exec("BEGIN EXCLUSIVE");
    } catch {
      database.close();
      throw new Error("此项目已在另一活动 Codex 对话中打开，请先关闭原连接。");
    }
    const owner: ProjectOwner = {
      threadId,
      database,
      opening: 0,
      established: false,
    };
    this.owners.set(projectId, owner);
    return owner;
  }

  private async start(projectId: string, path: string): Promise<OwnedService> {
    const runtime = join(this.root, projectId);
    await mkdir(runtime, { recursive: true, mode: 0o700 });
    if (this.closing) throw new Error("Agora 正在关闭。");
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("./service.mjs", import.meta.url)),
        "--file",
        path,
        "--runtime",
        runtime,
      ],
      {
        stdio: ["pipe", "ignore", "pipe", "ipc"],
        env: process.env,
      },
    );
    let output = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-4000);
    });
    const stopped = new Promise<boolean>((resolve) =>
      child.once("close", () => resolve(true)),
    );
    let stopping: Promise<void> | undefined;
    const stop = () =>
      (stopping ??= (async () => {
        child.stdin?.end();
        if (await Promise.race([stopped, delay(2000, false, { ref: false })]))
          return;
        if (running(child)) child.kill("SIGTERM");
        if (await Promise.race([stopped, delay(2000, false, { ref: false })]))
          return;
        if (running(child)) child.kill("SIGKILL");
        if (
          !(await Promise.race([stopped, delay(2000, false, { ref: false })]))
        )
          throw new Error("项目服务退出未确认。");
      })());
    const owned: OwnedService = {
      child,
      connection: { url: "", workerToken: "" },
      stop,
    };
    this.owned.add(owned);
    child.once("close", () => {
      this.owned.delete(owned);
      if (this.services.get(projectId) === owned)
        this.services.delete(projectId);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(
          () => fail(new Error("项目服务启动超时。")),
          10000,
        );
        const cleanup = () => {
          clearTimeout(deadline);
          child.off("message", ready);
          child.off("error", fail);
          child.off("close", exited);
        };
        const fail = (error: Error) => {
          cleanup();
          reject(error);
        };
        const exited = () =>
          fail(
            new Error(`无法启动项目服务，项目可能已在其他对话打开。${output}`),
          );
        const ready = (message: unknown) => {
          if (!readySchema.safeParse(message).success) return;
          cleanup();
          resolve();
        };
        child.on("message", ready);
        child.once("error", fail);
        child.once("close", exited);
      });
      if (!running(child) || this.closing)
        throw new Error("项目服务启动已中断。");
      owned.connection = readConnection(join(runtime, "connection.json"));
      return owned;
    } catch (error) {
      await stop();
      throw error;
    }
  }
}
