import { createAdminFeedbackListHandler } from "../handlers";
import { getDatabase } from "@/lib/db/pool";
export async function GET(r: Request) {
  return createAdminFeedbackListHandler({ db: getDatabase() })(r);
}
