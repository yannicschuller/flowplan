import { test, expect } from "@playwright/test";

// #167: the AFFiNE import preview offers "Dokumente mit genau einem Verweis
// darunter einordnen" (on by default) and says how many documents it moves;
// switched off, those documents stay at the top as before.

const shots = process.env.AFFINE_BACKLINK_SHOTS;

test("the AFFiNE preview counts documents with one link to them; switched off they stay at the top", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "One run is enough.");
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  const { affineFileV2, note, page: doc, para } = await import("../helpers/affine-fixture");
  const stamp = Date.now();
  const ref = (pageId: string) => ({ insert: " ", attributes: { reference: { type: "LinkedPage", pageId } } });
  const linking = (id: string, title: string, targets: string[]) =>
    doc(id, title, [note([para([{ insert: `${title}: ` }, ...targets.map(ref)])])]);
  const names = { start: `Start ${stamp}`, one: `Einzeln ${stamp}`, chain: `Kette ${stamp}`, other: `Andere ${stamp}` };
  const bytes = affineFileV2({
    id: `ws${stamp}`,
    name: `Verweise ${stamp}`,
    docs: [
      { id: "dStart", title: names.start, doc: linking("dStart", names.start, ["dOne"]) },
      { id: "dOne", title: names.one, doc: linking("dOne", names.one, ["dChain"]) },
      { id: "dChain", title: names.chain, doc: linking("dChain", names.chain, []) },
      { id: "dOther", title: names.other, doc: linking("dOther", names.other, []) },
    ],
  });

  await page.goto("/#settings/data");
  await page.getByLabel("Datei für den Import").setInputFiles({ name: "Verweise.affine", mimeType: "application/octet-stream", buffer: bytes });
  const preview = page.getByRole("region", { name: "Vorschau des Imports" });
  await expect(preview).toBeVisible({ timeout: 30000 });
  const toggle = preview.getByRole("switch", { name: "Dokumente mit genau einem Verweis darunter einordnen" });
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(preview).toContainText("2 Dokumente, auf die genau ein anderes Dokument verweist, kommen unter dieses Dokument");
  await preview.scrollIntoViewIfNeeded();
  if (shots) await preview.screenshot({ path: `${shots}/affine-preview-on.png` });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(preview).toContainText("bleiben auf der obersten Ebene");
  if (shots) await preview.screenshot({ path: `${shots}/affine-preview-off.png` });
  await preview.getByRole("button", { name: "Importieren", exact: true }).click();
  // Once imported, the first imported page opens (its "… importiert" line
  // in the settings shows only until then).
  await expect(page).toHaveURL(/#page=/, { timeout: 30000 });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const byTitle = (title: string) => boot.pages.find((p: { title: string }) => p.title === title) as { id: string; parent_id: string | null };
  // Off: all four next to each other (four documents at the top, no wrapper).
  const parents = new Set(Object.values(names).map((title) => byTitle(title).parent_id));
  expect(parents.size).toBe(1);
});
