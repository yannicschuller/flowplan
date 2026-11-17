// Formatted notification messages (#330): the dialect (mentions, formulas
// on top of #306), the stored form, placeholder values that stay text (no
// Markdown, links or mentions from record or trigger data), the channels –
// plain text for push and the API, escaped HTML for e-mails, Markdown for
// the inbox – and mentions of people who left the workspace.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Field, Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-notify-format-"));
process.env.SMTP_HOST = "smtp.example.test";
process.env.SMTP_FROM = "flowplan@example.test";
process.env.APP_URL = "https://flowplan.example.test";
const { id, run, one, all } = await import("../lib/db");
const { command, database, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { drainWorkflows } = await import("../lib/workflows/queue");
const { queueNotificationDigests } = await import("../lib/mail");
const { databaseSettings } = await import("../lib/database-settings");
const { parseInline, serializeInline } = await import("../lib/inline-markdown");
const notify = await import("../lib/notify-text");
const { NotificationText } = await import("../components/notification-text");
const { NOTIFY_TEXT, cleanNotifyMessage, templateRuns, runsTemplate, renderNotifyRuns, notifyPlain, notifyHtml, notifyMarkup, templatePieces } = notify;

const ANNA = "0b0e1c4a-1111-4222-8333-444455556666";
const BEN = "0b0e1c4a-9999-4222-8333-444455556666";

test("mentions and formulas are atoms of the notification dialect only", () => {
  assert.deepEqual(parseInline(`Hi [@Anna]{data-mention=${ANNA}}, see $x^2$ and **$\\frac{a}{b}$**`, NOTIFY_TEXT), [
    { text: "Hi " },
    { text: "@Anna", mention: ANNA },
    { text: ", see " },
    { text: "x^2", math: true },
    { text: " and " },
    { text: "\\frac{a}{b}", math: true, bold: true },
  ]);
  // Text properties and form descriptions read the same text as before.
  assert.deepEqual(parseInline("$x$"), [{ text: "$x$" }]);
  assert.deepEqual(parseInline(`[@Anna]{data-mention=${ANNA}}`, { spans: true }), [{ text: `[@Anna]{data-mention=${ANNA}}` }]);
  // Prices are no formulas (Pandoc's rules), \$ is a dollar sign.
  assert.deepEqual(parseInline("costs $5 and $10, $ 3 $", NOTIFY_TEXT), [{ text: "costs $5 and $10, $ 3 $" }]);
  assert.deepEqual(parseInline("\\$x\\$", NOTIFY_TEXT), [{ text: "$x$" }]);
  // The export's form reads too; a bad id is no mention.
  assert.deepEqual(parseInline("$`a$b`$", NOTIFY_TEXT), [{ text: "a$b", math: true }]);
  assert.deepEqual(parseInline("[@Anna]{data-mention=nope}", NOTIFY_TEXT), [{ text: "[@Anna]{data-mention=nope}" }]);
});

test("round trips: runs → Markdown → the same runs", () => {
  const samples: import("../lib/inline-markdown").InlineRun[][] = [
    [{ text: "a" }, { text: "@Anna", mention: ANNA }, { text: " " }, { text: "@Anna", mention: ANNA }],
    [{ text: "x^2", math: true }, { text: "5 Äpfel" }],
    [{ text: "price $5 " }, { text: "a$b", math: true }],
    [{ text: "bold ", bold: true }, { text: "y", math: true, bold: true }, { text: " " }, { text: "link", href: "https://example.org" }],
    [{ text: "u", underline: true }, { text: "\n" }, { text: "code", code: true }, { text: "~~not~~ *x*" }],
  ];
  for (const runs of samples) {
    const md = serializeInline(runs, NOTIFY_TEXT);
    assert.deepEqual(parseInline(md, NOTIFY_TEXT), runs, md);
  }
  // A digit after a formula: the export's form.
  assert.equal(serializeInline([{ text: "x", math: true }, { text: "5" }], NOTIFY_TEXT), "$`x`$5");
  assert.equal(serializeInline([{ text: "x", math: true }, { text: " ok" }], NOTIFY_TEXT), "$x$ ok");
});

test("templates: placeholders are slots, round trips keep them as written", () => {
  const template = '**Neu:** {{n_t1.record.title | truncate: 40, "…}}"}} – [öffnen](https://example.org/r/{{n_t1.record.id}}) \\{{literal';
  assert.deepEqual(templatePieces(template).filter((p) => "raw" in p), [{ raw: '{{n_t1.record.title | truncate: 40, "…}}"}}' }, { raw: "{{n_t1.record.id}}" }]);
  const { runs, raws } = templateRuns(template);
  assert.equal(runsTemplate(runs, raws), template);
  // Stored as written when plain; Markdown-looking legacy text formats (the #306 caveat).
  assert.equal(cleanNotifyMessage("Hallo {{n_t1.record.title}}, 50% off_sale"), "Hallo {{n_t1.record.title}}, 50% off_sale");
  assert.equal(cleanNotifyMessage("[x](javascript:alert(1)) {{n_t1.x}}"), "x {{n_t1.x}}");
  assert.equal(cleanNotifyMessage("[x]{.color-red} **b**"), "x **b**");
  // An AI-written workflow: no links, no mentions.
  assert.equal(cleanNotifyMessage(`[x](https://evil.example) [@Anna]{data-mention=${ANNA}} **b**`, { links: false, mentions: false }), "x @Anna **b**");
  // A database rule's message has no placeholders.
  assert.equal(cleanNotifyMessage("Überfällig: **jetzt**", { template: false }), "Überfällig: **jetzt**");
});

test("placeholder values stay literal: no Markdown, links, formulas or mentions from data", () => {
  const evil = `**fett** $x$ [klick](javascript:alert(1)) [@Ben]{data-mention=${BEN}} <b>x</b> \\ 0`;
  const members = new Map([[ANNA, "Anna Muster"], [BEN, "Ben"]]);
  const runs = renderNotifyRuns(`_Neu:_ {{t.title}} von [@A]{data-mention=${ANNA}} [Link](https://example.org/{{t.title}}) [Bad]({{t.title}})`, {
    template: true,
    value: () => evil,
    members,
  });
  const text = runs.map((r) => r.text).join("");
  assert.ok(text.includes(evil.replace(/[]/g, "") ) || text.includes(evil), text);
  assert.equal(runs.filter((r) => r.mention).length, 1);
  assert.equal(runs.find((r) => r.mention)!.text, "@Anna Muster");
  assert.equal(runs.filter((r) => r.math).length, 0);
  assert.equal(runs.filter((r) => r.bold).length, 0);
  const hrefs = [...new Set(runs.map((r) => r.href).filter((h): h is string => !!h))];
  assert.equal(hrefs.length, 1);
  // The value is encoded behind the author's address.
  assert.ok(hrefs[0].startsWith("https://example.org/**fett**%20%24x%24%20%5Bklick%5D(javascript%3Aalert(1))"), hrefs[0]);
  // Stored and read back: the value is still text.
  const markup = notifyMarkup(runs);
  const back = parseInline(markup, NOTIFY_TEXT);
  assert.equal(back.filter((r) => r.mention).length, 1);
  assert.equal(back.filter((r) => r.math || r.bold).length, 0);
  assert.ok(back.some((r) => r.text.includes("**fett** $x$ [klick](javascript:alert(1))")), markup);
  // A value can't open a formula or close one either.
  const inMath = renderNotifyRuns("$a{{t.x}}$", { template: true, value: () => "}\\href{javascript:x}{y}", members });
  assert.deepEqual(inMath, [{ text: "$a}\\href{javascript:x}{y}$" }]);
});

test("channels: plain text for push, escaped HTML for e-mails, mentions of former members as text", () => {
  const markup = `**Bitte** prüfen: [Vertrag](https://example.org/v?a=1&b=2) für [@Anna]{data-mention=${ANNA}} – $E=mc^2$ <script>x</script>\nZeile 2 [mail](mailto:a@example.org)`;
  assert.equal(notifyPlain(markup), "Bitte prüfen: Vertrag (https://example.org/v?a=1&b=2) für @Anna – E=mc^2 <script>x</script>\nZeile 2 mail (a@example.org)");
  // A link whose label is its address: once.
  assert.equal(notifyPlain("[https://example.org](https://example.org)"), "https://example.org");
  const html = notifyHtml(markup);
  assert.match(html, /<strong>Bitte<\/strong>/);
  assert.match(html, /<a href="https:\/\/example.org\/v\?a=1&#38;b=2" target="_blank" rel="noopener noreferrer"[^>]*>Vertrag<\/a>/);
  assert.match(html, /für @Anna/);
  assert.match(html, /<code[^>]*>\$E=mc\^2\$<\/code>/);
  assert.match(html, /&#60;script&#62;x&#60;\/script&#62;<br>Zeile 2/);
  assert.ok(!html.includes("<script"));
  // Mentions resolve to current members: one who left is plain text.
  const runs = renderNotifyRuns(`hi [@Anna]{data-mention=${ANNA}} [@Ben]{data-mention=${BEN}}`, { template: false, members: new Map([[ANNA, "Anna M."]]) });
  assert.deepEqual(runs, [{ text: "hi " }, { text: "@Anna M.", mention: ANNA }, { text: " @Ben" }]);
  // The inbox: elements, a chip for members, text for others, formulas as
  // their source until KaTeX is loaded, links in a new tab.
  const shown = renderToStaticMarkup(createElement(NotificationText, { value: `a [@Anna]{data-mention=${ANNA}} [@Ben]{data-mention=${BEN}} $x^2$ [l](https://example.org) [j](javascript:x)`, members: [{ id: ANNA, name: "Anna Neu" }] }));
  assert.match(shown, new RegExp(`<span class="mention" data-mention="${ANNA}"[^>]*>@Anna Neu</span>`));
  assert.ok(!shown.includes(`data-mention="${BEN}"`));
  assert.match(shown, /@Ben/);
  assert.match(shown, /<span class="math-inline" data-math="x\^2"[^>]*>x\^2<\/span>/);
  assert.match(shown, /<a href="https:\/\/example.org" target="_blank" rel="noopener noreferrer">l<\/a>/);
  assert.ok(!shown.includes("javascript"));
});

/* ---------- On the server: a workflow and a database rule ---------- */

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = await user("Owner"),
  anna = await user("Anna"),
  ben = await user("Ben");
const wid = await createWorkspace(owner.id, "Notify");
const space = (await bootstrap(owner, wid)).spaces[0].id;
await run("INSERT INTO members VALUES(?,?,?)", wid, anna.id, "editor");
const act = async (body: Record<string, unknown>, who = owner): Promise<any> => await command(who, body);
const fields: Field[] = [
  { id: "title", name: "Title", type: "text" },
  { id: "status", name: "Status", type: "select", options: ["Open", "Done"] },
];
const dbId = (await act({ action: "page.create", workspaceId: wid, spaceId: space, kind: "database", title: "Tickets" })).id as string;
await act({ action: "database.update", pageId: dbId, version: (await database(dbId)).version, fields, views: (await database(dbId)).views });

test("a workflow's formatted message: markup for the inbox and e-mail, plain body, values literal, former members text", async () => {
  const trigger = { id: "n_t00001", type: "trigger.record.created", typeVersion: 1, label: "Neu", note: "", position: { x: 0, y: 0 }, disabled: false, config: { database: dbId } };
  const message = `**Neu:** {{n_t00001.record.title}} für [@Anna]{data-mention=${anna.id}} und [@Ben]{data-mention=${ben.id}} – $\\sqrt{2}$ [Doku](https://example.org/{{n_t00001.record.title}}) [x](javascript:alert(1))`;
  const step = { id: "n_t00002", type: "notify.person", typeVersion: 1, label: "Sagen", note: "", position: { x: 10, y: 0 }, disabled: false, config: { to: [owner.id], title: "Ticket *A*", message, channels: ["inbox", "push", "email"] } };
  const pageId = (await act({ action: "page.create", workspaceId: wid, spaceId: space, kind: "workflow", title: "Formatiert" })).id as string;
  await act({ action: "workflow.draft", pageId, graph: { nodes: [trigger, step], edges: [{ id: "e_1", from: { node: trigger.id, port: "out" }, to: { node: step.id, port: "in" } }] } });
  // Cleaned on save: the unsafe link keeps its label.
  const activated = await act({ action: "workflow.activate", pageId });
  assert.equal(activated.ok, true, JSON.stringify(activated.issues));
  const stored = await one<{ graph: string }>("SELECT graph FROM workflow_versions WHERE page_id=?", pageId);
  assert.ok(!stored!.graph.includes("javascript:"), stored!.graph);
  const title = `**Boom** $x$ [evil](https://evil.example) [@Ben]{data-mention=${ben.id}} @Anna`;
  await act({ action: "row.create", pageId: dbId, cells: { title, status: "Open" } });
  await drainWorkflows();
  const n = await one<{ id: string; body: string; markup: string | null }>("SELECT id,body,markup FROM notifications WHERE user_id=? AND kind='workflow'", owner.id);
  assert.ok(n, "a notification");
  // The plain body: no Markdown left, the title literal, Ben (not a member) as text.
  assert.ok(n!.body.startsWith(`Ticket *A* – Neu: ${title} für @Anna und @Ben – \\sqrt{2} Doku (https://example.org/`), n!.body);
  const runs = parseInline(n!.markup, NOTIFY_TEXT);
  assert.deepEqual(runs.filter((r) => r.mention).map((r) => [r.mention, r.text]), [[anna.id, "@Anna"]]);
  assert.equal(runs.filter((r) => r.math).length, 1);
  assert.deepEqual([...new Set(runs.filter((r) => r.href).map((r) => r.href!.slice(0, 20)))], ["https://example.org/"]);
  assert.ok(runs.some((r) => r.text.includes(title)), n!.markup!);
  assert.ok(runs.some((r) => r.text === "Ticket *A* – "), n!.markup!);
  // The inbox gets it; locked notifications never show their markup.
  const boot = await bootstrap(owner, wid);
  assert.equal(boot.notifications.find((x) => x.id === n!.id)?.markup, n!.markup);
  // E-mail: formatted, escaped, formula as source, mention as text.
  await run("DELETE FROM mail_queue");
  await queueNotificationDigests(Date.now() + 30 * 60_000);
  const mail = await one<{ html: string; text: string; subject: string }>("SELECT html,text,subject FROM mail_queue WHERE recipient=?", owner.email);
  assert.ok(mail, "a digest");
  assert.match(mail!.html, /<strong>Neu:<\/strong>/);
  assert.match(mail!.html, /\$\\sqrt\{2\}\$<\/code>/);
  assert.match(mail!.html, /\*\*Boom\*\* \$x\$ \[evil\]\(https:\/\/evil.example\)/);
  assert.ok(!mail!.html.includes('href="https://evil.example'));
  assert.ok(!mail!.html.includes("javascript:"));
  assert.ok(mail!.subject.startsWith("Ticket *A* – Neu: **Boom**"), mail!.subject);
  assert.ok(!mail!.text.includes("<strong>"));
  await act({ action: "workflow.pause", pageId });
});

test("a database rule's formatted message; plain messages stay as they were", async () => {
  await act({
    action: "database.settings",
    pageId: dbId,
    settings: {
      automations: [
        { id: "r1", name: "Fertig", trigger: { type: "changed", field: "status", to: "Done" }, actions: [{ type: "notify", to: owner.id, message: `**Erledigt** von [@Anna]{data-mention=${anna.id}} [x](javascript:1)` }] },
        { id: "r2", name: "Plain", trigger: { type: "changed", field: "status", to: "Done" }, actions: [{ type: "notify", to: owner.id, message: "50% off_sale" }] },
      ],
    },
  });
  const settings = (await databaseSettings(dbId)) as any;
  assert.equal(settings.automations[0].actions[0].message, `**Erledigt** von [@Anna]{data-mention=${anna.id}} x`);
  assert.equal(settings.automations[1].actions[0].message, "50% off_sale");
  await run("DELETE FROM notifications");
  const rid = (await act({ action: "row.create", pageId: dbId, cells: { title: "T **1**", status: "Open" } })).id;
  const version = (await one<{ version: number }>("SELECT version FROM rows WHERE id=?", rid))!.version;
  await act({ action: "row.update", pageId: dbId, rowId: rid, version, cells: { status: "Done" } }, anna);
  await drainWorkflows();
  const notes = await all<{ body: string; markup: string | null }>("SELECT body,markup FROM notifications WHERE user_id=? AND kind='automation' ORDER BY body", owner.id);
  assert.deepEqual(
    notes.map((x) => ({ ...x })),
    [
      { body: "50% off_sale – „T **1**“", markup: null },
      { body: "Erledigt von @Anna x – „T **1**“", markup: `**Erledigt** von [@Anna]{data-mention=${anna.id}} x – „T \\*\\*1\\*\\*“` },
    ],
  );
});
