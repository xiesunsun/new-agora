import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import {
  panelCommandSchema,
  viewSchema,
  workerResultSchema,
} from "../../../packages/contracts/src/index.js";
import type {
  PanelCommand,
  WorkerCommand,
} from "../../../packages/contracts/src/index.js";
import manifest from "../.codex-plugin/plugin.json" with { type: "json" };

const { name, version } = manifest;
const panelUri = `ui://${name}/panel.html`;
const threadSchema = z.string().min(1).max(128);
const errorSchema = z.object({ error: z.string() });
const connectionSchema = z.object({
  url: z.url().refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.href === `${url.origin}/`
    );
  }),
  workerToken: z.string().min(1),
});

function connection() {
  try {
    const file =
      process.env.AGORA_CONNECTION ||
      new URL("./connection.json", import.meta.url);
    return connectionSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    throw new Error("请先启动 Agora 本地服务并设置 AGORA_CONNECTION。");
  }
}

async function requestService<T>(
  route: "/api/state" | "/api/panel" | "/api/worker",
  schema: z.ZodType<T>,
  command?: PanelCommand | WorkerCommand,
): Promise<T> {
  const { url, workerToken } = connection();
  const headers = new Headers();
  if (route === "/api/worker")
    headers.set("Authorization", `Bearer ${workerToken}`);
  if (command) headers.set("Content-Type", "application/json");
  let response: Response;
  try {
    response = await fetch(new URL(route, url), {
      method: command ? "POST" : "GET",
      headers,
      body: command ? JSON.stringify(command) : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(12000),
    });
  } catch {
    throw new Error("Agora 本地服务暂不可用。");
  }
  const payload: unknown = await response.json();
  if (!response.ok) {
    const problem = errorSchema.safeParse(payload);
    throw new Error(problem.success ? problem.data.error : "Agora 请求失败。");
  }
  return schema.parse(payload);
}

function worker(command: WorkerCommand) {
  return requestService("/api/worker", workerResultSchema, command);
}

function threadFromHost(metadata: Record<string, unknown> | undefined) {
  const thread = threadSchema.safeParse(metadata?.threadId);
  if (!thread.success) throw new Error("宿主没有提供当前 Codex 对话标识。");
  return thread.data;
}

async function respond(
  operation: () => Promise<Record<string, unknown>>,
  text?: string,
): Promise<CallToolResult> {
  try {
    const data = await operation();
    return {
      content: [{ type: "text", text: text ?? JSON.stringify(data) }],
      structuredContent: data,
    };
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : "Agora 请求失败。";
    return {
      content: [{ type: "text", text: error }],
      structuredContent: { error },
      isError: true,
    };
  }
}

const server = new McpServer(
  { name, version },
  {
    instructions:
      "Agora 只处理在当前对话打开的文稿。收到面板的改稿通知后，先调用 agora_claim_next。仅当返回 claimed 时，才用原生文件工具编辑返回的 candidatePath。按批注中的原话和选区修改待审稿，保留人类已写的内容，再用同一个 executionId 调用 agora_submit_candidate。领取后如失败或中断，必须用同一个 executionId 调用 agora_finish_execution 报告 failed 或 cancelled。超时和重启不能证明执行结束。写回原文件和选择修改由用户在面板中完成。",
  },
);

registerAppResource(server, `${name}-panel`, panelUri, {}, async () => ({
  contents: [
    {
      uri: panelUri,
      mimeType: RESOURCE_MIME_TYPE,
      text: readFileSync(new URL("./panel.html", import.meta.url), "utf8"),
      _meta: {
        ui: {
          prefersBorder: true,
          csp: { connectDomains: [], resourceDomains: [] },
        },
      },
    },
  ],
}));

registerAppTool(
  server,
  "agora_open_document",
  {
    title: "Agora 文稿工作台",
    description: "在当前 Codex 对话打开本地 Agora 服务绑定的 Markdown 文稿。",
    inputSchema: { path: z.string().min(1).optional() },
    _meta: {
      ui: { resourceUri: panelUri },
      "openai/ui": { entrypoints: [{ type: "thread" }] },
    },
  },
  async ({ path }, { _meta }) =>
    respond(async () => {
      const threadId = threadFromHost(_meta);
      await worker({ action: "bind", threadId, path });
      return { threadId };
    }, "Agora 文稿工作台已打开。"),
);

registerAppTool(
  server,
  "agora_panel",
  {
    description: "仅供当前对话的 Agora 面板读取文稿或提交用户操作。",
    inputSchema: {
      expectedThread: threadSchema,
      command: panelCommandSchema.optional(),
    },
    _meta: { ui: { visibility: ["app"] } },
  },
  async ({ expectedThread, command }, { _meta }) =>
    respond(async () => {
      const threadId = threadFromHost(_meta);
      if (threadId !== expectedThread)
        throw new Error("当前对话与打开 Agora 工作台的对话不同。");
      await worker({ action: "bind", threadId });
      const state = command
        ? await requestService("/api/panel", viewSchema, command)
        : await requestService("/api/state", viewSchema);
      return { state };
    }),
);

server.registerTool(
  "agora_claim_next",
  {
    description:
      "领取当前 Codex 对话的改稿任务。仅当返回 claimed 时，用原生文件工具编辑返回的 candidatePath，完成后提交同一个 executionId。",
    inputSchema: {},
  },
  async (_, { _meta }) =>
    respond(async () =>
      worker({ action: "claim", threadId: threadFromHost(_meta) }),
    ),
);

server.registerTool(
  "agora_submit_candidate",
  {
    description:
      "完成待审稿编辑后，提交领取时取得的 executionId。Agora 读取待审文件并计算差异。",
    inputSchema: { executionId: z.string().min(1) },
  },
  async ({ executionId }, { _meta }) =>
    respond(async () =>
      worker({
        action: "submit",
        threadId: threadFromHost(_meta),
        executionId,
      }),
    ),
);

server.registerTool(
  "agora_finish_execution",
  {
    description:
      "领取后的改稿执行失败或中断时，报告同一个 executionId 的结束状态。只有已停止编辑候选文件后才能报告 cancelled。",
    inputSchema: {
      executionId: z.string().min(1),
      outcome: z.enum(["failed", "cancelled"]),
    },
  },
  async ({ executionId, outcome }, { _meta }) =>
    respond(async () =>
      worker({
        action: "finish",
        threadId: threadFromHost(_meta),
        executionId,
        outcome,
      }),
    ),
);

await server.connect(new StdioServerTransport());
