import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  workerResultSchema,
  type WorkerCommand,
} from "../../../packages/contracts/src/index.js";

export const scriptedWorkerOptionsSchema = z.strictObject({
  threadId: z.string().min(1).max(128),
  pollMs: z.number().int().min(1).max(60_000),
  editMs: z.number().int().min(0).max(600_000),
  rules: z.array(
    z.strictObject({
      quote: z.string().min(1),
      instruction: z.string().optional(),
      replacement: z.string(),
    }),
  ),
  results: z
    .array(
      z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("rules") }),
        z.strictObject({
          kind: z.literal("candidate"),
          body: z.string().max(2_000_000),
        }),
        z.strictObject({ kind: z.enum(["failed", "cancelled"]) }),
      ]),
    )
    .min(1),
});
export type ScriptedWorkerOptions = z.infer<typeof scriptedWorkerOptionsSchema>;

export async function startScriptedWorker(
  url: string,
  token: string,
  signal: AbortSignal,
  options: ScriptedWorkerOptions,
): Promise<void> {
  const { threadId } = options;
  async function request(command: WorkerCommand) {
    const response = await fetch(new URL("/api/worker", url), {
      method: "POST",
      signal: AbortSignal.timeout(12_000),
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
  let resultIndex = 0;
  while (!signal.aborted) {
    try {
      await delay(options.pollMs, undefined, { signal });
    } catch (error) {
      if (signal.aborted) return;
      throw error;
    }
    const claim = await request({ action: "claim", threadId });
    if (claim.status !== "claimed") continue;
    try {
      if (signal.aborted) throw new Error("Scripted worker stopped");
      const base = await readFile(claim.candidatePath, "utf8");
      const result =
        options.results[Math.min(resultIndex++, options.results.length - 1)];
      await delay(options.editMs, undefined, { signal });
      if (result.kind === "failed" || result.kind === "cancelled") {
        await request({
          action: "finish",
          threadId,
          executionId: claim.executionId,
          outcome: result.kind,
        });
        continue;
      }
      let candidate = result.kind === "candidate" ? result.body : base;
      if (result.kind === "rules") {
        let cursor = base.length;
        for (const comment of [...claim.comments].sort(
          (a, b) => b.start - a.start,
        )) {
          const rule = options.rules.find(
            (rule) =>
              rule.quote === comment.quote &&
              (rule.instruction === undefined ||
                rule.instruction === comment.instruction),
          );
          if (
            !rule ||
            comment.end > cursor ||
            base.slice(comment.start, comment.end) !== comment.quote
          )
            continue;
          candidate =
            candidate.slice(0, comment.start) +
            rule.replacement +
            candidate.slice(comment.end);
          cursor = comment.start;
        }
      }
      await writeFile(claim.candidatePath, candidate);
      if (signal.aborted) throw new Error("Scripted worker stopped");
      await request({
        action: "submit",
        threadId,
        executionId: claim.executionId,
      });
    } catch (error) {
      await request({
        action: "finish",
        threadId,
        executionId: claim.executionId,
        outcome: signal.aborted ? "cancelled" : "failed",
      });
      if (signal.aborted) return;
      throw error;
    }
  }
}
