import { test, expect } from "@playwright/test";

// Loading while offline needs the production build (the dev server hydrates
// only with its live-reload connection); `npm run check:offline` covers it.
test("offline use is opt-in per device and its copies are removable", async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  test.skip(
    testInfo.project.name !== "desktop",
    "One service-worker run covers the shared code path.",
  );
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", {
      headers: { origin },
      data,
    });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const doc = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `Reiseplan ${Date.now()}`,
  });
  const cached = () =>
    page.evaluate(async () =>
      (await caches.has("flowplan-data-v1"))
        ? (await (await caches.open("flowplan-data-v1")).keys()).map(
            (r) => new URL(r.url).pathname,
          )
        : [],
    );
  await page.goto("/#settings");
  await page.getByRole("button", { name: "Daten", exact: true }).click();
  // Nothing private is stored before opting in.
  expect(await cached()).toEqual([]);
  await page
    .getByRole("button", { name: "Auf diesem Gerät offline verfügbar machen" })
    .click();
  // Every readable page of the (shared, growing) test account is stored.
  await expect(page.getByText(/offline verfügbar\./)).toBeVisible({
    timeout: 120_000,
  });
  const stored = await cached();
  expect(stored).toContain("/");
  expect(stored).toContain("/api/bootstrap");
  expect(stored).toContain(`/api/pages/${doc.id}`);
  await page.getByRole("button", { name: "Offline-Kopien entfernen" }).click();
  await expect(
    page.getByText("Offline-Kopien auf diesem Gerät wurden entfernt."),
  ).toBeVisible();
  expect(await cached()).toEqual([]);
  // Logging out removes the copies as well.
  await page
    .getByRole("button", { name: "Auf diesem Gerät offline verfügbar machen" })
    .click();
  // Every readable page of the (shared, growing) test account is stored.
  await expect(page.getByText(/offline verfügbar\./)).toBeVisible({
    timeout: 120_000,
  });
  await page.getByRole("button", { name: "Kontomenü" }).click();
  await page.getByRole("menuitem", { name: "Abmelden" }).click();
  await page.waitForURL((url) => url.hash === "");
  expect(await cached()).toEqual([]);
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await command({ action: "page.delete", pageId: doc.id });
});
