import { test, expect, type Locator, type Page } from "@playwright/test";

// #642: on a phone every image of an editable document looked selected –
// the resize handles (blue bars at the sides, squares at the corners)
// showed on all of them at once, as a frame. They show only on the image
// the person selected (a tap), on phones and desktop alike; a record's
// content (bottom sheet on a phone) and a normal page as control.
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
// TEST_SHOTS_DIR=<dir>: screenshots of each step, for a look at them.
const shots = process.env.TEST_SHOTS_DIR;

// Taken through the DevTools protocol: page.screenshot() with the phone's
// emulation changes the viewport for a moment, and the editor reads the
// selection anew – the tapped image would no longer be selected in it.
async function shot(page: Page, name: string) {
  if (!shots) return;
  const cdp = await page.context().newCDPSession(page);
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
  await cdp.detach();
  const { writeFileSync } = await import("node:fs");
  writeFileSync(`${shots}/${name}.png`, Buffer.from(data, "base64"));
}

async function picture(page: Page, color: string) {
  return page.evaluate((color) => {
    const canvas = document.createElement("canvas");
    canvas.width = 300;
    canvas.height = 160;
    const context = canvas.getContext("2d")!;
    context.fillStyle = color;
    context.fillRect(0, 0, 300, 160);
    return canvas.toDataURL("image/png").split(",")[1];
  }, color);
}

// How selected an image looks: the opacity of its resize handles and any
// outline, border or shadow around the image, its box or its container.
function looks(image: Locator) {
  return image.evaluate((img) => {
    const container = img.closest("[data-resize-container]")!;
    const frames = [img, img.closest("[data-resize-wrapper]")!, container].map((el) => {
      const s = getComputedStyle(el);
      return [s.outlineStyle === "none" ? "none" : `${s.outlineStyle} ${s.outlineWidth}`, s.borderTopStyle === "none" ? "none" : s.borderTopWidth, s.boxShadow].join("|");
    });
    const handles = [...container.querySelectorAll("[data-resize-handle]")].map((h) => Number(getComputedStyle(h).opacity));
    return {
      handles: handles.length ? Math.max(...handles) : -1,
      frames: frames.join(" / "),
      selected: container.classList.contains("ProseMirror-selectednode"),
    };
  });
}
const unselected = { handles: 0, frames: "none|none|none / none|none|none / none|none|none", selected: false };

test("images look selected only when tapped or clicked, in a record and on a page", async ({ page }, info) => {
  test.setTimeout(150_000);
  const phone = info.project.name === "mobile";
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await command({ action: "profile.onboarded" });
  await page.goto("about:blank");
  const blue = await picture(page, "#4f70d5"),
    orange = await picture(page, "#d5704f");
  const upload = async (pageId: string, name: string, data: string, rowId?: string) => {
    const response = await page.request.post("/api/upload", {
      headers: { origin },
      multipart: { pageId, ...(rowId ? { rowId } : {}), file: { name, mimeType: "image/png", buffer: Buffer.from(data, "base64") } },
    });
    expect(response.ok(), await response.text()).toBe(true);
    return (await response.json()).url as string;
  };
  const { htmlState } = await import("../../lib/document-server");
  const content = (one: string, two: string) =>
    Buffer.from(htmlState(`<p>Anfang</p><img src="${one}" alt="Eins"><p>Mitte</p><img src="${two}" alt="Zwei"><p>Ende</p>`)).toString("base64");

  // A record with two images in its content.
  const db = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Bilder ${info.project.name} ${Date.now()}`, kind: "database" });
  const row = await command({ action: "row.create", pageId: db.id, cells: { title: "Mit Bildern" } });
  const rowImages = [await upload(db.id, "eins.png", blue, row.id), await upload(db.id, "zwei.png", orange, row.id)];
  await command({
    action: "row.document.sync",
    pageId: db.id,
    rowId: row.id,
    generation: (await (await page.request.get(`/api/pages/${db.id}/rows/${row.id}`)).json()).generation,
    update: content(rowImages[0], rowImages[1]),
  });
  // A normal page with two images.
  const p = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Seite mit Bildern ${Date.now()}` });
  const pageImages = [await upload(p.id, "eins.png", blue), await upload(p.id, "zwei.png", orange)];
  await command({
    action: "document.sync",
    pageId: p.id,
    generation: (await (await page.request.get(`/api/pages/${p.id}`)).json()).generation,
    update: content(pageImages[0], pageImages[1]),
  });

  for (const [kind, address] of [
    ["record", `/#page=${db.id}&row=${row.id}`],
    ["page", `/#page=${p.id}`],
  ] as const) {
    await page.goto("about:blank");
    await page.goto(address);
    const editor = kind === "record" ? page.locator(".modal.record-dialog .ProseMirror") : page.getByLabel("Dokumentinhalt", { exact: true });
    const one = editor.locator('img[alt="Eins"]'),
      two = editor.locator('img[alt="Zwei"]');
    await expect(two).toBeVisible({ timeout: 30_000 });
    await expect(editor).toHaveAttribute("contenteditable", "true");
    await expect.poll(() => one.evaluate((img: HTMLImageElement) => img.naturalWidth), { timeout: 15_000 }).toBe(300);
    await one.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400); // the sheet's opening, the handles' fade
    // Opened: no image looks selected.
    expect(await looks(one), `${kind}: first image on opening`).toEqual(unselected);
    expect(await looks(two), `${kind}: second image on opening`).toEqual(unselected);
    await shot(page, `${kind}-${info.project.name}-opened`);

    // Tapped (clicked): only that image is selected.
    if (phone) await one.tap();
    else await one.click();
    await expect.poll(() => looks(one), `${kind}: the tapped image`).toMatchObject({ handles: 1, selected: true });
    await page.waitForTimeout(300);
    expect(await looks(two), `${kind}: the other image`).toEqual(unselected);
    await shot(page, `${kind}-${info.project.name}-tapped`);

    // A tap into the text deselects it – no handles left behind (a
    // touch's :hover stays where the finger was).
    const text = editor.locator("p", { hasText: "Ende" });
    if (phone) await text.tap();
    else {
      await text.click();
      await page.mouse.move(0, 0);
    }
    await expect.poll(() => looks(one), `${kind}: deselected`).toEqual(unselected);
    expect(await looks(two)).toEqual(unselected);
  }
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: p.id });
  await command({ action: "page.delete", pageId: db.id });
});
