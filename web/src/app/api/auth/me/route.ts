import { createMeHandler } from "./handler";
import { getDatabase } from "@/lib/db/pool";

export async function GET(request: Request): Promise<Response> {
  return createMeHandler({ db: getDatabase() })(request);
}
