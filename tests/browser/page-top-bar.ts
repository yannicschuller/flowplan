import type { Page } from "@playwright/test";

// The top bar of an open page (components/workspace-app.tsx): on phones
// (≤ 767 px) it holds the sidebar button, the title and ⋯; follow,
// favourite, share and reading mode are at the top of the ⋯ menu there.
export const phoneTopBar = (page: Page) => (page.viewportSize()?.width ?? 1440) <= 767;

export async function openPageMenu(page: Page) {
  await page.getByRole("button", { name: "Seitenaktionen", exact: true }).click();
  return page.getByRole("menu");
}

// "Teilen" from the top bar, or from the ⋯ menu on phones.
export async function openShare(page: Page) {
  if (phoneTopBar(page)) await (await openPageMenu(page)).getByRole("menuitem", { name: "Teilen", exact: true }).click();
  else await page.getByRole("button", { name: "Teilen", exact: true }).click();
}

// Reading mode on or off ("Lesemodus" / "Bearbeiten").
export async function toggleReadingMode(page: Page, name: "Lesemodus" | "Bearbeiten" = "Lesemodus") {
  if (phoneTopBar(page)) await (await openPageMenu(page)).getByRole("menuitem", { name, exact: true }).click();
  else await page.getByRole("button", { name, exact: true }).click();
}
