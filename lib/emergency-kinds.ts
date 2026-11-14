// Emergency access for trusted contacts (#281): the choices and the shapes
// the settings show – client-safe. The rules are in lib/emergency-access.ts.
export const EMERGENCY_WAIT_DAYS = [1, 2, 7, 14, 30] as const;
export const EMERGENCY_DEFAULT_WAIT = 7;
// How long a granted access lasts (null: until the holder ends it).
export const EMERGENCY_ACCESS_DAYS = [7, 30, 90] as const;
export const EMERGENCY_MAX_CONTACTS = 5;
export type EmergencyStatus = "invited" | "accepted" | "requested" | "granted";

type Person = { id: string; name: string; email: string };
type Common = {
  id: string;
  status: EmergencyStatus;
  waitDays: number;
  accessDays: number | null;
  requestedAt: number | null;
  grantAt: number | null;
  grantedAt: number | null;
  expiresAt: number | null;
};
// A trusted contact the person named.
export type EmergencyContactView = Common & {
  contact: Person & { hasKeys: boolean };
  // Key versions of encrypted spaces not yet sealed for the contact.
  keysMissing: number;
};
// Someone who named the person as trusted contact.
export type EmergencyHolderView = Common & {
  holder: Person;
  // A new request is possible from then on (after a denial).
  requestAfter: number | null;
};
// Space keys the holder's browser still has to seal for a contact.
export type EmergencyRewrap = { linkId: string; contactId: string; publicKey: string; spaceId: string; versions: number[] };
export type EmergencyOverview = {
  enabled: boolean;
  // FLOWPLAN_EMERGENCY_ACCESS=off: the administration cannot switch it on.
  forcedOff: boolean;
  encryptedSpaces: number;
  mine: EmergencyContactView[];
  forMe: EmergencyHolderView[];
  rewrap: EmergencyRewrap[];
};
// What a contact with granted access reads.
export type EmergencySpace = {
  id: string;
  name: string;
  icon: string;
  workspace: string;
  encrypted: boolean;
  encryptTitles: boolean;
  keyVersion: number;
};
export type EmergencyPage = {
  id: string;
  spaceId: string;
  parentId: string | null;
  title: string;
  titleCipher: string | null;
  icon: string;
  kind: string;
};
export type EmergencyContent = {
  holder: Person;
  grantedAt: number | null;
  expiresAt: number | null;
  spaces: EmergencySpace[];
  pages: EmergencyPage[];
};
