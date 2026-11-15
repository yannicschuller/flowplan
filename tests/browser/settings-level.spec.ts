import { test, expect, type Page } from "@playwright/test";

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

async function setup(page: Page) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const response = await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  expect(response.ok(), await response.text()).toBe(true);
}
const levelOf = async (page: Page) => (await (await page.request.get("/api/bootstrap")).json()).settingsLevel as { level: string; own: boolean };

// #294: settings levels. A new account starts at Normal; switching the
// level at the top of Settings shows and hides settings and sections; the
// search finds an expert setting from the beginner level, says so and
// offers to show it anyway or to switch the level.
test("settings levels: switch the level, settings appear and disappear, the search finds what is above", async ({ page }) => {
  test.setTimeout(120_000);
  await setup(page);
  // A new account starts at the instance's default, Normal (a demo
  // account may be reused by an earlier test: its own level counts then).
  const start = await levelOf(page);
  if (!start.own) expect(start.level).toBe("normal");
  else await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.settingsLevel", level: "normal" } });

  await page.goto("/#settings");
  const levels = page.getByRole("radiogroup", { name: "Einstellungsstufe" });
  await expect(levels).toBeVisible({ timeout: 30_000 });
  await expect(levels.getByRole("radio", { name: "Normal" })).toBeChecked();
  // Expert sections are not among the tiles at Normal.
  await expect(page.getByRole("link", { name: /^Darstellung & Sprache/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /^API & KI-Assistenten/ })).toHaveCount(0);

  // Normal: "Animationen" with its mark, no "Formatierungsleiste anpassen".
  await page.goto("/#settings/appearance");
  await expect(page.getByRole("heading", { name: "Darstellung & Sprache", level: 1 })).toBeVisible({ timeout: 30_000 });
  const motion = page.locator("#motion");
  await expect(motion).toBeVisible();
  await expect(motion.getByRole("img", { name: "Stufe: Normal" })).toBeVisible();
  await expect(page.locator("#ui-language").getByRole("img", { name: "Stufe: Einsteiger" })).toBeVisible();
  await expect(page.locator("#toolbar-layout")).toHaveCount(0);
  await expect(page.getByText(/weitere Einstellungen? gehör/)).toBeVisible();

  // Expert: it appears, the API section too.
  await page.goto("/#settings");
  await levels.getByRole("radio", { name: "Experte" }).check();
  await expect.poll(() => levelOf(page)).toEqual({ level: "expert", own: true });
  await expect(page.getByRole("link", { name: /^API & KI-Assistenten/ })).toBeVisible();
  await page.goto("/#settings/appearance");
  await expect(page.locator("#toolbar-layout")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#toolbar-layout").getByRole("img", { name: "Stufe: Experte" })).toBeVisible();

  // Beginner: the normal ones go as well, a card with nothing left goes.
  await page.goto("/#settings");
  await levels.getByRole("radio", { name: "Einsteiger" }).check();
  await expect.poll(() => levelOf(page)).toEqual({ level: "beginner", own: true });
  await page.goto("/#settings/appearance");
  await expect(page.locator("#ui-language")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#motion")).toHaveCount(0);
  await expect(page.locator("#toolbar-layout")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Editor", level: 2 })).toBeHidden();

  // The search finds the expert setting from Beginner and marks it.
  await page.goto("/#settings");
  await page.getByRole("searchbox", { name: "Einstellung suchen" }).fill("Formatierungsleiste anpassen");
  const result = page.getByRole("link", { name: /Formatierungsleiste anpassen.*Stufe Experte/ });
  await expect(result).toBeVisible();
  await result.click();
  await expect(page.getByText("Diese Einstellung gehört zur Stufe Experte.")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#toolbar-layout")).toHaveCount(0);
  // "Trotzdem zeigen": shown this once, the level stays.
  await page.getByRole("button", { name: "Trotzdem zeigen" }).first().click();
  await expect(page.locator("#toolbar-layout")).toBeVisible();
  await expect(page.locator("#motion")).toBeVisible();
  expect((await levelOf(page)).level).toBe("beginner");
  // "Stufe wechseln": one click to Expert.
  await page.getByRole("button", { name: "Stufe wechseln: Experte" }).click();
  await expect.poll(() => levelOf(page)).toEqual({ level: "expert", own: true });
  await expect(page.getByText(/gehört zur Stufe Experte|Vorübergehend/)).toHaveCount(0);

  // A whole section above the level, opened from the search.
  await page.goto("/#settings");
  await levels.getByRole("radio", { name: "Normal" }).check();
  await expect.poll(() => levelOf(page)).toEqual({ level: "normal", own: true });
  await page.getByRole("searchbox", { name: "Einstellung suchen" }).fill("Persönliche API-Tokens");
  await page.getByRole("link", { name: /Persönliche API-Tokens/ }).click();
  await expect(page.getByText("Dieser Bereich gehört zur Stufe Experte.")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#tokens")).toHaveCount(0);
  await page.getByRole("button", { name: "Trotzdem zeigen" }).click();
  await expect(page.locator("#tokens")).toBeVisible({ timeout: 30_000 });
});
