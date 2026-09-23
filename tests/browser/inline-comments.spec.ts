import { test, expect, type Page, type Browser } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { join } from "node:path";
import { htmlState } from "../../lib/document-server";
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
async function fixture(page: Page, browser: Browser) {
  if (!process.env.FLOWPLAN_DATA_DIR?.startsWith("/tmp/flowplan-inline-e2e."))
    throw new Error("Use isolated inline-comment data.");
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>, p = page) => {
    const r = await p.request.post("/api/command", {
      headers: { origin },
      data,
    });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  };
  const area = await command({
    action: "space.create",
    workspaceId: boot.workspace.id,
    name: `Inline ${randomUUID()}`,
    private: false,
  });
  const doc = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: area.id,
    title: "Inline review",
  });
  const database = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: area.id,
    title: "Review records",
    kind: "database",
  });
  const row = await command({
    action: "row.create",
    pageId: database.id,
    cells: { title: "Review entry" },
  });
  await page.request.get(`/api/pages/${database.id}/rows/${row.id}`);
  const db = new DatabaseSync(
    join(process.env.FLOWPLAN_DATA_DIR, "flowplan.sqlite"),
  );
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  const html =
      "<p>Alpha Bravo Charlie Delta</p><ul><li><p>Nested review</p></li></ul>",
    state = htmlState(html);
  db.prepare("UPDATE documents SET state=?,html=? WHERE page_id=?").run(
    state,
    html,
    doc.id,
  );
  db.prepare("UPDATE row_documents SET state=?,html=? WHERE row_id=?").run(
    state,
    html,
    row.id,
  );
  const uid = randomUUID(),
    token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)").run(
    uid,
    uid,
    "Review Reader",
    `${uid}@test.invalid`,
  );
  db.prepare("INSERT INTO members VALUES(?,?,?)").run(
    boot.workspace.id,
    uid,
    "viewer",
  );
  db.prepare("INSERT INTO sessions VALUES(?,?,?,?)").run(
    createHash("sha256").update(token).digest("hex"),
    uid,
    "[]",
    Date.now() + 3600000,
  );
  const context = await browser.newContext({
    viewport: page.viewportSize(),
    isMobile: test.info().project.name === "mobile",
    hasTouch: test.info().project.name === "mobile",
  });
  await context.addCookies([
    { name: "flowplan_session", value: token, url: origin },
  ]);
  const other = await context.newPage(),
    errors: string[] = [];
  for (const p of [page, other])
    p.on("pageerror", (e) => errors.push(e.message));
  async function open(p: Page, record = false) {
    await p.goto("about:blank");
    await p.goto(`${origin}/#page=${record ? database.id : doc.id}`);
    if (test.info().project.name === "mobile") {
      const shade = p.locator(".nav-shade");
      if (await shade.isVisible())
        await shade.click({ position: { x: 300, y: 600 } });
    }
    if (record)
      await p.locator(`[data-row-id="${row.id}"] .title-cell`).click();
    await expect(p.locator(".tiptap")).toContainText("Alpha Bravo");
  }
  async function threads(record = false, p = page, detail = "") {
    return (
      await p.request.get(
        `/api/threads?page=${record ? database.id : doc.id}${record ? `&row=${row.id}` : ""}${detail ? `&thread=${detail}` : ""}`,
      )
    ).json();
  }
  return {
    boot,
    doc,
    database,
    row,
    area,
    db,
    uid,
    context,
    other,
    errors,
    command,
    open,
    threads,
  };
}
async function select(page: Page, from = 7, to = 12) {
  await page.locator(".tiptap").evaluate(
    (el, range) => {
      const editor = (el as HTMLElement & { editor: any }).editor;
      editor.commands.focus();
      editor.commands.setTextSelection(range);
    },
    { from, to },
  );
  await expect(page.locator(".tiptap")).toBeFocused();
}
async function create(page: Page, body = "Please review") {
  await select(page);
  await page
    .getByRole("button", { name: "Text kommentieren", exact: true })
    .click();
  await page.getByLabel("Kommentar zur Textstelle", { exact: true }).fill(body);
  await page
    .getByRole("button", { name: "Kommentar senden", exact: true })
    .click();
  await expect(page.locator(".inline-comment-message")).toContainText(body);
}
async function openThread(page: Page) {
  await page.getByRole("button", { name: /Textkommentare \(/ }).click();
  await page.locator(".inline-thread-link").first().click();
  await expect(page.getByLabel("Antwort", { exact: true })).toBeVisible();
}
test("inline document threads support reader replies, editing, reactions, resolution and deletion on desktop and mobile", async ({
  page,
  browser,
}, info) => {
  const f = await fixture(page, browser);
  try {
    await f.open(page);
    await create(page);
    await expect(page.locator(".inline-comment-mark")).toHaveText("Bravo");
    await f.open(f.other);
    await openThread(f.other);
    await f.other.getByLabel("Antwort", { exact: true }).fill("Reader reply");
    await f.other
      .getByRole("button", { name: "Antwort senden", exact: true })
      .click();
    await expect(f.other.locator(".inline-comment-message")).toHaveCount(2);
    await expect(
      f.other.getByRole("button", { name: "Thread erledigen", exact: true }),
    ).toHaveCount(0);
    await expect(page.locator(".inline-comment-message")).toHaveCount(2, {
      timeout: 10000,
    });
    const message = page.locator(".inline-comment-message").first();
    await message
      .getByRole("button", { name: "Kommentar bearbeiten", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Kommentartext bearbeiten", exact: true })
      .fill("Reviewed with detail");
    await page
      .getByRole("button", { name: "Änderung speichern", exact: true })
      .click();
    await expect(message).toContainText("Reviewed with detail");
    await message
      .getByRole("button", { name: "Emoji-Reaktion hinzufügen", exact: true })
      .click();
    const picker = page.getByRole("dialog", {
      name: "Emoji-Reaktion",
      exact: true,
    });
    await picker.getByLabel("Emoji suchen", { exact: true }).fill("Rakete");
    await picker.getByRole("button", { name: /Rakete 🚀/i }).click();
    await expect(
      message.getByRole("button", { name: "🚀 1 Reaktionen", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await page.screenshot({
      path: `test-results/inline-comments-verification/thread-${info.project.name}.png`,
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Thread erledigen", exact: true })
      .click();
    await expect(
      page.getByText("Dieser Thread ist erledigt.", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Textkommentare schließen", exact: true })
      .click();
    await expect(page.locator(".inline-comment-mark")).toHaveCount(0);
    await page.getByRole("button", { name: /Textkommentare \(/ }).click();
    await page
      .getByRole("button", { name: "Wieder öffnen", exact: true })
      .click();
    await message
      .getByRole("button", { name: "Kommentar löschen", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Kommentar endgültig löschen", exact: true })
      .click();
    await expect(page.locator(".inline-comment-message").first()).toContainText(
      "Kommentar gelöscht",
    );
    await expect(page.locator(".inline-comment-message").last()).toContainText(
      "Reader reply",
    );
    const html = await page
      .locator(".tiptap")
      .evaluate((el) => (el as HTMLElement & { editor: any }).editor.getHTML());
    expect(html).not.toContain("inline-comment");
    expect(html).not.toContain("Reader reply");
    await page.reload();
    await openThread(page);
    await expect(page.locator(".inline-comment-message").last()).toContainText(
      "Reader reply",
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await expect(f.other.locator(".tiptap")).toHaveAttribute(
      "contenteditable",
      "false",
    );
    await f.other.locator(".tiptap").evaluate((el) => {
      (el as HTMLElement).focus();
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const offset = node.textContent?.indexOf("Delta") ?? -1;
        if (offset < 0) continue;
        const range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, offset + 5);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        break;
      }
      document.dispatchEvent(new Event("selectionchange"));
    });
    await f.other
      .getByRole("button", { name: "Text kommentieren", exact: true })
      .click();
    await expect(
      f.other.locator(".inline-comment-panel blockquote"),
    ).toHaveText("Delta");
    await f.other
      .getByLabel("Kommentar zur Textstelle", { exact: true })
      .fill("Reader starts a thread");
    await f.other
      .getByRole("button", { name: "Kommentar senden", exact: true })
      .click();
    await expect(f.other.locator(".inline-comment-message")).toContainText(
      "Reader starts a thread",
    );
    await f.other
      .getByRole("button", { name: "Thread erledigen", exact: true })
      .click();
    await expect(
      f.other.getByText("Dieser Thread ist erledigt.", { exact: true }),
    ).toBeVisible();
    expect(f.errors).toEqual([]);
  } finally {
    await f.context.close();
    f.db.close();
  }
});
test("comment anchors follow typing, stale edits keep drafts, and deleted text leaves an accessible thread", async ({
  page,
  browser,
}) => {
  const f = await fixture(page, browser);
  try {
    await f.open(page);
    await create(page);
    const thread = (await f.threads())[0];
    await page
      .locator(".inline-comment-message")
      .first()
      .getByRole("button", { name: "Kommentar bearbeiten", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Kommentartext bearbeiten", exact: true })
      .fill("My pending edit");
    await f.command({
      action: "thread.edit",
      pageId: f.doc.id,
      threadId: thread.id,
      messageId: thread.messages[0].id,
      version: 1,
      body: "Concurrent edit",
    });
    await page
      .getByRole("button", { name: "Änderung speichern", exact: true })
      .click();
    await expect(
      page.locator(".inline-comment-panel").getByRole("alert"),
    ).toContainText("Entwurf bleibt erhalten");
    await expect(
      page.getByRole("textbox", {
        name: "Kommentartext bearbeiten",
        exact: true,
      }),
    ).toHaveText("My pending edit");
    await page
      .getByRole("button", { name: "Bearbeitung abbrechen", exact: true })
      .click();
    await select(page, 1, 1);
    await page.keyboard.insertText("New ");
    await expect(page.locator(".inline-comment-mark")).toHaveText("Bravo");
    await expect
      .poll(async () => {
        const data = await (
          await page.request.get(`/api/pages/${f.doc.id}`)
        ).json();
        return data.html;
      })
      .toContain("New Alpha");
    await page.reload();
    await expect(page.locator(".inline-comment-mark")).toHaveText("Bravo");
    await page.locator(".inline-comment-mark").click();
    await expect(page.locator(".inline-comment-message")).toContainText(
      "Concurrent edit",
    );
    await select(page, 11, 16);
    await page.keyboard.press("Backspace");
    await expect(page.locator(".inline-comment-mark")).toHaveCount(0);
    await expect(
      page.getByText("Textstelle nicht mehr verfügbar", { exact: true }),
    ).toBeVisible();
    await expect(page.locator(".inline-comment-panel blockquote")).toHaveText(
      "Bravo",
    );
    expect(f.errors).toEqual([]);
  } finally {
    await f.context.close();
    f.db.close();
  }
});
test("row threads survive generation changes and lost acknowledgements do not duplicate comments", async ({
  page,
  browser,
}) => {
  const f = await fixture(page, browser);
  try {
    await f.open(page, true);
    let dropped = false;
    await page.route("**/api/command", async (route) => {
      if (route.request().postDataJSON().action !== "thread.create" || dropped)
        return route.continue();
      dropped = true;
      await route.fetch();
      await route.abort();
    });
    await select(page);
    await page
      .getByRole("button", { name: "Text kommentieren", exact: true })
      .click();
    await page
      .getByLabel("Kommentar zur Textstelle", { exact: true })
      .fill("Row review");
    await page
      .getByRole("button", { name: "Kommentar senden", exact: true })
      .click();
    await expect(
      page.locator(".inline-comment-panel").getByRole("alert"),
    ).toBeVisible();
    await expect(
      page.getByLabel("Kommentar zur Textstelle", { exact: true }),
    ).toHaveText("Row review");
    await page
      .getByRole("button", { name: "Kommentar senden", exact: true })
      .click();
    await expect(page.locator(".inline-comment-message")).toContainText(
      "Row review",
    );
    expect((await f.threads(true)).length).toBe(1);
    await page.unrouteAll({ behavior: "wait" });
    await f.open(f.other, true);
    await openThread(f.other);
    await f.other.getByLabel("Antwort", { exact: true }).fill("Unsaved reply");
    f.db
      .prepare("UPDATE row_documents SET generation=? WHERE row_id=?")
      .run(randomUUID(), f.row.id);
    // The new document generation has no matching anchor; the discussion stays visible.
    await f.open(page, true);
    await openThread(page);
    await expect(
      page.getByText("Textstelle nicht mehr verfügbar", { exact: true }),
    ).toBeVisible();
    await expect(page.locator(".inline-comment-message")).toContainText(
      "Row review",
    );
    await f.open(f.other, true);
    await openThread(f.other);
    await expect(f.other.getByLabel("Antwort", { exact: true })).toHaveText(
      "Unsaved reply",
    );
    await f.open(page);
    await expect.poll(() => f.threads()).toEqual([]);
    // Block comments use node decorations and node selection, including images.
    await page.locator(".tiptap").evaluate((el) => {
      const e = (el as HTMLElement & { editor: any }).editor;
      e.commands.insertContentAt(e.state.doc.content.size, {
        type: "image",
        attrs: { src: "/icon.svg", alt: "Commented image" },
      });
      e.state.doc.descendants((node: any, pos: number) => {
        if (node.type.name === "image") e.commands.setNodeSelection(pos);
      });
      e.commands.focus();
    });
    await expect(page.locator(".tiptap")).toBeFocused();
    await page.keyboard.press("ControlOrMeta+Alt+m");
    await page
      .getByLabel("Kommentar zur Textstelle", { exact: true })
      .fill("Image review");
    await page
      .getByRole("button", { name: "Kommentar senden", exact: true })
      .click();
    await expect(page.locator(".inline-comment-message")).toContainText(
      "Image review",
    );
    await expect(page.locator(".tiptap img.inline-comment-mark")).toHaveCount(
      1,
    );
    await expect(page.locator(".inline-comment-panel blockquote")).toHaveText(
      "[Medienblock]",
    );
    await page
      .getByRole("button", { name: "Zur Textstelle", exact: true })
      .click();
    await expect
      .poll(() =>
        page
          .locator(".tiptap")
          .evaluate(
            (el) =>
              (
                el as HTMLElement & { editor: any }
              ).editor.state.selection.toJSON().type,
          ),
      )
      .toBe("node");
    const anonymous = await browser.newContext();
    try {
      expect(
        (
          await anonymous.request.get(
            `${origin}/api/threads?page=${f.database.id}&row=${f.row.id}`,
          )
        ).status(),
      ).toBe(401);
    } finally {
      await anonymous.close();
    }
    expect(f.errors).toEqual([]);
  } finally {
    await f.context.close();
    f.db.close();
  }
});

test("comment notification links open exact row threads, survive reload and support browser history", async ({
  page,
  browser,
}) => {
  const f = await fixture(page, browser);
  try {
    await f.open(page, true);
    await create(page, "Linked row discussion");
    const [thread] = await f.threads(true);
    await page
      .getByRole("button", { name: "Thread erledigen", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Wieder öffnen", exact: true }),
    ).toBeVisible();
    await f.other.goto(`${origin}/#inbox`);
    await f.other
      .locator(".notification-row")
      .filter({ hasText: "Review records" })
      .click();
    const target = `#page=${f.database.id}&row=${f.row.id}&thread=${thread.id}`;
    await expect(f.other).toHaveURL(`${origin}/${target}`);
    await expect(
      f.other.getByRole("dialog", { name: "Eintrag", exact: true }),
    ).toBeVisible();
    await expect(f.other.locator(".inline-comment-message")).toContainText(
      "Linked row discussion",
    );
    // Resolved threads must open despite the default open-thread filter.
    await expect(
      f.other.locator(".inline-comment-panel blockquote"),
    ).toHaveText("Bravo");
    await f.other.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text: string) => {
            (window as any).__copiedLink = text;
          },
        },
      });
    });
    await f.other
      .getByRole("button", { name: "Kommentarlink kopieren", exact: true })
      .click();
    expect(await f.other.evaluate(() => (window as any).__copiedLink)).toBe(
      `${origin}/${target}`,
    );
    await f.other.reload();
    await expect(f.other.locator(".inline-comment-message")).toContainText(
      "Linked row discussion",
    );
    await f.other.goBack();
    await expect(
      f.other.getByRole("heading", { name: "Posteingang", exact: true }),
    ).toBeVisible();
    await f.other.goForward();
    await expect(f.other.locator(".inline-comment-message")).toContainText(
      "Linked row discussion",
    );
    await f.other
      .getByRole("dialog", { name: "Eintrag", exact: true })
      .getByRole("button", { name: "Schließen", exact: true })
      .click();
    await expect(f.other).toHaveURL(`${origin}/#page=${f.database.id}`);
    await f.other.goBack();
    await expect(f.other.locator(".inline-comment-message")).toContainText(
      "Linked row discussion",
    );
    await f.other.evaluate((hash) => {
      location.hash = hash;
    }, `page=${f.database.id}&row=${f.row.id}&thread=${randomUUID()}`);
    await expect(f.other.locator(".inline-comment-panel")).toContainText(
      "Dieser Kommentar ist nicht mehr verfügbar",
    );
    await f.other.evaluate((hash) => {
      location.hash = hash;
    }, target);
    await expect(f.other.locator(".inline-comment-message")).toContainText(
      "Linked row discussion",
    );
    expect(f.errors).toEqual([]);
  } finally {
    await f.context.close();
    f.db.close();
  }
});

test("document thread links switch workspaces and enforce current permissions without stale navigation", async ({
  page,
  browser,
}) => {
  const f = await fixture(page, browser);
  try {
    await f.open(page);
    await create(page, "Cross workspace discussion");
    const [thread] = await f.threads();
    const otherWorkspace = await f.command(
      { action: "workspace.create", name: "Different initial workspace" },
      f.other,
    );
    f.db
      .prepare("UPDATE workspaces SET created_at='2000-01-01' WHERE id=?")
      .run(otherWorkspace.id);
    const target = `#page=${f.doc.id}&thread=${thread.id}`;
    await f.other.goto(`${origin}/${target}`);
    await expect(f.other.locator(".inline-comment-message")).toContainText(
      "Cross workspace discussion",
    );
    // Polling the newly selected workspace must not bounce back to Home.
    await expect(f.other.locator(".workspace-switch")).toContainText(
      f.boot.workspace.name,
    );
    await f.other.waitForResponse(
      (response) =>
        response
          .url()
          .includes(`/api/bootstrap?workspace=${f.boot.workspace.id}`),
      { timeout: 15000 },
    );
    await expect(f.other).toHaveURL(`${origin}/${target}`);
    await f.other.reload();
    await expect(f.other.locator(".inline-comment-message")).toContainText(
      "Cross workspace discussion",
    );
    // A pending page request cannot reopen content after navigation to Home.
    let entered!: () => void;
    const started = new Promise<void>((r) => (entered = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await f.other.route(
      `**/api/pages/${f.database.id}`,
      async (route) => {
        entered();
        await gate;
        await route.continue();
      },
      { times: 1 },
    );
    await f.other.evaluate((hash) => {
      location.hash = hash;
    }, `page=${f.database.id}&row=${f.row.id}`);
    await expect(f.other).toHaveURL(
      `${origin}/#page=${f.database.id}&row=${f.row.id}`,
    );
    await started;
    await f.other.evaluate(() => {
      location.hash = "home";
    });
    release();
    await expect(f.other).toHaveURL(`${origin}/#home`);
    await expect(
      f.other.getByRole("dialog", { name: "Eintrag", exact: true }),
    ).toHaveCount(0);
    f.db
      .prepare("DELETE FROM members WHERE user_id=? AND workspace_id=?")
      .run(f.uid, f.boot.workspace.id);
    await f.other.goto(`${origin}/${target}`);
    await expect(f.other.locator(".inline-comment-message")).toHaveCount(0);
    await expect(f.other.locator(".toast")).toBeVisible();
    expect(
      (
        await f.other.request.get(
          `/api/threads?page=${f.doc.id}&thread=${thread.id}`,
        )
      ).status(),
    ).toBe(403);
    expect(f.errors).toEqual([]);
  } finally {
    await f.context.close();
    f.db.close();
  }
});

test("unauthenticated comment links retain their destination after signing in", async ({
  page,
  browser,
}) => {
  const f = await fixture(page, browser);
  const context = await browser.newContext({
    viewport: page.viewportSize(),
    isMobile: test.info().project.name === "mobile",
    hasTouch: test.info().project.name === "mobile",
  });
  try {
    await f.open(page, true);
    await create(page, "Return after sign-in");
    const [thread] = await f.threads(true);
    const target = `${origin}/#page=${f.database.id}&row=${f.row.id}&thread=${thread.id}`;
    const visitor = await context.newPage();
    await visitor.goto(target);
    await expect(visitor.locator(".login")).toBeVisible();
    await visitor
      .getByRole("button", { name: "Lokalen Arbeitsbereich öffnen" })
      .click();
    await expect(visitor).toHaveURL(target);
    await expect(visitor.locator(".inline-comment-message")).toContainText(
      "Return after sign-in",
    );
    await expect(
      visitor.getByRole("dialog", { name: "Eintrag", exact: true }),
    ).toBeVisible();
  } finally {
    await context.close();
    await f.context.close();
    f.db.close();
  }
});

test("formatted comments support keyboard mentions, links, lists and rich edits without changing document content", async ({
  page,
  browser,
}, info) => {
  const f = await fixture(page, browser);
  const readerName = `Mention ${f.uid.slice(0, 8)}`;
  f.db.prepare("UPDATE users SET name=? WHERE id=?").run(readerName, f.uid);
  try {
    await f.open(page);
    await select(page);
    await page
      .getByRole("button", { name: "Text kommentieren", exact: true })
      .click();
    const input = page.getByRole("textbox", {
      name: "Kommentar zur Textstelle",
      exact: true,
    });
    const composer = page.locator(".comment-composer");
    await input.fill("Important");
    await input.press("ControlOrMeta+a");
    await composer
      .getByRole("button", { name: "Kommentar: Fett", exact: true })
      .click();
    await expect(input.locator("strong")).toHaveText("Important");
    await input.press("ControlOrMeta+z");
    await expect(input.locator("strong")).toHaveCount(0);
    await input.press("ControlOrMeta+Shift+z");
    await expect(input.locator("strong")).toHaveText("Important");
    await input.press("ArrowRight");
    await input.press("End");
    await expect
      .poll(() => input.evaluate((element) =>
        (element as HTMLElement & { editor: any }).editor.state.selection.empty,
      ))
      .toBe(true);
    await input.press("ControlOrMeta+b");
    await input.pressSequentially(` @${readerName}`);
    await expect(
      composer.getByRole("option", {
        name: `${readerName} ${f.uid}@test.invalid`,
        exact: true,
      }),
    ).toBeVisible();
    await input.press("Enter");
    await expect(input.locator("[data-comment-mention]")).toHaveText(
      `@${readerName}`,
    );
    await input.pressSequentially("please check");
    await composer
      .getByRole("button", { name: "Kommentar: Link", exact: true })
      .click();
    await composer
      .getByLabel("Kommentar-Linkadresse", { exact: true })
      .fill("https://example.test/review");
    await composer
      .getByRole("button", { name: "Link übernehmen", exact: true })
      .click();
    await input.press("End");
    await input.press("Enter");
    await composer
      .getByRole("button", { name: "Kommentar: Aufzählung", exact: true })
      .click();
    await input.pressSequentially("Follow-up task");
    await page
      .getByRole("button", { name: "Kommentar senden", exact: true })
      .click();
    const message = page.locator(".inline-comment-message");
    await expect(
      message.locator("strong").filter({ hasText: "Important" }),
    ).toBeVisible();
    await expect(message.locator(".comment-rich-body a")).toHaveAttribute(
      "href",
      "https://example.test/review",
    );
    await expect(message.locator(".comment-rich-body li")).toContainText(
      "Follow-up task",
    );
    const [thread] = await f.threads(),
      [stored] = await f.threads(false, page, thread.id);
    expect(stored.messages[0].content.type).toBe("doc");
    expect(stored.messages[0].body).toContain(`@${readerName}`);
    const notification = f.db
      .prepare("SELECT body FROM notifications WHERE user_id=? AND thread_id=?")
      .get(f.uid, thread.id) as { body: string };
    expect(notification.body).toContain("erwähnt");
    await page.reload();
    await openThread(page);
    await expect(page.locator(".comment-rich-body li")).toContainText(
      "Follow-up task",
    );
    await page
      .getByRole("button", { name: "Kommentar bearbeiten", exact: true })
      .click();
    const editing = page.getByRole("textbox", {
      name: "Kommentartext bearbeiten",
      exact: true,
    });
    await expect(editing.locator("[data-comment-mention]")).toHaveText(
      `@${readerName}`,
    );
    await editing.press("ControlOrMeta+End");
    await editing.pressSequentially(" updated");
    await page
      .getByRole("button", { name: "Änderung speichern", exact: true })
      .click();
    await expect(page.locator(".comment-rich-body")).toContainText("updated");
    const response = await (
      await page.request.get(`/api/pages/${f.doc.id}`)
    ).json();
    expect(response.html).not.toContain("Important");
    expect(response.html).not.toContain("data-comment-mention");
    await page
      .locator(".inline-comment-panel")
      .evaluate((element) => element.scrollIntoView({ block: "start" }));
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document.querySelector(".editor-toolbar")!.getBoundingClientRect()
              .bottom <=
            document
              .querySelector(".inline-comment-panel")!
              .getBoundingClientRect().top +
              1,
        ),
      )
      .toBe(true);
    await page.screenshot({
      path: `test-results/rich-comments-verification/rich-${info.project.name}.png`,
      fullPage: true,
    });
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "dark";
    });
    await page.screenshot({
      path: `test-results/rich-comments-verification/rich-dark-${info.project.name}.png`,
      fullPage: true,
    });
    expect(f.errors).toEqual([]);
  } finally {
    await f.context.close();
    f.db.close();
  }
});

test("rich reply drafts survive reload and revoked mention access keeps the unsent draft", async ({
  page,
  browser,
}) => {
  const f = await fixture(page, browser);
  const readerName = `Mention ${f.uid.slice(0, 8)}`;
  f.db.prepare("UPDATE users SET name=? WHERE id=?").run(readerName, f.uid);
  try {
    await f.open(page, true);
    await create(page, "Reply here");
    const reply = page.getByRole("textbox", { name: "Antwort", exact: true });
    await reply.fill("Pending");
    await reply.press("ControlOrMeta+a");
    await reply.press("ControlOrMeta+i");
    await reply.press("ArrowRight");
    const composer = page.locator(".comment-composer");
    await composer
      .getByRole("button", { name: "Person erwähnen", exact: true })
      .click();
    await composer
      .getByLabel("Person suchen", { exact: true })
      .fill(`${f.uid}@test.invalid`);
    await expect(
      composer.getByRole("option", {
        name: `${readerName} ${f.uid}@test.invalid`,
        exact: true,
      }),
    ).toBeVisible();
    await composer
      .getByLabel("Person suchen", { exact: true })
      .dispatchEvent("keydown", {
        key: "Enter",
        code: "Enter",
        isComposing: true,
      });
    await expect(
      composer.getByRole("option", {
        name: `${readerName} ${f.uid}@test.invalid`,
        exact: true,
      }),
    ).toBeVisible();
    await composer
      .getByRole("option", {
        name: `${readerName} ${f.uid}@test.invalid`,
        exact: true,
      })
      .click();
    await page.reload();
    await openThread(page);
    await expect(reply.locator("em")).toContainText("Pending");
    await expect(reply.locator("[data-comment-mention]")).toHaveText(
      `@${readerName}`,
    );
    f.db
      .prepare("DELETE FROM members WHERE workspace_id=? AND user_id=?")
      .run(f.boot.workspace.id, f.uid);
    await page
      .getByRole("button", { name: "Antwort senden", exact: true })
      .click();
    await expect(
      page.locator(".inline-comment-panel").getByRole("alert"),
    ).toContainText("keinen Zugriff");
    await expect(reply.locator("[data-comment-mention]")).toHaveText(
      `@${readerName}`,
    );
    const [thread] = await f.threads(true),
      [detail] = await f.threads(true, page, thread.id);
    expect(detail.messages.length).toBe(1);
    await reply.fill("Safe revised reply");
    await reply.press("ControlOrMeta+Enter");
    await expect(page.locator(".inline-comment-message")).toHaveCount(2);
    await expect(page.locator(".inline-comment-message").last()).toContainText(
      "Safe revised reply",
    );
    expect(f.errors).toEqual([]);
  } finally {
    await f.context.close();
    f.db.close();
  }
});

test("comment editors reject oversized input and unsafe links while retaining usable drafts", async ({
  page,
  browser,
}) => {
  const f = await fixture(page, browser);
  try {
    await f.open(page);
    await select(page);
    await page
      .getByRole("button", { name: "Text kommentieren", exact: true })
      .click();
    const input = page.getByRole("textbox", {
        name: "Kommentar zur Textstelle",
        exact: true,
      }),
      composer = page.locator(".comment-composer");
    const original = "<img src=x onerror=alert(1)> literal";
    await input.fill(original);
    await expect(input.locator("img")).toHaveCount(0);
    await input.fill("X".repeat(5001));
    await expect(composer.getByRole("alert")).toContainText("5.000");
    await expect(input).toHaveText(original);
    await input.fill("Safe comment");
    await input.press("ControlOrMeta+a");
    await composer
      .getByRole("button", { name: "Kommentar: Link", exact: true })
      .click();
    await composer
      .getByLabel("Kommentar-Linkadresse", { exact: true })
      .fill("javascript:alert(1)");
    await composer
      .getByRole("button", { name: "Link übernehmen", exact: true })
      .click();
    await expect(composer.getByRole("alert")).toContainText("gültigen HTTP-");
    await expect(input.locator("a")).toHaveCount(0);
    await composer
      .getByLabel("Kommentar-Linkadresse", { exact: true })
      .fill("https://example.test/safe");
    await composer
      .getByRole("button", { name: "Link übernehmen", exact: true })
      .click();
    await expect(input.locator("a")).toHaveAttribute(
      "href",
      "https://example.test/safe",
    );
    await input.press("ControlOrMeta+Enter");
    await expect(page.locator(".comment-rich-body a")).toHaveText(
      "Safe comment",
    );
    expect(f.errors).toEqual([]);
  } finally {
    await f.context.close();
    f.db.close();
  }
});
