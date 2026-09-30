"use client";

import { FormEvent, useEffect, useState } from "react";

type User = {
  id: string;
  username: string;
  display_name?: string;
  displayName?: string;
  role: "agent" | "admin";
  status: string;
};

export function UserManagement() {
  const [users, setUsers] = useState<User[]>([]);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<"agent" | "admin">("agent");
  const [secret, setSecret] = useState("");
  const [listError, setListError] = useState("");
  const [actionError, setActionError] = useState("");
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [deactivatingId, setDeactivatingId] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setListError("");
    try {
      const response = await fetch("/api/admin/users");
      if (!response.ok) throw new Error("list_failed");
      setUsers((await response.json()).items);
    } catch {
      setListError("账号列表加载失败，请重试");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    return () => setSecret("");
  }, []);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreating(true);
    setActionError("");
    setSecret("");
    try {
      const response = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, displayName, role }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body.error === "username_exists" ? "username_exists" : "create_failed");
      }
      setSecret(body.temporaryPassword);
      setUsername("");
      setDisplayName("");
      setRole("agent");
      await load();
    } catch (error) {
      setActionError(error instanceof Error && error.message === "username_exists" ? "用户名已存在，请更换后重试" : "创建账号失败，请重试");
    } finally {
      setCreating(false);
    }
  }

  async function deactivate(id: string) {
    setDeactivatingId(id);
    setActionError("");
    try {
      const response = await fetch(`/api/admin/users/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "deactivate" }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const messages: Record<string, string> = {
          last_admin: "不能停用最后一个有效管理员",
          cannot_deactivate_self: "不能停用当前登录账号",
        };
        throw new Error(messages[body.error] ?? "停用账号失败，请重试");
      }
      await load();
    } catch (error) {
      setActionError(error instanceof Error && error.message.startsWith("不能") ? error.message : "停用账号失败，请重试");
    } finally {
      setDeactivatingId(null);
    }
  }

  return (
    <section>
      <h2>账号管理</h2>
      <form onSubmit={create}>
        <label>用户名<input aria-label="用户名" required value={username} onChange={(event) => setUsername(event.target.value)} /></label>
        <label>显示名称<input aria-label="显示名称" required value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
        <label>角色<select aria-label="角色" value={role} onChange={(event) => setRole(event.target.value as "agent" | "admin")}>
          <option value="agent">客服</option><option value="admin">管理员</option>
        </select></label>
        <button type="submit" disabled={creating}>{creating ? "正在创建…" : "创建账号"}</button>
      </form>

      {actionError && <p role="alert">{actionError}</p>}
      {secret && <p role="status">临时密码：<code>{secret}</code>。仅显示本次，请立即复制并安全保存；离开或刷新后将消失。</p>}
      {loading && <p role="status">正在加载账号…</p>}
      {listError && <p role="alert">{listError}<button type="button" onClick={() => void load()}>重试列表</button></p>}
      {!loading && users.length === 0 && <p>暂无账号</p>}
      <ul>
        {users.map((user) => (
          <li key={user.id}>
            {user.display_name ?? user.displayName ?? user.username}（{user.role}，{user.status}）
            <button type="button" disabled={deactivatingId === user.id || user.status !== "active"} onClick={() => void deactivate(user.id)}>
              {deactivatingId === user.id ? "正在停用…" : "停用账号"}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
