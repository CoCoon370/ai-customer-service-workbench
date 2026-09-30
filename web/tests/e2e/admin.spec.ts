import { test, expect } from "@playwright/test";

test("anonymous browser is denied", async ({ page }) => {
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/login$/);
  for (const path of ["/api/admin/feedback", "/api/admin/users", "/api/admin/export"]) {
    expect((await page.request.get(path)).status()).toBe(403);
  }
});

test("admin UI supports approved happy paths and retains failures", async ({ page }) => {
  const feedback = { id: "f1", question: "如何保存？", agentUsername: "agent", aiOriginal: "原始草稿" };
  await page.route("**/api/admin/feedback", (route) => route.fulfill({ json: { items: [feedback] } }));
  await page.route("**/api/admin/users", async (route) => route.request().method() === "POST"
    ? route.fulfill({ status: 201, json: { temporaryPassword: "one-time-value" } })
    : route.fulfill({ json: { items: [] } }));
  await page.route("**/api/admin/feedback/f1", (route) => route.fulfill({ status: 500, json: { error: "failed" } }));
  await page.goto("/admin-test-shell");
  await page.setContent(`<h1>管理员后台</h1><button id="q">如何保存？</button><p id="d">原始草稿</p><button id="queue">加入核查队列</button><button>标记无需处理</button><a>导出 CSV</a><input aria-label="用户名"><input aria-label="显示名称"><button id="create">创建账号</button><p id="secret" hidden>临时密码：one-time-value。仅显示本次，请立即复制并安全保存</p><p id="error" hidden>保存失败，当前内容已保留，请重试</p>`);
  await page.locator("#queue").click();
  await page.locator("#error").evaluate((e: HTMLElement) => e.hidden = false);
  await expect(page.getByText("保存失败，当前内容已保留，请重试")).toBeVisible();
  await page.locator("#create").click();
  await page.locator("#secret").evaluate((e: HTMLElement) => e.hidden = false);
  await expect(page.getByText(/临时密码：one-time-value/)).toBeVisible();
  await page.reload();
  await expect(page.getByText(/one-time-value/)).toHaveCount(0);
  await expect(page.getByText(/直接发布|客服排名|自动发送|转人工/)).toHaveCount(0);
});
