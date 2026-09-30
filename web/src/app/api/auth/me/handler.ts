import { authenticateRequest } from "@/lib/auth/authorize";
import type { Database } from "@/lib/db/pool";

export function createMeHandler({ db, now = () => new Date() }: { db: Database; now?: () => Date }) {
  return async function me(request: Request): Promise<Response> {
    const user = await authenticateRequest(request, db, now());
    if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
    return Response.json({
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        mustResetPassword: user.must_reset_password,
      },
    });
  };
}
