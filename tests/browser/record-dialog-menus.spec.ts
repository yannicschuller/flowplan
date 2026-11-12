import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

// Issue #232: menus and pickers that float above the content work inside a
// database record. A record opens in a modal dialog, which turns pointer
// events off on <body> and takes a press outside its content as one outside
// the dialog – a menu rendered in <body> took no clicks there, and its own
// "click elsewhere" closed it. The meeting block's settings and attendee
// picker, and the code block's options, stay in the dialog now; Escape
// closes the menu, not the record. The meeting's status is answered by the
// test (no transcription service needed).
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
type Tiptap = { commands: { insertContent: (html: string) => boolean } };

async function openRecord(page: Page, html: string) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const db = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Einträge ${Date.now()}`, kind: "database" });
  const row = await command({ action: "row.create", pageId: db.id, cells: { title: "Kundengespräch" } });
  await page.goto(`/#page=${db.id}&row=${row.id}`);
  const welcome = page.getByRole("dialog", { name: "Willkommen bei Flowplan" });
  await welcome.waitFor({ timeout: 3000 }).then(() => page.keyboard.press("Escape"), () => {});
  const dialog = page.locator(".modal.record-dialog");
  const editor = dialog.locator(".ProseMirror");
  await expect(editor).toBeVisible();
  await editor.evaluate((el, content) => (el as HTMLElement & { editor: Tiptap }).editor.commands.insertContent(content), html);
  await page.waitForTimeout(300); // the dialog's opening animation
  return { dialog, boot };
}

async function meetingInRecord(page: Page) {
  const meetingId = randomUUID();
  const status = { id: meetingId, status: "new", error: null, durationMs: 0, sessions: [], audio: [], audioUntil: null, summarizedAt: null, consentRequired: false, transcription: true };
  await page.route(`**/api/meetings/${meetingId}`, (r) => r.fulfill({ json: status }));
  await page.route("**/api/meetings/settings?*", (r) => r.fulfill({ json: { consentRequired: false, consentText: "", defaultConsentText: "", transcription: true } }));
  await page.route("**/api/meetings/events?*", (r) => r.fulfill({ json: { events: [] } }));
  const html =
    `<div data-meeting="${meetingId}" data-meeting-title="Kundengespräch" data-meeting-date="2026-11-11" data-meeting-instructions="auto" class="meeting-block"><p class="meeting-title">Kundengespräch</p><div class="meeting-parts">` +
    `<div data-meeting-part="summary"><p></p></div><div data-meeting-part="agenda"><p>Budget</p></div><div data-meeting-part="transcript"><p></p></div></div></div><p></p>`;
  const { dialog, boot } = await openRecord(page, html);
  const block = dialog.locator(".meeting-block").first();
  await expect(block.locator(".meeting-head")).toBeVisible();
  return { dialog, block, boot };
}

test("meeting block in a record: the settings menu and its Language level take clicks (#232)", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Phones show the menu as a bottom sheet of its own.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { dialog, block } = await meetingInRecord(page);
  const gear = block.getByRole("button", { name: "Einstellungen der Besprechung" });
  await gear.click();
  const menu = page.getByRole("menu", { name: "Einstellungen der Besprechung" });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: /^Sprache/ }).click();
  const english = menu.getByRole("menuitemradio", { name: "English" });
  await expect(english).toBeVisible();
  await english.click();
  await expect(menu).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await gear.click();
  await expect(menu.getByRole("menuitem", { name: /^Sprache/ })).toContainText("English");
  // In the dialog, not behind its focus trap and pointer barrier.
  expect(await menu.evaluate((el) => !!el.closest(".modal.record-dialog"))).toBe(true);
  await page.screenshot({ path: "test-results/record-meeting-menu.png" });
  // Escape closes the menu, the record stays open.
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(gear).toBeFocused();
  expect(errors).toEqual([]);
});

test("meeting block in a record: + picks a member, Escape closes only the picker (#232)", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Phones show the picker as a bottom sheet of its own.");
  const { dialog, block, boot } = await meetingInRecord(page);
  const me = (boot.members as { id: string; name: string }[])[0].name;
  // Chrome records only the microphone unless "Record all participants" (#199).
  await expect(block.locator(".meeting-mic-only-hint")).toHaveText("Nur dein Mikrofon – wähle „Alle Teilnehmenden aufnehmen“, um die anderen mit aufzunehmen.");
  const plus = block.getByRole("button", { name: "Teilnehmende hinzufügen" });
  await plus.click();
  const picker = page.getByRole("dialog", { name: "Teilnehmende hinzufügen" });
  await expect(picker.getByRole("combobox")).toBeFocused();
  await picker.getByRole("option", { name: new RegExp(me) }).first().click();
  await expect(block.locator(".meeting-meta")).toContainText(`@${me}`);
  await expect(dialog).toBeVisible();
  // The picker stays for further attendees; Escape closes it, not the record.
  await expect(picker).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(plus).toBeFocused();
});

test("code block in a record: the options panel takes clicks (#232)", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "One run covers it.");
  const { dialog } = await openRecord(page, `<pre><code class="language-javascript">let a = 1;\nlet b = 2;</code></pre><p></p>`);
  const code = dialog.locator("pre").first();
  await code.hover();
  await dialog.getByRole("button", { name: "Codeblock-Optionen" }).first().click();
  const panel = page.getByRole("dialog", { name: "Codeblock-Optionen" });
  await expect(panel).toBeVisible();
  const numbers = panel.getByRole("checkbox", { name: "Zeilennummern" });
  const before = await numbers.isChecked();
  await numbers.click();
  await expect(numbers).toBeChecked({ checked: !before });
  await expect(panel).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(dialog).toBeVisible();
});
