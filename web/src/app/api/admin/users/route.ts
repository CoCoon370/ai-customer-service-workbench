import { createAdminUsersHandler } from "../handlers";
import { getDatabase } from "@/lib/db/pool";
export async function GET(r: Request) {
  return createAdminUsersHandler({ db: getDatabase() })(r);
}
export async function POST(r: Request) {
  return createAdminUsersHandler({ db: getDatabase() })(r);
}
