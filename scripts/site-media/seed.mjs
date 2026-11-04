// Seeds a fresh dev instance with the demo content for the media of the docs
// and the website. Order:
//
//   FLOWPLAN_DATA_DIR=/dev/shm/media APP_URL=http://127.0.0.1:3641 npx next dev --hostname 127.0.0.1 -p 3641
//   node scripts/site-media/ai-mock.mjs &                 # the stand-in AI provider
//   MEDIA_URL=http://127.0.0.1:3641 MEDIA_DATA=/dev/shm/media node scripts/site-media/seed.mjs
//   MEDIA_URL=… node scripts/site-media/shots.mjs [name …]   # screenshots
//   MEDIA_URL=… node scripts/site-media/clips.mjs [name …]   # clips, then encode.sh
//
// Three people:
// - Mia Hartmann (first account, administers the instance; English): the
//   team workspace "Northwind Studio" with Jonas, Lena and Noah, a launch
//   plan, a launch database with a timeline, a notebook with handwriting, an
//   annotated PDF, a drawing block and Ask AI on the mock provider.
// - Lena Hoffmann (German) and Alex Morgan (English): the demo showcase of
//   "Demo ausprobieren" in their language, kept as normal accounts.
//
// Writes ids.json and one signed-in browser state per person to MEDIA_DIR.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { launch, context, cmd, get, post, state, APP, DIR, DATA, PASSWORD, sleep } from "./lib.mjs";
import { handwriting, penPath } from "./handwriting.mjs";
import { paper } from "./paper.mjs";
import { HOME_LAYOUT } from "./home-layout.mjs";

if (!DATA) throw new Error("MEDIA_DATA: the instance's FLOWPLAN_DATA_DIR");
const require = createRequire(new URL("../../package.json", import.meta.url));
const { DatabaseSync } = require("node:sqlite");
const sql = (fn) => {
  const db = new DatabaseSync(join(DATA, "flowplan.sqlite"));
  db.exec("PRAGMA busy_timeout=10000");
  try {
    return fn(db);
  } finally {
    db.close();
  }
};
const MOCK = `http://127.0.0.1:${process.env.MOCK_PORT || 3299}/v1`;
const browser = await launch();
const out = {};

// ---- Mia: the first account administers the instance ----------------------
{
  const ctx = await context(browser);
  const page = await ctx.newPage();
  await post(page, "auth/register", { name: "Mia Hartmann", email: "mia@example.org", password: PASSWORD });
  await get(page, "bootstrap");
  await ctx.storageState({ path: state("mia") });
  await ctx.close();
}
const ctx = await context(browser, { who: "mia" });
const page = await ctx.newPage();
await cmd(page, { action: "profile.onboarded" });
let boot = await get(page, "bootstrap");
const wid = boot.workspace.id;
const sid = boot.spaces[0].id;
await cmd(page, { action: "workspace.update", workspaceId: wid, name: "Northwind Studio" });
for (const p of boot.pages.filter((p) => !p.deleted_at && !p.parent_id)) await cmd(page, { action: "page.delete", pageId: p.id });

// The team.
const people = { Mia: boot.user.id };
for (const [name, full] of [["Jonas", "Jonas Weber"], ["Lena", "Lena Brandt"], ["Noah", "Noah Fischer"]]) {
  const email = name.toLowerCase() + "@example.org";
  await cmd(page, { action: "member.invite", workspaceId: wid, email, role: "editor" });
  const c = await context(browser);
  const p = await c.newPage();
  await post(p, "auth/register", { name: full, email, password: PASSWORD });
  const b = await get(p, "bootstrap");
  people[name] = b.user.id;
  await cmd(page, { action: "admin.confirmEmail", userId: b.user.id }).catch(() => {});
  await c.close();
  const c2 = await context(browser);
  const p2 = await c2.newPage();
  await post(p2, "auth/password", { email, password: PASSWORD });
  await cmd(p2, { action: "profile.onboarded" });
  await get(p2, "bootstrap");
  await c2.close();
}

const icon = (pageId, icon) => cmd(page, { action: "page.update", pageId, patch: { icon } });
const create = async (title, kind, ic, parentId) => {
  const { id } = await cmd(page, { action: "page.create", workspaceId: wid, spaceId: sid, title, kind, ...(parentId ? { parentId } : {}) });
  if (ic) await icon(id, ic);
  return id;
};
const doc = async (title, html, ic, parentId) => {
  const { id } = await cmd(page, { action: "page.import", workspaceId: wid, spaceId: sid, title, format: "html", content: html });
  if (ic) await icon(id, ic);
  if (parentId) await cmd(page, { action: "page.move", pageId: id, parentId });
  return id;
};
const task = (text, done = false, extra = "") =>
  `<li data-type="taskItem" data-checked="${done}"${extra}><label><input type="checkbox"${done ? " checked" : ""}></label><div><p>${text}</p></div></li>`;
const mention = (name) => `<span data-mention="${people[name]}" class="mention">@${name}</span>`;

// ---- Product launch: board, timeline, table, calendar ----------------------
const db = await create("Product launch", "database", "🚀");
let pd = await get(page, "pages/" + db);
const STATUS = ["Idea", "Planned", "In progress", "Done"];
await cmd(page, {
  action: "database.update",
  pageId: db,
  version: pd.database.version,
  fields: [
    { id: "title", name: "Task", type: "text" },
    { id: "status", name: "Status", type: "select", options: STATUS },
    { id: "owner", name: "Owner", type: "person" },
    { id: "start", name: "Start", type: "date" },
    { id: "end", name: "End", type: "date" },
    { id: "priority", name: "Priority", type: "select", options: ["High", "Medium", "Low"] },
    { id: "area", name: "Area", type: "multiselect", options: ["Engineering", "Marketing", "Support", "Design"] },
    { id: "deps", name: "Depends on", type: "relation", relationPage: db },
  ],
  views: [
    { id: "board", name: "Board", type: "board", filters: [], sorts: [], groupBy: "status", hiddenFields: ["status", "start", "end", "deps", "priority"], groupSettings: { hideEmpty: true, sort: "manual", collapsed: [] } },
    {
      id: "timeline", name: "Timeline", type: "timeline", filters: [{ field: "start", op: "notempty", value: "" }], sorts: [{ field: "start", direction: "asc" }],
      dateField: "start", endDateField: "end",
      timeline: { scale: "month", showWeekends: true, dependencyField: "deps", dependencyType: "fs", moveSuccessors: true, criticalPath: true },
    },
    { id: "table", name: "All tasks", type: "table", filters: [], sorts: [{ field: "start", direction: "asc" }] },
    { id: "calendar", name: "Calendar", type: "calendar", filters: [], sorts: [], dateField: "start", endDateField: "end" },
  ],
});
// Dates around "today" (the clips and screenshots are taken now), so the
// timeline and the agenda are never empty: day 0 is the launch.
const DAY = 86400_000;
const launchDay = new Date(Date.now() + 9 * DAY);
const iso = (offset) => new Date(launchDay.getTime() + offset * DAY).toISOString().slice(0, 10);
const nice = (offset, opts = { day: "numeric", month: "long" }) => new Date(launchDay.getTime() + offset * DAY).toLocaleDateString("en-GB", opts);
const rows = [
  ["Finalize pricing", "Done", "Lena", -27, -23, "High", ["Marketing"], []],
  ["Security review", "Done", "Jonas", -23, -14, "High", ["Engineering"], []],
  ["Write release notes", "Done", "Noah", -22, -16, "Medium", ["Support"], ["Finalize pricing"]],
  ["Landing page and screenshots", "In progress", "Lena", -22, -7, "High", ["Design", "Marketing"], ["Finalize pricing"]],
  ["Update help center", "In progress", "Noah", -15, -5, "Medium", ["Support"], ["Write release notes"]],
  ["Migration dry run", "In progress", "Jonas", -12, -8, "High", ["Engineering"], ["Security review"]],
  ["Beta rollout", "Planned", "Jonas", -7, -5, "High", ["Engineering"], ["Migration dry run"]],
  ["Press kit", "Planned", "Lena", -6, -2, "Medium", ["Marketing"], ["Landing page and screenshots"]],
  ["Go/no-go review", "Planned", "Mia", -1, -1, "High", [], ["Beta rollout", "Update help center", "Press kit"]],
  ["Public launch", "Planned", "Mia", 0, 0, "High", ["Marketing"], ["Go/no-go review"]],
  ["Launch webinar", "Idea", "Noah", null, null, "Low", ["Marketing"], []],
  ["Customer quotes for the website", "Idea", "Lena", null, null, "Medium", ["Marketing"], []],
  ["Referral program", "Idea", "Mia", null, null, "Low", ["Marketing"], []],
];
const rowIds = {};
for (const [title, status, owner, start, end, priority, area] of rows) {
  const cells = { title, status, owner: people[owner], priority, area };
  if (start !== null) Object.assign(cells, { start: iso(start), end: iso(end) });
  rowIds[title] = (await cmd(page, { action: "row.create", pageId: db, cells })).id;
}
for (const [title, , , , , , , deps] of rows)
  for (const d of deps) {
    const v = (await get(page, "pages/" + db)).database.version;
    await cmd(page, { action: "timeline.link", pageId: db, viewId: "timeline", version: v, from: rowIds[d], to: rowIds[title] });
  }

// ---- Documents --------------------------------------------------------------
const citation = JSON.stringify({
  id: "heath2007", type: "book", title: "Made to Stick: Why Some Ideas Survive and Others Die",
  author: [{ family: "Heath", given: "Chip" }, { family: "Heath", given: "Dan" }],
  issued: { "date-parts": [[2007]] }, publisher: "Random House",
}).replace(/"/g, "&quot;");
const weekday = nice(0, { weekday: "long", day: "numeric", month: "long" });
const plan = await doc(
  "Launch plan",
  `<aside data-callout="important"><p><strong>Launch: ${weekday}.</strong> The go/no-go review is the day before – everything below feeds into it.</p></aside>` +
    `<p>Everything for the release of Flowplan 2.0 in one place: goals, open tasks, who announces what, and when. The tasks themselves live in <a href="/#page=${db}">Product launch</a>.</p>` +
    `<h2>Checklist</h2><ul data-type="taskList">` +
    task("Pricing page signed off", true) +
    task(`Release notes reviewed by ${mention("Noah")}`, true) +
    task(`Migration dry run passed – ${mention("Jonas")}`, false, ` data-due="${iso(-8)}"`) +
    task("Screenshots for the landing page", false, ` data-due="${iso(-7)}"`) +
    task("Press kit sent to partners", false, ` data-due="${iso(-2)}"`) +
    `</ul>` +
    `<h2>Goals</h2><ul><li><p>Every beta workspace migrated without data loss</p></li><li><p>500 new sign-ups in the first two weeks</p></li><li><p>Help center articles for every new feature on day one</p></li></ul>` +
    `<h2>Rollout</h2>` +
    `<p>Flowplan 2.0 goes live on ${nice(0)}. Rather than switching everyone over on a single day, we are planning a staged rollout: the beta customers who have been testing with us since the summer get the new version first, and everyone else follows about a week later, once we are confident that the migration runs smoothly. Marketing, support and documentation will all go live at the same time, so that nobody hears about a feature before the help center can explain it. Mia owns the final go/no-go decision, which we will make together the day before the launch, based on the beta rollout and the migration dry run.</p>` +
    `<h2>Channels</h2><table><tbody><tr><th><p>Channel</p></th><th><p>Owner</p></th><th><p>Goes out</p></th></tr>` +
    `<tr><td><p>Blog post and newsletter</p></td><td><p>Lena</p></td><td><p>${nice(0, { day: "numeric", month: "short" })}, 9:00</p></td></tr>` +
    `<tr><td><p>In-app announcement</p></td><td><p>Noah</p></td><td><p>${nice(0, { day: "numeric", month: "short" })}, 10:00</p></td></tr>` +
    `<tr><td><p>Partner e-mail</p></td><td><p>Mia</p></td><td><p>${nice(1, { day: "numeric", month: "short" })}</p></td></tr></tbody></table>` +
    `<h2>Why a staged rollout</h2>` +
    `<p>Staged rollouts catch most migration problems before they reach everyone<sup data-footnote="In the 1.8 release, three of the four migration issues showed up in the first five percent of workspaces."></sup>. And one clear message sticks better than a long feature list <span class="citation" data-citation="heath2007" data-citation-item="${citation}" data-citation-locator=""></span>, so the announcement leads with a single sentence: <em>your whole team's work, in one place – now faster.</em></p>` +
    `<div data-bibliography="true" data-bibliography-title="References"></div>`,
  "📋",
);
const marketing = await doc("Marketing", `<p>Everything we publish around the launch, in one place.</p><ul><li><p>Launch announcement – blog post and newsletter</p></li><li><p>Press kit – logos, screenshots, quotes</p></li></ul>`, "📣");
await doc(
  "Launch announcement",
  `<h2>Your whole team's work, in one place – now faster</h2><p>Today we are releasing Flowplan 2.0. Pages open instantly, boards and timelines move with you, and the new writing assistant helps you get to the point.</p><h3>What's new</h3><ul><li><p>A faster editor and page tree</p></li><li><p>Timelines with dependencies and a critical path</p></li><li><p>Optional AI that runs on your own server</p></li></ul>`,
  "📝",
  marketing,
);
await doc("Press kit", `<p>Logos, product screenshots and quotes for partners and press.</p><ul data-type="taskList">${task("Logo files (SVG, PNG)", true)}${task("Screenshots in light and dark", false)}${task("Two customer quotes", false)}</ul>`, "🗞️", marketing);
const handbook = await doc("Team handbook", `<p>How we work at Northwind Studio: tools, rituals and who to ask.</p><h2>Rituals</h2><ul><li><p>Monday: planning, 30 minutes</p></li><li><p>Thursday: demo of what shipped</p></li></ul>`, "📚");
const meetings = await doc("Meeting notes", `<p>Notes from our weekly syncs, newest first.</p>`, "🗒️", handbook);
const sync = await doc(
  `Launch sync – ${nice(-16, { day: "numeric", month: "long" })}`,
  `<p>Attendees: Mia, Jonas, Lena, Noah</p><h2>Decisions</h2><ul><li><p>The public launch stays on ${nice(0)}.</p></li><li><p>The go/no-go review is on ${nice(-1)}; Mia makes the call.</p></li><li><p>The launch depends on the migration dry run and the beta rollout, both owned by Jonas.</p></li></ul><h2>Next steps</h2><ul data-type="taskList">${task("Share the rollout plan with support", false)}${task("Pick a date for the launch webinar", false)}</ul>`,
  "🗓️",
  meetings,
);
await doc(
  "Customer interviews",
  `<p>Notes from five interviews with beta customers.</p><h2>What we heard</h2><ul><li><p>Planning and documentation should live next to each other.</p></li><li><p>Timelines need dependencies – "what moves if this slips?"</p></li><li><p>Self-hosting is a must for two of the five teams.</p></li></ul><blockquote><p>"We finally stopped copying status updates between three tools." – Ella, operations lead</p></blockquote>`,
  "🎧",
);

// ---- Release notes: a Markdown code block, code and preview side by side ---
const PIPELINE_HTML =
  `<p>The release notes are written in Markdown; the preview shows them as the blog will.</p>` +
  `<pre data-code-view="split" data-line-numbers="true" data-highlight-lines="3"><code class="language-markdown">## Flowplan 2.0
_Your whole team's work, in one place – now faster._
**Ships first to the beta customers.**

- A faster editor and page tree
- Timelines with dependencies
- Optional AI on your own server

&gt; Questions? Ask in the help center.</code></pre>` +
  `<p>Lena turns this into the blog post on launch day.</p>`;
const pipeline = await doc("Release notes", PIPELINE_HTML, "📝", handbook);

// ---- Onboarding flow: a drawing block in a document ------------------------
const BLOCK = "onboarding-sketch";
const flow = await doc(
  "Onboarding flow",
  `<p>Three screens for the first minute in the app. Templates help, but only when they match the team's job.</p>` +
    `<div data-ink-block="${BLOCK}" data-ink-height="460" data-ink-paper="grid" class="ink-block-placeholder">Handschrift</div>` +
    `<h2>Next steps</h2><ul data-type="taskList">${task("Clickable prototype of the three screens")}${task("Test with five new teams")}</ul>`,
  "🧭",
);
{
  const ink = [];
  const w = (text, x, y, size, seed, color = "#1f2a44") => ink.push(...handwriting(text, { x, y, size, seed, color, maxWidth: 400 }).strokes);
  const box = (x, y, bw, bh, id) => ink.push(penPath([[x, y], [x + bw, y + 1], [x + bw - 1, y + bh], [x + 1, y + bh - 1], [x, y]], { id, corners: true, width: 1.8 }));
  const screens = [["1 Welcome", "Name your team"], ["2 Invite", "add colleagues"], ["3 Template", "pick one, done"]];
  screens.forEach(([head, sub], i) => {
    const x = 40 + i * 260;
    box(x, 30, 170, 210, `s${i}`);
    w(head, x + 14, 70, 22, 10 + i);
    w(sub, x + 14, 100, 16, 20 + i);
    for (let l = 0; l < 3; l++) ink.push(penPath([[x + 16, 135 + l * 18], [x + 150, 136 + l * 18]], { id: `l${i}${l}`, width: 1.2, seed: i * 3 + l }));
    box(x + 22, 195, 126, 32, `b${i}`);
    if (i < 2) ink.push(penPath([[x + 182, 135], [x + 248, 134]], { id: `a${i}`, width: 1.6 }), penPath([[x + 238, 127], [x + 249, 134], [x + 238, 141]], { id: `h${i}`, width: 1.6, corners: true }));
  });
  ink.push(penPath([[300, 330], [292, 262]], { id: "pt", color: "#e03131", width: 1.6 }), penPath([[285, 274], [292, 261], [299, 273]], { id: "ph", color: "#e03131", width: 1.6, corners: true }));
  w("invite before the template !", 320, 320, 22, 33, "#e03131");
  await page.request.put(`${APP}/api/pages/${flow}/ink?surface=${BLOCK}`, {
    headers: { Origin: APP, "content-type": "application/json" },
    data: { base: 0, doc: { format: "flowplan-ink", version: 1, unit: "pt", pages: { [BLOCK]: ink } } },
  }).then(async (r) => r.ok() || console.warn("draw block ink", r.status(), await r.text()));
}

// ---- Physics 101: a notebook with handwriting -------------------------------
const notebook = await create("Physics 101 – Lecture notes", "notebook");
let sheets = (await get(page, "pages/" + notebook)).notebook?.sheets || [];
await cmd(page, { action: "notebook.sheet.add", pageId: notebook, after: sheets[0]?.id, count: 1 }).catch((e) => console.warn(e.message));
sheets = (await get(page, "pages/" + notebook)).notebook?.sheets || [];
await cmd(page, { action: "notebook.paper", pageId: notebook, paper: { template: "lined" }, all: true }).catch((e) => console.warn(e.message));
const saveSheet = (sheet, items) =>
  page.request.put(`${APP}/api/pages/${notebook}/ink?surface=${sheet}`, {
    headers: { Origin: APP, "content-type": "application/json" },
    data: { base: 0, doc: { format: "flowplan-ink", version: 1, unit: "pt", pages: { [sheet]: items } } },
  }).then(async (r) => r.ok() || console.warn("notebook ink", r.status(), await r.text()));
if (sheets[0]) {
  const r = 20.25;
  const ink = [];
  const w = (text, x, y, size, seed, color = "#1f2a44") => {
    const h = handwriting(text, { x, y, size, seed, color, maxWidth: 470 });
    ink.push(...h.strokes);
    return h;
  };
  w("Lecture 4 – Newton's laws", 90, 100 + r * 2, 30, 1, "#1864ab");
  w("Oct 25", 470, 100 + r * 2, 18, 2, "#1864ab");
  w("1. Inertia: a body stays at rest or keeps moving", 90, 100 + r * 4, 19, 3);
  w("in a straight line unless a force acts on it.", 104, 100 + r * 5, 19, 4);
  const f = w("2. F = m · a", 90, 100 + r * 7, 22, 5);
  ink.push(penPath([[112, 100 + r * 7 - 22], [f.right + 6, 100 + r * 7 - 22], [f.right + 6, 100 + r * 7 + 6], [112, 100 + r * 7 + 6], [112, 100 + r * 7 - 22]], { id: "box", corners: true, width: 1.6 }));
  ink.push(penPath([[f.right + 10, 100 + r * 7 - 8], [f.right + 40, 100 + r * 7 - 8]], { id: "ar", color: "#e03131", width: 1.5 }));
  w("exam !", f.right + 46, 100 + r * 7 - 2, 19, 6, "#e03131");
  // The script font has no ×, − or ²: written the way people write them.
  const unit = w("force = mass x acceleration,  1 N = 1 kg · m/s", 104, 100 + r * 8.5, 17, 7);
  w("2", unit.right - 2, 100 + r * 8.5 - 9, 10, 17);
  const third = w("3. Actio = reactio: every force has an equal", 90, 100 + r * 10, 19, 8);
  w("and opposite force,  F12 = - F21", 104, 100 + r * 11, 19, 9);
  ink.push(penPath([[third.right - 70, 100 + r * 10 - 4], [third.right + 2, 100 + r * 10 - 3]], { id: "hl1", color: "#ffd43b", width: 13, type: "highlighter" }));
  // An inclined plane with the forces.
  const y0 = 100 + r * 19;
  ink.push(penPath([[150, y0], [430, y0], [430, y0 - 150], [150, y0]], { id: "ramp", corners: true, width: 1.6 }));
  ink.push(penPath([[268, y0 - 50], [300, y0 - 67], [316, y0 - 38], [284, y0 - 21], [268, y0 - 50]], { id: "blk", corners: true, width: 1.6 }));
  ink.push(penPath([[292, y0 - 44], [292, y0 + 18]], { id: "fg", color: "#e03131", width: 1.6 }));
  w("mg", 298, y0 + 22, 15, 11, "#e03131");
  ink.push(penPath([[292, y0 - 44], [262, y0 - 100]], { id: "fn", color: "#1864ab", width: 1.6 }));
  w("N", 250, y0 - 104, 15, 12, "#1864ab");
  ink.push(penPath([[300, y0 - 52], [350, y0 - 78]], { id: "fr", color: "#2b8a3e", width: 1.6 }));
  w("friction", 352, y0 - 80, 15, 13, "#2b8a3e");
  await saveSheet(sheets[0].id, ink);
}
if (sheets[1]) {
  const ink = [];
  ink.push(...handwriting("Exercises", { x: 90, y: 140, size: 26, seed: 40, color: "#1864ab" }).strokes);
  ink.push(...handwriting("Box on a ramp, 30°: find a", { x: 90, y: 200, size: 19, seed: 41 }).strokes);
  ink.push(penPath([[120, 400], [380, 400], [120, 260], [120, 400]], { id: "t2", corners: true, width: 1.5 }));
  await saveSheet(sheets[1].id, ink);
}

// ---- Reading: a paper as PDF, annotated --------------------------------------
const reading = await doc("Reading list", `<p>Papers for the onboarding redesign.</p>`, "📖");
let pdfFile = null;
{
  const { bytes, ink } = await paper();
  const res = await page.request.post(APP + "/api/upload", {
    headers: { Origin: APP },
    multipart: { pageId: reading, file: { name: "Spaced-repetition.pdf", mimeType: "application/pdf", buffer: bytes } },
  });
  pdfFile = await res.json();
  await page.request.put(`${APP}/api/files/${pdfFile.id}/ink`, { headers: { Origin: APP, "content-type": "application/json" }, data: { base: 0, doc: ink } })
    .then(async (r) => r.ok() || console.warn("pdf ink", r.status(), await r.text()));
  // The PDF as a block in the page (the document has no edits yet, so its
  // HTML is its content).
  const html = `<p>Papers for the onboarding redesign.</p><div data-pdf="/api/files/${pdfFile.id}" data-title="Spaced-repetition.pdf" class="pdf-block"><a href="/api/files/${pdfFile.id}">Spaced-repetition.pdf</a></div><p>Takeaway: short, repeated touches beat one long tutorial.</p>`;
  sql((d) => d.prepare("UPDATE documents SET html=?,state=NULL WHERE page_id=?").run(html, reading));
}
out.pdf = pdfFile?.id;

// Mia's own tasks this week (My tasks, the home page).
const todayIso = (d) => new Date(Date.now() + d * DAY).toISOString().slice(0, 10);
const WEEK_HTML = `<p>What Mia wants to get done this week.</p><ul data-type="taskList">${task(`Schedule interviews with three beta teams ${mention("Mia")}`, false, ` data-due="${todayIso(0)}"`)}${task(`Sketch a draft for the pricing page ${mention("Mia")}`, false, ` data-due="${todayIso(1)}"`)}${task(`Review the press kit with Lena ${mention("Mia")}`, false, ` data-due="${todayIso(3)}"`)}</ul>`;
await doc("Weekly planning", WEEK_HTML, "🗂️", meetings);

// ---- A journal and the start page ------------------------------------------
await cmd(page, { action: "page.create", workspaceId: wid, spaceId: sid, title: "Journal", kind: "journal" });
await cmd(page, { action: "home.save", workspaceId: wid, layout: HOME_LAYOUT });

// ---- Collections in the sidebar ---------------------------------------------
for (const [name, query, icon] of [["Everything about the launch", "launch", "🎯"], ["Edited this week", "updated:this-week type:document", "🕘"]])
  await cmd(page, { action: "collection.create", workspaceId: wid, name, query, icon, shared: true }).catch((e) => console.warn("collection", e.message));

// ---- AI (instance): the mock provider ----------------------------------------
await cmd(page, {
  action: "admin.ai",
  settings: {
    enabled: true,
    provider: { kind: "openai", baseUrl: MOCK, model: "llama3.1", embeddingModel: "" },
    access: "everyone", guests: false, userProviders: false,
    features: { write: true, summarize: true, ask: true, database: true },
    semanticSearch: false,
  },
});
// The public demo, for the two showcase accounts below.
sql((d) => d.prepare("INSERT INTO instance_settings(key,value) VALUES('publicDemo','true') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run());
Object.assign(out, { pipeline, wid, sid, db, plan, marketing, handbook, sync, flow, notebook, reading, rows: rowIds, people, launch: iso(0) });
await ctx.close();

// ---- Lena (German) and Alex (English): the demo showcase ---------------------
for (const [who, lang, name] of [["lena", "de", "Lena Hoffmann"], ["alex", "en", "Alex Morgan"]]) {
  const c = await context(browser, { lang });
  const res = await c.request.post(`${APP}/api/auth/trial`, { headers: { Origin: APP }, data: {}, timeout: 300_000 });
  if (!res.ok()) throw new Error(`demo ${lang}: ${res.status()} ${await res.text()}`);
  await c.storageState({ path: state(who) });
  await c.close();
  const info = sql((d) => {
    const user = d.prepare("SELECT id FROM users WHERE demo_until IS NOT NULL ORDER BY rowid DESC LIMIT 1").get().id;
    const workspace = d.prepare("SELECT workspace_id id FROM members WHERE user_id=?").get(user).id;
    d.prepare("UPDATE users SET name=?,email=?,demo_until=NULL,onboarded_at=? WHERE id=?").run(name, `${who}@example.com`, Date.now(), user);
    d.prepare("UPDATE sessions SET expires=? WHERE user_id=?").run(Date.now() + 14 * DAY, user);
    d.prepare("UPDATE workspaces SET name=?,quota_mb=NULL WHERE id=?").run("Northwind Studio", workspace);
    const pages = d.prepare("SELECT id,title,kind FROM pages WHERE workspace_id=? AND deleted_at IS NULL").all(workspace);
    return { user, workspace, pages };
  });
  out[who] = info;
  console.log(who, info.pages.map((p) => `${p.kind}:${p.title}`).join(" | "));
}

writeFileSync(join(DIR, "ids.json"), JSON.stringify(out, null, 1));
console.log("seeded", APP);
await browser.close();
