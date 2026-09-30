import { beforeEach, describe, expect, it } from "vitest";

import { createFeedbackHandler } from "@/app/api/feedback/handler";
import { hashSessionToken } from "@/lib/auth/session";
import type { Database, QueryResult, Queryable } from "@/lib/db/pool";

const user = { id: "00000000-0000-4000-8000-000000000001", username: "agent-01", role: "agent" as const, must_reset_password: false };
const otherUserId = "00000000-0000-4000-8000-000000000002";
const token = "d".repeat(64);
const now = new Date("2026-08-11T02:00:00.000Z");
const draftRunId = "10000000-0000-4000-8000-000000000001";

type StoredFeedback = { id: string; draftRunId: string; action: string; finalDraft: string | null; discardReason: string | null; discardNote: string | null; createdAt: Date };
type StoredReview = { id: string; feedbackId: string; category: string };

class FeedbackDatabase implements Database {
  feedback: StoredFeedback[] = [];
  reviews: StoredReview[] = [];
  ownerId = user.id;
  failReview = false;

  async query<T>(sql: string, values: readonly unknown[] = []): Promise<QueryResult<T>> {
    if (sql.includes("JOIN public.workbench_users")) {
      expect(values[0]).toBe(hashSessionToken(token));
      return { rows: [user as T], rowCount: 1 };
    }
    if (sql.includes("FROM public.draft_runs") && sql.includes("user_id = $2")) {
      return values[1] === this.ownerId ? { rows: [{ id: draftRunId } as T], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql.includes("FROM public.feedback_records")) {
      const row = this.feedback.find((item) => item.draftRunId === values[0]);
      return row ? { rows: [{ id: row.id, action: row.action, final_draft: row.finalDraft, discard_reason: row.discardReason, discard_note: row.discardNote, created_at: row.createdAt } as T], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    throw new Error(`unexpected outer query: ${sql}`);
  }

  async transaction<T>(work: (client: Queryable) => Promise<T>): Promise<T> {
    const feedback = [...this.feedback];
    const reviews = [...this.reviews];
    const client: Queryable = {
      query: async <R>(sql: string, values: readonly unknown[] = []): Promise<QueryResult<R>> => {
        if (sql.includes("pg_advisory_xact_lock") || sql.includes("public.draft_adjustments")) return { rows: [], rowCount: 0 };
        if (sql.includes("INSERT INTO public.feedback_records")) {
          if (feedback.some((row) => row.draftRunId === values[1])) {
            throw Object.assign(new Error("duplicate"), { code: "23505" });
          }
          feedback.push({ id: values[0] as string, draftRunId: values[1] as string, action: values[3] as string, finalDraft: values[4] as string | null, discardReason: values[5] as string | null, discardNote: values[6] as string | null, createdAt: values[7] as Date });
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("INSERT INTO public.review_items")) {
          if (this.failReview) throw new Error("injected review failure with secret DSN");
          reviews.push({ id: values[0] as string, feedbackId: values[1] as string, category: values[2] as string });
          return { rows: [], rowCount: 1 };
        }
        throw new Error(`unexpected transaction query: ${sql}`);
      },
    };
    const result = await work(client);
    this.feedback = feedback;
    this.reviews = reviews;
    return result;
  }
}

function request(body: unknown) {
  return new Request("http://workbench.invalid/api/feedback", {
    method: "POST",
    headers: { cookie: `workbench_session=${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function handler(db: FeedbackDatabase) {
  let counter = 0;
  return createFeedbackHandler({
    db,
    now: () => now,
    randomUUID: () => `20000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`,
  });
}

describe("feedback API", () => {
  let db: FeedbackDatabase;

  beforeEach(() => {
    db = new FeedbackDatabase();
  });

  it("rejects browser-supplied identity", async () => {
    const response = await handler(db)(request({ draftRunId, action: "adopted", userId: otherUserId }));
    expect(response.status).toBe(400);
    expect(db.feedback).toHaveLength(0);
  });

  it.each(["handoff", "unresolved", "sent"])("rejects retired action %s", async (action) => {
    expect((await handler(db)(request({ draftRunId, action }))).status).toBe(400);
  });

  it("requires a nonempty final draft only for modified feedback", async () => {
    expect((await handler(db)(request({ draftRunId, action: "modified", finalDraft: "   " }))).status).toBe(400);
    expect((await handler(db)(request({ draftRunId, action: "adopted", finalDraft: "not allowed" }))).status).toBe(400);
    expect((await handler(db)(request({ draftRunId, action: "modified", finalDraft: "客服最终稿" }))).status).toBe(201);
    expect(db.reviews).toHaveLength(1);
  });

  it("requires a note when discard reason is other", async () => {
    expect((await handler(db)(request({ draftRunId, action: "discarded", discardReason: "other", discardNote: "" }))).status).toBe(400);
    expect((await handler(db)(request({ draftRunId, action: "discarded", discardReason: "other", discardNote: "人工归类" }))).status).toBe(201);
  });

  it.each([
    "knowledge_incorrect",
    "question_unresolved",
    "wrong_product",
    "irrelevant_answer",
    "tone_or_style",
    "dynamic_data_required",
  ])("accepts discard reason %s and queues one review item", async (discardReason) => {
    const response = await handler(db)(request({ draftRunId, action: "discarded", discardReason }));
    expect(response.status).toBe(201);
    expect(db.feedback).toHaveLength(1);
    expect(db.reviews).toHaveLength(1);
  });

  it("returns the existing success for an identical adopted retry without a second row", async () => {
    const post = handler(db);
    expect((await post(request({ draftRunId, action: "adopted" }))).status).toBe(201);
    expect(db.reviews).toHaveLength(0);
    const retry = await post(request({ draftRunId, action: "adopted" }));
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ action: "adopted", idempotent: true });
    expect(db.feedback).toHaveLength(1);
  });

  it.each([
    [{ action: "modified", finalDraft: " 客服最终稿 " }, { action: "modified", finalDraft: "客服最终稿" }],
    [{ action: "discarded", discardReason: "other", discardNote: " 人工归类 " }, { action: "discarded", discardReason: "other", discardNote: "人工归类" }],
  ])("treats normalized identical payload retries as success", async (first, retry) => {
    const post = handler(db);
    expect((await post(request({ draftRunId, ...first }))).status).toBe(201);
    expect((await post(request({ draftRunId, ...retry }))).status).toBe(200);
    expect(db.feedback).toHaveLength(1);
    expect(db.reviews).toHaveLength(1);
  });

  it.each([
    [{ action: "adopted" }, { action: "modified", finalDraft: "不同动作" }],
    [{ action: "modified", finalDraft: "版本一" }, { action: "modified", finalDraft: "版本二" }],
    [{ action: "discarded", discardReason: "wrong_product" }, { action: "discarded", discardReason: "tone_or_style" }],
    [{ action: "discarded", discardReason: "other", discardNote: "说明一" }, { action: "discarded", discardReason: "other", discardNote: "说明二" }],
  ])("keeps different feedback payloads as conflicts", async (first, retry) => {
    const post = handler(db);
    expect((await post(request({ draftRunId, ...first }))).status).toBe(201);
    expect((await post(request({ draftRunId, ...retry }))).status).toBe(409);
    expect(db.feedback).toHaveLength(1);
  });

  it("rolls back feedback when review creation fails and redacts the exception", async () => {
    db.failReview = true;
    const response = await handler(db)(request({ draftRunId, action: "modified", finalDraft: "客服最终稿" }));
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(db.feedback).toHaveLength(0);
    expect(db.reviews).toHaveLength(0);
    expect(text).not.toContain("secret");
    expect(text).not.toContain("DSN");
  });

  it("cannot submit feedback for another user's draft", async () => {
    db.ownerId = otherUserId;
    expect((await handler(db)(request({ draftRunId, action: "adopted" }))).status).toBe(404);
  });
});
