import { expect, it, vi } from "vitest";
import { createAdjustmentHandler } from "@/app/api/adjustments/handler";
import type { Database, Queryable } from "@/lib/db/pool";
const id = "10000000-0000-4000-8000-000000000001";
const next = "10000000-0000-4000-8000-000000000002";
const body = { draftRunId: id, requestId: next, instruction: "更亲切，先回应担心" };
const request = (payload: unknown = body) => new Request("http://local/api/adjustments", { method: "POST", headers: { cookie: `workbench_session=${"d".repeat(64)}` }, body: JSON.stringify(payload) });
function setup({ round = 0, owned = true, terminal = false, duplicate = false, mode = "draft", unchanged = false } = {}) {
  const writes: string[] = [];
  const query = vi.fn(async (sql: string) => {
    let rows: unknown[] = [];
    if (sql.includes("JOIN public.workbench_users")) rows = [{ id: "user" }];
    else if (sql.includes("WHERE d.id = $1 AND d.user_id")) rows = owned ? [{ id, question: "硬果能吃吗", ai_draft: "原稿", root_id: id, round }] : [];
    else if (sql.includes("pg_advisory_xact_lock")) rows = [];
    else if (sql.includes("WHERE a.request_id")) rows = duplicate ? [{ id: next, ai_draft: "已生成稿", question: "硬果能吃吗", answer_mode: "draft", root_id: id, round: 1, created_at: new Date() }] : [];
    else if (sql.includes("UNION ALL")) rows = terminal ? [{ id: next }] : [];
    else if (sql.includes("SELECT d.ai_draft")) rows = [{ ai_draft: "原稿" }];
    else if (sql.includes("INSERT INTO")) writes.push(sql);
    else throw new Error(sql);
    return { rows, rowCount: rows.length };
  });
  const db = { query, transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => fn({ query } as Queryable) } as unknown as Database;
  const agent = vi.fn(async () => ({ run_id: next, draft: unchanged ? "原稿" : "新的有温度的回复", answer_mode: mode, faq_hits: [], product_hits: [], intent: "faq_question", model_version: "test", prompt_version: "test", knowledge_version: "test", insufficient_fields: [], retryable: false, error_code: null } as any));
  return { handler: createAdjustmentHandler({ db, callAgent: agent }), agent, writes, query };
}
it("passes server-owned original and guidance, stores both draft and chain", async () => {
  const s = setup(); expect((await s.handler(request())).status).toBe(201);
  expect(s.agent).toHaveBeenCalledWith({ question: "硬果能吃吗", previous_drafts: ["原稿"], instruction: body.instruction });
  expect(s.writes).toHaveLength(2);
  expect(s.query.mock.calls.some(([sql]) => sql.includes("pg_advisory_xact_lock"))).toBe(true);
});
it.each([{ round: 3 }, { terminal: true }])("blocks completed/maxed chains", async opts => {
  const s = setup(opts); expect((await s.handler(request())).status).toBe(409); expect(s.agent).not.toHaveBeenCalled();
});
it("denies other users' drafts", async () => {
  const s = setup({ owned: false }); expect((await s.handler(request())).status).toBe(404); expect(s.agent).not.toHaveBeenCalled();
});
it("replays a successful request without another model call", async () => {
  const s = setup({ duplicate: true }); expect((await s.handler(request())).status).toBe(200); expect(s.agent).not.toHaveBeenCalled();
});
it.each([{ mode: "error" }, { mode: "insufficient" }, { unchanged: true }])("failures never write a round", async opts => {
  const s = setup(opts); expect((await s.handler(request())).status).toBe(422); expect(s.writes).toHaveLength(0);
});
it("rejects browser-provided question, draft and counter", async () => {
  const s = setup(); expect((await s.handler(request({ ...body, question: "伪造", round: 0 }))).status).toBe(400);
});
