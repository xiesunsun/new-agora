import { createHash } from "node:crypto";
import { copyFile, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { createManagedRun } from "../runtime/src/index.mjs";
import { scriptedWorkerOptionsSchema } from "../../apps/worker/src/index.js";

const mockConfigSchema = z.strictObject({
  manuscript: z.string().min(1),
  comments: z
    .array(
      z.strictObject({
        quote: z.string().min(1),
        instruction: z.string().min(1),
      }),
    )
    .default([]),
  worker: scriptedWorkerOptionsSchema,
});

export async function prepareMock(configPath: string) {
  const configBytes = await readFile(configPath);
  const config = mockConfigSchema.parse(
    JSON.parse(configBytes.toString("utf8")),
  );
  const run = await createManagedRun("mock");
  try {
    const root = run.root;
    const originalPath = join(root, "manuscript.md");
    await copyFile(
      resolve(dirname(configPath), config.manuscript),
      originalPath,
    );
    const draft = await readFile(originalPath, "utf8");
    const comments = config.comments.map((comment, index) => {
      const start = draft.indexOf(comment.quote);
      if (start < 0 || draft.indexOf(comment.quote, start + 1) >= 0)
        throw new Error(
          `Mock comment must have one exact anchor: ${comment.quote}`,
        );
      return {
        ...comment,
        id: `mock-note-${index + 1}`,
        start,
        end: start + comment.quote.length,
        revision: 0,
        resolved: true,
        focusOffset: start + comment.quote.length,
        direction: "forward" as const,
      };
    });
    return {
      ...run,
      configPath,
      configDigest: createHash("sha256").update(configBytes).digest("hex"),
      originalPath,
      runtimeDir: join(root, "runtime"),
      worker: config.worker,
      comments,
    };
  } catch (error) {
    await run.release();
    throw error;
  }
}
