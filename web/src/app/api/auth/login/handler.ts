import { randomBytes } from "node:crypto";
import { z } from "zod";

import { verifyPassword } from "@/lib/auth/password";
import { createSessionToken, DEFAULT_SESSION_TTL_MS, hashSessionToken, sessionCookie, shouldUseSecureCookie } from "@/lib/auth/session";
import type { Database, Queryable } from "@/lib/db/pool";

type LoginUser = {
  id: string;
  username: string;
  password_hash: string;
  role: "agent" | "admin";
  status: "active" | "disabled";
  failed_attempts: number;
  locked_until: Date | null;
  must_reset_password: boolean;
};

type LoginDependencies = {
  db: Database;
  now?: () => Date;
  randomBytes?: () => Uint8Array;
  verify?: (password: string, hash: string) => Promise<boolean>;
  sessionTtlMs?: number;
};

const LoginPayload = z.strictObject({
  username: z.string().trim().min(1).max(100),
  password: z.string().min(1).max(200),
});

function json(status: number, body: unknown, headers?: HeadersInit): Response {
  return Response.json(body, { status, headers });
}

async function findUser(client: Queryable, username: string): Promise<LoginUser | null> {
  const result = await client.query<LoginUser>(
    `SELECT id, username, password_hash, role, status, failed_attempts, locked_until, must_reset_password
       FROM public.workbench_users
      WHERE username = $1
      FOR UPDATE`,
    [username],
  );
  return result.rows[0] ?? null;
}

export function createLoginHandler(dependencies: LoginDependencies) {
  const now = dependencies.now ?? (() => new Date());
  const verify = dependencies.verify ?? verifyPassword;
  const ttl = dependencies.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;

  return async function login(request: Request): Promise<Response> {
    let parsed: z.infer<typeof LoginPayload>;
    try {
      parsed = LoginPayload.parse(await request.json());
    } catch {
      return json(400, { error: "invalid_request" });
    }

    const timestamp = now();
    const outcome = await dependencies.db.transaction(async (client) => {
      const user = await findUser(client, parsed.username);
      if (!user) return { status: 401 as const };
      if (user.status !== "active") return { status: 403 as const };
      if (user.locked_until && user.locked_until > timestamp) return { status: 423 as const };

      if (!(await verify(parsed.password, user.password_hash))) {
        const attempts = (user.locked_until && user.locked_until <= timestamp ? 0 : user.failed_attempts) + 1;
        const lockedUntil = attempts >= 5 ? new Date(timestamp.getTime() + 15 * 60 * 1000) : null;
        await client.query(
          `UPDATE public.workbench_users
              SET failed_attempts = $2, locked_until = $3, updated_at = $4
            WHERE id = $1`,
          [user.id, attempts, lockedUntil, timestamp],
        );
        return { status: 401 as const };
      }

      const token = createSessionToken(dependencies.randomBytes?.() ?? randomBytes(32));
      const expiresAt = new Date(timestamp.getTime() + ttl);
      await client.query(
        `UPDATE public.workbench_users
            SET failed_attempts = 0, locked_until = NULL, updated_at = $2
          WHERE id = $1`,
        [user.id, timestamp],
      );
      await client.query(
        `INSERT INTO public.workbench_sessions (token_hash, user_id, expires_at, created_at)
         VALUES ($1, $2, $3, $4)`,
        [hashSessionToken(token), user.id, expiresAt, timestamp],
      );
      return { status: 200 as const, token, user };
    });

    if (outcome.status !== 200) return json(outcome.status, { error: outcome.status === 423 ? "account_locked" : "invalid_credentials" });
    const secure = shouldUseSecureCookie(process.env.NODE_ENV, new URL(request.url));
    return json(
      200,
      { user: { id: outcome.user.id, username: outcome.user.username, role: outcome.user.role, mustResetPassword: outcome.user.must_reset_password } },
      { "set-cookie": sessionCookie(outcome.token, secure, Math.floor(ttl / 1000)) },
    );
  };
}
