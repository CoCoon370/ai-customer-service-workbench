import type { Database } from "@/lib/db/pool";
import { expiredSessionCookie, getSessionToken, hashSessionToken, shouldUseSecureCookie } from "@/lib/auth/session";

export function createLogoutHandler({ db }: { db: Database }) {
  return async function logout(request: Request): Promise<Response> {
    const token = getSessionToken(request);
    if (token) {
      await db.query("DELETE FROM public.workbench_sessions WHERE token_hash = $1", [hashSessionToken(token)]);
    }
    const secure = shouldUseSecureCookie(process.env.NODE_ENV, new URL(request.url));
    return new Response(null, { status: 204, headers: { "set-cookie": expiredSessionCookie(secure) } });
  };
}
