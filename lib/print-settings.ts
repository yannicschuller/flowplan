// Print options on the server (#215, lib/print-options.ts): a person's last
// choice and own print presets in users.print_settings, a workspace's
// presets and its default one in workspaces.print_presets (JSON, NULL =
// none). Workspace presets are delivered to every member and guest in the
// bootstrap and changed by owners only.
import { audit, id, one, run } from "./db";
import { HttpError } from "./auth";
import { requireMember } from "./permissions";
import {
  PRINT_PRESET_LIMITS,
  normalizePreset,
  printOptionsOf,
  printOptionsSchema,
  printPresetSchema,
  printPresetsSchema,
  presetsOf,
  type PrintPreset,
  type UserPrintSettings,
  type WorkspacePrintPresets,
} from "./print-options";
import type { Identity } from "./types";

const parse = (raw: string | null | undefined) => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
};

export async function userPrintSettings(userId: string): Promise<UserPrintSettings> {
  const stored = parse((await one<{ print_settings: string | null }>("SELECT print_settings FROM users WHERE id=?", userId))?.print_settings);
  return { last: stored?.last ? printOptionsOf(stored.last) : null, presets: presetsOf(stored?.presets) };
}

export async function workspacePrintPresets(workspaceId: string): Promise<WorkspacePrintPresets> {
  const stored = parse((await one<{ print_presets: string | null }>("SELECT print_presets FROM workspaces WHERE id=?", workspaceId))?.print_presets);
  const presets = presetsOf(stored?.presets);
  const defaultId = typeof stored?.defaultId === "string" && presets.some((p) => p.id === stored.defaultId) ? stored.defaultId : null;
  return { presets, defaultId };
}

// A list as sent: every preset valid, unique ids (a repeated or missing one
// gets a new id).
function cleanPresets(input: unknown): PrintPreset[] {
  if (Array.isArray(input) && input.length > PRINT_PRESET_LIMITS.presets) throw new HttpError(400, "Höchstens 30 Druckvorlagen.");
  const presets = printPresetsSchema.parse(input).map(normalizePreset);
  const seen = new Set<string>();
  for (const preset of presets) {
    if (seen.has(preset.id)) preset.id = id();
    seen.add(preset.id);
  }
  return presets;
}

// The person's own: the last choice (`options`) and/or the whole list of
// their presets. Every signed-in person has their own, guests too; read
// tokens do not write.
export async function setUserPrintSettings(user: Identity, input: { options?: unknown; presets?: unknown }) {
  if (user.apiScope === "read") throw new HttpError(403, "Dieses API-Token darf nur lesen.");
  const current = await userPrintSettings(user.id);
  const next: UserPrintSettings = {
    last: input.options === undefined ? current.last : input.options === null ? null : printOptionsSchema.parse(input.options),
    presets: input.presets === undefined ? current.presets : cleanPresets(input.presets),
  };
  await run("UPDATE users SET print_settings=? WHERE id=?", next.last || next.presets.length ? JSON.stringify(next) : null, user.id);
  return next;
}

// Owners replace the workspace's list and its default.
export async function saveWorkspacePrintPresets(user: Identity, workspaceId: string, input: { presets: unknown; defaultId?: unknown }) {
  await requireMember(user, workspaceId, "owner");
  const presets = cleanPresets(input.presets);
  const defaultId = typeof input.defaultId === "string" && presets.some((p) => p.id === input.defaultId) ? input.defaultId : null;
  await run("UPDATE workspaces SET print_presets=? WHERE id=?", presets.length ? JSON.stringify({ presets, defaultId }) : null, workspaceId);
  await audit(user.id, "workspace.printPresets", workspaceId, String(presets.length));
  return { presets, defaultId };
}

// ---- Archives (lib/archive.ts) and the JSON backup ----

// An archive's presets in the workspace it is imported into: only by an
// owner, preset by preset – an invalid one is left out and counted
// (`dropped`). Added to the workspace's own: a name the workspace already
// has keeps the workspace's version; at most PRINT_PRESET_LIMITS.presets
// in all. The default comes along when the workspace has none.
export async function importPrintPresets(user: Identity, workspaceId: string, input: unknown) {
  if (input === undefined || input === null) return { added: 0, dropped: 0 };
  if ((await one<{ role: string }>("SELECT role FROM members WHERE workspace_id=? AND user_id=?", workspaceId, user.id))?.role !== "owner") return { added: 0, dropped: 0 };
  const list = (input as { presets?: unknown }).presets;
  if (typeof input !== "object" || !Array.isArray(list)) return { added: 0, dropped: 1 };
  const current = await workspacePrintPresets(workspaceId);
  const names = new Set(current.presets.map((p) => p.name.toLowerCase()));
  const ids = new Set(current.presets.map((p) => p.id));
  const presets = [...current.presets];
  let defaultId = current.defaultId;
  const wantedDefault = (input as { defaultId?: unknown }).defaultId;
  let added = 0,
    dropped = 0;
  for (const entry of list) {
    const parsed = printPresetSchema.safeParse(entry);
    if (!parsed.success) {
      dropped++;
      continue;
    }
    const preset = normalizePreset(parsed.data);
    if (names.has(preset.name.toLowerCase())) continue;
    if (presets.length >= PRINT_PRESET_LIMITS.presets) {
      dropped++;
      continue;
    }
    const original = preset.id;
    if (ids.has(preset.id)) preset.id = id();
    names.add(preset.name.toLowerCase());
    ids.add(preset.id);
    presets.push(preset);
    if (!defaultId && wantedDefault === original) defaultId = preset.id;
    added++;
  }
  if (added) await run("UPDATE workspaces SET print_presets=? WHERE id=?", JSON.stringify({ presets, defaultId }), workspaceId);
  return { added, dropped };
}
