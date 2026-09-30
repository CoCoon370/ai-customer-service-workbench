import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { POST as legacyPost } from "@/app/api/[..._path]/route";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("does not proxy arbitrary browser requests to LangGraph", async () => {
  const fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);

  const response = await legacyPost(
    new Request("http://workbench.invalid/api/threads", {
      method: "POST",
      body: JSON.stringify({ message: "must not be sent" }),
    }),
  );

  expect(response.status).toBe(404);
  expect(fetchSpy).not.toHaveBeenCalled();
});

it("documents only server-side Task 5 configuration", async () => {
  const example = await readFile(resolve(".env.example"), "utf8");

  expect(example).toContain("DATABASE_URL=");
  expect(example).toContain("WORKBENCH_AGENT_TOKEN=");
  expect(example).not.toContain("NEXT_PUBLIC_");
  expect(example).not.toContain("LANGSMITH_API_KEY");
  expect(example).not.toContain("LANGGRAPH_API_URL");
});
it("keeps browser source free of public Agent configuration", async () => {
  const stream = await readFile(resolve("src/providers/Stream.tsx"), "utf8");
  const thread = await readFile(resolve("src/providers/Thread.tsx"), "utf8");

  expect(stream).not.toContain("NEXT_PUBLIC_");
  expect(thread).not.toContain("NEXT_PUBLIC_");
});
