import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  mkdirSync,
  openSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  panelCommandSchema,
  workerCommandSchema,
} from "../../../packages/contracts/src/index.js";
import { CommandError, DocumentService } from "./document.js";
import { writeAtomically } from "./files.js";

type ServiceOptions = {
  originalPath: string;
  runtimeDir: string;
  panelDir: string;
  port: number;
  resetThreadBinding?: boolean;
};

const panelAssets = new Map([
  ["/", { file: "index.html", mime: "text/html; charset=utf-8" }],
  ["/panel.js", { file: "panel.js", mime: "text/javascript; charset=utf-8" }],
  ["/panel.css", { file: "panel.css", mime: "text/css; charset=utf-8" }],
]);

export async function startService(
  options: ServiceOptions,
): Promise<{ url: string; close(): Promise<void> }> {
  const originalPath = canonicalDocumentPath(options.originalPath);
  mkdirSync(options.runtimeDir, { recursive: true, mode: 0o700 });
  const runtimeDir = realpathSync(options.runtimeDir);
  const documentFromRuntime = relative(runtimeDir, originalPath);
  if (
    !isAbsolute(documentFromRuntime) &&
    documentFromRuntime !== ".." &&
    !documentFromRuntime.startsWith(`..${sep}`)
  ) {
    throw new Error("原文件须位于运行目录之外。");
  }
  const owner = privateDatabase(join(runtimeDir, "owner.sqlite"));
  let db: DatabaseSync | undefined;
  let server: Server | undefined;
  const connectionPath = join(runtimeDir, "connection.json");
  const workerToken = randomUUID();
  let url = "";

  try {
    owner.exec("BEGIN EXCLUSIVE");
    db = privateDatabase(join(runtimeDir, "document.sqlite"));
    const document = new DocumentService(
      db,
      originalPath,
      runtimeDir,
      options.resetThreadBinding,
    );
    server = createServer((request, response) => {
      void serve(request, response, {
        document,
        url,
        workerToken,
        panelDir: options.panelDir,
      }).catch((error: unknown) => {
        const known = error instanceof CommandError;
        json(response, known ? error.status : 500, {
          error: known ? error.message : "本地服务无法完成操作。",
        });
      });
    });
    const listener = server;
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(options.port, "127.0.0.1", () => {
        listener.off("error", reject);
        resolve();
      });
    });

    const address = listener.address();
    if (!address || typeof address === "string") {
      throw new Error("本地服务没有监听地址。");
    }
    url = `http://127.0.0.1:${address.port}`;
    writeAtomically(
      connectionPath,
      JSON.stringify({ url, workerToken }),
      0o600,
    );
  } catch (error) {
    if (server?.listening) await stop(server);
    db?.close();
    owner.close();
    throw error;
  }

  const activeServer = server;
  const activeDatabase = db;
  let closing: Promise<void> | undefined;
  return {
    url,
    close() {
      closing ??= stop(activeServer).finally(() => {
        try {
          rmSync(connectionPath, { force: true });
        } finally {
          activeDatabase.close();
          owner.close();
        }
      });
      return closing;
    },
  };
}

type HttpContext = {
  document: DocumentService;
  url: string;
  workerToken: string;
  panelDir: string;
};

async function serve(
  request: IncomingMessage,
  response: ServerResponse,
  context: HttpContext,
): Promise<void> {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  const host = context.url.slice("http://".length);
  if (
    request.headers.host !== host ||
    (request.headers.origin && request.headers.origin !== context.url)
  ) {
    throw new CommandError(403, "仅接受当前本地面板的请求。");
  }

  if (request.method === "GET" && request.url === "/api/state") {
    json(response, 200, context.document.view());
    return;
  }

  if (request.method === "POST" && request.url === "/api/panel") {
    const parsed = panelCommandSchema.safeParse(await readJson(request));
    if (!parsed.success) throw new CommandError(400, "面板请求格式不正确。");
    json(response, 200, context.document.panel(parsed.data));
    return;
  }

  if (request.method === "POST" && request.url === "/api/worker") {
    if (request.headers.authorization !== `Bearer ${context.workerToken}`) {
      throw new CommandError(401, "执行器需要本地授权。");
    }
    const parsed = workerCommandSchema.safeParse(await readJson(request));
    if (!parsed.success) throw new CommandError(400, "执行器请求格式不正确。");
    json(response, 200, context.document.worker(parsed.data));
    return;
  }

  const asset =
    request.method === "GET" ? panelAssets.get(request.url ?? "") : undefined;
  if (!asset) throw new CommandError(404, "找不到此页面。");
  const body = await readFile(join(context.panelDir, asset.file));
  response.writeHead(200, { "Content-Type": asset.mime });
  response.end(body);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (
    request.headers["content-type"]?.split(";")[0]?.trim() !==
    "application/json"
  ) {
    throw new CommandError(415, "请求必须使用 JSON。");
  }
  const limit = 8 * 1024 * 1024;
  if (Number(request.headers["content-length"]) > limit) {
    throw new CommandError(413, "工作稿超出请求大小限制。");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    if (!Buffer.isBuffer(chunk))
      throw new CommandError(400, "请求格式不正确。");
    total += chunk.length;
    if (total > limit) throw new CommandError(413, "工作稿超出请求大小限制。");
    chunks.push(chunk);
  }
  try {
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return body;
  } catch {
    throw new CommandError(400, "请求格式不正确。");
  }
}

function json(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(data));
}

function privateDatabase(path: string): DatabaseSync {
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
  return new DatabaseSync(path);
}

function canonicalDocumentPath(path: string): string {
  const absolutePath = resolve(path);
  try {
    return realpathSync(absolutePath);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
    return join(realpathSync(dirname(absolutePath)), basename(absolutePath));
  }
}

function stop(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
