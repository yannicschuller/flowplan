import type { Locator, Page } from "@playwright/test";
import { SETTINGS_SECTIONS } from "../../lib/settings-sections";
import type { Scene, SceneContext } from "./types";

// Every scene of the UI gallery (scripts/gallery/run.ts). A scene opens a
// place of the app and clicks its way to what should be seen – with the same
// accessible locators as the browser specs in tests/browser. Each runs in a
// fresh browser context per variant (desktop/phone × light/dark); one that
// changes content works on a page of its own (ctx.fixture).
//
// `covers` names the component files whose dialog, menu or popover the
// scene shows; tests/gallery-coverage.test.ts checks that every such file
// has a scene or is listed in scripts/gallery/uncovered.json.

// ------------------------------------------------------------------ helpers

const dialog = (page: Page, name: string | RegExp) => page.getByRole("dialog", { name, exact: typeof name === "string" });
const waitDialog = (page: Page, name: string | RegExp) => dialog(page, name).first().waitFor();
const menu = (page: Page) => page.getByRole("menu").last();
const button = (scope: Page | Locator, name: string | RegExp) => scope.getByRole("button", { name, exact: typeof name === "string" });
const editor = (page: Page) => page.getByLabel("Dokumentinhalt", { exact: true });

const docPath = (c: SceneContext) => `#page=${c.ids.documentId}`;
const dbPath = (c: SceneContext) => `#page=${c.ids.databaseId}`;
const recordPath = (c: SceneContext) => `#page=${c.ids.databaseId}&row=${c.ids.rowId}`;

// A view of the database by its tab, or from "Weitere" when the tabs do not fit.
async function openView(page: Page, name: string) {
  const views = page.getByRole("group", { name: "Ansichten" });
  await views.waitFor();
  const tab = views.getByRole("button", { name, exact: true });
  if (await tab.isVisible()) await tab.click();
  else {
    await views.getByRole("button", { name: /^Weitere Ansichten/ }).click();
    await page.getByRole("menuitem", { name, exact: true }).click();
  }
}

// The phone drawer (the sidebar).
async function openDrawer(page: Page) {
  await page.locator(".mobile-tab-bar, .topbar").getByRole("button", { name: "Navigation öffnen", exact: true }).first().click();
  await page.locator(".nav-open .sidebar").waitFor();
}

// Vorlagen, Medien, Papierkorb, Einstellungen …: a row of symbols, on phones
// behind "Mehr" in the drawer (tests/browser/sidebar-tools.ts).
async function sidebarTool(page: Page, ctx: SceneContext, name: string) {
  if (ctx.phone) {
    await openDrawer(page);
    await page.locator("aside.sidebar .sidebar-more").click();
    await dialog(page, "Mehr").getByRole("button", { name, exact: true }).click();
  } else await page.locator("aside.sidebar .sidebar-tools").getByRole("button", { name, exact: true }).click();
}

// An entry of the page's ⋯ menu.
async function pageAction(page: Page, item: string) {
  await button(page, "Seitenaktionen").click();
  await menu(page).getByRole("menuitem", { name: item, exact: true }).click();
}

// "Teilen": in the top bar, inside ⋯ on phones (tests/browser/page-top-bar.ts).
async function openShare(page: Page, ctx: SceneContext) {
  if (ctx.phone) await pageAction(page, "Teilen");
  else await button(page, "Teilen").click();
}

// The account menu: "⋯" next to the name, on phones in the "Mehr" sheet.
async function accountMenu(page: Page, ctx: SceneContext) {
  if (ctx.phone) {
    await openDrawer(page);
    await page.locator("aside.sidebar .sidebar-more").click();
    await waitDialog(page, "Mehr");
  } else {
    await button(page, "Kontomenü").click();
    await menu(page).waitFor();
  }
}

// A page of its own with the given HTML, opened, the editor ready.
async function editorWith(page: Page, ctx: SceneContext, html: string, title = "Entwurf") {
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
  await page.getByRole("button", { name: new RegExp(`^Blockaktionen: [^·]+ · ${text}$`) }).click();
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

// "Einfügen und mehr" on the whiteboard's rail, the sheet "Weitere
// Werkzeuge" on phones (tests/browser/whiteboard-ui.ts).
async function boardInsert(page: Page, name?: string) {
  await page
    .getByRole("button", { name: "Einfügen und mehr", exact: true })
    .or(page.getByRole("button", { name: "Weitere Werkzeuge", exact: true }))
    .first()
    .click();
  if (name) await page.locator(".wb-plus, .wb-sheet").getByRole("button", { name, exact: true }).first().click();
}

const RICH_HTML =
  "<h2>Ziele</h2><p>Wir bringen die neue Version im Herbst heraus.</p><p>Alpha</p><p>Bravo</p><ul><li><p>Onboarding</p></li><li><p>Offline-Modus</p></li></ul>";

const TABLE_HTML =
  "<p>Budget</p><table><tbody><tr><th><p>Posten</p></th><th><p>Betrag</p></th></tr><tr><td><p>Design</p></td><td><p>1200</p></td></tr><tr><td><p>Druck</p></td><td><p>300</p></td></tr></tbody></table><p>Ende</p>";

// ------------------------------------------------------------------- scenes

const pages: Scene[] = [
  { id: "home", group: "Pages", title: "Start page", path: "#home" },
  { id: "inbox", group: "Pages", title: "Inbox", path: "#inbox" },
  { id: "tasks", group: "Pages", title: "My tasks", path: "#tasks" },
  { id: "graph", group: "Pages", title: "Graph", path: "#graph" },
  { id: "trash", group: "Pages", title: "Trash", path: "#trash" },
  { id: "media", group: "Pages", title: "Media library", path: "#media" },
  { id: "tags", group: "Pages", title: "Tags", path: "#tags" },
  { id: "settings-home", group: "Pages", title: "Settings landing page", path: "#settings" },
  { id: "admin-home", group: "Pages", title: "Administration landing page", path: "#admin" },
  { id: "document", group: "Pages", title: "Document", path: docPath },
  {
    id: "document-reading",
    group: "Pages",
    title: "Document in reading mode",
    path: docPath,
    steps: async (page, ctx) => {
      if (ctx.phone) await pageAction(page, "Lesemodus");
      else {
        await button(page, "Lesemodus").click();
        await button(page, "Bearbeiten").first().waitFor();
      }
    },
  },
  { id: "database-table", group: "Pages", title: "Database (table)", path: dbPath },
  { id: "whiteboard", group: "Pages", title: "Whiteboard", path: (c) => `#page=${c.ids.whiteboardId}` },
  { id: "journal", group: "Pages", title: "Journal", path: (c) => `#page=${c.ids.journalId}` },
  { id: "notebook", group: "Pages", title: "Notebook", path: (c) => `#page=${c.ids.notebookId}` },
  { id: "dashboard", group: "Pages", title: "Dashboard", path: (c) => `#page=${c.ids.dashboardId}` },
  { id: "workflow", group: "Pages", title: "Workflow", path: (c) => `#page=${c.ids.workflowId}` },
  {
    id: "record-full-page",
    group: "Pages",
    title: "Record as a full page",
    path: (c) => `#page=${c.ids.databaseId}&row=${c.ids.rowId}&full=1`,
  },
  { id: "welcome-page", group: "Pages", title: "Example page (Willkommen)", steps: async (page, ctx) => {
    await ctx.open("#home");
    if (ctx.phone) await openDrawer(page);
    await page.getByRole("tree").getByRole("button", { name: "Willkommen bei Flowplan", exact: true }).click();
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
      ["footnote", "fußnote", "Footnote", "Fußnote einfügen", ""],
      ["synced-block", "synchronisierten", "Synced block", "Synchronisierten Block einfügen", ""],
      ["voice-note", "sprachnotiz", "Voice note", "Sprachnotiz", "components/voice-recorder.tsx"],
      ["embed", "einbetten", "Embed", "Inhalt einbetten", ""],
      ["drawio", "draw.io", "draw.io diagram", "draw.io-Diagramm", "components/drawio-editor.tsx"],
      ["mermaid", "mermaid", "Mermaid diagram", "", "components/mermaid-editor.tsx"],
      ["math", "formel", "Equation", "", "components/math-editor.tsx"],
      ["citation", "zitieren", "Citation", "", "components/citation-dialog.tsx"],
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
      await editorWith(page, ctx, '<p>Beispiel</p><pre><code class="language-ts">const answer = 42;\nconsole.log(answer);</code></pre><p>Ende</p>');
      await editor(page).locator("pre").hover();
      await page.getByRole("button", { name: /Codeblock-Optionen/ }).first().click();
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
        '<div data-callout="info"><p>Hinweis: Die Abgabe ist am Freitag.</p></div><div data-callout="warning"><p>Achtung: Nicht vergessen.</p></div><p>Ende</p>',
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
      await page.getByRole("searchbox", { name: "Aktionen und Blocktypen suchen" }).waitFor();
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
      await page.getByRole("menuitem", { name: /^Umwandeln in/ }).first().hover();
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
      await page.getByRole("menuitem", { name: "Farbe", exact: true }).hover();
      await page.getByRole("menu", { name: "Farbe" }).waitFor();
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
      await selectText(page, "Wir bringen die neue Version im Herbst heraus.");
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
      await waitDialog(page, "Seite, Eintrag oder Person erwähnen");
    },
  },
  {
    id: "link-insert",
    group: "Documents & editor",
    title: "Insert a link",
    devices: ["desktop"],
    steps: async (page, ctx) => {
      await editorWith(page, ctx, RICH_HTML);
      await selectText(page, "Wir bringen die neue Version im Herbst heraus.");
      await page.getByRole("toolbar", { name: "Textformatierung" }).getByRole("button", { name: "Link", exact: true }).click();
      await waitDialog(page, "Link einfügen");
    },
  },
  {
    id: "link-preview",
    group: "Documents & editor",
    title: "Page link preview (hover)",
    devices: ["desktop"],
    covers: ["components/link-preview.tsx"],
    steps: async (page, ctx) => {
      await editorWith(page, ctx, `<p>Alles Weitere steht im <a href="/#page=${ctx.ids.documentId}">Projektbriefing</a>.</p><p>Ende</p>`);
      await editor(page).getByText("Projektbriefing").hover();
      await page.locator(".link-preview").waitFor();
    },
  },
  {
    id: "page-icon-picker",
    group: "Documents & editor",
    title: "Page icon picker (emoji)",
    steps: async (page, ctx) => {
      await editorWith(page, ctx, RICH_HTML);
      await pageAction(page, "Icon ändern");
      await waitDialog(page, "Seiten-Icon");
    },
  },
  {
    id: "cover-picker",
    group: "Documents & editor",
    title: "Cover picker",
    covers: ["components/cover-picker.tsx"],
    steps: async (page, ctx) => {
      await editorWith(page, ctx, RICH_HTML);
      await pageAction(page, "Cover ändern");
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
      await button(page, "Zeile 2").click();
      await page.getByRole("menu", { name: "Zeile" }).waitFor();
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
      await button(page, "Spalte 1").click();
      await page.getByRole("menu", { name: "Spalte" }).waitFor();
    },
  },
  {
    id: "comments-panel",
    group: "Documents & editor",
    title: "Comments panel",
    path: docPath,
    steps: async (page, ctx) => {
      if (ctx.phone) await pageAction(page, "Kommentare");
      else await button(page, "Kommentare").click();
    },
  },
  {
    id: "markdown-edit",
    group: "Documents & editor",
    title: "Edit as Markdown",
    steps: async (page, ctx) => {
      await editorWith(page, ctx, RICH_HTML);
      await pageAction(page, "Als Markdown bearbeiten");
      await page.getByRole("region", { name: "Markdown-Quelltext" }).waitFor();
    },
  },
  {
    id: "page-review",
    group: "Documents & editor",
    title: "Owner and review",
    covers: ["components/page-review.tsx"],
    steps: async (page, ctx) => {
      await editorWith(page, ctx, RICH_HTML);
      await pageAction(page, "Besitzer und Prüfung …");
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
      await pageAction(page, "Aliasse …");
      await page.getByRole("dialog").last().waitFor();
    },
  },
  {
    id: "version-history",
    group: "Documents & editor",
    title: "Version history",
    path: docPath,
    steps: async (page) => {
      await pageAction(page, "Versionsverlauf");
      await waitDialog(page, "Versionsverlauf");
    },
  },
  {
    id: "page-menu",
    group: "Documents & editor",
    title: "Page actions menu (⋯)",
    path: docPath,
    steps: async (page) => {
      await button(page, "Seitenaktionen").click();
      await menu(page).waitFor();
    },
  },
  {
    id: "properties",
    group: "Documents & editor",
    title: "Page tags and properties",
    covers: ["components/page-properties.tsx"],
    steps: async (page, ctx) => {
      await editorWith(page, ctx, RICH_HTML);
      await button(page, "Eigenschaft").first().click();
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
      await page.getByLabel("Suchen oder Befehl").fill("Fokusmodus");
      await page.getByLabel("Suchen oder Befehl").press("Enter");
      await page.getByRole("status", { name: "Fokusmodus" }).waitFor();
    },
  },
];

const databaseScenes: Scene[] = [
  ...(
    [
      ["board", "Board"],
      ["calendar", "Kalender"],
      ["timeline", "Zeitleiste"],
      ["gallery", "Galerie"],
      ["list", "Liste"],
      ["chart", "Diagramm"],
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
  {
    id: "database-view-settings",
    group: "Databases",
    title: "View settings",
    covers: ["components/database-view.tsx"],
    path: dbPath,
    steps: async (page) => {
      await page.getByTitle("Ansicht und Eigenschaften", { exact: true }).click();
      await waitDialog(page, "Ansicht konfigurieren");
    },
  },
  {
    id: "database-filter",
    group: "Databases",
    title: "Filter menu",
    path: dbPath,
    steps: async (page) => {
      await page.getByRole("button", { name: /^Filtern/ }).first().click();
    },
  },
  {
    id: "database-filter-advanced",
    group: "Databases",
    title: "Advanced filter",
    path: dbPath,
    steps: async (page) => {
      await page.getByRole("button", { name: /^Filtern/ }).first().click();
      await button(page, "Erweitert …").first().click();
      await waitDialog(page, "Filter bearbeiten");
    },
  },
  {
    id: "database-sort",
    group: "Databases",
    title: "Sort menu",
    path: dbPath,
    steps: async (page) => {
      await page.getByRole("button", { name: /^Sortieren/ }).first().click();
    },
  },
  {
    id: "database-group",
    group: "Databases",
    title: "Group menu",
    path: dbPath,
    steps: async (page) => {
      await page.getByRole("button", { name: /^Gruppieren/ }).first().click();
    },
  },
  {
    id: "database-properties-menu",
    group: "Databases",
    title: "Visible properties menu",
    path: dbPath,
    steps: async (page) => {
      await page.getByRole("button", { name: /^Eigenschaften/ }).first().click();
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
      await waitDialog(page, "Eigenschaft bearbeiten");
    },
  },
  {
    id: "database-add-view",
    group: "Databases",
    title: "Add a view",
    path: dbPath,
    steps: async (page) => {
      await button(page, "Ansicht hinzufügen").click();
    },
  },
  {
    id: "database-tools",
    group: "Databases",
    title: "More tools menu",
    path: dbPath,
    covers: ["components/database-tools.tsx"],
    steps: async (page) => {
      await button(page, "Weitere Werkzeuge").first().click();
    },
  },
  {
    id: "database-export",
    group: "Databases",
    title: "Export menu",
    path: dbPath,
    steps: async (page) => {
      await button(page, "Exportieren").first().click();
    },
  },
  {
    id: "database-calendar-sync",
    group: "Databases",
    title: "Calendar sync",
    path: dbPath,
    covers: ["components/calendar-sync-dialog.tsx"],
    steps: async (page) => {
      await button(page, "Kalender-Sync").click();
      await page.getByRole("dialog").last().waitFor();
    },
  },
  {
    id: "record-dialog",
    group: "Databases",
    title: "Record dialog",
    path: recordPath,
    steps: async (page) => {
      await waitDialog(page, "Eintrag");
    },
  },
  {
    id: "record-share",
    group: "Databases",
    title: "Share a record",
    path: recordPath,
    covers: ["components/record-share-dialog.tsx"],
    steps: async (page) => {
      const record = dialog(page, "Eintrag");
      await record.getByRole("button", { name: "Teilen" }).first().click();
      await waitDialog(page, "Eintrag teilen");
    },
  },
  {
    id: "record-select-cell",
    group: "Databases",
    title: "Select cell editor",
    path: dbPath,
    devices: ["desktop"],
    steps: async (page) => {
      await page.locator(".data-table tbody tr").first().getByRole("gridcell", { name: "In Arbeit" }).click();
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
      await page.locator(".data-table tbody tr").first().getByRole("gridcell", { name: "12. Okt. 2026" }).click();
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
      await button(page, "Moderation").click();
      await waitDialog(page, "Moderation");
    },
  },
  {
    id: "whiteboard-view",
    group: "Whiteboard",
    title: "View and actions",
    path: (c) => `#page=${c.ids.whiteboardId}`,
    steps: async (page) => {
      await button(page, "Ansicht und Aktionen").click();
      await waitDialog(page, "Ansicht und Aktionen");
    },
  },
  {
    id: "whiteboard-templates",
    group: "Whiteboard",
    title: "Board templates",
    path: (c) => `#page=${c.ids.whiteboardId}`,
    covers: ["components/whiteboard/template-gallery.tsx"],
    steps: async (page) => {
      await boardInsert(page, "Vorlagen");
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
      await boardInsert(page, "Formenbibliothek");
      await waitDialog(page, "Formenbibliothek");
    },
  },
  ...(
    [
      ["media", "Bilder und Symbole suchen", "Images and symbols", "components/whiteboard/media-search.tsx"],
      ["embed", "Einbetten", "Embed", "components/whiteboard/embed-dialog.tsx"],
      ["mermaid", "Mermaid/PlantUML importieren …", "Import Mermaid/PlantUML", "components/whiteboard/diagram-panels.tsx"],
      ["racks", "Racks", "Racks and devices", "components/whiteboard/rack-panels.tsx"],
      ["emoji", "Emoji", "Emoji", ""],
      ["stamp", "Stempel", "Stamps", ""],
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
      await button(page, "Zeichnen").click();
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
      await page.getByRole("button", { name: /^Heute/ }).first().click();
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
      await page.getByRole("button", { name: /^Heute/ }).first().click();
      await editor(page).waitFor();
      await page.getByRole("button", { name: /^Tag wählen/ }).click();
      await waitDialog(page, "Tag im Journal wählen");
    },
  },
  {
    id: "journal-settings",
    group: "Journal",
    title: "Journal settings",
    path: (c) => `#page=${c.ids.journalId}`,
    covers: ["components/journal-parts.tsx"],
    steps: async (page) => {
      await button(page, "Journal einrichten").click();
      await waitDialog(page, "Journal einrichten");
    },
  },
  {
    id: "journal-review",
    group: "Journal",
    title: "Review (Rückblick)",
    path: (c) => `#page=${c.ids.journalId}`,
    steps: async (page) => {
      await button(page, "Rückblick").click();
      await waitDialog(page, "Rückblick");
    },
  },
  {
    id: "journal-calendar",
    group: "Journal",
    title: "Journal as a calendar",
    path: (c) => `#page=${c.ids.journalId}`,
    steps: async (page) => {
      await page.getByRole("group", { name: "Darstellung" }).getByRole("button", { name: "Kalender" }).click();
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
      await page.getByLabel("Suchen oder Befehl").fill("Pro");
      await dialog(page, "Schnellsuche").getByText("Projektbriefing").first().waitFor();
    },
  },
  {
    id: "command-palette",
    group: "Dialogs",
    title: "Command palette (>)",
    path: "#home",
    steps: async (page) => {
      await page.keyboard.press("ControlOrMeta+k");
      await page.getByLabel("Suchen oder Befehl").fill(">");
    },
  },
  {
    id: "new-page",
    group: "Dialogs",
    title: "New page",
    path: "#new",
    covers: ["components/new-page-dialog.tsx"],
    steps: async (page) => {
      await waitDialog(page, "Neue Seite");
    },
  },
  {
    id: "new-workspace",
    group: "Dialogs",
    title: "New workspace",
    path: "#home",
    devices: ["desktop"],
    steps: async (page) => {
      await page.getByRole("button", { name: /Mein Arbeitsbereich/ }).first().click();
      await menu(page).getByRole("menuitem", { name: "Arbeitsbereich erstellen" }).click();
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
      await page.getByRole("button", { name: /Mein Arbeitsbereich/ }).first().click();
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
      await waitDialog(page, "Seite teilen");
    },
  },
  {
    id: "move-page",
    group: "Dialogs",
    title: "Move page",
    path: docPath,
    covers: ["components/move-page-dialog.tsx"],
    steps: async (page) => {
      await pageAction(page, "Verschieben");
      await waitDialog(page, "Seite verschieben");
    },
  },
  {
    id: "page-to-records",
    group: "Dialogs",
    title: "Move into a database",
    path: docPath,
    covers: ["components/page-to-record.tsx"],
    steps: async (page) => {
      await pageAction(page, "In Datenbank verschieben …");
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
      await pageAction(page, "Exportieren");
      await waitDialog(page, "Seite exportieren");
    },
  },
  {
    id: "print",
    group: "Dialogs",
    title: "Print / PDF",
    path: docPath,
    covers: ["components/print-dialog.tsx"],
    steps: async (page) => {
      await pageAction(page, "Drucken / PDF");
      await waitDialog(page, "Drucken / PDF");
    },
  },
  {
    id: "save-as-template",
    group: "Dialogs",
    title: "Save as template",
    path: docPath,
    steps: async (page) => {
      await pageAction(page, "Als Vorlage speichern");
      await page.getByRole("dialog").last().waitFor();
    },
  },
  {
    id: "templates",
    group: "Dialogs",
    title: "Templates",
    path: "#home",
    steps: async (page, ctx) => {
      await sidebarTool(page, ctx, "Vorlagen");
      await waitDialog(page, "Vorlagen");
    },
  },
  {
    id: "keyboard-shortcuts",
    group: "Dialogs",
    title: "Keyboard shortcuts",
    path: "#home",
    covers: ["components/keyboard-shortcuts.tsx"],
    steps: async (page, ctx) => {
      await sidebarTool(page, ctx, "Tastenkürzel");
      await waitDialog(page, "Tastenkürzel");
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
      await page.getByRole(ctx.phone ? "button" : "menuitem", { name: "Was ist neu" }).first().click();
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
      await button(page, "Einführung starten").click();
      await waitDialog(page, "Willkommen bei Flowplan");
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
      await button(page, "Bereich Teamspace verwalten").click();
      await page.getByRole("menuitem", { name: "Bereich bearbeiten …" }).click();
      await waitDialog(page, "Bereich verwalten");
    },
  },
  {
    id: "add-space",
    group: "Dialogs",
    title: "Add a space",
    path: "#home",
    steps: async (page, ctx) => {
      if (ctx.phone) await openDrawer(page);
      await button(page, "Bereich hinzufügen").click();
      await waitDialog(page, "Bereich hinzufügen");
    },
  },
  {
    id: "capture",
    group: "Dialogs",
    title: "Quick capture",
    path: "#capture",
    covers: ["components/quick-capture.tsx"],
    steps: async (page) => {
      await waitDialog(page, "Erfassen");
    },
  },
  {
    id: "trash-toast",
    group: "Dialogs",
    title: "Toast: moved to the trash, with undo",
    steps: async (page, ctx) => {
      await editorWith(page, ctx, RICH_HTML, "Wegwerfen");
      await pageAction(page, "In den Papierkorb");
      await page.getByRole("status").filter({ hasText: "in den Papierkorb gelegt" }).waitFor();
    },
  },
  {
    id: "home-add-widget",
    group: "Dialogs",
    title: "Start page: add a widget",
    path: "#home",
    steps: async (page) => {
      await button(page, "Anpassen").click();
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
      await button(page, "Teamspace als Markdown exportieren").click();
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
      await button(page, "Seiten auswählen").click();
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
      await button(page, "Neue Sammlung").click();
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
      await page.getByRole("button", { name: /Mitglied einladen|Einladen/ }).first().click();
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
      await page.getByRole("button", { name: /Verschlüsselung einrichten/ }).first().click();
      await waitDialog(page, "Verschlüsselung einrichten");
    },
  },
  {
    id: "workspace-icon",
    group: "Dialogs",
    title: "Workspace icon",
    path: "#settings/workspace",
    covers: ["components/workspace-icon.tsx"],
    steps: async (page) => {
      await page.getByRole("button", { name: /Symbol/ }).first().click();
      await page.getByRole("dialog").last().waitFor();
    },
  },
  {
    id: "empty-trash",
    group: "Dialogs",
    title: "Confirm: empty the trash",
    covers: ["components/trash-view.tsx"],
    steps: async (page, ctx) => {
      await ctx.command({ action: "page.delete", pageId: await ctx.fixture({ title: "Alter Entwurf" }) });
      await ctx.open("#trash");
      await button(page, "Papierkorb leeren").click();
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
      await page.getByRole("checkbox", { name: "Onboarding vereinfachen auswählen" }).check();
      await page.getByRole("checkbox", { name: "Mobile Navigation auswählen" }).check();
      await page.getByRole("button", { name: /Verschieben/ }).first().click();
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
      await button(page, "Bereich Teamspace verwalten").click();
      await page.getByRole("menu", { name: "Bereich Teamspace verwalten" }).waitFor();
    },
  },
  {
    id: "home-customize",
    group: "Dialogs",
    title: "Customise the start page",
    path: "#home",
    covers: ["components/home/home-editor.tsx"],
    steps: async (page) => {
      await button(page, "Anpassen").click();
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
      await button(page, "Probelauf").click();
      await waitDialog(page, "Probelauf");
    },
  },
  {
    id: "workflow-activate",
    group: "Dialogs",
    title: "Workflow: activate",
    devices: ["desktop"],
    path: (c) => `#page=${c.ids.workflowId}`,
    steps: async (page) => {
      await button(page, "Aktivieren").click();
      await waitDialog(page, "Workflow aktivieren");
    },
  },
  {
    id: "workflow-add-node",
    group: "Dialogs",
    title: "Workflow: add a node",
    devices: ["desktop"],
    path: (c) => `#page=${c.ids.workflowId}`,
    steps: async (page) => {
      await button(page, "Knoten dazwischen einfügen").first().click();
      await waitDialog(page, "Knoten dazwischen einfügen");
    },
  },
  {
    id: "dashboard-add-tile",
    group: "Dialogs",
    title: "Dashboard: add a tile",
    path: (c) => `#page=${c.ids.dashboardId}`,
    covers: ["components/dashboard-view.tsx"],
    steps: async (page) => {
      await button(page, "Erste Kachel hinzufügen").click();
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
      await button(page, "Papier ändern").click();
      await waitDialog(page, "Papier");
    },
  },
  {
    id: "notebook-pen",
    group: "Dialogs",
    title: "Notebook: pen settings",
    path: (c) => `#page=${c.ids.notebookId}`,
    covers: ["components/ink/ink-panel.tsx"],
    steps: async (page) => {
      await button(page, "Stifteinstellungen").click();
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
      await button(page, "Bild oder Sticker einfügen").click();
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
      await button(page, "Konto löschen …").or(button(page, "Konto löschen")).first().click();
      await waitDialog(page, "Dein Konto löschen?");
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
    await page.getByRole("heading", { name: s.title.de, level: 1 }).first().waitFor();
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
      const link = button(page, "Mit E-Mail und Passwort");
      if (await link.isVisible()) await link.click();
      await page.locator("input[name=email]").waitFor();
    },
  },
  { id: "register", group: "Auth", title: "Register", path: "/register", signedOut: true },
  { id: "reset", group: "Auth", title: "Reset password", path: "/reset", signedOut: true },
];

const publicScenes: Scene[] = [
  { id: "public-document", group: "Public", title: "Published document", path: (c) => `/share/${c.ids.publicDocToken}`, signedOut: true },
  { id: "public-database", group: "Public", title: "Published database", path: (c) => `/share/${c.ids.publicDbToken}`, signedOut: true },
  { id: "share-link", group: "Public", title: "Share link (editor)", path: (c) => `/share/${c.ids.shareLinkToken}`, signedOut: true },
  { id: "public-templates", group: "Public", title: "Template gallery", path: "/templates", signedOut: true },
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
    title: "\"Mehr\" sheet",
    path: "#home",
    devices: ["phone"],
    covers: ["components/sidebar-tools.tsx"],
    steps: async (page) => {
      await openDrawer(page);
      await page.locator("aside.sidebar .sidebar-more").click();
      await waitDialog(page, "Mehr");
    },
  },
  {
    id: "phone-new-page",
    group: "Mobile-only",
    title: "New page sheet (tab bar)",
    path: "#home",
    devices: ["phone"],
    steps: async (page) => {
      await page.locator(".mobile-tab-bar").getByRole("button", { name: "Neue Seite" }).click();
      await waitDialog(page, "Neue Seite");
    },
  },
  {
    id: "phone-page-menu",
    group: "Mobile-only",
    title: "Page menu sheet",
    path: docPath,
    devices: ["phone"],
    steps: async (page) => {
      await button(page, "Seitenaktionen").click();
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
      await waitDialog(page, "Eintrag");
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
