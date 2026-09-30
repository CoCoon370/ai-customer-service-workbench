"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!username.trim() || !password) {
      setError("请输入客服账号和密码");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        if (body?.error === "account_locked") setError("登录失败次数过多，请稍后再试");
        else setError("账号或密码不正确");
        return;
      }
      setPassword("");
      router.replace("/workbench");
      router.refresh();
    } catch {
      setError("登录服务暂时不可用，请稍后重试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-shell">
      <section className="login-card">
        <div className="brand-lockup login-brand">
          <span className="brand-mark" aria-hidden="true">绿</span>
          <div>
            <p className="eyebrow">绿手指有机农场</p>
            <h1>客服辅助工作台</h1>
          </div>
        </div>
        <p className="login-intro">使用管理员分配的客服账号登录</p>
        <form onSubmit={submit} className="login-form">
          <label htmlFor="username">客服账号</label>
          <input id="username" name="username" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} disabled={busy} />
          <label htmlFor="password">密码</label>
          <input id="password" name="password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy} />
          {error ? <p className="form-error" role="alert">{error}</p> : null}
          <button className="button-primary login-button" type="submit" disabled={busy}>{busy ? "正在登录…" : "登录"}</button>
        </form>
        <p className="safety-note login-note">仅供客服参考，不会自动发送</p>
      </section>
    </main>
  );
}
