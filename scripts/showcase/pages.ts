// Documents, the journal, the notebook, the dashboard, templates, the start
// page layout and the "Start here" guide of the showcase.
import { id, one, run } from "../../lib/db";
import { database } from "../../lib/api";
import { withCommentDocument } from "../../lib/inline-comments";
import { commentAnchor } from "../../lib/comment-positions";
import { writeSurface } from "../../lib/page-ink-store";
import { saveFileInk } from "../../lib/ink-store";
import { emptyInk, type InkItem } from "../../lib/ink/model";
import { dayTitle } from "../../lib/journal";
import { indexPageTasks } from "../../lib/doc-tasks";
import { notebookSheets } from "../../lib/notebook";
import { htmlState } from "../../lib/document-server";
import { Ctx, view } from "./context";
import { handwriting, loop, penPath } from "./handwriting";
import { briefPdf, cover, illustration, palette, pdfPageSizes, screen, storyboardPdf, type PdfLine } from "./assets";
import * as H from "./html";

const { h, p, ul, ol, callout, toggle, columns, table, code, mermaid, math, mathInline, link, tasks } = H;

// ---- Inline comment threads --------------------------------------------------
function thread(c: Ctx, pageId: string, quote: string, messages: { by: number; text: string }[], resolved = false) {
  const anchor = withCommentDocument(pageId, null, (binding, generation) => {
    let from = -1;
    binding.content.descendants((node, pos) => {
      if (from >= 0 || !node.isText) return;
      const at = node.text!.indexOf(quote);
      if (at >= 0) from = pos + at;
    });
    if (from < 0) throw new Error(`quote not found: ${quote}`);
    return commentAnchor(binding, from, from + quote.length, generation);
  });
  const threadId = id();
  const first = messages[0];
  c.act({ action: "thread.create", pageId, threadId, messageId: id(), anchor, body: first.text }, c.team[first.by]?.identity ?? c.me);
  for (const m of messages.slice(1)) c.act({ action: "thread.reply", pageId, threadId, messageId: id(), body: m.text }, m.by < 0 ? c.me : c.team[m.by].identity);
  if (resolved) {
    const version = one<{ version: number }>("SELECT version FROM inline_threads WHERE id=?", threadId)!.version;
    c.act({ action: "thread.resolve", pageId, threadId, resolved: true, version });
  }
}

// A version of a document in the past (version history).
function version(c: Ctx, pageId: string, html: string, title: string, daysAgo: number, by = c.me.id) {
  run(
    "INSERT INTO snapshots(id,page_id,state,html,title,created_by,created_at,kind) VALUES(?,?,?,?,?,?,?,'manual')",
    id(),
    pageId,
    htmlState(html),
    html,
    title,
    by,
    c.sqlTime(-daysAgo, 11),
  );
}

export async function handbook(c: Ctx, refs: { projects: string; tickets: string; journey: string }) {
  const { t } = c;
  const hb = c.page("handbook", "studio", t("Team-Handbuch", "Team handbook"), "document", null, "📘");
  const hbCover = c.file(hb, "handbuch-cover.jpg", "image/jpeg", await cover([palette.night, palette.sky, palette.plum, palette.clay], 21));
  c.appearance(hb, { cover: c.url(hbCover), cover_position: 40 });
  const how = c.page("how", "studio", t("So arbeiten wir", "How we work"), "document", hb, "🧭");
  const editor = c.page("editor", "studio", t("Editor-Showcase: alle Blöcke", "Editor showcase: every block"), "document", hb, "✍️");
  const brand = c.page("brand", "studio", t("Markenrichtlinien (PDF mit Anmerkungen)", "Brand guidelines (annotated PDF)"), "document", hb, "🎨");
  const meetings = c.page("meetings", "studio", t("Meeting-Notizen", "Meeting notes"), "document", hb, "🗒️");
  const syncedPage = c.page("synced", "studio", t("Synchronisierter Block", "Synced block"), "document", editor);
  run("UPDATE pages SET synced=1 WHERE id=?", syncedPage);
  c.setHtml(
    syncedPage,
    callout("important", `<strong>${t("Synchronisiert:", "Synced:")}</strong> ${t("Dieser Hinweis steht im Editor-Showcase und auf „Start hier“. Ändere ihn an einer Stelle – er ändert sich überall.", "This note sits in the editor showcase and on “Start here”. Change it in one place – it changes everywhere.")}`),
  );

  // ---- Handbook -------------------------------------------------------------
  c.setHtml(
    hb,
    p(t("Alles, was neue Teammitglieder in der ersten Woche brauchen. Öffne das Inhaltsverzeichnis rechts oben (☰), um zwischen Abschnitten zu springen.", "Everything new team members need in their first week. Open the table of contents at the top right (☰) to jump between sections.")) +
      h(2, t("Inhalt", "Contents")) +
      ul(
        `${link(how, t("So arbeiten wir", "How we work"))} – ${t("Rituale, Entscheidungen, Werkzeuge (mit Versionsverlauf)", "rituals, decisions, tools (with version history)")}`,
        `${link(editor, t("Editor-Showcase", "Editor showcase"))} – ${t("jeder Block, den der Editor kann", "every block the editor offers")}`,
        `${link(brand, t("Markenrichtlinien", "Brand guidelines"))} – ${t("PDF mit Handschrift-Anmerkungen", "PDF with handwritten annotations")}`,
        `${link(meetings, t("Meeting-Notizen", "Meeting notes"))} – ${t("aus der Vorlage „Meeting-Protokoll“", "from the “Meeting minutes” template")}`,
      ) +
      h(2, t("Unsere Werte", "Our values")) +
      columns(
        h(3, "🧡 " + t("Klarheit", "Clarity")) + p(t("Wir schreiben auf, was wir entscheiden – kurz und verständlich.", "We write down what we decide – short and clear.")),
        h(3, "🤝 " + t("Nähe", "Closeness")) + p(t("Kund:innen sitzen mit am Tisch, nicht am anderen Ende einer E-Mail.", "Clients sit at the table, not at the other end of an email.")),
        h(3, "🌱 " + t("Wachstum", "Growth")) + p(t("Jede Retro endet mit genau einer Maßnahme.", "Every retro ends with exactly one action.")),
      ) +
      h(2, t("Erste Woche", "First week")) +
      tasks(
        { text: t("Laptop einrichten und Flowplan-App installieren", "Set up the laptop and install the Flowplan app"), done: true },
        { text: t("Handbuch lesen", "Read the handbook"), due: c.day(1), who: { id: c.me.id, name: t("Du", "You") } },
        { text: t("Ersten Journal-Eintrag schreiben", "Write a first journal entry"), due: c.day(2), who: { id: c.me.id, name: t("Du", "You") } },
        { text: t("Kaffee mit jedem Teammitglied", "Coffee with every team member"), children: [{ text: "Mara", done: true }, { text: "Jonas" }, { text: "Aylin" }, { text: "Lukas" }] },
      ),
  );
  run("UPDATE pages SET review_at=?,review_every_days=? WHERE id=?", c.day(30), 90, hb);
  c.act({ action: "page.aliases", pageId: hb, aliases: [t("Onboarding", "Onboarding"), "Wiki"] });

  // ---- How we work, with versions and comments -----------------------------
  const howV1 = h(2, t("Rituale", "Rituals")) + ul(t("Montag: Planung", "Monday: planning"), t("Freitag: Demo", "Friday: demo"));
  const howV2 = howV1 + h(2, t("Entscheidungen", "Decisions")) + p(t("Wer entscheidet, schreibt es ins Projekt.", "Whoever decides writes it into the project."));
  const howNow =
    callout("note", t("Diese Seite hat einen Versionsverlauf (⋯ → Versionen): drei ältere Stände lassen sich vergleichen und wiederherstellen.", "This page has a version history (⋯ → Versions): three older states can be compared and restored.")) +
    h(2, t("Rituale", "Rituals")) +
    table([
      [t("Wann", "When"), t("Was", "What"), t("Dauer", "Length")],
      [t("Montag 9:30", "Monday 9:30"), t("Wochenplanung im Board", "Weekly planning on the board"), "30 min"],
      [t("Täglich 9:45", "Daily 9:45"), t("Daily (stehend)", "Daily stand-up"), "10 min"],
      [t("Freitag 15:00", "Friday 3 pm"), t("Demo & Retro (alle zwei Wochen)", "Demo & retro (every other week)"), "60 min"],
    ]) +
    h(2, t("Entscheidungen", "Decisions")) +
    p(
      t(`Wer entscheidet, schreibt es in das Projekt (${link(refs.projects, "Projekte")}). Tickets verweisen per Kürzel wie ATL-4 auf die Umsetzung – die Kürzel werden im Text automatisch erkannt.`, `Whoever decides writes it into the project (${link(refs.projects, "Projects")}). Tickets refer to the work by keys like ATL-4 – keys are recognised in text automatically.`),
    ) +
    h(2, t("Werkzeuge", "Tools")) +
    ul(t("Flowplan für alles Geschriebene, Geplante und Gezeichnete", "Flowplan for everything written, planned and drawn"), t("Figma für Pixel", "Figma for pixels"), t("Git für Code – Commits mit „ATL-12“ verknüpfen sich mit Tickets", "Git for code – commits mentioning “ATL-12” link to tickets")) +
    h(2, t("Meetings ohne Meeting", "Meetings without meetings")) +
    p(t("Asynchrone Updates schreiben wir ins Journal oder als Kommentar direkt am Text. Markiere einen Satz und wähle „Kommentieren“.", "We write asynchronous updates into the journal or as a comment right on the text. Select a sentence and choose “Comment”."));
  c.setHtml(how, howNow);
  version(c, how, howV1, t("So arbeiten wir", "How we work"), 40);
  version(c, how, howV2, t("So arbeiten wir", "How we work"), 21);
  version(c, how, howV2 + h(2, t("Werkzeuge", "Tools")) + ul("Flowplan", "Figma"), t("So arbeiten wir", "How we work"), 7);
  thread(c, how, t("Demo & Retro (alle zwei Wochen)", "Demo & retro (every other week)"), [
    { by: 0, text: t("Sollen wir die Demo auf jeden Freitag legen?", "Should we hold the demo every Friday?") },
    { by: 2, text: t("Lieber alle zwei Wochen – sonst gibt es zu wenig zu zeigen.", "Rather every other week – otherwise there is too little to show.") },
  ]);
  thread(c, how, t("Figma für Pixel", "Figma for pixels"), [{ by: 1, text: t("Und Flowplan-Whiteboards für frühe Skizzen 😉", "And Flowplan whiteboards for early sketches 😉") }], true);
  c.act({ action: "comment.create", pageId: how, body: t("Ich habe die Ritual-Tabelle aktualisiert – bitte kurz drüberschauen.", "I updated the rituals table – please have a quick look.") }, c.team[2].identity);

  // ---- Editor showcase -----------------------------------------------------
  const img = c.file(editor, "moodboard.jpg", "image/jpeg", await illustration([palette.sand, palette.clay, palette.sage, palette.plum], 51));
  const shot = c.file(editor, "atlas-screen.jpg", "image/jpeg", await screen("Atlas Dashboard", palette.clay, 52));
  const sheet = c.file(
    editor,
    t("Projektsteckbrief.pdf", "Project-sheet.pdf"),
    "application/pdf",
    await briefPdf({
      title: t("Projektsteckbrief", "Project sheet"),
      subtitle: "Atlas App · Velo Urban GmbH",
      footer: t("Fiktives Beispiel für das Flowplan-Showcase", "Fictional example for the Flowplan showcase"),
      sections: [{ heading: t("Kurz gesagt", "In short"), lines: [t("Eine Leih-App, die in 30 Sekunden zum Rad führt.", "A rental app that gets you on a bike in 30 seconds.")] }],
    }),
  );
  const books: H.Csl[] = [
    { id: "krug2014", type: "book", title: "Don't Make Me Think, Revisited", author: [{ family: "Krug", given: "Steve" }], issued: { "date-parts": [[2014]] }, publisher: "New Riders" },
    { id: "norman2013", type: "book", title: "The Design of Everyday Things", author: [{ family: "Norman", given: "Don" }], issued: { "date-parts": [[2013]] }, publisher: "Basic Books" },
    { id: "singer2019", type: "book", title: "Shape Up", author: [{ family: "Singer", given: "Ryan" }], issued: { "date-parts": [[2019]] }, publisher: "Basecamp" },
  ];
  const inkId = "ink-showcase1";
  const linkedViews = [
    view("lv-board", "Board", "board", { groupBy: "status", hiddenFields: ["project", "time"] }),
    view("lv-table", t("Offen", "Open"), "table", { filters: [{ field: "status", op: "neq", value: t("Erledigt", "Done") }] }),
  ];
  const me = { id: c.me.id, name: t("Du", "You") };
  const now = Date.now();
  const editorHtml = [
    callout("tip", t("Tippe irgendwo <code>/</code> für das Blockmenü, markiere Text für Formatierungen, ziehe Blöcke am Griff links. ⌘K / Strg+K öffnet die Befehlspalette.", "Type <code>/</code> anywhere for the block menu, select text to format it, drag blocks by the handle on the left. ⌘K / Ctrl+K opens the command palette.")),
    h(1, t("Überschrift 1", "Heading 1")),
    h(2, t("Text und Formatierung", "Text and formatting")),
    p(
      t(
        `<strong>Fett</strong>, <em>kursiv</em>, <u>unterstrichen</u>, <s>durchgestrichen</s>, <code>Code</code>, ${H.mark("markiert")}, ${H.color("farbig", "#c2255c")}, E = mc<sup>2</sup>, H<sub>2</sub>O, ein ${H.spoiler("Spoiler – klick drauf")} und ein ${H.web("https://flowplan.org", "Weblink")}.`,
        `<strong>Bold</strong>, <em>italic</em>, <u>underlined</u>, <s>struck through</s>, <code>code</code>, ${H.mark("highlighted")}, ${H.color("coloured", "#c2255c")}, E = mc<sup>2</sup>, H<sub>2</sub>O, a ${H.spoiler("spoiler – click it")} and a ${H.web("https://flowplan.org", "web link")}.`,
      ),
    ),
    `<p data-indent="1">${t("Mit Tab eingerückter Absatz.", "A paragraph indented with Tab.")}</p>`,
    `<p style="text-align: center">${t("Zentrierter Text", "Centred text")}</p>`,
    p(
      `${t("Erwähnung", "Mention")}: ${H.mention(c.me.id, t("Du", "You"))} · ${t("Seitenlink", "Page link")}: ${link(refs.projects, t("Projekte", "Projects"))} · ${t("Datensatzlink", "Record link")}: ${link(refs.projects, "Atlas App", c.rows.projects["0"])} · ${t("Ticket-Kürzel", "Ticket key")}: ATL-4`,
    ),
    p(t(`Fußnoten stehen am Ende des Dokuments${H.footnote("Wie in einer Hausarbeit – nur ohne Formatierungsstress.")} und nummerieren sich selbst${H.footnote("Verschiebe diesen Satz: Die Nummern folgen.")}.`, `Footnotes are listed at the end of the document${H.footnote("Like in a term paper – minus the formatting stress.")} and number themselves${H.footnote("Move this sentence: the numbers follow.")}.`)),
    h(2, t("Hinweise in fünf Farben", "Callouts in five colours")),
    callout("note", t("Hinweis: nützliche Information.", "Note: useful information.")),
    callout("tip", t("Tipp: Mit <code>/hinweis</code> wechselst du die Art.", "Tip: <code>/note</code> switches the kind.")),
    callout("important", t("Wichtig: das Wesentliche auf einen Blick.", "Important: key information at a glance.")),
    callout("warning", t("Warnung: braucht Aufmerksamkeit.", "Warning: needs attention.")),
    callout("caution", t("Achtung: Risiko oder unerwünschte Folge.", "Caution: risk or negative outcome.")),
    H.quote(t("Gute Gestaltung ist so wenig Gestaltung wie möglich. – Dieter Rams", "Good design is as little design as possible. – Dieter Rams")),
    toggle(t("Aufklappbar: Wie funktioniert das?", "Toggle: how does it work?"), p(t("Inhalt bleibt verborgen, bis man ihn öffnet. Auch Listen, Bilder und Code passen hinein.", "Content stays hidden until opened. Lists, images and code fit in too.")) + ul("A", "B")),
    h(2, t("Listen und Aufgaben", "Lists and tasks")),
    columns(
      h(3, t("Aufzählung", "Bullets")) + `<ul><li><p>${t("Punkt", "Item")}</p><ul><li><p>${t("verschachtelt", "nested")}</p></li></ul></li><li><p>${t("zweiter Punkt", "second item")}</p></li></ul>`,
      h(3, t("Nummeriert", "Numbered")) + ol(t("Erstens", "First"), t("Zweitens", "Second"), t("Drittens", "Third")),
    ),
    tasks(
      { text: t("Erledigte Aufgabe", "Completed task"), done: true },
      { text: t("Aufgabe mit Fälligkeit, dir zugewiesen – erscheint unter „Meine Aufgaben“", "Task with a due date, assigned to you – shows up in “My tasks”"), due: c.day(1), who: me },
      { text: t("Überfällige Aufgabe", "Overdue task"), due: c.day(-2), who: me },
      { text: t("Aufgabe mit Unteraufgaben", "Task with subtasks"), children: [{ text: t("Unteraufgabe 1", "Subtask 1"), done: true }, { text: t("Unteraufgabe 2", "Subtask 2") }] },
    ),
    H.reactions(t("Auf Absätze lässt sich reagieren – Cursor in einen Absatz setzen und rechts auf das Smiley tippen.", "You can react to paragraphs – put the cursor into one and tap the smiley on the right."), { "👍": [c.me.id, c.team[0].id], "🎉": [c.team[1].id] }),
    h(2, t("Tabelle und Spalten", "Table and columns")),
    table([
      [t("Phase", "Phase"), t("Verantwortlich", "Owner"), "Status"],
      ["Discovery", "Aylin", "✅"],
      ["Design", "Mara", "🔄"],
      [t("Entwicklung", "Engineering"), "Jonas", "⏳"],
    ]),
    columns(p(H.image(img, "Moodboard")), p(H.image(shot, "Atlas"))),
    h(2, t("Code mit Hervorhebung", "Code with highlighting")),
    code("typescript", `// ${t("Ausleihe in 30 Sekunden", "Rent in 30 seconds")}\nexport async function rent(bikeId: string, user: User) {\n  const hold = await payments.preauthorize(user, 50_00);\n  await locks.open(bikeId);\n  return { bikeId, hold, startedAt: new Date() };\n}`),
    code("python", `# ${t("NPS aus den Umfrageantworten", "NPS from the survey responses")}\npromoters = sum(1 for s in scores if s >= 9)\ndetractors = sum(1 for s in scores if s <= 6)\nnps = round((promoters - detractors) / len(scores) * 100)`),
    code("sql", "SELECT status, count(*) AS tickets\nFROM tickets\nWHERE sprint = 'Sprint 14'\nGROUP BY status;"),
    h(2, t("Diagramme, Formeln, Graphen", "Diagrams, formulas, graphs")),
    mermaid(t("flowchart LR\n  A[Idee] --> B{Passt es?}\n  B -- ja --> C[Prototyp]\n  B -- nein --> A\n  C --> D[Test] --> E((Launch))", "flowchart LR\n  A[Idea] --> B{Does it fit?}\n  B -- yes --> C[Prototype]\n  B -- no --> A\n  C --> D[Test] --> E((Launch))")),
    mermaid(t("sequenceDiagram\n  Nutzer->>App: QR scannen\n  App->>Server: Rad reservieren\n  Server-->>App: Schloss offen\n  App-->>Nutzer: Gute Fahrt!", "sequenceDiagram\n  User->>App: Scan QR\n  App->>Server: Reserve bike\n  Server-->>App: Lock open\n  App-->>User: Enjoy the ride!")),
    p(`${t("Formel im Text", "Inline formula")}: ${mathInline("NPS = \\%_{9\\text{–}10} - \\%_{0\\text{–}6}")} ${t("und als Block:", "and as a block:")}`),
    math("\\text{Marge} = \\frac{\\text{Budget} - \\text{Kosten}}{\\text{Budget}} \\cdot 100\\,\\%"),
    math("\\int_0^1 x^2\\,dx = \\tfrac{1}{3}"),
    p(t("Rechnen im Text: Tippe <code>3/4 + 1/6 =</code> und drücke Tab – Flowplan setzt das Ergebnis ein. Probier es in der nächsten Zeile.", "Calculate in text: type <code>3/4 + 1/6 =</code> and press Tab – Flowplan inserts the result. Try it on the next line.")),
    p(""),
    H.plot([{ expr: "sin(x)", color: "#3b3fd8" }, { expr: "0.1*x^2 - 1", color: "#e03131" }], { xMin: -6, xMax: 6, yMin: -2, yMax: 3 }),
    H.metric(refs.tickets, "sum", "points"),
    h(2, t("Datenbank, Whiteboard und Handschrift im Dokument", "Database, whiteboard and handwriting in the document")),
    H.linkedDatabase(refs.tickets, linkedViews),
    H.whiteboard(refs.journey, 380),
    H.drawBlock(inkId, 300, "grid"),
    h(2, t("Synchronisierter Block", "Synced block")),
    H.synced(syncedPage),
    h(2, t("Medien und Einbettungen", "Media and embeds")),
    H.pdf(sheet, t("Projektsteckbrief.pdf", "Project-sheet.pdf")),
    H.linkCard("https://flowplan.org", "Flowplan", "flowplan.org", t("Dokumente, Datenbanken, Whiteboards und ein Journal – selbst gehostet.", "Documents, databases, whiteboards and a journal – self-hosted.")),
    H.embed("https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ"),
    h(2, t("Vorschläge und Kommentare", "Suggestions and comments")),
    p(
      t(
        `Im Vorschlagsmodus (Stift oben) werden Änderungen zu Vorschlägen: Das Review ist am ${H.suggestion("delete", "Montag", { id: c.team[0].id, name: "Mara Klein" }, "sg1", now)}${H.suggestion("insert", "Dienstag", { id: c.team[0].id, name: "Mara Klein" }, "sg1", now)} um 10 Uhr.`,
        `In suggestion mode (pen at the top) changes become suggestions: the review is on ${H.suggestion("delete", "Monday", { id: c.team[0].id, name: "Mara Klein" }, "sg1", now)}${H.suggestion("insert", "Tuesday", { id: c.team[0].id, name: "Mara Klein" }, "sg1", now)} at 10 am.`,
      ),
    ),
    p(t("Markierter Text mit einer Diskussion daneben: Dieser Satz hat einen Kommentar.", "Highlighted text with a discussion next to it: this sentence has a comment.")),
    h(2, t("Quellen", "Sources")),
    p(t(`Gute Oberflächen erklären sich selbst ${H.citation(books[0], "S. 11")}, Fehler sind Designfehler ${H.citation(books[1])}, und Projekte brauchen feste Zeitrahmen ${H.citation(books[2])}.`, `Good interfaces explain themselves ${H.citation(books[0], "p. 11")}, errors are design errors ${H.citation(books[1])}, and projects need fixed time boxes ${H.citation(books[2])}.`)),
    H.bibliography(t("Literaturverzeichnis", "Bibliography")),
    "<hr>",
    p(t("Ende des Showcases. Öffne ⋯ → Exportieren für PDF, Word, Markdown oder EPUB.", "End of the showcase. Open ⋯ → Export for PDF, Word, Markdown or EPUB.")),
  ].join("");
  c.setHtml(editor, editorHtml);
  c.appearance(editor, { full_width: 0 });
  // The drawing block: a sketch with a label.
  const sketch: InkItem[] = [
    penPath([[40, 40], [260, 41], [259, 220], [41, 219], [40, 41]], { id: "frame1", color: "#1f2a44", width: 2, corners: true }),
    penPath([[60, 70], [240, 70]], { id: "bar1", color: "#1f2a44", width: 1.4 }),
    penPath([[60, 110], [180, 110]], { id: "bar2", color: "#868e96", width: 1.2 }),
    penPath([[60, 140], [200, 140]], { id: "bar3", color: "#868e96", width: 1.2 }),
    penPath([[100, 175], [200, 176], [199, 205], [101, 204], [100, 176]], { id: "btn", color: "#e0782c", width: 2, corners: true }),
    penPath([[90, 190], [215, 190]], { id: "hl", color: "#ffd43b", width: 12, type: "highlighter" }),
    ...handwriting(t("Onboarding-Screen 1", "Onboarding screen 1"), { x: 300, y: 70, size: 30, seed: 5, color: "#1f2a44" }).strokes,
    ...handwriting(t("Button größer!", "Bigger button!"), { x: 320, y: 190, size: 26, seed: 6, color: "#c92a2a" }).strokes,
    penPath([[315, 182], [275, 190], [215, 192]], { id: "arrow", color: "#c92a2a", width: 1.6 }),
    penPath([[225, 184], [213, 192], [226, 199]], { id: "arrowhead", color: "#c92a2a", width: 1.6 }),
  ];
  writeSurface(editor, inkId, { ...emptyInk(), pages: { [inkId]: sketch } }, t("Onboarding-Screen 1 Button größer!", "Onboarding screen 1 Bigger button!"), c.me.id);
  thread(c, editor, t("Dieser Satz hat einen Kommentar.", "this sentence has a comment."), [
    { by: 0, text: t("So sehen Textkommentare aus – antworte gern!", "This is what text comments look like – feel free to reply!") },
    { by: 1, text: t("Und mit 👍 reagieren geht auch.", "And you can react with 👍 too.") },
  ]);
  version(c, editor, p(t("Erster Entwurf des Showcases.", "First draft of the showcase.")), t("Editor-Showcase", "Editor showcase"), 3);

  // ---- Brand guidelines: a PDF with ink annotations --------------------------
  const lines: PdfLine[] = [];
  const guide = await briefPdf(
    {
      title: t("Markenrichtlinien", "Brand guidelines"),
      subtitle: t("Northwind Studio · Version 3 · intern", "Northwind Studio · version 3 · internal"),
      footer: t("Fiktives Beispiel für das Flowplan-Showcase", "Fictional example for the Flowplan showcase"),
      sections: [
        { heading: t("1. Farben", "1. Colours"), lines: [t("Primär: Nachtblau #14213D. Akzent: Ton #E0782C. Hintergrund: Papier #FBF8F3. Akzentfarbe sparsam einsetzen – höchstens ein Element pro Ansicht.", "Primary: night blue #14213D. Accent: clay #E0782C. Background: paper #FBF8F3. Use the accent sparingly – at most one element per view.")] },
        { heading: t("2. Typografie", "2. Typography"), lines: [t("Überschriften in Inter Bold, Fließtext in Inter Regular, 16 px, Zeilenhöhe 1,5.", "Headings in Inter Bold, body text in Inter Regular, 16 px, line height 1.5.")] },
        { heading: t("3. Tonalität", "3. Tone of voice"), lines: [t("Wir duzen, schreiben kurz und konkret, ohne Buzzwords. Ein Satz, eine Idee.", "We write casually, short and concrete, without buzzwords. One sentence, one idea.")] },
        { heading: t("4. Logo", "4. Logo"), lines: [t("Schutzraum: die Höhe des N auf allen Seiten. Nie verzerren, nie einfärben.", "Clear space: the height of the N on every side. Never distort, never recolour.")] },
        { heading: t("5. Bildsprache", "5. Imagery"), lines: [t("Echte Menschen, natürliches Licht, keine Stockfotos mit Handschlag.", "Real people, natural light, no handshake stock photos.")] },
      ],
    },
    palette.clay,
    lines,
  );
  const guideFile = c.file(brand, t("Markenrichtlinien-v3.pdf", "Brand-guidelines-v3.pdf"), "application/pdf", guide);
  c.setHtml(
    brand,
    p(t("Das PDF unten trägt Anmerkungen: Markierungen, Kreise und handschriftliche Notizen. Öffne es und wähle den Stift, um selbst zu schreiben – mit Apple Pencil, Stift oder Maus.", "The PDF below carries annotations: highlights, circles and handwritten notes. Open it and pick the pen to write yourself – with Apple Pencil, a stylus or a mouse.")) +
      H.pdf(guideFile, t("Markenrichtlinien-v3.pdf", "Brand-guidelines-v3.pdf")) +
      callout("note", t("Anmerkungen haben einen eigenen Verlauf und lassen sich als PDF mit eingebrannter Handschrift exportieren.", "Annotations have their own history and can be exported as a PDF with the handwriting burnt in.")),
  );
  // Annotations placed on the text: a highlight over the colour rule, the
  // accent colour circled with an "approved", a question on the typeface.
  const find = (part: string) => {
    const line = lines.find((l) => l.text.includes(part))!;
    const before = line.text.slice(0, line.text.indexOf(part));
    return { line, x: line.x + line.width(before), w: line.width(part) };
  };
  const accent = find("#E0782C");
  const colourLines = lines.slice(0, 2);
  const inter = find("Inter Bold");
  const ann: InkItem[] = [
    ...colourLines.map((l, i) => penPath([[l.x - 2, l.y - 3.5], [l.x + l.width(l.text) + 2, l.y - 3.5]], { id: `hl${i}`, color: "#ffd43b", width: 13, type: "highlighter", corners: true })),
    penPath(loop(accent.x + accent.w / 2, accent.line.y - 4, accent.w / 2 + 8, 10, 4), { id: "c1", color: "#e03131", width: 1.4, seed: 4 }),
    ...handwriting(t("Passt!", "Approved!"), { x: accent.x + accent.w + 14, y: accent.line.y - 20, size: 24, seed: 9, color: "#2f9e44" }).strokes,
    penPath([[inter.x, inter.line.y + 2.5], [inter.x + inter.w, inter.line.y + 2]], { id: "u1", color: "#1971c2", width: 1.4 }),
    ...handwriting(t("Inter oder Söhne?", "Inter or Söhne?"), { x: inter.x + inter.w + 60, y: inter.line.y - 22, size: 20, seed: 10, color: "#1971c2" }).strokes,
    penPath([[inter.x + inter.w + 56, inter.line.y - 24], [inter.x + inter.w + 22, inter.line.y - 20], [inter.x + inter.w + 4, inter.line.y - 9]], { id: "a1", color: "#1971c2", width: 1.2 }),
    penPath([[inter.x + inter.w - 1, inter.line.y - 15], [inter.x + inter.w + 4, inter.line.y - 9], [inter.x + inter.w + 11, inter.line.y - 13]], { id: "a2", color: "#1971c2", width: 1.2, corners: true }),
    { id: "txt1", type: "text", color: "#c2255c", size: 11, x: 56, y: 760, text: t("Freigegeben von Mara, ", "Approved by Mara, ") + c.day(-3) },
  ];
  saveFileInk(c.me, guideFile, { base: 0, doc: { ...emptyInk(), pages: { "1": ann } } });

  // ---- Meeting notes (filled in later from the template) -------------------
  return { hb, how, editor, brand, meetings, synced: syncedPage };
}

export function meetingNotes(c: Ctx, pageId: string, refs: { tickets: string }) {
  const { t } = c;
  const me = { id: c.me.id, name: t("Du", "You") };
  c.setHtml(
    pageId,
    p(`📅 ${c.day(-1)} · 👥 Mara, Jonas, Aylin, ${t("du", "you")}`) +
      h(2, t("Agenda", "Agenda")) +
      ol(t("Stand Beta", "Beta status"), t("Kaution vs. Vorautorisierung", "Deposit vs. pre-authorisation"), t("Launch-Termin", "Launch date")) +
      h(2, t("Beschlüsse", "Decisions")) +
      callout("important", t("Wir ersetzen die Kaution durch eine Vorautorisierung über 50 € (ATL-4).", "We replace the deposit with a €50 pre-authorisation (ATL-4).")) +
      h(2, t("Aufgaben", "Action items")) +
      tasks(
        { text: t("Payment-Provider-Vertrag prüfen", "Review the payment provider contract"), due: c.day(2), who: me },
        { text: t("Testplan für die Beta schreiben", "Write the beta test plan"), due: c.day(4) },
        { text: t("Termin mit Velo Urban fürs Review", "Schedule the review with Velo Urban"), done: true },
      ) +
      p(t(`Tickets: ${link(refs.tickets, "Board")}`, `Tickets: ${link(refs.tickets, "Board")}`)),
  );
}

export async function journal(c: Ctx) {
  const { t } = c;
  const j = c.page("journal", "personal", "Journal", "journal", null, "📓");
  c.act({
    action: "journal.settings",
    pageId: j,
    template: h(3, t("Dankbar für", "Grateful for")) + p("") + h(3, t("Fokus heute", "Focus today")) + tasks({ text: "" }) + h(3, t("Rückblick am Abend", "Evening review")) + p(""),
    trackers: [
      { id: "mood", name: t("Stimmung", "Mood"), kind: "mood" },
      { id: "energy", name: t("Energie", "Energy"), kind: "scale" },
      { id: "sleep", name: t("Schlaf", "Sleep"), kind: "number", unit: "h" },
      { id: "water", name: t("Wasser", "Water"), kind: "number", unit: "l" },
      { id: "sport", name: "Sport", kind: "check" },
      { id: "focus", name: t("Fokuszeit", "Focus time"), kind: "number", unit: "h" },
    ],
    options: { place: true, events: true },
  });
  const photo = c.file(j, "ostsee.jpg", "image/jpeg", await illustration(["#e7f5ff", palette.sky, palette.sand, palette.night], 77));
  type E = [number, string, Record<string, number | boolean>, string];
  const entries: E[] = [
    [-1, h(3, t("Dankbar für", "Grateful for")) + p(t("Das ehrliche Feedback in der Retro.", "The honest feedback in the retro.")) + h(3, t("Fokus heute", "Focus today")) + tasks({ text: t("Payment-Flow reviewen", "Review the payment flow"), done: true }, { text: t("Fallstudie Atlas gliedern", "Outline the Atlas case study") }, { text: t("Rückruf Praxis am Park", "Call back Praxis am Park") }) + h(3, t("Rückblick am Abend", "Evening review")) + p(t("Guter Tag. Die Beta steht fast.", "Good day. The beta is almost there.")), { mood: 4, energy: 4, sleep: 7.5, water: 2, sport: true, focus: 4 }, "Hamburg"],
    [-2, p(t("Workshop mit Velo Urban: Customer Journey auf dem Whiteboard erarbeitet. Schmerzpunkt Kaution ganz klar.", "Workshop with Velo Urban: worked out the customer journey on the whiteboard. Pain point deposit, very clear.")), { mood: 5, energy: 4, sleep: 7, water: 1.5, sport: false, focus: 2 }, t("Büro", "Office")],
    [-3, p(t("Lange Fokuszeit am Vormittag – zwei Tickets fertig.", "Long focus block in the morning – two tickets done.")), { mood: 4, energy: 3, sleep: 6.5, water: 2, focus: 5 }, t("Büro", "Office")],
    [-4, p(t("Kurzer Tag, abends Laufen an der Alster.", "Short day, a run along the Alster in the evening.")), { mood: 4, energy: 5, sleep: 8, sport: true, water: 2.5 }, "Hamburg"],
    [-5, p(t("Wochenende. Kein Laptop. 🌿", "Weekend. No laptop. 🌿")), { mood: 5, energy: 5, sleep: 9, sport: true }, ""],
    [-7, p(t("Sprint-Planung: 26 Punkte committed. Mutig, aber machbar.", "Sprint planning: 26 points committed. Bold but doable.")), { mood: 3, energy: 3, sleep: 6, water: 1.5, focus: 2 }, t("Büro", "Office")],
    [-8, p(t("Retro Sprint 13 – Ergebnis: WIP-Limit für Review.", "Retro sprint 13 – outcome: WIP limit for review.")), { mood: 4, energy: 3, sleep: 7, focus: 3 }, t("Büro", "Office")],
    [-10, p(t("Müde. Zu viele Meetings.", "Tired. Too many meetings.")), { mood: 2, energy: 2, sleep: 5.5, water: 1, focus: 1 }, t("Büro", "Office")],
    [-12, p(t("Offsite an der Ostsee, Tag 2.", "Offsite at the Baltic Sea, day 2.")) + p(H.image(photo, t("Ostsee", "Baltic Sea"))), { mood: 5, energy: 4, sleep: 7, sport: true }, "Heiligenhafen"],
    [-30, p(t("Kickoff Atlas App. Aufregend!", "Atlas app kickoff. Exciting!")), { mood: 5, energy: 5, sleep: 8, sport: true, focus: 3 }, "Hamburg"],
    [-365, p(t("Vor einem Jahr: erster Tag im eigenen Studio. Drei Tische, eine Kaffeemaschine, viele Pläne.", "A year ago: first day in our own studio. Three desks, one coffee machine, many plans.")), { mood: 5, energy: 4, sleep: 6 }, "Hamburg"],
    [-366, p(t("Umzugskartons. Überall.", "Moving boxes. Everywhere.")), { mood: 3, energy: 2, sleep: 5 }, "Hamburg"],
  ];
  for (const [offset, html, values, place] of entries) {
    const date = c.day(offset);
    const dayId = c.page(`day${offset}`, "personal", dayTitle(date), "document", j);
    run("UPDATE pages SET journal_date=?,icon='day',position=? WHERE id=?", date, -Number(date.replaceAll("-", "")), dayId);
    c.setHtml(dayId, html);
    c.act({ action: "journal.entry", pageId: dayId, entry: { values, ...(place ? { place } : {}) } });
    indexPageTasks(dayId, false);
  }
  c.setHtml(j, p(t("Dein Journal: ein Eintrag pro Tag, Tracker oben, Rückblick und Statistik in der Übersicht. „An diesem Tag“ zeigt, was vor einem Jahr war.", "Your journal: one entry per day, trackers at the top, review and statistics in the overview. “On this day” shows what happened a year ago.")));
  return j;
}

export async function notebook(c: Ctx) {
  const { t } = c;
  const nb = c.page("notebook", "personal", t("Skizzenbuch", "Sketchbook"), "notebook", null, "✏️");
  const first = notebookSheets(nb)[0].id;
  // Paper: lined (default), grid, dotted, Cornell, blank dark landscape, wide ruled.
  c.act({ action: "notebook.sheet.add", pageId: nb, after: first, count: 5 });
  const ids = notebookSheets(nb).map((s) => s.id);
  const paper = (sheetIds: string[], value: Record<string, string>) => c.act({ action: "notebook.sheet.paper", pageId: nb, sheetIds, paper: value });
  paper([ids[1]], { template: "grid" });
  paper([ids[2]], { template: "dotted" });
  paper([ids[3]], { template: "cornell" });
  paper([ids[4]], { template: "blank", orientation: "landscape", color: "dark" });
  paper([ids[5]], { template: "lined-wide" });
  const ink = (sheet: string, items: InkItem[], recognized = "") => writeSurface(nb, sheet, { ...emptyInk(), pages: { [sheet]: items } }, recognized, c.me.id);
  const write = (text: string, x: number, y: number, size: number, seed: number, color = "#1f2a44", maxWidth = 480, lineHeight?: number) =>
    handwriting(text, { x, y, size, seed, color, maxWidth, lineHeight }).strokes;
  // 1: meeting notes on lined paper (college ruling: 20.25 pt).
  const r = 20.25;
  const lines = [
    [t("Ziel: Rad in 30 Sekunden ausleihen.", "Goal: rent a bike in 30 seconds.")],
    [t("Kaution schreckt ab – Vorautorisierung?", "Deposit scares people off – pre-authorise?")],
    [t("Beta in acht Wochen, Launch zum Saisonstart.", "Beta in eight weeks, launch at season start.")],
    [t("Nächster Schritt: Interviews auswerten!", "Next step: analyse the interviews!")],
  ];
  const measure = (text: string, seed: number) => handwriting(text, { x: 90, y: 0, size: 24, seed, maxWidth: 600 }).right;
  const [before, word] = lines[1][0].split(/ – | - /);
  const circleFrom = measure(`${before} –`, 3) + 2;
  const circleTo = measure(`${before} – ${word.replace(/\?$/, "")}`, 3);
  const lastRight = measure(lines[3][0], 5);
  ink(
    ids[0],
    [
      ...write(t("Kickoff Atlas App", "Atlas app kickoff"), 90, 100 + r * 2, 34, 1, "#1f2a44"),
      penPath([[88, 100 + r * 2 + 8], [330, 100 + r * 2 + 6]], { id: "u1", color: "#e0782c", width: 2 }),
      ...lines.flatMap(([text], i) => write(text, 90, 100 + r * (5 + i * 2), 24, 2 + i, "#1f2a44", 600)),
      // Circled: the word after the dash; highlighted: the last line.
      penPath(loop((circleFrom + circleTo) / 2, 100 + r * 7 - 6, (circleTo - circleFrom) / 2 + 10, 15, 7), { id: "l1", color: "#1971c2", width: 1.6, seed: 7 }),
      penPath([[86, 100 + r * 11 - 4], [lastRight + 4, 100 + r * 11 - 3]], { id: "hl", color: "#ffd43b", width: 14, type: "highlighter" }),
    ],
    t("Kickoff Atlas App Ziel: Rad in 30 Sekunden ausleihen.", "Atlas app kickoff Goal: rent a bike in 30 seconds."),
  );
  // 2: a wireframe on grid paper.
  const g = 5 * (72 / 25.4);
  const box = (id: string, x: number, y: number, w: number, h: number, color = "#1f2a44"): InkItem => penPath([[x, y], [x + w, y + 0.6], [x + w - 0.5, y + h], [x + 0.4, y + h - 0.5], [x, y + 1]], { id, color, width: 1.6, corners: true });
  ink(ids[1], [
    ...write("Wireframe: Start", 60, 80, 30, 3),
    box("phone", 60, 110, g * 14, g * 26),
    box("map", 72, 140, g * 14 - 24, g * 12, "#868e96"),
    penPath(loop(150, 210, 14, 14, 2), { id: "pin", color: "#e03131", width: 2 }),
    box("btn", 90, 140 + g * 13, g * 14 - 60, g * 3, "#e0782c"),
    ...write(t("Rad scannen", "Scan bike"), 110, 140 + g * 15, 20, 4, "#e0782c"),
    ...write(t("Karte mit freien Rädern", "Map with free bikes"), 330, 200, 22, 5, "#1971c2", 220),
    penPath([[325, 196], [280, 200], [250, 210]], { id: "a1", color: "#1971c2", width: 1.4 }),
  ]);
  // 3: a bullet journal week on dotted paper.
  const days = t("Mo,Di,Mi,Do,Fr", "Mon,Tue,Wed,Thu,Fri").split(",");
  const todo = t("Beta-Plan,Retro,Fallstudie,Rückruf,Demo", "Beta plan,Retro,Case study,Call back,Demo").split(",");
  ink(ids[2], [
    ...write(t("Woche 44", "Week 44"), 70, 90, 38, 6, "#7b5ea7"),
    ...days.flatMap((d, i) => [
      box(`cb${i}`, 72, 140 + i * 50 - 14, 14, 14, "#1f2a44"),
      ...(i < 2 ? [penPath([[74, 140 + i * 50 - 7], [79, 140 + i * 50 - 2], [88, 140 + i * 50 - 15]], { id: `ck${i}`, color: "#2f9e44", width: 2 })] : []),
      ...write(`${d}  ${todo[i]}`, 100, 140 + i * 50, 24, 20 + i),
    ]),
    ...write(t("Gewohnheiten", "Habits"), 330, 140, 24, 30, "#e0782c"),
    ...[0, 1, 2, 3, 4, 5, 6].map((k) => penPath(loop(340 + k * 24, 175, 8, 8, 40 + k), { id: `hb${k}`, color: k < 4 ? "#2f9e44" : "#adb5bd", width: 1.4 })),
  ]);
  // 4: Cornell notes.
  ink(ids[3], [
    ...write(t("Design Sprint – Notizen", "Design sprint – notes"), 60, 70, 30, 8),
    ...write(t("Tag 1\nTag 2\nTag 3\nTag 4\nTag 5", "Day 1\nDay 2\nDay 3\nDay 4\nDay 5"), 50, 150, 22, 9, "#c2255c", 130, 60),
    ...write(t("Problem verstehen, Ziel festlegen\nLösungen skizzieren\nEntscheiden, Storyboard\nPrototyp bauen\nMit fünf Nutzern testen", "Understand the problem, set a goal\nSketch solutions\nDecide, storyboard\nBuild a prototype\nTest with five users"), 190, 150, 22, 10, "#1f2a44", 360, 60),
    ...write(t("Fazit: fünf Tage, eine Frage.", "Takeaway: five days, one question."), 60, 720, 24, 11, "#2f9e44"),
  ]);
  // 5: a mind map on dark landscape paper.
  ink(ids[4], [
    penPath(loop(420, 300, 110, 46, 12), { id: "core", color: "#ffd43b", width: 2.4 }),
    ...write(t("Launch", "Launch"), 370, 312, 40, 12, "#ffd43b"),
    ...[[160, 140, "Social"], [690, 140, t("Presse", "Press")], [160, 470, "Events"], [690, 470, "Newsletter"]].flatMap(([x, y, label], i) => [
      penPath([[420 + (Number(x) < 420 ? -100 : 100), 300 + (Number(y) < 300 ? -30 : 30)], [Number(x) + (Number(x) < 420 ? 90 : -10), Number(y) + (Number(y) < 300 ? 10 : -20)]], { id: `br${i}`, color: "#a5d8ff", width: 1.8 }),
      ...write(String(label), Number(x) - 30, Number(y), 30, 13 + i, "#e9ecef", 300),
    ]),
  ]);
  // 6: wide ruled with highlights.
  ink(ids[5], [
    ...write(t("Zitat des Tages", "Quote of the day"), 80, 110, 30, 14, "#e0782c"),
    ...write(t("„Fertig ist besser als perfekt –\naber schön ist besser als fertig.“", "“Done is better than perfect –\nbut beautiful is better than done.”"), 80, 110 + 24.75 * 3, 28, 15, "#1f2a44", 460, 24.75 * 2),
    penPath([[78, 110 + 24.75 * 5 + 2], [420, 110 + 24.75 * 5 + 2]], { id: "hl2", color: "#b2f2bb", width: 14, type: "highlighter" }),
  ]);
  // 7–8: a printed storyboard (PDF) as background, sketched on.
  const pdfBytes = await storyboardPdf(t("Storyboard Launch-Video", "Storyboard launch video"), [t("Szene", "Scene"), t("Fiktive Vorlage · Flowplan-Showcase", "Fictional template · Flowplan showcase")]);
  const fileId = c.file(nb, t("Storyboard-Vorlage.pdf", "Storyboard-template.pdf"), "application/pdf", pdfBytes);
  const sizes = await pdfPageSizes(pdfBytes);
  c.act({ action: "notebook.import", pageId: nb, fileId, pages: sizes, after: ids[5] });
  const pdfSheets = notebookSheets(nb).filter((s) => s.background).map((s) => s.id);
  const H0 = 595.28;
  const scenes = t("Pendler am Morgen,Code scannen,Schloss klickt,Fahrt am Wasser,Rückgabe,Logo + Claim", "Commuter in the morning,Scan the code,Lock clicks,Ride by the water,Return,Logo + claim").split(",");
  // A small sketch per scene, drawn into the printed frames.
  const bike = (k: string, x: number, y: number): InkItem[] => [
    penPath(loop(x, y, 18, 18, 60), { id: `${k}w1`, color: "#495057", width: 1.6 }),
    penPath(loop(x + 66, y, 18, 18, 61), { id: `${k}w2`, color: "#495057", width: 1.6 }),
    penPath([[x, y], [x + 26, y - 30], [x + 66, y], [x + 30, y], [x, y]], { id: `${k}fr`, color: "#e0782c", width: 1.8, corners: true }),
    penPath([[x + 26, y - 30], [x + 22, y - 40], [x + 32, y - 40]], { id: `${k}sd`, color: "#e0782c", width: 1.6, corners: true }),
  ];
  const sketches: ((x: number, top: number) => InkItem[])[] = [
    (x, top) => [
      penPath(loop(x + 60, top + 45, 12, 12, 70), { id: "s1h", color: "#495057", width: 1.6 }),
      penPath([[x + 60, top + 57], [x + 60, top + 100], [x + 48, top + 130]], { id: "s1b", color: "#495057", width: 1.6, corners: true }),
      penPath([[x + 60, top + 100], [x + 72, top + 130]], { id: "s1l", color: "#495057", width: 1.6 }),
      penPath([[x + 44, top + 75], [x + 60, top + 68], [x + 78, top + 80]], { id: "s1a", color: "#495057", width: 1.6, corners: true }),
      penPath(loop(x + 180, top + 40, 16, 16, 71), { id: "s1s", color: "#f08c00", width: 1.8 }),
      ...bike("s1", x + 110, top + 120),
    ],
    (x, top) => [
      penPath([[x + 80, top + 20], [x + 150, top + 21], [x + 149, top + 135], [x + 81, top + 134], [x + 80, top + 21]], { id: "s2p", color: "#495057", width: 1.8, corners: true }),
      ...[0, 1, 2].flatMap((r) => [0, 1, 2].filter((col) => (r + col) % 2 === 0 || r === col).map((col) => penPath([[x + 95 + col * 13, top + 50 + r * 13], [x + 104 + col * 13, top + 50 + r * 13], [x + 104 + col * 13, top + 59 + r * 13], [x + 95 + col * 13, top + 59 + r * 13], [x + 95 + col * 13, top + 50 + r * 13]], { id: `s2q${r}${col}`, color: "#1f2a44", width: 1.4, corners: true }))),
      penPath([[x + 92, top + 110], [x + 138, top + 110]], { id: "s2b", color: "#e0782c", width: 3 }),
    ],
    (x, top) => [
      penPath([[x + 90, top + 70], [x + 150, top + 71], [x + 149, top + 125], [x + 91, top + 124], [x + 90, top + 71]], { id: "s3b", color: "#495057", width: 2, corners: true }),
      penPath([[x + 100, top + 70], [x + 100, top + 45], [x + 120, top + 28], [x + 140, top + 45], [x + 140, top + 58]], { id: "s3s", color: "#495057", width: 2 }),
      penPath(loop(x + 120, top + 95, 7, 7, 72), { id: "s3k", color: "#e0782c", width: 2 }),
      ...handwriting(t("klick!", "click!"), { x: x + 160, y: top + 50, size: 20, seed: 73, color: "#2f9e44" }).strokes,
    ],
    (x, top) => [
      ...bike("s4", x + 80, top + 85),
      penPath(Array.from({ length: 30 }, (_, i) => [x + 20 + i * 7, top + 120 + Math.sin(i / 2) * 5] as [number, number]), { id: "s4w", color: "#1971c2", width: 1.6 }),
      penPath(Array.from({ length: 30 }, (_, i) => [x + 20 + i * 7, top + 134 + Math.sin(i / 2 + 1) * 5] as [number, number]), { id: "s4v", color: "#1971c2", width: 1.6 }),
    ],
    (x, top) => [
      ...bike("s5", x + 40, top + 110),
      penPath([[x + 170, top + 30], [x + 205, top + 31], [x + 204, top + 66], [x + 171, top + 65], [x + 170, top + 31]], { id: "s5p", color: "#1971c2", width: 1.8, corners: true }),
      penPath([[x + 187, top + 66], [x + 187, top + 130]], { id: "s5q", color: "#495057", width: 1.6 }),
      ...handwriting("P", { x: x + 180, y: top + 58, size: 30, seed: 74, color: "#1971c2" }).strokes,
    ],
    (x, top) => [...handwriting("Northwind", { x: x + 40, y: top + 85, size: 40, seed: 75, color: "#e0782c" }).strokes, penPath([[x + 40, top + 98], [x + 200, top + 96]], { id: "s6u", color: "#1f2a44", width: 1.4 })],
  ];
  ink(
    pdfSheets[0],
    scenes.flatMap((s, i) => {
      const col = i % 3,
        row = Math.floor(i / 3);
      const x = 40 + col * 260,
        top = 120 + row * 230; // the frame's top edge, from the top of the page
      return [...write(s, x + 4, top + 184, 18, 50 + i, "#1f2a44", 236), ...sketches[i](x, top).map((item) => ({ ...item, id: `${item.id}-${i}` }))];
    }),
    t("Storyboard Szenen", "Storyboard scenes"),
  );
  void H0;
  return nb;
}

export function dashboard(c: Ctx, refs: { tickets: string; projects: string; content: string; survey: string; journal: string }) {
  const { t } = c;
  const dash = c.page("dashboard", "studio", t("Studio-Dashboard", "Studio dashboard"), "dashboard", null, "📊");
  const tickets = database(refs.tickets);
  const survey = database(refs.survey);
  const npsField = survey.fields.find((f) => f.type === "number")!.id;
  const tiles = [
    { id: "intro", type: "text", size: "full", title: "", text: t("**Guten Morgen!** Das Dashboard rechnet live aus den Datenbanken. Kacheln lassen sich verschieben, vergrößern und neu anlegen (✎ oben rechts).", "**Good morning!** The dashboard computes live from the databases. Tiles can be moved, resized and added (✎ at the top right).") },
    { id: "open", type: "number", size: "small", title: t("Offene Tickets", "Open tickets"), source: refs.tickets, view: "open", aggregate: "count", field: "", target: null },
    { id: "points", type: "number", size: "small", title: t("Story Points gesamt", "Story points in total"), source: refs.tickets, view: "", aggregate: "sum", field: "points", target: 80 },
    { id: "budget", type: "number", size: "small", title: t("Auftragsvolumen", "Order volume"), source: refs.projects, view: "", aggregate: "sum", field: "budget", target: 250000 },
    { id: "nps", type: "number", size: "small", title: t("Ø Weiterempfehlung", "Avg. recommendation"), source: refs.survey, view: "", aggregate: "average", field: npsField, target: 10 },
    { id: "status", type: "chart", size: "medium", title: t("Tickets nach Status", "Tickets by status"), source: refs.tickets, view: "", kind: "donut", xField: "status", aggregate: "count", yField: "" },
    { id: "budgetchart", type: "chart", size: "medium", title: t("Budget je Status", "Budget by status"), source: refs.projects, view: "", kind: "horizontal", xField: "status", aggregate: "sum", yField: "budget" },
    { id: "board", type: "view", size: "large", title: t("Sprint-Board", "Sprint board"), source: refs.tickets, view: "board", interactive: true },
    { id: "journal", type: "journal", size: "small", title: "Journal", source: refs.journal },
    { id: "tasks", type: "tasks", size: "medium", title: t("Meine Aufgaben", "My tasks") },
    { id: "posts", type: "chart", size: "medium", title: t("Beiträge je Monat", "Posts per month"), source: refs.content, view: "", kind: "line", xField: "publish", aggregate: "count", yField: "" },
    { id: "recent", type: "recent", size: "medium", title: t("Zuletzt geändert", "Recently changed"), limit: 6 },
  ];
  c.act({ action: "dashboard.save", pageId: dash, tiles });
  void tickets;
  return dash;
}

export function templates(c: Ctx) {
  const { t } = c;
  // Saved from temporary pages, which are removed afterwards.
  const temp = (title: string, kind: string, html: string) => {
    const pid = c.page(`tmp-${title}`, "studio", title, kind);
    if (html) c.setHtml(pid, html);
    return pid;
  };
  const minutes = temp(
    t("Meeting-Protokoll", "Meeting minutes"),
    "document",
    p("📅 … · 👥 …") + h(2, "Agenda") + ol("") + h(2, t("Beschlüsse", "Decisions")) + callout("important", "") + h(2, t("Aufgaben", "Action items")) + tasks({ text: "" }),
  );
  run("UPDATE pages SET icon='🗒️' WHERE id=?", minutes);
  const brief = temp(
    t("Projekt-Steckbrief", "Project one-pager"),
    "document",
    columns(h(3, t("Problem", "Problem")) + p(""), h(3, t("Lösung", "Solution")) + p("")) + h(2, t("Erfolg messen", "Measuring success")) + table([[t("Kennzahl", "Metric"), t("Heute", "Today"), t("Ziel", "Target")], ["", "", ""]]) + h(2, t("Risiken", "Risks")) + callout("warning", ""),
  );
  run("UPDATE pages SET icon='📄' WHERE id=?", brief);
  const planner = c.page("tmp-planner", "studio", t("Wochenplaner", "Weekly planner"), "notebook");
  c.act({ action: "notebook.paper", pageId: planner, paper: { template: "dotted" }, all: true });
  const bugs = c.page("tmp-bugs", "studio", t("Bug-Tracker", "Bug tracker"), "database");
  c.schema(
    bugs,
    [
      { id: "title", name: "Bug", type: "text" },
      { id: "severity", name: t("Schwere", "Severity"), type: "select", options: [t("Kritisch", "Critical"), t("Hoch", "High"), t("Normal", "Normal")] },
      { id: "status", name: "Status", type: "select", options: [t("Neu", "New"), t("In Arbeit", "In progress"), t("Behoben", "Fixed")] },
      { id: "steps", name: t("Schritte", "Steps"), type: "text" },
      { id: "assignee", name: t("Zuständig", "Assignee"), type: "person" },
    ],
    [view("board", "Board", "board", { groupBy: "status" }), view("table", t("Tabelle", "Table"), "table")],
  );
  const saved: string[] = [];
  for (const [pid, name] of [
    [minutes, t("Meeting-Protokoll", "Meeting minutes")],
    [brief, t("Projekt-Steckbrief", "Project one-pager")],
    [planner, t("Wochenplaner (Notizbuch)", "Weekly planner (notebook)")],
    [bugs, t("Bug-Tracker (Datenbank)", "Bug tracker (database)")],
  ] as const)
    saved.push(c.act<{ id: string }>({ action: "template.save", pageId: pid, name, category: "" }).id);
  for (const pid of [minutes, brief, planner, bugs]) {
    run("DELETE FROM pages WHERE id=?", pid);
  }
  return { minutes: saved[0] };
}

export function homeLayout(c: Ctx, refs: { start: string; tickets: string; content: string; journal: string; projects: string }) {
  const { t } = c;
  c.act({
    action: "home.save",
    workspaceId: c.workspace,
    scope: "workspace",
    layout: {
      version: 1,
      appearance: { header: { type: "gradient", value: "dusk", position: 50 }, density: "comfortable", background: "dots", icon: "🧭", width: "wide" },
      widgets: [
        { id: "greeting", kind: "greeting", size: "full", config: { showDate: true, showMessage: true, message: t("Willkommen im Northwind-Showcase – fang bei „Start hier“ an.", "Welcome to the Northwind showcase – begin with “Start here”.") } },
        { id: "pinned", kind: "pinned", size: "l", config: { title: t("Start hier", "Start here"), pageId: refs.start, preview: true } },
        { id: "focus", kind: "focus", size: "s", config: { minutes: 25 } },
        { id: "tasks", kind: "tasks", size: "m", config: { source: "mine", filter: "open", max: 6 } },
        { id: "sprint", kind: "database", size: "m", config: { title: "Sprint 14", pageId: refs.tickets, viewId: "board", properties: ["status", "points"], style: "list", max: 6 } },
        { id: "calendar", kind: "calendar", size: "m", config: { range: "week", sources: [{ pageId: refs.content, viewId: "calendar" }], tasks: true, max: 8 } },
        { id: "journal", kind: "journal", size: "m", config: { journalId: refs.journal, quickWrite: true } },
        { id: "habits", kind: "habits", size: "s", config: { pageId: refs.journal } },
        { id: "counter", kind: "counter", size: "s", config: { title: t("Projektvolumen", "Project volume"), pageId: refs.projects, aggregate: "sum", fieldId: "budget", history: true } },
        { id: "favorites", kind: "favorites", size: "s", config: { max: 8 } },
        { id: "notes", kind: "notes", size: "s", config: { text: t("Notiz an mich: Beta-Termin mit Velo Urban bestätigen.", "Note to self: confirm the beta date with Velo Urban.") } },
        { id: "links", kind: "links", size: "s", config: { links: [{ title: "Flowplan", url: "https://flowplan.org" }, { title: t("Dokumentation", "Documentation"), url: "https://flowplan.org/docs" }] } },
        { id: "recent", kind: "recent", size: "full", config: { mode: "edited", style: "cards", max: 4 } },
      ],
    },
  });
}

export async function startPage(c: Ctx, r: Record<string, string>) {
  const { t } = c;
  const start = c.page("start", "studio", t("Start hier", "Start here"), "document", null, "👋");
  run("UPDATE pages SET position=? WHERE id=?", -1, start);
  const coverFile = c.file(start, "start-cover.jpg", "image/jpeg", await cover([palette.sand, palette.clay, palette.rose, palette.sky, palette.sage], 3));
  c.appearance(start, { cover: c.url(coverFile), cover_position: 55 });
  const row = (icon: string, page: string, title: string, what: string, tryIt: string) => [`${icon} ${link(page, title)}`, what, tryIt];
  const html = [
    p(
      t(
        "Willkommen bei <strong>Northwind Studio</strong> – einem fiktiven Designstudio mit fünf Menschen, vier Kunden und einer App kurz vor dem Launch. Dieser Arbeitsbereich zeigt alles, was Flowplan kann, mit echtem Inhalt statt Platzhaltern. Alle Personen und Firmen sind erfunden; Zuweisungen gehören nach dem Import dir.",
        "Welcome to <strong>Northwind Studio</strong> – a fictional design studio with five people, four clients and an app about to launch. This workspace shows everything Flowplan can do, with real content instead of placeholders. All people and companies are made up; after the import, assignments belong to you.",
      ),
    ),
    H.synced(r.synced),
    h(2, t("Rundgang in 10 Minuten", "A 10-minute tour")),
    tasks(
      { text: t(`${link(r.editor, "Editor-Showcase")} öffnen und <code>/</code> tippen`, `Open the ${link(r.editor, "editor showcase")} and type <code>/</code>`), who: { id: c.me.id, name: t("Du", "You") }, due: c.day(0) },
      { text: t(`Im ${link(r.tickets, "Ticket-Board")} eine Karte nach „Review“ ziehen – der Workflow fragt nach Pflichtfeldern`, `Drag a card to “Review” on the ${link(r.tickets, "ticket board")} – the workflow asks for required fields`) },
      { text: t(`In der ${link(r.projects, "Projekt-Timeline")} ein Projekt verschieben – abhängige Projekte wandern mit`, `Move a project in the ${link(r.projects, "project timeline")} – dependent projects move along`) },
      { text: t(`Auf dem ${link(r.retro, "Retro-Whiteboard")} abstimmen (Klick auf einen Zettel)`, `Vote on the ${link(r.retro, "retro whiteboard")} (click a note)`) },
      { text: t(`Im ${link(r.notebook, "Skizzenbuch")} mit Stift oder Maus schreiben`, `Write in the ${link(r.notebook, "sketchbook")} with a pen or the mouse`) },
      { text: t(`Heute einen ${link(r.journal, "Journal")}-Eintrag schreiben und die Stimmung tracken`, `Write today's ${link(r.journal, "journal")} entry and track your mood`) },
      { text: t("⌘K / Strg+K drücken und nach „Kaution“ suchen", "Press ⌘K / Ctrl+K and search for “deposit”") },
    ),
    h(2, t("Was du wo findest", "What you find where")),
    table([
      [t("Seite", "Page"), t("Zeigt", "Shows"), t("Probier", "Try")],
      row("📘", r.handbook, t("Team-Handbuch", "Team handbook"), t("Seitenbaum, Cover, Spalten, Aufgaben, Prüfdatum, Aliasse", "page tree, cover, columns, tasks, review date, aliases"), t("Inhaltsverzeichnis (☰) öffnen", "open the table of contents (☰)")),
      row("✍️", r.editor, t("Editor-Showcase", "Editor showcase"), t("alle Blöcke: Hinweise, Code, Mermaid, KaTeX, Graphen, Fußnoten, Zitate, Handschrift, eingebettete Datenbank und Whiteboard, PDF, Vorschläge, Kommentare", "every block: callouts, code, Mermaid, KaTeX, graphs, footnotes, citations, handwriting, embedded database and whiteboard, PDF, suggestions, comments"), t("<code>3/4 + 1/6 =</code> tippen, dann Tab", "type <code>3/4 + 1/6 =</code>, then Tab")),
      row("🧭", r.how, t("So arbeiten wir", "How we work"), t("Versionsverlauf, Textkommentare, Seitenkommentare", "version history, text comments, page comments"), t("⋯ → Versionen vergleichen", "⋯ → compare versions")),
      row("🎨", r.brand, t("Markenrichtlinien", "Brand guidelines"), t("PDF mit Handschrift-Anmerkungen", "PDF with handwritten annotations"), t("PDF öffnen, Stift wählen", "open the PDF, pick the pen")),
      row("🚀", r.projects, t("Projekte", "Projects"), t("alle Eigenschaftstypen, Relation, Rollup, Formeln, KI-Eigenschaft, Filtergruppen, Gruppierung, Datensatzvorlage, privater Datensatz, Wiederholung; Tabelle, Board, Kalender, Timeline, Galerie, Liste, Feed, Diagramm, Formular", "every property type, relation, rollup, formulas, AI property, filter groups, grouping, record template, private record, recurrence; table, board, calendar, timeline, gallery, list, feed, chart, form"), t("Timeline: ein Konflikt ist absichtlich drin – „Alle Konflikte nachziehen“", "Timeline: one conflict is there on purpose – “Resolve all conflicts”")),
      row("🎫", r.tickets, "Tickets", t("Ticketnummern (ATL-1 …), Sprints mit Burndown und Velocity, Epics mit Fortschritt, WIP-Limits, Workflow, Automationen, Zeiterfassung", "ticket numbers (ATL-1 …), sprints with burndown and velocity, epics with progress, WIP limits, workflow, automations, time tracking"), t("Ansicht „Sprints“ → Burndown", "view “Sprints” → burndown")),
      row("🤝", r.clients, t("Kunden", "Clients"), t("Zwei-Wege-Relation zu Projekten, Rollups, Logos", "two-way relation to projects, rollups, logos"), t("Pipeline-Board", "pipeline board")),
      row("👥", r.team, "Team", t("Galerie mit Porträts, Telefon, E-Mail", "gallery with portraits, phone, email"), t("„Du“ ist dein Konto", "“You” is your account")),
      row("🗓️", r.content, t("Content-Kalender", "Content calendar"), t("Monats- und Wochenkalender, Serien, wiederkehrende Aufgabe, Galerie aus Bildfeld, Feed", "month and week calendar, series, repeating task, gallery from an image property, feed"), t("Beitrag in der Woche verschieben", "drag a post in the week")),
      row("📋", r.survey, t("Kundenumfrage", "Client survey"), t("Umfrage mit NPS, Matrix, Ranking, Bedingungen, Seiten; Antworten als Datensätze und Diagramme", "survey with NPS, matrix, ranking, conditions, pages; responses as records and charts"), t("Ansicht „Umfrage“ als Vorschau", "preview the “Survey” view")),
      row("📨", r.requests, t("Projektanfragen", "Project requests"), t("Formular mit Bedingungen, Textblöcken, Seitenumbruch, Bestätigungsmail", "form with conditions, text blocks, page break, confirmation email"), t("Formular öffnen und „App“ wählen", "open the form and pick “App”")),
      row("📊", r.dashboard, "Dashboard", t("Kennzahlen, Diagramme, Board, Journal, Aufgaben", "metrics, charts, board, journal, tasks"), t("Kachel hinzufügen", "add a tile")),
      row("🧠", r.retro, "Retro", t("Rahmen, Zettel mit Stimmen, verdeckter Zettel, Tabelle, Datensatzkarten, Kommentar-Pin, Zeichnung", "frames, notes with votes, a covered note, table, record cards, comment pin, drawing"), t("Verdeckten Zettel aufdecken", "uncover the covered note")),
      row("🗺️", r.journey, "Customer Journey", t("Formen, Verbinder, Mindmap", "shapes, connectors, mind map"), t("Knoten wählen, Tab drücken", "select a node, press Tab")),
      row("📓", r.journal, "Journal", t("Tracker, Vorlage, Erinnerungen von vor einem Jahr, Fotos", "trackers, template, memories from a year ago, photos"), t("Übersicht → Statistik", "overview → statistics")),
      row("✏️", r.notebook, t("Skizzenbuch", "Sketchbook"), t("Papiere: liniert, kariert, gepunktet, Cornell, dunkel quer; Handschrift; PDF-Storyboard als Blatt", "papers: lined, grid, dotted, Cornell, dark landscape; handwriting; PDF storyboard as sheets"), t("Blatt hinzufügen, Papier wechseln", "add a sheet, change the paper")),
    ]),
    h(2, t("Außerdem enthalten", "Also included")),
    ul(
      t("<strong>Vorlagen</strong>: „Meeting-Protokoll“, „Projekt-Steckbrief“, „Wochenplaner“ (Notizbuch) und „Bug-Tracker“ (Datenbank) – Seitenleiste → Vorlagen. Die Meeting-Notizen im Handbuch stammen aus der ersten.", "<strong>Templates</strong>: “Meeting minutes”, “Project one-pager”, “Weekly planner” (notebook) and “Bug tracker” (database) – sidebar → Templates. The meeting notes in the handbook come from the first one."),
      t("<strong>Favoriten</strong>: Start hier, Projekte, Tickets, Dashboard und Journal sind markiert.", "<strong>Favourites</strong>: Start here, Projects, Tickets, Dashboard and Journal are starred."),
      t("<strong>Startseite</strong>: Wenn du noch keine eigene Startseite eingerichtet hast, bringt der Import ein Layout mit Begrüßung, angeheftetem „Start hier“, Fokus-Timer, Aufgaben, Sprint, Kalender, Journal und Gewohnheiten mit. „Zurücksetzen“ auf der Startseite stellt deine alte wieder her.", "<strong>Home page</strong>: if you have not set up your own home page yet, the import brings a layout with greeting, pinned “Start here”, focus timer, tasks, sprint, calendar, journal and habits. “Reset” on the home page brings back your previous one."),
      t("<strong>Zwei Bereiche</strong>: „Northwind Studio“ für das Team und „Persönlich“ für Journal und Skizzenbuch. Beim Import werden sie als private Bereiche angelegt – teile sie über die Bereichseinstellungen.", "<strong>Two spaces</strong>: “Northwind Studio” for the team and “Personal” for the journal and sketchbook. The import creates them as private spaces – share them in the space settings."),
    ),
    h(2, t("Selbst einrichten", "Set up yourself")),
    callout(
      "note",
      t("Einige Funktionen hängen an Zugangsdaten oder Adressen deiner Instanz und reisen deshalb nicht im Archiv mit:", "Some features depend on credentials or addresses of your instance and therefore do not travel in the archive:"),
      ul(
        t(`<strong>Kalender abonnieren</strong>: Im ${link(r.content, "Content-Kalender")} → Ansicht „Monat“ → ⋯ → „Kalender abonnieren“ erzeugt eine private iCal-Adresse für Apple, Google oder Outlook.`, `<strong>Calendar subscription</strong>: in the ${link(r.content, "content calendar")} → view “Month” → ⋯ → “Subscribe to calendar” creates a private iCal address for Apple, Google or Outlook.`),
        t(`<strong>Git</strong>: In den ${link(r.tickets, "Tickets")} → ⋯ → Einstellungen → Git eine Webhook-Adresse erzeugen. Commits mit „ATL-12“ verknüpfen sich mit dem Ticket, „fixes ATL-12“ schließt es.`, `<strong>Git</strong>: in ${link(r.tickets, "Tickets")} → ⋯ → Settings → Git create a webhook address. Commits mentioning “ATL-12” link to the ticket, “fixes ATL-12” closes it.`),
        t("<strong>KI</strong>: Die Eigenschaft „KI-Kurzfassung“ in Projekte ist eingerichtet und enthält Beispieltexte. Mit einem KI-Anbieter (Einstellungen → KI) lässt sie sich pro Datensatz neu erzeugen.", "<strong>AI</strong>: the “AI summary” property in Projects is set up and holds sample texts. With an AI provider (Settings → AI) it can be regenerated per record."),
        t("<strong>Freigaben, Veröffentlichungen, Formular-Links</strong>: Formulare sind nach dem Import ausgeschaltet; schalte sie in der Formularansicht ein, um einen öffentlichen Link zu bekommen.", "<strong>Shares, publications, form links</strong>: forms are switched off after the import; switch them on in the form view to get a public link."),
        t("<strong>Datumsangaben</strong> beziehen sich auf den Tag, an dem dieses Showcase erzeugt wurde.", "<strong>Dates</strong> are relative to the day this showcase was generated."),
      ),
    ),
    p(t("Viel Spaß beim Ausprobieren! 🧡", "Have fun exploring! 🧡")),
  ].join("");
  c.setHtml(start, html);
  indexPageTasks(start, false);
  return start;
}
