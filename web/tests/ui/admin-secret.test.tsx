// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UserManagement } from "@/app/admin/user-management";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderAndFill() {
  const browser = userEvent.setup();
  render(<UserManagement />);
  await screen.findByText("暂无账号");
  await browser.type(screen.getByLabelText("用户名"), "agent_a");
  await browser.type(screen.getByLabelText("显示名称"), "客服 A");
  return browser;
}

describe("一次性密码不会串到下一次创建", () => {
  it("成功 A 后提交 B 收到冲突，立即清掉 A 密码并保留 B 表单", async () => {
    let creates = 0;
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (!init?.method || init.method === "GET") return json({ items: [] });
      creates += 1;
      return creates === 1
        ? json({ temporaryPassword: "secret-A" }, 201)
        : json({ error: "username_exists" }, 409);
    }));
    const browser = await renderAndFill();
    const submit = screen.getByRole("button", { name: "创建账号" });

    await browser.click(submit);
    expect(await screen.findByText("secret-A")).toBeTruthy();
    await browser.type(screen.getByLabelText("用户名"), "agent_b");
    await browser.type(screen.getByLabelText("显示名称"), "客服 B");
    await browser.click(submit);

    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "用户名已存在，请更换后重试");
    expect(screen.queryByText("secret-A")).toBeNull();
    expect((screen.getByLabelText("用户名") as HTMLInputElement).value).toBe("agent_b");
    expect((screen.getByLabelText("显示名称") as HTMLInputElement).value).toBe("客服 B");
  });

  it("成功 A 后提交 B 遇到网络失败，A 密码保持清除；重试成功只显示 B", async () => {
    let creates = 0;
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (!init?.method || init.method === "GET") return json({ items: [] });
      creates += 1;
      if (creates === 1) return json({ temporaryPassword: "secret-A" }, 201);
      if (creates === 2) throw new Error("network");
      return json({ temporaryPassword: "secret-B" }, 201);
    }));
    const browser = await renderAndFill();
    const submit = screen.getByRole("button", { name: "创建账号" });

    await browser.click(submit);
    expect(await screen.findByText("secret-A")).toBeTruthy();
    await browser.type(screen.getByLabelText("用户名"), "agent_b");
    await browser.type(screen.getByLabelText("显示名称"), "客服 B");
    await browser.click(submit);

    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "创建账号失败，请重试");
    expect(screen.queryByText("secret-A")).toBeNull();
    await browser.click(submit);
    expect(await screen.findByText("secret-B")).toBeTruthy();
    expect(screen.queryByText("secret-A")).toBeNull();
  });
});
