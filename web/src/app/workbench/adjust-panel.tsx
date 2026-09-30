"use client";
import { useState } from "react";

const OPTIONS = ["更亲切", "更简短", "先安抚客户", "没答到重点"];
export function AdjustPanel({ busy, error, onCancel, onSubmit }: {
  busy: boolean; error: string | null; onCancel: () => void;
  onSubmit: (instruction: string) => void;
}) {
  const [choice, setChoice] = useState("");
  const [note, setNote] = useState("");
  return <section className="adjust-panel" aria-labelledby="adjust-title">
    <h3 id="adjust-title">这次想怎么调整？</h3>
    <div className="adjust-options">{OPTIONS.map(label => <button key={label} type="button"
      className="button-secondary" aria-pressed={choice === label} disabled={busy}
      onClick={() => setChoice(choice === label ? "" : label)}>{label}</button>)}</div>
    <label className="field-label" htmlFor="adjust-note">补充你的想法（选填）</label>
    <textarea id="adjust-note" className="dialog-textarea compact" value={note} maxLength={2000}
      onChange={e => setNote(e.target.value)} disabled={busy} rows={3}
      placeholder="不用重写回复，说说哪里不合适就好" />
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    <div className="dialog-actions">
      <button className="button-secondary" type="button" onClick={onCancel} disabled={busy}>取消</button>
      <button className="button-primary" type="button" disabled={busy || (!choice && !note.trim())}
        onClick={() => onSubmit([choice, note.trim() ? `具体建议：${note.trim()}` : ""].filter(Boolean).join("\n"))}>
        {busy ? "正在调整…" : "生成调整后的回复"}
      </button>
    </div>
  </section>;
}
