import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-wb-cards-"));
const { id, run, one } = await import("../lib/db");
const { command, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { whiteboardRowCards } = await import("../lib/whiteboard-cards");
const { displayText } = await import("../lib/field-format");

function user(name: string): Identity {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.com`);
  return { id: uid, name, email: `${name}@example.com`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = user("owner"),
  wid = createWorkspace(owner.id, "Cards"),
  boot = bootstrap(owner, wid);
const act = (body: Record<string, unknown>): any => command(owner, body);

test("record cards send dates and numbers raw, for the reader's language", () => {
  const page = act({ action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, title: "Projects", kind: "database" }).id as string;
  const version = one<{ version: number }>("SELECT version FROM databases WHERE page_id=?", page)!.version;
  const views = JSON.parse(one<{ views: string }>("SELECT views FROM databases WHERE page_id=?", page)!.views);
  act({
    action: "database.update",
    pageId: page,
    version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "due", name: "Due", type: "date" },
      { id: "budget", name: "Budget", type: "number", format: "eur" },
      { id: "state", name: "State", type: "select", options: ["Open"] },
    ],
    views,
  });
  const named = act({ action: "row.create", pageId: page, cells: { title: "Launch", due: "2026-10-20", budget: 1234.5, state: "Open" } }).id as string;
  const untitled = act({ action: "row.create", pageId: page, cells: { due: "2026-10-21" } }).id as string;

  const cards = whiteboardRowCards(owner, [
    { pageId: page, rowId: named },
    { pageId: page, rowId: untitled },
  ]);
  const card = cards[named];
  assert.equal(card.title, "Launch");
  assert.equal(card.database, "Projects");
  const due = card.props.find((p) => p.name === "Due")!;
  assert.equal(due.raw, "2026-10-20");
  assert.equal(due.format?.type, "date");
  // No server-side German: the browser formats it ("20 Oct 2026" in English).
  assert.doesNotMatch(due.value, /Okt/);
  const budget = card.props.find((p) => p.name === "Budget")!;
  assert.equal(budget.raw, 1234.5);
  assert.equal(budget.format?.format, "eur");
  assert.ok(displayText(budget.format!, budget.raw).includes("1"));
  assert.deepEqual(card.props.find((p) => p.name === "State"), { name: "State", value: "Open" });
  // An empty title stays empty; the card says "Untitled" in the reader's language.
  assert.equal(cards[untitled].title, "");
});
