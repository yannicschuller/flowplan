import { test, expect, type CDPSession, type Page } from "@playwright/test";

// Typing with Android's on-screen keyboards (#207): every key arrives as
// keydown "Unidentified" (key code 229) and the character as text input,
// committed or inside an IME composition – never as keydown "@" or "/".
// The mention dialog, the slash menu and the "[] " task shortcut work as
// with a hardware keyboard. The keyboard is simulated through the Chrome
// DevTools protocol (Input.insertText, Input.imeSetComposition).
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const android =
  "Mozilla/5.0 (Linux; Android 15; 24072PX77G) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36 FlowplanMobile/1.0";
test.use({ userAgent: android });

function keyboard(page: Page, cdp: CDPSession) {
  const key = (type: "rawKeyDown" | "keyUp") =>
    cdp.send("Input.dispatchKeyEvent", { type, key: "Unidentified", code: "", windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 });
  return {
    // A character the keyboard commits right away.
    commit: async (text: string) => {
      for (const ch of text) {
        await key("rawKeyDown");
        await cdp.send("Input.insertText", { text: ch });
        await key("keyUp");
      }
      await page.waitForTimeout(50);
    },
    // A word the keyboard composes and commits at the end – unless the
    // focus moves on first: then the composition ends where it was.
    compose: async (steps: string[], commit = true) => {
      for (const step of steps) {
        await key("rawKeyDown");
        await cdp.send("Input.imeSetComposition", { text: step, selectionStart: step.length, selectionEnd: step.length });
        await key("keyUp");
        await page.waitForTimeout(30);
      }
      if (commit) await cdp.send("Input.insertText", { text: steps[steps.length - 1] });
      await page.waitForTimeout(50);
    },
  };
}

test("“@”, “/” and “[] ” from an Android keyboard open the mention dialog and the slash menu and start a task", async ({ page, context }, info) => {
  test.skip(info.project.name !== "mobile", "Android keyboards: the mobile project");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // Not the hint that Flowplan is also an app.
  await context.addInitScript(() => {
    try {
      localStorage.setItem("flowplan-app-promo", "1");
    } catch {}
  });
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const created = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Android ${Date.now()}`, kind: "document" },
  });
  expect(created.ok(), await created.text()).toBe(true);
  await page.goto(`/#page=${(await created.json()).id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  const skip = page.getByRole("button", { name: "Überspringen" });
  if (await skip.waitFor({ timeout: 5000 }).then(() => true, () => false)) await skip.click();
  await editor.click();
  const { commit, compose } = keyboard(page, await context.newCDPSession(page));
  const dialog = page.getByRole("dialog", { name: "Seite, Eintrag oder Person erwähnen" });
  const search = dialog.getByRole("combobox", { name: "Seiten, Einträge und Personen suchen" });
  const tasks = editor.locator("li[data-checked]");
  const line = editor.locator("p", { hasText: "Hallo" });

  // "[] " committed key by key, and composed, starts a task.
  await commit("[] ");
  await expect(tasks).toHaveCount(1);
  await commit("Eins");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await compose(["[", "[]"]);
  await commit(" ");
  await expect(tasks).toHaveCount(2);
  await commit("Zwei");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");

  // "@" committed: the dialog opens, the "@" is not left in the text;
  // Escape types it as without the dialog.
  await commit("Hallo @");
  await expect(search).toBeFocused();
  await expect(line).toHaveText(/^Hallo\s$/);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(line).toHaveText(/^Hallo\s@$/);

  // "@" inside a composition opens it too; the search takes the focus
  // and the composition ends in the text.
  await commit(" ");
  await compose(["@"], false);
  await expect(search).toBeFocused();
  await expect(line).toHaveText(/^Hallo\s@\s$/);
  await page.keyboard.press("Escape");
  await expect(line).toHaveText(/^Hallo\s@\s@$/);

  // Inside a word – an e-mail address – "@" is typed.
  await commit(" ada@");
  await page.waitForTimeout(300);
  await expect(dialog).toHaveCount(0);
  await expect(line).toHaveText(/ada@$/);

  // "/" opens the slash menu once, the "/" stays in the text.
  await commit(" /");
  await expect(page.locator(".slash-menu")).toHaveCount(1);
  await commit("Aufg");
  await expect(line).toHaveText(/ada@\s\/Aufg$/);
  await page.keyboard.press("Escape");
  await expect(page.locator(".slash-menu")).toHaveCount(0);
  expect(errors).toEqual([]);
});
