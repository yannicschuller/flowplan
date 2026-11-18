import { test, expect, type Page } from "@playwright/test";

// Flashcards phase 3b (docs/specs/flashcards.md §8.1, §8.2): an Anki package
// generated in the test (tests/helpers/anki-fixture.ts) imported through the
// wizard on #study – preview of decks, note types and fields, a field's
// side changed, the learning state taken over – and the deck exported
// again as an .apkg download. STUDY_SCREENSHOTS=<dir> keeps pictures of the
// wizard (light and dark).
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const shots = process.env.STUDY_SCREENSHOTS || "";

async function signedIn(page: Page) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  return { boot };
}
async function shot(page: Page, name: string, project: string, prefix = "fc3") {
  if (!shots) return;
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${shots}/${prefix}-${name}-${project === "mobile" ? 390 : 1440}-${scheme}.png` });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

test("an Anki package through the wizard, and back out as .apkg", async ({ page }, info) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await signedIn(page);
  const { ankiPackage, sampleFixture } = await import("../helpers/anki-fixture");
  const fixture = sampleFixture();
  // Deck names of their own: the demo account is shared by the specs.
  const suffix = `${info.project.name} ${Date.now()}`;
  fixture.decks = fixture.decks.map((d) => (d.id === 1 ? d : { ...d, name: d.name.replace(/^(Spanisch|Biologie)/, `$1 ${suffix}`) }));
  const bytes = await ankiPackage(fixture);

  await page.goto("/#study");
  await page.getByRole("button", { name: "Aus Anki importieren" }).click();
  const wizard = page.getByRole("dialog", { name: "Aus Anki importieren" });
  await wizard.getByLabel("Anki-Datei").setInputFiles({ name: "Sprachen.apkg", mimeType: "application/octet-stream", buffer: bytes });
  // The preview: decks with their sub-decks, note types with their fields.
  await expect(wizard.locator(".study-anki-decks")).toContainText(`Spanisch ${suffix}`, { timeout: 60_000 });
  await expect(wizard.locator(".study-anki-decks")).toContainText("Unterstapel: Lektion 1");
  const vocab = wizard.locator(".study-anki-notetype").filter({ hasText: "Vokabel" });
  await expect(vocab.getByLabel("Ziel für Wort")).toHaveValue("front");
  await expect(vocab.getByLabel("Ziel für Eselsbrücke")).toHaveValue("hint");
  await expect(vocab.locator(".study-anki-sample")).toContainText("la casa → das Haus");
  // The example stays out.
  await vocab.getByLabel("Ziel für Beispiel").selectOption("skip");
  await expect(wizard.locator(".study-import-errors")).toContainText("Rückwärtskarte");
  // Image occlusion comes with its masks (phase 6).
  await expect(wizard.locator(".study-anki-notetype").filter({ hasText: "Image Occlusion" }).getByLabel("Kartentyp für Image Occlusion")).toHaveValue("occlusion");
  // Clozes preview as gaps, not as Anki's syntax; no reverse card for them;
  // one note is "1 Notiz".
  const cloze = wizard.locator(".study-anki-notetype").filter({ has: page.getByLabel("Kartentyp für Cloze", { exact: true }) });
  await expect(cloze.locator(".study-anki-sample")).toContainText("Die […] sind die [Bild] der Zelle.");
  await expect(cloze.locator(".study-anki-sample")).not.toContainText("{{c1::");
  await expect(cloze.getByRole("checkbox", { name: "Auch umgekehrt abfragen" })).toHaveCount(0);
  await expect(cloze.locator("legend")).toContainText("1 Notiz)");
  const occlusion = wizard.locator(".study-anki-notetype").filter({ hasText: "Image Occlusion" });
  await expect(occlusion).toContainText("Maske 1");
  await expect(occlusion).not.toContainText("image-occlusion:");
  await shot(page, "anki-wizard", info.project.name);
  await wizard.getByRole("checkbox", { name: /Meinen Lernstand übernehmen/ }).check();
  await wizard.getByRole("button", { name: "8 Notizen in 2 Stapel importieren" }).click();
  await expect(wizard.locator(".study-anki-done")).toContainText("8 Notizen in 2 Stapeln importiert", { timeout: 60_000 });
  await expect(wizard.locator(".study-anki-done")).toContainText("Wiederholungen als dein Lernstand übernommen");
  await wizard.getByRole("button", { name: "Stapel öffnen" }).click();

  // The first deck opens in its study view with the imported cards.
  await expect(page.locator(".study-deck")).toContainText(/\d+ Karten/, { timeout: 30_000 });
  await page.locator(".study-deck").getByRole("button", { name: /^Exportieren/ }).click();
  const downloading = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Als Anki-Paket (.apkg, ohne Lernstand)" }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/\.apkg$/);
  const { readFileSync } = await import("node:fs");
  const file = readFileSync((await download.path())!);
  expect(file.subarray(0, 2).toString()).toBe("PK");
  expect(file.includes(Buffer.from("collection.anki2"))).toBe(true);
  expect(errors).toEqual([]);
});

// #341: sub-decks as databases of their own, chosen in the wizard; a
// suspended card that was never studied stays suspended.
test("sub-decks as databases of their own, nested below the top-level deck", async ({ page }, info) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await signedIn(page);
  const { ankiPackage, sampleFixture, BASIC } = await import("../helpers/anki-fixture");
  const top = `Sprachen ${info.project.name} ${Date.now()}`;
  const bytes = await ankiPackage({
    ...sampleFixture(),
    decks: [
      { id: 1, name: "Default" },
      { id: 10, name: top },
      { id: 11, name: `${top}::Spanisch` },
      { id: 12, name: `${top}::Spanisch::Lektion 1` },
    ],
    notes: [
      { id: 1, mid: BASIC.id, fields: ["hola", "hallo"], deck: 11, cards: [{ ord: 0, id: 101 }] },
      { id: 2, mid: BASIC.id, fields: ["perro", "Hund"], deck: 12, cards: [{ ord: 0, id: 201 }] },
      { id: 3, mid: BASIC.id, fields: ["gato", "Katze"], deck: 12, cards: [{ ord: 0, id: 301, queue: -1 }] },
    ],
    reviews: [{ at: Date.UTC(2026, 9, 1, 8), cardId: 101, ease: 3, type: 0 }],
    media: {},
  });
  await page.goto("/#study");
  await page.getByRole("button", { name: "Aus Anki importieren" }).click();
  const wizard = page.getByRole("dialog", { name: "Aus Anki importieren" });
  await wizard.getByLabel("Anki-Datei").setInputFiles({ name: "Sprachen.apkg", mimeType: "application/octet-stream", buffer: bytes });
  const choice = wizard.getByRole("group", { name: "Unterstapel" });
  await expect(choice).toBeVisible({ timeout: 60_000 });
  await expect(choice.getByRole("radio", { name: /In die Eigenschaft „Deck“/ })).toBeChecked();
  await expect(wizard.getByRole("button", { name: "3 Notizen importieren" })).toBeVisible();
  await choice.getByRole("radio", { name: /Als eigene Datenbanken/ }).check();
  await expect(choice).toContainText("2 Stapel, jeder Unterstapel unter der Seite des Stapels darüber");
  await wizard.getByRole("checkbox", { name: /Meinen Lernstand übernehmen/ }).check();
  await expect(wizard.getByRole("checkbox", { name: /Meinen Lernstand übernehmen/ })).toBeChecked();
  await expect(wizard).toContainText("1 ausgesetzte Karte bleibt ausgesetzt");
  await choice.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await shot(page, "anki-subdecks", info.project.name, "w2fc");
  await wizard.getByRole("button", { name: "3 Notizen in 2 Stapel importieren" }).click();
  await expect(wizard.locator(".study-anki-done")).toContainText("3 Notizen in 2 Stapeln importiert", { timeout: 60_000 });
  // The pages: the top-level deck a plain page, Spanisch below it, Lektion 1 below Spanisch.
  const tree = (await (await page.request.get("/api/bootstrap")).json()).pages as { id: string; title: string; kind: string; parent_id: string | null }[];
  const topPage = tree.find((p) => p.title === top);
  expect(topPage?.kind).toBe("document");
  const spanish = tree.filter((p) => p.title === "Spanisch" && p.parent_id === topPage?.id);
  expect(spanish).toHaveLength(1);
  expect(spanish[0].kind).toBe("database");
  expect(tree.some((p) => p.title === "Lektion 1" && p.kind === "database" && p.parent_id === spanish[0].id)).toBe(true);
  expect(errors).toEqual([]);
});
