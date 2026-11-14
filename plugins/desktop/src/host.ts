import { App } from "@modelcontextprotocol/ext-apps";
import { OpenAIExtensions } from "@openai/mcp-extensions/app";
import { z } from "zod";
import { viewSchema } from "../../../packages/contracts/src/index.js";
import type {
  PanelCommand,
  PanelTransport,
} from "../../../packages/contracts/src/index.js";
import manifest from "../.codex-plugin/plugin.json" with { type: "json" };

declare const AgoraPanel: { mountPanel(transport: PanelTransport): () => void };

const app = new App(
  { name: manifest.interface.displayName, version: manifest.version },
  {},
);
const extension = new OpenAIExtensions(app);
const openSchema = z.object({
  threadId: z.string().min(1),
  projectId: z.string().optional(),
});
const replySchema = z.object({ state: viewSchema });
const errorSchema = z.object({ error: z.string() });
const warning = document.createElement("p");
warning.hidden = true;
warning.setAttribute("role", "alert");
document.body.prepend(warning);

function displayWarning(message: string) {
  warning.textContent = message;
  warning.hidden = !message;
}

async function panelRequest(
  expectedThread: string,
  expectedProject?: string,
  command?: PanelCommand,
) {
  const result = await app.callServerTool({
    name: "agora_panel",
    arguments: {
      expectedThread,
      ...(expectedProject ? { expectedProject } : {}),
      ...(command ? { command } : {}),
    },
  });
  if (result.isError) {
    const problem = errorSchema.safeParse(result.structuredContent);
    throw new Error(problem.success ? problem.data.error : "Agora 请求失败。");
  }
  return replySchema.parse(result.structuredContent).state;
}

async function notifyCodex(projectId?: string) {
  const text = `Agora 文稿工作台提交了改稿请求。请调用 agora_claim_next${projectId ? `，传入 projectId: ${projectId}` : ""}。只有领取成功后才编辑返回的待审稿，然后用领取结果的 projectId 和 executionId 调用 agora_submit_candidate 交回结果。`;
  const message = {
    role: "user" as const,
    content: [{ type: "text" as const, text }],
  };
  try {
    const result = extension.message
      ? await extension.message.send(
          {
            ...message,
            _meta: { "openai/message": { target: "active", send: true } },
          },
          { timeout: 15000 },
        )
      : await app.sendMessage(message, { timeout: 15000 });
    if (result.isError) throw new Error("Host rejected the wake-up.");
    displayWarning("");
  } catch {
    displayWarning("批注已保存。请在当前对话中让 Codex 领取 Agora 待审稿。");
  }
}

let mounted = false;
app.ontoolresult = (result) => {
  if (mounted) return;
  if (result.isError) {
    const problem = errorSchema.safeParse(result.structuredContent);
    displayWarning(problem.success ? problem.data.error : "Agora 打开失败。");
    return;
  }
  const opening = openSchema.safeParse(result.structuredContent);
  if (!opening.success) return;

  const { threadId, projectId } = opening.data;
  let notifiedRoundId: string | undefined;
  mounted = true;
  const unmount = AgoraPanel.mountPanel({
    getState: () => panelRequest(threadId, projectId),
    async run(command) {
      const state = await panelRequest(threadId, projectId, command);
      if (
        (command.action === "generate" || command.action === "retry") &&
        state.round?.phase === "waiting" &&
        notifiedRoundId !== state.round.id
      ) {
        notifiedRoundId = state.round.id;
        void notifyCodex(projectId);
      }
      return state;
    },
  });
  window.addEventListener("pagehide", unmount, { once: true });
};

try {
  await app.connect();
} catch {
  displayWarning("Agora 无法连接当前 Codex 对话。");
}
