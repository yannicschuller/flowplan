import { test, expect } from "@playwright/test";

test("suggest changes, then accept and reject them", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const pageId = (
    await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Vorschläge ${info.project.name} ${Date.now()}`, kind: "document" })
  ).id;
  const { htmlState } = await import("../../lib/document-server");
  const generation = (await (await page.request.get(`/api/pages/${pageId}`)).json()).generation;
  await command({ action: "document.sync", pageId, generation, update: Buffer.from(htmlState("<p>Das Treffen ist am Montag.</p>")).toString("base64") });
  await page.goto(`/#page=${pageId}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor).toContainText("Das Treffen ist am Montag.");
  await page.getByRole("button", { name: "Vorschlagen" }).click();
  await expect(page.getByRole("button", { name: "Vorschlagen" })).toHaveAttribute("aria-pressed", "true");
  // Replace "Montag" by "Dienstag": delete with Backspace, then type.
  await editor.getByText("Das Treffen ist am Montag.").click();
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowLeft");
  for (let i = 0; i < 6; i++) await page.keyboard.press("Backspace");
  await page.keyboard.type("Dienstag");
  await expect(editor.locator(".suggestion-delete")).toHaveText("Montag");
  await expect(editor.locator(".suggestion-insert")).toHaveText("Dienstag");
  const bar = page.getByRole("region", { name: "Vorschläge" });
  await expect(bar).toContainText("2 Vorschläge");
  await bar.getByRole("button", { name: /Vorschläge/ }).click();
  await expect(bar.locator(".suggestion-item.delete")).toContainText("Montag");
  // Suggestions are saved with the document.
  await expect
    .poll(async () => (await (await page.request.get(`/api/pages/${pageId}`)).json()).html, { timeout: 10_000 })
    .toContain('data-suggestion="delete"');
  // Reject the insertion, accept the deletion... then accept all left.
  await bar.locator(".suggestion-item.insert").getByRole("button", { name: "Ablehnen" }).click();
  await expect(editor.locator(".suggestion-insert")).toHaveCount(0);
  await expect(editor).toContainText("am Montag.");
  // The deletion is still open: accepting it removes the old day.
  await bar.getByRole("button", { name: "Alle annehmen" }).click();
  await expect(editor).toContainText("Das Treffen ist am .");
  await expect(bar).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("changes of others arriving live are not turned into own suggestions", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Same on mobile.");
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const pageId = (
    await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Live-Vorschläge ${Date.now()}`, kind: "document" })
  ).id;
  const Y = await import("yjs");
  const { htmlState } = await import("../../lib/document-server");
  const first = await (await page.request.get(`/api/pages/${pageId}`)).json();
  await command({ action: "document.sync", pageId, generation: first.generation, update: Buffer.from(htmlState("<p>Erster Satz.</p>")).toString("base64") });
  await page.goto(`/#page=${pageId}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor).toContainText("Erster Satz.");
  await page.getByRole("button", { name: "Vorschlagen" }).click();
  // Someone else adds a paragraph (an incremental Yjs update on the stored state).
  const stored = await (await page.request.get(`/api/pages/${pageId}`)).json();
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Buffer.from(stored.state, "base64"));
  const before = Y.encodeStateVector(doc);
  const fragment = doc.getXmlFragment("default");
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.insert(0, [new Y.XmlText("Von jemand anderem.")]);
  fragment.insert(fragment.length, [paragraph]);
  await command({
    action: "document.sync",
    pageId,
    generation: stored.generation,
    update: Buffer.from(Y.encodeStateAsUpdate(doc, before)).toString("base64"),
  });
  await expect(editor).toContainText("Von jemand anderem.", { timeout: 10_000 });
  await page.waitForTimeout(1500);
  await expect(editor.locator(".suggestion-insert")).toHaveCount(0);
  const html = (await (await page.request.get(`/api/pages/${pageId}`)).json()).html;
  expect(html).not.toContain("data-suggestion");
});
