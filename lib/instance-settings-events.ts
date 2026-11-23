// What a change of the instance settings means beyond the stored values:
// security events for who may get in, audit entries for the switches with
// consequences of their own. After admin.settings (lib/api.ts) and after
// the instance settings file's import (lib/settings-file.ts) alike.
import { audit } from "./db";
import type { InstanceSettings } from "./instance-settings";
import { modulesOffChange } from "./instance-modules";
import { securityEvent } from "./security-events";
import type { Identity } from "./types";

export async function instanceSettingsChanged(user: Identity, previous: InstanceSettings, saved: InstanceSettings) {
  // Who may get in, and how: sign-up for anyone, demo accounts,
  // invitation links (#320) and the two-factor requirement – a
  // security event each; opening them alerts the administrators
  // (lib/security-detect.ts, #321).
  for (const key of ["allowSignup", "publicDemo", "inviteLinks"] as const)
    if (previous[key] !== saved[key]) securityEvent("admin.settings", { actorId: user.id, detail: `${key} ${saved[key] ? "on" : "off"}` });
  if (previous.twoFactor !== saved.twoFactor) securityEvent("admin.settings", { actorId: user.id, detail: `twoFactor ${previous.twoFactor}→${saved.twoFactor}` });
  // Switching the emergency access (#281) suspends or resumes every
  // granted access: a security event of its own.
  if (previous.emergencyAccess !== saved.emergencyAccess) await audit(user.id, "admin.emergency", "instance", saved.emergencyAccess ? "on" : "off");
  // The inactivity message (#282) likewise.
  if (previous.deadManSwitch !== saved.deadManSwitch) await audit(user.id, "admin.deadman", "instance", saved.deadManSwitch ? "on" : "off");
  // Starter content for new accounts (#381): which space, if any.
  if (previous.starterSpace !== saved.starterSpace) await audit(user.id, "admin.starter", saved.starterSpace || "instance", saved.starterSpace ? "on" : "off");
  // Features switched off for the instance (#386): which went off, which on.
  const offChange = modulesOffChange(previous.modulesOff, saved.modulesOff);
  if (offChange) await audit(user.id, "admin.modulesOff", "instance", offChange);
}
