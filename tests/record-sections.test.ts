// Sections of a record page's properties (#646): named groups in the
// database's record layout (database.recordLayout → sections), validated
// on the server, kept in the versions and carried by duplicates; deleting
// one moves its properties back to the top.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-record-sections-"));
const { id, run, all } = await import("../lib/db");
const { command, database, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const sections = await import("../lib/record-sections");
const { cleanRecordLayout, parseRecordLayout, orderRecordFields } = await import("../lib/record-layout");
const { commandOverlay } = await import("../lib/optimistic-commands");

const {
  recordArrangement,
  arrangementLayout,
  moveRecordProperty,
  stepRecordProperty,
  addRecordSection,
  renameRecordSection,
  removeRecordSection,
  moveRecordSection,
  newRecordSectionId,
  cleanRecordSections,
} = sections;

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const fields = [
  { id: "title", name: "Title", type: "text" },
  { id: "status", name: "Status", type: "select", options: ["Open", "Done"] },
  { id: "note", name: "Note", type: "text" },
  { id: "due", name: "Due", type: "date" },
  { id: "phone", name: "Phone", type: "text" },
];

test("the arrangement: properties in no section on top, then the sections", () => {
  assert.deepEqual(recordArrangement(fields, {}), { top: ["status", "note", "due", "phone"], sections: [] });
  const a = recordArrangement(fields, {
    order: ["phone", "due", "status", "note"],
    sections: [
      { id: "s1", name: "Contact", fields: ["phone", "gone", "title", "phone"] },
      { id: "s2", name: "Dates", fields: ["due", "phone"] },
    ],
  });
  // Unknown ids, the title and a property already in a section are left out.
  assert.deepEqual(a, {
    top: ["status", "note"],
    sections: [
      { id: "s1", name: "Contact", fields: ["phone"] },
      { id: "s2", name: "Dates", fields: ["due"] },
    ],
  });
  // The stored order lists everything as shown: top group, then sections.
  assert.deepEqual(arrangementLayout(a).order, ["status", "note", "phone", "due"]);
  assert.deepEqual(
    orderRecordFields(fields, arrangementLayout(a).order).map((f) => f.id),
    ["title", "status", "note", "phone", "due"],
  );
});

test("properties move into, within and out of sections", () => {
  let a = recordArrangement(fields, {});
  a = addRecordSection(a, "s1", "  Contact  ")!;
  assert.deepEqual(a.sections, [{ id: "s1", name: "Contact", fields: [] }]);
  a = moveRecordProperty(a, "phone", { section: "s1", place: "end" })!;
  a = moveRecordProperty(a, "note", { section: "s1", place: "start" })!;
  assert.deepEqual(a, { top: ["status", "due"], sections: [{ id: "s1", name: "Contact", fields: ["note", "phone"] }] });
  // Before or after another property, in its group.
  a = moveRecordProperty(a, "due", { target: "phone", place: "before" })!;
  assert.deepEqual(a.sections[0].fields, ["note", "due", "phone"]);
  a = moveRecordProperty(a, "note", { target: "status", place: "before" })!;
  assert.deepEqual(a.top, ["note", "status"]);
  // Nothing changes: null.
  assert.equal(moveRecordProperty(a, "note", { target: "status", place: "before" }), null);
  assert.equal(moveRecordProperty(a, "note", { target: "note", place: "after" }), null);
  assert.equal(moveRecordProperty(a, "gone", { section: null, place: "end" }), null);
  assert.equal(moveRecordProperty(a, "title", { section: null, place: "end" }), null);
  assert.equal(moveRecordProperty(a, "note", { section: "nope", place: "end" }), null);
  assert.equal(moveRecordProperty(a, "note", { target: "gone", place: "after" }), null);
});

test("a step crosses the edge of a section and passes over properties not shown", () => {
  let a = { top: ["status", "note"], sections: [{ id: "s1", name: "A", fields: ["due", "phone"] }] };
  const all = new Set(["status", "note", "due", "phone"]);
  // Down from the end of the top group: the start of the section.
  a = stepRecordProperty(a, "note", 1, all)!;
  assert.deepEqual(a, { top: ["status"], sections: [{ id: "s1", name: "A", fields: ["note", "due", "phone"] }] });
  // Up from the start of the section: the end of the top group.
  a = stepRecordProperty(a, "note", -1, all)!;
  assert.deepEqual(a.top, ["status", "note"]);
  // Hidden "due" is passed over.
  const b = stepRecordProperty({ top: [], sections: [{ id: "s1", name: "A", fields: ["phone", "due", "note"] }] }, "phone", 1, new Set(["phone", "note"]))!;
  assert.deepEqual(b.sections[0].fields, ["due", "note", "phone"]);
  // At the very top or bottom: nothing.
  assert.equal(stepRecordProperty(a, "status", -1, all), null);
  assert.equal(stepRecordProperty(a, "phone", 1, all), null);
});

test("sections are added, renamed, moved and deleted without losing a property", () => {
  let a = { top: ["status"], sections: [{ id: "s1", name: "A", fields: ["note", "due"] }, { id: "s2", name: "B", fields: ["phone"] }] };
  assert.equal(addRecordSection(a, "s1", "Again"), null, "taken id");
  assert.equal(addRecordSection(a, "s 3", "Bad id"), null);
  assert.equal(addRecordSection(a, "s3", "   "), null);
  assert.equal(addRecordSection(a, "s3", "x".repeat(81)), null);
  assert.equal(addRecordSection(a, "s3", "Line\nbreak"), null);
  assert.equal(renameRecordSection(a, "s1", "A"), null);
  assert.equal(renameRecordSection(a, "nope", "C"), null);
  a = renameRecordSection(a, "s1", " Details ")!;
  assert.equal(a.sections[0].name, "Details");
  a = moveRecordSection(a, "s2", 0)!;
  assert.deepEqual(a.sections.map((s) => s.id), ["s2", "s1"]);
  assert.equal(moveRecordSection(a, "s2", 0), null);
  assert.equal(moveRecordSection(a, "s2", 5), null);
  a = removeRecordSection(a, "s1")!;
  assert.deepEqual(a, { top: ["status", "note", "due"], sections: [{ id: "s2", name: "B", fields: ["phone"] }] });
  assert.equal(removeRecordSection(a, "s1"), null);
  // Thirty at most.
  let many = { top: [], sections: [] } as { top: string[]; sections: { id: string; name: string; fields: string[] }[] };
  for (let i = 0; i < 30; i++) many = addRecordSection(many, `s${i}`, `S${i}`)!;
  assert.equal(addRecordSection(many, "s30", "One too many"), null);
  const fresh = newRecordSectionId(many.sections);
  assert.match(fresh, /^s_[a-z0-9]{10}$/);
});

test("cleaning keeps known properties, each in one section, and drops empty lists", () => {
  assert.equal(cleanRecordSections(undefined, fields), undefined);
  assert.equal(cleanRecordSections([], fields), undefined);
  assert.deepEqual(
    cleanRecordSections(
      [
        { id: "s1", name: "A", fields: ["title", "note", "gone", "note"] },
        { id: "s2", name: "B", fields: ["note", "due"] },
        { id: "s3", name: "Empty", fields: [] },
      ],
      fields,
    ),
    [
      { id: "s1", name: "A", fields: ["note"] },
      { id: "s2", name: "B", fields: ["due"] },
      { id: "s3", name: "Empty", fields: [] },
    ],
  );
  const layout = cleanRecordLayout(parseRecordLayout({ sections: [] }), fields);
  assert.equal("sections" in layout, false);
  // A stored layout of an older version reads as before.
  assert.equal(parseRecordLayout('{"order":["due"]}').sections, undefined);
});

const me = await user("me"),
  reader = await user("reader");
const wid = await createWorkspace(me.id, "Sections"),
  boot = await bootstrap(me, wid);
await run("INSERT INTO members VALUES(?,?,?)", wid, reader.id, "viewer");
const act = async (body: Record<string, unknown>): Promise<any> => await command(me, body);
const pageId = (await act({ action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, kind: "database", title: "Clients" })).id as string;
await act({ action: "database.update", pageId, version: (await database(pageId)).version, fields, views: (await database(pageId)).views });
const layout = async () => (await database(pageId)).recordLayout!;

test("the server validates and cleans the sections; readers cannot change them", async () => {
  const saved = await act({
    action: "database.recordLayout",
    pageId,
    layout: {
      ...(await layout()),
      order: ["status", "note", "phone", "due"],
      sections: [
        { id: "s_contact", name: "  Contact ", fields: ["phone", "gone", "title"] },
        { id: "s_dates", name: "Dates", fields: ["due", "phone"] },
      ],
    },
  });
  assert.deepEqual(saved.sections, [
    { id: "s_contact", name: "Contact", fields: ["phone"] },
    { id: "s_dates", name: "Dates", fields: ["due"] },
  ]);
  assert.deepEqual((await layout()).sections, saved.sections);
  const refuse = async (sections: unknown) =>
    await assert.rejects(async () => await act({ action: "database.recordLayout", pageId, layout: { ...(await layout()), sections } }));
  await refuse([{ id: "a", name: "A" }, { id: "a", name: "B" }]);
  await refuse([{ id: "bad id", name: "A" }]);
  await refuse([{ id: "a", name: "" }]);
  await refuse([{ id: "a", name: "   " }]);
  await refuse([{ id: "a", name: "x".repeat(81) }]);
  await refuse([{ id: "a", name: "Two\nlines" }]);
  await refuse(Array.from({ length: 31 }, (_, i) => ({ id: `s${i}`, name: `S${i}` })));
  await refuse("Contact");
  await assert.rejects(
    async () => await command(reader, { action: "database.recordLayout", pageId, layout: { ...(await layout()), sections: [] } }),
    (e: { status?: number }) => e.status === 403,
  );
  assert.deepEqual((await layout()).sections, saved.sections);
  // The layout's other settings stay as they were.
  assert.equal((await layout()).open, "center");
});

test("deleting a section brings its properties back to the top; a property removed leaves its section", async () => {
  const before = await layout();
  const next = arrangementLayout(removeRecordSection(recordArrangement(fields, before), "s_contact")!);
  const saved = await act({ action: "database.recordLayout", pageId, layout: { ...before, ...next } });
  assert.deepEqual(saved.sections, [{ id: "s_dates", name: "Dates", fields: ["due"] }]);
  assert.deepEqual(recordArrangement(fields, saved).top, ["status", "note", "phone"]);
  // The last section gone: none stored.
  const none = await act({ action: "database.recordLayout", pageId, layout: { ...saved, sections: [] } });
  assert.equal("sections" in none, false);
  assert.deepEqual(recordArrangement(fields, await layout()).top, ["status", "note", "phone", "due"]);
});

test("sections are kept in the versions and carried by a duplicate", async () => {
  await act({
    action: "database.recordLayout",
    pageId,
    layout: { ...(await layout()), sections: [{ id: "s_more", name: "More", fields: ["note"] }] },
  });
  await run("DELETE FROM snapshots WHERE page_id=?", pageId);
  await run("UPDATE pages SET updated_at='2000-01-01 00:00:00' WHERE id=?", pageId);
  await run("UPDATE rows SET updated_at='2000-01-01 00:00:00' WHERE page_id=?", pageId);
  await act({ action: "database.recordLayout", pageId, layout: { ...(await layout()), sections: [] } });
  const snapshots = await all<{ html: string }>("SELECT html FROM snapshots WHERE page_id=?", pageId);
  assert.deepEqual(snapshots.map((s) => JSON.parse(s.html).database.recordLayout.sections), [[{ id: "s_more", name: "More", fields: ["note"] }]]);
  await act({
    action: "database.recordLayout",
    pageId,
    layout: { ...(await layout()), sections: [{ id: "s_more", name: "More", fields: ["note"] }] },
  });
  const copy = (await act({ action: "page.duplicate", pageId })) as { id: string };
  assert.deepEqual((await database(copy.id)).recordLayout?.sections, [{ id: "s_more", name: "More", fields: ["note"] }]);
});

test("the optimistic layer shows new sections before the server answers", () => {
  const data = { page: { id: pageId }, database: { fields, views: [], version: 1, recordLayout: { open: "center", properties: "top", hideEmpty: false, hidden: [] } } } as any;
  const layoutNext = { ...data.database.recordLayout, sections: [{ id: "s1", name: "A", fields: ["note"] }] };
  const overlay = commandOverlay({ action: "database.recordLayout", pageId, layout: layoutNext }, { userId: me.id, userName: "me" });
  assert.deepEqual(overlay?.page?.(data).database?.recordLayout?.sections, layoutNext.sections);
});
