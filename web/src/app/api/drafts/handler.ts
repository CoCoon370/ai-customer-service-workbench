import { z } from "zod";

import type { AgentDraftResponse } from "@/lib/agent-client";
import { authenticateRequest } from "@/lib/auth/authorize";
import type { Database } from "@/lib/db/pool";
import { SYSTEM_VERSION } from "@/lib/system-version";

type DraftDependencies = {
  db: Database;
  now?: () => Date;
  callAgent: (question: string) => Promise<AgentDraftResponse>;
};

const DraftPayload = z.strictObject({
  question: z.string().trim().min(1).max(2000),
});

export function createDraftHandler({
  db,
  callAgent,
  now = () => new Date(),
}: DraftDependencies) {
  return async function createDraft(request: Request): Promise<Response> {
    const timestamp = now();
    const user = await authenticateRequest(request, db, timestamp);
    if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

    let payload: z.infer<typeof DraftPayload>;
    try {
      payload = DraftPayload.parse(await request.json());
    } catch {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }

    let agent: AgentDraftResponse;
    try {
      agent = await callAgent(payload.question);
    } catch {
      return Response.json(
        { error: "draft_service_unavailable" },
        { status: 502 },
      );
    }

    await db.query(
      `INSERT INTO public.draft_runs
         (id, user_id, question, intent, answer_mode, ai_draft, faq_snapshot,
          product_snapshot, model_version, prompt_version, system_version, knowledge_version, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12, $13)`,
      [
        agent.run_id,
        user.id,
        payload.question,
        agent.intent,
        agent.answer_mode,
        agent.draft,
        JSON.stringify(agent.faq_hits),
        JSON.stringify(agent.product_hits),
        agent.model_version,
        agent.prompt_version,
        SYSTEM_VERSION,
        agent.knowledge_version,
        timestamp,
      ],
    );

    return Response.json(
      {
        id: agent.run_id,
        draft: agent.draft,
        answerMode: agent.answer_mode,
        createdAt: timestamp.toISOString(),
      },
      { status: 201 },
    );
  };
}
