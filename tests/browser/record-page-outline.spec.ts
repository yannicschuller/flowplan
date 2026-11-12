import { test, expect, type Page, type Locator } from "@playwright/test";

// Issue #245: a record opened as a page of its own (#231) with the table of
// contents open. The list is fixed at the window's right edge; the record
// (bar with its actions, title, properties, text, sub-pages, comments) keeps
// out from under it at every window width, centred or at full width.

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const shots = process.env.ISSUE_245_SHOTS;

async function setup(page: Page) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await command({ action: "profile.onboarded" });
  const db = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Projekte ${Date.now()}`, kind: "database" });
  const row = await command({ action: "row.create", pageId: db.id, cells: { title: "Objektive packen" } });
  return { db, row };
}

async function right(locator: Locator) {
  const box = (await locator.boundingBox())!;
  return box.x + box.width;
}

test("the open table of contents never covers a record page", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "The list sits beside the text on wide screens only.");
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const { db, row } = await setup(page);
  await page.goto(`/#page=${db.id}&row=${row.id}&full=1`);
  const record = page.locator(".record-page");
  await expect(record).toBeVisible();
  const editor = record.locator(".ProseMirror").first();
  await editor.click();
  for (const text of ["Anfang", "Mitte", "Ende"]) {
    await page.keyboard.type(`# ${text}`);
    await page.keyboard.press("Enter");
    await page.keyboard.insertText("Ein langer Absatz, der über die ganze Breite des Eintrags läuft. ".repeat(6));
    await page.keyboard.press("Enter");
  }
  // A comment on the record, so its comments take room as well.
  const comment = record.getByPlaceholder("Kommentar schreiben …");
  await comment.fill("Bitte bis Freitag");
  await comment.press("Enter");
  await expect(comment).toHaveValue("");
  const toggle = record.locator(".outline-toggle");
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
  const outline = page.getByRole("navigation", { name: "Inhaltsverzeichnis" });
  await expect(outline).toBeVisible();
  const parts = {
    bar: record.locator(".record-page-bar"),
    title: record.locator(".row-title-input"),
    text: editor.locator("p").first(),
    comments: comment,
    record,
  };

  for (const wide of [false, true]) {
    if (wide) await record.getByRole("button", { name: "Volle Breite" }).click();
    await expect(record).toHaveClass(wide ? /record-page-wide/ : /^(?!.*record-page-wide)/);
    for (const width of [1280, 1440, 1600, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(outline).toBeVisible();
      // The layout follows the width (container queries, the outline's own
      // measurement) within a frame or two.
      await page.waitForTimeout(150);
      const list = (await outline.boundingBox())!;
      for (const [name, part] of Object.entries(parts))
        expect(await right(part), `${name} ends before the list (${width} px${wide ? ", full width" : ""})`).toBeLessThanOrEqual(list.x + 1);
      if (shots)
        for (const scheme of ["light", "dark"] as const) {
          await page.emulateMedia({ colorScheme: scheme });
          await page.evaluate((s) => document.documentElement.setAttribute("data-theme", s), scheme);
          await page.screenshot({ path: `${shots}/record-page-${width}${wide ? "-wide" : ""}-${scheme}.png` });
        }
    }
  }
});
