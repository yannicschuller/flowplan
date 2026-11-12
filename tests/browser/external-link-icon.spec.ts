import { test, expect, type Page } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

// "Symbol bei externen Links" (#217, lib/external-link-icon-pref.ts): the
// arrow after links to the web, on by default. Off, a class on <html> hides
// it; the link keeps its colour and underline, and print shows the address
// in both cases, never the arrow. A test server may sign every test in as
// the same person, so the test puts the default back.
async function command(page: Page, data: Record<string, unknown>) {
  const r = await page.request.post("/api/command", { headers: { origin }, data });
  expect(r.ok(), await r.text()).toBe(true);
  return r.json();
}
const arrow = (page: Page) =>
  page
    .getByLabel("Dokumentinhalt", { exact: true })
    .getByText("Extern", { exact: true })
    .evaluate((el) => {
      const after = getComputedStyle(el, "::after"),
        own = getComputedStyle(el);
      return { content: after.content, display: after.display, mask: after.maskImage || after.webkitMaskImage, line: own.textDecorationLine, color: own.color };
    });

test.afterEach(async ({ page }) => {
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.externalLinkIcon", externalLinkIcon: true } });
});

test("the arrow after web links follows the setting; colour and underline stay; never printed", async ({ page }, info) => {
  const dir = process.env.FLOWPLAN_DATA_DIR;
  test.skip(!dir || dir === "./data", "Braucht einen eigenen Datenordner.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await command(page, { action: "profile.onboarded" });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const doc = await command(page, { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Links ${info.project.name}${Date.now()}` });
  const html = `<p>Mehr unter <a href="https://example.com/">Extern</a> im Web.</p>`;
  // Imported here, not at the top: see playwright.config.ts.
  const { htmlState } = await import("../../lib/document-server");
  const db = new DatabaseSync(join(dir!, "flowplan.sqlite"));
  db.prepare("UPDATE documents SET state=?,html=?,generation=? WHERE page_id=?").run(htmlState(html), html, crypto.randomUUID(), doc.id);
  db.close();

  // The default: the arrow.
  await page.goto(`/#page=${doc.id}`);
  await expect(page.getByLabel("Dokumentinhalt", { exact: true })).toContainText("Extern");
  const on = await arrow(page);
  expect(on.content).toBe('""');
  expect(on.mask).toContain("svg");
  expect(on.line).toBe("underline");
  await expect(page.locator("html")).not.toHaveClass(/hide-external-link-icon/);

  // Off in the settings: saved for the person, the arrow gone right away.
  await page.goto("/#settings/appearance");
  const toggle = page.getByRole("switch", { name: "Symbol bei externen Links" });
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(page.locator("html")).toHaveClass(/hide-external-link-icon/);
  await expect.poll(async () => (await (await page.request.get("/api/bootstrap")).json()).externalLinkIcon).toBe(false);

  // After a reload too; the link keeps its look otherwise.
  await page.goto(`/#page=${doc.id}`);
  await page.reload();
  await expect(page.getByLabel("Dokumentinhalt", { exact: true })).toContainText("Extern");
  await expect(page.locator("html")).toHaveClass(/hide-external-link-icon/);
  const off = await arrow(page);
  expect(off.content).toBe("none");
  expect(off.line).toBe("underline");
  expect(off.color).toBe(on.color);

  // Print: the address, not the arrow – with the setting off and on.
  await page.emulateMedia({ media: "print" });
  for (const state of [false, true]) {
    if (state) {
      await command(page, { action: "profile.externalLinkIcon", externalLinkIcon: true });
      await page.emulateMedia({ media: "screen" });
      await page.reload();
      await expect(page.getByLabel("Dokumentinhalt", { exact: true })).toContainText("Extern");
      await expect(page.locator("html")).not.toHaveClass(/hide-external-link-icon/);
      await page.emulateMedia({ media: "print" });
    }
    const printed = await arrow(page);
    expect(printed.content, `setting ${state}`).toContain("https://example.com/");
    expect(printed.mask === "none" || printed.mask === "" || printed.mask === undefined, `setting ${state}: ${printed.mask}`).toBe(true);
  }
  await page.emulateMedia({ media: "screen" });
  expect((await arrow(page)).content).toBe('""');
  expect(errors).toEqual([]);
  await command(page, { action: "page.delete", pageId: doc.id });
});
