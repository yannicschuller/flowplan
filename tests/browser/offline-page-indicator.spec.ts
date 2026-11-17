import { test, expect } from "@playwright/test";

// Issue #332: offline on an open page, the top bar showed the offline icon
// twice (the offline status and the save badge's own), and a red "Keine
// Verbindung" toast with "Erneut versuchen" came up while the page kept
// working offline – from opening a page whose kept copy was showing (its
// fresh copy could not be fetched). Offline is one indicator; a kept copy
// opens without a toast, edits are kept for later. A page without a copy
// still says that it cannot open.
const origin = () => process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const shots = process.env.OFFLINE_SHOTS;

test("offline on an open page: one indicator, no connection toast (#332)", async ({ page, context }, info) => {
  test.setTimeout(120_000);
  await page.request.post("/api/auth/demo", { headers: { origin: origin() } });
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin: origin() }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await command({ action: "profile.onboarded" });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const create = (title: string) =>
    command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `${title} ${info.project.name} ${Date.now()}` });
  const note = await create("Test note"),
    other = await create("Andere Seite"),
    unseen = await create("Nie geöffnet");
  // A page like the report's: a task and a paragraph.
  const read = async () => (await page.request.get(`/api/pages/${note.id}`)).json();
  const { htmlState } = await import("../../lib/document-server");
  const html = '<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Task 2</p></li></ul><p>Online geschrieben.</p>';
  await command({ action: "document.sync", pageId: note.id, generation: (await read()).generation, update: Buffer.from(htmlState(html)).toString("base64") });

  // Every error toast or alert that shows up, for the assertion below.
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __alerts: string[] }).__alerts = seen;
    new MutationObserver(() => {
      for (const el of document.querySelectorAll(".toast-error, .error-alert[role=alert]")) {
        const text = el.textContent || "";
        if (text && !seen.includes(text)) seen.push(text);
      }
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
  const alerts = () => page.evaluate(() => (window as unknown as { __alerts: string[] }).__alerts.filter((text) => /Keine Verbindung/.test(text)));
  const editor = page.locator(".page-content .ProseMirror").first();
  const go = (id: string) => page.evaluate((id) => (location.hash = `page=${id}`), id);
  // Both pages opened once online: this tab keeps a copy of each.
  await page.goto(`/#page=${other.id}`);
  await expect(page.locator("textarea.page-title")).toHaveValue(/^Andere Seite/, { timeout: 30_000 });
  await go(note.id);
  await expect(editor).toContainText("Task 2", { timeout: 30_000 });
  // At the end of the paragraph, with the keyboard (and on phones the
  // docked formatting bar) open.
  await editor.getByText("Online geschrieben.").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Weiter.");
  const topbar = page.locator(".topbar");
  const offlineIcon = topbar.locator(".offline-status-button");

  await context.setOffline(true);
  await expect(offlineIcon).toBeVisible();
  await page.keyboard.press("Enter");
  await page.keyboard.type("Offline weitergeschrieben.");
  // Over to the other page and back, from their kept copies.
  await go(other.id);
  await expect(page.locator("textarea.page-title")).toHaveValue(/^Andere Seite/);
  await page.goBack();
  await expect(editor).toContainText("Offline weitergeschrieben.");
  await editor.getByText("Offline weitergeschrieben.").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Noch mehr.");
  // Past the save delay, the 10 s refresh and the comments' 5 s check.
  await page.waitForTimeout(12_000);

  // Exactly one offline indicator in the top bar, on screen and for
  // screen readers alike.
  const visibleIcons = await topbar.locator("svg").evaluateAll(
    (icons) =>
      icons.filter((icon) => {
        const box = icon.getBoundingClientRect();
        for (let el: Element | null = icon; el; el = el.parentElement) {
          const s = getComputedStyle(el);
          if (s.display === "none" || s.visibility === "hidden" || s.clipPath === "inset(50%)" || Number(s.opacity) === 0) return false;
        }
        // Phosphor's WifiSlash (bold and regular weight).
        return box.width > 4 && box.height > 4 && /M216\.88,207\.93|M213\.92,210\.62/.test(icon.innerHTML);
      }).length,
  );
  expect(visibleIcons).toBe(1);
  await expect(offlineIcon).toBeVisible();
  await expect(topbar.getByRole("status").filter({ hasText: /^Offline$/ })).toHaveCount(1);
  await expect(editor).toContainText("Offline weitergeschrieben. Noch mehr.");
  expect(await alerts()).toEqual([]);
  await expect(page.locator(".toast-error")).toHaveCount(0);
  if (shots) await page.screenshot({ path: `${shots}/offline-page-indicator-${info.project.name}.png` });

  // A page this tab has no copy of cannot open offline: that is said.
  await go(unseen.id);
  await expect(page.locator(".toast-error")).toContainText("Keine Verbindung");
  await expect(page.locator(".toast-error").getByRole("button", { name: "Erneut versuchen" })).toBeVisible();
  await page.goBack();
  await expect(editor).toContainText("Offline weitergeschrieben. Noch mehr.");

  await context.setOffline(false);
  await expect(offlineIcon).toHaveCount(0, { timeout: 15_000 });
  // The text written offline reaches the server.
  await expect
    .poll(async () => ((await read()).html as string) || "", { timeout: 20_000 })
    .toContain("Offline weitergeschrieben. Noch mehr.");
});
