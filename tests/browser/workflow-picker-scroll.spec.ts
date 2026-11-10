import { test, expect } from "@playwright/test";

// #182: picking a placeholder took the workflow builder down in the desktop
// app (Electron 45, Chrome 156) – newer Chromium returns a Promise from
// scrollIntoView/scrollTo/scrollBy, and the picker's effect returned that
// Promise, which React called as its cleanup when the picker closed ("i is
// not a function"). Playwright's Chromium may still return undefined, so the
// page gets the newer behaviour here.

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

test("a placeholder picked with the mouse while scroll methods return a Promise", async ({ page, context }, info) => {
  test.skip(info.project.name !== "desktop", "Editing is for tablets and computers.");
  await context.addInitScript(() => {
    for (const name of ["scrollIntoView", "scrollTo", "scrollBy"] as const) {
      const own = Element.prototype[name] as (...args: unknown[]) => void;
      (Element.prototype as unknown as Record<string, unknown>)[name] = function (this: Element, ...args: unknown[]) {
        own.apply(this, args);
        return Promise.resolve();
      };
    }
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const where = { workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id };
  const workflow = (await command({ action: "page.create", ...where, title: "Platzhalter 182", kind: "workflow" })).id as string;
  await page.goto(`/#page=${workflow}`);
  expect(await page.evaluate(() => (document.body.scrollIntoView({ block: "nearest" }) as unknown) instanceof Promise)).toBe(true);
  const welcome = page.getByRole("dialog", { name: "Willkommen bei Flowplan" });
  await welcome.waitFor({ timeout: 3000 }).then(() => page.keyboard.press("Escape"), () => {});

  await page.getByRole("button", { name: "Leer beginnen" }).click();
  const add = page.getByRole("dialog", { name: "Knoten hinzufügen" });
  await add.getByRole("combobox", { name: "Knoten suchen" }).fill("Neue Seite");
  await add.getByRole("combobox", { name: "Knoten suchen" }).press("Enter");
  await page.locator(".wf-side").getByRole("option", { name: "KI: Eigene Anweisung" }).click();
  const panel = page.locator(".wf-panel");
  await expect(panel.getByRole("heading", { name: "KI: Eigene Anweisung" })).toBeVisible();

  // The issue's steps: the {} button, then a click on a variable.
  const insert = panel.getByRole("button", { name: /Platzhalter einfügen in/ }).first();
  await insert.click();
  const picker = panel.getByRole("dialog", { name: "Platzhalter wählen" });
  await picker.getByRole("combobox", { name: "Platzhalter suchen" }).press("ArrowDown");
  await picker.getByRole("option").filter({ hasText: "Titel" }).first().click();
  await expect(picker).toBeHidden();
  await expect(panel.getByRole("heading", { name: "KI: Eigene Anweisung" })).toBeVisible();
  // Inserted, in the display form.
  await expect
    .poll(() => panel.locator(".wf-template textarea, .wf-template input").evaluateAll((fields) => fields.map((f) => (f as HTMLInputElement).value).join("\n")))
    .toContain("{{Neue Seite.");
  await expect(panel.getByRole("alert")).toHaveCount(0);
  expect(errors).toEqual([]);
});
