import { z } from "zod";

const id = z.string().min(1).max(128);
const revision = z.number().int().nonnegative();
const body = z.string().max(2_000_000);
function withValidFocus<
  T extends {
    start: number;
    end: number;
    direction: "forward" | "backward";
    focusOffset?: number;
  },
>(anchor: T) {
  return {
    ...anchor,
    focusOffset:
      anchor.focusOffset !== undefined &&
      anchor.focusOffset >= anchor.start &&
      anchor.focusOffset <= anchor.end
        ? anchor.focusOffset
        : anchor.direction === "backward"
          ? anchor.start
          : anchor.end,
  };
}
export const commentSchema = z
  .object({
    id,
    start: revision,
    end: revision,
    quote: z.string().min(1).max(16_000),
    instruction: z.string().trim().min(1).max(4_000),
    revision: revision.default(0),
    resolved: z.boolean().default(true),
    focusOffset: z.number().int().optional(),
    direction: z.enum(["forward", "backward"]).default("forward"),
  })
  .transform(withValidFocus);
const comments = z.array(commentSchema).max(100);
export const commentDraftSchema = z
  .object({
    id,
    editingCommentId: id.nullable(),
    sourceRevision: revision,
    start: revision,
    end: revision,
    quote: z.string().max(16_000),
    instruction: z.string().max(4_000),
    focusOffset: z.number().int(),
    direction: z.enum(["forward", "backward"]),
  })
  .transform(withValidFocus);
export const changeSchema = z.object({
  id,
  start: revision,
  end: revision,
  before: body,
  after: body,
});
export const versionSchema = z.object({
  number: z.number().int().positive(),
  body,
  savedAt: z.iso.datetime().nullable().default(null),
  parentVersion: z.number().int().positive().nullable().default(null),
  operationId: id.nullable().default(null),
});
const draftInput = {
  revision,
  draft: body,
  comments,
  draftRevision: revision.default(0),
  commentDraft: commentDraftSchema.nullable().default(null),
};
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
    roundId: id,
    changeId: id,
    keep: z.boolean(),
  }),
  z.strictObject({ action: z.literal("cancel"), revision, roundId: id }),
  z.strictObject({
    action: z.literal("retry"),
    revision,
    roundId: id,
    requestId: id,
  }),
  z.strictObject({ action: z.literal("abandon"), revision, roundId: id }),
  z.strictObject({
    action: z.literal("adopt"),
    revision,
    version: z.number().int().positive(),
  }),
  z.strictObject({
    action: z.literal("apply"),
    revision,
    operationId: id,
    preview: body,
  }),
  z.strictObject({ action: z.literal("recheck"), operationId: id }),
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
  z.strictObject({
    action: z.literal("finish"),
    threadId: id,
    executionId: id,
    outcome: z.enum(["failed", "cancelled"]),
  }),
]);
export const workerResultSchema = z.union([
  z.object({ status: z.enum(["bound", "idle", "submitted", "finished"]) }),
  z.object({
    status: z.literal("claimed"),
    executionId: id,
    candidatePath: z.string().min(1),
    comments,
  }),
]);
const roundSeed = {
  id,
  base: body,
  submittedComments: comments,
  sourceDraftRevision: revision,
};
export const roundSchema = z.discriminatedUnion("phase", [
  z.object({ ...roundSeed, phase: z.enum(["waiting", "empty"]) }),
  z.object({ ...roundSeed, phase: z.literal("editing"), executionId: id }),
  z.object({
    ...roundSeed,
    phase: z.literal("interrupted"),
    executionId: id.nullable(),
    executionEnded: z.boolean(),
    message: z.string(),
  }),
  z.object({
    ...roundSeed,
    phase: z.literal("review"),
    candidate: body,
    changes: z.array(changeSchema),
    decisions: z.record(id, z.enum(["keep", "discard"])),
    preview: body,
  }),
]);
export const applyStatusSchema = z.discriminatedUnion("phase", [
  z.object({
    phase: z.literal("checking"),
    operationId: id,
    revision,
    sourceDraftRevision: revision,
  }),
  z.object({
    phase: z.literal("applied"),
    operationId: id,
    sourceDraftRevision: revision,
    version: z.number().int().positive(),
  }),
  z.object({
    phase: z.literal("not-written"),
    operationId: id,
    sourceDraftRevision: revision,
  }),
]);
export const viewSchema = z.object({
  documentId: id,
  documentName: z.string(),
  revision,
  draftRevision: revision,
  draft: body,
  comments,
  commentDraft: commentDraftSchema.nullable(),
  workingBase: z.object({ version: z.number().int().positive() }),
  versions: z.array(versionSchema),
  round: roundSchema.nullable(),
  applyStatus: applyStatusSchema.nullable(),
});
export type Comment = z.infer<typeof commentSchema>;
export type CommentDraft = z.infer<typeof commentDraftSchema>;
export type Change = z.infer<typeof changeSchema>;
export type Version = z.infer<typeof versionSchema>;
export type CommentChoice = "keep" | "discard";
export type View = z.infer<typeof viewSchema>;
export type PanelCommand = z.infer<typeof panelCommandSchema>;
export type WorkerCommand = z.infer<typeof workerCommandSchema>;
export type WorkerResult = z.infer<typeof workerResultSchema>;
export interface PanelTransport {
  getState(): Promise<View>;
  run(command: PanelCommand): Promise<View>;
}
