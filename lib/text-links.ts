// The links in the text of pages and records, kept as a table for the
// backlinks (lib/text-backlinks.ts, #383) instead of a LIKE over all HTML of
// the workspace on every page GET.
//
// text_links holds, per source, what its HTML points at: `p:<id>` for each
// "#page=<id>" in it, `r:<id>` for each "row=<id>" (a record link is
// "#page=<database>&amp;row=<record>"). A source is a page's document
// (page_id, row_id '') or a record's text (page_id '', row_id: its record
// document, else the legacy rows.content) – the same HTML the scan read.
//
// Triggers (lib/db.ts, schema 107) only mark changed sources in
// text_link_dirty – whatever writes documents, records or record documents
// (saves, imports, templates, restores, older versions) – and drop the
// links of deleted ones; drainTextLinks() reads the marked sources again
// before backlinks are looked up. Schema 108's data step marks them all once.
import { all, one, run, transaction } from "./db";

// The characters of a page or record id (UUIDs); an id with others is
// looked up by the scan (lib/text-backlinks.ts).
export const LINK_ID = /^[A-Za-z0-9_-]+$/;
const PAGE_TOKEN = /#page=([A-Za-z0-9_-]+)/g;
const ROW_TOKEN = /row=([A-Za-z0-9_-]+)/g;

// What a piece of HTML links to, each target once.
export function linkTargets(html: string): string[] {
  const targets = new Set<string>();
  if (html.includes("#page=")) for (const m of html.matchAll(PAGE_TOKEN)) targets.add(`p:${m[1]}`);
  if (html.includes("row=")) for (const m of html.matchAll(ROW_TOKEN)) targets.add(`r:${m[1]}`);
  return [...targets];
}

const BATCH = 200;
// Reads the marked sources again: the table is current afterwards. Cheap
// when nothing is marked (one indexed read, no write).
export async function drainTextLinks() {
  for (;;) {
    if (!(await one("SELECT 1 AS dirty FROM text_link_dirty LIMIT 1"))) return;
    await transaction(async () => {
      for (const source of await all<{ page_id: string; row_id: string }>(
        "SELECT page_id,row_id FROM text_link_dirty ORDER BY page_id,row_id LIMIT ?",
        BATCH,
      )) {
        // The mark goes first: a change that comes in meanwhile marks the
        // source again (PostgreSQL: another instance's save).
        await run("DELETE FROM text_link_dirty WHERE page_id=? AND row_id=?", source.page_id, source.row_id);
        await run("DELETE FROM text_links WHERE page_id=? AND row_id=?", source.page_id, source.row_id);
        const html = source.row_id
          ? (await one<{ html: string }>(
              "SELECT COALESCE(rd.html,r.content,'') html FROM rows r LEFT JOIN row_documents rd ON rd.row_id=r.id WHERE r.id=?",
              source.row_id,
            ))?.html
          : (await one<{ html: string | null }>("SELECT html FROM documents WHERE page_id=?", source.page_id))?.html;
        for (const target of linkTargets(html || ""))
          await run(
            "INSERT INTO text_links(page_id,row_id,target) VALUES(?,?,?) ON CONFLICT DO NOTHING",
            source.page_id,
            source.row_id,
            target,
          );
      }
    });
  }
}

// Schema 108's data step: every source once.
export async function markAllTextLinks() {
  await run("INSERT INTO text_link_dirty(page_id,row_id) SELECT page_id,'' FROM documents WHERE true ON CONFLICT DO NOTHING");
  await run("INSERT INTO text_link_dirty(page_id,row_id) SELECT '',id FROM rows WHERE COALESCE(content,'')<>'' ON CONFLICT DO NOTHING");
  await run("INSERT INTO text_link_dirty(page_id,row_id) SELECT '',row_id FROM row_documents WHERE true ON CONFLICT DO NOTHING");
}
