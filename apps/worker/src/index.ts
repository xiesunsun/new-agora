import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  workerResultSchema,
  type WorkerCommand,
} from "../../../packages/contracts/src/index.js";

const threadId = "a01-script";
const replacements = new Map([
  ["本周完成初稿", "周四上午完成初稿"],
  ["周五前交付", "下周一交付"],
]);

export async function startScriptedWorker(
  url: string,
  token: string,
  signal: AbortSignal,
) {
  async function request(command: WorkerCommand) {
    const response = await fetch(new URL("/api/worker", url), {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(command),
    });
    if (!response.ok)
      throw new Error(`Scripted worker: ${await response.text()}`);
    return workerResultSchema.parse(await response.json());
  }

  await request({ action: "bind", threadId });
  while (!signal.aborted) {
    await delay(550, undefined, { signal });
    const claim = await request({ action: "claim", threadId });
    if (claim.status !== "claimed") continue;

    const base = await readFile(claim.candidatePath, "utf8");
    let candidate = base;
    for (const comment of [...claim.comments].sort(
      (a, b) => b.start - a.start,
    )) {
      const replacement = replacements.get(comment.quote);
      if (
        replacement &&
        base.slice(comment.start, comment.end) === comment.quote
      ) {
        candidate =
          candidate.slice(0, comment.start) +
          replacement +
          candidate.slice(comment.end);
      }
    }
    await delay(650, undefined, { signal });
    await writeFile(claim.candidatePath, candidate);
    await request({
      action: "submit",
      threadId,
      executionId: claim.executionId,
    });
  }
}
