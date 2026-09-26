import { test, expect } from "@playwright/test";

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
async function setup(page: import("@playwright/test").Page, title: string, kind = "document") {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const created = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title,
    kind,
  });
  return { created, command };
}

test("formats switch off at once, images paste from the clipboard, spoilers cover text", async ({
  page,
  browser,
}, info) => {
  test.skip(info.project.name === "mobile", "Toolbar and clipboard on desktop");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { created, command } = await setup(page, `Extras ${Date.now()}`);
  await page.goto(`/#page=${created.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await editor.click();
  await page.keyboard.type("Formel E=mc");

  // Superscript on and off without typing: the button follows right away.
  const supButton = page.getByTitle("Hochgestellt", { exact: true });
  await supButton.click();
  await expect(supButton).toHaveClass(/active/);
  await supButton.click();
  await expect(supButton).not.toHaveClass(/active/);

  // A new line starts plain: formatting of the line above does not carry
  // over; lists continue with a new item.
  await page.keyboard.press("Enter");
  await page.getByTitle("Fett", { exact: true }).click();
  await page.keyboard.type("fett");
  await page.keyboard.press("Enter");
  await page.keyboard.type("normal");
  await expect(editor.locator("strong", { hasText: "fett" })).toHaveCount(1);
  await expect(editor.locator("strong", { hasText: "normal" })).toHaveCount(0);
  await expect(editor.getByText("normal", { exact: true })).toBeVisible();
  await page.keyboard.press("Enter");
  await page.keyboard.type("- Punkt eins");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Punkt zwei");
  await expect(editor.locator("ul li")).toHaveCount(2);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");

  // "/ " is a plain slash.
  await page.keyboard.press("Enter");
  await page.keyboard.type("a / b");
  await expect(page.locator(".slash-menu")).toHaveCount(0);
  await expect(editor).toContainText("a / b");

  // An image in the clipboard is uploaded and inserted.
  await page.keyboard.press("Enter");
  await page.evaluate(async () => {
    const png = Uint8Array.from(
      atob("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DwnyHhPwMDAwMDAwAtAAX/2Hl5uAAAAABJRU5ErkJggg=="),
      (c) => c.charCodeAt(0),
    );
    const data = new DataTransfer();
    data.items.add(new File([png], "bildschirmfoto.png", { type: "image/png" }));
    const target = document.querySelector(".ProseMirror")!;
    target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(editor.locator('img[src^="/api/files/"]')).toHaveCount(1);

  // Spoiler: hatched while writing, covered for readers until clicked.
  await page.keyboard.press("Enter");
  await page.keyboard.type("Die Lösung ist ");
  await page.getByTitle(/^Verdecken \(Spoiler\)/).click();
  // Toolbar buttons leave the caret in the text.
  await expect(editor).toBeFocused();
  await page.keyboard.type("zweiundvierzig");
  const hidden = editor.locator("[data-spoiler]");
  await expect(hidden).toHaveText("zweiundvierzig");
  // Open while writing in it, covered again once the caret leaves.
  const openBlock = editor.locator("[data-spoiler-open]");
  await expect(openBlock).toHaveCount(1);
  await page.keyboard.press("Enter");
  await page.keyboard.type("Weiter");
  await expect(openBlock).toHaveCount(0);
  await expect(hidden).toHaveCSS("color", "rgba(0, 0, 0, 0)");
  await hidden.click();
  await expect(openBlock).toHaveCount(1);
  await expect(hidden).not.toHaveCSS("color", "rgba(0, 0, 0, 0)");
  await expect
    .poll(async () => (await (await page.request.get(`/api/pages/${created.id}`)).json()).html)
    .toContain("data-spoiler");
  await command({ action: "page.publish", pageId: created.id, enabled: true });
  const token = (await (await page.request.get(`/api/pages/${created.id}`)).json()).page.public_token;
  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto(`${origin}/share/${token}`);
  const spoiler = visitor.locator("[data-spoiler]");
  await expect(spoiler).toHaveCSS("color", "rgba(0, 0, 0, 0)");
  await spoiler.click();
  await expect(spoiler).toHaveAttribute("data-revealed", "");
  await visitor.context().close();
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: created.id });
});

test("whiteboard cards can be covered for everyone and uncovered again", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "Double-click on the canvas");
  const { created, command } = await setup(page, `Verdeckt ${Date.now()}`, "whiteboard");
  await page.goto(`/#page=${created.id}`);
  const canvas = page.locator("svg.wb-canvas, .wb svg").first();
  await expect(canvas).toBeVisible();
  const box = (await canvas.boundingBox())!;
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator(".wb textarea, textarea").first()).toBeFocused();
  await page.keyboard.type("Geheime Idee");
  await page.keyboard.press("Escape");
  const card = page.locator(".wb-item.wb-sticky").first();
  await card.click();
  await page.getByRole("button", { name: "Verdecken" }).click();
  await expect(page.locator(".wb-covered")).toHaveCount(1);
  await expect(page.locator(".wb-item")).not.toContainText("Geheime Idee");
  await page.getByRole("button", { name: "Aufdecken" }).click();
  await expect(page.locator(".wb-item.wb-sticky")).toContainText("Geheime Idee");
  await command({ action: "page.delete", pageId: created.id });
});
