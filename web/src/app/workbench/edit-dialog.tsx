"use client";

type EditDialogProps = {
  value: string;
  busy: boolean;
  error: string | null;
  onChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
  saved: boolean;
};

export function EditDialog({ value, busy, error, onChange, onCancel, onSubmit, saved }: EditDialogProps) {
  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="workbench-dialog" role="dialog" aria-modal="true" aria-labelledby="edit-dialog-title">
        <div>
          <p className="eyebrow">人工调整</p>
          <h2 id="edit-dialog-title">修改回复</h2>
        </div>
        <label className="field-label" htmlFor="edited-draft">修改后的回复</label>
        <textarea
          id="edited-draft"
          className="dialog-textarea"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          rows={9}
          disabled={busy || saved}
          autoFocus
        />
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="dialog-actions">
          <button className="button-secondary" type="button" onClick={onCancel} disabled={busy}>取消</button>
          <button className="button-primary" type="button" onClick={onSubmit} disabled={busy || !value.trim()}>
            {busy ? "正在保存…" : saved ? "再次复制" : "保存并复制"}
          </button>
        </div>
      </section>
    </div>
  );
}
