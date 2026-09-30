import { createAdminExportHandler } from "../handlers";
import { getDatabase } from "@/lib/db/pool";
export async function GET(r: Request) {
  return createAdminExportHandler({ db: getDatabase() })(r);
}
