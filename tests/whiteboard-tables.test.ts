import { test } from "node:test";
import assert from "node:assert/strict";
import { cellFill, cellLink, cellParts, isHeadCell, keptLinks, setFill, soleUrl, tableOwnColors, tablePageLinks, trimFills } from "../lib/whiteboard-tables";
import { boardEmbed, withValidExtras } from "../lib/whiteboard-embeds";
import { whiteboardSvg } from "../lib/whiteboard-svg";
import { previewCard } from "../lib/oembed";
import { cleanTemplateItems } from "../lib/whiteboard-user-templates";
import type { WhiteboardItem } from "../lib/whiteboard-model";

// #455: colours of rows and columns, header column, links in cells, link cards.

test("rows go before columns, header cells keep their grey without a colour", () => {
  const table = { cells: [["a", "b"], ["c", "d"]], header: true, headerCol: true, rowFills: ["", "#FFE3E3"], colFills: ["#d3f9d8"] };
  assert.equal(cellFill(table, 0, 0), "#d3f9d8");
  assert.equal(cellFill(table, 1, 0), "#ffe3e3");
  assert.equal(cellFill(table, 0, 1), null);
  assert.equal(isHeadCell(table, 0, 1), true);
  assert.equal(isHeadCell(table, 1, 0), true);
  assert.equal(isHeadCell(table, 1, 1), false);
  assert.equal(isHeadCell({ header: false }, 0, 1), false);
  // Anything else than #rrggbb is no colour.
  assert.equal(cellFill({ rowFills: ["red;background:url(x)"] }, 0, 0), null);
});

test("setting and trimming fills keeps the lists short", () => {
  assert.deepEqual(setFill(undefined, 2, "#E5DBFF", 4), ["", "", "#e5dbff"]);
  assert.equal(setFill(["#e5dbff"], 0, "", 3), undefined);
  assert.equal(setFill(["#e5dbff"], 0, "transparent", 3), undefined);
  assert.deepEqual(trimFills(["#ffffff", "", "#e5dbff"], 2), ["#ffffff"]);
  assert.deepEqual(trimFills(["#ffffff", "bogus"], 5), ["#ffffff"]);
});

test("web addresses in cells become links, http and https only", () => {
  assert.deepEqual(cellParts("see https://example.org/a?b=1. and more"), [
    { text: "see " },
    { text: "https://example.org/a?b=1", href: "https://example.org/a?b=1" },
    { text: ". and more" },
  ]);
  assert.deepEqual(cellParts("(https://en.wikipedia.org/wiki/Foo_(bar))"), [
    { text: "(" },
    { text: "https://en.wikipedia.org/wiki/Foo_(bar)", href: "https://en.wikipedia.org/wiki/Foo_(bar)" },
    { text: ")" },
  ]);
  for (const bad of ["javascript:alert(1)", "data:text/html,x", "ftp://example.org", "https://user:pw@example.org/"])
    assert.ok(cellParts(bad).every((p) => !p.href), bad);
  assert.equal(soleUrl("  https://example.org/x  "), "https://example.org/x");
  assert.equal(soleUrl("https://example.org/x and text"), null);
});

test("a lone address: player with its kept still picture, or a page with its kept preview", () => {
  // The still picture is a file of the board, kept like a preview (never
  // loaded from YouTube while the board is viewed).
  assert.deepEqual(cellLink("https://youtu.be/dQw4w9WgXcQ"), { kind: "player", url: "https://youtu.be/dQw4w9WgXcQ", provider: "YouTube" });
  assert.deepEqual(cellLink("https://youtu.be/dQw4w9WgXcQ", { "https://youtu.be/dQw4w9WgXcQ": { title: "YouTube", site: "YouTube", image: "/api/files/still" } }), {
    kind: "player",
    url: "https://youtu.be/dQw4w9WgXcQ",
    provider: "YouTube",
    thumbnail: "/api/files/still",
  });
  const preview = { title: "Beispiel", site: "example.org" };
  assert.deepEqual(cellLink("https://example.org/", { "https://example.org/": preview }), { kind: "page", url: "https://example.org/", preview });
  const table = { cells: [["https://example.org/", "https://youtu.be/dQw4w9WgXcQ"], ["text https://a.example/", ""]] };
  assert.deepEqual(tablePageLinks(table), ["https://example.org/", "https://youtu.be/dQw4w9WgXcQ"]);
  assert.deepEqual(keptLinks({ ...table, links: { "https://example.org/": preview, "https://gone.example/": preview } }), { "https://example.org/": preview });
});

test("stored table colours and previews are checked, wrong values dropped", () => {
  const item = withValidExtras({
    type: "table",
    headerCol: true,
    rowFills: ["#ffe3e3", ""],
    colFills: ["url(javascript:x)"],
    links: { "https://example.org/": { title: "T", site: "S", image: "http://insecure.example/i.png" } },
  } as unknown as Partial<WhiteboardItem>);
  assert.equal(item.headerCol, true);
  assert.deepEqual(item.rowFills, ["#ffe3e3", ""]);
  assert.equal(item.colFills, undefined);
  // An insecure picture is left out, the preview stays.
  assert.deepEqual(item.links, { "https://example.org/": { title: "T", site: "S" } });
  const bad = withValidExtras({ type: "table", links: { "javascript:alert(1)": { title: "x", site: "y" } } } as unknown as Partial<WhiteboardItem>);
  assert.equal(bad.links, undefined);
});

test("link cards are embeds without src, with a web address", () => {
  assert.deepEqual(boardEmbed({ type: "embed", url: "https://example.org/a", preview: { title: "A", site: "Beispiel" } }), {
    kind: "link",
    url: "https://example.org/a",
    provider: "Beispiel",
  });
  assert.equal(boardEmbed({ type: "embed", url: "javascript:alert(1)" })?.kind, undefined);
  assert.equal(boardEmbed({ type: "embed", src: "https://evil.example/frame", url: "https://example.org/" }), null);
  // Templates keep them.
  const [card] = cleanTemplateItems([{ id: "c", type: "embed", x: 0, y: 0, w: 340, h: 120, url: "https://example.org/a", preview: { title: "A", site: "B" } }]);
  assert.deepEqual(card.preview, { title: "A", site: "B" });
});

test("the server's SVG shows table colours, cell links and link cards", () => {
  const ctx = { image: () => null, page: () => null, record: () => null, label: (de: string) => de };
  const svg = whiteboardSvg(
    [
      { id: "t", type: "table", x: 0, y: 0, w: 300, h: 100, z: 1, cells: [["Name", "Link"], ["Ada", "https://example.org/<x>"]], rowFills: ["", "#ffe3e3"], colFills: ["#d3f9d8"], headerCol: true },
      { id: "l", type: "embed", x: 0, y: 200, w: 340, h: 120, z: 2, url: "https://example.org/a", preview: { title: "Titel <b>", site: "Beispiel", description: "Text" } },
    ] as WhiteboardItem[],
    ctx,
  )!;
  assert.match(svg, /<div class="wb-cell head" style="background:#d3f9d8">Name<\/div>/);
  assert.match(svg, /<div class="wb-cell head" style="background:#ffe3e3">Ada<\/div>/);
  assert.match(svg, /<a href="https:\/\/example.org\/">https:\/\/example.org\/<\/a>&lt;x&gt;/);
  assert.match(svg, /<a href="https:\/\/example.org\/a"[^>]*>Titel &lt;b&gt;<\/a>/);
});

test("link card previews name the site's icon", () => {
  const card = previewCard('<head><title>T</title><link rel="icon" href="https://cdn.example.org/i.svg"></head>', "https://example.org/");
  assert.equal(card.kind === "card" && card.icon, "https://cdn.example.org/i.svg");
  const none = previewCard('<head><title>T</title><link rel="icon" href="data:image/png;base64,AAAA"></head>', "https://example.org/");
  assert.equal(none.kind === "card" && none.icon, "");
});

test("colours from the colour wheel are the table's own colours while used", () => {
  const palette = ["transparent", "#ffffff", "#ffe3e3"];
  assert.deepEqual(tableOwnColors({}, ["#ffe3e3", "#12AB34"], undefined, palette), ["#12ab34"]);
  assert.deepEqual(tableOwnColors({ ownColors: ["#12ab34"] }, ["", "#12ab34"], ["#0000ff"], palette), ["#0000ff", "#12ab34"]);
  assert.equal(tableOwnColors({ ownColors: ["#12ab34"] }, undefined, undefined, palette), undefined);
});
