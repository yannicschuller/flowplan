import { test, expect, type Page } from "@playwright/test";

// Finding tags by typing in the quick search (#328): the tag filter is a
// combobox that filters while typing, and `#` in the search input suggests
// the matching tags. The input's own arrows and Enter still go through the
// results whenever no tags are suggested.
// TAG_SUGGEST_SCREENSHOTS=<dir> saves the open lists, in dark mode with
// TAG_SUGGEST_DARK=1.
const shots = process.env.TAG_SUGGEST_SCREENSHOTS;
const scheme = process.env.TAG_SUGGEST_DARK ? "dark" : "light";

async function openPalette(page: Page) {
  const input = page.getByLabel("Suchen oder Befehl");
  await expect(async () => {
    if (!(await input.isVisible())) await page.keyboard.press("ControlOrMeta+k");
    await expect(input).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
  return input;
}

async function setup(page: Page) {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data: { workspaceId: boot.workspace.id, ...data } });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  // Letters only, so the tags are this run's alone.
  const s = Array.from({ length: 6 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");
  const home = boot.spaces[0] as { id: string; name: string };
  for (const name of [`${s}projekt`, `${s}pro`, `Alt ${s}prozess`, `${s}archiv`]) await command({ action: "tag.save", name, spaceId: home.id });
  for (const title of [`Notiz ${s} eins`, `Notiz ${s} zwei`]) await command({ action: "page.create", spaceId: home.id, title, kind: "document" });
  return { s, home };
}

test("the tag filter finds tags by typing and adds the chosen one", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { s, home } = await setup(page);
  if (shots) await page.emulateMedia({ colorScheme: scheme });
  await page.goto("/#home");
  const input = await openPalette(page);
  const dialog = page.getByRole("dialog", { name: "Schnellsuche" });
  const filter = dialog.getByRole("combobox", { name: "Nach Tag filtern" });
  await expect(filter).toHaveAttribute("aria-expanded", "false");
  await filter.click();
  await filter.pressSequentially(`${s.toUpperCase()}PRO`);
  await expect(filter).toHaveAttribute("aria-expanded", "true");
  const list = page.getByRole("listbox", { name: "Tags", exact: true });
  // The same name first, then names starting with it, then a word in the name.
  await expect(list.locator(".tag-suggest-name")).toHaveText([`#${s}pro`, `#${s}projekt`, `#Alt ${s}prozess`]);
  await expect(filter).toHaveAttribute("aria-activedescendant", (await list.getByRole("option").first().getAttribute("id"))!);
  // For all spaces, each with its space's name as a hint (#136).
  await expect(list.locator(".tag-suggest-hint").first()).toHaveText(`, ${home.name}`);
  if (shots) await page.screenshot({ path: `${shots}/filter-${info.project.name}-${scheme}.png` });
  await filter.press("ArrowDown");
  await filter.press("ArrowDown");
  await expect(list.getByRole("option", { name: `#Alt ${s}prozess` })).toHaveAttribute("aria-selected", "true");
  await filter.press("Enter");
  await expect(input).toHaveValue(`#"Alt ${s}prozess" `);
  await expect(dialog.locator(".search-token", { hasText: `Alt ${s}prozess` })).toBeVisible();
  await expect(filter).toHaveValue("");
  await expect(list).toHaveCount(0);

  // Nothing matches: says so.
  await filter.fill(`${s}nichts`);
  await expect(page.getByRole("listbox", { name: "Tags", exact: true })).toContainText("Kein Tag gefunden");
  // Escape closes the list, not the search.
  await filter.press("Escape");
  await expect(page.getByRole("listbox", { name: "Tags", exact: true })).toHaveCount(0);
  await expect(dialog).toBeVisible();

  // A tap or click picks as well.
  await filter.fill(`${s}arch`);
  const option = page.getByRole("option", { name: `#${s}archiv` });
  if (info.project.name === "mobile") await option.tap();
  else await option.click();
  await expect(input).toHaveValue(`#"Alt ${s}prozess" #${s}archiv `);
  expect(errors).toEqual([]);
});

test("# in the search input suggests tags; the arrows go to the results otherwise", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { s } = await setup(page);
  if (shots) await page.emulateMedia({ colorScheme: scheme });
  await page.goto("/#home");
  const input = await openPalette(page);
  const dialog = page.getByRole("dialog", { name: "Schnellsuche" });
  const suggestions = page.getByRole("listbox", { name: "Passende Tags" });

  // Without `#` the arrows move through the hits.
  await input.pressSequentially(`Notiz ${s}`);
  const hits = dialog.locator(".palette-option", { hasText: `Notiz ${s}` });
  await expect(hits).toHaveCount(2);
  await expect(suggestions).toHaveCount(0);
  const before = await input.getAttribute("aria-activedescendant");
  await input.press("ArrowDown");
  await expect(input).not.toHaveAttribute("aria-activedescendant", before ?? "");
  await expect(input).toHaveAttribute("aria-controls", "palette-list");

  // `#` with letters: the matching tags, the same name first.
  await input.fill("");
  await input.pressSequentially(`Notiz #${s}pro`);
  await expect(suggestions.locator(".tag-suggest-name")).toHaveText([`#${s}pro`, `#${s}projekt`, `#Alt ${s}prozess`]);
  await expect(input).toHaveAttribute("aria-controls", (await suggestions.getAttribute("id"))!);
  await expect(input).toHaveAttribute("aria-activedescendant", (await suggestions.getByRole("option").first().getAttribute("id"))!);
  if (shots) await page.screenshot({ path: `${shots}/hash-${info.project.name}-${scheme}.png` });
  // The list takes the arrows and Tab: the token replaces what was typed.
  await input.press("ArrowDown");
  await input.press("ArrowDown");
  await input.press("Tab");
  await expect(input).toHaveValue(`Notiz #"Alt ${s}prozess" `);
  await expect(input).toBeFocused();
  await expect(suggestions).toHaveCount(0);
  await expect(dialog.locator(".search-token", { hasText: `Alt ${s}prozess` })).toBeVisible();

  // Enter inserts as well, also in the middle of the query.
  await input.fill(`#${s}arc ${s}`);
  await input.evaluate((el: HTMLInputElement, at: number) => el.setSelectionRange(at, at), s.length + 4);
  await input.press("ArrowLeft");
  await input.press("ArrowRight");
  await expect(suggestions.locator(".tag-suggest-name")).toHaveText([`#${s}archiv`]);
  await input.press("Enter");
  await expect(input).toHaveValue(`#${s}archiv ${s}`);
  await expect(dialog).toBeVisible();

  // Escape closes the suggestions, not the search.
  await input.fill("");
  await input.pressSequentially(`#${s}pr`);
  await expect(suggestions).toBeVisible();
  await input.press("Escape");
  await expect(suggestions).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(input).toHaveValue(`#${s}pr`);

  // Not in command mode.
  await input.fill("");
  await input.pressSequentially(`> #${s}pro`);
  await expect(input).toHaveValue(`> #${s}pro`);
  await expect(suggestions).toHaveCount(0);
  expect(errors).toEqual([]);
});
