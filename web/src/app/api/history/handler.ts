import { authenticateRequest } from "@/lib/auth/authorize";
import type { Database } from "@/lib/db/pool";

type HistoryRow = {
  id: string;
  question: string;
  ai_draft: string;
  answer_mode: string;
  created_at: Date;
  feedback_action?: string | null;
  final_draft?: string | null;
  discard_reason?: string | null;
  discard_note?: string | null;
  adjustment_round?: number;
  adjustment_instruction?: string | null;
  superseded?: boolean;
};

export function createHistoryHandler({ db, now = () => new Date() }: { db: Database; now?: () => Date }) {
  return async function history(request: Request): Promise<Response> {
    const user = await authenticateRequest(request, db, now());
    if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

    const result = await db.query<HistoryRow>(
      `SELECT d.id, d.question, d.ai_draft, d.answer_mode, d.created_at,
              f.action AS feedback_action, f.final_draft, f.discard_reason, f.discard_note,
              COALESCE(a.round, 0) AS adjustment_round, a.instruction AS adjustment_instruction,
              EXISTS(SELECT 1 FROM public.draft_adjustments child WHERE child.parent_draft_id = d.id) AS superseded
         FROM public.draft_runs d
         LEFT JOIN public.feedback_records f ON f.draft_run_id = d.id
         LEFT JOIN public.draft_adjustments a ON a.draft_run_id = d.id
        WHERE d.user_id = $1
        ORDER BY d.created_at DESC
        LIMIT 20`,
      [user.id],
    );
    return Response.json({
      items: result.rows.map((row) => ({
        id: row.id,
        question: row.question,
        draft: row.ai_draft,
        answerMode: row.answer_mode,
        createdAt: row.created_at.toISOString(),
        feedbackAction: row.feedback_action ?? null,
        finalDraft: row.final_draft ?? null,
        discardReason: row.discard_reason ?? null,
        discardNote: row.discard_note ?? null,
        adjustmentCount: row.adjustment_round ?? 0,
        adjustmentInstruction: row.adjustment_instruction ?? null,
        superseded: row.superseded ?? false,
      })),
    });
  };
}
