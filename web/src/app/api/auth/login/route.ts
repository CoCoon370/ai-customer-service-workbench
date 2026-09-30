import { createLoginHandler } from "./handler";
import { getDatabase } from "@/lib/db/pool";

export async function POST(request: Request): Promise<Response> {
  return createLoginHandler({ db: getDatabase() })(request);
}
