import { randomUUID } from "node:crypto";

import { authenticateRequest } from "@/lib/auth/authorize";
import type { Database } from "@/lib/db/pool";
import { FeedbackPayload, reviewCategory } from "@/lib/validation/feedback";

type ExistingFeedback = {
  id: string;
  action: "adopted" | "modified" | "discarded";
  final_draft: string | null;
  discard_reason: string | null;
  discard_note: string | null;
  created_at: Date;
};
type FeedbackDependencies = {
  db: Database;
  now?: () => Date;
  randomUUID?: () => string;
};

export function createFeedbackHandler({ db, now = () => new Date(), randomUUID: nextId = randomUUID }: FeedbackDependencies) {
  return async function createFeedback(request: Request): Promise<Response> {
    const timestamp = now();
    const user = await authenticateRequest(request, db, timestamp);
    if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

    let payload;
    try {
      payload = FeedbackPayload.parse(await request.json());
    } catch {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }

    const ownedDraft = await db.query<{ id: string }>(
      `SELECT id FROM public.draft_runs WHERE id = $1 AND user_id = $2 LIMIT 1`,
      [payload.draftRunId, user.id],
    );
    if (!ownedDraft.rows[0]) return Response.json({ error: "draft_not_found" }, { status: 404 });

    const feedbackId = nextId();
    try {
      await db.transaction(async (client) => {
        const chain = await client.query<{ root_id: string }>(
          `SELECT COALESCE((SELECT root_draft_id FROM public.draft_adjustments WHERE draft_run_id = $1), $1::uuid) AS root_id`,
          [payload.draftRunId],
        );
        await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [chain.rows[0]?.root_id ?? payload.draftRunId]);
        const superseded = await client.query<{ id: string }>(
          `SELECT draft_run_id AS id FROM public.draft_adjustments WHERE parent_draft_id = $1`, [payload.draftRunId]);
        if (superseded.rows.length) throw Object.assign(new Error("draft_superseded"), { code: "SUPERSEDED" });
        await client.query(
          `INSERT INTO public.feedback_records
             (id, draft_run_id, user_id, action, final_draft, discard_reason, discard_note, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
          [
            feedbackId,
            payload.draftRunId,
            user.id,
            payload.action,
            payload.action === "modified" ? payload.finalDraft : null,
            payload.action === "discarded" ? payload.discardReason : null,
            payload.action === "discarded" ? payload.discardNote ?? null : null,
            timestamp,
          ],
        );
        const category = reviewCategory(payload);
        if (category) {
          await client.query(
            `INSERT INTO public.review_items (id, feedback_id, category, status, created_at, updated_at)
             VALUES ($1, $2, $3, 'pending', $4, $4)`,
            [nextId(), feedbackId, category, timestamp],
          );
        }
      });
    } catch (error) {
      if ((error as { code?: string }).code === "SUPERSEDED") {
        return Response.json({ error: "draft_superseded" }, { status: 409 });
      }
      if ((error as { code?: string }).code === "23505") {
        const existing = await db.query<ExistingFeedback>(
          `SELECT id, action, final_draft, discard_reason, discard_note, created_at
             FROM public.feedback_records
            WHERE draft_run_id = $1 AND user_id = $2
            LIMIT 1`,
          [payload.draftRunId, user.id],
        );
        const row = existing.rows[0];
        const finalDraft = payload.action === "modified" ? payload.finalDraft : null;
        const discardReason = payload.action === "discarded" ? payload.discardReason : null;
        const discardNote = payload.action === "discarded" ? payload.discardNote ?? null : null;
        if (
          row &&
          row.action === payload.action &&
          row.final_draft === finalDraft &&
          row.discard_reason === discardReason &&
          row.discard_note === discardNote
        ) {
          return Response.json({ id: row.id, action: row.action, createdAt: row.created_at.toISOString(), idempotent: true });
        }
        return Response.json({ error: "feedback_already_submitted" }, { status: 409 });
      }
      return Response.json({ error: "feedback_save_failed" }, { status: 500 });
    }

    return Response.json({ id: feedbackId, action: payload.action, createdAt: timestamp.toISOString() }, { status: 201 });
  };
}
