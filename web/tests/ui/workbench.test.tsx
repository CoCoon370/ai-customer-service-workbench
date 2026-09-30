// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { WorkbenchClient } from "@/app/workbench/workbench-client";
const navigation = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => navigation }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const initial = { id: "10000000-0000-4000-8000-000000000001", draft: "原始参考回复", answerMode: "draft", createdAt: "2026-09-17T00:00:00Z" };
async function ready(failFirst = false) {
  let attempts = 0, count = 0;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/auth/me") return json({ user: { username: "客服A" } });
    if (url === "/api/history") return json({ items: [] });
    if (url === "/api/drafts") return json(initial, 201);
    if (url === "/api/adjustments") {
      if (failFirst && attempts++ === 0) return json({ error: "adjustment_unchanged" }, 422);
      count++;
      return json({ ...initial, id: `10000000-0000-4000-8000-00000000000${count + 1}`, draft: `调整后的回复${count}`, adjustmentCount: count }, 201);
    }
    if (url === "/api/feedback") return json({ action: JSON.parse(String(init?.body)).action }, 201);
    throw new Error(url);
  });
  vi.stubGlobal("fetch", fetcher);
  const browser = userEvent.setup();
  render(<WorkbenchClient initialHistory={[]} />);
  await screen.findByText("客服：客服A");
  fireEvent.change(screen.getByRole("textbox", { name: "客户问题" }), { target: { value: "猕猴桃是硬的" } });
  fireEvent.keyDown(screen.getByRole("textbox", { name: "客户问题" }), { key: "Enter" });
  await screen.findByText(initial.draft);
  return { browser, fetcher };
}
it("removes manual editing, preserves Enter submission and input clearing", async () => {
  await ready();
  expect(screen.queryByRole("button", { name: "修改回复" })).toBeNull();
  expect(screen.getByRole("button", { name: "帮我调整" })).toBeTruthy();
  expect((screen.getByRole("textbox", { name: "客户问题" }) as HTMLTextAreaElement).value).toBe("");
});
it("sends guidance, keeps revisions and stops after three successes", async () => {
  const { browser, fetcher } = await ready();
  for (let n = 1; n <= 3; n++) {
    await browser.click(screen.getByRole("button", { name: "帮我调整" }));
    await browser.click(screen.getByRole("button", { name: "更亲切" }));
    await browser.type(screen.getByLabelText("补充你的想法（选填）"), `建议${n}`);
    await browser.click(screen.getByRole("button", { name: "生成调整后的回复" }));
    await screen.findByText(`调整后的回复${n}`);
    expect(screen.getByText(`已调整 ${n} / 3 次`)).toBeTruthy();
    expect((screen.getByRole("button", { name: "采纳并复制" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "弃用" }) as HTMLButtonElement).disabled).toBe(false);
  }
  expect((screen.getByRole("button", { name: "帮我调整" }) as HTMLButtonElement).disabled).toBe(true);
  const payloads = fetcher.mock.calls.filter(([url]) => url === "/api/adjustments").map(([, init]) => JSON.parse(String(init?.body)));
  expect(payloads[2].instruction).toContain("建议3");
  expect(payloads[2].draftRunId).toBe("10000000-0000-4000-8000-000000000003");
  expect(payloads[0].requestId).toMatch(/^[a-f0-9-]{36}$/);
});
it("failed adjustment keeps the suggestion and count; retry reuses request ID", async () => {
  const { browser, fetcher } = await ready(true);
  await browser.click(screen.getByRole("button", { name: "帮我调整" }));
  await browser.type(screen.getByLabelText("补充你的想法（选填）"), "先回应担心");
  await browser.click(screen.getByRole("button", { name: "生成调整后的回复" }));
  await screen.findByRole("alert");
  expect(screen.getByText("已调整 0 / 3 次")).toBeTruthy();
  expect((screen.getByLabelText("补充你的想法（选填）") as HTMLTextAreaElement).value).toBe("先回应担心");
  await browser.click(screen.getByRole("button", { name: "生成调整后的回复" }));
  await screen.findByText("调整后的回复1");
  const calls = fetcher.mock.calls.filter(([url]) => url === "/api/adjustments");
  expect(calls[0][1]?.body).toBe(calls[1][1]?.body);
});
it("adopts the adjusted reply using the HTTP clipboard fallback", async () => {
  const { browser, fetcher } = await ready();
  await browser.click(screen.getByRole("button", { name: "帮我调整" }));
  await browser.click(screen.getByRole("button", { name: "更简短" }));
  await browser.click(screen.getByRole("button", { name: "生成调整后的回复" }));
  await screen.findByText("调整后的回复1");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
  Object.defineProperty(document, "execCommand", { configurable: true, value: vi.fn(() => true) });
  await browser.click(screen.getByRole("button", { name: "采纳并复制" }));
  await screen.findByText("已采纳并复制");
  const call = fetcher.mock.calls.find(([url]) => url === "/api/feedback");
  expect(JSON.parse(String(call?.[1]?.body))).toEqual({ draftRunId: "10000000-0000-4000-8000-000000000002", action: "adopted" });
});
it("discard requires a reason and closes the current round", async () => {
  const { browser } = await ready();
  await browser.click(screen.getByRole("button", { name: "弃用" }));
  expect((screen.getByRole("button", { name: "确认" }) as HTMLButtonElement).disabled).toBe(true);
  await browser.click(screen.getByRole("radio", { name: "商品匹配错误" }));
  await browser.click(screen.getByRole("button", { name: "确认" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("已弃用"));
  expect((screen.getByRole("button", { name: "帮我调整" }) as HTMLButtonElement).disabled).toBe(true);
});
