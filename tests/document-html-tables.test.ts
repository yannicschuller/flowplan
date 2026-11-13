// #256: wide tables in read-only views (published pages, feeds,
// presentations) scroll in a box of their own, as in the editor.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

const win = new Window({ url: "https://flowplan.test/" });
after(async () => {
  await win.happyDOM.close();
});
const { wrapTables } = await import("../lib/document-html");

const root = (html: string) => {
  const div = win.document.createElement("div");
  div.innerHTML = html;
  return div as unknown as HTMLElement;
};

test("read-only tables get the editor's scroll box, once", () => {
  const doc = root(
    "<p>Vorher</p><table><caption>Beschriftung</caption><tbody><tr><td><p>A</p><table><tbody><tr><td>innen</td></tr></tbody></table></td></tr></tbody></table><p>Danach</p>",
  );
  wrapTables(doc);
  const wrappers = doc.querySelectorAll(".tableWrapper");
  assert.equal(wrappers.length, 2);
  // In place, between the paragraphs; the caption stays the table's own.
  assert.deepEqual(
    [...doc.children].map((e) => `${e.tagName.toLowerCase()}${e.className ? `.${e.className}` : ""}`),
    ["p", "div.tableWrapper", "p"],
  );
  assert.equal(doc.children[1].firstElementChild?.tagName, "TABLE");
  assert.equal(doc.querySelector("table > caption")?.textContent, "Beschriftung");
  assert.equal(doc.querySelector("td .tableWrapper > table td")?.textContent, "innen");
  // A second run (the effect again on the same DOM) changes nothing.
  const before = doc.innerHTML;
  wrapTables(doc);
  assert.equal(doc.innerHTML, before);
});

test("linked databases on public pages keep their own scroll frame", () => {
  const doc = root('<div class="public-embed"><p class="public-embed-title">DB</p><table><tbody><tr><td>x</td></tr></tbody></table></div>');
  wrapTables(doc);
  assert.equal(doc.querySelectorAll(".tableWrapper").length, 0);
});
