import { test, expect } from "@playwright/test";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
  "base64",
);

test("guests with an edit link add records and upload images", async ({
  page,
  browser,
}, testInfo) => {
  const errors: string[] = [];
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
  const p = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `Gastliste ${testInfo.project.name} ${Date.now()}`,
    kind: "database",
  });
  const link = await command({
    action: "share.create",
    pageId: p.id,
    role: "editor",
    name: "Gäste",
  });
  const visitor = await browser.newContext({
    viewport: page.viewportSize()!,
    isMobile: testInfo.project.name === "mobile",
  });
  try {
    const guest = await visitor.newPage();
    guest.on("pageerror", (e) => errors.push(e.message));
    await guest.goto(`${origin}/share/${link.token}`);
    await guest.getByLabel("Name des neuen Eintrags").fill("Idee vom Gast");
    await guest.getByRole("button", { name: "Eintrag anlegen" }).click();
    await expect(guest).toHaveURL(/\?row=/);
    await expect(
      guest.getByRole("heading", { name: "Idee vom Gast" }),
    ).toBeVisible();
    await guest
      .getByRole("button", { name: "Inhalt bearbeiten", exact: true })
      .click();
    await guest.getByLabel("Geteilten Inhalt bearbeiten").click();
    await guest.getByLabel("Datei einfügen").setInputFiles({
      name: "skizze.png",
      mimeType: "image/png",
      buffer: png,
    });
    const image = guest.locator('.shared-rich-editor img[alt="skizze.png"]');
    await expect(image).toHaveAttribute(
      "src",
      new RegExp(`/api/share/${link.token}/files/`),
    );
    await guest
      .getByRole("button", { name: "Änderungen speichern", exact: true })
      .click();
    await expect(guest.getByRole("status")).toHaveText(
      "Änderungen gespeichert",
    );
    // After saving, only the published document shows the image.
    const published = guest.locator('img[alt="skizze.png"]');
    await expect(published).toHaveCount(1);
    await expect(published).toHaveAttribute(
      "src",
      new RegExp(`/api/share/${link.token}/files/`),
    );
    // Lazy images load once visible.
    await published.scrollIntoViewIfNeeded();
    await expect
      .poll(() =>
        published.evaluate((img: HTMLImageElement) => img.naturalWidth),
      )
      .toBe(1);
    // Unsupported types are refused with a message.
    await guest
      .getByRole("button", { name: "Inhalt bearbeiten", exact: true })
      .click();
    await guest.getByLabel("Datei einfügen").setInputFiles({
      name: "seite.html",
      mimeType: "text/html",
      buffer: Buffer.from("<script>alert(1)</script>"),
    });
    await expect(
      guest.locator(".shared-interactions [role=alert]"),
    ).toContainText("Erlaubt sind");
    await guest.screenshot({
      path: `test-results/guest-records-verification/${testInfo.project.name}.png`,
      fullPage: true,
    });
  } finally {
    await visitor.close();
  }
  // The owner sees the guest record with its document.
  const data = await (await page.request.get(`/api/pages/${p.id}`)).json();
  const record = data.rows.find(
    (r: { cells: { title: string } }) => r.cells.title === "Idee vom Gast",
  );
  expect(record).toBeTruthy();
  expect(record.content).toContain("/api/files/");
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: p.id });
});
