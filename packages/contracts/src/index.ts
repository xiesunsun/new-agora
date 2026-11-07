import { z } from "zod";

const id = z.string().min(1).max(128);
const revision = z.number().int().nonnegative();
const body = z.string().max(2_000_000);

const commentSchema = z.object({
  id,
  start: revision,
  end: revision,
  quote: z.string().min(1).max(16_000),
  instruction: z.string().trim().min(1).max(4_000),
});
const comments = z.array(commentSchema).max(100);

const changeSchema = z.object({
  id,
  start: revision,
  end: revision,
  before: body,
  after: body,
});

const draftInput = { revision, draft: body, comments };

export const panelCommandSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("save"), ...draftInput }),
  z.strictObject({
    action: z.literal("generate"),
    ...draftInput,
    requestId: id,
  }),
  z.strictObject({
    action: z.literal("choose"),
    revision,
    changeId: id,
    keep: z.boolean(),
  }),
  z.strictObject({
    action: z.literal("apply"),
    revision,
    operationId: id,
    preview: body,
  }),
]);

export const workerCommandSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("bind"),
    threadId: id,
    path: z.string().min(1).optional(),
  }),
  z.strictObject({ action: z.literal("claim"), threadId: id }),
  z.strictObject({
    action: z.literal("submit"),
    threadId: id,
    executionId: id,
  }),
]);

export const workerResultSchema = z.union([
  z.object({ status: z.enum(["bound", "idle", "submitted"]) }),
  z.object({
    status: z.literal("claimed"),
    executionId: id,
    candidatePath: z.string().min(1),
    comments,
  }),
]);

export const viewSchema = z.object({
  documentName: z.string(),
  revision,
  draft: body,
  comments,
  versions: z.array(z.object({ number: z.number().int().positive(), body })),
  round: z
    .discriminatedUnion("phase", [
      z.object({ phase: z.enum(["waiting", "editing", "empty"]) }),
      z.object({
        phase: z.literal("review"),
        changes: z.array(changeSchema),
        decisions: z.record(id, z.enum(["keep", "discard"])),
        preview: body,
      }),
    ])
    .nullable(),
  applyStatus: z
    .discriminatedUnion("phase", [
      z.object({ phase: z.literal("checking"), operationId: id, revision }),
      z.object({
        phase: z.literal("applied"),
        version: z.number().int().positive(),
      }),
    ])
    .nullable(),
});

export type Comment = z.infer<typeof commentSchema>;
export type Change = z.infer<typeof changeSchema>;
export type View = z.infer<typeof viewSchema>;
export type PanelCommand = z.infer<typeof panelCommandSchema>;
export type WorkerCommand = z.infer<typeof workerCommandSchema>;
export type WorkerResult = z.infer<typeof workerResultSchema>;

export interface PanelTransport {
  getState(): Promise<View>;
  run(command: PanelCommand): Promise<View>;
}
