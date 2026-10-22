// End-to-end encrypted spaces, server side (docs/e2ee-design.md). The
// server stores and relays what the browsers encrypted – public keys,
// wrapped private keys, sealed space keys, encrypted Yjs updates, snapshots,
// titles and files – and never holds a key that opens any of it. Its job is
// access control, ordering, and refusing every path that would put
// plaintext of an encrypted page on the server (HTML, search, AI, exports,
// share links, publications, webhooks with content, MCP). The triggers in
// lib/db.ts catch what a forgotten code path might still try.
import { z } from "zod";
import { all, audit, one, run } from "./db";
import { HttpError } from "./auth";
import { memberRole, pageRole, requirePage, spaceRole } from "./permissions";
import { canManageSpace } from "./workspace-lifecycle";
import { documentKey, publishEncryptedUpdate } from "./document-live";
import type { Identity, Page, Space } from "./types";
import { ENCRYPTED_TITLE } from "./e2ee";

export { ENCRYPTED_TITLE };
export const PLAINTEXT_REFUSED = "Für verschlüsselte Seiten nicht verfügbar.";
export const E2EE_GENERATION = "e2ee";
const MAX_UPDATE = 8_000_000;

const uuid = z.string().uuid();
const b64 = (max: number) => z.string().max(max).regex(/^[A-Za-z0-9+/]*={0,2}$/);
const passphraseWrap = z
  .object({
    alg: z.literal("PBKDF2-SHA256/AES-256-GCM"),
    v: z.number().int().min(1).max(10),
    salt: b64(64),
    iterations: z.number().int().min(600_000).max(10_000_000),
    iv: b64(32),
    ct: b64(512),
  })
  .strict();
const recoveryWrap = z
  .object({ alg: z.literal("HKDF-SHA256/AES-256-GCM"), v: z.number().int().min(1).max(10), salt: b64(64), iv: b64(32), ct: b64(512) })
  .strict();
const sealedKey = z
  .object({
    alg: z.literal("X25519-HKDF-SHA256/AES-256-GCM"),
    v: z.number().int().min(1).max(10),
    epk: b64(64),
    salt: b64(64),
    iv: b64(32),
    ct: b64(128),
  })
  .strict();
const publicKey = b64(64).refine((value) => Buffer.from(value, "base64").length === 32, "Ungültiger Schlüssel.");
const titleCipher = z
  .string()
  .max(8000)
  .refine((value) => {
    try {
      const parsed = JSON.parse(value) as { v?: unknown; d?: unknown };
      return Number.isInteger(parsed.v) && typeof parsed.d === "string" && /^[A-Za-z0-9+/]*={0,2}$/.test(parsed.d) && Object.keys(parsed).length === 2;
    } catch {
      return false;
    }
  }, "Ungültige Eingabe.");

// ---- What is encrypted ----

type SpaceFlags = Space & { encrypted?: number; key_version?: number; encrypt_titles?: number; rotate_pending?: number };
export function encryptedSpace(spaceId: string | null | undefined): SpaceFlags | null {
  if (!spaceId) return null;
  const space = one<SpaceFlags>("SELECT * FROM spaces WHERE id=?", spaceId);
  return space?.encrypted ? space : null;
}
export function isEncryptedPage(page: Pick<Page, "space_id"> | null | undefined) {
  return !!page && !!encryptedSpace(page.space_id);
}
// For every route that hands out or takes content as plaintext.
export function requirePlaintext(page: Pick<Page, "space_id"> | null | undefined) {
  if (isEncryptedPage(page)) throw new HttpError(409, PLAINTEXT_REFUSED);
}
export function requirePlaintextSpace(space: Pick<Space, "id"> | null | undefined) {
  if (space && encryptedSpace(space.id)) throw new HttpError(409, PLAINTEXT_REFUSED);
}
export function encryptedPageIds(workspaceId: string) {
  return new Set(
    all<{ id: string }>("SELECT p.id FROM pages p JOIN spaces s ON s.id=p.space_id WHERE p.workspace_id=? AND s.encrypted=1", workspaceId).map(
      (r) => r.id,
    ),
  );
}
// Webhook payloads name an encrypted page, never its content.
export function metadataOnly<T extends Record<string, unknown> & { pageId?: string }>(data: T): T | Record<string, unknown> {
  if (!data.pageId) return data;
  const page = one<Page>("SELECT * FROM pages WHERE id=?", data.pageId);
  if (!page || !isEncryptedPage(page)) return data;
  return {
    pageId: data.pageId,
    ...(typeof data.rowId === "string" ? { rowId: data.rowId } : {}),
    ...(typeof data.userId === "string" ? { userId: data.userId } : {}),
    encrypted: true,
  };
}

// ---- The command guard: runs before every command ----

// What a command may do with a page or space of an encrypted space. All
// other commands naming one are refused – the allow-list keeps new features
// out of encrypted spaces until they are made to work without plaintext.
const ALLOWED = new Set([
  "page.create",
  "page.update",
  "page.delete",
  "page.restore",
  "page.move",
  "pages.bulk",
  "favorite",
  "page.follow",
  "page.owner",
  "page.review",
  "space.update",
  "space.delete",
  "space.restore",
  "space.purge",
  "e2ee.append",
  "e2ee.compact",
  "e2ee.title",
  "e2ee.member.add",
  "e2ee.member.remove",
  "e2ee.rotate",
  "notification.read",
  "notification.mark",
  "notification.delete",
]);
const PAGE_KEYS = ["pageId", "targetId", "parentId", "resourceId", "journalId", "sourcePageId", "targetPageId", "databaseId", "rootId"];
const SPACE_KEYS = ["spaceId", "resourceId", "targetSpaceId"];
export function guardEncryptedCommand(action: string, b: Record<string, unknown>) {
  const ids = (keys: string[]) => keys.map((key) => b[key]).filter((value): value is string => typeof value === "string" && value.length <= 100);
  const pageIds = [...ids(PAGE_KEYS), ...(Array.isArray(b.pageIds) ? b.pageIds.filter((v): v is string => typeof v === "string") : [])];
  const touched: string[] = [];
  for (const pid of pageIds) {
    const page = one<{ space_id: string }>("SELECT space_id FROM pages WHERE id=?", pid);
    if (page) touched.push(page.space_id);
  }
  for (const sid of ids(SPACE_KEYS)) if (one("SELECT 1 FROM spaces WHERE id=?", sid)) touched.push(sid);
  const encrypted = touched.map((sid) => encryptedSpace(sid)).filter((s): s is SpaceFlags => !!s);
  if (!encrypted.length) return;
  if (!ALLOWED.has(action)) throw new HttpError(409, PLAINTEXT_REFUSED);
  // Everything one command touches stays inside the same encrypted space:
  // its key does not open another space, and plaintext pages never move in.
  if (new Set(touched).size > 1)
    throw new HttpError(409, "Seiten lassen sich nicht in einen verschlüsselten Bereich hinein oder aus ihm heraus verschieben.");
  const space = encrypted[0];
  if (action === "pages.bulk" && b.operation === "duplicate") throw new HttpError(409, PLAINTEXT_REFUSED);
  if (action === "space.update" && !b.private) throw new HttpError(409, "Ein verschlüsselter Bereich bleibt privat.");
  if (action === "page.create") {
    if ((b.kind ?? "document") !== "document")
      throw new HttpError(409, "Verschlüsselte Bereiche enthalten nur Dokumente (Datenbanken folgen später).");
    if (b.templateId || b.starterTemplate || b.aiDatabase !== undefined) throw new HttpError(409, PLAINTEXT_REFUSED);
    // The plain title never reaches the database, not even for a moment.
    if (space.encrypt_titles && b.title !== ENCRYPTED_TITLE) throw new HttpError(409, "In diesem Bereich sind Titel verschlüsselt.");
  }
  if (action === "page.update") {
    const patch = (b.patch ?? {}) as Record<string, unknown>;
    if (patch.cover !== undefined || patch.cover_position !== undefined) throw new HttpError(409, PLAINTEXT_REFUSED);
    if (space.encrypt_titles && patch.title !== undefined && patch.title !== ENCRYPTED_TITLE)
      throw new HttpError(409, "In diesem Bereich sind Titel verschlüsselt.");
  }
}

// ---- Identities ----

type IdentityRow = { user_id: string; public_key: string; wrapped_private: string; recovery_wrapped: string; version: number };
export function identityOf(userId: string) {
  const row = one<IdentityRow>("SELECT * FROM e2ee_identities WHERE user_id=?", userId);
  return row
    ? {
        publicKey: row.public_key,
        wrappedPrivate: JSON.parse(row.wrapped_private),
        recoveryWrapped: JSON.parse(row.recovery_wrapped),
        version: row.version,
      }
    : null;
}

function requireIdentity(userId: string) {
  const identity = one<IdentityRow>("SELECT * FROM e2ee_identities WHERE user_id=?", userId);
  if (!identity) throw new HttpError(409, "Zuerst die Verschlüsselung einrichten.");
  return identity;
}

// ---- Spaces and their keys ----

function heldVersions(spaceId: string, userId: string) {
  return all<{ key_version: number }>("SELECT key_version FROM e2ee_space_keys WHERE space_id=? AND user_id=? ORDER BY key_version", spaceId, userId).map(
    (r) => r.key_version,
  );
}
function holders(spaceId: string, version: number) {
  return all<{ user_id: string }>("SELECT user_id FROM e2ee_space_keys WHERE space_id=? AND key_version=?", spaceId, version).map((r) => r.user_id);
}
function requireEncryptedSpace(user: Identity, spaceId: string) {
  const space = encryptedSpace(spaceId);
  if (!space || space.deleted_at) throw new HttpError(404, "Bereich nicht gefunden.");
  if (!spaceRole(user, space)) throw new HttpError(403, "Kein Zugriff auf Bereich.");
  return space;
}
function requireHolder(user: Identity, space: SpaceFlags) {
  if (!heldVersions(space.id, user.id).includes(space.key_version!))
    throw new HttpError(403, "Dir fehlt der Schlüssel dieses Bereichs. Ein Mitglied muss dich hinzufügen.");
}

// Called by space.create right after the space row exists.
export function makeSpaceEncrypted(user: Identity, spaceId: string, input: unknown) {
  const data = z.object({ key: sealedKey, encryptTitles: z.boolean().optional() }).parse(input);
  requireIdentity(user.id);
  run("UPDATE spaces SET encrypted=1,key_version=1,encrypt_titles=?,visibility='private' WHERE id=?", data.encryptTitles ? 1 : 0, spaceId);
  run(
    "INSERT INTO e2ee_space_keys(space_id,user_id,key_version,sealed,sealed_by,created_at) VALUES(?,?,?,?,?,?)",
    spaceId,
    user.id,
    1,
    JSON.stringify(data.key),
    user.id,
    Date.now(),
  );
  audit(user.id, "e2ee.space", spaceId);
}

// Called by page.create for a page of an encrypted space.
export function afterEncryptedPageCreate(pageId: string, input: Record<string, unknown>) {
  const page = one<Page>("SELECT * FROM pages WHERE id=?", pageId);
  const space = encryptedSpace(page?.space_id);
  if (!page || !space) return;
  if (space.encrypt_titles) {
    const cipher = input.titleCipher === undefined ? null : titleCipher.parse(input.titleCipher);
    if (cipher && JSON.parse(cipher).v !== space.key_version) throw new HttpError(409, "Der Schlüssel des Bereichs wurde erneuert. Bitte neu laden.");
    run("UPDATE pages SET title=?,title_cipher=? WHERE id=?", ENCRYPTED_TITLE, cipher, pageId);
  }
}

// What the browser needs to open a space: my sealed keys, the members
// holding the current key (with public keys, for sealing a new one) and
// the people who could be added.
export function spaceKeys(user: Identity, spaceId: string) {
  const space = requireEncryptedSpace(user, spaceId);
  const current = space.key_version!;
  const keyHolders = all<{ id: string; name: string; public_key: string | null }>(
    `SELECT u.id,u.name,i.public_key FROM e2ee_space_keys k JOIN users u ON u.id=k.user_id
     LEFT JOIN e2ee_identities i ON i.user_id=u.id WHERE k.space_id=? AND k.key_version=? ORDER BY u.name`,
    space.id,
    current,
  );
  const holderIds = new Set(keyHolders.map((h) => h.id));
  const manage = canManageSpace(user, space);
  return {
    spaceId: space.id,
    keyVersion: current,
    encryptTitles: !!space.encrypt_titles,
    rotatePending: !!space.rotate_pending,
    manage,
    ownerId: space.owner_id,
    myKeys: all<{ key_version: number; sealed: string }>(
      "SELECT key_version,sealed FROM e2ee_space_keys WHERE space_id=? AND user_id=? ORDER BY key_version",
      space.id,
      user.id,
    ).map((k) => ({ version: k.key_version, sealed: JSON.parse(k.sealed) })),
    holders: keyHolders.map((h) => ({ userId: h.id, name: h.name, publicKey: h.public_key })),
    // Workspace members with a key pair who do not hold the key yet.
    candidates: manage
      ? all<{ id: string; name: string; email: string; public_key: string }>(
          `SELECT u.id,u.name,u.email,i.public_key FROM members m JOIN users u ON u.id=m.user_id JOIN e2ee_identities i ON i.user_id=u.id
           WHERE m.workspace_id=? AND u.disabled=0 AND NOT EXISTS(SELECT 1 FROM workspace_guests g WHERE g.workspace_id=m.workspace_id AND g.user_id=u.id)
           ORDER BY u.name`,
          space.workspace_id,
        )
          .filter((u) => !holderIds.has(u.id))
          .map((u) => ({ userId: u.id, name: u.name, email: u.email, publicKey: u.public_key }))
      : [],
    // Members without a key pair cannot be added yet.
    withoutKeys: manage
      ? all<{ id: string; name: string }>(
          `SELECT u.id,u.name FROM members m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? AND u.disabled=0
           AND NOT EXISTS(SELECT 1 FROM e2ee_identities i WHERE i.user_id=u.id) ORDER BY u.name`,
          space.workspace_id,
        ).map((u) => ({ userId: u.id, name: u.name }))
      : [],
  };
}

// ---- Document log ----

function requireEncryptedDocument(user: Identity, pageId: string, write: boolean) {
  const page = requirePage(user, pageId, write);
  const space = encryptedSpace(page.space_id);
  if (!space) throw new HttpError(400, "Keine verschlüsselte Seite.");
  if (page.kind !== "document") throw new HttpError(400, "Kein Dokument.");
  if (write && page.locked) throw new HttpError(409, "Diese Seite ist gesperrt.");
  return { page, space };
}
const toB64 = (data: Uint8Array) => Buffer.from(data).toString("base64");

// The snapshot (when the reader is behind it) and every update after.
export function documentLog(user: Identity, pageId: string, after: number) {
  const { page, space } = requireEncryptedDocument(user, pageId, false);
  const snapshot = one<{ upto: number; key_version: number; data: Uint8Array }>("SELECT * FROM e2ee_snapshots WHERE page_id=?", page.id);
  const fromSnapshot = !!snapshot && after < snapshot.upto;
  const start = fromSnapshot ? snapshot!.upto : after;
  const updates = all<{ seq: number; key_version: number; data: Uint8Array }>(
    "SELECT seq,key_version,data FROM e2ee_updates WHERE page_id=? AND seq>? ORDER BY seq LIMIT 5000",
    page.id,
    start,
  );
  return {
    keyVersion: space.key_version,
    snapshot: fromSnapshot ? { upto: snapshot!.upto, version: snapshot!.key_version, data: toB64(snapshot!.data) } : null,
    updates: updates.map((u) => ({ seq: u.seq, version: u.key_version, data: toB64(u.data) })),
    // More than one answer holds: ask again from the last seq.
    more: updates.length === 5000,
    pending: one<{ n: number }>("SELECT count(*) n FROM e2ee_updates WHERE page_id=?", page.id)!.n,
  };
}

function ciphertext(value: unknown) {
  const text = b64(Math.ceil((MAX_UPDATE * 4) / 3) + 4).parse(value);
  const data = Buffer.from(text, "base64");
  // Format byte, IV and GCM tag at least (lib/e2ee.ts encryptContent).
  if (data.length < 29 || data[0] !== 1) throw new HttpError(400, "Ungültige Eingabe.");
  return data;
}

// ---- Commands ----

export function e2eeCommand(user: Identity, action: string, b: Record<string, unknown>, afterCommit: (() => void)[]): unknown {
  switch (action) {
    case "e2ee.identity.setup": {
      if (user.apiScope || user.demo) throw new HttpError(403, "Nicht erlaubt.");
      const data = z.object({ publicKey, wrappedPrivate: passphraseWrap, recoveryWrapped: recoveryWrap }).parse(b);
      if (one("SELECT 1 FROM e2ee_identities WHERE user_id=?", user.id)) throw new HttpError(409, "Die Verschlüsselung ist bereits eingerichtet.");
      run(
        "INSERT INTO e2ee_identities(user_id,public_key,wrapped_private,recovery_wrapped,version,created_at,updated_at) VALUES(?,?,?,?,1,?,?)",
        user.id,
        data.publicKey,
        JSON.stringify(data.wrappedPrivate),
        JSON.stringify(data.recoveryWrapped),
        Date.now(),
        Date.now(),
      );
      audit(user.id, "e2ee.identity.setup", user.id);
      return { ok: true };
    }
    // New passphrase or new recovery key: the key pair stays, only its wraps change.
    case "e2ee.identity.update": {
      if (user.apiScope) throw new HttpError(403, "Nicht erlaubt.");
      const data = z
        .object({ version: z.number().int(), wrappedPrivate: passphraseWrap.optional(), recoveryWrapped: recoveryWrap.optional() })
        .parse(b);
      const current = requireIdentity(user.id);
      if (current.version !== data.version) throw new HttpError(409, "Die Schlüssel wurden inzwischen geändert. Bitte neu laden.");
      run(
        "UPDATE e2ee_identities SET wrapped_private=?,recovery_wrapped=?,version=version+1,updated_at=? WHERE user_id=?",
        data.wrappedPrivate ? JSON.stringify(data.wrappedPrivate) : current.wrapped_private,
        data.recoveryWrapped ? JSON.stringify(data.recoveryWrapped) : current.recovery_wrapped,
        Date.now(),
        user.id,
      );
      audit(user.id, "e2ee.identity.update", user.id);
      return { ok: true };
    }
    // Passphrase and recovery key both lost: start over. The keys of every
    // space are gone for this person; a member has to add them again.
    case "e2ee.identity.reset": {
      if (user.apiScope) throw new HttpError(403, "Nicht erlaubt.");
      run("DELETE FROM e2ee_space_keys WHERE user_id=?", user.id);
      run("DELETE FROM e2ee_identities WHERE user_id=?", user.id);
      audit(user.id, "e2ee.identity.reset", user.id);
      return { ok: true };
    }
    case "e2ee.member.add": {
      const data = z
        .object({
          spaceId: uuid,
          userId: uuid,
          role: z.enum(["editor", "viewer"]).default("editor"),
          keys: z.array(z.object({ version: z.number().int().min(1), sealed: sealedKey })).min(1).max(1000),
        })
        .parse(b);
      const space = requireEncryptedSpace(user, data.spaceId);
      if (!canManageSpace(user, space)) throw new HttpError(403, "Nur Bereichs- oder Arbeitsbereichseigentümer dürfen Mitglieder hinzufügen.");
      requireHolder(user, space);
      if (!memberRole({ ...user, id: data.userId }, space.workspace_id)) throw new HttpError(400, "Mitglied fehlt.");
      if (!one("SELECT 1 FROM e2ee_identities WHERE user_id=?", data.userId))
        throw new HttpError(409, "Diese Person hat die Verschlüsselung noch nicht eingerichtet.");
      if (holders(space.id, space.key_version!).includes(data.userId)) throw new HttpError(409, "Diese Person hat den Schlüssel bereits.");
      // Every key version I hold, so the new member reads older content too.
      const mine = heldVersions(space.id, user.id);
      const given = [...new Set(data.keys.map((k) => k.version))].sort((a, b) => a - b);
      if (given.length !== data.keys.length || given.join() !== mine.join())
        throw new HttpError(409, "Die Schlüssel des Bereichs wurden inzwischen geändert. Bitte neu laden.");
      for (const key of data.keys)
        run(
          "INSERT INTO e2ee_space_keys(space_id,user_id,key_version,sealed,sealed_by,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(space_id,user_id,key_version) DO UPDATE SET sealed=excluded.sealed,sealed_by=excluded.sealed_by",
          space.id,
          data.userId,
          key.version,
          JSON.stringify(key.sealed),
          user.id,
          Date.now(),
        );
      if (space.owner_id !== data.userId)
        run(
          "INSERT INTO grants(resource_id,user_id,group_id,role) VALUES(?,?,'',?) ON CONFLICT(resource_id,user_id,group_id) DO UPDATE SET role=excluded.role",
          space.id,
          data.userId,
          data.role,
        );
      audit(user.id, "e2ee.member.add", space.id, data.userId);
      return { ok: true };
    }
    // Removing a member (or leaving): their grant and sealed keys go, and
    // the space needs a new key before anything new is written
    // (e2ee.rotate, done right away by the remover's browser).
    case "e2ee.member.remove": {
      const data = z.object({ spaceId: uuid, userId: uuid }).parse(b);
      const space = requireEncryptedSpace(user, data.spaceId);
      if (data.userId !== user.id && !canManageSpace(user, space))
        throw new HttpError(403, "Nur Bereichs- oder Arbeitsbereichseigentümer dürfen Mitglieder entfernen.");
      if (data.userId === space.owner_id) throw new HttpError(409, "Die Eigentümerin oder der Eigentümer des Bereichs bleibt Mitglied.");
      run("DELETE FROM grants WHERE resource_id=? AND user_id=? AND group_id=''", space.id, data.userId);
      run("DELETE FROM e2ee_space_keys WHERE space_id=? AND user_id=?", space.id, data.userId);
      run("UPDATE spaces SET rotate_pending=1 WHERE id=?", space.id);
      audit(user.id, "e2ee.member.remove", space.id, data.userId);
      return { ok: true, rotate: true };
    }
    // A new space key for everyone who still holds the current one.
    case "e2ee.rotate": {
      const data = z
        .object({ spaceId: uuid, version: z.number().int().min(2), keys: z.array(z.object({ userId: uuid, sealed: sealedKey })).min(1).max(10000) })
        .parse(b);
      const space = requireEncryptedSpace(user, data.spaceId);
      requireHolder(user, space);
      if (data.version !== space.key_version! + 1) throw new HttpError(409, "Der Schlüssel des Bereichs wurde inzwischen erneuert. Bitte neu laden.");
      const expected = holders(space.id, space.key_version!)
        .filter((uid) => spaceRole({ ...user, id: uid }, space))
        .sort();
      const given = data.keys.map((k) => k.userId).sort();
      if (new Set(given).size !== given.length || given.join() !== expected.join())
        throw new HttpError(409, "Die Mitglieder des Bereichs haben sich geändert. Bitte neu laden.");
      for (const key of data.keys)
        run(
          "INSERT INTO e2ee_space_keys(space_id,user_id,key_version,sealed,sealed_by,created_at) VALUES(?,?,?,?,?,?)",
          space.id,
          key.userId,
          data.version,
          JSON.stringify(key.sealed),
          user.id,
          Date.now(),
        );
      run("UPDATE spaces SET key_version=?,rotate_pending=0 WHERE id=?", data.version, space.id);
      audit(user.id, "e2ee.rotate", space.id, String(data.version));
      return { ok: true, keyVersion: data.version };
    }
    case "e2ee.append": {
      const pageId = uuid.parse(b.pageId);
      const version = z.number().int().parse(b.version);
      const { page, space } = requireEncryptedDocument(user, pageId, true);
      requireHolder(user, space);
      if (space.rotate_pending) throw new HttpError(409, "Der Schlüssel des Bereichs muss erneuert werden.");
      if (version !== space.key_version) throw new HttpError(409, "Der Schlüssel des Bereichs wurde erneuert. Bitte neu laden.");
      const data = ciphertext(b.data);
      const seq = Number(
        run(
          "INSERT INTO e2ee_updates(page_id,key_version,data,created_by,created_at) VALUES(?,?,?,?,?)",
          page.id,
          version,
          data,
          user.id,
          Date.now(),
        ).lastInsertRowid,
      );
      run("UPDATE pages SET updated_at=CURRENT_TIMESTAMP WHERE id=?", page.id);
      const client = typeof b.client === "string" && b.client.length <= 100 ? b.client : undefined;
      const encoded = data.toString("base64");
      afterCommit.push(() => publishEncryptedUpdate(documentKey(page.id, null, E2EE_GENERATION), { seq, version, data: encoded }, client));
      return { seq };
    }
    // Compaction: the encrypted full state up to `upto` replaces the
    // snapshot and the updates it contains.
    case "e2ee.compact": {
      const pageId = uuid.parse(b.pageId);
      const upto = z.number().int().min(1).parse(b.upto);
      const version = z.number().int().parse(b.version);
      const { page, space } = requireEncryptedDocument(user, pageId, true);
      requireHolder(user, space);
      if (version !== space.key_version) throw new HttpError(409, "Der Schlüssel des Bereichs wurde erneuert. Bitte neu laden.");
      const last = one<{ seq: number | null }>("SELECT max(seq) seq FROM e2ee_updates WHERE page_id=?", page.id)?.seq;
      const current = one<{ upto: number }>("SELECT upto FROM e2ee_snapshots WHERE page_id=?", page.id)?.upto || 0;
      if (!last || upto > last || upto <= current) throw new HttpError(409, "Inzwischen gibt es neuere Änderungen.");
      const data = ciphertext(b.data);
      run(
        "INSERT INTO e2ee_snapshots(page_id,upto,key_version,data,created_by,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(page_id) DO UPDATE SET upto=excluded.upto,key_version=excluded.key_version,data=excluded.data,created_by=excluded.created_by,created_at=excluded.created_at",
        page.id,
        upto,
        version,
        data,
        user.id,
        Date.now(),
      );
      run("DELETE FROM e2ee_updates WHERE page_id=? AND seq<=?", page.id, upto);
      return { ok: true };
    }
    case "e2ee.title": {
      const pageId = uuid.parse(b.pageId);
      const page = requirePage(user, pageId, true);
      const space = encryptedSpace(page.space_id);
      if (!space?.encrypt_titles) throw new HttpError(400, "In diesem Bereich sind Titel nicht verschlüsselt.");
      requireHolder(user, space);
      const cipher = titleCipher.parse(b.cipher);
      if (JSON.parse(cipher).v !== space.key_version) throw new HttpError(409, "Der Schlüssel des Bereichs wurde erneuert. Bitte neu laden.");
      run("UPDATE pages SET title=?,title_cipher=?,updated_at=CURRENT_TIMESTAMP WHERE id=?", ENCRYPTED_TITLE, cipher, page.id);
      return { ok: true };
    }
  }
  throw new HttpError(400, "Unbekannte Aktion.");
}

// ---- Page data and the encrypted archive ----

export function encryptedPageData(user: Identity, page: Page) {
  const space = encryptedSpace(page.space_id)!;
  return {
    page,
    role: pageRole(user, page),
    encrypted: {
      spaceId: space.id,
      keyVersion: space.key_version,
      encryptTitles: !!space.encrypt_titles,
    },
    images: [],
    files: [],
    publication: null,
    shareLinks: [],
    comments: [],
    snapshots: [],
    present: [],
    backlinks: [],
    html: "",
    state: null,
    generation: E2EE_GENERATION,
  };
}

// Everything of an encrypted space as the server holds it: ciphertext,
// sealed keys and my wrapped private key. Readable later with the
// passphrase or recovery key alone (no server needed).
export function encryptedArchive(user: Identity, spaceId: string) {
  const space = requireEncryptedSpace(user, spaceId);
  const pages = all<Page & { title_cipher: string | null }>(
    "SELECT * FROM pages WHERE space_id=? AND deleted_at IS NULL ORDER BY position,id",
    space.id,
  ).filter((page) => pageRole(user, page));
  return {
    format: "flowplan-e2ee-1",
    exportedAt: new Date().toISOString(),
    space: { id: space.id, name: space.name, keyVersion: space.key_version, encryptTitles: !!space.encrypt_titles },
    identity: identityOf(user.id),
    keys: all<{ key_version: number; sealed: string }>(
      "SELECT key_version,sealed FROM e2ee_space_keys WHERE space_id=? AND user_id=? ORDER BY key_version",
      space.id,
      user.id,
    ).map((k) => ({ version: k.key_version, sealed: JSON.parse(k.sealed) })),
    pages: pages.map((page) => {
      const snapshot = one<{ upto: number; key_version: number; data: Uint8Array }>("SELECT * FROM e2ee_snapshots WHERE page_id=?", page.id);
      return {
        id: page.id,
        parentId: page.parent_id,
        title: page.title,
        titleCipher: page.title_cipher,
        icon: page.icon,
        updatedAt: page.updated_at,
        snapshot: snapshot ? { upto: snapshot.upto, version: snapshot.key_version, data: toB64(snapshot.data) } : null,
        updates: all<{ seq: number; key_version: number; data: Uint8Array }>(
          "SELECT seq,key_version,data FROM e2ee_updates WHERE page_id=? ORDER BY seq",
          page.id,
        ).map((u) => ({ seq: u.seq, version: u.key_version, data: toB64(u.data) })),
        files: all<{ id: string; size: number }>("SELECT id,size FROM files WHERE page_id=?", page.id),
      };
    }),
  };
}
