import { expect, type Locator, type Page } from "@playwright/test";

// My tasks (components/my-tasks.tsx, #612): the workspaces, Quelle, Person,
// the date range, "Erledigte zeigen", the unassigned tasks and the tools for
// records sit behind "Filter" – a panel below the chip on larger screens, a
// bottom sheet on phones, both a dialog named "Filter". These helpers open
// it, act and close it again.

// Runs `act` inside "Filter" (closed again afterwards with Escape).
export async function withTaskFilters<T>(page: Page, act: (filters: Locator) => Promise<T>): Promise<T> {
  await page.getByRole("button", { name: /^Filter(, \d+ gesetzt)?$/ }).click();
  const dialog = page.getByRole("dialog", { name: "Filter", exact: true });
  await expect(dialog).toBeVisible();
  const result = await act(dialog);
  // Escape from inside: the focus may have left with a control that went away.
  if (!(await dialog.evaluate((el) => el.contains(document.activeElement)))) await dialog.focus();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  return result;
}

// The source, in "Filter".
export async function chooseSource(page: Page, label: "Alle" | "Dokumente" | "Datenbanken") {
  await withTaskFilters(page, (filters) => filters.locator(".my-tasks-source label", { hasText: label }).click());
}
