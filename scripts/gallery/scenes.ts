import type { Locator, Page } from "@playwright/test";
import { SETTINGS_SECTIONS } from "../../lib/settings-sections";
import type { Scene, SceneContext } from "./types";

// Every scene of the UI gallery (scripts/gallery/run.ts). A scene opens a
// place of the app and clicks its way to what should be seen – with the same
// accessible locators as the browser specs in tests/browser. Each runs in a
// fresh browser context per variant (desktop/phone × light/dark); one that
// changes content works on a page of its own (ctx.fixture).
//
// The gallery is recorded in English (#438): the locators use the English
// half of the t("Deutsch", "English") pairs, the example content is English.
//
// `covers` names the component files whose dialog, menu or popover the
// scene shows; tests/gallery-coverage.test.ts checks that every such file
// has a scene or is listed in scripts/gallery/uncovered.json.

// ------------------------------------------------------------------ helpers

const dialog = (page: Page, name: string | RegExp) => page.getByRole("dialog", { name, exact: typeof name === "string" });
const waitDialog = (page: Page, name: string | RegExp) => dialog(page, name).first().waitFor();
const menu = (page: Page) => page.getByRole("menu").last();
const button = (scope: Page | Locator, name: string | RegExp) => scope.getByRole("button", { name, exact: typeof name === "string" });
const editor = (page: Page) => page.getByLabel("Document content", { exact: true });
// Until no part of the page is still loading – no "Opening document …" or
// "Opening whiteboard …" (the skeleton) left on screen.
async function loaded(page: Page) {
  await page.waitForFunction(() => !document.querySelector(".page-skeleton"), undefined, { timeout: 20_000 });
}
// A document's editor, ready.
async function documentReady(page: Page) {
  await editor(page).waitFor({ timeout: 20_000 });
  await loaded(page);
}

// A flashcard deck of its own (Front/Back) with a study view.
async function studyDeck(ctx: SceneContext, title: string, settings: Record<string, unknown> = {}) {
  const db = await ctx.fixture({ kind: "database", title });
  const { database } = await (await ctx.api.get(`/api/pages/${db}`)).json();
  await ctx.command({
    action: "database.update",
    pageId: db,
    version: database.version,
    fields: [
      { id: "title", name: "Front", type: "text" },
      { id: "back", name: "Back", type: "text" },
    ],
    views: [{ id: "study", name: "Study", type: "study", filters: [], sorts: [], default: true }],
  });
  await ctx.command({ action: "study.settings", pageId: db, settings: { version: 1, front: { field: "title" }, back: { field: "back" }, ...settings } });
  return db;
}
// An image occlusion deck (phase 6): one record whose document has a
// diagram with five masks – two of them grouped, three labelled.
async function occlusionDeck(ctx: SceneContext, title: string) {
  const { diagramPng } = await import("../../tests/helpers/png");
  const db = await studyDeck(ctx, title, { type: { fixed: "occlusion" } });
  const row = await ctx.command({ action: "row.create", pageId: db, cells: { title: "Which region is marked?", back: "From the atlas, page 12" } });
  const upload = await ctx.api.post("/api/upload", { headers: { origin: ctx.origin }, multipart: { pageId: db, file: { name: "atlas.png", mimeType: "image/png", buffer: diagramPng() } } });
  if (!upload.ok()) throw new Error(`upload: ${upload.status()}`);
  const { url } = await upload.json();
  const masks = {
    v: 1,
    mode: "hide-all",
    masks: [
      { id: "0a000000-0000-4000-8000-000000000001", shape: "ellipse", x: 0.07, y: 0.17, w: 0.28, h: 0.44, label: "North" },
      { id: "0a000000-0000-4000-8000-000000000002", shape: "rect", x: 0.39, y: 0.11, w: 0.24, h: 0.32, label: "Highlands" },
      { id: "0a000000-0000-4000-8000-000000000003", shape: "rect", x: 0.69, y: 0.19, w: 0.24, h: 0.24, group: "0b000000-0000-4000-8000-000000000001", label: "Coast" },
      { id: "0a000000-0000-4000-8000-000000000004", shape: "polygon", x: 0, y: 0, w: 0, h: 0, points: [[0.07, 0.69], [0.33, 0.69], [0.33, 0.89], [0.07, 0.89]], group: "0b000000-0000-4000-8000-000000000001" },
      { id: "0a000000-0000-4000-8000-000000000005", shape: "ellipse", x: 0.41, y: 0.55, w: 0.32, h: 0.34 },
    ],
  };
  const attr = JSON.stringify(masks).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const { htmlState } = await import("../../lib/document-server");
  const { generation } = await (await ctx.api.get(`/api/pages/${db}/rows/${row.id}`)).json();
  await ctx.command({
    action: "row.document.sync",
    pageId: db,
    rowId: row.id,
    generation,
    update: Buffer.from(htmlState(`<p>Map of the regions</p><img src="${url}" alt="Map with five regions" data-occlusion="${attr}">`)).toString("base64"),
  });
  return { db, rowId: row.id as string };
}
// A few cards rated over the last days, for the statistics and counts.
async function studied(ctx: SceneContext, db: string) {
  const words = [["hola", "hello"], ["perro", "dog"], ["gato", "cat"], ["casa", "house"]];
  const ids: string[] = [];
  for (const [title, back] of words) ids.push((await ctx.command({ action: "row.create", pageId: db, cells: { title, back } })).id);
  const day = 86_400_000;
  // One batch (as the app sends ratings made offline), not one command per
  // rating: scenes running side by side ran into the rating limit (#346).
  const reviews = [];
  for (let d = 4; d >= 0; d--)
    for (const [i, rowId] of ids.entries())
      if ((i + d) % 3 !== 0)
        reviews.push({ pageId: db, rowId, sub: "", rating: (i + d) % 4 === 0 ? 1 : 3, id: crypto.randomUUID(), zone: "Europe/Berlin", reviewedAt: Date.now() - d * day - i * 1000 });
  await ctx.command({ action: "study.reviews", reviews });
}
// A published deck (flashcards phase 7): a few cards of every kind of text,
// a cloze among them; the publication's token.
async function publishedDeck(ctx: SceneContext) {
  const db = await studyDeck(ctx, "Spanish A1");
  for (const [title, back] of [
    ["¿Dónde está la estación?", "Where is the station?"],
    ["el perro", "the dog"],
    ["Me llamo {{c1::Ana}} y vivo en {{c2::Madrid}}.", ""],
    ["gracias", "thank you"],
    ["la casa", "the house"],
  ])
    await ctx.command({ action: "row.create", pageId: db, cells: { title, back } });
  await ctx.command({ action: "page.publish", pageId: db, enabled: true });
  const { page } = await (await ctx.api.get(`/api/pages/${db}`)).json();
  return page.public_token as string;
}
// The Anki deck of the import tests (tests/helpers/anki-fixture.ts) with
// English decks and notes: the same note types, cards, reviews and media.
async function englishAnkiFixture() {
  const { sampleFixture } = await import("../../tests/helpers/anki-fixture");
  const fixture = sampleFixture();
  const decks: Record<number, string> = { 10: "Spanish", 11: "Spanish::Lesson 1", 20: "Biology" };
  const fields: Record<number, string[]> = {
    1: ["<b>hola</b>", "hello<script>alert(1)</script>"],
    2: ["perro", '<span style="color:red" onclick="x()">dog</span>'],
    3: ["gato", "cat"],
    4: ["la casa", "the house", "Mi casa es su casa.", "house", "just for me"],
    5: ["The {{c1::mitochondria}} are the {{c2::powerhouses::picture}} of the cell. H<sub>2</sub>O", "Cell biology"],
    6: ['What does the picture show? <img src="cell.png">', 'A cell [sound:cell.mp3] <img src="missing.png">'],
    7: ["{{c1::image-occlusion:rect:left=.1:top=.1:width=.2:height=.2}}", '<img src="cell.png">', "Organelles", "", ""],
    8: ["Formula?", "\\(E=mc^2\\)"],
  };
  const tags: Record<string, string> = { gruss: "greeting", tiere: "animals", zelle: "cell" };
  return {
    ...fixture,
    decks: fixture.decks.map((d) => ({ ...d, name: decks[d.id] ?? d.name })),
    notes: fixture.notes.map((n) => ({ ...n, fields: fields[n.id] ?? n.fields, ...(n.tags ? { tags: n.tags.map((t) => tags[t] ?? t) } : {}) })),
    media: { "cell.png": fixture.media!["zelle.png"], "cell.mp3": fixture.media!["zelle.mp3"], "unused.png": fixture.media!["unbenutzt.png"] },
  };
}
const docPath = (c: SceneContext) => `#page=${c.ids.documentId}`;
const dbPath = (c: SceneContext) => `#page=${c.ids.databaseId}`;
const recordPath = (c: SceneContext) => `#page=${c.ids.databaseId}&row=${c.ids.rowId}`;

// A view of the database by its tab, or from "More views" when the tabs do not fit.
async function openView(page: Page, name: string) {
  const views = page.getByRole("group", { name: "Views" });
  await views.waitFor();
  const tab = views.getByRole("button", { name, exact: true });
  if (await tab.isVisible()) await tab.click();
  else {
    await views.getByRole("button", { name: /^More views/ }).click();
    await page.getByRole("menuitem", { name, exact: true }).click();
  }
}

// The phone drawer (the sidebar).
async function openDrawer(page: Page) {
  await page.locator(".mobile-tab-bar, .topbar").getByRole("button", { name: "Open navigation", exact: true }).first().click();
  await page.locator(".nav-open .sidebar").waitFor();
}

// Templates, media, trash, settings …: a row of symbols, on phones
// behind "More" in the drawer (tests/browser/sidebar-tools.ts).
async function sidebarTool(page: Page, ctx: SceneContext, name: string) {
  if (ctx.phone) {
    await openDrawer(page);
    await page.locator("aside.sidebar .sidebar-more").click();
    await dialog(page, "More").getByRole("button", { name, exact: true }).click();
  } else await page.locator("aside.sidebar .sidebar-tools").getByRole("button", { name, exact: true }).click();
}

// An entry of the page's ⋯ menu.
// The appearance entries sit in a submenu of the dropdown (a section of
// the phone sheet).
const APPEARANCE = ["Change icon", "Change cover", "Full width", "Number captions", "Change font"];
async function pageAction(page: Page, item: string) {
  await button(page, "Page actions").click();
  const sub = menu(page).getByRole("menuitem", { name: "Appearance", exact: true });
  if (APPEARANCE.includes(item) && (await sub.count())) await sub.click();
  await menu(page).getByRole("menuitem", { name: item, exact: true }).click();
}

// "Share": in the top bar, inside ⋯ on phones (tests/browser/page-top-bar.ts).
async function openShare(page: Page, ctx: SceneContext) {
  if (ctx.phone) await pageAction(page, "Share");
  else await button(page, "Share").click();
}

// The account menu: "⋯" next to the name, on phones in the "More" sheet.
async function accountMenu(page: Page, ctx: SceneContext) {
  if (ctx.phone) {
    await openDrawer(page);
    await page.locator("aside.sidebar .sidebar-more").click();
    await waitDialog(page, "More");
  } else {
    await button(page, "Account menu").click();
    await menu(page).waitFor();
  }
}

// A page of its own with the given HTML, opened, the editor ready.
async function editorWith(page: Page, ctx: SceneContext, html: string, title = "Draft") {
  const id = await ctx.fixture({ html, title });
  await ctx.open(`#page=${id}`);
  await editor(page).waitFor();
  await editor(page).locator("p, h1, h2, h3, li, table").first().waitFor();
  return id;
}

// Puts the caret at the end of a paragraph with this text.
async function caretAfter(page: Page, text: string) {
  await editor(page).getByText(text, { exact: true }).first().click();
  await page.keyboard.press("End");
}

// The block handle of the block with this text (hover on desktop).
async function blockMenu(page: Page, text: string) {
  await editor(page).getByText(text, { exact: true }).first().hover();
  await page.getByRole("button", { name: new RegExp(`^Block actions: [^·]+ · ${text}$`) }).click();
}

// Selects the words of a paragraph (the text menu shows above them).
async function selectText(page: Page, text: string) {
  const target = editor(page).getByText(text, { exact: true }).first();
  await target.click({ clickCount: 3 });
}

// "/query" + Enter in an empty line of a page of its own: the dialog of a
// block that asks before it is inserted.
async function slashInsert(page: Page, ctx: SceneContext, query: string) {
  await editorWith(page, ctx, RICH_HTML);
  await caretAfter(page, "Bravo");
  await page.keyboard.press("Enter");
  await page.keyboard.type(`/${query}`);
  await page.locator(".slash-menu").getByRole("option").first().waitFor();
  await page.keyboard.press("Enter");
}

// "Insert and more" on the whiteboard's rail, the sheet "More tools" on
// phones (tests/browser/whiteboard-ui.ts).
async function boardInsert(page: Page, name?: string) {
  await page
    .getByRole("button", { name: "Insert and more", exact: true })
    .or(page.getByRole("button", { name: "More tools", exact: true }))
    .first()
    .click();
  if (name) await page.locator(".wb-plus, .wb-sheet").getByRole("button", { name, exact: true }).first().click();
}

const RICH_HTML =
  "<h2>Goals</h2><p>We ship the new version in the autumn.</p><p>Alpha</p><p>Bravo</p><ul><li><p>Onboarding</p></li><li><p>Offline mode</p></li></ul>";

const TABLE_HTML =
  "<p>Budget</p><table><tbody><tr><th><p>Item</p></th><th><p>Amount</p></th></tr><tr><td><p>Design</p></td><td><p>1200</p></td></tr><tr><td><p>Printing</p></td><td><p>300</p></td></tr></tbody></table><p>End</p>";

// ------------------------------------------------------------------- scenes

const pages: Scene[] = [
  { id: "home", group: "Pages", title: "Start page", path: "#home" },
  { id: "inbox", group: "Pages", title: "Inbox", path: "#inbox" },
  { id: "tasks", group: "Pages", title: "My tasks", path: "#tasks" },
  {
    id: "tasks-range",
    group: "Pages",
    title: "My tasks – date range",
    covers: ["components/chip-popover.tsx"],
    path: "#tasks",
    steps: async (page) => {
      await page.getByRole("button", { name: /^Due: / }).click();
      await page.getByRole("dialog", { name: "Due" }).waitFor();
    },
  },
  {
    id: "tasks-databases",
    group: "Pages",
    title: "My tasks – all records from databases",
    path: "#tasks",
    steps: async (page) => {
      await page.locator(".my-tasks-source label", { hasText: "Databases" }).click();
      await page.locator(".my-tasks-person label", { hasText: "All" }).click();
      await page.getByRole("group", { name: "Only for records from databases" }).waitFor();
    },
  },
  { id: "graph", group: "Pages", title: "Graph", path: "#graph" },
  { id: "trash", group: "Pages", title: "Trash", path: "#trash" },
  { id: "media", group: "Pages", title: "Media library", path: "#media" },
  // A space shown as a library (#329): "New book" asks for a name only.
  {
    id: "library-new-book",
    group: "Pages",
    title: "Library: new book",
    covers: ["components/library-create-dialog.tsx"],
    steps: async (page, ctx) => {
      const name = `Handbook ${ctx.variant.id}`;
      const spaceId = (await ctx.command({ action: "space.create", workspaceId: ctx.ids.workspaceId, name })).id as string;
      await ctx.command({ action: "space.update", spaceId, name, private: false, library: true });
      await ctx.command({ action: "page.create", workspaceId: ctx.ids.workspaceId, spaceId, title: "Installation" });
      await ctx.open(`#library/${spaceId}`);
      await button(page, "New book").click();
      await waitDialog(page, "New book");
    },
  },
  { id: "tags", group: "Pages", title: "Tags", path: "#tags" },
  { id: "settings-home", group: "Pages", title: "Settings landing page", path: "#settings" },
  { id: "admin-home", group: "Pages", title: "Administration landing page", path: "#admin" },
  { id: "document", group: "Pages", title: "Document", path: docPath, steps: documentReady },
  {
    id: "document-reading",
    group: "Pages",
    title: "Document in reading mode",
    path: docPath,
    steps: async (page, ctx) => {
      await documentReady(page);
      if (ctx.phone) await pageAction(page, "Reading mode");
      else {
        await button(page, "Reading mode").click();
        await button(page, "Edit").first().waitFor();
      }
    },
  },
  { id: "database-table", group: "Pages", title: "Database (table)", path: dbPath },
  {
    id: "whiteboard",
    group: "Pages",
    title: "Whiteboard",
    path: (c) => `#page=${c.ids.whiteboardId}`,
    steps: async (page) => {
      await page.locator(".wb-canvas").first().waitFor({ timeout: 20_000 });
      await loaded(page);
    },
  },
  { id: "journal", group: "Pages", title: "Journal", path: (c) => `#page=${c.ids.journalId}`, steps: loaded },
  { id: "notebook", group: "Pages", title: "Notebook", path: (c) => `#page=${c.ids.notebookId}`, steps: loaded },
  { id: "dashboard", group: "Pages", title: "Dashboard", path: (c) => `#page=${c.ids.dashboardId}`, steps: loaded },
  { id: "workflow", group: "Pages", title: "Workflow", path: (c) => `#page=${c.ids.workflowId}`, steps: loaded },
  {
    id: "record-full-page",
    group: "Pages",
    title: "Record as a full page",
    path: (c) => `#page=${c.ids.databaseId}&row=${c.ids.rowId}&full=1`,
    steps: loaded,
  },
  { id: "welcome-page", group: "Pages", title: "Example page (Welcome)", steps: async (page, ctx) => {
    await ctx.open("#home");
    if (ctx.phone) await openDrawer(page);
    await page.getByRole("tree").getByRole("button", { name: "Welcome to Flowplan", exact: true }).click();
    await editor(page).waitFor();
  } },
];

const editorScenes: Scene[] = [
  {
    id: "slash-menu",
    group: "Documents & editor",
    title: "Slash menu",
    covers: ["components/slash-menu.tsx"],
    steps: async (page, ctx) => {
      await editorWith(page, ctx, RICH_HTML);
      await caretAfter(page, "Bravo");
      await page.keyboard.press("Enter");
      await page.keyboard.type("/");
      await page.locator(".slash-menu").waitFor();
    },
  },
  {
    id: "slash-menu-filtered",
    group: "Documents & editor",
    title: "Slash menu, filtered (/tab)",
    steps: async (page, ctx) => {
      await editorWith(page, ctx, RICH_HTML);
      await caretAfter(page, "Bravo");
      await page.keyboard.press("Enter");
      await page.keyboard.type("/tab");
      await page.locator(".slash-menu").waitFor();
    },
  },
  ...(
    [
      ["footnote", "footnote", "Footnote", "Insert footnote", ""],
      ["synced-block", "insert synced", "Synced block", "Insert synced block", ""],
      ["voice-note", "voice note", "Voice note", "Voice note", "components/voice-recorder.tsx"],
      ["embed", "embed", "Embed", "Embed content", ""],
      ["drawio", "draw.io", "draw.io diagram", "draw.io diagram", "components/drawio-editor.tsx"],
      ["mermaid", "mermaid", "Mermaid diagram", "", "components/mermaid-editor.tsx"],
      ["math", "formula", "Equation", "", "components/math-editor.tsx"],
      ["citation", "cite", "Citation", "", "components/citation-dialog.tsx"],
    ] as const
  ).map(
    ([id, query, title, name, cover]): Scene => ({
      id: `insert-${id}`,
      group: "Documents & editor",
      title: `Insert: ${title}`,
      ...(cover ? { covers: [cover] } : {}),
      steps: async (page, ctx) => {
        await slashInsert(page, ctx, query);
        if (name) await waitDialog(page, name);
        else await page.getByRole("dialog").last().waitFor();
      },
    }),
  ),
  {
    id: "code-block-menu",
    group: "Documents & editor",
    title: "Code block options",
    covers: ["components/code-block-menu.tsx"],
    steps: async (page, ctx) => {
      await editorWith(page, ctx, '<p>Example</p><pre><code class="language-ts">const answer = 42;\nconsole.log(answer);</code></pre><p>End</p>');
      await editor(page).locator("pre").hover();
      await page.getByRole("button", { name: /Code block options/ }).first().click();
    },
  },
  {
    id: "callout",
    group: "Documents & editor",
    title: "Callouts",
    steps: async (page, ctx) => {
      await editorWith(
        page,
        ctx,
        '<aside data-callout="note"><p>Note: The deadline is on Friday.</p></aside><aside data-callout="tip"><p>Tip: Templates save time.</p></aside><aside data-callout="warning"><p>Warning: Do not forget.</p></aside><p>End</p>',
      );
    },
  },
  {
    id: "block-menu",
    group: "Documents & editor",
    title: "Block menu",
    devices: ["desktop"],
    covers: ["components/block-menu.tsx"],
    steps: async (page, ctx) => {
      await editorWith(page, ctx, RICH_HTML);
      await blockMenu(page, "Alpha");
      await page.getByRole("searchbox", { name: "Search actions and block types" }).waitFor();
    },
  },
  {
    id: "block-menu-turn-into",
    group: "Documents & editor",
    title: "Block menu: turn into",
    devices: ["desktop"],
    steps: async (page, ctx) => {
      await editorWith(page, ctx, RICH_HTML);
      await blockMenu(page, "Alpha");
      await page.getByRole("menuitem", { name: /^Turn into/ }).first().hover();
      await page.getByRole("menuitemradio").first().waitFor();
    },
  },
  {
    id: "block-menu-color",
    group: "Documents & editor",
    title: "Block menu: colour",
    devices: ["desktop"],
    steps: async (page, ctx) => {
      await editorWith(page, ctx, RICH_HTML);
      await blockMenu(page, "Alpha");
      await page.getByRole("menuitem", { name: "Colour", exact: true }).hover();
      await page.getByRole("menu", { name: "Colour" }).waitFor();
    },
  },
  {
    id: "text-menu",
    group: "Documents & editor",
    title: "Text menu on a selection",
    devices: ["desktop"],
    covers: ["components/text-menu.tsx"],
    steps: async (page, ctx) => {
      await editorWith(page, ctx, RICH_HTML);
      await selectText(page, "We ship the new version in the autumn.");
      await page.locator(".text-menu, [role=toolbar]").first().waitFor();
    },
  },
  {
    id: "mention-picker",
    group: "Documents & editor",
    title: "Mention picker (@)",
    covers: ["components/editor.tsx"],
    steps: async (page, ctx) => {
      await editorWith(page, ctx, RICH_HTML);
      await caretAfter(page, "Bravo");
      await page.keyboard.type(" @Pro");
      await waitDialog(page, "Mention a page, record or person");
    },
  },
  {
    id: "link-insert",
    group: "Documents & editor",
    title: "Insert a link",
    devices: ["desktop"],
    steps: async (page, ctx) => {
      await editorWith(page, ctx, RICH_HTML);
      await selectText(page, "We ship the new version in the autumn.");
      await page.getByRole("toolbar", { name: "Text formatting" }).getByRole("button", { name: "Link", exact: true }).click();
      await waitDialog(page, "Insert link");
    },
  },
  {
    id: "link-preview",
    group: "Documents & editor",
    title: "Page link preview (hover)",
    devices: ["desktop"],
    covers: ["components/link-preview.tsx"],
    steps: async (page, ctx) => {
      await editorWith(page, ctx, `<p>Everything else is in the <a href="/#page=${ctx.ids.documentId}">Project brief</a>.</p><p>End</p>`);
      await editor(page).getByText("Project brief").hover();
      await page.locator(".link-preview").waitFor();
    },
  },
  {
    id: "page-icon-picker",
    group: "Documents & editor",
    title: "Page icon picker (emoji)",
    steps: async (page, ctx) => {
      await editorWith(page, ctx, RICH_HTML);
      await pageAction(page, "Change icon");
      await waitDialog(page, "Page icon");
    },
  },
  {
    id: "cover-picker",
    group: "Documents & editor",
    title: "Cover picker",
    covers: ["components/cover-picker.tsx"],
    steps: async (page, ctx) => {
      // Two covers uploaded, the second one set: the first is a former
      // cover, marked "Not used" with "Remove" (#396).
      const id = await ctx.fixture({ html: RICH_HTML, title: "Draft" });
      const { diagramPng } = await import("../../tests/helpers/png");
      let url = "";
      for (const name of ["Old cover.png", "New cover.png"]) {
        const upload = await ctx.api.post("/api/upload", { headers: { origin: ctx.origin }, multipart: { pageId: id, purpose: "cover", file: { name, mimeType: "image/png", buffer: diagramPng() } } });
        url = (await upload.json()).url;
      }
      await ctx.command({ action: "page.update", pageId: id, patch: { cover: url } });
      await ctx.open(`#page=${id}`);
      await editor(page).waitFor();
      await pageAction(page, "Change cover");
      await page.getByText("Not used").first().waitFor();
      await page.getByRole("dialog").last().waitFor();
    },
  },
  {
    id: "table-cell-menu",
    group: "Documents & editor",
    title: "Table: cell and handles",
    devices: ["desktop"],
    steps: async (page, ctx) => {
      await editorWith(page, ctx, TABLE_HTML);
      await editor(page).getByText("1200", { exact: true }).click();
      await editor(page).getByText("1200", { exact: true }).hover();
    },
  },
  {
    id: "table-row-menu",
    group: "Documents & editor",
    title: "Table: row menu",
    devices: ["desktop"],
    steps: async (page, ctx) => {
      await editorWith(page, ctx, TABLE_HTML);
      await editor(page).getByText("Design", { exact: true }).click();
      await button(page, "Row 2").click();
      await page.getByRole("menu", { name: "Row" }).waitFor();
    },
  },
  {
    id: "table-column-menu",
    group: "Documents & editor",
    title: "Table: column menu",
    devices: ["desktop"],
    steps: async (page, ctx) => {
      await editorWith(page, ctx, TABLE_HTML);
      await editor(page).getByText("Design", { exact: true }).click();
      await button(page, "Column 1").click();
      await page.getByRole("menu", { name: "Column" }).waitFor();
    },
  },
  {
    id: "comments-panel",
    group: "Documents & editor",
    title: "Comments panel",
    path: docPath,
    steps: async (page, ctx) => {
      if (ctx.phone) await pageAction(page, "Comments");
      else await button(page, "Comments").click();
    },
  },
  // Text comments (#314): one button, one panel with the threads and
  // "New" for a comment on the selection; a hard line break stays a line
  // break in the quote.
  {
    id: "inline-comments",
    group: "Documents & editor",
    title: "Text comments: threads and a new comment",
    covers: ["components/inline-comments.tsx"],
    steps: async (page, ctx) => {
      await editorWith(
        page,
        ctx,
        "<p>We ship the new version in the autumn.</p><p>Text 3<br>Text 4</p><p>Alpha</p>",
      );
      await selectText(page, "We ship the new version in the autumn.");
      await button(page, /^Text comments \(/).click();
      await button(page, "New text comment").click();
      await page.getByLabel("Comment on the passage", { exact: true }).fill("Does the date still work?");
      await button(page, "Send comment").click();
      await page.locator(".inline-comment-message").waitFor();
      // Wide windows show the threads and the new comment in the margin
      // next to the text (no way back, no quote); narrower ones in the panel.
      const back = button(page, "← All text comments");
      const margin = !(await back.isVisible());
      if (!margin) await back.click();
      await editor(page).locator("p").nth(1).click({ clickCount: 3 });
      await button(page, "New text comment").click();
      if (margin) await page.getByLabel("Comment on the passage", { exact: true }).last().waitFor();
      else {
        await page.locator(".inline-comment-new blockquote").waitFor();
        await page.locator(".inline-thread-link").waitFor();
      }
      // The page context has no `ctx`: pass where to scroll as an argument.
      await page.locator(".inline-comment-panel").evaluate((el, block: ScrollLogicalPosition) => el.scrollIntoView({ block }), (ctx.phone ? "start" : "center") as ScrollLogicalPosition);
    },
  },
  {
    id: "markdown-edit",
    group: "Documents & editor",
    title: "Edit as Markdown",
    steps: async (page, ctx) => {
      await editorWith(page, ctx, RICH_HTML);
      await pageAction(page, "Edit as Markdown");
      await page.getByRole("region", { name: "Markdown source" }).waitFor();
    },
  },
  {
    id: "page-review",
    group: "Documents & editor",
    title: "Owner and review",
    covers: ["components/page-review.tsx"],
    steps: async (page, ctx) => {
      await editorWith(page, ctx, RICH_HTML);
      await pageAction(page, "Owner and review …");
      await page.getByRole("dialog").last().waitFor();
    },
  },
  {
    id: "page-aliases",
    group: "Documents & editor",
    title: "Aliases",
    covers: ["components/page-aliases.tsx"],
    steps: async (page, ctx) => {
      await editorWith(page, ctx, RICH_HTML);
      await pageAction(page, "Aliases …");
      await page.getByRole("dialog").last().waitFor();
    },
  },
  {
    id: "version-history",
    group: "Documents & editor",
    title: "Version history",
    path: docPath,
    steps: async (page) => {
      await pageAction(page, "Version history");
      await waitDialog(page, "Version history");
    },
  },
  {
    id: "page-menu",
    group: "Documents & editor",
    title: "Page actions menu (⋯)",
    path: docPath,
    covers: ["components/page-menu.tsx"],
    steps: async (page) => {
      await button(page, "Page actions").click();
      await menu(page).waitFor();
    },
  },
  {
    // The submenu "Appearance" of the page menu (design review).
    id: "page-menu-appearance",
    group: "Documents & editor",
    title: "Page actions menu: Appearance",
    path: docPath,
    devices: ["desktop"],
    covers: ["components/page-menu.tsx"],
    steps: async (page) => {
      await button(page, "Page actions").click();
      await menu(page).getByRole("menuitem", { name: "Appearance", exact: true }).click();
      await menu(page).getByRole("menuitem", { name: "Change icon", exact: true }).waitFor();
    },
  },
  {
    id: "properties",
    group: "Documents & editor",
    title: "Page tags and properties",
    covers: ["components/page-properties.tsx"],
    steps: async (page, ctx) => {
      await editorWith(page, ctx, RICH_HTML);
      await button(page, "Property").first().click();
    },
  },
  {
    id: "focus-mode",
    group: "Documents & editor",
    title: "Focus mode",
    devices: ["desktop"],
    path: docPath,
    steps: async (page) => {
      await editor(page).click();
      await page.keyboard.press("ControlOrMeta+k");
      await page.getByLabel("Search or command").fill("Focus mode");
      await page.getByLabel("Search or command").press("Enter");
      await page.getByRole("status", { name: "Focus mode" }).waitFor();
    },
  },
];

const databaseScenes: Scene[] = [
  ...(
    [
      ["board", "Board"],
      ["calendar", "Calendar"],
      ["timeline", "Timeline"],
      ["gallery", "Gallery"],
      ["list", "List"],
      ["chart", "Chart"],
      ["feed", "Feed"],
    ] as const
  ).map(
    ([id, name]): Scene => ({
      id: `database-${id}`,
      group: "Databases",
      title: `View: ${name}`,
      path: dbPath,
      steps: async (page) => {
        await openView(page, name);
      },
    }),
  ),
  // The QR code of the form's link (#415): the seeded form is enabled.
  {
    id: "database-form-qr",
    group: "Databases",
    title: "Form QR code",
    covers: ["components/form-qr.tsx"],
    path: dbPath,
    steps: async (page) => {
      await openView(page, "Form");
      await button(page, "QR code").click();
      await waitDialog(page, "Form QR code");
    },
  },
  {
    id: "database-view-settings",
    group: "Databases",
    title: "View settings",
    covers: ["components/database-view.tsx"],
    path: dbPath,
    steps: async (page) => {
      await page.getByTitle("View and properties", { exact: true }).click();
      await waitDialog(page, "Configure view");
    },
  },
  {
    id: "database-filter",
    group: "Databases",
    title: "Filter menu",
    path: dbPath,
    steps: async (page) => {
      await page.getByRole("button", { name: /^Filter/ }).first().click();
    },
  },
  {
    id: "database-filter-advanced",
    group: "Databases",
    title: "Advanced filter",
    path: dbPath,
    steps: async (page) => {
      await page.getByRole("button", { name: /^Filter/ }).first().click();
      await button(page, "Advanced …").first().click();
      await waitDialog(page, "Edit filters");
    },
  },
  {
    id: "database-sort",
    group: "Databases",
    title: "Sort menu",
    path: dbPath,
    steps: async (page) => {
      await page.getByRole("button", { name: /^Sort/ }).first().click();
    },
  },
  {
    id: "database-group",
    group: "Databases",
    title: "Group menu",
    path: dbPath,
    steps: async (page) => {
      await page.getByRole("button", { name: /^Group/ }).first().click();
    },
  },
  {
    id: "database-properties-menu",
    group: "Databases",
    title: "Visible properties menu",
    path: dbPath,
    steps: async (page) => {
      await page.getByRole("button", { name: /^Properties/ }).first().click();
    },
  },
  {
    id: "database-property-settings",
    group: "Databases",
    title: "Property settings (select)",
    path: dbPath,
    devices: ["desktop"],
    steps: async (page) => {
      await page.locator(".data-table th").getByRole("button", { name: "Status" }).click();
      await waitDialog(page, "Edit property");
    },
  },
  {
    id: "database-add-view",
    group: "Databases",
    title: "Add a view",
    path: dbPath,
    steps: async (page) => {
      await button(page, "Add view").click();
    },
  },
  {
    id: "database-tools",
    group: "Databases",
    title: "More tools menu",
    path: dbPath,
    covers: ["components/database-tools.tsx"],
    steps: async (page) => {
      await button(page, "More tools").first().click();
    },
  },
  {
    id: "database-automations",
    group: "Databases",
    title: "Automations dialog",
    path: dbPath,
    // The dialogs of the "…" menu load with the first one opened.
    covers: ["components/database-tool-panels.tsx"],
    steps: async (page) => {
      await button(page, "More tools").first().click();
      await menu(page).getByRole("menuitem", { name: "Automations", exact: true }).click();
      await waitDialog(page, /^Automations ·/);
    },
  },
  {
    id: "database-automation-placeholders",
    group: "Databases",
    title: "Placeholder picker of a rule",
    path: dbPath,
    // The picker of the workflow editor in "Create task" (#413).
    covers: ["components/placeholder-picker.tsx"],
    steps: async (page) => {
      await button(page, "More tools").first().click();
      await menu(page).getByRole("menuitem", { name: "Automations", exact: true }).click();
      await waitDialog(page, /^Automations ·/);
      const rules = dialog(page, /^Automations ·/).first();
      await button(rules, "Custom rule").click();
      await rules.getByLabel("Action", { exact: true }).selectOption("task");
      await button(rules, "Insert a placeholder into “Task: text”").click();
      await page.getByRole("listbox", { name: "Placeholders" }).waitFor();
    },
  },
  {
    id: "database-export",
    group: "Databases",
    title: "Export menu",
    path: dbPath,
    steps: async (page) => {
      await button(page, "Export").first().click();
    },
  },
  {
    id: "database-calendar-sync",
    group: "Databases",
    title: "Calendar sync",
    path: dbPath,
    covers: ["components/calendar-sync-dialog.tsx"],
    steps: async (page) => {
      await button(page, "Calendar sync").click();
      await page.getByRole("dialog").last().waitFor();
    },
  },
  {
    id: "record-dialog",
    group: "Databases",
    title: "Record dialog",
    path: recordPath,
    steps: async (page) => {
      await waitDialog(page, "Record");
    },
  },
  // Flashcards (docs/specs/flashcards.md): a database without a card
  // mapping gets "Set up cards" with a study view; the focus mode with
  // a revealed card and the rating buttons.
  {
    id: "study-setup",
    group: "Databases",
    title: "Flashcards: set up cards",
    covers: ["components/database-study.tsx"],
    steps: async (page, ctx) => {
      const db = await ctx.fixture({ kind: "database", title: "Spanish A1" });
      const { database } = await (await ctx.api.get(`/api/pages/${db}`)).json();
      await ctx.command({
        action: "database.update",
        pageId: db,
        version: database.version,
        fields: [
          { id: "title", name: "Spanish", type: "text" },
          { id: "answer", name: "English", type: "text" },
        ],
        views: [{ id: "study", name: "Study", type: "study", filters: [], sorts: [], default: true }],
      });
      for (const [title, answer] of [["el perro", "the dog"], ["la ventana", "the window"]]) await ctx.command({ action: "row.create", pageId: db, cells: { title, answer } });
      await ctx.open(`#page=${db}`);
      await waitDialog(page, "Set up cards");
    },
  },
  {
    id: "study-focus",
    group: "Databases",
    title: "Flashcards: focus mode",
    covers: ["components/study/focus.tsx", "components/study/focus-core.tsx"],
    steps: async (page, ctx) => {
      const db = await ctx.fixture({ kind: "database", title: "Spanish A1" });
      const { database } = await (await ctx.api.get(`/api/pages/${db}`)).json();
      await ctx.command({
        action: "database.update",
        pageId: db,
        version: database.version,
        fields: [
          { id: "title", name: "Front", type: "text" },
          { id: "back", name: "Back", type: "text" },
        ],
        views: [{ id: "study", name: "Study", type: "study", filters: [], sorts: [], default: true }],
      });
      await ctx.command({ action: "study.settings", pageId: db, settings: { version: 1, front: { field: "title" }, back: { field: "back" } } });
      await ctx.command({ action: "row.create", pageId: db, cells: { title: "¿Dónde está la estación?", back: "Where is the station?" } });
      await ctx.open(`#page=${db}`);
      await button(page, "Start studying").click();
      await button(dialog(page, /^Study: /), /^Show answer/).click();
      await page.locator(".study-ratings").waitFor();
    },
  },
  // Flashcards phase 2/3a: cloze, typed and multiple choice cards, the wait
  // screen, the import wizard, the statistics, #study and the widget.
  {
    id: "study-import",
    group: "Databases",
    title: "Flashcards: import cards",
    covers: ["components/study/import.tsx"],
    steps: async (page, ctx) => {
      const db = await studyDeck(ctx, "Vocabulary");
      await ctx.open(`#page=${db}`);
      await button(page, "Import cards").click();
      const wizard = dialog(page, "Import cards");
      await wizard.getByLabel("Text", { exact: true }).fill("Word\tTranslation\nhola\thello\nperro\tdog\ngato\t\nla casa\tthe house");
      await wizard.locator(".study-import-preview").waitFor();
    },
  },
  // Flashcards phase 3b: the Anki import with its preview and mapping.
  {
    id: "study-anki-import",
    group: "Databases",
    title: "Flashcards: import from Anki",
    covers: ["components/study/anki-import.tsx"],
    steps: async (page, ctx) => {
      const { ankiPackage } = await import("../../tests/helpers/anki-fixture");
      await ctx.open("#study");
      await button(page, "Import from Anki").click();
      const wizard = dialog(page, "Import from Anki");
      await wizard.getByLabel("Anki file").setInputFiles({ name: "Languages.apkg", mimeType: "application/octet-stream", buffer: await ankiPackage(await englishAnkiFixture()) });
      await wizard.locator(".study-anki-notetype").first().waitFor({ timeout: 30_000 });
    },
  },
  {
    id: "study-cloze",
    group: "Databases",
    title: "Flashcards: cloze card",
    covers: ["components/study/card-parts.tsx"],
    steps: async (page, ctx) => {
      const db = await studyDeck(ctx, "Geography");
      await ctx.command({ action: "row.create", pageId: db, cells: { title: "{{c1::Paris}} lies on the {{c2::Seine::river}}.", back: "Capital of France" } });
      await ctx.open(`#page=${db}`);
      await button(page, "Start studying").click();
      await page.locator(".cloze-gap").first().waitFor();
    },
  },
  // Flashcards phase 6: the mask editor of image occlusion and a card.
  {
    id: "study-occlusion-editor",
    group: "Databases",
    title: "Flashcards: image occlusion editor",
    covers: ["components/study/occlusion-editor.tsx"],
    steps: async (page, ctx) => {
      const { db, rowId } = await occlusionDeck(ctx, "Map regions");
      await ctx.open(`#page=${db}&row=${rowId}`);
      const image = dialog(page, "Record").locator(".ProseMirror img").first();
      await image.waitFor();
      await image.click();
      await button(page, "More image actions").first().click();
      await page.getByRole("menuitem", { name: "Edit image occlusion (flashcards)" }).click();
      const editor = dialog(page, "Edit image occlusion");
      await editor.locator(".occlusion-edit-layer").waitFor();
      await editor.getByRole("button", { name: /^Card 2: select Rectangle/ }).click();
    },
  },
  {
    id: "study-occlusion",
    group: "Databases",
    title: "Flashcards: image occlusion card",
    covers: ["components/study/occlusion-image.tsx"],
    steps: async (page, ctx) => {
      const { db } = await occlusionDeck(ctx, "Learn the map");
      await ctx.open(`#page=${db}`);
      await button(page, "Start studying").click();
      await page.locator(".occlusion-card .occlusion-mask.asked").first().waitFor();
    },
  },
  {
    id: "study-typed",
    group: "Databases",
    title: "Flashcards: typed answer",
    steps: async (page, ctx) => {
      const db = await studyDeck(ctx, "Spanish typing", { type: { fixed: "typed" } });
      await ctx.command({ action: "row.create", pageId: db, cells: { title: "la estación", back: "the station" } });
      await ctx.open(`#page=${db}`);
      await button(page, "Start studying").click();
      await page.getByLabel("Your answer").fill("the staton");
      await page.getByLabel("Your answer").press("Enter");
      await page.locator(".study-typed-result").waitFor();
    },
  },
  {
    id: "study-choice",
    group: "Databases",
    title: "Flashcards: multiple choice",
    steps: async (page, ctx) => {
      const db = await studyDeck(ctx, "Capitals", { type: { fixed: "choice" } });
      for (const [title, back] of [["Capital of Spain?", "Madrid"], ["Capital of Italy?", "Rome"], ["Capital of Poland?", "Warsaw"], ["Capital of Portugal?", "Lisbon"]])
        await ctx.command({ action: "row.create", pageId: db, cells: { title, back } });
      await ctx.open(`#page=${db}`);
      await button(page, "Start studying").click();
      await page.locator(".study-choice").first().click();
      await page.locator(".study-ratings").waitFor();
    },
  },
  {
    id: "study-stats",
    group: "Databases",
    title: "Flashcards: statistics",
    covers: ["components/study/stats.tsx"],
    steps: async (page, ctx) => {
      const db = await studyDeck(ctx, "Spanish B1");
      await studied(ctx, db);
      await ctx.open(`#page=${db}`);
      await button(page.locator(".study-deck"), "Statistics").click();
      await page.locator(".study-stats").waitFor();
    },
  },
  {
    // Flashcards phase 8: the FSRS parameters fitted to 1161 synthetic
    // ratings in the browser, with before/after and the recommended retention.
    id: "study-optimize",
    group: "Databases",
    title: "Flashcards: optimise FSRS parameters",
    covers: ["components/study/optimize.tsx"],
    steps: async (page, ctx) => {
      const { syntheticReviews } = await import("../../tests/helpers/fsrs-synthetic");
      const db = await studyDeck(ctx, "Spanish C1");
      await ctx.command({ action: "rows.import", pageId: db, rows: Array.from({ length: 150 }, (_, i) => ({ title: `palabra ${i + 1}`, back: `word ${i + 1}` })) });
      const { rows } = await (await ctx.api.get(`/api/pages/${db}`)).json();
      const ids = (rows as { id: string; cells: { title: string } }[]).sort((a, b) => Number(a.cells.title.split(" ")[1]) - Number(b.cells.title.split(" ")[1])).map((r) => r.id);
      const reviews = syntheticReviews(db, ids);
      for (let i = 0; i < reviews.length; i += 500) await ctx.command({ action: "study.reviews", reviews: reviews.slice(i, i + 500) });
      await ctx.open(`#page=${db}`);
      await button(page.locator(".study-deck"), "My settings").click();
      await button(dialog(page, "My settings"), "Optimise parameters …").click();
      const optimize = dialog(page, "Optimise parameters");
      await button(optimize, "Optimise").click();
      await optimize.locator(".study-optimize-result").waitFor({ timeout: 60_000 });
    },
  },
  {
    id: "study-screen",
    group: "Pages",
    title: "Flashcards: #study",
    covers: ["components/study/screen.tsx"],
    steps: async (page, ctx) => {
      const db = await studyDeck(ctx, "Spanish A1");
      await studied(ctx, db);
      await ctx.open("#study");
      await page.locator(".study-deck-list").waitFor();
    },
  },
  {
    id: "home-study-widget",
    group: "Pages",
    title: "Start page: due cards",
    steps: async (page, ctx) => {
      const db = await studyDeck(ctx, "Spanish A1");
      for (const [title, back] of [["hola", "hello"], ["perro", "dog"], ["gato", "cat"]]) await ctx.command({ action: "row.create", pageId: db, cells: { title, back } });
      await ctx.command({
        action: "home.save",
        workspaceId: ctx.ids.workspaceId,
        layout: {
          version: 1,
          widgets: [{ id: "cards", kind: "study", size: "m", config: {} }],
          appearance: { header: { type: "none", value: "", position: 50 }, density: "comfortable", background: "none", icon: "", width: "normal" },
        },
      });
      await ctx.open("#home");
      await page.locator(".home-study-total").waitFor();
      // The seeded start page again for the scenes after this one.
      await ctx.command({ action: "home.reset", workspaceId: ctx.ids.workspaceId });
    },
  },
  {
    // A due date with a time ("+ Time", #314) and a weekly repeating task
    // that counts on from it, with a second date property to choose from.
    id: "record-date-time-repeat",
    group: "Databases",
    title: "Record with a time and a repeating task",
    covers: ["components/record-repeat.tsx"],
    steps: async (page, ctx) => {
      const db = await ctx.fixture({ kind: "database", title: "Appointments" });
      const read = async () => (await ctx.api.get(`/api/pages/${db}`)).json();
      const { database } = await read();
      await ctx.command({
        action: "database.update",
        pageId: db,
        version: database.version,
        fields: [...database.fields, { id: "start", name: "Start", type: "date" }],
        views: database.views,
      });
      const row = await ctx.command({
        action: "row.create",
        pageId: db,
        cells: { title: "Weekly report", date: "2026-10-12T07:30:00Z", start: "2026-10-05" },
      });
      const version = (await read()).rows.find((r: { id: string }) => r.id === row.id).version;
      await ctx.command({
        action: "row.repeat",
        pageId: db,
        rowId: row.id,
        version,
        repeat: { freq: "weekly", interval: 1, weekdays: [1], field: "date", timeZone: "UTC" },
      });
      await ctx.open(`#page=${db}&row=${row.id}`);
      await waitDialog(page, "Record");
    },
  },
  {
    id: "record-share",
    group: "Databases",
    title: "Share a record",
    path: recordPath,
    covers: ["components/record-share-dialog.tsx"],
    steps: async (page) => {
      const record = dialog(page, "Record");
      await record.getByRole("button", { name: "Share" }).first().click();
      await waitDialog(page, "Share record");
    },
  },
  {
    id: "record-select-cell",
    group: "Databases",
    title: "Select cell editor",
    path: dbPath,
    devices: ["desktop"],
    steps: async (page) => {
      await page.locator(".data-table tbody tr").first().getByRole("gridcell", { name: "In progress" }).click();
      await page.keyboard.press("Enter");
    },
  },
  {
    id: "record-date-cell",
    group: "Databases",
    title: "Date cell editor",
    path: dbPath,
    devices: ["desktop"],
    steps: async (page) => {
      await page.locator(".data-table tbody tr").first().getByRole("gridcell", { name: "Oct 12, 2026" }).click();
      await page.keyboard.press("Enter");
    },
  },
  {
    id: "form-public",
    group: "Public",
    title: "Form (public)",
    path: (c) => `/forms/${c.ids.formToken}`,
    signedOut: true,
  },
];

const whiteboardScenes: Scene[] = [
  {
    id: "whiteboard-insert",
    group: "Whiteboard",
    title: "Insert and more",
    path: (c) => `#page=${c.ids.whiteboardId}`,
    steps: async (page) => {
      await boardInsert(page);
    },
  },
  {
    id: "whiteboard-moderation",
    group: "Whiteboard",
    title: "Moderation",
    path: (c) => `#page=${c.ids.whiteboardId}`,
    covers: ["components/whiteboard/whiteboard.tsx"],
    steps: async (page) => {
      await button(page, "Facilitation").click();
      await waitDialog(page, "Facilitation");
    },
  },
  {
    id: "whiteboard-view",
    group: "Whiteboard",
    title: "View and actions",
    path: (c) => `#page=${c.ids.whiteboardId}`,
    steps: async (page) => {
      await button(page, "View and actions").click();
      await waitDialog(page, "View and actions");
    },
  },
  {
    id: "whiteboard-templates",
    group: "Whiteboard",
    title: "Board templates",
    path: (c) => `#page=${c.ids.whiteboardId}`,
    covers: ["components/whiteboard/template-gallery.tsx"],
    steps: async (page) => {
      await boardInsert(page, "Templates");
      await page.getByRole("dialog").last().waitFor();
    },
  },
  {
    id: "whiteboard-shapes",
    group: "Whiteboard",
    title: "Shape library",
    path: (c) => `#page=${c.ids.whiteboardId}`,
    covers: ["components/whiteboard/shape-library.tsx"],
    steps: async (page) => {
      await boardInsert(page, "Shape library");
      await waitDialog(page, "Shape library");
    },
  },
  ...(
    [
      ["media", "Search images and icons", "Images and symbols", "components/whiteboard/media-search.tsx"],
      ["embed", "Embed", "Embed", "components/whiteboard/embed-dialog.tsx"],
      ["mermaid", "Import Mermaid/PlantUML …", "Import Mermaid/PlantUML", "components/whiteboard/diagram-panels.tsx"],
      ["racks", "Racks", "Racks and devices", "components/whiteboard/rack-panels.tsx"],
      ["emoji", "Emoji", "Emoji", ""],
      ["stamp", "Stamp", "Stamps", ""],
    ] as const
  ).map(
    ([id, name, title, cover]): Scene => ({
      id: `whiteboard-${id}`,
      group: "Whiteboard",
      title,
      path: (c) => `#page=${c.ids.whiteboardId}`,
      ...(cover ? { covers: [cover] } : {}),
      steps: async (page) => {
        await boardInsert(page, name);
        // Stamps and emoji open a panel at the rail, the others a dialog.
        if (id !== "stamp" && id !== "emoji") await page.getByRole("dialog").last().waitFor();
      },
    }),
  ),
  {
    id: "whiteboard-draw",
    group: "Whiteboard",
    title: "Pen options",
    path: (c) => `#page=${c.ids.whiteboardId}`,
    steps: async (page) => {
      await button(page, "Draw").click();
    },
  },
];

const journalScenes: Scene[] = [
  {
    id: "journal-today",
    group: "Journal",
    title: "Today's page",
    path: (c) => `#page=${c.ids.journalId}`,
    realTime: true,
    steps: async (page) => {
      await page.getByRole("button", { name: /^Today/ }).first().click();
      await editor(page).waitFor();
    },
  },
  {
    id: "journal-pick-day",
    group: "Journal",
    title: "Pick a day",
    path: (c) => `#page=${c.ids.journalId}`,
    covers: ["components/journal-nav.tsx"],
    realTime: true,
    steps: async (page) => {
      await page.getByRole("button", { name: /^Today/ }).first().click();
      await editor(page).waitFor();
      await page.getByRole("button", { name: /^Choose a day/ }).click();
      await waitDialog(page, "Choose a day in the journal");
    },
  },
  {
    id: "journal-settings",
    group: "Journal",
    title: "Journal settings",
    path: (c) => `#page=${c.ids.journalId}`,
    covers: ["components/journal-parts.tsx"],
    steps: async (page) => {
      await button(page, "Set up journal").click();
      await waitDialog(page, "Set up journal");
    },
  },
  {
    id: "journal-review",
    group: "Journal",
    title: "Review",
    path: (c) => `#page=${c.ids.journalId}`,
    steps: async (page) => {
      await button(page, "Review").click();
      await waitDialog(page, "Review");
    },
  },
  {
    id: "journal-calendar",
    group: "Journal",
    title: "Journal as a calendar",
    path: (c) => `#page=${c.ids.journalId}`,
    steps: async (page) => {
      await page.getByRole("group", { name: "Display" }).getByRole("button", { name: "Calendar" }).click();
    },
  },
];

const dialogScenes: Scene[] = [
  {
    id: "search-palette",
    group: "Dialogs",
    title: "Search palette",
    covers: ["components/workspace-app.tsx"],
    path: "#home",
    steps: async (page) => {
      await page.keyboard.press("ControlOrMeta+k");
      await page.getByLabel("Search or command").fill("Pro");
      await dialog(page, "Quick search").getByText("Project brief").first().waitFor();
    },
  },
  {
    id: "command-palette",
    group: "Dialogs",
    title: "Command palette (>)",
    path: "#home",
    steps: async (page) => {
      await page.keyboard.press("ControlOrMeta+k");
      await page.getByLabel("Search or command").fill(">");
    },
  },
  {
    id: "new-page",
    group: "Dialogs",
    title: "New page",
    path: "#new",
    covers: ["components/new-page-dialog.tsx"],
    steps: async (page) => {
      await waitDialog(page, "New page");
    },
  },
  {
    // "Database" with its kinds as one segmented row (#314: "Documents"
    // sat on its border).
    id: "new-page-database",
    group: "Dialogs",
    title: "New page: database kinds",
    path: "#new",
    steps: async (page) => {
      await waitDialog(page, "New page");
      await dialog(page, "New page").getByRole("radio", { name: /^Database/ }).click();
      await page.locator(".np-kind").waitFor();
    },
  },
  {
    id: "new-workspace",
    group: "Dialogs",
    title: "New workspace",
    path: "#home",
    devices: ["desktop"],
    steps: async (page) => {
      await page.getByRole("button", { name: /My workspace/ }).first().click();
      await menu(page).getByRole("menuitem", { name: "Create workspace" }).click();
      await page.getByRole("dialog").last().waitFor();
    },
  },
  {
    id: "workspace-switcher",
    group: "Dialogs",
    title: "Workspace switcher",
    path: "#home",
    devices: ["desktop"],
    steps: async (page) => {
      await page.getByRole("button", { name: /My workspace/ }).first().click();
      await menu(page).waitFor();
    },
  },
  {
    id: "share",
    group: "Dialogs",
    title: "Share page",
    path: docPath,
    covers: ["components/share-dialog.tsx"],
    steps: async (page, ctx) => {
      await openShare(page, ctx);
      await waitDialog(page, "Share page");
    },
  },
  {
    id: "move-page",
    group: "Dialogs",
    title: "Move page",
    path: docPath,
    covers: ["components/move-page-dialog.tsx"],
    steps: async (page) => {
      await pageAction(page, "Move");
      await waitDialog(page, "Move page");
    },
  },
  {
    id: "page-to-records",
    group: "Dialogs",
    title: "Move into a database",
    path: docPath,
    covers: ["components/page-to-record.tsx"],
    steps: async (page) => {
      await pageAction(page, "Move into database …");
      await page.getByRole("dialog").last().waitFor();
    },
  },
  {
    id: "export-page",
    group: "Dialogs",
    title: "Export page",
    path: docPath,
    covers: ["components/page-export.tsx"],
    steps: async (page) => {
      await pageAction(page, "Export");
      await waitDialog(page, "Export page");
    },
  },
  {
    id: "print",
    group: "Dialogs",
    title: "Print / PDF",
    path: docPath,
    covers: ["components/print-dialog.tsx"],
    steps: async (page) => {
      await pageAction(page, "Print / PDF");
      await waitDialog(page, "Print / PDF");
    },
  },
  {
    id: "save-as-template",
    group: "Dialogs",
    title: "Save as template",
    path: docPath,
    steps: async (page) => {
      await pageAction(page, "Save as template");
      await page.getByRole("dialog").last().waitFor();
    },
  },
  {
    id: "templates",
    group: "Dialogs",
    title: "Templates",
    path: "#home",
    steps: async (page, ctx) => {
      await sidebarTool(page, ctx, "Templates");
      await waitDialog(page, "Templates");
    },
  },
  {
    id: "keyboard-shortcuts",
    group: "Dialogs",
    title: "Keyboard shortcuts",
    path: "#home",
    covers: ["components/keyboard-shortcuts.tsx"],
    steps: async (page, ctx) => {
      await sidebarTool(page, ctx, "Keyboard shortcuts");
      await waitDialog(page, "Keyboard shortcuts");
    },
  },
  {
    id: "account-menu",
    group: "Dialogs",
    title: "Account menu",
    path: "#home",
    steps: async (page, ctx) => {
      await accountMenu(page, ctx);
    },
  },
  {
    id: "whats-new",
    group: "Dialogs",
    title: "What's new",
    path: "#home",
    covers: ["components/whats-new.tsx"],
    steps: async (page, ctx) => {
      await accountMenu(page, ctx);
      await page.getByRole(ctx.phone ? "button" : "menuitem", { name: "What’s new" }).first().click();
      await page.getByRole("dialog").last().waitFor();
    },
  },
  {
    id: "onboarding",
    group: "Dialogs",
    title: "Introduction (onboarding)",
    path: "#settings/appearance",
    covers: ["components/onboarding.tsx"],
    steps: async (page) => {
      await button(page, "Start introduction").click();
      await waitDialog(page, "Welcome to Flowplan");
    },
  },
  {
    id: "space-manager",
    group: "Dialogs",
    title: "Manage a space",
    path: "#home",
    covers: ["components/space-manager.tsx"],
    steps: async (page, ctx) => {
      if (ctx.phone) await openDrawer(page);
      await button(page, "Manage space Teamspace").click();
      await page.getByRole("menuitem", { name: "Edit space …" }).click();
      await waitDialog(page, "Manage space");
    },
  },
  {
    id: "add-space",
    group: "Dialogs",
    title: "Add a space",
    path: "#home",
    steps: async (page, ctx) => {
      if (ctx.phone) await openDrawer(page);
      await button(page, "Add space").click();
      await waitDialog(page, "Add space");
    },
  },
  {
    id: "capture",
    group: "Dialogs",
    title: "Quick capture",
    path: "#capture",
    covers: ["components/quick-capture.tsx"],
    steps: async (page) => {
      await waitDialog(page, "Capture");
    },
  },
  {
    id: "trash-toast",
    group: "Dialogs",
    title: "Toast: moved to the trash, with undo",
    steps: async (page, ctx) => {
      await editorWith(page, ctx, RICH_HTML, "Throwaway");
      await pageAction(page, "Move to trash");
      await page.getByRole("status").filter({ hasText: "moved to the trash" }).waitFor();
    },
  },
  {
    id: "home-add-widget",
    group: "Dialogs",
    title: "Start page: add a widget",
    path: "#home",
    steps: async (page) => {
      await button(page, "Customize").click();
      await page.locator(".home-editor, [class*=home-edit]").getByRole("button").first().click();
      await page.getByRole("dialog").last().waitFor();
    },
  },
  {
    id: "space-export",
    group: "Dialogs",
    title: "Export a space",
    path: "#home",
    covers: ["components/space-export.tsx"],
    steps: async (page, ctx) => {
      if (ctx.phone) await openDrawer(page);
      await button(page, "Export Teamspace as Markdown").click();
      await page.getByRole("dialog").last().waitFor();
    },
  },
  {
    id: "page-tree-select",
    group: "Dialogs",
    title: "Page tree: select pages",
    path: "#home",
    steps: async (page, ctx) => {
      if (ctx.phone) await openDrawer(page);
      // Library spaces of other scenes have the button too: the first space's.
      await button(page, "Select pages").first().click();
    },
  },
  {
    id: "new-collection",
    group: "Dialogs",
    title: "New collection",
    path: "#home",
    covers: ["components/collection-editor.tsx"],
    steps: async (page, ctx) => {
      if (ctx.phone) await openDrawer(page);
      await button(page, "New collection").click();
      await page.getByRole("dialog").last().waitFor();
    },
  },
  {
    id: "invite-member",
    group: "Dialogs",
    title: "Invite a member",
    path: "#settings/members",
    covers: ["components/settings/user/members.tsx"],
    steps: async (page) => {
      await page.getByRole("button", { name: /Invite member|Invite/ }).first().click();
      await page.getByRole("dialog").last().waitFor();
    },
  },
  {
    id: "e2ee-setup",
    group: "Dialogs",
    title: "Set up end-to-end encryption",
    path: "#settings/account/encryption",
    covers: ["components/e2ee.tsx"],
    steps: async (page) => {
      await page.getByRole("button", { name: /Set up encryption/ }).first().click();
      await waitDialog(page, "Set up encryption");
    },
  },
  {
    id: "workspace-icon",
    group: "Dialogs",
    title: "Workspace icon",
    path: "#settings/workspace",
    covers: ["components/workspace-icon.tsx"],
    steps: async (page) => {
      await page.getByRole("button", { name: /Emoji or icon/ }).first().click();
      await page.getByRole("dialog").last().waitFor();
      // The emoji picker loads on demand ("Loading emojis …").
      await page.getByRole("dialog").last().getByLabel(/Search emoji/).waitFor();
    },
  },
  {
    id: "empty-trash",
    group: "Dialogs",
    title: "Confirm: empty the trash",
    covers: ["components/trash-view.tsx"],
    steps: async (page, ctx) => {
      await ctx.command({ action: "page.delete", pageId: await ctx.fixture({ title: "Old draft" }) });
      await ctx.open("#trash");
      await button(page, "Empty trash").click();
      await page.getByRole("dialog").or(page.getByRole("alertdialog")).last().waitFor();
    },
  },
  {
    id: "move-records",
    group: "Dialogs",
    title: "Move selected records",
    path: dbPath,
    devices: ["desktop"],
    covers: ["components/record-transfer.tsx"],
    steps: async (page) => {
      await page.getByRole("checkbox", { name: "Select Simplify onboarding" }).check();
      await page.getByRole("checkbox", { name: "Select Mobile navigation" }).check();
      await page.getByRole("button", { name: /Move/ }).first().click();
      await page.getByRole("dialog").or(page.getByRole("menu")).last().waitFor();
    },
  },
  {
    id: "space-menu",
    group: "Dialogs",
    title: "Space menu",
    path: "#home",
    steps: async (page, ctx) => {
      if (ctx.phone) await openDrawer(page);
      await button(page, "Manage space Teamspace").click();
      await page.getByRole("menu", { name: "Manage space Teamspace" }).waitFor();
    },
  },
  {
    id: "home-customize",
    group: "Dialogs",
    title: "Customise the start page",
    path: "#home",
    covers: ["components/home/home-editor.tsx"],
    steps: async (page) => {
      await button(page, "Customize").click();
      // The editor loads on demand: wait for it, not an empty page.
      await page.getByText("Customize home page").first().waitFor();
    },
  },
  {
    id: "workflow-dry-run",
    group: "Dialogs",
    title: "Workflow: dry run",
    devices: ["desktop"],
    path: (c) => `#page=${c.ids.workflowId}`,
    covers: ["components/workflow/dialogs.tsx"],
    steps: async (page) => {
      await button(page, "Dry run").click();
      await waitDialog(page, "Dry run");
    },
  },
  {
    id: "workflow-settings",
    group: "Dialogs",
    title: "Workflow: settings",
    devices: ["desktop"],
    path: (c) => `#page=${c.ids.workflowId}`,
    covers: ["components/workflow/dialogs.tsx"],
    steps: async (page) => {
      await button(page, "Workflow settings").click();
      await waitDialog(page, "Workflow settings");
    },
  },
  {
    id: "workflow-activate",
    group: "Dialogs",
    title: "Workflow: activate",
    devices: ["desktop"],
    path: (c) => `#page=${c.ids.workflowId}`,
    steps: async (page) => {
      await button(page, "Activate").click();
      await waitDialog(page, "Activate the workflow");
    },
  },
  {
    id: "workflow-add-node",
    group: "Dialogs",
    title: "Workflow: add a node",
    devices: ["desktop"],
    path: (c) => `#page=${c.ids.workflowId}`,
    steps: async (page) => {
      await button(page, "Insert a node in between").first().click();
      await waitDialog(page, "Insert a node in between");
    },
  },
  {
    id: "dashboard-add-tile",
    group: "Dialogs",
    title: "Dashboard: add a tile",
    path: (c) => `#page=${c.ids.dashboardId}`,
    covers: ["components/dashboard-view.tsx"],
    steps: async (page) => {
      await button(page, "Add the first tile").click();
      await page.getByRole("dialog").last().waitFor();
    },
  },
  {
    id: "notebook-paper",
    group: "Dialogs",
    title: "Notebook: paper",
    path: (c) => `#page=${c.ids.notebookId}`,
    covers: ["components/notebook/paper-dialog.tsx"],
    steps: async (page) => {
      await button(page, "Change paper").click();
      await waitDialog(page, "Paper");
    },
  },
  {
    id: "notebook-pen",
    group: "Dialogs",
    title: "Notebook: pen settings",
    path: (c) => `#page=${c.ids.notebookId}`,
    covers: ["components/ink/ink-panel.tsx"],
    steps: async (page) => {
      await button(page, "Pen settings").click();
      await page.getByRole("dialog").last().waitFor();
    },
  },
  {
    id: "notebook-insert",
    group: "Dialogs",
    title: "Notebook: image or sticker",
    path: (c) => `#page=${c.ids.notebookId}`,
    covers: ["components/notebook/notebook-insert.tsx"],
    steps: async (page) => {
      await button(page, "Insert picture or sticker").click();
      await page.getByRole("dialog").or(page.getByRole("menu")).last().waitFor();
    },
  },
  {
    id: "delete-account",
    group: "Dialogs",
    title: "Confirm: delete account",
    path: "#settings/account/delete-account",
    covers: ["components/delete-own-account.tsx"],
    steps: async (page) => {
      await button(page, "Delete account …").or(button(page, "Delete account")).first().click();
      await waitDialog(page, "Delete your account?");
    },
  },
];

// One scene per section of the settings and the administration
// (lib/settings-sections.ts), so a new section shows up by itself.
const sectionScenes: Scene[] = SETTINGS_SECTIONS.map((s) => ({
  id: `${s.area}-${s.id}`,
  group: s.area === "admin" ? "Admin" : "Settings",
  title: s.title.en,
  path: `#${s.area}/${s.id}`,
  steps: async (page: Page) => {
    await page.getByRole("heading", { name: s.title.en, level: 1 }).first().waitFor();
  },
}));

const authScenes: Scene[] = [
  { id: "sign-in", group: "Auth", title: "Sign-in", path: "/login", signedOut: true },
  {
    id: "sign-in-password",
    group: "Auth",
    title: "Sign-in with e-mail and password",
    path: "/login",
    signedOut: true,
    steps: async (page) => {
      await page.locator(".login-ways:not([data-pending])").waitFor();
      const link = button(page, "With e-mail and password");
      if (await link.isVisible()) await link.click();
      await page.locator("input[name=email]").waitFor();
    },
  },
  { id: "register", group: "Auth", title: "Register", path: "/register", signedOut: true },
  { id: "reset", group: "Auth", title: "Reset password", path: "/reset", signedOut: true },
  // The links of a change of the e-mail address (#405): nothing happens before the button.
  { id: "email-change-confirm", group: "Auth", title: "Confirm new e-mail address", path: "/email-change?token=gallery-example", signedOut: true },
  { id: "email-change-cancel", group: "Auth", title: "Cancel e-mail address change", path: "/email-change?token=gallery-example&cancel=1", signedOut: true },
];

const publicScenes: Scene[] = [
  { id: "public-document", group: "Public", title: "Published document", path: (c) => `/share/${c.ids.publicDocToken}`, signedOut: true },
  { id: "public-database", group: "Public", title: "Published database", path: (c) => `/share/${c.ids.publicDbToken}`, signedOut: true },
  { id: "share-link", group: "Public", title: "Share link (editor)", path: (c) => `/share/${c.ids.shareLinkToken}`, signedOut: true },
  { id: "public-templates", group: "Public", title: "Template gallery", path: "/templates", signedOut: true },
  // A published deck: its cards to browse (one turned over) and the
  // practice without an account (state in the browser only).
  {
    id: "public-study-browse",
    group: "Public",
    title: "Published deck: browse",
    signedOut: true,
    covers: ["components/public-study.tsx"],
    steps: async (page, ctx) => {
      await ctx.open(`/share/${await publishedDeck(ctx)}`);
      await page.locator(".public-flashcard").first().click();
      await page.locator(".public-flashcard.flipped").waitFor();
    },
  },
  {
    id: "public-study-practice",
    group: "Public",
    title: "Published deck: practise",
    signedOut: true,
    covers: ["components/study/public-practice.tsx"],
    steps: async (page, ctx) => {
      await ctx.open(`/share/${await publishedDeck(ctx)}`);
      await button(page, "Practise").click();
      await page.locator(".public-study-note").waitFor();
      await button(page, /^Show answer/).click();
      await page.locator(".study-ratings").waitFor();
    },
  },
];

const errorScenes: Scene[] = [
  { id: "not-found", group: "Errors", title: "404", path: "/does-not-exist", signedOut: true },
  { id: "not-found-signed-in", group: "Errors", title: "404 (signed in)", path: "/does-not-exist" },
  {
    id: "unknown-page",
    group: "Errors",
    title: "Unknown page link",
    path: "#page=00000000-0000-4000-8000-000000000000",
  },
  {
    id: "offline-banner",
    group: "Errors",
    title: "Offline banner",
    path: docPath,
    steps: async (page) => {
      await page.context().setOffline(true);
      await page.evaluate(() => window.dispatchEvent(new Event("offline")));
      await page.waitForTimeout(1500);
    },
  },
];

const mobileScenes: Scene[] = [
  {
    id: "phone-drawer",
    group: "Mobile-only",
    title: "Navigation drawer",
    path: "#home",
    devices: ["phone"],
    steps: async (page) => {
      await openDrawer(page);
    },
  },
  {
    id: "phone-more",
    group: "Mobile-only",
    title: "\"More\" sheet",
    path: "#home",
    devices: ["phone"],
    covers: ["components/sidebar-tools.tsx"],
    steps: async (page) => {
      await openDrawer(page);
      await page.locator("aside.sidebar .sidebar-more").click();
      await waitDialog(page, "More");
    },
  },
  {
    id: "phone-new-page",
    group: "Mobile-only",
    title: "New page sheet (tab bar)",
    path: "#home",
    devices: ["phone"],
    steps: async (page) => {
      await page.locator(".mobile-tab-bar").getByRole("button", { name: "New page" }).click();
      await waitDialog(page, "New page");
    },
  },
  {
    id: "phone-page-menu",
    group: "Mobile-only",
    title: "Page menu sheet",
    path: docPath,
    covers: ["components/page-menu.tsx"],
    devices: ["phone"],
    steps: async (page) => {
      await button(page, "Page actions").click();
      await menu(page).waitFor();
    },
  },
  {
    id: "phone-slash-menu-sheet",
    group: "Mobile-only",
    title: "Block insert on phones",
    devices: ["phone"],
    steps: async (page, ctx) => {
      await editorWith(page, ctx, RICH_HTML);
      await editor(page).getByText("Bravo", { exact: true }).tap();
      await page.keyboard.press("End");
      await page.keyboard.press("Enter");
      await page.keyboard.type("/");
      await page.locator(".slash-menu").waitFor();
    },
  },
  {
    id: "phone-database-record",
    group: "Mobile-only",
    title: "Record sheet",
    path: recordPath,
    devices: ["phone"],
    steps: async (page) => {
      await waitDialog(page, "Record");
    },
  },
];

export const SCENES: Scene[] = [
  ...pages,
  ...editorScenes,
  ...databaseScenes,
  ...whiteboardScenes,
  ...journalScenes,
  ...dialogScenes,
  ...sectionScenes,
  ...authScenes,
  ...publicScenes,
  ...errorScenes,
  ...mobileScenes,
];
