import { test, expect } from "@playwright/test";

// #644: while the offline copy is being made, its status stands right under
// the switch and stays in view when you scroll; what waits for the sync is
// disabled and says so, and works once the copy is ready.
test("offline settings: the sync status stays in view and what waits for it is disabled", async ({ page, context }) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });

  // The first copy waits at its second step until the test lets it go on
  // (context.route also sees requests a service worker passes on).
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  let gated = false;
  await context.route("**/api/offline/changes**", async (route) => {
    if (!gated) {
      gated = true;
      await held;
    }
    await route.continue();
  });

  await page.goto("/#settings/devices");
  await page.getByRole("button", { name: "Auf diesem Gerät offline verfügbar machen" }).click();

  const status = page.getByTestId("offline-sync");
  await expect(status).toContainText("Offline-Kopie wird erstellt …");
  await expect(status).toContainText(/\d+ von \d+/);
  // In "Offline copy" at the top of the card, instead of when it was updated.
  await expect(page.getByTestId("offline-state").getByTestId("offline-sync")).toBeVisible();
  await expect(page.getByTestId("offline-updated")).toHaveCount(0);
  await expect(status).toBeInViewport();

  // What waits for the sync: disabled, with the note.
  const records = page.getByRole("switch", { name: "Auch Eintragsinhalte und Dateien speichern" });
  const budget = page.getByRole("combobox", { name: "Speicherbudget" });
  const keepSwitches = page.getByTestId("offline-spaces").getByRole("switch");
  await expect(records).toBeDisabled();
  await expect(budget).toBeDisabled();
  await expect(keepSwitches.first()).toBeDisabled();
  await expect(page.getByRole("button", { name: "Jetzt aktualisieren" })).toBeDisabled();
  const note = page.getByTestId("offline-wait").first();
  await expect(note).toHaveText("Wird verfügbar, sobald die Offline-Kopie fertig ist.");
  await expect(page.getByTestId("offline-wait")).toHaveCount(3);
  await expect(records).toHaveAccessibleDescription("Wird verfügbar, sobald die Offline-Kopie fertig ist.");
  await expect(keepSwitches.first()).toHaveAccessibleDescription("Wird verfügbar, sobald die Offline-Kopie fertig ist.");
  // A tap on a disabled switch changes nothing.
  await records.click({ force: true });
  await expect(records).toHaveAttribute("aria-checked", "false");

  // Scrolled down to the end of the card: a copy of the status line stays
  // at the top of the pane (below the phone's "back" bar).
  // (The forced tap above may have scrolled the card: back to its top first,
  // where the line itself is in view and there is no copy.)
  const float = page.getByTestId("offline-sync-float");
  await page.locator(".setting-group#offline").evaluate((el) => el.scrollIntoView({ block: "start" }));
  await expect(status).toBeInViewport();
  await expect(float).toHaveCount(0);
  // (Its pane scrolls the line a good way past its top.)
  await status.evaluate((el) => {
    let pane = el.parentElement;
    while (pane && !(pane.scrollHeight > pane.clientHeight && /auto|scroll/.test(getComputedStyle(pane).overflowY))) pane = pane.parentElement;
    (pane || document.scrollingElement!).scrollBy(0, el.getBoundingClientRect().top + 150);
  });
  await expect(status).not.toBeInViewport();
  await expect(float).toBeVisible();
  await expect(float).toContainText(/Offline-Kopie wird erstellt … \d+ von \d+/);
  await expect(float).toBeInViewport();
  const stuck = (await float.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(stuck.y).toBeLessThan(viewport.height / 4);
  const bar = page.locator(".settings-detail-bar");
  if (await bar.isVisible()) {
    const barBox = (await bar.boundingBox())!;
    expect(stuck.y).toBeGreaterThanOrEqual(barBox.y + barBox.height - 1);
  }
  // Only one status: none further down.
  await expect(page.locator(".setting-group#offline [role=status]")).toHaveCount(1);

  release();
  await expect(status).toHaveText(/offline verfügbar\./, { timeout: 120_000 });
  await expect(status).not.toHaveClass(/syncing/);
  await expect(float).toHaveCount(0);
  await expect(page.getByTestId("offline-updated")).toContainText("Offline-Kopie aktualisiert");
  await expect(page.getByTestId("offline-wait")).toHaveCount(0);
  await expect(records).toBeEnabled();
  await expect(budget).toBeEnabled();
  await expect(keepSwitches.first()).toBeEnabled();

  // Now the switch takes the tap, and the copy follows (status on top again).
  await records.click();
  await expect(records).toHaveAttribute("aria-checked", "true");
  await expect(status).toHaveText("Offline-Kopie ist auf dem neuesten Stand.", { timeout: 120_000 });
  await expect(records).toHaveAttribute("aria-checked", "true");

  await page.getByRole("button", { name: "Offline-Kopien entfernen" }).click();
  await expect(status).toHaveText("Offline-Kopien auf diesem Gerät wurden entfernt.");
  expect(errors).toEqual([]);
});
