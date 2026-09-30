import { createDraftHandler } from "./handler";
import { getAgentClient } from "@/lib/agent-client";
import { getDatabase } from "@/lib/db/pool";

export async function POST(request: Request): Promise<Response> {
  return createDraftHandler({ db: getDatabase(), callAgent: getAgentClient() })(request);
}
