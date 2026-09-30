import { randomBytes, randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import { z } from "zod";
import { authenticateRequest } from "@/lib/auth/authorize";
import type { Database, Queryable } from "@/lib/db/pool";

type Deps = { db: Database; now?: () => Date; randomUUID?: () => string; randomBytes?: () => Buffer };
const UUID = z.string().uuid();
const MAX_PAGE = 1_000_000;
const ADMIN_DEACTIVATION_LOCK = 7642107;
const filters = new Set(["agentId", "action", "discardReason", "reviewStatus", "from", "to", "page", "limit"]);
const actions = new Set(["adopted", "modified", "discarded"]);
const reasons = new Set(["knowledge_incorrect", "question_unresolved", "wrong_product", "irrelevant_answer", "tone_or_style", "dynamic_data_required", "other"]);
const statuses = new Set(["pending", "queued", "no_action"]);

async function admin(request: Request, deps: Deps) {
  const user = await authenticateRequest(request, deps.db, (deps.now ?? (() => new Date()))());
  return user?.role === "admin" ? user : null;
}

function strictDate(value: string) {
  const dateOnly = z.iso.date().safeParse(value).success;
  const dateTime = z.iso.datetime({ offset: true }).safeParse(value).success;
  if (!dateOnly && !dateTime) throw new Error("invalid_date");
  return new Date(dateOnly ? `${value}T00:00:00.000Z` : value);
}

function parsed(url: string, cap = 100) {
  const params = new URL(url).searchParams;
  for (const key of params.keys()) if (!filters.has(key)) throw new Error("unknown_filter");
  const limit = Number(params.get("limit") ?? cap);
  const page = Number(params.get("page") ?? 1);
  if (!Number.isInteger(limit) || limit < 1 || limit > cap || !Number.isSafeInteger(page) || page < 1 || page > MAX_PAGE) throw new Error("invalid_pagination");
  const agentId = params.get("agentId");
  if (agentId && !UUID.safeParse(agentId).success) throw new Error("invalid_agent");
  for (const [key, allowed] of [["action", actions], ["discardReason", reasons], ["reviewStatus", statuses]] as const) {
    const value = params.get(key);
    if (value && !allowed.has(value)) throw new Error("invalid_enum");
  }
  const from = params.get("from") ? strictDate(params.get("from")!) : null;
  const to = params.get("to") ? strictDate(params.get("to")!) : null;
  if (from && to && from.getTime() > to.getTime()) throw new Error("invalid_range");
  return { params, limit, page, from, to };
}

function where(query: ReturnType<typeof parsed>) {
  const clauses: string[] = [];
  const values: unknown[] = [];
  for (const [key, column] of [["agentId", "f.user_id"], ["action", "f.action"], ["discardReason", "f.discard_reason"], ["reviewStatus", "f.review_status"]]) {
    const value = query.params.get(key);
    if (value) { values.push(value); clauses.push(`${column} = $${values.length}`); }
  }
  for (const [value, operator] of [[query.from, ">="], [query.to, "<="]] as const) {
    if (value) { values.push(value); clauses.push(`f.created_at ${operator} $${values.length}`); }
  }
  return { sql: clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "", values };
}

const base = `SELECT f.id,f.user_id agent_id,u.username agent_username,d.question,d.ai_draft,f.final_draft,f.action,f.discard_reason,f.discard_note,f.review_status,f.reviewed_by,f.reviewed_at,f.review_note,f.created_at,d.faq_snapshot,d.product_snapshot,d.model_version,d.prompt_version,d.system_version,d.knowledge_version,
  COALESCE(a.round,0) adjustment_round, a.instruction adjustment_instruction,
  (SELECT jsonb_agg(jsonb_build_object('round',x.round,'instruction',x.instruction,'previousDraft',p.ai_draft,'draft',n.ai_draft) ORDER BY x.round)
   FROM public.draft_adjustments x JOIN public.draft_runs p ON p.id=x.parent_draft_id JOIN public.draft_runs n ON n.id=x.draft_run_id
   WHERE x.root_draft_id=COALESCE(a.root_draft_id,d.id)) adjustment_history
 FROM public.feedback_records f JOIN public.draft_runs d ON d.id=f.draft_run_id JOIN public.workbench_users u ON u.id=f.user_id
 LEFT JOIN public.draft_adjustments a ON a.draft_run_id=d.id`;
const out = (row: any) => ({
  id: row.id, agentId: row.agent_id, agentUsername: row.agent_username, question: row.question,
  aiOriginal: row.ai_draft, finalDraft: row.final_draft, action: row.action, discardReason: row.discard_reason,
  note: row.discard_note, reviewStatus: row.review_status, reviewedBy: row.reviewed_by,
  reviewedAt: row.reviewed_at?.toISOString?.() ?? null, reviewNote: row.review_note,
  createdAt: row.created_at.toISOString(), faqSnapshot: row.faq_snapshot, productSnapshot: row.product_snapshot,
  versions: { model: row.model_version, prompt: row.prompt_version, system: row.system_version, knowledge: row.knowledge_version },
  adjustmentCount: row.adjustment_round ?? 0, adjustmentInstruction: row.adjustment_instruction ?? null,
  adjustmentHistory: row.adjustment_history ?? [],
});

function invalid() { return Response.json({ error: "invalid_request" }, { status: 400 }); }

export function createAdminFeedbackListHandler(deps: Deps) {
  return async (request: Request) => {
    if (!(await admin(request, deps))) return Response.json({ error: "forbidden" }, { status: 403 });
    let query; try { query = parsed(request.url); } catch { return invalid(); }
    const condition = where(query);
    const values = [...condition.values, query.limit, (query.page - 1) * query.limit];
    const result = await deps.db.query<any>(`${base}${condition.sql} ORDER BY f.created_at DESC,f.id DESC LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
    return Response.json({ items: result.rows.map(out), page: query.page, limit: query.limit });
  };
}

export function createAdminFeedbackDetailHandler(deps: Deps) {
  return async (request: Request, context: { id: string }) => {
    if (!(await admin(request, deps))) return Response.json({ error: "forbidden" }, { status: 403 });
    if (!UUID.safeParse(context.id).success) return invalid();
    const result = await deps.db.query<any>(`${base} WHERE f.id=$1 LIMIT 1`, [context.id]);
    return result.rows[0] ? Response.json(out(result.rows[0])) : Response.json({ error: "not_found" }, { status: 404 });
  };
}

const Review = z.strictObject({ action: z.enum(["queue_for_review", "no_action"]), note: z.string().trim().max(2000).optional() });
export function createAdminReviewHandler(deps: Deps) {
  return async (request: Request, context: { id: string }) => {
    const user = await admin(request, deps);
    if (!user) return Response.json({ error: "forbidden" }, { status: 403 });
    if (!UUID.safeParse(context.id).success) return invalid();
    let body; try { body = Review.parse(await request.json()); } catch { return invalid(); }
    try {
      const result = await deps.db.transaction(async (tx) => {
        const current = await tx.query<any>("SELECT review_status,review_note FROM public.feedback_records WHERE id=$1 FOR UPDATE", [context.id]);
        if (!current.rows[0]) return "missing";
        const status = body.action === "queue_for_review" ? "queued" : "no_action";
        const note = body.note ?? null;
        if (current.rows[0].review_status !== "pending") return current.rows[0].review_status === status && current.rows[0].review_note === note ? "same" : "conflict";
        const time = (deps.now ?? (() => new Date()))();
        await tx.query("UPDATE public.feedback_records SET review_status=$1,reviewed_by=$2,reviewed_at=$3,review_note=$4,updated_at=$3 WHERE id=$5", [status, user.id, time, note, context.id]);
        if (status === "queued") await tx.query("INSERT INTO public.review_items(id,feedback_id,category,status,created_at,updated_at) VALUES($1,$2,'other','pending',$3,$3) ON CONFLICT(feedback_id) DO NOTHING", [(deps.randomUUID ?? randomUUID)(), context.id, time]);
        else await tx.query(
          "UPDATE public.review_items SET status=$1,updated_at=$2 WHERE feedback_id=$3",
          ["no_action", time, context.id],
        );
        return "ok";
      });
      if (result === "missing") return Response.json({ error: "not_found" }, { status: 404 });
      if (result === "conflict") return Response.json({ error: "review_conflict" }, { status: 409 });
      return Response.json({ ok: true, idempotent: result === "same" });
    } catch { return Response.json({ error: "review_failed" }, { status: 500 }); }
  };
}

const User = z.strictObject({ username: z.string().regex(/^[a-zA-Z0-9_-]{3,32}$/), displayName: z.string().trim().min(1).max(80), role: z.enum(["agent", "admin"]) });
export function createAdminUsersHandler(deps: Deps) {
  return async (request: Request) => {
    if (!(await admin(request, deps))) return Response.json({ error: "forbidden" }, { status: 403 });
    if (request.method === "GET") {
      const result = await deps.db.query<any>("SELECT id,username,display_name,role,status,must_reset_password,created_at FROM public.workbench_users ORDER BY created_at DESC,id DESC LIMIT 100");
      return Response.json({ items: result.rows.map(({ password_hash, ...value }: any) => value) });
    }
    let body; try { body = User.parse(await request.json()); } catch { return invalid(); }
    const password = (deps.randomBytes ?? randomBytes)(24).toString("base64url");
    const id = (deps.randomUUID ?? randomUUID)();
    const time = (deps.now ?? (() => new Date()))();
    try {
      await deps.db.transaction(async (tx: Queryable) => tx.query("INSERT INTO public.workbench_users(id,username,display_name,password_hash,role,status,must_reset_password,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'active',true,$6,$6)", [id, body.username, body.displayName, await hash(password, 12), body.role, time]));
      return Response.json({ id, username: body.username, displayName: body.displayName, role: body.role, temporaryPassword: password }, { status: 201 });
    } catch (error) {
      const duplicate = (error as any).code === "23505";
      return Response.json({ error: duplicate ? "username_exists" : "create_failed" }, { status: duplicate ? 409 : 500 });
    }
  };
}

const Deactivate = z.strictObject({ action: z.literal("deactivate") });
export function createAdminUserDeactivateHandler(deps: Deps) {
  return async (request: Request, context: { id: string }) => {
    const user = await admin(request, deps);
    if (!user) return Response.json({ error: "forbidden" }, { status: 403 });
    if (!UUID.safeParse(context.id).success) return invalid();
    try { Deactivate.parse(await request.json()); } catch { return invalid(); }
    if (context.id === user.id) return Response.json({ error: "cannot_deactivate_self" }, { status: 400 });
    try {
      const changed = await deps.db.transaction(async (tx) => {
        await tx.query("SELECT pg_advisory_xact_lock($1)", [ADMIN_DEACTIVATION_LOCK]);
        const target = await tx.query<any>("SELECT id, role, status FROM public.workbench_users WHERE id=$1 FOR UPDATE", [context.id]);
        if (!target.rows[0]) return false;
        if (target.rows[0].status !== "active") return true;
        if (target.rows[0].role === "admin") {
          const count = await tx.query<any>("SELECT COUNT(*) count FROM public.workbench_users WHERE role = 'admin' AND status='active'", []);
          if (Number(count.rows[0].count) <= 1) throw Object.assign(new Error("last_admin"), { safe: true });
        }
        const time = (deps.now ?? (() => new Date()))();
        await tx.query("UPDATE public.workbench_users SET status='disabled',updated_at=$2 WHERE id=$1", [context.id, time]);
        await tx.query("DELETE FROM public.workbench_sessions WHERE user_id=$1 AND expires_at>$2", [context.id, time]);
        return true;
      });
      return changed ? Response.json({ ok: true }) : Response.json({ error: "not_found" }, { status: 404 });
    } catch (error) {
      const safe = Boolean((error as any).safe);
      return Response.json({ error: safe ? "last_admin" : "deactivate_failed" }, { status: safe ? 400 : 500 });
    }
  };
}

function cell(value: unknown) {
  let text = value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  text = text.replace(/^(\s*)(?=[=+\-@])/, "$1'");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function createAdminExportHandler(deps: Deps) {
  return async (request: Request) => {
    if (!(await admin(request, deps))) return Response.json({ error: "forbidden" }, { status: 403 });
    let query; try { query = parsed(request.url, 10000); } catch { return invalid(); }
    const condition = where(query);
    const values = [...condition.values, 10000];
    const result = await deps.db.query<any>(`${base}${condition.sql} ORDER BY f.created_at DESC,f.id DESC LIMIT $${values.length}`, values);
    const head = ["创建时间", "客服", "问题", "AI原稿", "最终稿", "操作", "弃用原因", "说明", "审核状态", "版本", "调整次数", "本次调整建议", "完整调整过程"];
    const rows = result.rows.map((value) => [value.created_at.toISOString(), value.agent_username, value.question, value.ai_draft, value.final_draft, value.action, value.discard_reason, value.discard_note, value.review_status, `${value.model_version}/${value.prompt_version}/${value.system_version}/${value.knowledge_version}`, value.adjustment_round ?? 0, value.adjustment_instruction ?? "", JSON.stringify(value.adjustment_history ?? [])]);
    const csv = "\ufeff" + [head, ...rows].map((row) => row.map(cell).join(",")).join("\r\n");
    return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="feedback-${(deps.now ?? (() => new Date()))().toISOString().slice(0, 10)}.csv"` } });
  };
}
