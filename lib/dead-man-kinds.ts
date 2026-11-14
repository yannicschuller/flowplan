// Inactivity message per workspace ("dead man's switch", #282): the choices
// and the shapes the settings show – client-safe. The rules are in
// lib/dead-man-switch.ts.
export const DEADMAN_PERIOD_DAYS = [30, 60, 90, 180, 365] as const;
export const DEADMAN_DEFAULT_PERIOD = 90;
// Warnings to the holder, days before the message goes out.
export const DEADMAN_WARNING_DAYS = [7, 3, 1] as const;
export const DEADMAN_MAX_RECIPIENTS = 10;
export const DEADMAN_MAX_SWITCHES = 3;
export const DEADMAN_MAX_NOTE = 5000;
// What counts as a sign of life: any use of the account, or only use of
// this workspace.
export type DeadmanSource = "account" | "workspace";
export type DeadmanState = "off" | "armed" | "fired";

export type DeadmanView = {
  id: string;
  state: DeadmanState;
  periodDays: number;
  note: string;
  recipients: string[];
  source: DeadmanSource;
  grantEmergency: boolean;
  // The last sign of life that counts for this switch.
  lastCheckin: number;
  nextWarningAt: number | null;
  fireAt: number | null;
  firedAt: number | null;
  firedTo: string[];
};
export type DeadmanWorkspace = { workspaceId: string; name: string; icon: string; switch: DeadmanView | null };
export type DeadmanOverview = {
  // Mail is set up and the administration allows it.
  available: boolean;
  mail: boolean;
  enabled: boolean;
  // FLOWPLAN_DEAD_MAN_SWITCH=off: the administration cannot switch it on.
  forcedOff: boolean;
  // Emergency access (#281) is on: the switch can grant it.
  emergency: boolean;
  // Trusted contacts (#281) who accepted the role.
  trustedContacts: number;
  workspaces: DeadmanWorkspace[];
};
export type DeadmanPreview = { from: string; to: string[]; subject: string; text: string };
