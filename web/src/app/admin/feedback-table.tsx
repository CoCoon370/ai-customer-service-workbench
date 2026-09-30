"use client";

import { useEffect, useMemo, useState } from "react";

type Filters = {
  agentId: string;
  action: string;
  discardReason: string;
  reviewStatus: string;
  from: string;
  to: string;
};

type FeedbackSummary = {
  id: string;
  agentUsername: string;
  question: string;
  action: string;
  reviewStatus: string;
  createdAt: string;
};

type FeedbackDetail = FeedbackSummary & {
  aiOriginal: string;
  finalDraft: string | null;
  faqSnapshot: unknown;
  productSnapshot: unknown;
  versions: { model: string; prompt: string; system: string; knowledge: string };
};

const emptyFilters: Filters = {
  agentId: "",
  action: "",
  discardReason: "",
  reviewStatus: "",
  from: "",
  to: "",
};

function paramsFor(filters: Filters, page?: number) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, value);
  }
  if (page !== undefined && (page !== 1 || params.size > 0)) params.set("page", String(page));
  return params;
}

function urlFor(path: string, filters: Filters, page?: number) {
  const query = paramsFor(filters, page).toString();
  return query ? `${path}?${query}` : path;
}

function snapshot(value: unknown) {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

export function FeedbackTable() {
  const [draftFilters, setDraftFilters] = useState<Filters>(emptyFilters);
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<FeedbackSummary[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<FeedbackDetail | null>(null);
  const [detailError, setDetailError] = useState("");
  const [detailLoading, setDetailLoading] = useState(false);
  const [reviewPending, setReviewPending] = useState(false);

  const exportUrl = useMemo(() => urlFor("/api/admin/export", filters), [filters]);

  async function loadList(nextFilters = filters, nextPage = page) {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(urlFor("/api/admin/feedback", nextFilters, nextPage));
      if (!response.ok) throw new Error("feedback_load_failed");
      const body = await response.json();
      setItems(body.items);
    } catch {
      setError("反馈加载失败，请重试");
    } finally {
      setLoading(false);
    }
  }

  async function loadDetail(id = selectedId) {
    if (!id) return;
    setDetailLoading(true);
    setDetailError("");
    try {
      const response = await fetch(`/api/admin/feedback/${id}`);
      if (!response.ok) throw new Error("detail_load_failed");
      setDetail(await response.json());
    } catch {
      setDetailError("详情加载失败，请重试");
    } finally {
      setDetailLoading(false);
    }
  }

  useEffect(() => {
    void loadList(emptyFilters, 1);
  }, []);

  async function review(action: "queue_for_review" | "no_action") {
    if (!selectedId) return;
    setReviewPending(true);
    setDetailError("");
    try {
      const response = await fetch(`/api/admin/feedback/${selectedId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!response.ok) throw new Error("review_failed");
      await Promise.all([loadList(), loadDetail(selectedId)]);
    } catch {
      setDetailError("保存失败，当前内容已保留，请重试");
    } finally {
      setReviewPending(false);
    }
  }

  function field(key: keyof Filters, label: string, type = "text") {
    return (
      <label>
        {label}
        <input
          aria-label={label}
          type={type}
          value={draftFilters[key]}
          onChange={(event) => setDraftFilters((old) => ({ ...old, [key]: event.target.value }))}
        />
      </label>
    );
  }

  function select(key: keyof Filters, label: string, options: Array<[string, string]>) {
    return (
      <label>
        {label}
        <select
          aria-label={label}
          value={draftFilters[key]}
          onChange={(event) => setDraftFilters((old) => ({ ...old, [key]: event.target.value }))}
        >
          <option value="">全部</option>
          {options.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
        </select>
      </label>
    );
  }

  return (
    <section>
      <h2>反馈审核</h2>
      <form onSubmit={(event) => {
        event.preventDefault();
        setFilters(draftFilters);
        setPage(1);
        void loadList(draftFilters, 1);
      }}>
        {field("agentId", "客服 ID")}
        {select("action", "操作", [["adopted", "采纳"], ["modified", "修改"], ["discarded", "弃用"]])}
        {select("discardReason", "弃用原因", [
          ["knowledge_incorrect", "知识内容不正确"], ["question_unresolved", "未解决问题"],
          ["wrong_product", "商品匹配错误"], ["irrelevant_answer", "回复无关"],
          ["tone_or_style", "语气或表达"], ["dynamic_data_required", "需要实时信息"], ["other", "其他"],
        ])}
        {select("reviewStatus", "审核状态", [["pending", "待审核"], ["queued", "核查队列"], ["no_action", "无需处理"]])}
        {field("from", "开始时间", "date")}
        {field("to", "结束时间", "date")}
        <button type="submit" disabled={loading}>筛选反馈</button>
        <a href={exportUrl}>导出 CSV</a>
      </form>

      {loading && <p role="status">正在加载反馈…</p>}
      {error && <p role="alert">{error}<button type="button" onClick={() => void loadList()}>重试列表</button></p>}
      {!loading && items.length === 0 && <p>暂无反馈</p>}
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            <button type="button" onClick={() => {
              setSelectedId(item.id);
              setDetail(null);
              void loadDetail(item.id);
            }}>{item.question}</button>
            {" · "}{item.agentUsername}
          </li>
        ))}
      </ul>
      <nav aria-label="反馈分页">
        <button type="button" disabled={loading || page <= 1} onClick={() => {
          const next = page - 1;
          setPage(next);
          void loadList(filters, next);
        }}>上一页</button>
        <span>第 {page} 页</span>
        <button type="button" disabled={loading || items.length === 0} onClick={() => {
          const next = page + 1;
          setPage(next);
          void loadList(filters, next);
        }}>下一页</button>
      </nav>

      {selectedId && (
        <article>
          <h3>反馈详情</h3>
          {detailLoading && <p role="status">正在加载详情…</p>}
          {detailError && <p role="alert">{detailError}<button type="button" onClick={() => void loadDetail()}>重试详情</button></p>}
          {detail && (
            <>
              <h4>客户问题</h4><p>{detail.question}</p>
              <h4>AI 原稿</h4><p>{detail.aiOriginal}</p>
              <h4>客服最终稿</h4><p>{detail.finalDraft ?? "未填写"}</p>
              <h4>FAQ 快照</h4><pre>{snapshot(detail.faqSnapshot)}</pre>
              <h4>商品快照</h4><pre>{snapshot(detail.productSnapshot)}</pre>
              <h4>版本</h4>
              <dl>
                <dt>模型</dt><dd>{detail.versions.model}</dd>
                <dt>提示词</dt><dd>{detail.versions.prompt}</dd>
                <dt>系统</dt><dd>{detail.versions.system}</dd>
                <dt>知识库</dt><dd>{detail.versions.knowledge}</dd>
              </dl>
              <button type="button" disabled={reviewPending} onClick={() => void review("queue_for_review")}>加入核查队列</button>
              <button type="button" disabled={reviewPending} onClick={() => void review("no_action")}>标记无需处理</button>
            </>
          )}
        </article>
      )}
    </section>
  );
}
