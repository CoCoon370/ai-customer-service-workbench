import { createFeedbackHandler } from "./handler";
import { getDatabase } from "@/lib/db/pool";

export async function POST(request: Request): Promise<Response> {
  return createFeedbackHandler({ db: getDatabase() })(request);
}
