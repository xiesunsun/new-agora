import { viewSchema } from "../../../packages/contracts/src/index.js";
import { mountPanel } from "./index.js";

async function readView(response: Response) {
  const data: unknown = await response.json();
  if (!response.ok) {
    const message =
      data &&
      typeof data === "object" &&
      "error" in data &&
      typeof data.error === "string"
        ? data.error
        : "本地服务请求失败。";
    throw new Error(message);
  }
  return viewSchema.parse(data);
}

mountPanel({
  async getState() {
    return readView(await fetch("/api/state", { cache: "no-store" }));
  },
  async run(command) {
    return readView(
      await fetch("/api/panel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(command),
      }),
    );
  },
});
