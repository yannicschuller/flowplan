import { test, expect, type APIRequestContext } from "@playwright/test";

// Idempotency keys (lib/idempotency.ts): a double submit – the same request
// with the same key, also at the same time – applies the change once.
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

async function setup(request: APIRequestContext, title: string) {
  await request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await request.get("/api/bootstrap")).json();
  const created = await request.post("/api/command", {
    headers: { origin },
    data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title },
  });
  expect(created.ok(), await created.text()).toBe(true);
  return (await created.json()) as { id: string };
}
const comments = async (request: APIRequestContext, pageId: string) =>
  ((await (await request.get(`/api/pages/${pageId}`)).json()).comments as { body: string }[]) || [];

test("the same comment sent twice at once with one key: one comment, the same answer twice", async ({ request }, testInfo) => {
  const page = await setup(request, `Idempotenz ${testInfo.project.name} ${Date.now()}`);
  const key = `e2e-${Date.now()}-${testInfo.project.name}`;
  const send = () =>
    request.post("/api/command", {
      headers: { origin, "Idempotency-Key": key },
      data: { action: "comment.create", pageId: page.id, body: "Nur einmal" },
    });
  const [a, b] = await Promise.all([send(), send()]);
  expect(a.status()).toBe(200);
  expect(b.status()).toBe(200);
  expect(await a.text()).toBe(await b.text());
  const replayed = [a, b].filter((r) => r.headers()["idempotent-replayed"] === "true");
  expect(replayed).toHaveLength(1);
  // Later with the same key: still the stored answer; another body: 422.
  const later = await send();
  expect(later.headers()["idempotent-replayed"]).toBe("true");
  const other = await request.post("/api/command", {
    headers: { origin, "Idempotency-Key": key },
    data: { action: "comment.create", pageId: page.id, body: "Anders" },
  });
  expect(other.status()).toBe(422);
  expect((await comments(request, page.id)).filter((c) => c.body === "Nur einmal")).toHaveLength(1);
});

test("double submit in the comment form posts the comment once", async ({ page }, testInfo) => {
  const created = await setup(page.request, `Doppelt ${testInfo.project.name} ${Date.now()}`);
  await page.goto(`/#page=${created.id}`);
  await page.getByRole("button", { name: /Kommentare/ }).first().click();
  const field = page.getByPlaceholder("Schreibe einen Kommentar …");
  await field.fill("Doppelklick");
  // Ctrl+Enter and the button right after each other, before the answer.
  await field.press("Control+Enter");
  await field.press("Control+Enter");
  await expect(field).toHaveValue("");
  await expect.poll(async () => (await comments(page.request, created.id)).filter((c) => c.body === "Doppelklick").length).toBe(1);
});
