import { test, expect, type Page } from "@playwright/test";

// Suggestions in the form designer (#385): why earlier answers are off,
// next to the switch, with the button that makes the form members-only;
// and a fixed list of suggestions that a public form offers while typing.
const shots = process.env.FORM385_SHOTS || "";

test("the designer explains the members-only rule and a public form suggests the fixed list", async ({ page, browser }, info) => {
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
  await command({ action: "profile.onboarded" });
  const db = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Anmeldung ${info.project.name} ${Date.now()}`, kind: "database" });
  const read = async () => (await page.request.get(`/api/pages/${db.id}`)).json();
  const first = await read();
  await command({
    action: "database.update",
    pageId: db.id,
    version: first.database.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "city", name: "Ort", type: "text" },
    ],
    views: first.database.views,
  });
  const shoot = async (target: Page, name: string) => {
    if (!shots) return;
    for (const scheme of ["light", "dark"] as const) {
      await target.emulateMedia({ colorScheme: scheme });
      await target.screenshot({ path: `${shots}/form385-${name}-${info.project.name}-${scheme}.png` });
    }
    await target.emulateMedia({ colorScheme: "light" });
  };

  // An anonymous form: the switch is off, the reason stands next to it.
  await command({ action: "form.update", pageId: db.id, enabled: true, internal: true, anonymous: true });
  await page.goto(`/#page=${db.id}`);
  await page.getByRole("button", { name: /^Weitere Ansichten/ }).click();
  await page.getByRole("menuitem", { name: "Formular" }).click();
  await page.getByRole("button", { name: "Formular gestalten", exact: true }).click();
  const design = page.getByRole("dialog", { name: "Formular gestalten" });
  const toggle = design.getByRole("checkbox", { name: "Frühere Antworten für Ort vorschlagen" });
  await expect(toggle).toBeDisabled();
  await expect(toggle).toHaveAccessibleDescription(/nur in Formularen „Nur für Mitglieder“ ohne anonyme Antworten/);
  // One notice above the questions, not one per question.
  const switchButton = design.getByRole("button", { name: "Auf „Nur für Mitglieder“ umstellen" });
  await expect(switchButton).toHaveCount(1);
  await expect(switchButton).toBeVisible();
  await switchButton.scrollIntoViewIfNeeded();
  await shoot(page, "designer-locked");

  // One click: members only, no anonymous answers – the switch can be used.
  await switchButton.click();
  await expect(toggle).toBeEnabled();
  // The focus lands on the first switch that can now be used ("Name").
  await expect(design.getByRole("checkbox", { name: "Frühere Antworten für Name vorschlagen" })).toBeFocused();
  await expect(design.getByRole("button", { name: "Auf „Nur für Mitglieder“ umstellen" })).toHaveCount(0);
  const settings = await read();
  expect(settings.form.internal).toBe(1);
  expect(settings.form.anonymous).toBe(0);

  // A fixed list for "Ort", one entry per line (trimmed, without duplicates).
  await design.getByRole("button", { name: "Feste Vorschläge für Ort eingeben" }).click();
  const lines = design.getByRole("textbox", { name: "Feste Vorschläge für Ort" });
  await lines.fill("Hamburg\n  Hannover \nhamburg\n\nBad Homburg\nKiel");
  await expect(design.getByText(/4 von 200/)).toBeVisible();
  await lines.scrollIntoViewIfNeeded();
  await shoot(page, "designer-list");
  await design.getByRole("button", { name: "Formular speichern", exact: true }).click();
  await expect(design).toBeHidden();
  expect((await read()).form.config.suggestionLists).toEqual({ city: ["Hamburg", "Hannover", "Bad Homburg", "Kiel"] });

  // Public and anonymous: a visitor without an account gets the fixed list.
  await command({ action: "form.update", pageId: db.id, internal: false, anonymous: true });
  const token = (await read()).form.token;
  const visitor = await browser.newContext({ locale: "de-DE", ...(info.project.name === "mobile" ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : {}) });
  const form = await visitor.newPage();
  form.on("pageerror", (e) => errors.push(e.message));
  await form.goto(`${origin}/forms/${token}`);
  const field = form.getByRole("combobox", { name: "Ort" });
  await expect(field).toHaveAttribute("aria-autocomplete", "list");
  const list = form.getByRole("listbox", { name: "Vorschläge für Ort" });
  // From the first letter: those starting with it first.
  await field.click();
  await field.pressSequentially("h");
  await expect(list.getByRole("option")).toHaveText(["Hamburg", "Hannover", "Bad Homburg"]);
  await field.pressSequentially("om");
  await expect(list.getByRole("option")).toHaveText(["Bad Homburg"]);
  await shoot(form, "public-typing");
  await field.press("ArrowDown");
  await field.press("Enter");
  await expect(field).toHaveValue("Bad Homburg");
  await expect(list).toBeHidden();
  // ArrowDown in an empty field shows the list.
  await field.fill("");
  await field.press("ArrowDown");
  await expect(list.getByRole("option")).toHaveText(["Hamburg", "Hannover", "Bad Homburg", "Kiel"]);
  await expect(list.getByRole("option", { name: "Hamburg" })).toHaveAttribute("aria-selected", "true");
  await field.press("Escape");
  await expect(list).toBeHidden();
  await field.pressSequentially("ki");
  const option = list.getByRole("option", { name: "Kiel" });
  if (info.project.name === "mobile") await option.tap();
  else await option.click();
  await expect(field).toHaveValue("Kiel");
  // No request for earlier answers from a public form.
  const asked: string[] = [];
  form.on("request", (r) => r.url().includes("/suggestions") && asked.push(r.url()));
  await field.fill("");
  await field.pressSequentially("Ha");
  await expect(list.getByRole("option")).toHaveText(["Hamburg", "Hannover"]);
  await form.waitForTimeout(400);
  expect(asked).toEqual([]);
  await field.fill("Kiel");
  await form.getByRole("textbox", { name: "Name" }).fill("Kim");
  await form.getByRole("button", { name: "Antwort senden" }).click();
  await expect(form.getByRole("heading", { name: "Vielen Dank!" })).toBeVisible();
  await visitor.close();
  expect((await read()).rows.some((r: { cells: Record<string, unknown> }) => r.cells.city === "Kiel" && r.cells.title === "Kim")).toBe(true);
  expect(errors).toEqual([]);
});
