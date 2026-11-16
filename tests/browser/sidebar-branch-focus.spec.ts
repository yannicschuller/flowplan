import { test, expect } from "@playwright/test";

// A branch of the page tree focused in the sidebar (#318): the tree shows
// one page as its root with "←", the path and "×" above; kept on this
// device over a reload; a page opened outside the branch shows the whole
// tree again. Desktop through the row's context menu, phones through the
// page's "⋯" sheet (the drawer opens to show it).
test("sidebar focuses a branch of the page tree, goes up, keeps it over a reload and ends it", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const spaceId = boot.spaces[0].id as string;
  const spaceName = boot.spaces[0].name as string;
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const tag = `${testInfo.project.name}${Date.now()}`;
  const create = async (title: string, parentId?: string) =>
    (await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId, title, ...(parentId ? { parentId } : {}) })).id as string;
  const top = await create(`Projekte ${tag}`);
  const branch = await create(`Garten ${tag}`, top);
  const leaf = await create(`Beete ${tag}`, branch);
  await create(`Kompost ${tag}`, branch);
  const sibling = await create(`Küche ${tag}`, top);
  const outside = await create(`Draußen ${tag}`);

  const mobile = testInfo.project.name === "mobile";
  const nav = page.locator(".sidebar");
  const openNav = async () => {
    if (mobile && !(await page.locator(".app-shell.nav-open").count()))
      await page.locator(".topbar").getByRole("button", { name: "Navigation öffnen" }).click();
    await expect(nav).toBeInViewport();
  };
  const focusHere = async (pageTitle: string, id: string) => {
    if (mobile) {
      // The page's own "⋯" menu, a bottom sheet on phones.
      await page.getByRole("button", { name: "Seitenaktionen" }).click();
      await page.getByRole("dialog", { name: "Seitenaktionen" }).getByRole("menuitem", { name: "Im Seitenbaum fokussieren" }).click();
      await expect(page.locator(".app-shell.nav-open")).toHaveCount(1);
    } else {
      await openNav();
      await nav.locator(`.page-nav[data-page-id="${id}"]`).click({ button: "right" });
      await page.getByRole("menu", { name: `Aktionen für ${pageTitle}` }).getByRole("menuitem", { name: "Im Seitenbaum fokussieren" }).click();
    }
  };
  const focusedTree = (title: string) => nav.getByRole("tree", { name: `Seiten unter ${title}` });
  const path = nav.getByRole("navigation", { name: "Pfad im Seitenbaum" });
  const spaceCrumb = new RegExp(`${spaceName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);

  await page.goto(`/#page=${branch}`);
  await expect(page.locator(".tiptap")).toBeVisible();
  await focusHere(`Garten ${tag}`, branch);

  // Only the branch: the page as the root, its sub-pages shown.
  let tree = focusedTree(`Garten ${tag}`);
  await expect(tree).toBeVisible();
  await expect(nav.getByRole("tree")).toHaveCount(1);
  const root = tree.locator(`[role="treeitem"][data-page-id="${branch}"]`);
  await expect(root).toHaveAttribute("aria-level", "1");
  await expect(root).toHaveAttribute("aria-expanded", "true");
  await expect(tree.locator(`[data-page-id="${leaf}"]`)).toBeVisible();
  await expect(tree.locator(".page-nav")).toHaveCount(3);
  await expect(nav.locator(`[data-page-id="${sibling}"], [data-page-id="${outside}"], [data-page-id="${top}"]`)).toHaveCount(0);
  await expect(nav.getByRole("status").filter({ hasText: `Seitenbaum auf „Garten ${tag}“ fokussiert` })).toHaveCount(1);
  // The path: the space, the page above, the focused page (not a button).
  await expect(path.getByRole("button")).toHaveText([spaceCrumb, `Projekte ${tag}`]);
  await expect(path.locator('[aria-current="location"]')).toHaveText(`Garten ${tag}`);

  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    await page.screenshot({ path: `test-results/sidebar-branch/${testInfo.project.name}-${scheme}.png` });
  }
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });

  // "←": one level up, the parent the root now.
  await nav.getByRole("button", { name: `Zurück zu „Projekte ${tag}“` }).click();
  tree = focusedTree(`Projekte ${tag}`);
  await expect(tree).toBeVisible();
  await expect(tree.locator(`[data-page-id="${branch}"]`)).toBeVisible();
  await expect(tree.locator(`[data-page-id="${sibling}"]`)).toBeVisible();
  await expect(path.getByRole("button")).toHaveText([spaceCrumb]);
  await expect(path.locator('[aria-current="location"]')).toHaveText(`Projekte ${tag}`);

  // Kept on this device over a reload.
  await page.reload();
  await expect(page.locator(".tiptap")).toBeVisible();
  await openNav();
  await expect(focusedTree(`Projekte ${tag}`)).toBeVisible();
  await expect(nav.locator(`[data-page-id="${outside}"]`)).toHaveCount(0);

  // "×": the whole tree again, the way to the branch unfolded.
  await nav.getByRole("button", { name: "Fokus beenden – ganzen Seitenbaum zeigen" }).click();
  await expect(nav.locator(".tree-branch")).toHaveCount(0);
  await expect(nav.locator(`[data-page-id="${outside}"]`)).toBeVisible();
  await expect(nav.locator(`[data-page-id="${top}"]`)).toBeVisible();

  // A page opened outside the branch leaves it, with a hint and a way back.
  // (Phones: the drawer closes like a dialog; the page menu is behind it.)
  if (mobile) {
    await page.keyboard.press("Escape");
    await expect(page.locator(".app-shell.nav-open")).toHaveCount(0);
  }
  await focusHere(`Garten ${tag}`, branch);
  await expect(focusedTree(`Garten ${tag}`)).toBeVisible();
  await page.evaluate((id) => (location.hash = `page=${id}`), outside);
  await expect(page.locator(".toast")).toContainText(`„Draußen ${tag}“ liegt nicht unter „Garten ${tag}“`);
  await openNav();
  await expect(nav.locator(".tree-branch")).toHaveCount(0);
  await expect(nav.locator(`.page-nav.selected[data-page-id="${outside}"]`)).toBeVisible();

  if (!mobile) {
    // Esc in the focused tree shows the whole tree, the focus on the same page.
    await page.locator(".toast").getByRole("button", { name: "Wieder fokussieren" }).click();
    tree = focusedTree(`Garten ${tag}`);
    await tree.locator(`[data-page-id="${branch}"]`).focus();
    await page.keyboard.press("Escape");
    await expect(nav.locator(".tree-branch")).toHaveCount(0);
    await expect(nav.locator(`.page-nav[data-page-id="${branch}"]`)).toBeFocused();
  }
  // Not focused any more: a reload shows the whole tree.
  await page.reload();
  await expect(page.locator(".tiptap")).toBeVisible();
  await openNav();
  await expect(nav.locator(".tree-branch")).toHaveCount(0);
  expect(errors).toEqual([]);
});
