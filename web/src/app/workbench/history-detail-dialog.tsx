"use client";

import type { HistoryItem } from "./history-list";
import { DISCARD_OPTIONS } from "./discard-dialog";

const feedbackLabels = {
  adopted: "已采纳",
  modified: "已修改",
  discarded: "已弃用",
} as const;

const discardLabels = Object.fromEntries(DISCARD_OPTIONS.map((item) => [item.code, item.label]));

export function HistoryDetailDialog({ item, onClose }: { item: HistoryItem; onClose: () => void }) {
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="workbench-dialog history-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="history-detail-title">
        <div className="history-detail-heading">
          <div>
            <p className="eyebrow">查询记录</p>
            <h2 id="history-detail-title">记录详情</h2>
          </div>
          <button className="button-quiet" type="button" onClick={onClose} aria-label="关闭记录详情">关闭</button>
        </div>
        <dl className="history-detail-list">
          <div><dt>客户问题</dt><dd>{item.question}</dd></div>
          <div><dt>AI 参考回复</dt><dd>{item.draft}</dd></div>
          {item.adjustmentInstruction ? <div><dt>本次调整建议</dt><dd>{item.adjustmentInstruction}</dd></div> : null}
          {item.finalDraft ? <div><dt>客服修改后的回复</dt><dd>{item.finalDraft}</dd></div> : null}
          <div><dt>处理状态</dt><dd>{item.feedbackAction ? feedbackLabels[item.feedbackAction] : item.superseded ? "已继续调整" : "待处理"}</dd></div>
          {item.discardReason ? <div><dt>弃用原因</dt><dd>{discardLabels[item.discardReason] ?? item.discardReason}{item.discardNote ? `：${item.discardNote}` : ""}</dd></div> : null}
          <div><dt>查询时间</dt><dd>{new Date(item.createdAt).toLocaleString("zh-CN", { hour12: false })}</dd></div>
        </dl>
      </section>
    </div>
  );
}
