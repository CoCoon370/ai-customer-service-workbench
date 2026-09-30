import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getDatabase } from "@/lib/db/pool";
import { authenticateRequest } from "@/lib/auth/authorize";
import { FeedbackTable } from "./feedback-table";
import { UserManagement } from "./user-management";
export default async function AdminPage() {
  const h = await headers(),
    r = new Request("http://internal/admin", {
      headers: { cookie: h.get("cookie") ?? "" },
    }),
    u = await authenticateRequest(r, getDatabase(), new Date());
  if (!u || u.role !== "admin") redirect("/login");
  return (
    <main>
      <h1>管理员后台</h1>
      <FeedbackTable />
      <UserManagement />
    </main>
  );
}

