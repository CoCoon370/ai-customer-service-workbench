import { beforeEach, describe, expect, it } from "vitest";
import { createAdminFeedbackDetailHandler, createAdminFeedbackListHandler, createAdminUserDeactivateHandler } from "@/app/api/admin/handlers";
import { hashSessionToken } from "@/lib/auth/session";
import type { Database, Queryable, QueryResult } from "@/lib/db/pool";

const token = "a".repeat(64);
const admin = { id: "00000000-0000-4000-8000-000000000001", username: "admin", role: "admin" as const, must_reset_password: false };
const agentId = "00000000-0000-4000-8000-000000000002";

class StrictDb implements Database {
  businessQueries = 0;
  txQueries: string[] = [];
  async query<T>(sql: string, values: readonly unknown[] = []): Promise<QueryResult<T>> {
    if (sql.includes("token_hash")) {
      expect(values[0]).toBe(hashSessionToken(token));
      return { rows: [admin as T], rowCount: 1 };
    }
    this.businessQueries += 1;
    return { rows: [] as T[], rowCount: 0 };
  }
  async transaction<T>(work: (client: Queryable) => Promise<T>): Promise<T> {
    return work({ query: async <R>(sql: string) => {
      this.txQueries.push(sql);
      if (sql.includes("SELECT id, role, status")) return { rows: [{ id: agentId, role: "agent", status: "active" } as R], rowCount: 1 };
      return { rows: [] as R[], rowCount: 1 };
    } });
  }
}

const request = (url: string, init: RequestInit = {}) => new Request(url, { ...init, headers: { cookie: `workbench_session=${token}`, ...(init.headers ?? {}) } });
const deps = (db: StrictDb) => ({ db, now: () => new Date("2026-08-12T02:00:00Z") });

describe("管理员 API 严格输入和停用串行化", () => {
  let db: StrictDb;
  beforeEach(() => { db = new StrictDb(); });

  it.each([
    "agentId=x%27%20OR%201=1", "from=2026-02-30", "from=2026-08-12T25:00:00Z",
    "from=2026-08-13&to=2026-08-12", "page=9007199254740991",
  ])("在业务查询前拒绝非法查询：%s", async (query) => {
    const response = await createAdminFeedbackListHandler(deps(db))(request(`http://x/api/admin/feedback?${query}`));
    expect(response.status).toBe(400);
    expect(db.businessQueries).toBe(0);
  });

  it("接受合法 UUID、严格日期和安全页码", async () => {
    const response = await createAdminFeedbackListHandler(deps(db))(request(`http://x/api/admin/feedback?agentId=${agentId}&from=2026-08-01&to=2026-08-12&page=2&limit=10`));
    expect(response.status).toBe(200);
    expect(db.businessQueries).toBe(1);
  });

  it("在业务查询前拒绝非法详情 UUID", async () => {
    const response = await createAdminFeedbackDetailHandler(deps(db))(request("http://x/api/admin/feedback/nope"), { id: "nope" });
    expect(response.status).toBe(400);
    expect(db.businessQueries).toBe(0);
  });

  it("在事务前拒绝非法账号 UUID", async () => {
    const response = await createAdminUserDeactivateHandler(deps(db))(request("http://x", { method: "PATCH", body: JSON.stringify({ action: "deactivate" }) }), { id: "nope" });
    expect(response.status).toBe(400);
    expect(db.txQueries).toHaveLength(0);
  });

  it("先取得事务级全局锁，再读取目标和更新", async () => {
    const response = await createAdminUserDeactivateHandler(deps(db))(request("http://x", { method: "PATCH", body: JSON.stringify({ action: "deactivate" }) }), { id: agentId });
    expect(response.status).toBe(200);
    expect(db.txQueries[0]).toContain("pg_advisory_xact_lock");
    expect(db.txQueries[1]).toContain("SELECT id, role, status");
  });
});
