import { z } from "zod";

const AGENT_URL = "http://127.0.0.1:2124/v1/drafts";

const FaqHit = z.strictObject({
  card_id: z.string(),
  answer: z.string(),
  category: z.string(),
  source_snapshot: z.record(z.string(), z.unknown()),
  score: z.number(),
  knowledge_version: z.string(),
});

const ProductHit = z.strictObject({
  product_id: z.string(),
  name: z.string(),
  sku_ids: z.array(z.string()),
  stable_facts: z.record(z.string(), z.unknown()),
  source_snapshot: z.record(z.string(), z.unknown()),
  score: z.number(),
  knowledge_version: z.string(),
});

const AgentDraft = z.strictObject({
  run_id: z.string().uuid(),
  intent: z.string(),
  answer_mode: z.enum(["draft", "insufficient", "error"]),
  draft: z.string().min(1),
  faq_hits: z.array(FaqHit),
  product_hits: z.array(ProductHit),
  model_version: z.string(),
  prompt_version: z.string(),
  knowledge_version: z.string(),
  insufficient_fields: z.array(z.string()),
  retryable: z.boolean(),
  error_code: z.string().nullable(),
});

export type AgentDraftResponse = z.infer<typeof AgentDraft>;

type AgentClientDependencies = {
  token: string;
  fetcher?: typeof fetch;
};

export function createAgentClient({ token, fetcher = fetch }: AgentClientDependencies) {
  if (!token) throw new Error("agent client is not configured");
  return async function callAgent(question: string): Promise<AgentDraftResponse> {
    const response = await fetcher(AGENT_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-token": token },
      body: JSON.stringify({ question }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error("agent request failed");
    try {
      return AgentDraft.parse(await response.json());
    } catch {
      throw new Error("agent response was invalid");
    }
  };
}

export function getAgentClient() {
  return createAgentClient({ token: process.env.WORKBENCH_AGENT_TOKEN ?? "" });
}

export type AdjustmentInput = { question: string; previous_drafts: string[]; instruction: string };

export function getAdjustmentClient() {
  return async (input: AdjustmentInput): Promise<AgentDraftResponse> => {
    const token = process.env.WORKBENCH_AGENT_TOKEN;
    if (!token) throw new Error("agent client is not configured");
    const response = await fetch("http://127.0.0.1:2124/v1/adjustments", {
      method: "POST", headers: { "content-type": "application/json", "x-internal-token": token },
      body: JSON.stringify(input), signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error("adjustment request failed");
    return AgentDraft.parse(await response.json());
  };
}
