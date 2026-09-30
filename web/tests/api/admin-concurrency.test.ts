import { describe, expect, it } from "vitest";
import { createAdminUserDeactivateHandler } from "@/app/api/admin/handlers";
import { hashSessionToken } from "@/lib/auth/session";
import type { Database, Queryable, QueryResult } from "@/lib/db/pool";

const first = { id: "00000000-0000-4000-8000-000000000001", username: "admin-a", role: "admin" as const, must_reset_password: false, status: "active" };
const second = { id: "00000000-0000-4000-8000-000000000002", username: "admin-b", role: "admin" as const, must_reset_password: false, status: "active" };
const tokenA = "a".repeat(64), tokenB = "b".repeat(64);

class SerializedAdminDb implements Database {
  users = [first, second].map((user) => ({ ...user }));
  private tail = Promise.resolve();

  async query<T>(sql: string, values: readonly unknown[] = []): Promise<QueryResult<T>> {
    if (!sql.includes("token_hash")) throw new Error(`unexpected query ${sql}`);
    const user = values[0] === hashSessionToken(tokenA) ? first : second;
    return { rows: [user as T], rowCount: 1 };
  }

  async transaction<T>(work: (client: Queryable) => Promise<T>): Promise<T> {
    let unlock: (() => void) | undefined;
    let locked = false;
    const client: Queryable = { query: async <R>(sql: string, values: readonly unknown[] = []) => {
      if (sql.includes("pg_advisory_xact_lock")) {
        const previous = this.tail;
        this.tail = new Promise<void>((resolve) => { unlock = resolve; });
        await previous;
        locked = true;
        return { rows: [] as R[], rowCount: 1 };
      }
      if (!locked) throw new Error("business query ran before advisory lock");
      if (sql.includes("SELECT id, role, status")) {
        const user = this.users.find((candidate) => candidate.id === values[0]);
        return { rows: user ? [user as R] : [], rowCount: user ? 1 : 0 };
      }
      if (sql.includes("COUNT(*)")) {
        const count = this.users.filter((user) => user.role === "admin" && user.status === "active").length;
        return { rows: [{ count: String(count) } as R], rowCount: 1 };
      }
      if (sql.includes("UPDATE public.workbench_users")) {
        this.users.find((user) => user.id === values[0])!.status = "disabled";
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { rows: [] as R[], rowCount: 1 };
      }
      if (sql.includes("DELETE FROM public.workbench_sessions")) return { rows: [] as R[], rowCount: 1 };
      throw new Error(`unexpected transaction query ${sql}`);
    } };
    try { return await work(client); } finally { unlock?.(); }
  }
}

const request = (token: string) => new Request("http://x/api/admin/users/id", {
  method: "PATCH", headers: { cookie: `workbench_session=${token}` }, body: JSON.stringify({ action: "deactivate" }),
});

describe("最后一个管理员并发保护", () => {
  it("两个管理员同时互相停用时只允许一个成功", async () => {
    const db = new SerializedAdminDb();
    const handler = createAdminUserDeactivateHandler({ db, now: () => new Date("2026-08-12T02:00:00Z") });
    const responses = await Promise.all([
      handler(request(tokenA), { id: second.id }),
      handler(request(tokenB), { id: first.id }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
    expect(db.users.filter((user) => user.status === "active")).toHaveLength(1);
    const failed = responses.find((response) => response.status === 400)!;
    expect(await failed.json()).toEqual({ error: "last_admin" });
  });
});
