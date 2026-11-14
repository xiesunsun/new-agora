import { readFileSync } from "node:fs";
import { z } from "zod";
import type {
  PanelCommand,
  WorkerCommand,
} from "../../../packages/contracts/src/index.js";

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
export type Connection = z.infer<typeof connectionSchema>;

export function readConnection(path: string): Connection {
  return connectionSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export async function requestService<T>(
  connection: Connection,
  route: "/api/state" | "/api/panel" | "/api/worker",
  schema: z.ZodType<T>,
  command?: PanelCommand | WorkerCommand,
): Promise<T> {
  const headers = new Headers();
  if (route === "/api/worker")
    headers.set("Authorization", `Bearer ${connection.workerToken}`);
  if (command) headers.set("Content-Type", "application/json");
  let response: Response;
  try {
    response = await fetch(new URL(route, connection.url), {
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
