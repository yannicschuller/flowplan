// Private mode on whiteboards, in the browser's document (lib/whiteboard-
// private-mode.ts): which changes go under the private client, and that the
// shared sync never carries them.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import {
  installPrivateRouting,
  newClientId,
  privateItemCount,
  privateItemIds,
  privateUpdate,
  setPrivateRouting,
  sharedUpdate,
  updateClients,
  withoutClients,
} from "../lib/whiteboard-private-mode";

const LOCAL = "local";
function board() {
  const doc = new Y.Doc();
  const items = doc.getMap<Y.Map<unknown>>("items");
  installPrivateRouting(doc, items);
  const undo = new Y.UndoManager(items, { trackedOrigins: new Set([LOCAL]), captureTimeout: 0 });
  const add = (props: Record<string, unknown>) => {
    const id = crypto.randomUUID();
    const map = new Y.Map<unknown>();
    for (const [k, v] of Object.entries(props)) map.set(k, v);
    doc.transact(() => items.set(id, map), LOCAL);
    return id;
  };
  const set = (id: string, props: Record<string, unknown>) =>
    doc.transact(() => {
      for (const [k, v] of Object.entries(props)) items.get(id)!.set(k, v);
    }, LOCAL);
  return { doc, items, undo, add, set };
}
const textOf = (update: Uint8Array) => Buffer.from(update).toString("latin1");
// What another person's browser sees after applying only shared changes.
function observer(...updates: Uint8Array[]) {
  const doc = new Y.Doc();
  for (const u of updates) Y.applyUpdate(doc, u);
  return doc;
}

test("new items in the private area and every change to them go under the private client", () => {
  const a = board();
  const shared = a.add({ type: "sticky", x: 0, y: 0, w: 100, h: 100, text: "Agenda" });
  const client = newClientId(a.doc);
  setPrivateRouting(a.doc, { client, area: () => ({ x: 500, y: 0, w: 1000, h: 1000 }) });
  const inside = a.add({ type: "sticky", x: 600, y: 100, w: 100, h: 100, text: "Geheime Idee" });
  const outside = a.add({ type: "sticky", x: -400, y: 0, w: 100, h: 100, text: "Öffentlich" });
  a.set(inside, { text: "Geheime Idee, überarbeitet", x: 700 });
  // Nested types inside a private item (stamps, comments) stay private too.
  a.doc.transact(() => {
    const stamps = new Y.Map<string>();
    a.items.get(inside)!.set("stamps", stamps);
    stamps.set("me", "🔥");
  }, LOCAL);
  a.doc.transact(() => {
    const list = new Y.Array<unknown>();
    a.items.get(inside)!.set("messages", list);
    list.push([{ id: "m", text: "Privater Kommentar" }]);
  }, LOCAL);
  // Shared items keep being shared, even edited in the same step.
  a.doc.transact(() => {
    a.items.get(shared)!.set("x", 40);
    a.items.get(inside)!.set("y", 140);
  }, LOCAL);

  assert.deepEqual(privateItemIds(a.doc, a.items), [inside]);
  const out = sharedUpdate(a.doc, null);
  assert.ok(!updateClients(out).has(client));
  assert.doesNotMatch(textOf(out), /Geheime|Privater|🔥/);
  const b = observer(out);
  assert.equal(b.store.pendingStructs, null, "the shared changes apply without anything private");
  const seen = b.getMap<Y.Map<unknown>>("items");
  assert.equal(seen.get(shared)?.get("x"), 40);
  assert.equal(seen.get(outside)?.get("text"), "Öffentlich");
  assert.equal(seen.has(inside), false);

  // The private changes, merged in ("Aufdecken"), bring the item complete.
  const priv = privateUpdate(a.doc, [client], new Map());
  assert.deepEqual([...updateClients(priv)], [client]);
  assert.equal(privateItemCount(priv), 1);
  Y.applyUpdate(b, priv);
  assert.equal(b.store.pendingStructs, null);
  const revealed = seen.get(inside)!.toJSON();
  assert.equal(revealed.text, "Geheime Idee, überarbeitet");
  assert.equal(revealed.y, 140);
  assert.deepEqual(revealed.stamps, { me: "🔥" });
  assert.equal(revealed.messages[0].text, "Privater Kommentar");
});

test("undo of private changes stays private; a shared key last written privately stays private", () => {
  const a = board();
  const shared = a.add({ type: "sticky", x: 0, y: 0, w: 100, h: 100, text: "Geteilt" });
  const before = sharedUpdate(a.doc, null);
  const client = newClientId(a.doc);
  setPrivateRouting(a.doc, { client });
  const mine = a.add({ type: "sticky", x: 10, y: 10, w: 100, h: 100, text: "Entwurf" });
  a.set(mine, { text: "Entwurf 2" });
  a.undo.undo(); // back to "Entwurf": restored under the private client
  assert.equal(a.items.get(mine)!.get("text"), "Entwurf");
  a.undo.undo(); // the item goes again
  a.undo.redo(); // and comes back – privately
  assert.equal(a.items.get(mine)?.get("text"), "Entwurf");
  // One step that moved a shared and a private item: undone privately as a
  // whole; later edits of that property follow (they refer to it).
  a.doc.transact(() => {
    a.items.get(shared)!.set("x", 300);
    a.items.get(mine)!.set("x", 300);
  }, LOCAL);
  a.undo.undo();
  a.set(shared, { x: 77 });
  a.set(shared, { text: "Geteilt, neu" });

  const out = sharedUpdate(a.doc, Y.encodeStateVectorFromUpdate(before));
  assert.ok(!updateClients(out).has(client));
  assert.doesNotMatch(textOf(out), /Entwurf/);
  const b = observer(before, out);
  assert.equal(b.store.pendingStructs, null, "no shared change waits for a private one");
  assert.equal(b.getMap<Y.Map<unknown>>("items").get(shared)!.get("text"), "Geteilt, neu");
  // After revealing, everything agrees.
  Y.applyUpdate(b, privateUpdate(a.doc, [client], new Map()));
  assert.deepEqual(b.getMap("items").toJSON(), a.items.toJSON());
});

test("private mode ends: changes are shared again, earlier private ones stay where they are", () => {
  const a = board();
  const client = newClientId(a.doc);
  setPrivateRouting(a.doc, { client });
  const mine = a.add({ type: "sticky", x: 0, y: 0, w: 10, h: 10, text: "Idee" });
  const priv = privateUpdate(a.doc, [client], new Map());
  setPrivateRouting(a.doc, { client: null });
  assert.deepEqual(privateItemIds(a.doc, a.items), []);
  a.set(mine, { text: "Idee (aufgedeckt)" });
  const out = sharedUpdate(a.doc, null);
  const b = observer(priv, out);
  assert.equal(b.store.pendingStructs, null);
  assert.equal(b.getMap<Y.Map<unknown>>("items").get(mine)!.get("text"), "Idee (aufgedeckt)");
});

test("the server strips changes of private clients from a shared update", () => {
  const a = board();
  a.add({ type: "sticky", x: 0, y: 0, w: 10, h: 10, text: "Offen" });
  const client = newClientId(a.doc);
  setPrivateRouting(a.doc, { client });
  a.add({ type: "sticky", x: 0, y: 0, w: 10, h: 10, text: "Verdeckt" });
  // A client that sends everything (an older version, a mistake): the
  // server removes what belongs to a private client.
  const everything = Y.encodeStateAsUpdate(a.doc);
  assert.ok(updateClients(everything).has(client));
  const stripped = withoutClients(everything, [client]);
  assert.ok(!updateClients(stripped).has(client));
  assert.doesNotMatch(textOf(stripped), /Verdeckt/);
  assert.match(textOf(stripped), /Offen/);
});
