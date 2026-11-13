import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

// Handles of hidden and boxed blocks (#252): blocks inside a closed toggle
// have no handle (Chrome still lays out the content of a closed <details>,
// so a hidden block's handle showed over the visible blocks below it) –
// also after a reload with the stored closed state and with images inside.
// The meeting block has one handle at its header row, none for its parts,
// and its inner blocks take the pointer only right of its handle.
const RESULTS = process.env.BLOCK_HANDLE_SHOTS || "test-results";
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

async function fixture(page: Page, title: string, html: (upload: string) => string) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await command({ action: "profile.onboarded" });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const host = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, kind: "document", title });
  // A tall picture inside the toggle: its laid-out rectangle reaches far down.
  await page.goto("/#home");
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 480;
    canvas.height = 320;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#4f70d5";
    context.fillRect(0, 0, 480, 320);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  const upload = await page.request.post("/api/upload", {
    headers: { origin },
    multipart: { pageId: host.id, file: { name: "bild.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") } },
  });
  const { url } = await upload.json();
  const { htmlState } = await import("../../lib/document-server");
  const generation = (await (await page.request.get(`/api/pages/${host.id}`)).json()).generation;
  await command({ action: "document.sync", pageId: host.id, generation, update: Buffer.from(htmlState(html(url))).toString("base64") });
  return host;
}
const center = async (page: Page, selector: string) => {
  const box = (await page.locator(selector).first().boundingBox())!;
  return box.y + box.height / 2;
};

test("no handles for blocks in a closed toggle: each visible block shows its own handle, also after a reload (#252)", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Hovering with a mouse: desktop.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const host = await fixture(
    page,
    `Zugeklappt ${Date.now()}`,
    (url) =>
      '<details data-heading="2"><summary>HISTORY</summary><div>' +
      `<p>Versteckt eins</p><img src="${url}" alt="Verstecktes Bild"><p>Versteckt zwei</p>` +
      "<details><summary>Innen</summary><div><p>Ganz innen</p></div></details>" +
      "</div></details>" +
      "<p>Meeting September 14, 2026 9:00 AM</p>" +
      '<details data-heading="2"><summary>HISTORY II</summary><div><p>Zweiter Inhalt</p></div></details>' +
      "<p>Ende</p>",
  );
  await page.goto(`/#page=${host.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor.getByText("Ende", { exact: true })).toBeVisible({ timeout: 20_000 });
  const history = editor.locator(":scope > details.toggle-block").first();
  await expect(history.locator("img")).toBeVisible();
  // Close the first toggle, then reload: the closed state comes from storage.
  await history.locator(":scope > summary .toggle-title").hover();
  await history.locator(":scope > summary").getByRole("button", { name: "Zuklappen" }).click();
  await expect(history).not.toHaveAttribute("open", "");
  await page.reload();
  await expect(editor.getByText("Ende", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(history).not.toHaveAttribute("open", "");
  // Let the picture load in the closed toggle, as after a real reload.
  await expect.poll(() => history.locator("img").evaluate((img: HTMLImageElement) => img.complete && img.naturalHeight > 0)).toBe(true);

  const handles = page.locator(".document-block-handle");
  await expect(handles).not.toHaveCount(0);
  for (const hidden of ["Versteckt eins", "Versteckt zwei", "Verstecktes Bild", "Innen", "Ganz innen"])
    await expect(page.getByRole("button", { name: new RegExp(`^Blockaktionen: .* · ${hidden}$`) })).toHaveCount(0);

  const visible: [string, string, string][] = [
    ["Toggle · HISTORY", ":scope > details.toggle-block >> nth=0 >> :scope > summary .toggle-title", ":scope > details.toggle-block >> nth=0 >> :scope > summary"],
    ["Absatz · Meeting September 14, 2026 9:00 AM", ':scope > p:has-text("Meeting September")', ':scope > p:has-text("Meeting September")'],
    ["Toggle · HISTORY II", ":scope > details.toggle-block >> nth=1 >> :scope > summary .toggle-title", ":scope > details.toggle-block >> nth=1 >> :scope > summary"],
    ["Absatz · Ende", ':scope > p:has-text("Ende")', ':scope > p:has-text("Ende")'],
  ];
  for (const [label, target, line] of visible) {
    await editor.locator(target).hover();
    const shown = page.locator(".document-block-handle.hovered");
    await expect(shown).toHaveCount(1);
    await expect(shown).toHaveAttribute("aria-label", `Blockaktionen: ${label}`);
    const box = (await shown.boundingBox())!;
    const text = (await editor.locator(line).boundingBox())!;
    // Beside the first line of its block, left of it.
    expect(Math.abs(box.y + box.height / 2 - (text.y + Math.min(text.height, 28) / 2)), label).toBeLessThan(8);
    expect(box.x + box.width, label).toBeLessThanOrEqual(text.x + 4);
  }
  await editor.locator(":scope > details.toggle-block >> nth=1 >> :scope > summary .toggle-title").hover();
  await page.screenshot({ path: `${RESULTS}/block-handles-closed-toggle.png`, clip: { x: 0, y: 0, width: 1440, height: 600 } });
  expect(errors).toEqual([]);
});

test("the meeting block: one handle at its header, none for its parts, inner blocks right of it (#252)", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Hovering with a mouse: desktop.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const meetingId = randomUUID();
  const date = "2026-11-11";
  await page.route(`**/api/meetings/${meetingId}`, (r) =>
    r.fulfill({
      json: {
        id: meetingId,
        status: "done",
        error: null,
        durationMs: 60000,
        sessions: [{ n: 1, offsetMs: 0, durationMs: 60000, state: "done", by: "someone", byName: "Ada" }],
        audio: [],
        audioUntil: null,
        summarizedAt: Date.now(),
        consentRequired: false,
        transcription: true,
      },
    }),
  );
  await page.route("**/api/meetings/settings?*", (r) =>
    r.fulfill({ json: { consentRequired: false, consentText: "", defaultConsentText: "", transcription: true } }),
  );
  await page.route("**/api/meetings/events?*", (r) => r.fulfill({ json: { events: [] } }));
  const host = await fixture(page, `Besprechung ${Date.now()}`, () => "<p>Davor</p>");
  await page.goto(`/#page=${host.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor.getByText("Davor", { exact: true })).toBeVisible({ timeout: 20_000 });
  const html =
    `<div data-meeting="${meetingId}" data-meeting-title="Wochentermin" data-meeting-date="${date}" data-meeting-attendees="[]" data-meeting-instructions="auto" class="meeting-block"><p class="meeting-title">Wochentermin</p><div class="meeting-parts">` +
    `<div data-meeting-part="summary"><h3>Aufgaben</h3><p>Budget umsetzen</p></div>` +
    `<div data-meeting-part="agenda"><p>Budget</p></div><div data-meeting-part="transcript"></div></div></div><p>Danach</p>`;
  await editor.getByText("Davor", { exact: true }).click();
  await page.keyboard.press("End");
  await page.evaluate((content) => {
    const dom = document.querySelector(".page-layout .ProseMirror") as HTMLElement & { editor: { commands: { insertContentAt: (pos: number, html: string) => boolean }; state: { doc: { content: { size: number } } } } };
    dom.editor.commands.insertContentAt(dom.editor.state.doc.content.size, content);
  }, html);
  const block = editor.locator(".meeting-block").first();
  await expect(block.locator(".meeting-head")).toBeVisible();

  const handle = page.getByRole("button", { name: "Blockaktionen: Besprechung · Wochentermin", exact: true });
  await expect(handle).toHaveCount(1);
  await expect(page.getByRole("button", { name: /^Blockaktionen: (meeting|Besprechungs)/ })).toHaveCount(0);
  // The summary's blocks keep their handles.
  await expect(page.getByRole("button", { name: "Blockaktionen: Überschrift · Aufgaben", exact: true })).toHaveCount(1);

  // The header row shows the meeting's handle, beside that row.
  await block.locator(".meeting-head-row").hover({ position: { x: 40, y: 8 } });
  await expect(page.locator(".document-block-handle.hovered")).toHaveAttribute("aria-label", "Blockaktionen: Besprechung · Wochentermin");
  const box = (await handle.boundingBox())!;
  expect(Math.abs(box.y + box.height / 2 - (await center(page, ".meeting-head-row")))).toBeLessThan(4);
  // On its way to the handle, the pointer passes left of the inner blocks: still the meeting's.
  const heading = block.locator("h3", { hasText: "Aufgaben" });
  const headingBox = (await heading.boundingBox())!;
  await page.mouse.move(box.x + box.width + 4, headingBox.y + headingBox.height / 2);
  await expect(page.locator(".document-block-handle.hovered")).toHaveAttribute("aria-label", "Blockaktionen: Besprechung · Wochentermin");
  // Over the heading's text: the heading's handle.
  await heading.hover();
  await expect(page.locator(".document-block-handle.hovered")).toHaveAttribute("aria-label", "Blockaktionen: Überschrift · Aufgaben");

  // The menu is the meeting's: its kind as the heading, duplicate and delete.
  await block.locator(".meeting-head-row").hover({ position: { x: 40, y: 8 } });
  await handle.click();
  const menu = page.getByRole("menu", { name: "Besprechung · Wochentermin" });
  await expect(menu).toBeVisible();
  await expect(menu.locator(".block-menu-kind")).toHaveText("Besprechung");
  await expect(menu.getByRole("menuitem", { name: "Duplizieren" })).toBeEnabled();
  await expect(menu.getByRole("menuitem", { name: "Löschen" })).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  // Dragged by its handle, the whole block moves below "Danach".
  await block.locator(".meeting-head-row").hover({ position: { x: 40, y: 8 } });
  const from = (await handle.boundingBox())!;
  const after = (await editor.locator(":scope > p", { hasText: "Danach" }).boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(after.x + 40, after.y + after.height - 2, { steps: 10 });
  await expect(page.locator(".document-block-drop")).toBeVisible();
  await page.mouse.up();
  await expect.poll(() => editor.evaluate((el) => [...el.children].map((c) => (c.matches(".meeting-block, :has(> .meeting-block)") ? "meeting" : c.textContent?.trim())).filter(Boolean))).toEqual(["Davor", "Danach", "meeting"]);
  await expect(editor.locator(".meeting-block h3", { hasText: "Aufgaben" })).toHaveCount(1);
  expect(errors).toEqual([]);
});
