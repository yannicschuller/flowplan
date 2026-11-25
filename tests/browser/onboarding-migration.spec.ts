import { test, expect } from "@playwright/test";
import { readdirSync, readFileSync, statSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { ZipFile } from "yazl";

// The introduction for people moving from another tool: "Woher kommst
// du?" with the export guide and the import of a Notion HTML export into the
// first space, "So heißt das hier", starters by goal, the sample space, and
// afterwards the checklist "Erste Schritte" in the sidebar ticking itself.
// SHOTS=<dir> also writes screenshots there.

const FIXTURE = "tests/fixtures/import/notion-html";
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}
function notionZip() {
  const zip = new ZipFile();
  for (const path of files(FIXTURE)) zip.addBuffer(readFileSync(path), relative(FIXTURE, path));
  zip.end();
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (c: Buffer) => chunks.push(c));
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on("error", reject);
  });
}

test("moving from Notion: guide, import, terms, starters, sample space and the checklist", async ({ page, browser }, info) => {
  test.setTimeout(180_000);
  test.skip(info.project.name !== "desktop", "One run covers the flow; the phone layout is checked by onboarding.spec.ts.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const shots = process.env.SHOTS;
  if (shots) mkdirSync(shots, { recursive: true });
  const shot = async (name: string) => {
    if (shots) await page.screenshot({ path: join(shots, `${name}.png`) });
  };
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  // A new account sees the introduction by itself.
  const stamp = Date.now();
  const account = { name: "Nora Umzug", email: `nora-${stamp}@example.test`, password: "ein-langes-passwort" };
  if (!(await page.request.post("/api/auth/register", { headers: { origin }, data: account })).ok()) {
    // Sign-up is closed once an instance has its first account: an
    // administrator opens it for this one registration.
    test.skip(!process.env.TEST_ADMIN_EMAIL, "Sign-up is closed and TEST_ADMIN_EMAIL is not given.");
    const admin = await browser.newContext({ baseURL: origin });
    const post = (path: string, data: unknown) => admin.request.post(path, { headers: { origin }, data });
    await post("/api/auth/password", { email: process.env.TEST_ADMIN_EMAIL, password: process.env.TEST_ADMIN_PASSWORD });
    expect((await post("/api/command", { action: "admin.settings", settings: { allowSignup: true } })).ok()).toBe(true);
    try {
      expect((await page.request.post("/api/auth/register", { headers: { origin }, data: account })).ok()).toBe(true);
    } finally {
      await post("/api/command", { action: "admin.settings", settings: { allowSignup: false } });
      await admin.close();
    }
  }
  await page.goto("/");
  const dialog = page.getByRole("dialog", { name: "Willkommen bei Flowplan" });
  await expect(dialog.getByRole("heading", { name: "Hallo Nora!" })).toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByRole("heading", { name: "Hallo Nora!" })).toBeFocused();
  await dialog.getByRole("button", { name: "Weiter", exact: true }).click();

  // The first account of an instance is its administrator: traffic lights.
  await expect(dialog.getByRole("heading", { name: /^(Instanz einrichten|Woher kommst du\?)$/ })).toBeVisible();
  if (await dialog.getByRole("heading", { name: "Instanz einrichten" }).isVisible()) {
    const lights = dialog.locator(".onboarding-setup li");
    await expect(lights).toHaveCount(5);
    await expect(dialog.getByRole("link", { name: /^E-Mail-Versand: / })).toHaveAttribute("href", "#settings/instance/mail");
    await expect(dialog.getByRole("link", { name: /^Sicherung: / })).toHaveAttribute("href", "#settings/instance/storage/backup");
    await shot("onboarding-admin-setup");
    await dialog.getByRole("button", { name: "Weiter", exact: true }).click();
  }

  // Where from: Notion, with where its export is, and the import.
  const heading = dialog.getByRole("heading", { name: "Woher kommst du?" });
  await expect(heading).toBeFocused();
  await dialog.getByRole("radio", { name: "Notion" }).check();
  await expect(dialog.getByRole("heading", { name: "So kommst du an deinen Export aus Notion" })).toBeVisible();
  await expect(dialog.getByRole("listitem").filter({ hasText: "Export all workspace content" })).toBeVisible();
  await dialog.getByLabel("Export aus Notion importieren").setInputFiles({ name: "Notion-Export.zip", mimeType: "application/zip", buffer: await notionZip() });
  await expect(dialog.getByRole("status").filter({ hasText: "importiert" })).toContainText("Seiten", { timeout: 60_000 });
  await shot("onboarding-source-notion");
  await dialog.getByRole("button", { name: "Weiter", exact: true }).click();

  // What it's called here.
  await expect(dialog.getByRole("heading", { name: "So heißt das hier" })).toBeFocused();
  const table = dialog.getByRole("table", { name: "Begriffe aus Notion und in Flowplan" });
  await expect(table.getByRole("row", { name: /^Teamspace/ })).toContainText("Bereich");
  await expect(table.getByRole("row", { name: /^Synced block/ })).toContainText("Synchronisierter Block");
  await expect(table.getByRole("row", { name: /^Notion Calendar/ })).toContainText("Gibt es nicht");
  await shot("onboarding-terms-notion");
  await dialog.getByRole("button", { name: "Weiter", exact: true }).click();

  // What for: other starters for projects, and a sample space to try.
  await expect(dialog.getByRole("heading", { name: "Womit möchtest du starten?" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: /^Aufgaben/ })).toBeVisible();
  await dialog.getByRole("radio", { name: "Projekte & Tickets" }).check();
  // The goal suggests a settings level (#294).
  await expect(dialog.locator(".onboarding-level-hint")).toContainText("„Normal“");
  await expect(dialog.getByRole("button", { name: /^Aufgaben/ })).toHaveCount(0);
  await dialog.getByRole("button", { name: /^Sprint-Board/ }).click();
  await dialog.getByRole("button", { name: "Beispielbereich anlegen" }).click();
  await expect(dialog.getByText("„Beispielbereich“ ist angelegt")).toBeVisible();
  await expect(page.locator(".sidebar").getByText("Beispielbereich").first()).toBeAttached();
  await dialog.getByRole("button", { name: "1 anlegen und weiter" }).click();
  await expect(dialog.getByRole("heading", { name: "Das kann Flowplan" })).toBeVisible({ timeout: 15_000 });
  await dialog.getByRole("button", { name: "Weiter", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Wie möchtest du benachrichtigt werden?" })).toBeVisible();
  await dialog.getByRole("button", { name: "Weiter", exact: true }).click();
  // Offline use on this device (#295): what is stored, and the choice.
  await expect(dialog.getByRole("heading", { name: "Auch ohne Verbindung arbeiten?" })).toBeFocused();
  await expect(dialog).toContainText("Einstellungen → Offline & Geräte");
  await expect(dialog.getByRole("button", { name: "Offline nutzen" })).toBeVisible();
  await shot("onboarding-offline-step");
  await dialog.getByRole("button", { name: "Nicht mehr fragen" }).click();
  expect(await page.evaluate(() => localStorage.getItem("flowplan-offline-offer"))).toBe("never");
  await expect(dialog.getByRole("heading", { name: "Alles bereit!" })).toBeVisible();
  await expect(dialog).toContainText("Sprint-Board");
  await expect(dialog).toContainText("Erste Schritte");
  await dialog.getByRole("button", { name: "Los geht's" }).click();
  await expect(dialog).toBeHidden();
  // … stored as the person's own level.
  expect((await (await page.request.get("/api/bootstrap")).json()).settingsLevel).toEqual({ level: "normal", own: true });

  // The checklist: imported in the introduction already, so no import item.
  const list = page.getByRole("region", { name: "Erste Schritte" });
  await expect(list).toBeVisible();
  await expect(list.getByRole("checkbox")).toHaveCount(5);
  await expect(list.getByRole("checkbox", { name: "Inhalte importieren" })).toHaveCount(0);
  await expect(list).toContainText("0 von 5");
  // The search ticks itself.
  await page.locator("main").click();
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByRole("dialog", { name: "Schnellsuche" })).toBeVisible();
  // (The sidebar is hidden from assistive technology while the search is open.)
  await expect(page.locator(".getting-started-count")).toHaveText("1 von 5");
  await page.keyboard.press("Escape");
  await expect(list.getByRole("checkbox", { name: /^Suche und Befehle ausprobieren/ })).toBeChecked();
  // A new page from the list ticks "Eine erste Seite schreiben".
  await list.getByRole("button", { name: "Neue Seite" }).click();
  const create = page.getByRole("dialog", { name: "Neue Seite" });
  await create.getByRole("textbox", { name: "Name" }).fill("Meine erste Seite");
  await create.getByRole("button", { name: "Seite erstellen" }).click();
  await expect(create).toBeHidden();
  await expect(list.getByRole("checkbox", { name: "Eine erste Seite schreiben" })).toBeChecked();
  // By hand.
  await list.getByRole("checkbox", { name: "Die App installieren" }).check();
  await expect(list).toContainText("3 von 5");
  await shot("onboarding-checklist-sidebar");
  // The sample space goes with one click.
  await list.getByRole("button", { name: "„Beispielbereich“ entfernen" }).click();
  await expect(page.locator(".sidebar").getByText("Beispielbereich", { exact: true })).toHaveCount(0);
  // Hidden for good; the command palette shows it again.
  await list.getByRole("button", { name: "Erste Schritte ausblenden" }).click();
  await expect(list).toBeHidden();
  const boot = await (await page.request.get("/api/bootstrap")).json();
  expect(boot.gettingStarted).toMatchObject({ hidden: true, goal: "projects", source: "notion" });
  expect(boot.sampleSpace).toBeNull();
  expect(boot.pages.some((p: { title: string }) => p.title.startsWith("Besprechungen"))).toBe(true);
  // This device answered in the introduction: no card after a reload.
  await page.reload();
  await expect(page.locator(".sidebar")).toBeVisible();
  await page.waitForTimeout(3500);
  await expect(page.getByRole("region", { name: "Auf diesem Gerät auch offline arbeiten?" })).toHaveCount(0);
  // Another browser of the same person asks once; "Später" closes it for a week.
  // (A device that was never asked: not the specs' pre-answered storage.)
  const other = await browser.newContext({ baseURL: origin, viewport: { width: 1280, height: 800 }, locale: "de-DE", storageState: { cookies: [], origins: [] } });
  const second = await other.newPage();
  await second.request.post("/api/auth/password", { headers: { origin }, data: { email: account.email, password: account.password } });
  await second.goto("/");
  const card = second.getByRole("region", { name: "Auf diesem Gerät auch offline arbeiten?" });
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card).toContainText("Seiten dieses Arbeitsbereichs");
  await expect(card.getByRole("button", { name: "Offline nutzen" })).toBeVisible();
  if (shots) await second.screenshot({ path: join(shots, "offline-offer-card.png") });
  await card.getByRole("button", { name: "Später", exact: true }).click();
  await expect(card).toBeHidden();
  expect(await second.evaluate(() => localStorage.getItem("flowplan-offline-offer"))).toMatch(/^later:\d+$/);
  await second.reload();
  await expect(second.locator(".sidebar")).toBeVisible();
  await second.waitForTimeout(3500);
  await expect(card).toHaveCount(0);
  await other.close();
  expect(errors).toEqual([]);
});
