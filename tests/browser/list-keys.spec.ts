import { test, expect, type Page } from "@playwright/test";

// Tab and Enter in lists (#254, as in Notion): Tab in an item that cannot be
// indented keeps the caret in it (the browser does not move the focus to
// the next list or a toggle's title); Enter in an empty sub-item moves only
// that item one level up per Enter and finally ends the list.
async function fixture(page: Page, title: string, html: string) {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await command({ action: "profile.onboarded" });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const host = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, kind: "document", title });
  const read = async () => (await page.request.get(`/api/pages/${host.id}`)).json();
  const { htmlState } = await import("../../lib/document-server");
  await command({
    action: "document.sync",
    pageId: host.id,
    generation: (await read()).generation,
    update: Buffer.from(htmlState(html)).toString("base64"),
  });
  return { host };
}
// The editor's lists as an outline: UL[…], li(…), paragraphs by text ("_"
// when empty); empty lines the editor keeps at the start or end are left out.
const outline = (page: Page) =>
  page.getByLabel("Dokumentinhalt", { exact: true }).evaluate((root) => {
    const walk = (el: Element): string => {
      const kids = () => [...el.children].map(walk).filter(Boolean).join(", ");
      if (el.tagName === "UL") return `${el.getAttribute("data-type") === "taskList" ? "TL" : "UL"}[${kids()}]`;
      if (el.tagName === "LI") return `li(${[...(el.querySelector(":scope > div") || el).children].map(walk).filter(Boolean).join(", ")})`;
      if (el.tagName === "P") return el.textContent || "_";
      if (el.tagName === "DETAILS") return "T";
      return "";
    };
    return [...root.children].map(walk).filter(Boolean).join(", ").replace(/(, _)+$/, "").replace(/^(_, )+/, "");
  });

test("Tab in an item that cannot be indented keeps the caret there (#254)", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Keyboard (a hardware keyboard on touch devices): desktop.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const f = await fixture(
    page,
    `Tab in Listen ${Date.now()}`,
    "<ul><li><p>Punkt A</p><ul><li><p>Erstes</p></li></ul></li></ul><ul><li><p>Andere</p></li></ul>" +
      '<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Aufgabe</p><ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Unteraufgabe</p></li></ul></li></ul>' +
      "<details><summary>Klappe</summary><div><p>Drin</p></div></details>",
  );
  await page.goto(`/#page=${f.host.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor.getByText("Drin")).toBeAttached({ timeout: 20_000 });
  const before = await outline(page);
  for (const text of ["Erstes", "Unteraufgabe", "Punkt A"]) {
    await editor.getByText(text, { exact: true }).click();
    await page.keyboard.press("End");
    await page.keyboard.press("Tab");
    await page.keyboard.type("X");
    await expect(editor.getByText(`${text}X`, { exact: true }), `${text}: typing stays in the item`).toBeVisible();
    await page.keyboard.press("Backspace");
    expect(await outline(page)).toBe(before);
  }
  expect(errors).toEqual([]);
});

test("Enter in an empty sub-item lifts only that item, one level per Enter; Enter before sub-items starts a new first one (#254)", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Keyboard (a hardware keyboard on touch devices): desktop.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const f = await fixture(
    page,
    `Enter in Listen ${Date.now()}`,
    "<ul><li><p>A</p><ul><li><p>B</p><ul><li><p>C</p></li><li><p>D</p><ul><li><p>D1</p></li></ul></li><li><p>E</p></li></ul></li></ul></li><li><p>Z</p></li></ul>" +
      '<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>T1</p><ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>T2</p></li><li data-type="taskItem" data-checked="false"><p>T3</p></li></ul></li></ul><p>Ende</p>',
  );
  await page.goto(`/#page=${f.host.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor.getByText("Ende")).toBeVisible({ timeout: 20_000 });
  const tasks = "TL[li(T1, TL[li(T2), li(T3)])], Ende";
  expect(await outline(page)).toBe(`UL[li(A, UL[li(B, UL[li(C), li(D, UL[li(D1)]), li(E)])]), li(Z)], ${tasks}`);
  // A new empty sub-item after "E" (level 3), as when typing.
  await editor.getByText("E", { exact: true }).click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expect.poll(() => outline(page)).toBe(`UL[li(A, UL[li(B, UL[li(C), li(D, UL[li(D1)]), li(E), li(_)])]), li(Z)], ${tasks}`);
  await page.keyboard.press("Enter");
  await expect.poll(() => outline(page)).toBe(`UL[li(A, UL[li(B, UL[li(C), li(D, UL[li(D1)]), li(E)]), li(_)]), li(Z)], ${tasks}`);
  await page.keyboard.press("Enter");
  await expect.poll(() => outline(page)).toBe(`UL[li(A, UL[li(B, UL[li(C), li(D, UL[li(D1)]), li(E)])]), li(_), li(Z)], ${tasks}`);
  await page.keyboard.press("Enter");
  await expect.poll(() => outline(page)).toBe(`UL[li(A, UL[li(B, UL[li(C), li(D, UL[li(D1)]), li(E)])])], _, UL[li(Z)], ${tasks}`);
  // Typing goes into the paragraph that is left.
  await page.keyboard.type("Frei");
  await expect(editor.locator(":scope > p", { hasText: "Frei" })).toBeVisible();

  // Enter at the end of "B" (which has sub-items): a new first sub-item;
  // Enter in it again lifts only that one.
  await editor.getByText("B", { exact: true }).click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expect.poll(() => outline(page)).toContain("UL[li(A, UL[li(B, UL[li(_), li(C), li(D, UL[li(D1)]), li(E)])])]");
  await page.keyboard.type("Neu");
  await expect.poll(() => outline(page)).toContain("UL[li(A, UL[li(B, UL[li(Neu), li(C), li(D, UL[li(D1)]), li(E)])])]");

  // Tasks alike: Enter after "T3", then Enter in the empty subtask.
  await editor.getByText("T3", { exact: true }).click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await expect.poll(() => outline(page)).toContain("TL[li(T1, TL[li(T2), li(T3)]), li(_)], Ende");
  await page.keyboard.press("Enter");
  await expect.poll(() => outline(page)).toContain("TL[li(T1, TL[li(T2), li(T3)])], _, Ende");
  expect(errors).toEqual([]);
});
