import { expect, test, type Page } from "@playwright/test";

const user = { id: "00000000-0000-4000-8000-000000000001", username: "agent-01", role: "agent" };

type MockOptions = {
  clipboardFails?: boolean;
  feedbackStatuses?: number[];
  authenticated?: boolean;
};

async function installApiMocks(page: Page, options: MockOptions = {}) {
  const feedbackBodies: Record<string, unknown>[] = [];
  const history: Record<string, unknown>[] = [];
  let draftCounter = 0;
  let feedbackCounter = 0;
  let authenticated = options.authenticated ?? true;

  await page.addInitScript((clipboardFails) => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          if (clipboardFails) throw new Error("clipboard denied");
          window.localStorage.setItem("lastCopiedDraft", text);
        },
      },
    });
  }, options.clipboardFails ?? false);

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/auth/me") {
      return route.fulfill({ status: authenticated ? 200 : 401, json: authenticated ? { user } : { error: "unauthorized" } });
    }
    if (path === "/api/auth/login") {
      authenticated = true;
      return route.fulfill({ status: 200, json: { user } });
    }
    if (path === "/api/auth/logout") {
      authenticated = false;
      return route.fulfill({ status: 204, body: "" });
    }
    if (!authenticated) return route.fulfill({ status: 401, json: { error: "unauthorized" } });
    if (path === "/api/history") return route.fulfill({ status: 200, json: { items: history } });
    if (path === "/api/drafts") {
      draftCounter += 1;
      const question = (request.postDataJSON() as { question: string }).question;
      const result = {
        id: `10000000-0000-4000-8000-${String(draftCounter).padStart(12, "0")}`,
        draft: `您好，理解您的疑问。关于“${question}”，请以审核知识为准。`,
        answerMode: "draft",
        createdAt: "2026-08-11T03:00:00.000Z",
      };
      history.unshift({ ...result, question, feedbackAction: null });
      return route.fulfill({ status: 201, json: result });
    }
    if (path === "/api/feedback") {
      feedbackBodies.push(request.postDataJSON() as Record<string, unknown>);
      const statuses = options.feedbackStatuses ?? [201];
      const status = statuses[Math.min(feedbackCounter++, statuses.length - 1)];
      return route.fulfill({ status, json: status === 201 ? { id: "feedback-1" } : { error: "feedback_save_failed" } });
    }
    return route.fulfill({ status: 404, json: { error: "not_found" } });
  });

  return { feedbackBodies, history };
}

async function generate(page: Page, question = "这款商品怎么保存？") {
  await page.getByRole("textbox", { name: "客户问题" }).fill(question);
  await page.getByRole("button", { name: "生成参考回复" }).click();
  await expect(page.getByText(`您好，理解您的疑问。关于“${question}”，请以审核知识为准。`)).toBeVisible();
}

test("generates a reference draft, adopts it, and retains server-backed history after refresh", async ({ page }) => {
  const mocked = await installApiMocks(page);
  await page.goto("/workbench");
  await expect(page.getByText("仅供客服参考，不会自动发送")).toBeVisible();
  await expect(page.getByText("依据与提醒")).toHaveCount(0);

  await generate(page);
  await page.getByRole("button", { name: "采纳并复制" }).click();
  await expect(page.getByText("已采纳并复制")).toBeVisible();
  expect(mocked.feedbackBodies).toEqual([{ draftRunId: expect.any(String), action: "adopted" }]);

  await page.reload();
  await expect(page.getByText("这款商品怎么保存？")).toBeVisible();
});

test("clipboard failure shows manual-copy guidance and never saves adoption", async ({ page }) => {
  const mocked = await installApiMocks(page, { clipboardFails: true });
  await page.goto("/workbench");
  await generate(page);
  await page.getByRole("button", { name: "采纳并复制" }).click();

  await expect(page.getByText("复制失败，请手动复制")).toBeVisible();
  expect(mocked.feedbackBodies).toHaveLength(0);
});

test("saved modification stays visible after clipboard rejection and retry-copy does not resubmit", async ({ page }) => {
  const mocked = await installApiMocks(page, { clipboardFails: true });
  await page.goto("/workbench");
  await generate(page);
  await page.getByRole("button", { name: "修改回复" }).click();
  const editor = page.getByRole("textbox", { name: "修改后的回复" });
  await editor.fill("客服已保存的最终回复");
  await page.getByRole("button", { name: "保存并复制" }).click();

  await expect(page.getByRole("alert")).toHaveText("复制失败，请手动复制");
  await expect(editor).toHaveValue("客服已保存的最终回复");
  await expect(page.getByRole("button", { name: "再次复制" })).toBeVisible();
  expect(mocked.feedbackBodies).toHaveLength(1);
});
test("feedback failure keeps the modification and allows retry", async ({ page }) => {
  const mocked = await installApiMocks(page, { feedbackStatuses: [500, 201] });
  await page.goto("/workbench");
  await generate(page);
  await page.getByRole("button", { name: "修改回复" }).click();
  const editor = page.getByRole("textbox", { name: "修改后的回复" });
  await expect(editor).toHaveValue(/您好，理解您的疑问/);
  await editor.fill("客服修改后的最终回复");

  await page.getByRole("button", { name: "保存并复制" }).click();
  await expect(page.getByText("反馈保存失败，请重试")).toBeVisible();
  await expect(editor).toHaveValue("客服修改后的最终回复");
  await page.getByRole("button", { name: "保存并复制" }).click();
  await expect(editor).toHaveCount(0);
  expect(mocked.feedbackBodies).toEqual([
    { draftRunId: expect.any(String), action: "modified", finalDraft: "客服修改后的最终回复" },
    { draftRunId: expect.any(String), action: "modified", finalDraft: "客服修改后的最终回复" },
  ]);
});

const reasons = [
  ["知识内容不正确", "knowledge_incorrect"],
  ["没有解决客户问题", "question_unresolved"],
  ["商品匹配错误", "wrong_product"],
  ["回复与问题无关", "irrelevant_answer"],
  ["语气或表达不合适", "tone_or_style"],
  ["需要实时信息", "dynamic_data_required"],
  ["其他原因", "other"],
] as const;

for (const [label, code] of reasons) {
  test(`saves discard reason ${code}`, async ({ page }) => {
    const mocked = await installApiMocks(page);
    await page.goto("/workbench");
    await generate(page, `测试弃用原因 ${label}`);
    await page.getByRole("button", { name: "弃用" }).click();
    const confirm = page.getByRole("button", { name: "确认" });
    await expect(confirm).toBeDisabled();
    await page.getByRole("radio", { name: label }).click();
    if (code === "other") {
      await expect(confirm).toBeDisabled();
      await page.getByRole("textbox", { name: "补充说明" }).fill("人工归类说明");
    }
    await confirm.click();
    await expect(page.getByText("已弃用")).toBeVisible();
    expect(mocked.feedbackBodies).toEqual([
      {
        draftRunId: expect.any(String),
        action: "discarded",
        discardReason: code,
        ...(code === "other" ? { discardNote: "人工归类说明" } : {}),
      },
    ]);
  });
}

test("submits modified feedback for two sequential draft ids", async ({ page }) => {
  const mocked = await installApiMocks(page);
  await page.goto("/workbench");
  for (const [question, finalDraft] of [["连续问题A", "客服最终稿A"], ["连续问题B", "客服最终稿B"]] as const) {
    await generate(page, question);
    await page.getByRole("button", { name: "修改回复" }).click();
    await page.getByRole("textbox", { name: "修改后的回复" }).fill(finalDraft);
    await page.getByRole("button", { name: "保存并复制" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
  expect(mocked.feedbackBodies).toEqual([
    { draftRunId: "10000000-0000-4000-8000-000000000001", action: "modified", finalDraft: "客服最终稿A" },
    { draftRunId: "10000000-0000-4000-8000-000000000002", action: "modified", finalDraft: "客服最终稿B" },
  ]);
});
test("logout clears the session and login restores access", async ({ page }) => {
  await installApiMocks(page);
  await page.goto("/workbench");
  await expect(page.getByText("客服：agent-01")).toBeVisible();
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page).toHaveURL(/\/login$/);

  await page.getByLabel("客服账号").fill("agent-01");
  await page.getByLabel("密码").fill("temporary-test-password");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/workbench$/);
});

test("refresh authentication sends an expired session to login", async ({ page }) => {
  await installApiMocks(page, { authenticated: false });
  await page.goto("/workbench");
  await expect(page).toHaveURL(/\/login$/);
});
