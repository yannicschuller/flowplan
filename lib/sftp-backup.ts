// SFTP as a target of the scheduled backup (#128), set up in Administration
// → Speicher & Sicherung. Every scheduled (or "Back up now") copy of the
// database – encrypted with FLOWPLAN_ENCRYPTION_KEY like the copies in S3
// and the data folder – goes to <folder>/flowplan-….sqlite[.enc]; the
// newest N are kept. With "files" on, <folder>/uploads/ mirrors the uploads
// (each encrypted on its own with the key; files deleted here are removed
// there as well), so database and files can be restored on a new instance
// (lib/setup-restore.ts).
//
// Stored in instance_settings under "sftpBackup"; password, private key
// and passphrase sealed with the key for stored secrets (lib/secret-box.ts),
// never shown again or logged. Host key: trust on first use – "Test
// connection" shows the fingerprint, the admin confirms it; a changed key
// stops every backup until it is confirmed again.
import { createReadStream, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { audit, one, run } from "./db";
import { HttpError } from "./auth";
import { openSecret, sealSecret } from "./secret-box";
import { encryptionEnabled, sealStream } from "./encryption";
import { BACKUP_FILE, beyondKeep, copyPath, databaseCopy } from "./backup-copy";
import {
  HostKeyError,
  connectSftp,
  remoteDirectory,
  remotePath,
  sftpHost,
  sftpList,
  sftpMkdirs,
  sftpReplace,
  sftpUnlink,
  sftpUpload,
  type SftpLogin,
  type SftpSession,
} from "./sftp";

const SETTING = "sftpBackup";
const LAST = "sftpBackup";
const SEEN = "sftpBackupSeen";
const UPLOAD = /^[A-Za-z0-9_-]{1,100}$/;
const dataDir = () => resolve(/* turbopackIgnore: true */ process.env.FLOWPLAN_DATA_DIR || "./data");

type Stored = {
  enabled: boolean;
  host: string;
  port: number;
  username: string;
  auth: "password" | "key";
  password: string;
  privateKey: string;
  passphrase: string;
  directory: string;
  keep: number;
  uploads: boolean;
  hostKey: string | null;
};
export type SftpRun = { at: number; name: string; bytes: number; files: number; removed: number; error: string | null };

function readJson<T>(table: "instance_settings" | "instance_state", key: string): T | null {
  const row = one<{ value: string }>(`SELECT value FROM ${table} WHERE key=?`, key);
  try {
    return row ? (JSON.parse(row.value) as T) : null;
  } catch {
    return null;
  }
}
function writeJson(table: "instance_settings" | "instance_state", key: string, value: unknown) {
  run(`INSERT INTO ${table}(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, key, JSON.stringify(value));
}
const stored = () => readJson<Stored>("instance_settings", SETTING);
const AAD = { password: "sftp-backup:password", privateKey: "sftp-backup:private-key", passphrase: "sftp-backup:passphrase" } as const;

export function sftpBackupActive() {
  const s = stored();
  return !!s?.enabled && !!s.host;
}

function login(s: Stored): SftpLogin {
  const open = (value: string, aad: string) => {
    if (!value) return "";
    try {
      return openSecret(value, aad);
    } catch {
      throw new HttpError(409, "Die gespeicherten SFTP-Zugangsdaten lassen sich nicht entschlüsseln – bitte neu eingeben.");
    }
  };
  return {
    host: s.host,
    port: s.port,
    username: s.username,
    ...(s.auth === "key"
      ? { privateKey: open(s.privateKey, AAD.privateKey), passphrase: open(s.passphrase, AAD.passphrase) || undefined }
      : { password: open(s.password, AAD.password) }),
  };
}

// For the admin page: everything but the secrets.
export function sftpBackupSettings() {
  const s = stored();
  return {
    enabled: !!s?.enabled,
    host: s?.host || "",
    port: s?.port || 22,
    username: s?.username || "",
    auth: s?.auth || ("password" as const),
    hasPassword: !!s?.password,
    hasPrivateKey: !!s?.privateKey,
    hasPassphrase: !!s?.passphrase,
    directory: s?.directory || "flowplan-backups",
    keep: s?.keep || 14,
    uploads: s?.uploads ?? true,
    hostKey: s?.hostKey || null,
  };
}
export function sftpBackupStatus() {
  const s = stored();
  return { enabled: !!s?.enabled && !!s.host, hostKey: s?.hostKey || null, last: readJson<SftpRun>("instance_state", LAST) };
}

// A secret field: left out keeps the stored one, "" removes it.
const secret = z.string().max(20_000).optional();
const settingsSchema = z.object({
  enabled: z.boolean(),
  host: z.string().max(260),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().trim().min(1).max(200),
  auth: z.enum(["password", "key"]),
  password: secret,
  privateKey: secret,
  passphrase: secret,
  directory: z.string().max(500).default("flowplan-backups"),
  keep: z.number().int().min(1).max(365).default(14),
  uploads: z.boolean().default(true),
});
export function saveSftpBackup(actor: string, input: unknown) {
  const parsed = settingsSchema.safeParse(input);
  if (!parsed.success) throw new HttpError(400, "Bitte Server, Benutzer und Anmeldung des SFTP-Ziels angeben.");
  const b = parsed.data;
  const host = sftpHost(b.host);
  const directory = remoteDirectory(b.directory);
  const before = stored();
  const keep = (value: string | undefined, old: string | undefined, aad: string) =>
    value === undefined ? old || "" : value ? sealSecret(value, aad) : "";
  if (b.privateKey && !/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(b.privateKey))
    throw new HttpError(400, "Der private Schlüssel kann nicht gelesen werden (Format oder Passphrase).");
  // Another server (or port) has another host key: it is confirmed anew.
  const sameServer = before && before.host === host && before.port === b.port;
  const next: Stored = {
    enabled: b.enabled,
    host,
    port: b.port,
    username: b.username,
    auth: b.auth,
    password: keep(b.password, before?.password, AAD.password),
    privateKey: keep(b.privateKey, before?.privateKey, AAD.privateKey),
    passphrase: keep(b.passphrase, before?.passphrase, AAD.passphrase),
    directory,
    keep: b.keep,
    uploads: b.uploads,
    hostKey: sameServer ? before.hostKey : null,
  };
  if (next.auth === "password" && !next.password) throw new HttpError(400, "Bitte das Passwort für den SFTP-Server angeben.");
  if (next.auth === "key" && !next.privateKey) throw new HttpError(400, "Bitte den privaten Schlüssel für den SFTP-Server angeben.");
  writeJson("instance_settings", SETTING, next);
  // Never the secrets, only what changed about them.
  audit(actor, "backup.sftp.saved", "", JSON.stringify({ host, port: b.port, username: b.username, auth: b.auth, directory, enabled: b.enabled }));
  return sftpBackupSettings();
}
export function removeSftpBackup(actor: string) {
  run("DELETE FROM instance_settings WHERE key=?", SETTING);
  run("DELETE FROM instance_state WHERE key IN (?,?)", LAST, SEEN);
  audit(actor, "backup.sftp.removed", "");
  return sftpBackupSettings();
}

function remember(s: Stored, fingerprint: string) {
  writeJson("instance_state", SEEN, { host: s.host, port: s.port, fingerprint, at: Date.now() });
}

// "Test connection": learns the host key without sending credentials while
// it is unknown or changed; with the confirmed key it signs in, creates the
// folder and writes (and removes) a test file.
export async function testSftpBackup() {
  const s = stored();
  if (!s?.host) throw new HttpError(400, "Zuerst das SFTP-Ziel speichern.");
  let session: SftpSession;
  try {
    session = await connectSftp(login(s), s.hostKey);
  } catch (error) {
    if (error instanceof HostKeyError) {
      remember(s, error.fingerprint);
      return { state: error.expected ? ("changed" as const) : ("unknown" as const), fingerprint: error.fingerprint, expected: error.expected, backups: 0 };
    }
    throw error;
  }
  try {
    await sftpMkdirs(session.sftp, s.directory);
    const probe = remotePath(s.directory, `.flowplan-test-${Date.now()}`);
    await new Promise<void>((done, fail) => session.sftp.writeFile(probe, "flowplan", (e) => (e ? fail(e) : done())));
    await sftpUnlink(session.sftp, probe);
    const backups = (await sftpList(session.sftp, s.directory)).filter((e) => BACKUP_FILE.test(e.filename)).length;
    return { state: "ok" as const, fingerprint: session.fingerprint, expected: s.hostKey, backups };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Der Ordner auf dem SFTP-Server ist nicht beschreibbar.");
  } finally {
    session.end();
  }
}

// Confirms the host key the last test saw for this server.
export function trustSftpHostKey(actor: string, fingerprint: unknown) {
  const s = stored();
  const seen = readJson<{ host: string; port: number; fingerprint: string; at: number }>("instance_state", SEEN);
  if (!s || typeof fingerprint !== "string" || !seen || seen.host !== s.host || seen.port !== s.port || seen.fingerprint !== fingerprint || Date.now() - seen.at > 3_600_000)
    throw new HttpError(409, "Bitte zuerst die Verbindung testen und dann den angezeigten Hostschlüssel bestätigen.");
  writeJson("instance_settings", SETTING, { ...s, hostKey: fingerprint });
  audit(actor, s.hostKey ? "backup.sftp.hostkey-changed" : "backup.sftp.hostkey-trusted", "", JSON.stringify({ host: s.host, port: s.port, fingerprint, previous: s.hostKey }));
  return sftpBackupSettings();
}

// Uploads missing files to <folder>/uploads/ and removes what is gone here.
async function mirrorUploads(session: SftpSession, folder: string) {
  const local = resolve(dataDir(), "uploads");
  const mine = existsSync(local) ? readdirSync(local).filter((n) => UPLOAD.test(n)) : [];
  const remoteDir = remotePath(folder, "uploads");
  await sftpMkdirs(session.sftp, remoteDir);
  const theirs = new Set<string>();
  for (const entry of await sftpList(session.sftp, remoteDir)) {
    if (UPLOAD.test(entry.filename)) theirs.add(entry.filename);
    // Left over from an interrupted run.
    else if (/^[A-Za-z0-9_-]{1,100}\.part$/.test(entry.filename)) await sftpUnlink(session.sftp, remotePath(remoteDir, entry.filename)).catch(() => {});
  }
  const encrypted = encryptionEnabled();
  let files = 0,
    removed = 0;
  for (const name of mine) {
    if (theirs.delete(name)) continue;
    const path = resolve(local, name);
    if (!statSync(path).isFile()) continue;
    const part = remotePath(remoteDir, `${name}.part`);
    if (encrypted) await pipeline(createReadStream(path), sealStream(), session.sftp.createWriteStream(part));
    else await sftpUpload(session.sftp, path, part);
    await sftpReplace(session.sftp, part, remotePath(remoteDir, name));
    files++;
  }
  for (const name of theirs) {
    await sftpUnlink(session.sftp, remotePath(remoteDir, name));
    removed++;
  }
  return { files, removed };
}

// Sends a finished copy (lib/scheduled-backup.ts makes one for all targets)
// and records the outcome; never throws.
export async function sendToSftp(copy: { copy: string; name: string; bytes: number }, now = Date.now()): Promise<SftpRun> {
  let result: SftpRun;
  let session: SftpSession | null = null;
  try {
    const s = stored();
    if (!s?.host) throw new HttpError(400, "Kein SFTP-Ziel eingerichtet.");
    if (!s.hostKey) throw new HttpError(409, "Der Hostschlüssel des SFTP-Servers ist noch nicht bestätigt.");
    session = await connectSftp(login(s), s.hostKey);
    await sftpMkdirs(session.sftp, s.directory);
    const part = remotePath(s.directory, `${copy.name}.part`);
    await sftpUpload(session.sftp, copy.copy, part);
    await sftpReplace(session.sftp, part, remotePath(s.directory, copy.name));
    const names = (await sftpList(session.sftp, s.directory)).map((e) => e.filename);
    for (const old of beyondKeep(names.filter((n) => BACKUP_FILE.test(n)), s.keep)) await sftpUnlink(session.sftp, remotePath(s.directory, old));
    const mirrored = s.uploads ? await mirrorUploads(session, s.directory) : { files: 0, removed: 0 };
    result = { at: now, name: copy.name, bytes: copy.bytes, ...mirrored, error: null };
  } catch (error) {
    const message = error instanceof HttpError ? error.message : `SFTP: ${String((error as Error)?.message || error)}`;
    result = { at: now, name: copy.name, bytes: 0, files: 0, removed: 0, error: message.slice(0, 300) };
  } finally {
    session?.end();
  }
  writeJson("instance_state", LAST, result);
  return result;
}

// "Back up now" of the SFTP target alone.
export async function runSftpBackup(now = Date.now()) {
  if (!stored()?.host) throw new HttpError(400, "Zuerst das SFTP-Ziel speichern.");
  const path = copyPath();
  try {
    let made: ReturnType<typeof databaseCopy>;
    try {
      made = databaseCopy(now, path);
    } catch (error) {
      const result: SftpRun = { at: now, name: "", bytes: 0, files: 0, removed: 0, error: String((error as Error)?.message || error).slice(0, 300) };
      writeJson("instance_state", LAST, result);
      return result;
    }
    return await sendToSftp(made, now);
  } finally {
    if (existsSync(path)) rmSync(path);
  }
}
