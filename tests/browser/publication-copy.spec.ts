import { test, expect } from "@playwright/test";

test("published pages show metadata and can be copied into a workspace", async ({
  page,
  browser,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
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
  const title = `Leitfaden ${testInfo.project.name} ${Date.now()}`;
  const p = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title,
  });
  await command({ action: "page.publish", pageId: p.id, enabled: true });
  const token = (await (await page.request.get(`/api/pages/${p.id}`)).json())
    .page.public_token;

  // Anonymous visitors are asked to sign in.
  const anonymous = await browser.newContext();
  const guest = await anonymous.newPage();
  await guest.goto(`${origin}/share/${token}`);
  await expect(guest.getByText(/Veröffentlicht am/)).toBeVisible();
  await guest
    .getByRole("button", { name: "In meinen Arbeitsbereich kopieren" })
    .click();
  await expect(
    guest.getByRole("link", { name: "Anmelden, um zu kopieren" }),
  ).toHaveAttribute(
    "href",
    `/api/auth/login?returnTo=${encodeURIComponent(`/share/${token}`)}`,
  );
  await anonymous.close();

  await page.goto(`/share/${token}`);
  await page
    .getByRole("button", { name: "In meinen Arbeitsbereich kopieren" })
    .click();
  await expect(
    page.getByRole("combobox", { name: "Bereich", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: `test-results/publication-copy-verification/${testInfo.project.name}-copy.png`,
  });
  await page.getByRole("button", { name: "Kopie anlegen" }).click();
  await expect(page).toHaveURL(/#page=/);
  await expect(page.getByRole("textbox", { name: "Seitentitel" })).toHaveValue(
    `${title} (Kopie)`,
  );

  // Owners can switch copying off.
  await command({
    action: "page.publish",
    pageId: p.id,
    enabled: true,
    allowCopy: false,
  });
  await page.goto(`/share/${token}`);
  await expect(page.getByText(/Zuletzt geändert/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "In meinen Arbeitsbereich kopieren" }),
  ).toHaveCount(0);
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: p.id });
});
