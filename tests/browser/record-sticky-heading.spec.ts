import { test, expect } from "@playwright/test";

// Issue #139: in a long record (centred dialog or bottom sheet, side panel,
// full page) title, actions and close button stay at the dialog's top edge
// while the content scrolls; a thin line below them appears only once the
// content has scrolled.
test("the record's heading stays at the top while the content scrolls", async ({ page }, info) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  // Past the introduction a new demo account sees first.
  await command({ action: "profile.onboarded" });
  let html = "<h1>Anfang</h1>";
  for (let i = 0; i < 40; i++) html += `<p>Absatz ${i} mit etwas Text, damit der Eintrag lang wird.</p>`;
  const db = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `Kopfzeile ${info.project.name} ${Date.now()}`,
    kind: "database",
  });
  const row = await command({ action: "row.create", pageId: db.id, cells: { title: "Langer Eintrag" } });

  for (const mode of ["center", "side", "full"]) {
    const current = await (await page.request.get(`/api/pages/${db.id}`)).json();
    await command({
      action: "database.update",
      pageId: db.id,
      version: current.database.version,
      fields: [{ id: "title", name: "Name", type: "text" }],
      views: [{ id: "table", name: "Tabelle", type: "table", filters: [], sorts: [], recordOpen: mode }],
    });
    await page.goto("about:blank");
    await page.goto(`/#page=${db.id}&row=${row.id}`);
    const dialog = page.locator(".modal.record-dialog");
    const editor = dialog.locator(".ProseMirror.document-editor");
    await expect(editor).toBeVisible();
    if (mode === "center") {
      await editor.evaluate((el, html) => {
        (el as HTMLElement & { editor: TiptapLike }).editor.chain().insertContent(html).run();
      }, html);
    }
    await expect.poll(() => editor.locator("p").count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(40);
    await page.waitForTimeout(400); // the opening animation
    const heading = dialog.locator(".modal-heading");
    const close = dialog.getByRole("button", { name: "Schließen", exact: true });

    // At the top: no line below the heading.
    await dialog.evaluate((el) => (el.scrollTop = 0));
    await expect(heading).not.toHaveAttribute("data-stuck");
    const line = () => heading.evaluate((el) => getComputedStyle(el).boxShadow);
    const plain = await line();
    const before = (await heading.boundingBox())!;

    // Scrolled far down: the heading stays where it was, on top of the
    // content, and gets its line.
    await dialog.evaluate((el) => (el.scrollTop = el.scrollHeight));
    expect(await dialog.evaluate((el) => el.scrollTop), `${mode} scrolls`).toBeGreaterThan(300);
    await expect(heading).toHaveAttribute("data-stuck", "true");
    await expect.poll(line).not.toBe(plain);
    const after = (await heading.boundingBox())!;
    expect(Math.abs(after.y - before.y), `${mode}: heading moved`).toBeLessThan(2);
    await expect(dialog.getByRole("heading", { name: "Eintrag", exact: true })).toBeInViewport();
    await expect(close).toBeInViewport({ ratio: 1 });
    // Nothing of the content shows through the heading.
    const box = (await close.boundingBox())!;
    const hit = await page.evaluate(
      ([x, y]) => !!document.elementFromPoint(x, y)?.closest(".modal-heading"),
      [box.x + box.width / 2, box.y + box.height / 2],
    );
    expect(hit, `${mode}: close button on top`).toBe(true);
    const actions = dialog.locator(".modal-heading-actions");
    await expect(actions).toBeInViewport();

    // Back at the top the line goes again.
    await dialog.evaluate((el) => (el.scrollTop = 0));
    await expect(heading).not.toHaveAttribute("data-stuck");
    await expect.poll(line).toBe(plain);

    // Scrolled again, the close button closes the record.
    await dialog.evaluate((el) => (el.scrollTop = el.scrollHeight));
    await expect(heading).toHaveAttribute("data-stuck", "true");
    await close.click();
    await expect(dialog).toHaveCount(0);
  }
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: db.id });
});

// The editor instance on its element (Tiptap sets it), as far as used here.
type Chain = { insertContent: (html: string) => Chain; run: () => boolean };
type TiptapLike = { chain: () => Chain };
