import { beforeEach, describe, expect, it } from "vitest";

import { createLoginHandler } from "@/app/api/auth/login/handler";
import { createLogoutHandler } from "@/app/api/auth/logout/handler";
import { createMeHandler } from "@/app/api/auth/me/handler";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { hashSessionToken, shouldUseSecureCookie } from "@/lib/auth/session";
import type { Database, QueryResult, Queryable } from "@/lib/db/pool";

type UserRow = {
  id: string;
  username: string;
  password_hash: string;
  role: "agent" | "admin";
  status: "active" | "disabled";
  failed_attempts: number;
  locked_until: Date | null;
  must_reset_password: boolean;
};

class AuthDatabase implements Database {
  user: UserRow = {
    id: "00000000-0000-0000-0000-000000000001",
    username: "agent-01",
    password_hash: "stored-hash",
    role: "agent",
    status: "active",
    failed_attempts: 0,
    locked_until: null,
    must_reset_password: false,
  };
  sessions = new Map<string, { userId: string; expiresAt: Date }>();

  async query<T>(sql: string, values: readonly unknown[] = []): Promise<QueryResult<T>> {
    if (sql.includes("FROM public.workbench_users") && sql.includes("FOR UPDATE")) {
      return { rows: this.user.username === values[0] ? [this.user as T] : [], rowCount: this.user.username === values[0] ? 1 : 0 };
    }
    if (sql.includes("SET failed_attempts = $2")) {
      this.user.failed_attempts = values[1] as number;
      this.user.locked_until = (values[2] as Date | null) ?? null;
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SET failed_attempts = 0")) {
      this.user.failed_attempts = 0;
      this.user.locked_until = null;
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO public.workbench_sessions")) {
      this.sessions.set(values[0] as string, { userId: values[1] as string, expiresAt: values[2] as Date });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("JOIN public.workbench_users")) {
      const session = this.sessions.get(values[0] as string);
      const now = values[1] as Date;
      if (!session || session.expiresAt <= now || this.user.status !== "active") return { rows: [], rowCount: 0 };
      return { rows: [{ id: this.user.id, username: this.user.username, role: this.user.role, must_reset_password: this.user.must_reset_password } as T], rowCount: 1 };
    }
    if (sql.includes("DELETE FROM public.workbench_sessions")) {
      this.sessions.delete(values[0] as string);
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected query: ${sql}`);
  }

  async transaction<T>(work: (client: Queryable) => Promise<T>): Promise<T> {
    return work(this);
  }
}

const now = new Date("2026-08-11T00:00:00.000Z");
const tokenBytes = new Uint8Array(Array.from({ length: 32 }, (_, index) => index));

function loginRequest(password: string, url = "http://workbench.invalid/api/auth/login") {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "agent-01", password }),
  });
}

describe("workbench authentication", () => {
  let db: AuthDatabase;

  beforeEach(() => {
    db = new AuthDatabase();
  });

  it("uses bcrypt-compatible password hashing", async () => {
    const hash = await hashPassword("temporary-password");
    expect(hash).not.toContain("temporary-password");
    await expect(verifyPassword("temporary-password", hash)).resolves.toBe(true);
    await expect(verifyPassword("wrong-password", hash)).resolves.toBe(false);
  });

  it("stores only a SHA-256 hash of a 32-byte opaque session token and sets safe HTTP cookie flags", async () => {
    const handler = createLoginHandler({
      db,
      now: () => now,
      randomBytes: () => tokenBytes,
      verify: async (password) => password === "correct-password",
    });

    const response = await handler(loginRequest("correct-password"));
    const cookie = response.headers.get("set-cookie") ?? "";
    const rawToken = /workbench_session=([^;]+)/.exec(cookie)?.[1] ?? "";

    expect(response.status).toBe(200);
    expect(rawToken).toHaveLength(64);
    expect(db.sessions.has(hashSessionToken(rawToken))).toBe(true);
    expect(db.sessions.has(rawToken)).toBe(false);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).not.toContain("Secure");
  });

  it("enables Secure only for production HTTPS", () => {
    expect(shouldUseSecureCookie("production", new URL("https://workbench.invalid"))).toBe(true);
    expect(shouldUseSecureCookie("production", new URL("http://workbench.invalid"))).toBe(false);
    expect(shouldUseSecureCookie("development", new URL("https://workbench.invalid"))).toBe(false);
  });

  it("locks an account for fifteen minutes after five failed attempts", async () => {
    const handler = createLoginHandler({ db, now: () => now, verify: async () => false });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await handler(loginRequest("wrong-password"));
    }

    expect(db.user.failed_attempts).toBe(5);
    expect(db.user.locked_until?.toISOString()).toBe("2026-08-11T00:15:00.000Z");
    const locked = await createLoginHandler({ db, now: () => now, verify: async () => true })(loginRequest("correct-password"));
    expect(locked.status).toBe(423);
  });

  it("rejects disabled users and disabled or expired sessions", async () => {
    db.user.status = "disabled";
    const login = await createLoginHandler({ db, now: () => now, verify: async () => true })(loginRequest("correct-password"));
    expect(login.status).toBe(403);

    const token = "a".repeat(64);
    db.sessions.set(hashSessionToken(token), { userId: db.user.id, expiresAt: new Date(now.getTime() + 60_000) });
    const me = createMeHandler({ db, now: () => now });
    expect((await me(new Request("http://workbench.invalid/api/auth/me", { headers: { cookie: `workbench_session=${token}` } }))).status).toBe(401);

    db.user.status = "active";
    db.sessions.set(hashSessionToken(token), { userId: db.user.id, expiresAt: new Date(now.getTime() - 1) });
    expect((await me(new Request("http://workbench.invalid/api/auth/me", { headers: { cookie: `workbench_session=${token}` } }))).status).toBe(401);
  });

  it("deletes only the hashed session and expires the cookie on logout", async () => {
    const token = "b".repeat(64);
    db.sessions.set(hashSessionToken(token), { userId: db.user.id, expiresAt: new Date(now.getTime() + 60_000) });
    const response = await createLogoutHandler({ db })(new Request("http://workbench.invalid/api/auth/logout", { method: "POST", headers: { cookie: `workbench_session=${token}` } }));

    expect(response.status).toBe(204);
    expect(db.sessions.size).toBe(0);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});
