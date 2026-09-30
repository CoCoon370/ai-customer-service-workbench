import { z } from "zod";

export const DISCARD_REASONS = [
  "knowledge_incorrect",
  "question_unresolved",
  "wrong_product",
  "irrelevant_answer",
  "tone_or_style",
  "dynamic_data_required",
  "other",
] as const;

const DraftId = z.string().uuid();

const Adopted = z.strictObject({
  draftRunId: DraftId,
  action: z.literal("adopted"),
});

const Modified = z.strictObject({
  draftRunId: DraftId,
  action: z.literal("modified"),
  finalDraft: z.string().trim().min(1).max(10_000),
});

const Discarded = z
  .strictObject({
    draftRunId: DraftId,
    action: z.literal("discarded"),
    discardReason: z.enum(DISCARD_REASONS),
    discardNote: z.string().trim().max(2_000).optional(),
  })
  .superRefine((payload, context) => {
    if (payload.discardReason === "other" && !payload.discardNote) {
      context.addIssue({ code: "custom", path: ["discardNote"], message: "discard note is required" });
    }
  });

export const FeedbackPayload = z.union([Adopted, Modified, Discarded]);
export type FeedbackInput = z.infer<typeof FeedbackPayload>;

export type ReviewCategory = "knowledge" | "product" | "retrieval" | "prompt" | "dynamic_data" | "other";

export function reviewCategory(input: FeedbackInput): ReviewCategory | null {
  if (input.action === "adopted") return null;
  if (input.action === "modified") return "other";
  const categories: Record<(typeof DISCARD_REASONS)[number], ReviewCategory> = {
    knowledge_incorrect: "knowledge",
    question_unresolved: "retrieval",
    wrong_product: "product",
    irrelevant_answer: "retrieval",
    tone_or_style: "prompt",
    dynamic_data_required: "dynamic_data",
    other: "other",
  };
  return categories[input.discardReason];
}
