import type { Database } from "@/lib/db/pool";
import { getSessionToken, hashSessionToken } from "@/lib/auth/session";

export type AuthenticatedUser = {
  id: string;
  username: string;
  role: "agent" | "admin";
  must_reset_password: boolean;
};

export async function authenticateRequest(
  request: Request,
  db: Database,
  now: Date,
): Promise<AuthenticatedUser | null> {
  const token = getSessionToken(request);
  if (!token) return null;
  const result = await db.query<AuthenticatedUser>(
    `SELECT u.id, u.username, u.role, u.must_reset_password
       FROM public.workbench_sessions s
       JOIN public.workbench_users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.expires_at > $2
        AND u.status = 'active'
      LIMIT 1`,
    [hashSessionToken(token), now],
  );
  return result.rows[0] ?? null;
}
