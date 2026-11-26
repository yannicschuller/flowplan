import { test, expect, type Page } from "@playwright/test";

// Files uploaded straight into a space (#569): files dragged from the
// computer onto a page in the sidebar become sub-pages of it, onto the
// space pages at its top level – one page per file, titled with the file's
// name, holding its block. "Datei hochladen …" in the space's menu does the
// same through the file picker. Dragging pages in the tree is unchanged.

// Files are dragged from a computer onto the sidebar that stays in view:
// the wide window.
test.beforeEach(({}, info) => test.skip(info.project.name !== "desktop", "Dragging files from the computer onto the sidebar: desktop."));

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const pdf = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

async function setup(page: Page) {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const space = boot.spaces[0] as { id: string; name: string };
  const create = async (title: string) =>
    (
      await (
        await page.request.post("/api/command", {
          headers: { origin },
          data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: space.id, title, kind: "document" },
        })
      ).json()
    ).id as string;
  const host = await create(`Ablage ${Date.now()}`);
  await page.goto(`/#page=${host}`);
  await expect(page.locator(`.page-nav[data-page-id="${host}"]`)).toBeVisible({ timeout: 20_000 });
  return { origin, boot, space, host, create };
}

// Files dragged from the desktop over an element and dropped there.
async function dropFiles(page: Page, selector: string, files: { name: string; type: string; data: Buffer }[], drop = true) {
  await page.locator(selector).first().evaluate(
    (el, { list, drop }) => {
      const data = new DataTransfer();
      for (const f of list) data.items.add(new File([Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0))], f.name, { type: f.type }));
      const box = el.getBoundingClientRect();
      const at = { clientX: box.left + 20, clientY: box.top + box.height / 2, bubbles: true, cancelable: true, dataTransfer: data };
      el.dispatchEvent(new DragEvent("dragenter", at));
      el.dispatchEvent(new DragEvent("dragover", at));
      if (drop) el.dispatchEvent(new DragEvent("drop", at));
    },
    { list: files.map((f) => ({ ...f, data: f.data.toString("base64") })), drop },
  );
}

const childTitles = async (page: Page, parentId: string | null, spaceId: string) => {
  const boot = await (await page.request.get("/api/bootstrap")).json();
  return (boot.pages as { title: string; parent_id: string | null; space_id: string; deleted_at?: string | null }[])
    .filter((p) => p.parent_id === parentId && p.space_id === spaceId && !p.deleted_at)
    .map((p) => p.title);
};

test("files dropped on a page in the sidebar become its sub-pages, one per file", async ({ page }) => {
  const { host, space } = await setup(page);
  const row = `.page-nav[data-page-id="${host}"]`;
  // While dragged over, the page shows it takes the files.
  await dropFiles(page, row, [{ name: "Grundriss.png", type: "image/png", data: png }], false);
  await expect(page.locator(row)).toHaveClass(/file-drop/);
  await dropFiles(page, row, [
    { name: "Grundriss.png", type: "image/png", data: png },
    { name: "Angebot 2026.pdf", type: "application/pdf", data: pdf },
  ]);
  await expect(page.locator(row)).not.toHaveClass(/file-drop/);
  const panel = page.getByRole("region", { name: "Dateien als Seiten hochladen" });
  await expect(panel.getByText("2 Seiten angelegt")).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => childTitles(page, host, space.id)).toEqual(expect.arrayContaining(["Grundriss", "Angebot 2026"]));
  // The tree shows them below the page, and the page holds its file.
  const child = page.locator(".page-nav", { hasText: "Angebot 2026" });
  await expect(child).toBeVisible();
  await panel.getByRole("button", { name: "„Grundriss“ öffnen" }).click();
  await expect(page.locator(".page-content .ProseMirror img[src^='/api/files/']").first()).toBeVisible({ timeout: 20_000 });
});

test("files dropped on a space land at its top level; the space menu uploads through the picker", async ({ page }) => {
  const { space } = await setup(page);
  const section = `.nav-section[data-space-id="${space.id}"] .nav-section-title`;
  await dropFiles(page, section, [{ name: "Notizen.pdf", type: "application/pdf", data: pdf }], false);
  await expect(page.locator(`.nav-section[data-space-id="${space.id}"]`)).toHaveClass(/space-file-drop/);
  await dropFiles(page, section, [{ name: "Notizen.pdf", type: "application/pdf", data: pdf }]);
  await expect.poll(() => childTitles(page, null, space.id)).toContain("Notizen");
  await page.getByRole("button", { name: `Bereich ${space.name} verwalten` }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: "Datei hochladen …" }).click();
  await (await chooser).setFiles([{ name: "Foto vom Whiteboard.png", mimeType: "image/png", buffer: png }]);
  await expect.poll(() => childTitles(page, null, space.id)).toContain("Foto vom Whiteboard");
});

test("dragging a page onto another in the tree still moves it", async ({ page }) => {
  const { host, create, space } = await setup(page);
  const moved = await create(`Verschieben ${Date.now()}`);
  await page.reload();
  const source = page.locator(`.page-nav[data-page-id="${moved}"]`);
  const target = page.locator(`.page-nav[data-page-id="${host}"]`);
  await expect(source).toBeVisible({ timeout: 20_000 });
  await source.dragTo(target);
  await expect.poll(async () => {
    const boot = await (await page.request.get("/api/bootstrap")).json();
    return (boot.pages as { id: string; parent_id: string | null }[]).find((p) => p.id === moved)?.parent_id;
  }).toBe(host);
  // No upload panel: a page is no file.
  await expect(page.getByRole("region", { name: "Dateien als Seiten hochladen" })).toHaveCount(0);
  expect(await childTitles(page, host, space.id)).toHaveLength(1);
});
