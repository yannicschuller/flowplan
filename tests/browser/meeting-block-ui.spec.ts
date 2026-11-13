import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

// The meeting block's interface (#229, #228, #199 comment): anchored menus
// that float above the content, a calm state after processing, the pickers
// for attendees and the calendar event, the transcript lock and the notes.
// The meeting's status, the workspace settings and the day's events are
// answered by the test (no transcription service needed).
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

type Options = { status?: Record<string, unknown>; settings?: Record<string, unknown> };
async function openMeeting(page: Page, options: Options = {}) {
  const meetingId = randomUUID();
  const date = "2026-11-11";
  const status = {
    id: meetingId,
    status: "done",
    error: null,
    durationMs: 2481000,
    sessions: [{ n: 1, offsetMs: 0, durationMs: 2481000, state: "done", by: "someone", byName: "Ada" }],
    audio: [],
    audioUntil: null,
    summarizedAt: Date.now(),
    consentRequired: false,
    transcription: true,
    ...options.status,
  };
  const settings = { consentRequired: false, consentText: "", defaultConsentText: "Diese Besprechung wird aufgezeichnet.", transcription: true, ...options.settings };
  await page.route(`**/api/meetings/${meetingId}`, (r) => r.fulfill({ json: status }));
  await page.route("**/api/meetings/settings?*", (r) => r.fulfill({ json: settings }));
  await page.route("**/api/meetings/events?*", (r) =>
    r.fulfill({
      json: {
        events: [
          { title: "Wochentermin Produkt", start: `${date}T09:00:00`, end: `${date}T10:00:00`, timed: true, source: "Team-Kalender", pageId: "p1", rowId: "r1", calendar: true },
          { title: "Kundentermin", start: `${date}T14:30:00`, end: `${date}T15:00:00`, timed: true, source: "Kalender", uid: "u1", calendar: true },
          { title: `${date} 08:23 — OK (Flowplan)`, start: `${date}T08:23:00`, end: `${date}T08:23:00`, timed: true, source: "Sync-Log", pageId: "p2", rowId: "r2", calendar: false },
        ],
      },
    }),
  );
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const { id } = await (
    await page.request.post("/api/command", {
      headers: { origin },
      data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Besprechung ${Date.now()}`, kind: "document" },
    })
  ).json();
  await page.goto(`/#page=${id}`);
  const welcome = page.getByRole("dialog", { name: "Willkommen bei Flowplan" });
  await welcome.waitFor({ timeout: 3000 }).then(() => page.keyboard.press("Escape"), () => {});
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await editor.click();
  const segments = [
    ["s1", 3, "Willkommen, heute geht es um das Budget mit Herrn Mayr."],
    ["s2", 14, "Das Budget ist freigegeben."],
    ["s3", 31, "Untertitel im Auftrag des ZDF", true],
  ] as const;
  const html =
    `<div data-meeting="${meetingId}" data-meeting-title="Wochentermin" data-meeting-date="${date}" data-meeting-attendees='[{"name":"Gast Grace"}]' data-meeting-instructions="auto" class="meeting-block"><p class="meeting-title">Wochentermin</p><div class="meeting-parts">` +
    `<div data-meeting-part="summary"><h3>Aufgaben</h3><ul><li><p>Budget umsetzen <sup data-meeting-cite="s2" data-n="1">①</sup> <sup data-meeting-cite="s1" data-n="2" data-cite-start="3">00:03</sup> <sup data-meeting-cite="gone" data-n="3" data-cite-start="3725">1:02:05</sup></p></li></ul></div>` +
    `<div data-meeting-part="agenda"><p>Budget</p></div><div data-meeting-part="transcript">` +
    segments
      .map(([sid, start, text, hidden]) => `<p data-segment="${sid}" data-start="${start}" data-end="${start + 8}" data-speaker="Ada" data-track="me" data-session="1"${hidden ? ' data-hallucination="1"' : ""}>${text}</p>`)
      .join("") +
    `</div></div></div><p></p>`;
  await page.evaluate((content) => {
    const dom = document.querySelector(".page-layout .ProseMirror") as HTMLElement & { editor: { commands: { insertContent: (html: string) => boolean } } };
    dom.editor.commands.insertContent(content);
  }, html);
  const block = page.locator(".meeting-block").first();
  await expect(block.locator(".meeting-head")).toBeVisible();
  return { block, editor, boot };
}

test("the settings menu opens anchored below the gear and closes with Escape, nothing moves", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "The phone's bottom sheet has its own test.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { block } = await openMeeting(page, { status: { audio: [{ session: 1, track: "me", url: "/api/files/x" }] } });
  // Calm after processing: no prominent button, one quiet line.
  await expect(block.locator(".meeting-status-done")).toHaveText("41:21 aufgenommen · transkribiert · zusammengefasst");
  await expect(block.locator(".button.primary")).toHaveCount(0);
  const tabs = await block.locator(".meeting-tabs").boundingBox();
  const gear = block.getByRole("button", { name: "Einstellungen der Besprechung" });
  await expect(gear).toHaveAttribute("aria-haspopup", "menu");
  await gear.click();
  await expect(gear).toHaveAttribute("aria-expanded", "true");
  const menu = page.getByRole("menu", { name: "Einstellungen der Besprechung" });
  await expect(menu).toBeVisible();
  const g = (await gear.boundingBox())!;
  const m = (await menu.boundingBox())!;
  expect(m.y).toBeGreaterThanOrEqual(g.y + g.height);
  expect(m.y - (g.y + g.height)).toBeLessThan(10);
  expect(Math.abs(m.x + m.width - (g.x + g.width))).toBeLessThan(2);
  expect(await block.locator(".meeting-tabs").boundingBox()).toEqual(tabs);
  // Continue first, destructive ones last, red and apart.
  const items = menu.getByRole("menuitem");
  await expect(items.first()).toHaveText("Weiter aufnehmen");
  await expect(menu.getByRole("menuitem", { name: "Audio jetzt löschen …" })).toHaveClass(/danger/);
  await expect(menu.getByRole("menuitem", { name: "Transkript löschen …" })).toHaveClass(/danger/);
  await expect(menu.getByRole("menuitem", { name: /^Sprache/ })).toContainText("Automatisch");
  // A second level, then back with Escape, then closed.
  await menu.getByRole("menuitem", { name: /^Anweisungen/ }).click();
  await expect(menu.getByRole("menuitemradio", { name: "Automatisch" })).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(menu.getByRole("menuitem", { name: /^Anweisungen/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(gear).toBeFocused();
  await expect(gear).toHaveAttribute("aria-expanded", "false");
  expect(await block.locator(".meeting-tabs").boundingBox()).toEqual(tabs);
  // Delete audio asks first.
  await gear.click();
  let asked = "";
  page.once("dialog", (d) => {
    asked = d.message();
    void d.dismiss();
  });
  await page.getByRole("menuitem", { name: "Audio jetzt löschen …" }).click();
  expect(asked).toContain("Audio jetzt löschen?");
  await page.screenshot({ path: "test-results/meeting-block-menu.png" });
  expect(errors).toEqual([]);
});

test("date, attendee chips and + share one centre line (#228)", async ({ page }) => {
  const { block } = await openMeeting(page);
  // The boxes and what is drawn inside them (the date is a form label, whose
  // content forms stack at the top).
  const centres = await block.locator(".meeting-meta > *").evaluateAll((els) =>
    els.map((el) => {
      const box = el.getBoundingClientRect();
      const text = [...el.childNodes].find((n) => n.nodeType === 3 && n.textContent!.trim());
      let inner: DOMRect = el.querySelector("svg")?.getBoundingClientRect() || box;
      if (text) {
        const range = document.createRange();
        range.selectNodeContents(text);
        inner = range.getBoundingClientRect();
      }
      return [box.top + box.height / 2, inner.top + inner.height / 2];
    }),
  );
  expect(centres.length).toBe(3);
  for (const [box, inner] of centres) {
    expect(Math.abs(box - centres[0][0])).toBeLessThanOrEqual(1);
    expect(Math.abs(inner - centres[0][1])).toBeLessThanOrEqual(1.5);
  }
});

test("a failed meeting shows the error with its one action and the admin detail", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "One run covers it.");
  const { block } = await openMeeting(page, { status: { status: "failed", error: "Der Transkriptionsdienst ist nicht erreichbar.", errorDetail: "RangeError: Invalid array length" } });
  await expect(block.getByRole("alert")).toContainText("Der Transkriptionsdienst ist nicht erreichbar.");
  await expect(block.locator(".button.primary")).toHaveCount(1);
  await expect(block.locator(".button.primary")).toHaveText("Erneut verarbeiten");
  await expect(block.locator(".meeting-error-detail")).toHaveText("Details für Admins: RangeError: Invalid array length");
});

test("attendees: search, keyboard, a guest from the typed text", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "One run covers it.");
  const { block, boot } = await openMeeting(page);
  const me = (boot.members as { id: string; name: string }[])[0].name;
  const plus = block.getByRole("button", { name: "Teilnehmende hinzufügen" });
  const tabs = await block.locator(".meeting-tabs").boundingBox();
  await plus.click();
  const picker = page.getByRole("dialog", { name: "Teilnehmende hinzufügen" });
  const search = picker.getByRole("combobox");
  await expect(search).toBeFocused();
  expect(await block.locator(".meeting-tabs").boundingBox()).toEqual(tabs);
  await search.fill(me.slice(0, 3).toLowerCase());
  await expect(picker.getByRole("option").first()).toContainText(me);
  await expect(picker.getByRole("option").first()).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(block.locator(".meeting-meta")).toContainText(`@${me}`);
  // The member is in: not offered again; the text becomes a guest.
  await search.fill("Zoe Gast");
  await expect(picker.getByRole("option")).toHaveCount(1);
  await expect(picker.getByRole("option")).toHaveText("Gast „Zoe Gast“ hinzufügen");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(block.locator(".meeting-guest", { hasText: "Zoe Gast" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
  await expect(plus).toBeFocused();
});

test("the event picker lists calendar appointments, other dated rows only on request", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "One run covers it.");
  const { block } = await openMeeting(page);
  const button = block.getByRole("button", { name: "Termin aus dem Kalender wählen" });
  await button.click();
  const picker = page.getByRole("dialog", { name: "Termin wählen" });
  await expect(picker.getByRole("option", { name: /Wochentermin Produkt/ })).toBeVisible();
  await expect(picker.getByRole("option", { name: /Kundentermin/ })).toBeVisible();
  await expect(picker.getByText("OK (Flowplan)")).toHaveCount(0);
  await expect(picker.getByRole("option").first()).toBeFocused();
  // Time on the left, grouped by calendar.
  await expect(picker.getByRole("listbox", { name: "Team-Kalender" }).getByRole("option")).toHaveText(/^09:00\s*Wochentermin Produkt$/);
  const more = picker.getByRole("button", { name: "Weitere Einträge dieses Tages (1)" });
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await more.click();
  await expect(picker.getByRole("option", { name: /OK \(Flowplan\)/ })).toBeVisible();
  await picker.getByRole("option", { name: /Wochentermin Produkt/ }).click();
  await expect(picker).toHaveCount(0);
  await expect(block.getByLabel("Titel der Besprechung")).toHaveValue("Wochentermin Produkt");
});

test("the transcript is locked until switched on; edited passages are marked; hidden lines on request", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "One run covers it.");
  const { block } = await openMeeting(page);
  await block.getByRole("tab", { name: "Transkript" }).click();
  const transcript = block.locator('[data-meeting-part="transcript"]');
  const first = transcript.locator('[data-segment="s1"]');
  await expect(transcript).toHaveAttribute("contenteditable", "false");
  const toggle = block.getByRole("button", { name: "Transkript bearbeiten" });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await first.click();
  await page.keyboard.type("XYZ");
  await expect(first).toHaveText("Willkommen, heute geht es um das Budget mit Herrn Mayr.");
  // The invented line is hidden, with a switch.
  await expect(transcript.locator('[data-segment="s3"]')).toBeHidden();
  await block.getByRole("button", { name: "1 ausgeblendete Zeile anzeigen" }).click();
  await expect(transcript.locator('[data-segment="s3"]')).toBeVisible();
  // Unlocked: typing changes the passage and marks it.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(transcript).not.toHaveAttribute("contenteditable", "false");
  await first.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Ende");
  await expect(first).toHaveText("Willkommen, heute geht es um das Budget mit Herrn Mayr. Ende");
  await expect(first).toHaveAttribute("data-edited", "1");
  await expect(transcript.locator('[data-segment="s2"]')).not.toHaveAttribute("data-edited", "1");
  // Find and replace.
  await block.getByRole("button", { name: "Suchen und ersetzen" }).click();
  await block.getByLabel("Suchen", { exact: true }).fill("mayr");
  await expect(block.locator(".meeting-find-count")).toHaveText("1 Treffer");
  await block.getByLabel("Ersetzen durch").fill("Maier");
  await block.getByRole("button", { name: "Alle ersetzen" }).click();
  await expect(first).toContainText("Herrn Maier.");
  // Locked again.
  await toggle.click();
  await expect(transcript).toHaveAttribute("contenteditable", "false");
});

test("citation chips show their passage's time – also older numbered ones – and open the transcript there (#199)", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "One run covers it.");
  const { block } = await openMeeting(page);
  const chips = block.locator('[data-meeting-part="summary"] sup[data-meeting-cite]');
  // ① of an older summary is drawn from its segment (14 s), a newer chip
  // from its segment as well, one whose passage is gone keeps its stored time.
  await expect(chips).toHaveText(["00:14", "00:03", "1:02:05"]);
  await expect(chips.nth(0)).toHaveAttribute("aria-label", "Quelle 00:14: Das Budget ist freigegeben.");
  await expect(chips.nth(2)).toHaveAttribute("aria-label", "Quelle 1:02:05");
  await chips.nth(0).hover();
  const popover = block.locator(".meeting-cite-popover");
  await expect(popover).toContainText("00:14 · Ada");
  await expect(popover).toContainText("Das Budget ist freigegeben.");
  await chips.nth(0).click();
  await expect(block.getByRole("tab", { name: "Transkript" })).toHaveAttribute("aria-selected", "true");
  await expect(block.locator('[data-meeting-part="transcript"] [data-segment="s2"]')).toBeInViewport();
});

test("notes keep their place as a tab and stay editable after the recording", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "One run covers it.");
  const { block } = await openMeeting(page);
  await expect(block.getByRole("tab", { name: "Agenda" })).toHaveCount(0);
  await block.getByRole("tab", { name: "Notizen" }).click();
  const notes = block.locator('[data-meeting-part="agenda"]');
  await expect(notes).toBeVisible();
  await notes.locator("p").first().click();
  await page.keyboard.press("End");
  await page.keyboard.type(", Roadmap");
  await expect(notes).toHaveText("Budget, Roadmap");
});

test("transcribe again asks first whether corrected passages stay", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "One run covers it.");
  const bodies: Record<string, unknown>[] = [];
  const { block } = await openMeeting(page, { status: { audio: [{ session: 1, track: "me", url: "/api/files/x" }] } });
  await page.route("**/api/meetings/*/retranscribe", async (r) => {
    const body = r.request().postDataJSON();
    bodies.push(body);
    await r.fulfill({ json: { status: body.dryRun ? "done" : "transcribing", edited: 2, started: !body.dryRun } });
  });
  await block.getByRole("button", { name: "Einstellungen der Besprechung" }).click();
  await page.getByRole("menuitem", { name: "Erneut transkribieren" }).click();
  const dialog = page.getByRole("dialog", { name: "Erneut transkribieren" });
  await expect(dialog).toContainText("2 Stellen im Transkript wurden von Hand korrigiert.");
  await dialog.getByRole("button", { name: "2 korrigierte Stellen behalten" }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[0].dryRun).toBe(true);
  expect(bodies[1].dryRun).toBeUndefined();
  expect(bodies[1].force).toBeUndefined();
});

test("phones: the settings menu is a bottom sheet", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "Phones only.");
  const { block } = await openMeeting(page);
  await block.getByRole("button", { name: "Einstellungen der Besprechung" }).click();
  const sheet = page.getByRole("dialog", { name: "Besprechung" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("menuitem", { name: "Weiter aufnehmen" })).toBeVisible();
  const box = (await sheet.boundingBox())!;
  expect(box.y + box.height).toBeGreaterThan(page.viewportSize()!.height - 4);
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
});
