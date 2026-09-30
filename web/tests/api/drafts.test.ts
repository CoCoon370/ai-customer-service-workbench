import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDraftHandler } from "@/app/api/drafts/handler";
import { createHistoryHandler } from "@/app/api/history/handler";
import { createAgentClient, type AgentDraftResponse } from "@/lib/agent-client";
import { hashSessionToken } from "@/lib/auth/session";
import type { Database, QueryResult, Queryable } from "@/lib/db/pool";

const user = {
  id: "00000000-0000-0000-0000-000000000001",
  username: "agent-01",
  role: "agent" as const,
  must_reset_password: false,
};
const otherUserId = "00000000-0000-0000-0000-000000000002";
const token = "c".repeat(64);
const now = new Date("2026-08-11T01:00:00.000Z");

const auditedDraft: AgentDraftResponse = {
  run_id: "10000000-0000-4000-8000-000000000001",
  intent: "product_question",
  answer_mode: "draft",
  draft: "这款商品请密封后放在阴凉处保存。",
  faq_hits: [
    {
      card_id: "faq-1",
      answer: "阴凉保存",
      category: "storage",
      source_snapshot: { source: "audited" },
      score: 0.91,
      knowledge_version: "knowledge-2026-08-10-v1",
    },
  ],
  product_hits: [
    {
      product_id: "p-1",
      name: "虚构商品",
      sku_ids: ["sku-1"],
      stable_facts: { storage: "阴凉" },
      source_snapshot: { source: "audited" },
      score: 0.92,
      knowledge_version: "knowledge-2026-08-10-v1",
    },
  ],
  model_version: "qwen-plus",
  prompt_version: "workbench-v1",
  knowledge_version: "knowledge-2026-08-10-v1",
  insufficient_fields: [],
  retryable: false,
  error_code: null,
};

class DraftDatabase implements Database {
  inserted: { sql: string; values: readonly unknown[] }[] = [];
  history = [
    {
      id: "new",
      question: "new question",
      ai_draft: "new draft",
      final_draft: "客服最终稿",
      feedback_action: "modified",
      discard_reason: null,
      discard_note: null,
      answer_mode: "draft",
      created_at: new Date("2026-08-11T00:02:00Z"),
    },
    {
      id: "old",
      question: "old question",
      ai_draft: "old draft",
      answer_mode: "draft",
      created_at: new Date("2026-08-11T00:01:00Z"),
    },
    {
      id: "other",
      user_id: otherUserId,
      question: "private",
      ai_draft: "private",
      answer_mode: "draft",
      created_at: new Date("2026-08-11T00:03:00Z"),
    },
  ];

  async query<T>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<T>> {
    if (sql.includes("JOIN public.workbench_users")) {
      expect(values[0]).toBe(hashSessionToken(token));
      return { rows: [user as T], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO public.draft_runs")) {
      this.inserted.push({ sql, values });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("FROM public.draft_runs") && sql.includes("LIMIT 20")) {
      expect(values).toEqual([user.id]);
      expect(sql).toContain("WHERE d.user_id = $1");
      expect(sql).toContain("ORDER BY d.created_at DESC");
      return {
        rows: this.history
          .filter((row) => !("user_id" in row) || row.user_id === user.id)
          .slice(0, 20) as T[],
        rowCount: 2,
      };
    }
    throw new Error(`unexpected query: ${sql}`);
  }

  async transaction<T>(work: (client: Queryable) => Promise<T>): Promise<T> {
    return work(this);
  }
}

function authenticatedRequest(path: string, init: RequestInit = {}) {
  return new Request(`http://workbench.invalid${path}`, {
    ...init,
    headers: {
      cookie: `workbench_session=${token}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });
}

describe("draft and history APIs", () => {
  let db: DraftDatabase;

  beforeEach(() => {
    db = new DraftDatabase();
  });

  it("stores the authenticated user and complete agent audit while returning only the browser contract", async () => {
    const response = await createDraftHandler({
      db,
      now: () => now,
      callAgent: async () => auditedDraft,
    })(
      authenticatedRequest("/api/drafts", {
        method: "POST",
        body: JSON.stringify({ question: "  这款怎么保存？  " }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(Object.keys(body).sort()).toEqual([
      "answerMode",
      "createdAt",
      "draft",
      "id",
    ]);
    expect(db.inserted).toHaveLength(1);
    expect(db.inserted[0].values).toContain(user.id);
    expect(db.inserted[0].values).toContain("这款怎么保存？");
    expect(db.inserted[0].values).toContain(
      JSON.stringify(auditedDraft.faq_hits),
    );
    expect(db.inserted[0].values).toContain(
      JSON.stringify(auditedDraft.product_hits),
    );
    expect(db.inserted[0].values).toContain(
      "workbench-adjustments-20260918-v1",
    );
    expect(db.inserted[0].sql).toContain("system_version");
  });

  it("rejects browser identity fields instead of trusting them", async () => {
    const response = await createDraftHandler({
      db,
      now: () => now,
      callAgent: async () => auditedDraft,
    })(
      authenticatedRequest("/api/drafts", {
        method: "POST",
        body: JSON.stringify({ question: "测试", userId: otherUserId }),
      }),
    );
    expect(response.status).toBe(400);
    expect(db.inserted).toHaveLength(0);
  });

  it("redacts Agent failures and never stores a failed draft", async () => {
    const response = await createDraftHandler({
      db,
      now: () => now,
      callAgent: async () => {
        throw new Error("WORKBENCH_AGENT_TOKEN=secret postgresql://private");
      },
    })(
      authenticatedRequest("/api/drafts", {
        method: "POST",
        body: JSON.stringify({ question: "测试" }),
      }),
    );
    const text = await response.text();

    expect(response.status).toBe(502);
    expect(text).toContain("draft_service_unavailable");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("postgresql");
    expect(db.inserted).toHaveLength(0);
  });

  it("calls only the fixed loopback Agent endpoint with a server token", async () => {
    const fetcher = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify(auditedDraft), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const callAgent = createAgentClient({
      token: "server-only-token",
      fetcher,
    });

    await callAgent("虚构问题");

    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:2124/v1/drafts");
    expect(init).toBeDefined();
    expect(init?.headers).toMatchObject({
      "x-internal-token": "server-only-token",
    });
  });

  it("returns only the session user's newest twenty history rows", async () => {
    const response = await createHistoryHandler({ db, now: () => now })(
      authenticatedRequest("/api/history"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.items.map((item: { id: string }) => item.id)).toEqual([
      "new",
      "old",
    ]);
    expect(JSON.stringify(body)).not.toContain("private");
    expect(body.items[0]).toMatchObject({
      draft: "new draft",
      finalDraft: "客服最终稿",
      feedbackAction: "modified",
    });
    expect(db.inserted).toHaveLength(0);
  });
});
