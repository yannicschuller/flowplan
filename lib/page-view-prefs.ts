// How a person looks at a page, stored in their account (schema 83, table
// page_view_prefs) and therefore the same on all their devices – unlike the
// folded headings (lib/heading-folds.ts), which stay on the device.
//
// Whether the bar with tags and properties under the title is collapsed
// (#83). NULL (or no row) means the person never chose; then the default of
// lib/page-properties.ts isBarCollapsed applies.
//
// On a database page (#186, schema 99): whether the properties of its
// records are folded – one choice for all records of the database,
// separately for phones and larger screens (record_properties_phone /
// _desktop; the default: lib/record-properties.ts isRecordFolded).
// Looking is not changing: anyone who may open the page may choose, and the
// choice is nobody else's business (no notification, no version, no event).
import { z } from "zod";
import { one, run } from "./db";
import { requirePage } from "./permissions";
import { HttpError } from "./auth";
import type { Identity } from "./types";

// The person's choice for the page's property bar (null: none yet).
export async function propertiesCollapsed(user: Pick<Identity, "id">, pageId: string): Promise<boolean | null> {
  const row = await one<{ properties_collapsed: number | null }>(
    "SELECT properties_collapsed FROM page_view_prefs WHERE user_id=? AND page_id=?",
    user.id,
    pageId,
  );
  return row && row.properties_collapsed !== null ? row.properties_collapsed === 1 : null;
}

const input = z.object({ pageId: z.string().uuid(), collapsed: z.boolean().nullable() });

// The command `page.collapseProperties`: { pageId, collapsed } – null
// forgets the choice (the default applies again).
export async function setPropertiesCollapsed(user: Identity, body: unknown): Promise<{ collapsed: boolean | null }> {
  const b = input.parse(body);
  const page = await requirePage(user, b.pageId);
  if (b.collapsed === null) await run("DELETE FROM page_view_prefs WHERE user_id=? AND page_id=?", user.id, page.id);
  else
    await run(
      `INSERT INTO page_view_prefs(user_id,page_id,properties_collapsed,updated_at) VALUES(?,?,?,?)
       ON CONFLICT(user_id,page_id) DO UPDATE SET properties_collapsed=excluded.properties_collapsed,updated_at=excluded.updated_at`,
      user.id,
      page.id,
      b.collapsed ? 1 : 0,
      Date.now(),
    );
  return { collapsed: b.collapsed };
}

// The person's choices for the records of a database (null: none yet).
export type RecordPropertiesChoice = { phone: boolean | null; desktop: boolean | null };
const bool = (value: unknown) => (value === null || value === undefined ? null : Number(value) === 1);
export async function recordPropertiesCollapsed(user: Pick<Identity, "id">, databaseId: string): Promise<RecordPropertiesChoice> {
  const row = await one<{ record_properties_phone: number | null; record_properties_desktop: number | null }>(
    "SELECT record_properties_phone,record_properties_desktop FROM page_view_prefs WHERE user_id=? AND page_id=?",
    user.id,
    databaseId,
  );
  return { phone: bool(row?.record_properties_phone), desktop: bool(row?.record_properties_desktop) };
}

const recordInput = z.object({ pageId: z.string().uuid(), device: z.enum(["phone", "desktop"]), collapsed: z.boolean().nullable() });

// The command `database.collapseRecordProperties`: { pageId (the database),
// device ("phone" | "desktop"), collapsed } – null forgets the choice for
// that kind of device. Like the bar: anyone who may open the database.
export async function setRecordPropertiesCollapsed(user: Identity, body: unknown): Promise<{ device: "phone" | "desktop"; collapsed: boolean | null }> {
  const b = recordInput.parse(body);
  const page = await requirePage(user, b.pageId);
  if (!(await one("SELECT 1 AS ok FROM databases WHERE page_id=?", page.id))) throw new HttpError(400, "Keine Datenbank.");
  const column = b.device === "phone" ? "record_properties_phone" : "record_properties_desktop";
  const value = b.collapsed === null ? null : b.collapsed ? 1 : 0;
  await run(
    `INSERT INTO page_view_prefs(user_id,page_id,${column},updated_at) VALUES(?,?,?,?)
     ON CONFLICT(user_id,page_id) DO UPDATE SET ${column}=excluded.${column},updated_at=excluded.updated_at`,
    user.id,
    page.id,
    value,
    Date.now(),
  );
  // Nothing chosen any more: no row.
  if (value === null)
    await run(
      `DELETE FROM page_view_prefs WHERE user_id=? AND page_id=? AND properties_collapsed IS NULL AND completed_mine IS NULL
       AND record_properties_phone IS NULL AND record_properties_desktop IS NULL`,
      user.id,
      page.id,
    );
  return { device: b.device, collapsed: b.collapsed };
}
