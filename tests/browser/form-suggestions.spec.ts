import { test, expect, type Page } from "@playwright/test";

// Earlier answers as suggestions in forms (#374): the switch in the form
// designer (off for anonymous forms, with the hint) and the list while
// typing on the form page – arrow keys, Enter, Escape and a tap.
const shots = process.env.FORM374_SHOTS || "";

test("a text question suggests earlier answers while typing", async ({ page }, info) => {
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
  const db = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Einkauf ${info.project.name} ${Date.now()}`, kind: "database" });
  const read = async () => (await page.request.get(`/api/pages/${db.id}`)).json();
  const first = await read();
  await command({
    action: "database.update",
    pageId: db.id,
    version: first.database.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "item", name: "Artikel", type: "text" },
    ],
    views: first.database.views,
  });
  for (const item of ["Buntstifte", "Buntstifte", "Bunte Wolle", "Kleber"]) await command({ action: "row.create", pageId: db.id, cells: { title: "Kim", item } });

  // An anonymous form: the switch is off and says why.
  await command({ action: "form.update", pageId: db.id, enabled: true, internal: true, anonymous: true });
  await page.goto(`/#page=${db.id}`);
  await page.getByRole("button", { name: /^Weitere Ansichten/ }).click();
  await page.getByRole("menuitem", { name: "Formular" }).click();
  const openDesigner = async () => {
    await page.getByRole("button", { name: "Formular gestalten", exact: true }).click();
    return page.getByRole("dialog", { name: "Formular gestalten" });
  };
  const anonymous = page.getByRole("checkbox", { name: "Anonyme Antworten" });
  await expect(anonymous).toBeChecked();
  let design = await openDesigner();
  await expect(design.getByRole("checkbox", { name: "Frühere Antworten für Artikel vorschlagen" })).toBeDisabled();
  await expect(design.getByText(/Nur in Formularen „Nur für Mitglieder“ ohne anonyme Antworten/).first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(design).toBeHidden();

  // Members only, with names: switched on, all answers.
  await anonymous.uncheck();
  await expect(anonymous).not.toBeChecked();
  design = await openDesigner();
  const toggle = design.getByRole("checkbox", { name: "Frühere Antworten für Artikel vorschlagen" });
  await expect(toggle).toBeEnabled();
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await design.getByLabel("Vorschläge für Artikel aus").selectOption("all");
  await expect(design.getByText(/bis zu acht frühere Antworten/).first()).toBeVisible();
  const shoot = async (target: Page, name: string) => {
    if (!shots) return;
    for (const scheme of ["light", "dark"] as const) {
      await target.emulateMedia({ colorScheme: scheme });
      await target.screenshot({ path: `${shots}/form374-${name}-${info.project.name}-${scheme}.png` });
    }
    await target.emulateMedia({ colorScheme: "light" });
  };
  await design.getByText(/bis zu acht frühere Antworten/).first().scrollIntoViewIfNeeded();
  await shoot(page, "editor");
  await design.getByRole("button", { name: "Formular speichern", exact: true }).click();
  await expect(design).toBeHidden();
  expect((await read()).form.config.suggestions).toEqual({ item: "all" });

  // The form page: two letters bring the list.
  await page.goto(`/forms/${(await read()).form.token}`);
  const field = page.getByRole("combobox", { name: "Artikel" });
  await expect(field).toHaveAttribute("aria-autocomplete", "list");
  await field.click();
  await field.pressSequentially("Bu");
  const list = page.getByRole("listbox", { name: "Vorschläge für Artikel" });
  await expect(list.getByRole("option")).toHaveText(["Buntstifte", "Bunte Wolle"]);
  await expect(field).toHaveAttribute("aria-expanded", "true");
  await shoot(page, "typing");
  // Arrow keys and Enter take one, without sending the form.
  await field.press("ArrowDown");
  await field.press("ArrowDown");
  await expect(list.getByRole("option", { name: "Bunte Wolle" })).toHaveAttribute("aria-selected", "true");
  await field.press("Enter");
  await expect(field).toHaveValue("Bunte Wolle");
  await expect(list).toBeHidden();
  await expect(page.getByRole("button", { name: "Antwort senden" })).toBeVisible();
  // Escape closes the list.
  await field.fill("");
  await field.pressSequentially("Kle");
  await expect(list.getByRole("option")).toHaveText(["Kleber"]);
  await field.press("Escape");
  await expect(list).toBeHidden();
  await expect(field).toHaveValue("Kle");
  // A tap (or click) picks.
  await field.fill("");
  await field.pressSequentially("bunt");
  const option = list.getByRole("option", { name: "Buntstifte" });
  if (info.project.name === "mobile") await option.tap();
  else await option.click();
  await expect(field).toHaveValue("Buntstifte");
  await expect(field).toBeFocused();
  // The other text question keeps the browser's own history.
  const name = page.getByRole("textbox", { name: "Name" });
  await expect(name).toHaveAttribute("autocomplete", "on");
  await expect(name).toHaveAttribute("name", "flowplan-question-title");
  await name.fill("Kim");
  await page.getByRole("button", { name: "Antwort senden" }).click();
  await expect(page.getByRole("heading", { name: "Vielen Dank!" })).toBeVisible();
  expect((await read()).rows.some((r: { cells: Record<string, unknown> }) => r.cells.item === "Buntstifte" && r.cells.title === "Kim")).toBe(true);
  expect(errors).toEqual([]);
});
