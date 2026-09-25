import { test, expect } from "@playwright/test";

test("images are resized by their handle and keep the size", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Mouse resize on desktop.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", {
      headers: { origin },
      data,
    });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const p = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `Bildgröße ${Date.now()}`,
  });
  const read = async () =>
    (await page.request.get(`/api/pages/${p.id}`)).json();
  await page.goto("/#home");
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 400;
    canvas.height = 200;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#4f70d5";
    context.fillRect(0, 0, 400, 200);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  const upload = await page.request.post("/api/upload", {
    headers: { origin },
    multipart: {
      pageId: p.id,
      file: {
        name: "plan.png",
        mimeType: "image/png",
        buffer: Buffer.from(png, "base64"),
      },
    },
  });
  const { url } = await upload.json();
  const { htmlState } = await import("../../lib/document-server");
  await command({
    action: "document.sync",
    pageId: p.id,
    generation: (await read()).generation,
    update: Buffer.from(
      htmlState(`<p>Plan</p><img src="${url}" alt="Plan">`),
    ).toString("base64"),
  });
  await page.goto(`/#page=${p.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  const image = editor.locator('img[alt="Plan"]');
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBe(400);
  await image.hover();
  const handle = editor.locator('[data-resize-handle="right"]');
  const box = (await handle.boundingBox())!;
  const before = (await image.boundingBox())!.width;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 150, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(async () => (await image.boundingBox())!.width)
    .toBeLessThan(before - 100);
  await expect
    .poll(async () => {
      const width = /width="(\d+)"/.exec((await read()).html)?.[1];
      return width ? Number(width) : Infinity;
    })
    .toBeLessThan(before - 100);
  const stored = Number(/width="(\d+)"/.exec((await read()).html)![1]);
  await page.reload();
  await expect
    .poll(async () =>
      Math.round(
        (await page
          .getByLabel("Dokumentinhalt", { exact: true })
          .locator('img[alt="Plan"]')
          .boundingBox())!.width,
      ),
    )
    .toBe(stored);
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: p.id });
});
