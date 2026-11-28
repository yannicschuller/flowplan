import { test, expect, type Page } from "@playwright/test";

// The database view's search field (components/database-toolbar.tsx
// SearchChip, #650): the text and the placeholder sit in the middle of the
// chip – on a phone (16 px, the 38 px chip) as on a desktop. The open chip
// is a <div>; without flex of its own its field sat on a line at the top.
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

async function openDatabase(page: Page, name: string) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const response = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Suche ${name} ${Date.now()}`, kind: "database" },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const { id } = await response.json();
  await page.goto(`/#page=${id}`);
}

// Where the field and its text are, from the computed styles: the chip's
// box inside its border, the field's content box, and the box of the text's
// line – the font's ascent and descent (canvas metrics of the field's font),
// centred in the content box as WebKit and Blink lay a single line out.
async function measure(page: Page) {
  return page.locator(".toolbar-chip-search").evaluate((chip) => {
    const input = chip.querySelector("input")!;
    const box = (el: Element, inset: (s: CSSStyleDeclaration) => [number, number]) => {
      const r = el.getBoundingClientRect();
      const [top, bottom] = inset(getComputedStyle(el));
      return { top: r.top + top, bottom: r.bottom - bottom };
    };
    const px = (v: string) => parseFloat(v) || 0;
    const chipBox = box(chip, (s) => [px(s.borderTopWidth), px(s.borderBottomWidth)]);
    const content = box(input, (s) => [px(s.borderTopWidth) + px(s.paddingTop), px(s.borderBottomWidth) + px(s.paddingBottom)]);
    const style = getComputedStyle(input);
    const context = document.createElement("canvas").getContext("2d")!;
    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const metrics = context.measureText(input.value || input.placeholder);
    const textHeight = metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent;
    const line = style.lineHeight === "normal" ? textHeight : px(style.lineHeight);
    return {
      fontSize: px(style.fontSize),
      chipCentre: (chipBox.top + chipBox.bottom) / 2,
      contentCentre: (content.top + content.bottom) / 2,
      contentHeight: content.bottom - content.top,
      line,
      textHeight,
    };
  });
}

test("the database search's text and placeholder sit in the middle of the field (#650)", async ({ page }, info) => {
  const phone = info.project.name === "mobile";
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await openDatabase(page, info.project.name);

  const chip = page.locator("button.toolbar-chip", { hasText: "Suchen" }).first();
  if (phone) await chip.tap();
  else await chip.click();
  const field = page.getByLabel("Datenbank durchsuchen", { exact: true });
  await expect(field).toBeFocused();
  await expect(field).toHaveAttribute("placeholder", "Suchen …");

  const check = async () => {
    const m = await measure(page);
    // Phones: 16 px (iOS zooms into a field below), the 38 px chip.
    expect(m.fontSize).toBe(phone ? 16 : 12);
    // The field is in the middle of the chip …
    expect(Math.abs(m.contentCentre - m.chipCentre)).toBeLessThanOrEqual(1);
    // … and its line fits into it, so the text box is centred in it.
    expect(m.line).toBeLessThanOrEqual(m.contentHeight + 0.5);
    expect(m.textHeight).toBeLessThanOrEqual(m.contentHeight + 0.5);
    return m;
  };
  // The placeholder, then typed text.
  await check();
  await field.pressSequentially("Hamburg");
  await expect(field).toHaveValue("Hamburg");
  const typed = await check();

  // What is drawn: the ink of capitals ("HHH", no descenders) is centred on
  // the chip, within 2 px – for these fonts the centre of a capital is that
  // of the text box.
  await field.fill("HHHH");
  const shot = await page.locator(".toolbar-chip-search input").screenshot({ animations: "disabled", caret: "hide" });
  const sharp = (await import("sharp")).default;
  const { data, info: raw } = await sharp(shot).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let top = -1,
    bottom = -1;
  for (let y = 0; y < raw.height; y++) {
    let ink = false;
    for (let x = 0; x < raw.width && !ink; x++) {
      const i = (y * raw.width + x) * raw.channels;
      // Text in light and dark themes: far from the background's grey.
      const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
      ink = Math.max(r, g, b) < 140;
    }
    if (ink) {
      if (top < 0) top = y;
      bottom = y + 1;
    }
  }
  expect(top, "the capitals were drawn").toBeGreaterThanOrEqual(0);
  const inputBox = (await page.locator(".toolbar-chip-search input").boundingBox())!;
  const inkCentre = inputBox.y + ((top + bottom) / 2) * (inputBox.height / raw.height);
  expect(Math.abs(inkCentre - typed.chipCentre)).toBeLessThanOrEqual(2);
  expect(errors).toEqual([]);
});
