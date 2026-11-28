import { test, expect, type Page } from "@playwright/test";

// Sections of a record's properties (#646): with "Layout anpassen" open an
// editor adds a section, moves properties into it (the move dialog, Alt +
// arrow keys, dragging on desktop), folds it (remembered in this browser)
// and deletes it again – its properties come back to the top.
test("record properties are grouped in sections that fold and go away again", async ({ page }, info) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "Needs the test server data directory.");
  test.setTimeout(120_000);
  const mobile = info.project.name === "mobile";
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const read = async () => (await page.request.get(`/api/pages/${db.id}`)).json();
  const db = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `Abschnitte ${info.project.name} ${Date.now()}`,
    kind: "database",
  });
  await command({
    action: "database.update",
    pageId: db.id,
    version: (await read()).database.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "status", name: "Status", type: "select", options: ["Offen", "Erledigt"] },
      { id: "note", name: "Notiz", type: "text" },
      { id: "phone", name: "Telefon", type: "text" },
      { id: "mail", name: "E-Mail", type: "text" },
    ],
    views: [{ id: "table", name: "Tabelle", type: "table", filters: [], sorts: [] }],
  });
  const row = await command({ action: "row.create", pageId: db.id, cells: { title: "Kundin", status: "Offen", note: "Rückruf", phone: "0301234", mail: "k@example.invalid" } });

  const names = ["Status", "Notiz", "Telefon", "E-Mail"];
  // The properties of the top group and of each section, as shown.
  const arrangement = async (p: Page) =>
    p.locator(".row-properties").first().evaluate((root, names) => {
      const labels = (els: Element[]) => els.map((el) => el.textContent?.trim() || "").filter((n) => names.includes(n));
      const all = [...root.querySelectorAll(".row-property > span:first-child")];
      return {
        top: labels(all.filter((el) => !el.closest(".record-section"))),
        sections: [...root.querySelectorAll(".record-section")].map((s) => ({
          name: s.querySelector(".record-section-name")?.textContent?.trim() || "",
          fields: labels([...s.querySelectorAll(".row-property > span:first-child")]),
        })),
      };
    }, names);
  const open = async () => {
    await page.goto("about:blank");
    await page.goto(`/#page=${db.id}&row=${row.id}`);
    const entry = page.getByRole("dialog", { name: "Eintrag", exact: true });
    await expect(entry.locator(".row-properties")).toContainText("E-Mail", { timeout: 30_000 });
    return entry;
  };
  let entry = await open();
  await expect.poll(() => arrangement(page)).toEqual({ top: names, sections: [] });
  // Without the layout settings open: no "+ Abschnitt".
  await expect(entry.getByRole("button", { name: "Abschnitt", exact: true })).toHaveCount(0);

  // Add a section.
  await entry.getByRole("button", { name: "Layout anpassen" }).first().click();
  await entry.getByRole("button", { name: "Abschnitt", exact: true }).click();
  await entry.getByRole("textbox", { name: "Name des neuen Abschnitts" }).fill("Kontakt");
  await page.keyboard.press("Enter");
  await expect(entry.locator(".record-section-name")).toHaveText("Kontakt");
  await expect(entry.locator(".record-section-empty")).toBeVisible();
  await expect.poll(() => arrangement(page)).toEqual({ top: names, sections: [{ name: "Kontakt", fields: [] }] });

  // The move dialog: "In Abschnitt verschieben".
  await entry.getByRole("button", { name: "„E-Mail“ verschieben" }).click();
  const move = page.getByRole("dialog", { name: "Eigenschaft verschieben" });
  await move.getByLabel("In Abschnitt verschieben").selectOption({ label: "Kontakt" });
  await expect(move).toContainText("„E-Mail“ ist an Position 1 von 1 im Abschnitt „Kontakt“.");
  await page.keyboard.press("Escape");
  await expect(move).toBeHidden();
  await expect.poll(() => arrangement(page)).toEqual({ top: ["Status", "Notiz", "Telefon"], sections: [{ name: "Kontakt", fields: ["E-Mail"] }] });

  // The keyboard: Alt + arrow down at the end of the top group enters the
  // section at its start.
  await entry.getByRole("button", { name: "„Telefon“ verschieben" }).focus();
  await page.keyboard.press("Alt+ArrowDown");
  await expect.poll(() => arrangement(page)).toEqual({ top: ["Status", "Notiz"], sections: [{ name: "Kontakt", fields: ["Telefon", "E-Mail"] }] });
  await expect(entry.getByRole("button", { name: "„Telefon“ verschieben" })).toBeFocused();

  // Dragging (desktop): Notiz onto the lower half of the section's heading,
  // the start of the section.
  if (!mobile) {
    const heading = entry.locator('.record-section[data-section] .record-section-heading');
    const box = (await heading.boundingBox())!;
    await entry.getByRole("button", { name: "„Notiz“ verschieben" }).dragTo(heading, { targetPosition: { x: 40, y: box.height - 4 } });
    await expect.poll(() => arrangement(page)).toEqual({ top: ["Status"], sections: [{ name: "Kontakt", fields: ["Notiz", "Telefon", "E-Mail"] }] });
  }
  const inSection = mobile ? ["Telefon", "E-Mail"] : ["Notiz", "Telefon", "E-Mail"];
  const ids: Record<string, string> = { Status: "status", Notiz: "note", Telefon: "phone", "E-Mail": "mail" };
  await expect
    .poll(async () => (await read()).database.recordLayout.sections?.map((s: { name: string; fields: string[] }) => [s.name, s.fields]))
    .toEqual([["Kontakt", inSection.map((n) => ids[n])]]);

  // Fold the section: kept after reloading (this browser).
  await entry.getByRole("button", { name: "Layout anpassen" }).first().click();
  const toggle = entry.getByRole("button", { name: /^Kontakt/ });
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(entry.locator(".record-section-body")).toBeHidden();
  await expect(entry.locator(".record-section-count")).toHaveText(String(inSection.length));
  entry = await open();
  await expect(entry.getByRole("button", { name: /^Kontakt/ })).toHaveAttribute("aria-expanded", "false");
  await expect(entry.locator(".record-section-body")).toBeHidden();
  await entry.getByRole("button", { name: /^Kontakt/ }).click();
  await expect(entry.locator(".record-section-body")).toBeVisible();
  await expect.poll(() => arrangement(page)).toEqual({ top: names.filter((n) => !inSection.includes(n)), sections: [{ name: "Kontakt", fields: inSection }] });

  // Rename, then delete: its properties come back to the top.
  await entry.getByRole("button", { name: "Layout anpassen" }).first().click();
  await entry.getByRole("button", { name: "Abschnitt „Kontakt“ umbenennen" }).click();
  await entry.getByRole("textbox", { name: "Name des Abschnitts" }).fill("Erreichbarkeit");
  await page.keyboard.press("Enter");
  await expect(entry.locator(".record-section-name")).toHaveText("Erreichbarkeit");
  await entry.getByRole("button", { name: "Abschnitt „Erreichbarkeit“ löschen" }).click();
  await expect(entry.locator(".record-section")).toHaveCount(0);
  const back = [...names.filter((n) => !inSection.includes(n)), ...inSection];
  await expect.poll(() => arrangement(page)).toEqual({ top: back, sections: [] });
  await expect.poll(async () => (await read()).database.recordLayout.sections).toBeUndefined();
  entry = await open();
  await expect.poll(() => arrangement(page)).toEqual({ top: back, sections: [] });
  expect(errors).toEqual([]);
});
