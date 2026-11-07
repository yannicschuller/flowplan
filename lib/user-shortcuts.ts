// A person's own keyboard shortcuts (lib/keymap.ts): stored per user, only
// the actions that differ from the defaults. Sent along with the bootstrap,
// changed with the command `shortcuts.save`.
import { z } from "zod";
import { one, run } from "./db";
import { HttpError } from "./auth";
import { cleanOverrides, MAX_COMBOS, normalizeCombo, SHORTCUT_ACTIONS, type KeymapOverrides } from "./keymap";
import type { Identity } from "./types";

export async function userShortcuts(user: Pick<Identity, "id">): Promise<KeymapOverrides> {
  const row = await one<{ bindings: string }>("SELECT bindings FROM user_shortcuts WHERE user_id=?", user.id);
  if (!row) return {};
  try {
    return cleanOverrides(JSON.parse(row.bindings));
  } catch {
    return {};
  }
}

const input = z.object({
  // The whole set of own shortcuts; {} resets everything to the defaults.
  bindings: z.partialRecord(z.enum(SHORTCUT_ACTIONS), z.array(z.string().max(40)).max(MAX_COMBOS)),
});

export async function saveShortcuts(user: Identity, body: unknown): Promise<{ bindings: KeymapOverrides }> {
  const b = input.parse(body);
  for (const combos of Object.values(b.bindings))
    if (combos?.some((c) => !normalizeCombo(c))) throw new HttpError(400, "Ungültige Eingabe.");
  const bindings = cleanOverrides(b.bindings);
  if (!Object.keys(bindings).length) await run("DELETE FROM user_shortcuts WHERE user_id=?", user.id);
  else
    await run(
      `INSERT INTO user_shortcuts(user_id,bindings,updated_at) VALUES(?,?,?)
       ON CONFLICT(user_id) DO UPDATE SET bindings=excluded.bindings,updated_at=excluded.updated_at`,
      user.id,
      JSON.stringify(bindings),
      Date.now(),
    );
  return { bindings };
}
