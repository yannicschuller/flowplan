import { test, expect, type Page } from "@playwright/test";

// All tasks of a checklist at once (#309): "Alle als offen markieren" and
// "Alle abhaken" in the block handle menu (the whole checklist of a task,
// nested tasks included, in one undo step), for several chosen blocks, and
// in the right-click menu.
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const item = (text: string, checked: boolean, attrs = "", sub = "") =>
  `<li data-type="taskItem" data-checked="${checked}"${attrs}><p>${text}</p>${sub ? `<ul data-type="taskList">${sub}</ul>` : ""}</li>`;
const HTML =
  "<p>Reise</p>" +
  '<ul data-type="taskList">' +
  item("Pass", true) +
  item("Koffer", false, ' data-status="progress"', item("Socken", true) + item("Hemden", false)) +
  item("Ticket", false) +
  "</ul><p>Sonst</p>" +
  '<ul data-type="taskList">' +
  item("Anderes", true) +
  "</ul><p>Ende</p>";
const TRIP = ["Pass", "Koffer", "Socken", "Hemden", "Ticket"];

async function setup(page: Page) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await command({ action: "profile.onboarded" });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const host = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, kind: "document", title: `Packliste ${Date.now()}` });
  const { htmlState } = await import("../../lib/document-server");
  const generation = (await (await page.request.get(`/api/pages/${host.id}`)).json()).generation;
  await command({ action: "document.sync", pageId: host.id, generation, update: Buffer.from(htmlState(HTML)).toString("base64") });
  await page.addInitScript(() => {
    const hide = () => {
      const style = document.createElement("style");
      style.textContent = "nextjs-portal { display: none !important; }";
      document.head.append(style);
    };
    if (document.head) hide();
    else document.addEventListener("DOMContentLoaded", hide);
  });
  await page.goto(`/#page=${host.id}`);
  const welcome = page.getByRole("dialog", { name: "Willkommen bei Flowplan" });
  await welcome.waitFor({ timeout: 3000 }).then(() => page.keyboard.press("Escape"), () => {});
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor.getByText("Ende")).toBeVisible({ timeout: 30_000 });
  return editor;
}
// The state of each task by its text: "x" done, "/" in progress, " " open.
const states = (page: Page, texts: string[]) =>
  page.getByLabel("Dokumentinhalt", { exact: true }).evaluate((root, texts) => {
    const out: Record<string, string> = {};
    for (const li of root.querySelectorAll<HTMLElement>("li[data-checked]")) {
      const text = li.querySelector(":scope > div > p")?.textContent || "";
      if (!texts.includes(text)) continue;
      out[text] = li.dataset.checked === "true" ? "x" : li.dataset.status === "progress" ? "/" : " ";
    }
    return out;
  }, texts);
async function openHandleMenu(page: Page, text: string, mobile: boolean) {
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  const handle = page.getByRole("button", { name: new RegExp(`^Blockaktionen: .* · ${text}`) });
  if (mobile) {
    await editor.getByText(text, { exact: true }).tap();
    await handle.tap();
  } else {
    await editor.getByText(text, { exact: true }).hover();
    await handle.click();
  }
}
const tapOrClick = (mobile: boolean) => (locator: import("@playwright/test").Locator) => (mobile ? locator.tap() : locator.click());
const undo = async (page: Page, mobile: boolean) => {
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await tapOrClick(mobile)(editor.getByText("Ende", { exact: true }));
  await tapOrClick(mobile)(page.getByRole("toolbar", { name: "Textformatierung" }).getByRole("button", { name: "Rückgängig" }));
};

test("the handle menu marks a whole checklist as open, one undo brings it back, check all ticks it (#309)", async ({ page }, info) => {
  const mobile = info.project.name === "mobile";
  const press = tapOrClick(mobile);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await setup(page);
  const before = { Pass: "x", Koffer: "/", Socken: "x", Hemden: " ", Ticket: " " };
  expect(await states(page, TRIP)).toEqual(before);

  // From a nested task: the whole checklist, the other list stays.
  await openHandleMenu(page, "Socken", mobile);
  await press(page.getByRole("menuitem", { name: "Alle als offen markieren", exact: true }));
  await expect.poll(() => states(page, [...TRIP, "Anderes"])).toEqual({ Pass: " ", Koffer: " ", Socken: " ", Hemden: " ", Ticket: " ", Anderes: "x" });

  // Nothing left to reset: greyed out.
  await openHandleMenu(page, "Ticket", mobile);
  await expect(page.getByRole("menuitem", { name: "Alle als offen markieren", exact: true })).toBeDisabled();
  await expect(page.getByRole("menuitem", { name: "Alle abhaken", exact: true })).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menuitem", { name: "Alle abhaken", exact: true })).toHaveCount(0);

  await undo(page, mobile);
  await expect.poll(() => states(page, TRIP)).toEqual(before);

  await openHandleMenu(page, "Pass", mobile);
  await press(page.getByRole("menuitem", { name: "Alle abhaken", exact: true }));
  await expect.poll(() => states(page, TRIP)).toEqual({ Pass: "x", Koffer: "x", Socken: "x", Hemden: "x", Ticket: "x" });
  await openHandleMenu(page, "Pass", mobile);
  await expect(page.getByRole("menuitem", { name: "Alle abhaken", exact: true })).toBeDisabled();
  // Not offered for a block without tasks.
  await page.keyboard.press("Escape");
  await openHandleMenu(page, "Reise", mobile);
  await expect(page.getByRole("menuitem", { name: "Umwandeln in …" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Alle als offen markieren", exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

// Chosen blocks are neighbours in one list (the selection stays one run).
test("several chosen blocks: only their tasks (#309)", async ({ page }, info) => {
  const mobile = info.project.name === "mobile";
  const editor = await setup(page);
  if (mobile) {
    await openHandleMenu(page, "Koffer", true);
    await page.getByRole("menuitem", { name: "Mehrere auswählen", exact: true }).tap();
    await page.getByRole("checkbox", { name: /· Ticket$/ }).tap();
    const bar = page.getByRole("toolbar", { name: "Ausgewählte Blöcke" });
    await expect(bar).toContainText("2 Blöcke");
    await bar.getByRole("button", { name: "Weitere Aktionen" }).tap();
    await page.getByRole("menuitem", { name: "Alle als offen markieren", exact: true }).tap();
    await bar.getByRole("button", { name: "Fertig" }).tap();
  } else {
    await editor.getByText("Koffer", { exact: true }).click();
    await page.keyboard.press("Escape");
    // Koffer (with its subtasks) and Ticket.
    await page.keyboard.press("Shift+ArrowDown");
    await page.keyboard.press("/");
    await expect(page.getByRole("menu", { name: "2 Blöcke" })).toBeVisible();
    await page.getByRole("menuitem", { name: "Alle als offen markieren", exact: true }).click();
  }
  // Pass (not chosen) stays done.
  await expect.poll(() => states(page, [...TRIP, "Anderes"])).toEqual({ Pass: "x", Koffer: " ", Socken: " ", Hemden: " ", Ticket: " ", Anderes: "x" });
  // Once more: nothing left to reset in them, ticking all is offered.
  if (mobile) {
    await openHandleMenu(page, "Koffer", true);
    await page.getByRole("menuitem", { name: "Mehrere auswählen", exact: true }).tap();
    await page.getByRole("checkbox", { name: /· Ticket$/ }).tap();
    await page.getByRole("toolbar", { name: "Ausgewählte Blöcke" }).getByRole("button", { name: "Weitere Aktionen" }).tap();
  } else {
    await editor.getByText("Koffer", { exact: true }).click();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Shift+ArrowDown");
    await page.keyboard.press("/");
  }
  await expect(page.getByRole("menuitem", { name: "Alle als offen markieren", exact: true })).toBeDisabled();
  await tapOrClick(mobile)(page.getByRole("menuitem", { name: "Alle abhaken", exact: true }));
  await expect.poll(() => states(page, [...TRIP, "Anderes"])).toEqual({ Pass: "x", Koffer: "x", Socken: "x", Hemden: "x", Ticket: "x", Anderes: "x" });
});

test("right click on a task: the same entries in the text menu (#309)", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "right click: desktop");
  const editor = await setup(page);
  await editor.getByText("Hemden", { exact: true }).click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Textmenü" });
  await menu.getByRole("menuitem", { name: "Alle als offen markieren" }).click();
  await expect.poll(() => states(page, [...TRIP, "Anderes"])).toEqual({ Pass: " ", Koffer: " ", Socken: " ", Hemden: " ", Ticket: " ", Anderes: "x" });
  await editor.getByText("Ticket", { exact: true }).click({ button: "right" });
  await expect(menu.getByRole("menuitem", { name: "Alle als offen markieren" })).toBeDisabled();
  await menu.getByRole("menuitem", { name: "Alle abhaken" }).click();
  await expect.poll(() => states(page, TRIP)).toEqual({ Pass: "x", Koffer: "x", Socken: "x", Hemden: "x", Ticket: "x" });
  // Not on plain text.
  await editor.getByText("Reise", { exact: true }).click({ button: "right" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Alle abhaken" })).toHaveCount(0);
});
