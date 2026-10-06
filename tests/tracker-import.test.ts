import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Papa from "papaparse";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-tracker-"));
const { id, run, all, one } = await import("../lib/db");
const { bootstrap, database, rows } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { importTracker, parseJira } = await import("../lib/tracker-import");

function user(name: string, email: string): Identity {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, email);
  return { id: uid, name, email, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = user("Ada Lovelace", "ada@test.invalid");
const wid = createWorkspace(owner.id, "Import"),
  boot = bootstrap(owner, wid);
const space = boot.spaces[0].id;

// Jira repeats columns (Labels, Comment, Attachment, Sprint).
const jira = Papa.unparse([
  ["Summary", "Issue key", "Issue id", "Parent id", "Issue Type", "Status", "Priority", "Assignee", "Reporter", "Created", "Due date", "Labels", "Labels", "Sprint", "Custom field (Story Points)", "Description", "Comment", "Attachment"],
  ["Login epic", "WEB-1", "100", "", "Epic", "In Progress", "High", "Ada Lovelace", "Bob", "06/Oct/26 10:15 AM", "", "auth", "", "Sprint 3", "", "All of login", "06/Oct/26 11:00 AM;557058:x;Looks good", ""],
  ["Reset password", "WEB-2", "101", "100", "Story", "Done", "Medium", "Ada Lovelace", "Bob", "2026-10-07 09:00", "20/Oct/26", "auth", "mail", "Sprint 3", "3", "Send a mail", "", "07/Oct/26;bob;spec.pdf;https://jira.example/secure/attachment/1/spec.pdf"],
]);

test("Jira CSV: properties, subtasks, comments, attachments", () => {
  const draft = parseJira(jira, "Web");
  assert.deepEqual(
    draft.fields.map((f) => f.name),
    ["Titel", "Jira-Schlüssel", "Typ", "Status", "Priorität", "Zuständig", "Gemeldet von", "Labels", "Sprint", "Story Points", "Erstellt", "Fällig", "Übergeordnet"],
  );
  const result = importTracker(owner, wid, space, "jira", jira, "Web.csv");
  assert.deepEqual([result.rows, result.comments], [2, 1]);
  const db = database(result.pageId);
  const stored = rows(result.pageId);
  const byKey = (k: string) => stored.find((r) => r.cells[db.fields[1].id] === k)!;
  const field = (name: string) => db.fields.find((f) => f.name === name)!;
  // All assignees are members: a person property.
  assert.equal(field("Zuständig").type, "person");
  assert.equal(byKey("WEB-2").cells[field("Zuständig").id], owner.id);
  assert.deepEqual(byKey("WEB-2").cells[field("Labels").id], ["auth", "mail"]);
  assert.equal(byKey("WEB-2").cells[field("Story Points").id], 3);
  assert.equal(byKey("WEB-1").cells[field("Erstellt").id], "2026-10-06");
  assert.equal(byKey("WEB-2").cells[field("Fällig").id], "2026-10-20");
  assert.deepEqual(byKey("WEB-2").cells[field("Übergeordnet").id], [byKey("WEB-1").id]);
  assert.match(String(byKey("WEB-2").content), /spec\.pdf<\/a>/);
  const comment = one<{ body: string }>("SELECT body FROM comments WHERE row_id=?", byKey("WEB-1").id)!;
  assert.equal(comment.body, "557058:x, 2026-10-06: Looks good");
  assert.ok(db.views.some((v) => v.type === "board"));
});

test("Trello JSON: lists, labels, checklists, comments", () => {
  const board = {
    name: "Marketing",
    lists: [{ id: "l1", name: "To do" }, { id: "l2", name: "Done" }],
    members: [{ id: "m1", fullName: "Someone Else" }],
    cards: [
      { id: "c1", name: "Newsletter", idList: "l1", desc: "**Draft** first", labels: [{ name: "Mail" }], idMembers: ["m1"], due: "2026-11-01T10:00:00.000Z", attachments: [{ name: "brief", url: "https://trello.com/1/brief" }] },
      { id: "c2", name: "Archived", idList: "l2", closed: true },
    ],
    checklists: [{ idCard: "c1", checkItems: [{ name: "Text", state: "complete" }, { name: "Images", state: "incomplete" }] }],
    actions: [{ type: "commentCard", date: "2026-10-01T08:00:00Z", data: { card: { id: "c1" }, text: "Go!" }, memberCreator: { fullName: "Someone Else" } }],
  };
  const result = importTracker(owner, wid, space, "trello", JSON.stringify(board));
  assert.equal(result.rows, 1);
  const db = database(result.pageId);
  const [card] = rows(result.pageId);
  const field = (name: string) => db.fields.find((f) => f.name === name)!;
  assert.equal(card.cells[field("Liste").id], "To do");
  assert.equal(field("Mitglieder").type, "text");
  assert.equal(card.cells[field("Mitglieder").id], "Someone Else");
  assert.deepEqual(card.cells[field("Checkliste").id], [{ text: "Text", done: true }, { text: "Images", done: false }]);
  assert.match(String(card.content), /<strong>Draft<\/strong>/);
  assert.equal(all("SELECT 1 FROM comments WHERE row_id=?", card.id).length, 1);
  assert.throws(() => importTracker(owner, wid, space, "trello", "{}"), /Trello-Export/);
  assert.throws(() => importTracker(owner, wid, space, "jira", "a,b\n1,2"), /Jira-CSV/);
});
