import { test } from "node:test";
import assert from "node:assert/strict";
import { documentSchema } from "../lib/document-schema";
import { dropContainer } from "../lib/drop-container";

// The block tinted while dragging (#255): the one that receives the drop.
const schema = documentSchema();
const p = (text: string) => schema.nodes.paragraph.create(null, text ? schema.text(text) : undefined);
const item = (...nodes: import("@tiptap/pm/model").Node[]) => schema.nodes.listItem.create(null, nodes);

test("the drop container is the innermost list item, list, toggle, callout or column around the drop", () => {
  const list = schema.nodes.bulletList.create(null, [item(p("One")), item(p("Two"))]);
  const toggle = schema.nodes.toggle.create({ title: "Klappe" }, p("Drinnen"));
  const callout = schema.nodes.callout.create(null, p("Hinweis"));
  const doc = schema.nodes.doc.create(null, [p("Start"), list, toggle, callout, p("Ende")]);
  const listPos = p("Start").nodeSize;
  // At the top level: nothing to tint.
  assert.equal(dropContainer(doc, 0), null);
  assert.equal(dropContainer(doc, listPos), null);
  // Between the items: the list.
  const between = listPos + 1 + list.child(0).nodeSize;
  assert.equal(dropContainer(doc, between)?.node.type.name, "bulletList");
  assert.equal(dropContainer(doc, between)?.pos, listPos);
  // At the end of the first item (a child of it): the item.
  assert.equal(dropContainer(doc, between - 1)?.node.type.name, "listItem");
  // Inside the toggle and the callout.
  const togglePos = listPos + list.nodeSize;
  assert.equal(dropContainer(doc, togglePos + 1)?.node.type.name, "toggle");
  const calloutPos = togglePos + toggle.nodeSize;
  assert.equal(dropContainer(doc, calloutPos + 1)?.node.type.name, "callout");
  // In a column of a column layout.
  const columns = schema.nodes.columns.create(null, [schema.nodes.column.create(null, p("L")), schema.nodes.column.create(null, p("R"))]);
  const withColumns = schema.nodes.doc.create(null, [columns]);
  assert.equal(dropContainer(withColumns, 2)?.node.type.name, "column");
  assert.equal(dropContainer(withColumns, -1), null);
  assert.equal(dropContainer(withColumns, withColumns.content.size + 1), null);
});
