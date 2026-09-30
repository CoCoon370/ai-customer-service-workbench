import {
  createAdminFeedbackDetailHandler,
  createAdminReviewHandler,
} from "../../handlers";
import { getDatabase } from "@/lib/db/pool";
type C = { params: Promise<{ id: string }> };
export async function GET(r: Request, c: C) {
  return createAdminFeedbackDetailHandler({ db: getDatabase() })(
    r,
    await c.params,
  );
}
export async function PATCH(r: Request, c: C) {
  return createAdminReviewHandler({ db: getDatabase() })(r, await c.params);
}
