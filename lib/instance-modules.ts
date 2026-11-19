// Features switched off for the whole instance (#386, Administration →
// Instanz → "Funktionen dieser Instanz", instance setting modulesOff). Unlike
// the per-person switches of #378 (lib/feature-modules.ts), off here is off
// on the server:
//
//   - hidden for everyone, whatever their own choice (the bootstrap's
//     modules.off; effective = instance on AND not hidden by the person);
//   - nothing new of it and no use of it: the commands, routes and MCP tools
//     of the feature answer 403 with "… auf dieser Instanz ausgeschaltet";
//   - no background work for it: the workflow queue and schedules, the AI
//     worker, study and meeting reminders skip their rounds and keep what is
//     queued (nothing is dropped, nothing piles up from new events);
//   - what exists stays untouched: pages of the kind stay in the tree, the
//     search, the trash, exports and backups and open read-only with a
//     notice; deleting, restoring and exporting keep working;
//   - public links of it answer "not available" (forms: the public form is
//     closed).
// Switching it on again restores everything as it was: nothing was changed.
//
// Read on every use (lib/instance-settings.ts reads the database each
// time), so in cluster mode every instance follows at once and background
// jobs check it on each run.
import { HttpError } from "./auth";
import { PAGE_KIND_MODULE, VIEW_MODULE, type FeatureModule } from "./feature-modules";
import { instanceSettings } from "./instance-settings";
import type { PageKind, View } from "./types";

// The refusal per feature (English in lib/i18n-errors.ts).
export const MODULE_OFF_TEXT: Record<FeatureModule, string> = {
  flashcards: "Lernkarten sind auf dieser Instanz ausgeschaltet.",
  whiteboards: "Whiteboards sind auf dieser Instanz ausgeschaltet.",
  notebooks: "Notizbücher sind auf dieser Instanz ausgeschaltet.",
  journal: "Das Journal ist auf dieser Instanz ausgeschaltet.",
  dashboards: "Dashboards sind auf dieser Instanz ausgeschaltet.",
  workflows: "Workflows sind auf dieser Instanz ausgeschaltet.",
  drawio: "draw.io ist auf dieser Instanz ausgeschaltet.",
  ai: "KI ist auf dieser Instanz ausgeschaltet.",
  views: "Diese Ansichtsart ist auf dieser Instanz ausgeschaltet.",
  forms: "Formulare sind auf dieser Instanz ausgeschaltet.",
  meetings: "Besprechungen sind auf dieser Instanz ausgeschaltet.",
};
export const moduleOffError = (module: FeatureModule) => new HttpError(403, MODULE_OFF_TEXT[module]);

export async function modulesOff(): Promise<FeatureModule[]> {
  return (await instanceSettings()).modulesOff;
}
export async function moduleOff(module: FeatureModule | undefined): Promise<boolean> {
  return !!module && (await modulesOff()).includes(module);
}
export async function requireModule(module: FeatureModule | undefined) {
  if (module && (await moduleOff(module))) throw moduleOffError(module);
}
export const kindModule = (kind: PageKind | string | null | undefined) => (kind ? PAGE_KIND_MODULE[kind as PageKind] : undefined);
// The feature a page belongs to: its kind's, a journal's day its journal's.
export const pageModule = (page: { kind: PageKind | string; journal_date?: string | null }) => (page.journal_date ? "journal" : kindModule(page.kind));
export const viewModule = (type: View["type"] | string | null | undefined) => (type ? VIEW_MODULE[type as View["type"]] : undefined);

// The commands of POST /api/command that belong to a feature. Deleting,
// restoring, moving and exporting pages are general commands and stay.
const COMMAND_PREFIXES: [string, FeatureModule][] = [
  ["study.", "flashcards"],
  ["notebook.", "notebooks"],
  ["journal.", "journal"],
  ["workflow.", "workflows"],
];
const COMMANDS: Record<string, FeatureModule> = {
  "whiteboard.sync": "whiteboards",
  "whiteboard.toRecords": "whiteboards",
  "dashboard.save": "dashboards",
  "form.update": "forms",
  "form.submit": "forms",
  "survey.save": "forms",
  "meeting.note": "meetings",
};
export function commandModule(action: string): FeatureModule | undefined {
  return COMMANDS[action] ?? COMMAND_PREFIXES.find(([prefix]) => action.startsWith(prefix))?.[1];
}
export async function refuseOffCommand(action: string) {
  await requireModule(commandModule(action));
}

// The MCP tools of a feature (lib/mcp.ts, lib/workflows/mcp-tools.ts);
// tools that use the AI (tool.ai) count as "ai" there.
export function toolModule(name: string): FeatureModule | undefined {
  if (name === "study_decks" || name.endsWith("_flashcard_parameters")) return "flashcards";
  if (name.endsWith("_meeting_note")) return "meetings";
  if (/(^|_)workflows?(_|$)/.test(name)) return "workflows";
  return undefined;
}

// Views a database may not gain while their kind is off: a new view of that
// type, or an existing one switched to it. Views that exist stay as stored.
export function addedOffViews(off: readonly FeatureModule[], before: readonly Pick<View, "id" | "type">[], after: readonly Pick<View, "id" | "type">[]): FeatureModule | undefined {
  for (const view of after) {
    const module = viewModule(view.type);
    if (!module || !off.includes(module)) continue;
    if (before.find((v) => v.id === view.id)?.type !== view.type) return module;
  }
  return undefined;
}

// The audit entry of a change (admin.modulesOff): "off: a, b; on: c".
export function modulesOffChange(before: readonly FeatureModule[], after: readonly FeatureModule[]): string {
  const off = after.filter((m) => !before.includes(m));
  const on = before.filter((m) => !after.includes(m));
  return [off.length ? `off: ${off.join(", ")}` : "", on.length ? `on: ${on.join(", ")}` : ""].filter(Boolean).join("; ");
}
