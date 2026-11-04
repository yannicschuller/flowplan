// Seeds a fresh dev instance with the demo content for the README media:
// a team of four, a project kickoff, a roadmap database, a team wiki and a
// whiteboard. Run once against an empty FLOWPLAN_DATA_DIR:
//
//   APP_URL=http://127.0.0.1:3583 FLOWPLAN_DATA_DIR=/dev/shm/media npx next dev -p 3583
//   MEDIA_URL=http://127.0.0.1:3583 node scripts/readme-media/seed.mjs
//
// Writes ids.json and one signed-in browser state per person to MEDIA_DIR.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { launch, context, cmd, get, post, state, APP, DIR, PASSWORD, sleep } from "./lib.mjs";

const require = createRequire(new URL("../../package.json", import.meta.url));
const Y = require("yjs");
const browser = await launch();

// ---- First account (administers the instance) -----------------------------
{
  const ctx = await context(browser);
  const page = await ctx.newPage();
  await page.goto(APP + "/register");
  await page.fill('input[name="name"]', "Mia Hartmann");
  await page.fill('input[name="email"]', "mia@example.org");
  await page.fill('input[name="password"]', PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(APP + "/", { timeout: 120_000 });
  await sleep(1500);
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

// ---- Team ------------------------------------------------------------------
const people = { Mia: boot.user.id };
for (const [name, full] of [["Jonas", "Jonas Weber"], ["Lena", "Lena Brandt"], ["Noah", "Noah Fischer"]]) {
  const email = name.toLowerCase() + "@example.org";
  await cmd(page, { action: "member.invite", workspaceId: wid, email, role: "editor" });
  const c = await context(browser);
  const p = await c.newPage();
  await post(p, "auth/register", { name: full, email, password: PASSWORD });
  const b = await get(p, "bootstrap");
  people[name] = b.user.id;
  await cmd(page, { action: "admin.confirmEmail", userId: b.user.id });
  await c.close();
  const c2 = await context(browser);
  const p2 = await c2.newPage();
  await post(p2, "auth/password", { email, password: PASSWORD });
  await cmd(p2, { action: "profile.onboarded" });
  await get(p2, "bootstrap");
  await c2.storageState({ path: state(name.toLowerCase()) });
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

// ---- Roadmap database ------------------------------------------------------
const db = await create("Atlas roadmap", "database", "🗺️");
const STATUS = ["Backlog", "Planned", "In progress", "Done"];
const fields = [
  { id: "title", name: "Item", type: "text" },
  { id: "status", name: "Status", type: "select", options: STATUS },
  { id: "owner", name: "Owner", type: "person" },
  { id: "start", name: "Start", type: "date" },
  { id: "end", name: "End", type: "date" },
  { id: "priority", name: "Priority", type: "select", options: ["High", "Medium", "Low"] },
  { id: "area", name: "Area", type: "multiselect", options: ["Engineering", "Design", "Marketing", "Support"] },
  { id: "estimate", name: "Estimate (days)", type: "number" },
];
const views = [
  { id: "table", name: "Table", type: "table", filters: [], sorts: [{ field: "start", direction: "asc" }] },
  { id: "board", name: "Board", type: "board", filters: [], sorts: [], groupBy: "status", hiddenFields: ["start", "end", "estimate", "status"], groupSettings: { hideEmpty: false, sort: "manual", collapsed: [] } },
  { id: "calendar", name: "Calendar", type: "calendar", filters: [], sorts: [], dateField: "start", endDateField: "end" },
  { id: "timeline", name: "Timeline", type: "timeline", filters: [{ field: "start", op: "notempty", value: "" }], sorts: [{ field: "start", direction: "asc" }], dateField: "start", endDateField: "end", timeline: { scale: "month", showWeekends: true } },
];
let pd = await get(page, "pages/" + db);
await cmd(page, { action: "database.update", pageId: db, version: pd.database.version, fields, views });
const rows = [
  ["Kickoff workshop", "Done", "Mia", "2026-11-02", "2026-11-02", "High", ["Design", "Engineering"], 1],
  ["User interviews (8 teams)", "Done", "Lena", "2026-11-03", "2026-11-06", "High", ["Design"], 4],
  ["Data model and API draft", "In progress", "Jonas", "2026-11-05", "2026-11-12", "High", ["Engineering"], 6],
  ["Clickable prototype", "In progress", "Lena", "2026-11-09", "2026-11-16", "High", ["Design"], 5],
  ["Offline sync spike", "In progress", "Noah", "2026-11-10", "2026-11-13", "Medium", ["Engineering"], 3],
  ["Pricing and plans", "Planned", "Mia", "2026-11-16", "2026-11-19", "Medium", ["Marketing"], 3],
  ["Beta with three pilot customers", "Planned", "Jonas", "2026-11-23", "2026-12-04", "High", ["Engineering", "Support"], 10],
  ["Help center articles", "Planned", "Noah", "2026-11-25", "2026-12-02", "Medium", ["Support"], 4],
  ["Launch page and screenshots", "Planned", "Lena", "2026-11-30", "2026-12-03", "Medium", ["Design", "Marketing"], 3],
  ["Public launch", "Backlog", "Mia", "2026-12-08", "2026-12-08", "High", ["Marketing"], 1],
  ["Import from spreadsheets", "Backlog", "Jonas", "", "", "Low", ["Engineering"], 5],
  ["Onboarding checklist", "Backlog", "Noah", "", "", "Low", ["Support"], 2],
];
for (const [title, status, owner, start, end, priority, area, estimate] of rows) {
  const cells = { title, status, owner: people[owner], priority, area, estimate };
  if (start) Object.assign(cells, { start, end });
  await cmd(page, { action: "row.create", pageId: db, cells });
}

// ---- Project kickoff ---------------------------------------------------------
const kickoff = await doc(
  "Project kickoff: Atlas",
  `<aside data-callout="note"><p><strong>Goal:</strong> a self-service client portal that replaces our status e-mails – first pilot customers in December.</p></aside>` +
    `<p>Attendees: ${mention("Mia")} ${mention("Jonas")} ${mention("Lena")} ${mention("Noah")} · Monday, 2 November 2026</p>` +
    `<h2>Why we are doing this</h2>` +
    `<p>Clients ask us for project updates three to four times a week, and the answers live in five different places. Atlas gives every client one page with their milestones, open questions and files – always current, without anyone writing a status mail.</p>` +
    `<h2>Scope for the first release</h2>` +
    `<ul><li><p>Milestones and their status, straight from the <a href="/#page=${db}">Atlas roadmap</a></p></li><li><p>A shared file area per client</p></li><li><p>Questions and approvals with notifications</p></li></ul>` +
    `<h2>Decisions</h2>` +
    `<table><tbody><tr><th><p>Topic</p></th><th><p>Decision</p></th><th><p>Owner</p></th></tr>` +
    `<tr><td><p>Pilot customers</p></td><td><p>Three agencies from the interview round</p></td><td><p>Mia</p></td></tr>` +
    `<tr><td><p>Sign-in for clients</p></td><td><p>Magic link, no passwords</p></td><td><p>Jonas</p></td></tr>` +
    `<tr><td><p>Design system</p></td><td><p>Reuse the website components</p></td><td><p>Lena</p></td></tr></tbody></table>` +
    `<h2>Open questions</h2><ul><li><p>Do clients need to comment on files, or is approval enough?</p></li><li><p>How long do we keep files after a project ends?</p></li></ul>`,
  "🚀",
);
const wiki = await doc(
  "Team wiki",
  `<p>How we work at Northwind Studio – start here if you are new.</p>` +
    `<h2>Getting started</h2><ul data-type="taskList">${task("Set up your laptop and accounts", true)}${task("Read the design principles", true)}${task("Pair with someone on a real ticket", false)}${task("Join the Thursday demo", false)}</ul>` +
    `<h2>Our week</h2><table><tbody><tr><th><p>When</p></th><th><p>What</p></th></tr>` +
    `<tr><td><p>Monday 9:30</p></td><td><p>Planning – we pick the week's work from the roadmap</p></td></tr>` +
    `<tr><td><p>Daily 10:00</p></td><td><p>Ten-minute check-in, cameras optional</p></td></tr>` +
    `<tr><td><p>Thursday 16:00</p></td><td><p>Demo – show what you built, finished or not</p></td></tr></tbody></table>` +
    `<h2>Principles</h2><ol><li><p><strong>Write it down.</strong> Decisions live in the wiki, not in chat.</p></li><li><p><strong>Small and often.</strong> Ship in slices clients can try.</p></li><li><p><strong>Ask early.</strong> A question on day one saves a week later.</p></li></ol>` +
    `<blockquote><p>“If it is not in the wiki, it did not happen.” – our unofficial motto</p></blockquote>`,
  "📚",
);
await doc("Onboarding", `<p>Your first two weeks at Northwind Studio.</p><h2>Week one</h2><ul><li><p>Laptop, accounts and a buddy</p></li><li><p>Shadow a client call</p></li></ul>`, "👋", wiki);
await doc("Design principles", `<ol><li><p>Clarity over cleverness</p></li><li><p>One primary action per screen</p></li><li><p>Respect people's time</p></li></ol>`, "🎨", wiki);
await doc("Engineering handbook", `<h2>Releases</h2><p>We release on Tuesdays and Thursdays. Every change goes through review and CI.</p>`, "🛠️", wiki);
const notes = await doc(
  "Weekly planning",
  `<p>Monday, 9 November · ${mention("Mia")} ${mention("Jonas")} ${mention("Lena")} ${mention("Noah")}</p><p>Focus this week: the prototype and the API draft.</p>`,
  "🗓️",
);
await doc("Client feedback", `<p>What the eight interviewed teams told us, sorted by theme.</p><h2>Top three wishes</h2><ol><li><p>See progress without asking</p></li><li><p>Approve designs in one click</p></li><li><p>All files in one place</p></li></ol>`, "💬");

// ---- Whiteboard --------------------------------------------------------------
const board = await create("Atlas brainstorm", "whiteboard", "🧠");
{
  const ydoc = new Y.Doc();
  const items = ydoc.getMap("items");
  const drafts = [
    { id: "f1", type: "frame", x: 0, y: 0, w: 640, h: 440, text: "What clients want", fill: "#e7f5ff" },
    { id: "f2", type: "frame", x: 720, y: 0, w: 560, h: 440, text: "First release", fill: "#ebfbee" },
    { id: "n1", type: "sticky", x: 30, y: 60, w: 180, h: 160, text: "See progress without asking", fill: "#fff6b6", fontSize: 18 },
    { id: "n2", type: "sticky", x: 230, y: 60, w: 180, h: 160, text: "Approve designs in one click", fill: "#ffd8a8", fontSize: 18 },
    { id: "n3", type: "sticky", x: 430, y: 60, w: 180, h: 160, text: "All files in one place", fill: "#c3fae8", fontSize: 18 },
    { id: "n4", type: "sticky", x: 30, y: 250, w: 180, h: 160, text: "Notify me only when it matters", fill: "#d0bfff", fontSize: 18 },
    { id: "n5", type: "sticky", x: 230, y: 250, w: 180, h: 160, text: "Works on my phone", fill: "#ffc9c9", fontSize: 18 },
    { id: "s1", type: "shape", shape: "rounded", x: 760, y: 70, w: 200, h: 80, text: "Milestones", fill: "#d3f9d8" },
    { id: "s2", type: "shape", shape: "rounded", x: 1040, y: 70, w: 200, h: 80, text: "Approvals", fill: "#d3f9d8" },
    { id: "s3", type: "shape", shape: "rounded", x: 760, y: 220, w: 200, h: 80, text: "File area", fill: "#d3f9d8" },
    { id: "s4", type: "shape", shape: "ellipse", x: 900, y: 330, w: 220, h: 90, text: "Pilot in December", fill: "#e5dbff" },
    { id: "c1", type: "connector", x: 0, y: 0, w: 0, h: 0, from: { id: "s1" }, to: { id: "s2" }, endArrow: true, route: "curved" },
    { id: "c2", type: "connector", x: 0, y: 0, w: 0, h: 0, from: { id: "s3" }, to: { id: "s4" }, endArrow: true, route: "elbow" },
    { id: "c3", type: "connector", x: 0, y: 0, w: 0, h: 0, from: { id: "s2" }, to: { id: "s4" }, endArrow: true, route: "curved" },
  ];
  // Leave room for the toolbar on the left; tighten the gap between frames.
  for (const d of drafts) if (d.type !== "connector") d.x += d.x >= 720 ? 70 : 110;
  const ids = new Map(drafts.map((d) => [d.id, crypto.randomUUID()]));
  drafts.forEach((draft, z) => {
    const map = new Y.Map();
    for (const [key, value] of Object.entries({ ...draft, z }))
      if (key !== "id") map.set(key, key === "from" || key === "to" ? { x: 0, y: 0, ...value, id: ids.get(value.id) } : value);
    items.set(ids.get(draft.id), map);
  });
  const wb = await get(page, "pages/" + board);
  const generation = wb.whiteboard?.generation ?? wb.generation;
  await cmd(page, { action: "whiteboard.sync", pageId: board, generation, update: Buffer.from(Y.encodeStateAsUpdate(ydoc)).toString("base64") });
}

await cmd(page, { action: "notification.read" }).catch(() => {});
// hero.mjs edits the kickoff page; it restores this version first.
const { id: kickoffSnapshot } = await cmd(page, { action: "page.snapshot", pageId: kickoff });
writeFileSync(join(DIR, "ids.json"), JSON.stringify({ db, kickoff, kickoffSnapshot, wiki, notes, board, people, wid, sid }, null, 1));
console.log("seeded", { db, kickoff, wiki, board });
await browser.close();
