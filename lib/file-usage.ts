// Which uploads are still used (#164): a file counts as used while its id
// appears anywhere in the current content of its workspace – documents and
// synced blocks, records (properties, icons, covers, texts, record
// documents), records in the trash, comments and text comments, whiteboards
// (also private mode), notebook backgrounds, page icons and covers, page
// properties, database settings, dashboards and start pages. Any form counts:
// /api/files/<id>, a share link's /api/share/<token>/files/<id>, an absolute
// address, or a bare id ({"file":"<id>"} of a notebook sheet). Version
// history does not count: restoring a version whose file was deleted shows
// the image as missing. Pages in the trash still count (they may come back).
import { all } from "./db";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

// Text sources per workspace (one parameter: the workspace id).
const TEXT_SOURCES = [
  "SELECT COALESCE(icon,'')||' '||COALESCE(cover,'') t FROM pages WHERE workspace_id=?",
  "SELECT d.html t FROM documents d JOIN pages p ON p.id=d.page_id WHERE p.workspace_id=?",
  "SELECT r.cells||' '||COALESCE(r.icon,'')||' '||COALESCE(r.cover,'')||' '||COALESCE(r.content,'') t FROM rows r JOIN pages p ON p.id=r.page_id WHERE p.workspace_id=?",
  "SELECT d.html t FROM row_documents d JOIN rows r ON r.id=d.row_id JOIN pages p ON p.id=r.page_id WHERE p.workspace_id=?",
  "SELECT payload t FROM row_trash WHERE workspace_id=?",
  "SELECT c.body t FROM comments c JOIN pages p ON p.id=c.page_id WHERE p.workspace_id=?",
  "SELECT m.body t FROM inline_messages m JOIN inline_threads h ON h.id=m.thread_id JOIN pages p ON p.id=h.page_id WHERE p.workspace_id=? AND m.deleted=0",
  "SELECT s.background t FROM notebook_sheets s JOIN pages p ON p.id=s.page_id WHERE p.workspace_id=? AND s.background IS NOT NULL",
  "SELECT v.value t FROM page_property_values v JOIN pages p ON p.id=v.page_id WHERE p.workspace_id=?",
  "SELECT d.fields||' '||d.views t FROM databases d JOIN pages p ON p.id=d.page_id WHERE p.workspace_id=?",
  "SELECT x.tiles t FROM dashboards x JOIN pages p ON p.id=x.page_id WHERE p.workspace_id=?",
  "SELECT layout t FROM home_layouts WHERE workspace_id=?",
  "SELECT layout t FROM home_defaults WHERE workspace_id=?",
  "SELECT icon t FROM workspaces WHERE id=?",
];
// Yjs states: strings sit in them as UTF-8, ids are ASCII.
const STATE_SOURCES = [
  "SELECT w.state s FROM whiteboards w JOIN pages p ON p.id=w.page_id WHERE p.workspace_id=?",
  "SELECT x.state s FROM whiteboard_private_parts x JOIN whiteboard_private w ON w.id=x.session_id JOIN pages p ON p.id=w.page_id WHERE p.workspace_id=? AND x.state IS NOT NULL",
];

// The ids among `candidates` that the workspace's content refers to.
export function usedFileIds(workspaceId: string, candidates: Iterable<string>): Set<string> {
  const wanted = new Set([...candidates].map((c) => c.toLowerCase()));
  const used = new Set<string>();
  if (!wanted.size) return used;
  const scan = (text: string | null | undefined) => {
    if (!text) return;
    for (const match of text.matchAll(UUID)) {
      const fid = match[0].toLowerCase();
      if (wanted.has(fid)) used.add(fid);
    }
  };
  const done = () => used.size === wanted.size;
  for (const sql of TEXT_SOURCES) {
    if (done()) return used;
    let rows: { t: string | null }[] = [];
    try {
      rows = all<{ t: string | null }>(sql, workspaceId);
    } catch {
      // A table of an optional feature that is missing: nothing to read.
      continue;
    }
    for (const row of rows) scan(row.t);
  }
  for (const sql of STATE_SOURCES) {
    if (done()) return used;
    let rows: { s: Uint8Array | null }[] = [];
    try {
      rows = all<{ s: Uint8Array | null }>(sql, workspaceId);
    } catch {
      continue;
    }
    for (const row of rows) if (row.s) scan(Buffer.from(row.s).toString("latin1"));
  }
  return used;
}
