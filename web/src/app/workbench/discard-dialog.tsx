"use client";

export const DISCARD_OPTIONS = [
  { code: "knowledge_incorrect", label: "知识内容不正确" },
  { code: "question_unresolved", label: "没有解决客户问题" },
  { code: "wrong_product", label: "商品匹配错误" },
  { code: "irrelevant_answer", label: "回复与问题无关" },
  { code: "tone_or_style", label: "语气或表达不合适" },
  { code: "dynamic_data_required", label: "需要实时信息" },
  { code: "other", label: "其他原因" },
] as const;

export type DiscardReason = (typeof DISCARD_OPTIONS)[number]["code"];

type DiscardDialogProps = {
  reason: DiscardReason | "";
  note: string;
  busy: boolean;
  error: string | null;
  onReasonChange: (reason: DiscardReason) => void;
  onNoteChange: (note: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
};

export function DiscardDialog({ reason, note, busy, error, onReasonChange, onNoteChange, onCancel, onSubmit }: DiscardDialogProps) {
  const submitDisabled = busy || !reason || (reason === "other" && !note.trim());
  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="workbench-dialog" role="dialog" aria-modal="true" aria-labelledby="discard-dialog-title">
        <div>
          <p className="eyebrow">反馈原因</p>
          <h2 id="discard-dialog-title">弃用这条回复</h2>
        </div>
        <fieldset className="reason-list" disabled={busy}>
          <legend>请选择一个主要原因</legend>
          {DISCARD_OPTIONS.map((option) => (
            <label key={option.code}>
              <input
                type="radio"
                name="discard-reason"
                value={option.code}
                checked={reason === option.code}
                onChange={() => onReasonChange(option.code)}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </fieldset>
        <label className="field-label" htmlFor="discard-note">补充说明</label>
        <textarea
          id="discard-note"
          className="dialog-textarea compact"
          value={note}
          onChange={(event) => onNoteChange(event.target.value)}
          placeholder={reason === "other" ? "选择其他原因时必须填写" : "选填"}
          rows={3}
          disabled={busy}
        />
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="dialog-actions">
          <button className="button-secondary" type="button" onClick={onCancel} disabled={busy}>取消</button>
          <button className="button-danger" type="button" onClick={onSubmit} disabled={submitDisabled}>
            {busy ? "正在保存…" : "确认"}
          </button>
        </div>
      </section>
    </div>
  );
}
