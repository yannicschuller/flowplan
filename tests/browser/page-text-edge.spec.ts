import { test, expect, type Page } from "@playwright/test";

// One left edge for a document page (#603): the page icon, the title, the
// properties and the formatting toolbar start where the text starts – the
// block handles keep their room left of it, in the page's margin. At the
// usual width, at full width, on a phone and in reading mode (no handles,
// no room kept).
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

async function fixture(page: Page, title: string) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await command({ action: "profile.onboarded" });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const host = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, kind: "document", title });
  const { htmlState } = await import("../../lib/document-server");
  await command({
    action: "document.sync",
    pageId: host.id,
    generation: (await (await page.request.get(`/api/pages/${host.id}`)).json()).generation,
    update: Buffer.from(htmlState("<h2>Alpha</h2><p>Bravo</p><p>Charlie</p>")).toString("base64"),
  });
  return { id: host.id as string, command };
}

// The left edges of the page's parts, rounded to whole pixels.
function edges(page: Page) {
  return page.evaluate(() => {
    const left = (selector: string) => {
      const el = document.querySelector(`.split-primary .page-content ${selector}`);
      return el ? Math.round(el.getBoundingClientRect().left) : null;
    };
    return {
      text: left(".ProseMirror > p"),
      icon: left(".large-page-icon"),
      title: left(".page-title"),
      properties: left(".page-properties"),
      toolbar: (() => {
        const bar = document.querySelector<HTMLElement>(".split-primary .page-content .editor-toolbar");
        // A phone's toolbar is a bar at the screen's bottom edge.
        return bar && getComputedStyle(bar).position !== "fixed" ? Math.round(bar.getBoundingClientRect().left) : null;
      })(),
    };
  });
}

function expectAligned(found: Record<string, number | null>, label: string) {
  const { text, ...rest } = found;
  expect(text, `${label}: text`).not.toBeNull();
  for (const [part, left] of Object.entries(rest)) if (left !== null) expect(left, `${label}: ${part}`).toBe(text);
}

test("the page's head starts where its text starts", async ({ page }, info) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const f = await fixture(page, `Kante ${Date.now()}`);
  await page.goto(`/#page=${f.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor.locator(":scope > p", { hasText: "Charlie" })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".split-primary .block-editor-surface.with-block-handles")).toBeVisible();
  const usual = await edges(page);
  expectAligned(usual, "usual width");
  // The handles keep their room: the text is not at the column's edge.
  const column = await page.locator(".split-primary .page-content").evaluate((el) => {
    const r = el.getBoundingClientRect();
    return Math.round(r.left + parseFloat(getComputedStyle(el).paddingLeft));
  });
  expect(usual.text! - column).toBeGreaterThanOrEqual(20);

  if (info.project.name === "desktop") {
    // Full width.
    await f.command({ action: "page.update", pageId: f.id, patch: { full_width: true } });
    await page.reload();
    await expect(page.locator(".split-primary .page-content.full-width")).toBeVisible({ timeout: 30_000 });
    await expect(editor.locator(":scope > p", { hasText: "Charlie" })).toBeVisible({ timeout: 30_000 });
    expectAligned(await edges(page), "full width");

    // Reading mode: no handles, the text at the column's edge – and the head with it.
    await page.getByRole("button", { name: "Lesemodus", exact: true }).click();
    await expect(page.locator(".split-primary .block-editor-surface.with-block-handles")).toHaveCount(0);
    const reading = await edges(page);
    expectAligned(reading, "reading mode");
    await page.getByRole("button", { name: "Bearbeiten", exact: true }).click();
  }
  expect(errors).toEqual([]);
  await page.goto("/#home");
  await f.command({ action: "page.delete", pageId: f.id });
});
