import type { Page } from "@playwright/test";

// The sidebar's less used places (Vorlagen, Medien, Papierkorb,
// Einstellungen …, components/sidebar-tools.tsx): a row of symbols, on
// phones behind "Mehr" in the drawer's profile row, as a list in a sheet
// (#185). Opens one by its name the way the layout offers it; on phones the
// drawer is open already.
export async function openSidebarTool(page: Page, name: string, { tap = false } = {}) {
  const press = async (target: ReturnType<Page["locator"]>) => (tap ? target.tap() : target.click());
  const more = page.locator("aside.sidebar .sidebar-more");
  if (await more.isVisible()) {
    await press(more);
    await press(page.getByRole("dialog", { name: "Mehr" }).getByRole("button", { name, exact: true }));
  } else await press(page.locator("aside.sidebar .sidebar-tools").getByRole("button", { name, exact: true }));
}
