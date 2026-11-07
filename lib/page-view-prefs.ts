// How a person looks at a page, stored in their account (schema 83, table
// page_view_prefs) and therefore the same on all their devices – unlike the
// folded headings (lib/heading-folds.ts), which stay on the device.
//
// For now one thing (#83): whether the bar with tags and properties under
// the title is collapsed. NULL (or no row) means the person never chose;
// then the default of lib/page-properties.ts isBarCollapsed applies.
// Looking is not changing: anyone who may open the page may choose, and the
// choice is nobody else's business (no notification, no version, no event).
import { z } from "zod";
import { one, run } from "./db";
import { requirePage } from "./permissions";
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
