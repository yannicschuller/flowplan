// Seeds the flashcard decks for the README's "Learn with flashcards"
// screenshots (after seed.mjs, against the same instance): a cloze deck
// "Cell biology", the "Vocabulary" starter as "Spanish A1", the image
// occlusion card of the "Flashcards" starter as "Inner planets", and three
// weeks of reviews (offline ratings with their own time), so #study shows
// a streak, a forecast and due cards. Writes study-ids.json to MEDIA_DIR.
//
//   MEDIA_URL=http://127.0.0.1:3583 node scripts/readme-media/study.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, context, cmd, get, DIR } from "./lib.mjs";

const ids = JSON.parse(readFileSync(join(DIR, "ids.json"), "utf8"));
const browser = await launch();
const ctx = await context(browser, { who: "mia" });
const page = await ctx.newPage();
const zone = "Europe/Berlin";
const icon = (pageId, icon) => cmd(page, { action: "page.update", pageId, patch: { icon } });
const starter = async (title, key, ic) => {
  const { id } = await cmd(page, { action: "page.create", workspaceId: ids.wid, spaceId: ids.sid, kind: "database", title, starterTemplate: key });
  await icon(id, ic);
  return id;
};

// ---- Cell biology: clozes in a text property ---------------------------------
const cells = (await cmd(page, { action: "page.create", workspaceId: ids.wid, spaceId: ids.sid, title: "Cell biology", kind: "database" })).id;
await icon(cells, "🧬");
{
  const fields = [
    { id: "title", name: "Card", type: "text" },
    { id: "extra", name: "Note", type: "text" },
    { id: "topic", name: "Topic", type: "select", options: ["Organelles", "Membrane", "Genetics"] },
  ];
  const views = [
    { id: "study", name: "Study", type: "study", filters: [], sorts: [] },
    { id: "table", name: "All cards", type: "table", filters: [], sorts: [] },
  ];
  const pd = await get(page, "pages/" + cells);
  await cmd(page, { action: "database.update", pageId: cells, version: pd.database.version, fields, views });
  await cmd(page, { action: "study.settings", pageId: cells, settings: { version: 1, type: { fixed: "cloze" }, front: { field: "title" }, back: { field: "extra" }, retention: 0.9 } });
  const rows = [
    ["The {{c1::mitochondrion}} produces most of the cell's ATP through {{c2::oxidative phosphorylation}}.", "Often called the powerhouse of the cell.", "Organelles"],
    ["Proteins are assembled by {{c1::ribosomes}}, free in the cytoplasm or on the {{c2::rough ER}}.", "", "Organelles"],
    ["The {{c1::Golgi apparatus}} modifies, sorts and packages proteins for transport.", "", "Organelles"],
    ["{{c1::Lysosomes}} break down waste with digestive enzymes.", "", "Organelles"],
    ["The cell membrane is a {{c1::phospholipid bilayer}} with embedded proteins.", "Fluid mosaic model", "Membrane"],
    ["Water crosses the membrane by {{c1::osmosis}}, often through {{c2::aquaporins}}.", "", "Membrane"],
    ["The {{c1::sodium–potassium pump}} moves 3 Na⁺ out and 2 K⁺ in per ATP.", "", "Membrane"],
    ["DNA is transcribed into {{c1::mRNA}} in the {{c2::nucleus}}.", "", "Genetics"],
    ["A codon is a sequence of {{c1::three}} nucleotides.", "", "Genetics"],
    ["{{c1::Mitosis}} gives two identical daughter cells, {{c2::meiosis}} four haploid ones.", "", "Genetics"],
  ];
  for (const [title, extra, topic] of rows) await cmd(page, { action: "row.create", pageId: cells, cells: { title, extra, topic } });
}

// ---- Spanish A1 and Inner planets: from the starter templates -----------------
const spanish = await starter("Spanish A1", "vocabulary", "🇪🇸");
const planets = await starter("Inner planets", "flashcards", "🪐");
{
  // Only the image occlusion record stays.
  const pd = await get(page, "pages/" + planets);
  for (const row of pd.rows ?? []) if (row.cells?.type !== "Image occlusion") await cmd(page, { action: "row.delete", pageId: planets, rowId: row.id });
}

// ---- Three weeks of reviews ----------------------------------------------------
// Ratings with their own time (as from a device that was offline): every
// card's ratings in order, a few cards a day, mostly "Good".
// Sent in one batch like the offline queue of the app (study.reviews).
const DAY = 86_400_000;
const start = Date.now() - 21 * DAY;
const reviews = [];
for (const [deck, perDay] of [
  [cells, 4],
  [spanish, 3],
]) {
  const q = await cmd(page, { action: "study.queue", pageId: deck, zone, limit: 50 });
  const cards = q.cards;
  let n = 0;
  for (let day = 0; day <= 20; day++) {
    if (day % 7 === 5) continue; // a day off now and then
    for (let k = 0; k < perDay; k++) {
      const card = cards[n++ % cards.length];
      const reviewedAt = start + day * DAY + (17 + k) * 3_600_000;
      const rating = (n + day) % 9 === 0 ? 1 : (n + day) % 5 === 0 ? 4 : 3;
      reviews.push({ id: crypto.randomUUID(), pageId: deck, rowId: card.rowId, sub: card.sub, rating, reviewedAt, zone });
    }
  }
}
reviews.sort((a, b) => a.reviewedAt - b.reviewedAt);
for (let i = 0; i < reviews.length; i += 100) await cmd(page, { action: "study.reviews", reviews: reviews.slice(i, i + 100), source: "web" });

writeFileSync(join(DIR, "study-ids.json"), JSON.stringify({ cells, spanish, planets }, null, 1));
console.log("study decks", { cells, spanish, planets });
await browser.close();
