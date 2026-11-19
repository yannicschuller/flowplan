// The person's switched-off features (#378, lib/feature-modules.ts), kept in
// users.modules as a JSON array (NULL: none of their own – the instance's
// default, modulesDefault in lib/instance-settings.ts). Only the interface
// reads it: nothing here limits what the person may open or do.
import { z } from "zod";
import { HttpError } from "./auth";
import { one, run } from "./db";
import { hiddenModulesOf, type FeatureModule, type FeatureModulesBoot } from "./feature-modules";
import { hiddenModulesSchema } from "./feature-modules-schema";
import { instanceSettings } from "./instance-settings";
import type { Identity } from "./types";

export async function instanceModules(): Promise<FeatureModule[]> {
  return hiddenModulesOf((await instanceSettings()).modulesDefault);
}
// The instance's default and the features switched off for the instance
// (#386, lib/instance-modules.ts), in one read.
async function instanceState() {
  const settings = await instanceSettings();
  return { standard: hiddenModulesOf(settings.modulesDefault), off: settings.modulesOff };
}
// The features that apply: the own choice, without one the instance's
// default; `off` (switched off for the instance) is hidden on top of either.
export function modulesState(stored: string | null | undefined, standard: FeatureModule[], off: FeatureModule[] = []): FeatureModulesBoot {
  // `off` only when there is any (most instances switch nothing off).
  const extra = off.length ? { off } : {};
  return stored === null || stored === undefined ? { hidden: standard, own: false, standard, ...extra } : { hidden: hiddenModulesOf(stored), own: true, standard, ...extra };
}
export async function userFeatureModules(userId: string): Promise<FeatureModulesBoot> {
  const stored = (await one<{ modules: string | null }>("SELECT modules FROM users WHERE id=?", userId))?.modules;
  const { standard, off } = await instanceState();
  return modulesState(stored, standard, off);
}

// profile.modules: the features the person hides, null for the instance's
// default (no choice of their own).
export const modulesInputSchema = hiddenModulesSchema.nullable();
export async function setUserFeatureModules(user: Identity, input: unknown) {
  const hidden = modulesInputSchema.parse(input);
  const stored = hidden === null ? null : JSON.stringify(hiddenModulesOf(hidden));
  await run("UPDATE users SET modules=? WHERE id=?", stored, user.id);
  const { standard, off } = await instanceState();
  return { modules: modulesState(stored, standard, off) };
}

// admin.modules: an administrator puts a person back on the instance's
// default (their own choice goes). Choosing features for someone else is
// left to the person.
export const adminModulesSchema = z.object({ userId: z.uuid() });
export async function adminResetFeatureModules(input: unknown) {
  const b = adminModulesSchema.parse(input);
  if (!(await run("UPDATE users SET modules=NULL WHERE id=? AND demo_until IS NULL", b.userId)).changes) throw new HttpError(404, "Benutzer nicht gefunden.");
  const { standard, off } = await instanceState();
  return { modules: modulesState(null, standard, off) };
}

// admin.modulesApplyAll: every account follows the instance's default from
// now on – also after later changes of it; own choices go.
export async function applyModulesToAll() {
  const changed = (await run("UPDATE users SET modules=NULL WHERE modules IS NOT NULL AND demo_until IS NULL")).changes;
  return { changed: Number(changed) || 0, standard: await instanceModules() };
}
