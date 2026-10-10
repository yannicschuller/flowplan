import { test, expect } from "@playwright/test";

// A survey from the template: build, share publicly, answer, see results.
test("survey builder, public survey and results", async ({ page, browser }, info) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const created = await page.request.post("/api/command", {
    headers: { origin, "accept-language": "de" },
    data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Umfrage ${info.project.name}`, kind: "database", starterTemplate: "survey" },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const pageId = (await created.json()).id;
  await page.goto(`/#page=${pageId}`);
  await page.getByRole("button", { name: /Umfrage bearbeiten|Edit survey/ }).click();
  const builder = page.getByRole("dialog");
  await builder.getByRole("button", { name: /Frage hinzufügen|Add question/ }).click();
  await builder.getByRole("button", { name: /^(Sterne|Star rating)$/ }).click();
  await builder.getByLabel(/^(Frage|Question)$/).fill("Wie gefällt dir das Design?");
  // Saved by itself shortly after typing; the indicator stays calm.
  const status = builder.locator(".survey-save-status");
  await expect(status).toHaveClass(/is-pending|is-saving/);
  await expect(status).toHaveText(/Automatisch gespeichert|Saved automatically/);
  await expect(status).toHaveClass(/is-saved/, { timeout: 10_000 });
  // An empty question is not saved and says why.
  await builder.getByLabel(/^(Frage|Question)$/).fill("");
  await expect(status).toHaveClass(/is-paused/);
  await expect(status).toContainText(/keinen Text|no text/);
  await builder.getByLabel(/^(Frage|Question)$/).fill("Wie gefällt dir das Design?");
  await expect(status).toHaveClass(/is-saved/, { timeout: 10_000 });
  await builder.getByRole("tab", { name: /Teilen|Share/ }).click();
  await builder.getByLabel(/Umfrage ist geöffnet|Survey is open/).check();
  await builder.getByLabel(/Öffentlich|Public/).check();
  await builder.getByLabel(/Anonym|Anonymous/).check();
  const link = builder.getByLabel(/Link zur Umfrage|Survey link/);
  await expect(link).toHaveValue(/\/forms\//);
  const url = await link.inputValue();

  // Someone without an account answers.
  const visitor = await browser.newContext({ locale: "de-DE", ...(info.project.name === "mobile" ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : {}) });
  const guest = await visitor.newPage();
  guest.on("pageerror", (e) => errors.push(e.message));
  await guest.goto(url);
  await guest.getByRole("button", { name: /Los geht/ }).click();
  const send = guest.getByRole("button", { name: "Absenden" });
  await send.click();
  await expect(guest.getByRole("alert").first()).toBeVisible();
  await guest.getByRole("radio", { name: /: 3$/ }).click();
  // A low score asks why.
  await guest.getByRole("textbox", { name: /besser machen/ }).fill("Mehr Vorlagen");
  await guest.getByText("Datenbanken", { exact: true }).click();
  await guest.getByRole("radio", { name: "4 von 5 Sternen" }).click();
  await send.click();
  await expect(guest.getByRole("status")).toContainText("Danke für deine Antwort!");
  await visitor.close();

  // Results in the builder.
  await page.reload();
  await page.getByRole("button", { name: /Umfrage bearbeiten|Edit survey/ }).click();
  await builder.getByRole("tab", { name: /Ergebnisse|Results/ }).click();
  const results = builder.locator(".survey-results");
  await expect(results.locator(".result-summary strong")).toHaveText("1");
  await expect(results).toContainText("-100");
  await expect(results).toContainText("Mehr Vorlagen");
  // The question typed before is there after reopening (autosave).
  await builder.getByRole("tab", { name: /Fragen|Questions/ }).click();
  await expect(builder.locator(".survey-outline")).toContainText("Wie gefällt dir das Design?");
  expect(errors).toEqual([]);
});
