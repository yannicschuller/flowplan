import { test, expect } from "@playwright/test";

test("react to a comment and to a paragraph", async ({ page }, info) => {
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
    await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Reaktionen ${info.project.name} ${Date.now()}`, kind: "document" })
  ).id;
  await command({ action: "comment.create", pageId, body: "Sieht gut aus" });
  await page.goto(`/#page=${pageId}`);

  // A paragraph: write, then react via the smiley at its end.
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await editor.click();
  await page.keyboard.type("Wir starten im Oktober");
  await editor.getByRole("button", { name: "Auf Block reagieren" }).click();
  await editor.getByRole("button", { name: "Mit 🎉 reagieren" }).click();
  const pill = editor.locator(".block-reaction", { hasText: "🎉 1" });
  await expect(pill).toBeVisible();
  await expect(pill).toHaveClass(/mine/);
  await expect
    .poll(async () => (await (await page.request.get(`/api/pages/${pageId}`)).json()).html, { timeout: 10_000 })
    .toContain("data-reactions");
  // Clicking the own reaction takes it back.
  await pill.click();
  await expect(editor.locator(".block-reaction")).toHaveCount(0);

  // The comment.
  await page.getByRole("button", { name: "Kommentare" }).first().click();
  const comment = page.locator(".comment", { hasText: "Sieht gut aus" });
  await comment.getByRole("button", { name: "Reaktion hinzufügen" }).click();
  await comment.getByRole("button", { name: "Mit 👍 reagieren" }).click();
  await expect(comment.getByRole("button", { name: "👍 1 Reaktion" })).toHaveAttribute("aria-pressed", "true");
  await comment.getByRole("button", { name: "👍 1 Reaktion" }).click();
  await expect(comment.locator(".reaction-button")).toHaveCount(0);
  expect(errors).toEqual([]);
});
