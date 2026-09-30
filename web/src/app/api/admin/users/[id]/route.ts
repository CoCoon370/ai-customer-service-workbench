import { createAdminUserDeactivateHandler } from "../../handlers";
import { getDatabase } from "@/lib/db/pool";
type C = { params: Promise<{ id: string }> };
export async function PATCH(r: Request, c: C) {
  return createAdminUserDeactivateHandler({ db: getDatabase() })(
    r,
    await c.params,
  );
}
