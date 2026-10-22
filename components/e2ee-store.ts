"use client";
// The keys of end-to-end encrypted spaces in this browser tab (lib/e2ee.ts,
// docs/e2ee-design.md). The unlocked private key and the space keys live in
// memory only: nothing is written to localStorage or IndexedDB, a reload or
// the auto-lock after inactivity forgets them, and the passphrase never
// leaves this tab.
import { useSyncExternalStore } from "react";
import { api } from "./ui";
import * as e2ee from "@/lib/e2ee";
import { tr as t } from "@/lib/locale-tag";

export type ServerIdentity = e2ee.Identity & { version: number };
type Holder = { userId: string; name: string; publicKey: string | null };
export type SpaceInfo = {
  spaceId: string;
  keyVersion: number;
  encryptTitles: boolean;
  rotatePending: boolean;
  manage: boolean;
  ownerId: string;
  myKeys: { version: number; sealed: e2ee.SealedKey }[];
  holders: Holder[];
  candidates: { userId: string; name: string; email: string; publicKey: string }[];
  withoutKeys: { userId: string; name: string }[];
};
type OpenSpace = { info: SpaceInfo; keys: Map<number, e2ee.SpaceKey> };

let identity: ServerIdentity | null | undefined;
let userId = "";
let privateKey: CryptoKey | null = null;
const spaces = new Map<string, OpenSpace>();
const opening = new Map<string, Promise<OpenSpace | null>>();
// Titles decrypted in this tab, by page id and cipher text.
const titles = new Map<string, string>();
const listeners = new Set<() => void>();
let snapshot = { identity, unlocked: false, revision: 0 };
function changed() {
  snapshot = { identity, unlocked: !!privateKey, revision: snapshot.revision + 1 };
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
const server = { identity: undefined as ServerIdentity | null | undefined, unlocked: false, revision: 0 };
export function useE2ee() {
  return useSyncExternalStore(subscribe, () => snapshot, () => server);
}

// ---- Auto-lock after inactivity ----

const AUTOLOCK_KEY = "flowplan:e2ee:autolock";
export const AUTOLOCK_CHOICES = [5, 15, 30, 60];
export function autoLockMinutes() {
  try {
    const value = Number(localStorage.getItem(AUTOLOCK_KEY));
    return AUTOLOCK_CHOICES.includes(value) ? value : 15;
  } catch {
    return 15;
  }
}
export function setAutoLockMinutes(minutes: number) {
  try {
    localStorage.setItem(AUTOLOCK_KEY, String(minutes));
  } catch {}
  changed();
}
let lastActivity = Date.now();
let watching = false;
function watchActivity() {
  if (watching || typeof window === "undefined") return;
  watching = true;
  const seen = () => (lastActivity = Date.now());
  for (const type of ["keydown", "pointerdown", "wheel", "touchstart"]) window.addEventListener(type, seen, { passive: true, capture: true });
  setInterval(() => {
    if (privateKey && Date.now() - lastActivity > autoLockMinutes() * 60_000) void lockSoon();
  }, 15_000);
}

// ---- Identity ----

export async function loadIdentity(user: string, force = false) {
  if (userId !== user) {
    lock();
    identity = undefined;
    userId = user;
  }
  if (identity !== undefined && !force) return identity;
  const result = await api<{ identity: ServerIdentity | null }>("/api/e2ee/identity");
  identity = result.identity;
  changed();
  return identity;
}
// Open editors send what is not saved yet before the keys go (at most 3 s).
const flushers = new Set<() => Promise<void>>();
export function beforeLock(flush: () => Promise<void>) {
  flushers.add(flush);
  return () => {
    flushers.delete(flush);
  };
}
export async function lockSoon() {
  if (privateKey && flushers.size)
    await Promise.race([Promise.all([...flushers].map((flush) => flush().catch(() => {}))), new Promise((done) => setTimeout(done, 3000))]);
  lock();
}
export function lock() {
  privateKey = null;
  spaces.clear();
  opening.clear();
  titles.clear();
  changed();
  window.dispatchEvent(new CustomEvent("flowplan:e2ee-locked"));
}
function unlocked(key: CryptoKey) {
  privateKey = key;
  lastActivity = Date.now();
  watchActivity();
  changed();
}
export async function unlock(passphrase: string) {
  if (!identity) throw new Error(t("Die Verschlüsselung ist noch nicht eingerichtet.", "Encryption is not set up yet."));
  try {
    unlocked(await e2ee.importPrivateKey(await e2ee.unwrapWithPassphrase(identity.wrappedPrivate, passphrase)));
  } catch (error) {
    if (error instanceof e2ee.DecryptError) throw new Error(t("Die Passphrase stimmt nicht.", "The passphrase is wrong."));
    throw error;
  }
}
// The recovery key opens the private key; a new passphrase replaces the old one.
export async function recover(recoveryKey: string, newPassphrase: string) {
  if (!identity) throw new Error(t("Die Verschlüsselung ist noch nicht eingerichtet.", "Encryption is not set up yet."));
  const recovery = e2ee.parseRecoveryKey(recoveryKey);
  if (!recovery) throw new Error(t("Der Wiederherstellungsschlüssel hat nicht das richtige Format.", "The recovery key does not have the right format."));
  let pkcs8: Uint8Array;
  try {
    pkcs8 = await e2ee.unwrapWithRecovery(identity.recoveryWrapped, recovery);
  } catch {
    throw new Error(t("Der Wiederherstellungsschlüssel stimmt nicht.", "The recovery key is wrong."));
  }
  await api("/api/command", { action: "e2ee.identity.update", version: identity.version, wrappedPrivate: await e2ee.wrapWithPassphrase(pkcs8, newPassphrase) });
  await loadIdentity(userId, true);
  unlocked(await e2ee.importPrivateKey(pkcs8));
}
export async function changePassphrase(current: string, next: string) {
  if (!identity) return;
  let pkcs8: Uint8Array;
  try {
    pkcs8 = await e2ee.unwrapWithPassphrase(identity.wrappedPrivate, current);
  } catch {
    throw new Error(t("Die bisherige Passphrase stimmt nicht.", "The current passphrase is wrong."));
  }
  await api("/api/command", { action: "e2ee.identity.update", version: identity.version, wrappedPrivate: await e2ee.wrapWithPassphrase(pkcs8, next) });
  await loadIdentity(userId, true);
}
// A new recovery key; the old one stops working.
export async function newRecoveryKey(passphrase: string) {
  if (!identity) return "";
  let pkcs8: Uint8Array;
  try {
    pkcs8 = await e2ee.unwrapWithPassphrase(identity.wrappedPrivate, passphrase);
  } catch {
    throw new Error(t("Die Passphrase stimmt nicht.", "The passphrase is wrong."));
  }
  const recovery = e2ee.randomBytes(e2ee.RECOVERY_BYTES);
  await api("/api/command", { action: "e2ee.identity.update", version: identity.version, recoveryWrapped: await e2ee.wrapWithRecovery(pkcs8, recovery) });
  await loadIdentity(userId, true);
  return e2ee.formatRecoveryKey(recovery);
}
// Prepares a key pair; nothing is stored until the recovery key is safe.
export async function prepareIdentity(passphrase: string) {
  if (!(await e2ee.x25519Supported()))
    throw new Error(t("Dieser Browser unterstützt die nötige Verschlüsselung (X25519) nicht. Bitte einen aktuellen Browser verwenden.", "This browser does not support the required encryption (X25519). Please use a current browser."));
  const created = await e2ee.createIdentity(passphrase);
  return {
    recoveryKey: created.recoveryKey,
    async commit() {
      await api("/api/command", { action: "e2ee.identity.setup", ...created.identity });
      await loadIdentity(userId, true);
      unlocked(created.privateKey);
    },
  };
}
export async function resetIdentity() {
  await api("/api/command", { action: "e2ee.identity.reset" });
  lock();
  await loadIdentity(userId, true);
}

// ---- Spaces ----

function requireUnlocked() {
  if (!privateKey) throw new Error(t("Bitte zuerst entsperren.", "Please unlock first."));
  return privateKey;
}
export function spaceKey(spaceId: string, version?: number) {
  const space = spaces.get(spaceId);
  if (!space) return undefined;
  return space.keys.get(version ?? space.info.keyVersion);
}
export function openedSpace(spaceId: string) {
  return spaces.get(spaceId) || null;
}
// Loads and opens my keys of a space (null: I hold none). A pending
// rotation (someone left) is done here, before anything new is written.
export function openSpace(spaceId: string, force = false): Promise<OpenSpace | null> {
  if (!force && spaces.has(spaceId)) return Promise.resolve(spaces.get(spaceId)!);
  if (!force && opening.has(spaceId)) return opening.get(spaceId)!;
  const promise = (async () => {
    const key = requireUnlocked();
    const info = await api<SpaceInfo>(`/api/e2ee/spaces/${spaceId}`);
    const keys = new Map<number, e2ee.SpaceKey>();
    for (const k of info.myKeys)
      try {
        keys.set(k.version, await e2ee.spaceKeyFromRaw(k.version, await e2ee.openKey(k.sealed, key, e2ee.spaceKeyContext(spaceId, k.version, userId))));
      } catch {
        // A key sealed for an earlier key pair (after a reset) stays closed.
      }
    if (!keys.has(info.keyVersion)) {
      spaces.delete(spaceId);
      return null;
    }
    const open = { info, keys };
    spaces.set(spaceId, open);
    if (info.rotatePending) return (await rotateSpace(spaceId)) || open;
    changed();
    return open;
  })().finally(() => opening.delete(spaceId));
  opening.set(spaceId, promise);
  return promise;
}
async function sealAll(spaceId: string, key: e2ee.SpaceKey, people: { userId: string; publicKey: string | null }[]) {
  return Promise.all(
    people
      .filter((p) => p.publicKey)
      .map(async (p) => ({ userId: p.userId, sealed: await e2ee.sealKey(key.raw, p.publicKey!, e2ee.spaceKeyContext(spaceId, key.version, p.userId)) })),
  );
}
// A new space key for everyone who still holds the current one.
export async function rotateSpace(spaceId: string) {
  const open = spaces.get(spaceId);
  if (!open) return null;
  const next = await e2ee.newSpaceKey(open.info.keyVersion + 1);
  await api("/api/command", { action: "e2ee.rotate", spaceId, version: next.version, keys: await sealAll(spaceId, next, open.info.holders) });
  spaces.delete(spaceId);
  return openSpace(spaceId, true);
}
export async function addMember(spaceId: string, person: { userId: string; publicKey: string }, role: "editor" | "viewer") {
  const open = spaces.get(spaceId) || (await openSpace(spaceId));
  if (!open) throw new Error(t("Dir fehlt der Schlüssel dieses Bereichs.", "You do not have the key of this space."));
  const keys = await Promise.all(
    [...open.keys.values()].map(async (key) => ({
      version: key.version,
      sealed: await e2ee.sealKey(key.raw, person.publicKey, e2ee.spaceKeyContext(spaceId, key.version, person.userId)),
    })),
  );
  await api("/api/command", { action: "e2ee.member.add", spaceId, userId: person.userId, role, keys });
  await openSpace(spaceId, true);
}
export async function removeMember(spaceId: string, memberId: string) {
  await api("/api/command", { action: "e2ee.member.remove", spaceId, userId: memberId });
  if (memberId === userId) {
    spaces.delete(spaceId);
    changed();
    return;
  }
  await openSpace(spaceId, true);
}
export async function createEncryptedSpace(input: { workspaceId: string; name: string; icon: string; iconColor: string; encryptTitles: boolean }) {
  if (!identity) throw new Error(t("Zuerst die Verschlüsselung einrichten.", "Set up encryption first."));
  requireUnlocked();
  const spaceId = crypto.randomUUID();
  const key = await e2ee.newSpaceKey(1);
  const sealed = await e2ee.sealKey(key.raw, identity.publicKey, e2ee.spaceKeyContext(spaceId, 1, userId));
  await api("/api/command", {
    action: "space.create",
    workspaceId: input.workspaceId,
    id: spaceId,
    name: input.name,
    private: true,
    icon: input.icon,
    iconColor: input.iconColor,
    encrypted: { key: sealed, encryptTitles: input.encryptTitles },
  });
  return spaceId;
}

// ---- Titles ----

export function decryptedTitle(pageId: string, cipher: string | null | undefined) {
  return cipher ? titles.get(`${pageId}:${cipher}`) : undefined;
}
export async function decryptTitles(pages: { id: string; space_id: string; title_cipher?: string | null }[]) {
  let any = false;
  for (const page of pages) {
    if (!page.title_cipher || titles.has(`${page.id}:${page.title_cipher}`)) continue;
    const open = spaces.get(page.space_id);
    if (!open) continue;
    try {
      titles.set(`${page.id}:${page.title_cipher}`, await e2ee.decryptTitle((v) => open.keys.get(v), page.id, page.title_cipher));
      any = true;
    } catch {}
  }
  if (any) changed();
}
export async function encryptTitle(spaceId: string, pageId: string, title: string) {
  const key = spaceKey(spaceId);
  if (!key) throw new Error(t("Bitte zuerst entsperren.", "Please unlock first."));
  const cipher = await e2ee.encryptTitle(key, pageId, title);
  titles.set(`${pageId}:${cipher}`, title);
  return cipher;
}
