import { z } from "zod";
import { authenticateRequest } from "@/lib/auth/authorize";
import type { Database } from "@/lib/db/pool";
import type { AdjustmentInput, AgentDraftResponse } from "@/lib/agent-client";
import { SYSTEM_VERSION } from "@/lib/system-version";

const Payload = z.strictObject({
  draftRunId: z.string().uuid(), requestId: z.string().uuid(),
  instruction: z.string().trim().min(1).max(2200),
});
type Draft = { id: string; question: string; ai_draft: string; answer_mode: string; created_at: Date; root_id: string; round: number };
const resultBody = (row: Draft) => ({ id: row.id, draft: row.ai_draft, question: row.question,
  answerMode: row.answer_mode, createdAt: row.created_at.toISOString(), adjustmentCount: row.round,
  rootDraftId: row.root_id });

export function createAdjustmentHandler({ db, callAgent }: {
  db: Database; callAgent: (input: AdjustmentInput) => Promise<AgentDraftResponse>;
}) {
  return async (request: Request): Promise<Response> => {
    const user = await authenticateRequest(request, db, new Date());
    if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
    let input: z.infer<typeof Payload>;
    try { input = Payload.parse(await request.json()); }
    catch { return Response.json({ error: "invalid_request" }, { status: 400 }); }
    try {
      return await db.transaction(async (tx) => {
        const owned = await tx.query<Draft>(
          `SELECT d.*, COALESCE(a.root_draft_id, d.id) AS root_id, COALESCE(a.round, 0) AS round
             FROM public.draft_runs d LEFT JOIN public.draft_adjustments a ON a.draft_run_id = d.id
            WHERE d.id = $1 AND d.user_id = $2`, [input.draftRunId, user.id]);
        const parent = owned.rows[0];
        if (!parent) return Response.json({ error: "draft_not_found" }, { status: 404 });
        // Serialize the chain, including feedback, across tabs/processes. The unique
        // constraints remain a second line of defense, not a client-side counter.
        await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [parent.root_id]);
        const existing = await tx.query<Draft>(
          `SELECT d.*, a.root_draft_id AS root_id, a.round FROM public.draft_adjustments a
           JOIN public.draft_runs d ON d.id = a.draft_run_id
           WHERE a.request_id = $1 AND a.parent_draft_id = $2 AND d.user_id = $3`,
          [input.requestId, parent.id, user.id]);
        if (existing.rows[0]) return Response.json(resultBody(existing.rows[0]));
        const terminal = await tx.query<{ id: string }>(
          `SELECT id FROM public.feedback_records WHERE draft_run_id = $1
           UNION ALL SELECT draft_run_id AS id FROM public.draft_adjustments WHERE parent_draft_id = $1`, [parent.id]);
        if (terminal.rows.length) return Response.json({ error: "draft_already_handled" }, { status: 409 });
        if (parent.round >= 3) return Response.json({ error: "adjustment_limit" }, { status: 409 });
        const prior = await tx.query<{ ai_draft: string }>(
          `SELECT d.ai_draft FROM public.draft_runs d LEFT JOIN public.draft_adjustments a ON a.draft_run_id = d.id
           WHERE d.id = $1 OR a.root_draft_id = $1 ORDER BY COALESCE(a.round, 0)`, [parent.root_id]);
        const agent = await callAgent({ question: parent.question,
          previous_drafts: prior.rows.map(row => row.ai_draft), instruction: input.instruction });
        if (agent.answer_mode !== "draft") return Response.json({ error: agent.error_code ?? "adjustment_insufficient" }, { status: 422 });
        if (prior.rows.some(row => row.ai_draft.replace(/\s/g, "") === agent.draft.replace(/\s/g, ""))) {
          return Response.json({ error: "adjustment_unchanged" }, { status: 422 });
        }
        const timestamp = new Date();
        await tx.query(`INSERT INTO public.draft_runs
          (id, user_id, question, intent, answer_mode, ai_draft, faq_snapshot, product_snapshot,
           model_version, prompt_version, system_version, knowledge_version, created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13)`,
          [agent.run_id, user.id, parent.question, agent.intent, agent.answer_mode, agent.draft,
            JSON.stringify(agent.faq_hits), JSON.stringify(agent.product_hits), agent.model_version,
            agent.prompt_version, SYSTEM_VERSION, agent.knowledge_version, timestamp]);
        await tx.query(`INSERT INTO public.draft_adjustments
          (request_id, root_draft_id, parent_draft_id, draft_run_id, round, instruction, created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [input.requestId, parent.root_id, parent.id, agent.run_id, parent.round + 1, input.instruction, timestamp]);
        return Response.json(resultBody({ id: agent.run_id, question: parent.question, ai_draft: agent.draft,
          answer_mode: agent.answer_mode, created_at: timestamp, root_id: parent.root_id, round: parent.round + 1 }), { status: 201 });
      });
    } catch {
      return Response.json({ error: "adjustment_failed" }, { status: 502 });
    }
  };
}
