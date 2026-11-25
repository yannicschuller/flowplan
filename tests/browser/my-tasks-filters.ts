import { expect, type Locator, type Page } from "@playwright/test";

// My tasks on phones (components/my-tasks.tsx): Quelle is a select and the
// date a chip in one row; Person, "Erledigte zeigen", the unassigned tasks
// and the tools for records sit in the sheet behind "Filter". These helpers
// do the same on both layouts.
const phone = (page: Page) => (page.viewportSize()?.width ?? 1440) <= 600;

// The source: a segmented control on larger screens, a select on phones.
export async function chooseSource(page: Page, label: "Alle" | "Dokumente" | "Datenbanken") {
  if (!phone(page)) return page.locator(".my-tasks-source label", { hasText: label }).click();
  const value = { Alle: "all", Dokumente: "documents", Datenbanken: "databases" }[label];
  await page.locator(".my-tasks-bar").getByLabel("Quelle", { exact: true }).selectOption(value);
}

// Runs `act` with the filters at hand: in the "Filter" sheet on phones
// (closed again afterwards), on the page elsewhere.
export async function withTaskFilters<T>(page: Page, act: (filters: Locator) => Promise<T>): Promise<T> {
  if (!phone(page)) return act(page.locator(".my-tasks"));
  await page.getByRole("button", { name: /^Filter(, \d+ gesetzt)?$/ }).click();
  const sheet = page.getByRole("dialog", { name: "Filter", exact: true });
  await expect(sheet).toBeVisible();
  const result = await act(sheet);
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  return result;
}
