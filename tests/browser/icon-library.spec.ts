import { test, expect } from "@playwright/test";

test("page icons come from the icon library in a colour and size", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const response = await page.request.post("/api/command", {
    headers: { origin },
    data: {
      action: "page.create",
      workspaceId: boot.workspace.id,
      spaceId: boot.spaces[0].id,
      title: `Symbole ${testInfo.project.name} ${Date.now()}`,
    },
  });
  const p = await response.json();
  const read = async () =>
    (await (await page.request.get(`/api/pages/${p.id}`)).json()).page;
  await page.goto(`/#page=${p.id}`);
  await page.getByTitle("Seiten-Icon ändern").click();
  const dialog = page.getByRole("dialog", { name: "Seiten-Icon" });
  await dialog.getByRole("tab", { name: "Symbole" }).click();
  await dialog.getByLabel("Symbole durchsuchen").fill("ziel");
  await dialog.getByRole("radio", { name: "Farbe Rot" }).click();
  await dialog.getByRole("option", { name: "Symbol Target" }).click();
  await expect
    .poll(async () => (await read()).icon)
    .toBe("icon:Target:#d44c47");
  const hero = page.locator(".large-page-icon svg");
  await expect(hero).toHaveAttribute("fill", "#d44c47");
  const small = (await hero.boundingBox())!.width;
  await page.getByTitle("Seiten-Icon ändern").click();
  await dialog.getByLabel("Symbolgröße").selectOption("large");
  await expect.poll(async () => (await read()).icon_size).toBe("large");
  await expect
    .poll(
      async () =>
        (await page.locator(".large-page-icon svg").boundingBox())!.width,
    )
    .toBeGreaterThan(small + 10);
  // The sidebar shows the same symbol.
  await expect(
    page.locator(`.page-nav[data-page-id="${p.id}"] svg[fill="#d44c47"]`),
  ).toHaveCount(1);
  expect(errors).toEqual([]);
});
