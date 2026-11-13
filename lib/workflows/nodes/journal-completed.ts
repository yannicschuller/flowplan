// A journal day's output `completed` for the workflow nodes (#273) – its own
// module: the trigger outputs (./triggers.ts) need it without the node
// implementations.
import { one } from "../../db";
import { pageRole } from "../../permissions";
import type { Locale } from "../../i18n";
import type { Identity, Page } from "../../types";
import { aiCompletedItems, completedLine } from "../../ai/journal-completed";

// The output `completed` (#273): what the journal lists below the day under
// "An diesem Tag erledigt", as the run's person sees it there ("Nur meine"
// or "Alle" by their choice) – each "Title (page or database)", at most 200.
// Only what the AI may read as well (lib/ai/journal-completed.ts): the list
// goes into AI steps, and a journal with a PIN stays closed even while that
// person has it unlocked in a browser.
export async function completedValue(who: Identity | null, dayId: string | null | undefined, zone: string, locale?: Locale): Promise<string[]> {
  if (!who || !dayId) return [];
  const day = await one<Page>("SELECT * FROM pages WHERE id=? AND deleted_at IS NULL", dayId);
  if (!day || !(await pageRole(who, day))) return [];
  const list = await aiCompletedItems(who, day, zone);
  return list ? list.items.map((item) => completedLine(item, locale)) : [];
}
