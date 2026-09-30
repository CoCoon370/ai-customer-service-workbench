"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { copyText } from "@/lib/copy-text";
import { DiscardDialog, type DiscardReason } from "./discard-dialog";
import { AdjustPanel } from "./adjust-panel";
import { HistoryList, type HistoryItem } from "./history-list";

type PageState = "idle" | "generating" | "adjusting" | "ready" | "saving" | "saved" | "error";

type WorkbenchUser = {
  id: string;
  username: string;
  role: "agent" | "admin";
};

type DraftResult = {
  id: string;
  draft: string;
  answerMode: string;
  createdAt: string;
  adjustmentCount?: number;
  rootDraftId?: string;
};

export function WorkbenchClient({ initialHistory }: { initialHistory: HistoryItem[] }) {
  const router = useRouter();
  const [user, setUser] = useState<WorkbenchUser | null>(null);
  const [history, setHistory] = useState(initialHistory);
  const [question, setQuestion] = useState("");
  const [draft, setDraft] = useState<DraftResult | null>(null);
  const [state, setState] = useState<PageState>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [adjustError, setAdjustError] = useState<string | null>(null);
  const [activeQuestion, setActiveQuestion] = useState("");
  const [previousReplies, setPreviousReplies] = useState<string[]>([]);
  const operation = useRef(false);
  const adjustmentRequest = useRef<{ key: string; id: string } | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [discardReason, setDiscardReason] = useState<DiscardReason | "">("");
  const [discardNote, setDiscardNote] = useState("");
  const [discardError, setDiscardError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    async function loadSession() {
      try {
        const meResponse = await fetch("/api/auth/me", { cache: "no-store" });
        if (meResponse.status === 401) {
          router.replace("/login");
          return;
        }
        if (!meResponse.ok) throw new Error("auth_failed");
        const me = (await meResponse.json()) as { user: WorkbenchUser };
        const historyResponse = await fetch("/api/history", { cache: "no-store" });
        if (historyResponse.status === 401) {
          router.replace("/login");
          return;
        }
        if (!historyResponse.ok) throw new Error("history_failed");
        const historyBody = (await historyResponse.json()) as { items: HistoryItem[] };
        if (active) {
          setUser(me.user);
          setHistory(historyBody.items);
        }
      } catch {
        if (active) {
          setState("error");
          setMessage("工作台加载失败，请刷新重试");
        }
      }
    }
    void loadSession();
    return () => {
      active = false;
    };
  }, [router]);

  function replaceHistoryFeedback(action: HistoryItem["feedbackAction"], finalDraft?: string) {
    if (!draft) return;
    setHistory((items) => items.map((item) => (
      item.id === draft.id ? { ...item, feedbackAction: action, ...(finalDraft ? { finalDraft } : {}) } : item
    )));
  }

  async function saveFeedback(body: Record<string, unknown>): Promise<boolean> {
    try {
      const response = await fetch("/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (response.status === 401) {
        router.replace("/login");
        return false;
      }
      return response.ok;
    } catch {
      return false;
    }
  }

  async function generateDraft() {
    if (operation.current) return;
    const normalized = question.trim();
    setMessage(null);
    if (!normalized) {
      setState("error");
      setMessage("请输入客户问题");
      return;
    }
    if (normalized.length > 2000) {
      setState("error");
      setMessage("客户问题不能超过 2000 字");
      return;
    }

    setDraft(null);
    operation.current = true;
    setAdjustOpen(false);
    setPreviousReplies([]);
    setActiveQuestion(normalized);
    adjustmentRequest.current = null;
    setDiscardOpen(false);
    setQuestion("");
    setState("generating");
    try {
      const response = await fetch("/api/drafts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: normalized }),
      });
      if (response.status === 401) {
        router.replace("/login");
        return;
      }
      if (!response.ok) throw new Error("draft_failed");
      const result = (await response.json()) as DraftResult;
      setDraft(result);
      setHistory((items) => [
        { ...result, question: normalized, feedbackAction: null },
        ...items.filter((item) => item.id !== result.id),
      ].slice(0, 20));
      setState("ready");
    } catch {
      setState("error");
      setMessage("生成失败，请重试");
    } finally {
      operation.current = false;
    }
  }

  async function adoptDraft() {
    if (!draft || operation.current) return;
    operation.current = true;
    setMessage(null);
    try {
      await copyText(draft.draft);
    } catch {
      setState("error");
      setMessage("复制失败，请手动复制");
      operation.current = false;
      return;
    }
    setState("saving");
    if (!(await saveFeedback({ draftRunId: draft.id, action: "adopted" }))) {
      setState("error");
      setMessage("反馈保存失败，请重试");
      operation.current = false;
      return;
    }
    replaceHistoryFeedback("adopted");
    setState("saved");
    setMessage("已采纳并复制");
    setAdjustOpen(false);
    operation.current = false;
  }

  async function submitAdjustment(instruction: string) {
    if (!draft || operation.current || (draft.adjustmentCount ?? 0) >= 3) return;
    operation.current = true;
    setState("adjusting"); setAdjustError(null); setMessage(null);
    const key = draft.id + instruction;
    if (adjustmentRequest.current?.key !== key) {
      // UUID generation works on the existing HTTP origin (crypto.randomUUID does not).
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
      const hex = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
      adjustmentRequest.current = { key, id: `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}` };
    }
    try {
      const response = await fetch("/api/adjustments", { method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ draftRunId: draft.id, instruction, requestId: adjustmentRequest.current.id }) });
      if (response.status === 401) { router.replace("/login"); return; }
      const body = await response.json();
      if (!response.ok) {
        const messages: Record<string, string> = {
          adjustment_limit: "已用完 3 次调整，请采纳或弃用。",
          adjustment_unchanged: "这次回复没有变化，未扣次数。请补充想调整的地方后重试。",
          adjustment_insufficient: "资料不足以支持这次调整，未扣次数。请调整建议后重试。",
          draft_already_handled: "这条回复已在其他页面处理或调整，请刷新查看记录。",
        };
        throw new Error(messages[body.error] ?? "调整失败，未扣次数，可以重试。");
      }
      const result = body as DraftResult;
      setPreviousReplies(items => [...items, draft.draft]);
      setDraft(result); setAdjustOpen(false);
      setHistory(items => [{ ...result, question: activeQuestion, adjustmentInstruction: instruction, feedbackAction: null },
        ...items.map(item => item.id === draft.id ? { ...item, superseded: true } : item)].slice(0, 20));
      setMessage("回复已调整，请确认后采纳或弃用。");
    } catch (error) {
      setAdjustError(error instanceof Error ? error.message : "调整失败，未扣次数，请重试。");
    } finally { setState("ready"); operation.current = false; }
  }

  function openDiscardDialog() {
    setDiscardReason("");
    setDiscardNote("");
    setDiscardError(null);
    setDiscardOpen(true);
  }

  async function submitDiscard() {
    if (!draft || operation.current || !discardReason || (discardReason === "other" && !discardNote.trim())) return;
    operation.current = true;
    setState("saving");
    setDiscardError(null);
    const body: Record<string, unknown> = {
      draftRunId: draft.id,
      action: "discarded",
      discardReason,
    };
    if (discardNote.trim()) body.discardNote = discardNote.trim();
    if (!(await saveFeedback(body))) {
      setState("error");
      setDiscardError("反馈保存失败，请重试");
      operation.current = false;
      return;
    }
    replaceHistoryFeedback("discarded");
    setDiscardOpen(false);
    setState("saved");
    setMessage("已弃用");
    setAdjustOpen(false);
    operation.current = false;
  }

  async function logout() {
    setDraft(null);
    setHistory([]);
    setUser(null);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      router.replace("/login");
    }
  }

  const feedbackComplete = state === "saved";
  const busy = state === "saving" || state === "adjusting" || state === "generating";

  return (
    <main className="workbench-shell">
      <header className="workbench-header">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">绿</span>
          <div>
            <p className="eyebrow">绿手指有机农场</p>
            <h1>客服辅助工作台</h1>
          </div>
        </div>
        <div className="agent-controls">
          <span>{user ? `客服：${user.username}` : "正在确认登录…"}</span>
          <button className="button-quiet" type="button" onClick={logout}>退出登录</button>
        </div>
      </header>

      <p className="safety-note">仅供客服参考，不会自动发送</p>

      <div className="workbench-grid">
        <section className="workbench-card drafting-card" aria-labelledby="question-title">
          <div className="section-heading">
            <div>
              <p className="eyebrow">查询与拟稿</p>
              <h2 id="question-title">客户问题</h2>
            </div>
            <span className="character-count">{question.length} / 2000</span>
          </div>
          <label className="sr-only" htmlFor="customer-question">客户问题</label>
          <textarea
            id="customer-question"
            className="question-input"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void generateDraft();
              }
            }}
            placeholder="粘贴客户的问题，例如：这款商品应该怎么保存？"
            rows={6}
            disabled={busy}
          />
          <div className="generate-row">
            <span className="input-hint">请勿输入姓名、手机号、地址或订单号等真实隐私信息</span>
            <button className="button-primary" type="button" onClick={generateDraft} disabled={busy}>
              {state === "generating" ? "正在生成…" : "生成参考回复"}
            </button>
          </div>

          <div className="draft-panel" aria-live="polite">
            <div className="draft-heading">
              <div>
                <p className="eyebrow">AI 草稿</p>
                <h2>参考回复</h2>
              </div>
              {draft ? <span className="status-pill">{draft.answerMode === "insufficient" ? "资料不足" : "已生成"}</span> : null}
            </div>
            {state === "generating" ? <p className="draft-placeholder">正在查询 FAQ 和商品信息并整理回复…</p> : null}
            {!draft && state !== "generating" ? <p className="draft-placeholder">生成后，参考回复会显示在这里</p> : null}
            {draft ? <p className="draft-copy">{draft.draft}</p> : null}
            {message ? <p className={state === "error" ? "form-error" : "form-success"} role="status">{message}</p> : null}
            {draft ? (
              <div className="feedback-actions">
                <button className="button-primary" type="button" onClick={adoptDraft} disabled={busy || feedbackComplete}>采纳并复制</button>
                <button className="button-secondary" type="button" onClick={() => { setAdjustError(null); setAdjustOpen(true); }} disabled={busy || feedbackComplete || (draft.adjustmentCount ?? 0) >= 3}>帮我调整</button>
                <button className="button-quiet danger-text" type="button" onClick={openDiscardDialog} disabled={busy || feedbackComplete}>弃用</button>
                <span className="input-hint">已调整 {draft.adjustmentCount ?? 0} / 3 次</span>
              </div>
            ) : null}
            {(draft?.adjustmentCount ?? 0) >= 3 ? <p className="input-hint">已用完 3 次调整，可采纳当前回复，或弃用并反馈。</p> : null}
            {adjustOpen ? <AdjustPanel busy={state === "adjusting"} error={adjustError}
              onCancel={() => setAdjustOpen(false)} onSubmit={submitAdjustment} /> : null}
            {previousReplies.length ? <details className="adjust-panel"><summary>查看之前的回复</summary>
              {previousReplies.map((text, i) => <div key={i}><p className="eyebrow">{i === 0 ? "初次生成" : `第 ${i} 次调整`}</p><p className="draft-copy">{text}</p></div>)}
            </details> : null}
          </div>
        </section>

        <HistoryList items={history} />
      </div>

      {discardOpen ? (
        <DiscardDialog
          reason={discardReason}
          note={discardNote}
          busy={state === "saving"}
          error={discardError}
          onReasonChange={setDiscardReason}
          onNoteChange={setDiscardNote}
          onCancel={() => setDiscardOpen(false)}
          onSubmit={submitDiscard}
        />
      ) : null}
    </main>
  );
}
