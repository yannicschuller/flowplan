// "Heute" favourites of journals (#537, schema 137): a journal whose
// "<Journal> – Heute" link sits in a person's favourites. The link opens the
// day of the date it is used on (components/workspace-app.tsx
// openJournalToday), so it moves on at midnight by itself. Kept apart from
// `favorites`: the journal page can be a favourite at the same time.
import { all, run } from "./db";
import { HttpError } from "./auth";
import { requirePage } from "./permissions";
import type { Identity } from "./types";

// The journals of `readable` (the bootstrap's readable pages) with a
// "Heute" favourite of this person, oldest first; not those in the trash.
export async function todayFavoriteIds(userId: string, readable: { id: string; kind: string; deleted_at?: string | null }[]) {
  const journals = new Set(readable.filter((p) => p.kind === "journal" && !p.deleted_at).map((p) => p.id));
  if (!journals.size) return [];
  return (await all<{ page_id: string }>("SELECT page_id FROM today_favorites WHERE user_id=? ORDER BY created_at,page_id", userId))
    .map((f) => f.page_id)
    .filter((id) => journals.has(id));
}

// favorite.today: adds or removes the "Heute" favourite of a journal the
// person may read.
export async function setTodayFavorite(user: Identity, pageId: string, value: boolean) {
  const page = await requirePage(user, pageId);
  if (page.kind !== "journal") throw new HttpError(400, "Nur Journale haben einen Heute-Favoriten.");
  if (value)
    await run("INSERT INTO today_favorites(user_id,page_id,created_at) VALUES(?,?,?) ON CONFLICT DO NOTHING", user.id, page.id, Date.now());
  else await run("DELETE FROM today_favorites WHERE user_id=? AND page_id=?", user.id, page.id);
}
