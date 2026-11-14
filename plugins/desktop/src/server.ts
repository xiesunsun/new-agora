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
import type { WorkerCommand } from "../../../packages/contracts/src/index.js";
import { readConnection, requestService } from "./connection.js";
import { DesktopProjects } from "./projects.js";
import manifest from "../.codex-plugin/plugin.json" with { type: "json" };

const { name, version } = manifest;
const panelUri = `ui://${name}/${version}/panel.html`;
const threadSchema = z.string().min(1).max(128);
const projectSchema = z.string().regex(/^[a-f0-9]{64}$/);
const externalConnection = process.env.AGORA_CONNECTION;
const projects = externalConnection ? undefined : new DesktopProjects();

function external() {
  try {
    if (!externalConnection) throw new Error("No external connection");
    return readConnection(externalConnection);
  } catch {
    throw new Error("请先启动 Agora 本地服务并设置 AGORA_CONNECTION。");
  }
}

async function worker(command: WorkerCommand, projectId?: string) {
  const selected = await projects?.get(
    command.threadId,
    projectId,
    "executionId" in command ? command.executionId : undefined,
  );
  const result = await requestService(
    selected?.connection ?? external(),
    "/api/worker",
    workerResultSchema,
    command,
  );
  if (selected && result.status === "claimed")
    projects?.rememberExecution(
      command.threadId,
      result.executionId,
      selected.projectId,
    );
  return selected ? { ...result, projectId: selected.projectId } : result;
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
      "Agora 按 Markdown 的绝对路径打开项目，只处理当前对话已打开的项目。收到面板通知后，调用 agora_claim_next 并传入通知中的 projectId。仅当返回 claimed 时，才用原生文件工具编辑返回的 candidatePath。按批注原话和选区改稿，保留人类已写内容，再用领取结果中的 projectId 和 executionId 调用 agora_submit_candidate。领取后如失败或中断，必须携带同一项目和执行编号调用 agora_finish_execution 报告 failed 或 cancelled。重启后结束未知的执行同样需要原 projectId 和 executionId。超时和重启不能证明执行结束。写回原文件和选择修改由用户在面板中完成。",
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
    description:
      "在当前 Codex 对话按绝对路径打开 Markdown 项目，自动启动服务并恢复草稿与历史。首次打开须提供 path，省略时恢复当前对话上次打开的项目。",
    inputSchema: { path: z.string().min(1).max(4096).optional() },
    _meta: {
      ui: { resourceUri: panelUri },
      "openai/ui": { entrypoints: [{ type: "thread" }] },
    },
  },
  async ({ path }, { _meta }) =>
    respond(async () => {
      const threadId = threadFromHost(_meta);
      if (projects) return projects.open(threadId, path);
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
      expectedProject: projectSchema.optional(),
      command: panelCommandSchema.optional(),
    },
    _meta: { ui: { visibility: ["app"] } },
  },
  async ({ expectedThread, expectedProject, command }, { _meta }) =>
    respond(async () => {
      const threadId = threadFromHost(_meta);
      if (threadId !== expectedThread)
        throw new Error("当前对话与打开 Agora 工作台的对话不同。");
      if (projects && !expectedProject)
        throw new Error("面板缺少项目身份，请重新打开文稿。");
      const selected = await projects?.get(threadId, expectedProject);
      const connection = selected?.connection ?? external();
      if (!projects) await worker({ action: "bind", threadId });
      const state = command
        ? await requestService(connection, "/api/panel", viewSchema, command)
        : await requestService(connection, "/api/state", viewSchema);
      return { state };
    }),
);

server.registerTool(
  "agora_claim_next",
  {
    description:
      "领取当前对话已打开项目的改稿任务。面板通知指定 projectId 时必须传入该身份。仅当返回 claimed 时编辑 candidatePath，完成后提交相同 projectId 和 executionId。",
    inputSchema: { projectId: projectSchema.optional() },
  },
  async ({ projectId }, { _meta }) =>
    respond(async () =>
      worker({ action: "claim", threadId: threadFromHost(_meta) }, projectId),
    ),
);

server.registerTool(
  "agora_submit_candidate",
  {
    description:
      "完成待审稿编辑后，提交领取时取得的 projectId 和 executionId。切换项目后仍须使用原项目身份。Agora 读取待审文件并计算差异。",
    inputSchema: {
      executionId: z.string().min(1),
      projectId: projectSchema.optional(),
    },
  },
  async ({ executionId, projectId }, { _meta }) =>
    respond(async () =>
      worker(
        {
          action: "submit",
          threadId: threadFromHost(_meta),
          executionId,
        },
        projectId,
      ),
    ),
);

server.registerTool(
  "agora_finish_execution",
  {
    description:
      "领取后的改稿执行失败或中断时，报告同一个 executionId 的结束状态。只有已停止编辑候选文件后才能报告 cancelled。",
    inputSchema: {
      executionId: z.string().min(1),
      projectId: projectSchema.optional(),
      outcome: z.enum(["failed", "cancelled"]),
    },
  },
  async ({ executionId, outcome, projectId }, { _meta }) =>
    respond(async () =>
      worker(
        {
          action: "finish",
          threadId: threadFromHost(_meta),
          executionId,
          outcome,
        },
        projectId,
      ),
    ),
);

let stopping: Promise<void> | undefined;
function stop(): Promise<void> {
  stopping ??= (async () => {
    await projects?.close();
    await server.close();
  })();
  return stopping;
}
const shutdown = () => {
  void stop().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
};
process.stdin.once("end", shutdown);
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
server.server.onclose = shutdown;
await server.connect(new StdioServerTransport());
