// The appearance a person's shares and publications start with (#526,
// lib/public-appearance.ts): their own page icon placement (users.page_icon),
// font (users.ui_font) and struck-through done tasks (users.strike_done_tasks).
// No person (a creator who was deleted): the defaults.
import { one } from "./db";
import { pageIconPrefOf } from "./page-icon-pref";
import { personalFontOf } from "./personal-font";
import { strikeDoneTasksOf } from "./done-strike-pref";
import { DEFAULT_PUBLIC_APPEARANCE, publicAppearanceOf, type PublicAppearance } from "./public-appearance";

export async function userPublicAppearance(userId: string | null | undefined): Promise<PublicAppearance> {
  const row = userId
    ? await one<{ page_icon: string | null; ui_font: string | null; strike_done_tasks: number | null }>(
        "SELECT page_icon,ui_font,strike_done_tasks FROM users WHERE id=?",
        userId,
      )
    : undefined;
  if (!row) return { ...DEFAULT_PUBLIC_APPEARANCE };
  return { pageIcon: pageIconPrefOf(row.page_icon), font: personalFontOf(row.ui_font), strikeDoneTasks: strikeDoneTasksOf(row.strike_done_tasks) };
}
// What a stored appearance means: as stored, or – made before #526 – the
// creator's current settings.
export async function storedPublicAppearance(stored: string | null | undefined, creator: string | null | undefined): Promise<PublicAppearance> {
  return stored ? publicAppearanceOf(stored) : await userPublicAppearance(creator);
}
