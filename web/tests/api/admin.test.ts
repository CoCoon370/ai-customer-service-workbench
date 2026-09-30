import { beforeEach, describe, expect, it } from "vitest";
import { compare } from "bcryptjs";

import {
  createAdminExportHandler,
  createAdminFeedbackDetailHandler,
  createAdminFeedbackListHandler,
  createAdminReviewHandler,
  createAdminUserDeactivateHandler,
  createAdminUsersHandler,
} from "@/app/api/admin/handlers";
import { hashSessionToken } from "@/lib/auth/session";
import type { Database, QueryResult, Queryable } from "@/lib/db/pool";

const token = "a".repeat(64);
const admin = {
  id: "00000000-0000-4000-8000-000000000001",
  username: "admin",
  role: "admin" as const,
  must_reset_password: false,
};
const agent = {
  ...admin,
  id: "00000000-0000-4000-8000-000000000002",
  username: "agent",
  role: "agent" as const,
};
const feedbackId = "10000000-0000-4000-8000-000000000001";
const now = new Date("2026-08-12T02:00:00.000Z");

class AdminDb implements Database {
  identity: typeof admin | typeof agent | null = admin;
  reviewStatus = "pending";
  reviewNote: string | null = null;
  reviewedBy: string | null = null;
  reviewItemStatus = "pending";
  users: Array<{
    id: string;
    username: string;
    role: "admin" | "agent";
    must_reset_password: boolean;
    display_name: string;
    status: string;
    created_at: Date;
  }> = [
    { ...admin, display_name: "管理员", status: "active", created_at: now },
  ];
  sessions = [
    { userId: admin.id, expiresAt: new Date("2026-08-13T00:00:00Z") },
  ];
  historyCount = 1;
  failSecondWrite = false;
  queryLog: Array<{ sql: string; values: readonly unknown[] }> = [];

  async query<T>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<T>> {
    this.queryLog.push({ sql, values });
    if (
      sql.includes("JOIN public.workbench_users") &&
      sql.includes("token_hash")
    ) {
      expect(values[0]).toBe(hashSessionToken(token));
      return this.identity
        ? { rows: [this.identity as T], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (sql.includes("COUNT(*)"))
      return { rows: [{ count: "1" } as T], rowCount: 1 };
    if (
      sql.includes("FROM public.feedback_records f") &&
      sql.includes("JOIN public.draft_runs")
    ) {
      const row = {
        id: feedbackId,
        agent_id: agent.id,
        agent_username: agent.username,
        question: " =SUM(A1:A2)",
        ai_draft: "原稿,含逗号",
        final_draft: "最终\n稿",
        action: "modified",
        discard_reason: null,
        discard_note: '说明"引号',
        review_status: this.reviewStatus,
        reviewed_by: this.reviewedBy,
        reviewed_at: this.reviewedBy ? now : null,
        review_note: this.reviewNote,
        created_at: now,
        faq_snapshot: { card: 1 },
        product_snapshot: { product: 2 },
        model_version: "qwen-plus",
        prompt_version: "p1",
        system_version: "s1",
        knowledge_version: "k1",
      };
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("FROM public.workbench_users") && !sql.includes("COUNT")) {
      return { rows: this.users as T[], rowCount: this.users.length };
    }
    throw new Error(`unexpected query: ${sql}`);
  }

  async transaction<T>(work: (client: Queryable) => Promise<T>): Promise<T> {
    const before = {
      reviewStatus: this.reviewStatus,
      reviewNote: this.reviewNote,
      reviewedBy: this.reviewedBy,
      reviewItemStatus: this.reviewItemStatus,
      users: structuredClone(this.users),
      sessions: structuredClone(this.sessions),
    };
    let writes = 0;
    const client: Queryable = {
      query: async <R>(sql: string, values: readonly unknown[] = []) => {
        writes += 1;
        if (this.failSecondWrite && writes === 2)
          throw new Error("injected failure SECRET");
        if (sql.includes("pg_advisory_xact_lock"))
          return { rows: [], rowCount: 1 };
        if (sql.includes("SELECT review_status") && sql.includes("FOR UPDATE"))
          return {
            rows: [
              {
                review_status: this.reviewStatus,
                review_note: this.reviewNote,
              } as R,
            ],
            rowCount: 1,
          };
        if (sql.includes("UPDATE public.feedback_records")) {
          this.reviewStatus = values[0] as string;
          this.reviewedBy = values[1] as string;
          this.reviewNote = values[3] as string | null;
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("INSERT INTO public.review_items"))
          return { rows: [], rowCount: 1 };
        if (sql.includes("UPDATE public.review_items")) {
          this.reviewItemStatus = values[0] as string;
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("DELETE FROM public.review_items"))
          throw Object.assign(new Error("permission denied for table review_items"), {
            code: "42501",
          });
        if (sql.includes("INSERT INTO public.workbench_users")) {
          if (this.users.some((u) => u.username === values[1]))
            throw Object.assign(new Error("duplicate"), { code: "23505" });
          this.users.push({
            id: values[0],
            username: values[1],
            display_name: values[2],
            password_hash: values[3],
            role: values[4],
            status: "active",
            created_at: values[5],
          } as never);
          return { rows: [], rowCount: 1 };
        }
        if (
          sql.includes("SELECT id, role, status") &&
          sql.includes("FOR UPDATE")
        ) {
          const u = this.users.find((x) => x.id === values[0]);
          return u
            ? { rows: [u as R], rowCount: 1 }
            : { rows: [], rowCount: 0 };
        }
        if (sql.includes("COUNT(*)") && sql.includes("role = 'admin'"))
          return { rows: [{ count: "1" } as R], rowCount: 1 };
        if (sql.includes("UPDATE public.workbench_users")) {
          const u = this.users.find((x) => x.id === values[0])!;
          u.status = "disabled";
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("DELETE FROM public.workbench_sessions")) {
          this.sessions = this.sessions.filter((s) => s.userId !== values[0]);
          return { rows: [], rowCount: 1 };
        }
        throw new Error(`unexpected tx: ${sql}`);
      },
    };
    try {
      return await work(client);
    } catch (error) {
      Object.assign(this, before);
      throw error;
    }
  }
}

const req = (url: string, init: RequestInit = {}, withToken = true) =>
  new Request(url, {
    ...init,
    headers: {
      ...(withToken ? { cookie: `workbench_session=${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
const deps = (db: AdminDb) => ({
  db,
  now: () => now,
  randomUUID: () => "20000000-0000-4000-8000-000000000001",
  randomBytes: () => Buffer.alloc(24, 7),
});

describe("admin API authorization and feedback", () => {
  let db: AdminDb;
  beforeEach(() => {
    db = new AdminDb();
  });

  it.each(["list", "detail", "review", "users", "deactivate", "export"])(
    "denies anonymous and agent access to %s",
    async (name) => {
      const calls = {
        list: () =>
          createAdminFeedbackListHandler(deps(db))(
            req("http://x/api/admin/feedback", {}, false),
          ),
        detail: () =>
          createAdminFeedbackDetailHandler(deps(db))(
            req("http://x/api/admin/feedback/x", {}, false),
            { id: feedbackId },
          ),
        review: () =>
          createAdminReviewHandler(deps(db))(
            req(
              "http://x/api/admin/feedback/x",
              {
                method: "PATCH",
                body: JSON.stringify({ action: "no_action" }),
              },
              false,
            ),
            { id: feedbackId },
          ),
        users: () =>
          createAdminUsersHandler(deps(db))(
            req("http://x/api/admin/users", {}, false),
          ),
        deactivate: () =>
          createAdminUserDeactivateHandler(deps(db))(
            req(
              "http://x/api/admin/users/x",
              {
                method: "PATCH",
                body: JSON.stringify({ action: "deactivate" }),
              },
              false,
            ),
            { id: agent.id },
          ),
        export: () =>
          createAdminExportHandler(deps(db))(
            req("http://x/api/admin/export", {}, false),
          ),
      };
      expect((await calls[name as keyof typeof calls]()).status).toBe(403);
      db.identity = agent;
      expect((await calls[name as keyof typeof calls]()).status).toBe(403);
    },
  );

  it("validates exact filters, dates and pagination without interpolating values", async () => {
    const list = createAdminFeedbackListHandler(deps(db));
    expect(
      (await list(req("http://x/api/admin/feedback?sort=drop%20table"))).status,
    ).toBe(400);
    expect(
      (await list(req("http://x/api/admin/feedback?from=nope"))).status,
    ).toBe(400);
    expect(
      (await list(req("http://x/api/admin/feedback?limit=101"))).status,
    ).toBe(400);
    expect(
      (
        await list(
          req(
            "http://x/api/admin/feedback?action=adopted&agentId=x%27%20OR%201=1&limit=10&page=2",
          ),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await list(
          req(
            `http://x/api/admin/feedback?action=adopted&agentId=${agent.id}&limit=10&page=2`,
          ),
        )
      ).status,
    ).toBe(200);
    expect(db.queryLog.at(-1)?.sql).not.toContain(agent.id);
    expect(db.queryLog.at(-1)?.values).toContain(agent.id);
  });

  it("returns snapshots, all version fields and uses session admin identity", async () => {
    const response = await createAdminFeedbackDetailHandler(deps(db))(
      req("http://x/api/admin/feedback/x"),
      { id: feedbackId },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      question: " =SUM(A1:A2)",
      faqSnapshot: { card: 1 },
      productSnapshot: { product: 2 },
      versions: {
        model: "qwen-plus",
        prompt: "p1",
        system: "s1",
        knowledge: "k1",
      },
    });
  });

  it("supports both review actions, rejects publish, and is idempotent but conflicts on a changed decision", async () => {
    const patch = createAdminReviewHandler(deps(db));
    expect(
      (
        await patch(
          req("http://x", {
            method: "PATCH",
            body: JSON.stringify({ action: "publish" }),
          }),
          { id: feedbackId },
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await patch(
          req("http://x", {
            method: "PATCH",
            body: JSON.stringify({ action: "queue_for_review", note: "核查" }),
          }),
          { id: feedbackId },
        )
      ).status,
    ).toBe(200);
    expect(db.reviewedBy).toBe(admin.id);
    expect(db.reviewItemStatus).toBe("pending");
    expect(
      (
        await patch(
          req("http://x", {
            method: "PATCH",
            body: JSON.stringify({ action: "queue_for_review", note: "核查" }),
          }),
          { id: feedbackId },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await patch(
          req("http://x", {
            method: "PATCH",
            body: JSON.stringify({ action: "no_action" }),
          }),
          { id: feedbackId },
        )
      ).status,
    ).toBe(409);
    db = new AdminDb();
    expect(
      (
        await createAdminReviewHandler(deps(db))(
          req("http://x", {
            method: "PATCH",
            body: JSON.stringify({ action: "no_action", note: "无需处理" }),
          }),
          { id: feedbackId },
        )
      ).status,
    ).toBe(200);
    expect(db.reviewStatus).toBe("no_action");
    expect(db.reviewItemStatus).toBe("no_action");
    expect(
      db.queryLog.every(
        ({ sql }) =>
          !/(business_faq_cards|workbench_product_chunks|knowledge_releases)/.test(
            sql,
          ),
      ),
    ).toBe(true);
  });

  it("rolls back review writes and never leaks database errors", async () => {
    db.failSecondWrite = true;
    const response = await createAdminReviewHandler(deps(db))(
      req("http://x", {
        method: "PATCH",
        body: JSON.stringify({ action: "queue_for_review" }),
      }),
      { id: feedbackId },
    );
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("SECRET");
    expect(db.reviewStatus).toBe("pending");
  });
});

describe("admin accounts and CSV", () => {
  let db: AdminDb;
  beforeEach(() => {
    db = new AdminDb();
  });

  it("creates an account with a one-time password and stores only bcrypt", async () => {
    const users = createAdminUsersHandler(deps(db));
    const response = await users(
      req("http://x", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: "agent_02",
          displayName: "客服二号",
          role: "agent",
        }),
      }),
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.temporaryPassword).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const stored = db.users.at(-1) as (typeof db.users)[number] & {
      password_hash: string;
    };
    expect(stored.password_hash).toMatch(/^\$2[aby]\$/);
    expect(await compare(body.temporaryPassword, stored.password_hash)).toBe(
      true,
    );
    const listed = await users(req("http://x"));
    expect(await listed.text()).not.toContain(body.temporaryPassword);
  });

  it("rejects duplicate usernames, unknown roles and browser-supplied elevated fields", async () => {
    const users = createAdminUsersHandler(deps(db));
    const post = (body: unknown) =>
      users(req("http://x", { method: "POST", body: JSON.stringify(body) }));
    expect(
      (await post({ username: "admin", displayName: "重复", role: "agent" }))
        .status,
    ).toBe(409);
    expect(
      (await post({ username: "new", displayName: "新", role: "owner" }))
        .status,
    ).toBe(400);
    expect(
      (
        await post({
          username: "new",
          displayName: "新",
          role: "agent",
          mustResetPassword: false,
        })
      ).status,
    ).toBe(400);
  });

  it("rejects current-admin deactivation and atomically deactivates another user without deleting history", async () => {
    db.users.push({
      ...agent,
      display_name: "客服",
      status: "active",
      created_at: now,
    });
    const deactivate = createAdminUserDeactivateHandler(deps(db));
    expect(
      (
        await deactivate(
          req("http://x", {
            method: "PATCH",
            body: JSON.stringify({ action: "deactivate" }),
          }),
          { id: admin.id },
        )
      ).status,
    ).toBe(400);
    const beforeHistory = db.historyCount;
    expect(
      (
        await deactivate(
          req("http://x", {
            method: "PATCH",
            body: JSON.stringify({ action: "deactivate" }),
          }),
          { id: agent.id },
        )
      ).status,
    ).toBe(200);
    expect(db.users.find((u) => u.id === agent.id)?.status).toBe("disabled");
    expect(db.sessions.some((s) => s.userId === agent.id)).toBe(false);
    expect(db.historyCount).toBe(beforeHistory);
  });

  it("rolls back deactivation when session deletion fails", async () => {
    db.users.push({
      ...agent,
      display_name: "客服",
      status: "active",
      created_at: now,
    });
    db.failSecondWrite = true;
    const response = await createAdminUserDeactivateHandler(deps(db))(
      req("http://x", {
        method: "PATCH",
        body: JSON.stringify({ action: "deactivate" }),
      }),
      { id: agent.id },
    );
    expect(response.status).toBe(500);
    expect(db.users.find((u) => u.id === agent.id)?.status).toBe("active");
  });

  it.each(["=1+1", "+cmd", "-2+3", "@SUM(A1)", "  =SUM(A1)"])(
    "defends formula prefix %s",
    async (danger) => {
      const original = await db.query.bind(db);
      db.query = async <T>(sql: string, values: readonly unknown[] = []) => {
        const result = await original<T>(sql, values);
        if (sql.includes("FROM public.feedback_records f") && result.rows[0])
          (result.rows[0] as unknown as { question: string }).question = danger;
        return result;
      };
      const response = await createAdminExportHandler(deps(db))(
        req("http://x/api/admin/export"),
      );
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      const text = new TextDecoder().decode(bytes);
      expect(text).toContain(danger.replace(/^(\s*)(?=[=+\-@])/, "$1'"));
    },
  );

  it("exports fixed quoted Unicode CSV columns with a 10000 row cap", async () => {
    const response = await createAdminExportHandler(deps(db))(
      req("http://x/api/admin/export?action=modified"),
    );
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("content-disposition")).toMatch(
      /^attachment; filename="feedback-/,
    );
    const text = await response.text();
    expect(text).toContain(
      "创建时间,客服,问题,AI原稿,最终稿,操作,弃用原因,说明,审核状态,版本",
    );
    expect(text).toContain('"原稿,含逗号"');
    expect(text).toContain('"最终\n稿"');
    expect(text).toContain('"说明""引号"');
    expect(db.queryLog.at(-1)?.values).toContain(10000);
  });
});
