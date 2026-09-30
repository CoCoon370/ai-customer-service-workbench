import { createAdjustmentHandler } from "./handler";
import { getAdjustmentClient } from "@/lib/agent-client";
import { getDatabase } from "@/lib/db/pool";

export async function POST(request: Request): Promise<Response> {
  return createAdjustmentHandler({ db: getDatabase(), callAgent: getAdjustmentClient() })(request);
}
