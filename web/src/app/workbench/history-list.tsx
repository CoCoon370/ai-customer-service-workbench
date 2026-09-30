"use client";

import { useState } from "react";

import { HistoryDetailDialog } from "./history-detail-dialog";

export type HistoryItem = {
  id: string;
  question: string;
  draft: string;
  answerMode: string;
  createdAt: string;
  feedbackAction: "adopted" | "modified" | "discarded" | null;
  finalDraft?: string | null;
  discardReason?: string | null;
  discardNote?: string | null;
  adjustmentCount?: number;
  adjustmentInstruction?: string | null;
  superseded?: boolean;
};

const feedbackLabels: Record<Exclude<HistoryItem["feedbackAction"], null>, string> = {
  adopted: "已采纳",
  modified: "已修改",
  discarded: "已弃用",
};

function questionSummary(question: string): string {
  return question.length > 80 ? `${question.slice(0, 80)}…` : question;
}

function draftStatus(answerMode: string): string {
  if (answerMode === "insufficient") return "资料不足";
  if (answerMode === "error") return "生成失败";
  return "草稿已生成";
}

export function HistoryList({ items }: { items: HistoryItem[] }) {
  const [selectedItem, setSelectedItem] = useState<HistoryItem | null>(null);
  return (
    <>
      <section className="workbench-card history-card" aria-labelledby="history-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">最近查询</p>
          <h2 id="history-title">我的记录</h2>
        </div>
        <span className="history-count">最近 {items.length} 条</span>
      </div>
      {items.length === 0 ? (
        <p className="empty-state">还没有查询记录</p>
      ) : (
        <ol className="history-list">
          {items.map((item) => (
            <li key={item.id}>
              <button className="history-item-button" type="button" onClick={() => setSelectedItem(item)} aria-label={`查看记录：${questionSummary(item.question)}`}>
                <span className="history-question">{questionSummary(item.question)}</span>
                <span className="history-meta">
                  <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString("zh-CN", { hour12: false })}</time>
                  <span>{draftStatus(item.answerMode)}</span>
                  <span>{item.feedbackAction ? feedbackLabels[item.feedbackAction] : item.superseded ? "已继续调整" : "待处理"}</span>
                  {item.adjustmentCount ? <span>第 {item.adjustmentCount} 次调整</span> : null}
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
      </section>
      {selectedItem ? <HistoryDetailDialog item={selectedItem} onClose={() => setSelectedItem(null)} /> : null}
    </>
  );
}
