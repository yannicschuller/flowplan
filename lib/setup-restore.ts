// Restore from a backup while setting up a new instance (#128): on the first
// start, before any account exists, "Restore from a backup" on the setup
// screen takes
//   - an uploaded file: a scheduled backup (flowplan-….sqlite[.enc], only the
//     database; flowplan-….dump[.enc] from a PostgreSQL instance, only into
//     PostgreSQL) or a download of the whole instance (flowplan-instanz-….zip
//     [.enc], database and files), or
//   - the newest scheduled backup from an S3 bucket or SFTP server entered
//     there, with the files mirrored next to it (S3: <prefix>/uploads/, SFTP:
//     <folder>/uploads/; files deleted since then from .deleted/uploads/).
// Encrypted backups need the old instance's FLOWPLAN_ENCRYPTION_KEY (entered
// in the form, or configured here). The database is checked (integrity,
// a Flowplan database, schema not newer than this version; older ones are
// migrated when they open) and swapped in right away; with Litestream the
// container's start does it (docker/entrypoint.sh), after a restart.
//
// Guarded: only while the instance has no account, only with the setup
// token when FLOWPLAN_SETUP_TOKEN is set (and only with it when password
// sign-in is off), with the origin check and a limit per address. Once an
// account exists, every endpoint refuses.
import { copyFileSync, createWriteStream, mkdirSync, openSync, readSync, closeSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DatabaseSync } from "node:sqlite";
import { AwsClient } from "aws4fetch";
import { z } from "zod";
import { SCHEMA_VERSION, audit, id, reopenDatabase, sql } from "./db";
import { dumpSummary } from "./pg-backup";
import { HttpError } from "./auth";
import { firstAccount, localLoginEnabled, setupAllowed, setupToken } from "./local-auth";
import { encryptionEnabled, fileIsEncrypted, fileKeyKnown, isEncrypted, parseKey, unseal, unsealFile, type Key } from "./encryption";
import { INSTANCE_ARCHIVE_LIMIT, cancelRestore, checkBackupDatabase, stageInstanceRestore, type Summary } from "./instance-backup";
import { BACKUP_FILE } from "./backup-copy";
import { DELETED_UPLOADS, newestDeleted, parseDeleted, type DeletedCopy } from "./deleted-uploads";
import { HostKeyError, connectSftp, remoteDirectory, remotePath, sftpDownload, sftpHost, sftpList, type SftpLogin, type SftpSession } from "./sftp";
import { storageConfig } from "./storage";

const dataDir = () => resolve(/* turbopackIgnore: true */ process.env.FLOWPLAN_DATA_DIR || "./data");
const UPLOAD = /^[A-Za-z0-9_-]{1,100}$/;
export const SETUP_RESTORE_LIMIT = INSTANCE_ARCHIVE_LIMIT;

export type RestoreResult = Summary & { missingFiles: number; restart: boolean; keyHint: boolean };
export type RestoreProgress = {
  source: "upload" | "s3" | "sftp";
  phase: "connect" | "download" | "check" | "files" | "apply" | "done" | "error";
  bytesDone: number;
  bytesTotal: number;
  filesDone: number;
  filesTotal: number;
  startedAt: number;
  error: string | null;
  needsKey: boolean;
  result: RestoreResult | null;
};
const runtime = globalThis as unknown as { flowplanSetupRestore?: RestoreProgress | null };
const running = () => {
  const p = runtime.flowplanSetupRestore;
  return !!p && p.phase !== "done" && p.phase !== "error";
};

// The encrypted backup needs a key that is not here.
export class KeyRequired extends HttpError {
  needsKey = true;
  constructor(given: boolean) {
    super(
      400,
      given
        ? "Der Schlüssel passt nicht zu dieser Sicherung."
        : "Die Sicherung ist verschlüsselt. Bitte den Schlüssel der alten Instanz (FLOWPLAN_ENCRYPTION_KEY) eingeben.",
    );
  }
}

// ---- Who may ----

export async function setupRestoreOpen(token?: unknown) {
  return await firstAccount() && (localLoginEnabled() || !!setupToken()) && setupAllowed(token);
}
export async function requireSetupRestore(token: unknown) {
  if (!(await firstAccount())) throw new HttpError(403, "Diese Instanz ist schon eingerichtet. Wiederherstellen geht hier nur über die Administration.");
  if (!setupAllowed(token) || (!localLoginEnabled() && !setupToken()))
    throw new HttpError(403, "Diese Instanz wird mit einem Einrichtungslink eingerichtet. Frag die Person, die sie betreibt.");
}
export function setupRestoreStatus() {
  return {
    progress: runtime.flowplanSetupRestore ?? null,
    // With Litestream the swap needs a restart of the container.
    litestream: process.env.FLOWPLAN_LITESTREAM_ACTIVE === "1",
    encryption: (() => {
      try {
        return encryptionEnabled();
      } catch {
        return false;
      }
    })(),
  };
}

// ---- The file ----

export function keysFrom(text: unknown): Key[] {
  if (typeof text !== "string" || !text.trim()) return [];
  try {
    return [parseKey(text, "Schlüssel")];
  } catch {
    throw new HttpError(400, "Der Schlüssel muss 32 Bytes lang sein (base64 oder 64 Hex-Zeichen).");
  }
}
function head(path: string, length: number) {
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    return buffer.subarray(0, readSync(fd, buffer, 0, length, 0));
  } finally {
    closeSync(fd);
  }
}
const SQLITE = Buffer.from("SQLite format 3\0");
// pg_dump's custom format (a scheduled backup of a PostgreSQL instance).
const PGDUMP_MAGIC = Buffer.from("PGDMP");
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

// flowplan-2026-11-06-03-00.sqlite → when the scheduled backup was made.
export function dateFromName(name: unknown) {
  const m = typeof name === "string" ? /flowplan-(\d{4}-\d{2}-\d{2})-(\d{2})-(\d{2})\.(sqlite|dump)/.exec(name) : null;
  return m ? `${m[1]}T${m[2]}:${m[3]}:00.000Z` : "";
}

type Fetcher = (ids: string[], folder: string, progress: RestoreProgress) => Promise<number>;

// Checks, stages and applies a backup file. `fetchFiles` brings the uploads
// a database-only backup refers to (from the bucket or SFTP server).
export async function restoreBackupFile(path: string, keys: Key[], progress: RestoreProgress, fetchFiles?: Fetcher, createdAt = ""): Promise<RestoreResult> {
  const tmp = resolve(dataDir(), "tmp");
  mkdirSync(tmp, { recursive: true });
  const plain = resolve(tmp, `setup-restore-${id()}.plain`);
  const staging = resolve(dataDir(), `restore-staging-${id()}`);
  try {
    progress.phase = "check";
    let file = path;
    if (fileIsEncrypted(path)) {
      if (!fileKeyKnown(path, keys)) throw new KeyRequired(keys.length > 0);
      try {
        await unsealFile(path, plain, keys);
      } catch {
        throw new HttpError(400, "Entschlüsseln fehlgeschlagen: falscher Schlüssel oder beschädigte Datei.");
      }
      file = plain;
    }
    const start = head(file, 16);
    let summary: Summary;
    let missingFiles = 0;
    if (start.subarray(0, 4).equals(ZIP)) {
      // The whole instance: database and files (lib/instance-backup.ts).
      summary = await stageInstanceRestore(file);
    } else if (start.equals(SQLITE) || start.subarray(0, 5).equals(PGDUMP_MAGIC)) {
      mkdirSync(resolve(staging, "uploads"), { recursive: true });
      let checked: Omit<Summary, "createdAt" | "files">;
      let ids: string[];
      if (start.equals(SQLITE)) {
        const database = resolve(staging, "flowplan.sqlite");
        if (file === plain) renameSync(plain, database);
        else copyFileSync(file, database);
        checked = checkBackupDatabase(database);
        const reader = new DatabaseSync(database, { readOnly: true });
        try {
          ids = (reader.prepare("SELECT id FROM files").all() as { id: string }[]).map((r) => String(r.id)).filter((n) => UPLOAD.test(n));
        } finally {
          reader.close();
        }
      } else {
        // A scheduled backup of a PostgreSQL instance (pg_dump,
        // lib/pg-backup.ts): restored with pg_restore, so only into
        // PostgreSQL. lib/db-restore.ts loads it when the database opens.
        if (sql.name !== "postgres")
          throw new HttpError(
            400,
            "Diese Sicherung ist ein PostgreSQL-Dump (pg_dump) und lässt sich nur in einer Instanz mit PostgreSQL wiederherstellen. Für einen Wechsel zu SQLite: die Sicherung der gesamten Instanz (.zip) oder der Instanzumzug.",
          );
        const dump = resolve(staging, "flowplan.dump");
        if (file === plain) renameSync(plain, dump);
        else copyFileSync(file, dump);
        let found: Awaited<ReturnType<typeof dumpSummary>>;
        try {
          found = await dumpSummary(dump);
        } catch (error) {
          console.error("Wiederherstellung beim Einrichten: Dump nicht lesbar", (error as Error)?.message);
          throw new HttpError(400, "Die Sicherung enthält keine gültige Flowplan-Datenbank.");
        }
        if (found.version > SCHEMA_VERSION)
          throw new HttpError(400, "Die Sicherung stammt aus einer neueren Flowplan-Version. Bitte zuerst Flowplan auf diese Version aktualisieren.");
        checked = { users: found.users, workspaces: found.workspaces, pages: found.pages, schema: found.version };
        ids = found.fileIds.filter((n) => UPLOAD.test(n));
      }
      if (fetchFiles) {
        progress.phase = "files";
        progress.filesTotal = ids.length;
        progress.filesDone = 0;
        missingFiles = await fetchFiles(ids, resolve(staging, "uploads"), progress);
      } else if (ids.length) {
        // An uploaded database-only backup brings no files: what this
        // instance's own bucket (S3_*) does not have is missing.
        const there = await bucketUploads().catch((error) => {
          console.error("Wiederherstellung beim Einrichten: Bucket nicht lesbar", (error as Error)?.message);
          return new Set<string>();
        });
        missingFiles = ids.filter((name) => !there.has(name)).length;
      }
      summary = { createdAt, ...checked, files: progress.filesDone };
      writeFileSync(resolve(staging, "READY"), JSON.stringify(summary));
      cancelRestore();
      renameSync(staging, resolve(dataDir(), "restore-pending"));
    } else throw new HttpError(400, "Das ist keine Flowplan-Sicherung (weder Datenbank noch Instanzsicherung).");
    // Someone set the instance up in the meantime: nothing is replaced.
    if (!(await firstAccount())) {
      cancelRestore();
      throw new HttpError(403, "Diese Instanz ist schon eingerichtet. Wiederherstellen geht hier nur über die Administration.");
    }
    progress.phase = "apply";
    const restart = process.env.FLOWPLAN_LITESTREAM_ACTIVE === "1";
    if (!restart) await reopenDatabase();
    const keyHint = keys.length > 0 && !setupRestoreStatus().encryption;
    await audit("", "instance.restore.setup", "", JSON.stringify({ ...summary, missingFiles, source: progress.source, restart }));
    return { ...summary, missingFiles, restart, keyHint };
  } finally {
    rmSync(plain, { force: true });
    rmSync(staging, { recursive: true, force: true });
  }
}

// The uploads in the bucket this instance is configured with (S3_*): they
// are fetched from there when needed (lib/storage.ts, ensureLocal).
async function bucketUploads() {
  const config = storageConfig();
  if (!config) return new Set<string>();
  const { accessKeyId, secretAccessKey, region } = config;
  const aws = new AwsClient({ accessKeyId, secretAccessKey, service: "s3", region, retries: 1 });
  const folder = [config.prefix, "uploads/"].filter(Boolean).join("/");
  return new Set((await listS3(aws, `${config.endpoint}/${encodeURIComponent(config.bucket)}`, folder)).map((k) => k.slice(folder.length)));
}

// An uploaded file (the request streams it to disk first).
export async function restoreUpload(path: string, keyText: unknown, fileName?: unknown) {
  if (running()) throw new HttpError(409, "Es läuft schon eine Wiederherstellung.");
  const keys = keysFrom(keyText);
  const size = statSync(path).size;
  const progress: RestoreProgress = {
    source: "upload",
    phase: "check",
    bytesDone: size,
    bytesTotal: size,
    filesDone: 0,
    filesTotal: 0,
    startedAt: Date.now(),
    error: null,
    needsKey: false,
    result: null,
  };
  runtime.flowplanSetupRestore = progress;
  try {
    progress.result = await restoreBackupFile(path, keys, progress, undefined, dateFromName(fileName));
    progress.phase = "done";
    return progress.result;
  } catch (error) {
    progress.phase = "error";
    progress.error = error instanceof HttpError ? error.message : "Wiederherstellung fehlgeschlagen.";
    progress.needsKey = error instanceof KeyRequired;
    throw error;
  }
}

// ---- From a bucket or SFTP server ----

const s3Schema = z.object({
  endpoint: z.string().trim().url().max(500),
  bucket: z.string().trim().min(1).max(200),
  region: z.string().trim().max(100).optional(),
  prefix: z.string().trim().max(300).optional(),
  accessKeyId: z.string().trim().min(1).max(500),
  secretAccessKey: z.string().min(1).max(500),
});
const sftpSchema = z.object({
  host: z.string().max(260),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().trim().min(1).max(200),
  password: z.string().max(1000).optional(),
  privateKey: z.string().max(20_000).optional(),
  passphrase: z.string().max(1000).optional(),
  directory: z.string().max(500).default("flowplan-backups"),
  fingerprint: z.string().max(200).optional(),
});

function s3Target(input: unknown) {
  const parsed = s3Schema.safeParse(input);
  if (!parsed.success) throw new HttpError(400, "Bitte Adresse, Bucket und Zugangsschlüssel des S3-Speichers angeben.");
  const b = parsed.data;
  if (!/^https?:\/\//.test(b.endpoint)) throw new HttpError(400, "Die Adresse des S3-Speichers muss mit https:// oder http:// beginnen.");
  const prefix = (b.prefix ?? "flowplan").replace(/^\/+|\/+$/g, "");
  if (!/^[A-Za-z0-9._\-/]*$/.test(prefix) || prefix.split("/").includes("..")) throw new HttpError(400, "Ungültiger Ordner im Bucket.");
  const region = b.region || "us-east-1";
  const aws = new AwsClient({ accessKeyId: b.accessKeyId, secretAccessKey: b.secretAccessKey, service: "s3", region, retries: 1 });
  const base = `${b.endpoint.replace(/\/+$/, "")}/${encodeURIComponent(b.bucket)}`;
  const key = (path: string) => [prefix, path].filter(Boolean).join("/");
  return { aws, base, key, prefix };
}
function sftpTarget(input: unknown) {
  const parsed = sftpSchema.safeParse(input);
  if (!parsed.success) throw new HttpError(400, "Bitte Server, Benutzer und Anmeldung des SFTP-Ziels angeben.");
  const b = parsed.data;
  const login: SftpLogin = {
    host: sftpHost(b.host),
    port: b.port,
    username: b.username,
    ...(b.privateKey?.trim() ? { privateKey: b.privateKey, passphrase: b.passphrase || undefined } : { password: b.password || "" }),
  };
  return { login, directory: remoteDirectory(b.directory), fingerprint: b.fingerprint?.trim() || null };
}

// The SFTP server's host key, without signing in: shown in the form to be
// compared and confirmed before credentials are sent.
export async function probeSftp(input: unknown) {
  const { login } = sftpTarget(input);
  try {
    const session = await connectSftp({ ...login, password: undefined, privateKey: undefined }, null, 15_000);
    session.end();
  } catch (error) {
    if (error instanceof HostKeyError) return { fingerprint: error.fingerprint };
    throw error;
  }
  throw new HttpError(502, "Verbindung zum SFTP-Server fehlgeschlagen.");
}

// Writes a response body to a file, counting bytes.
async function saveBody(response: Response, target: string, progress: RestoreProgress, limit = SETUP_RESTORE_LIMIT) {
  if (!response.body) throw new HttpError(502, "Leere Antwort des Speichers.");
  let size = 0;
  const count = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      size += chunk.length;
      progress.bytesDone += chunk.length;
      if (size > limit) return done(new HttpError(413, "Sicherung ist zu groß."));
      done(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body as never), count, createWriteStream(target, { flags: "wx" }));
}

// All keys under a prefix, page by page.
async function listS3(aws: AwsClient, base: string, prefix: string) {
  const keys: string[] = [];
  let token = "";
  for (let page = 0; page < 1000; page++) {
    const response = await aws.fetch(`${base}?list-type=2&prefix=${encodeURIComponent(prefix)}${token ? `&continuation-token=${encodeURIComponent(token)}` : ""}`);
    if (!response.ok) throw new HttpError(502, `Liste: HTTP ${response.status}`);
    const xml = await response.text();
    keys.push(...[...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]));
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? (/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1] ?? "") : "";
    if (!token) break;
  }
  return keys;
}

async function fromS3(input: unknown, keys: Key[], progress: RestoreProgress) {
  const { aws, base, key } = s3Target(input);
  progress.phase = "connect";
  const list = await aws.fetch(`${base}?list-type=2&prefix=${encodeURIComponent(key("backups/"))}`).catch(() => {
    throw new HttpError(502, "Der S3-Speicher ist nicht erreichbar.");
  });
  if (list.status === 403 || list.status === 401) throw new HttpError(400, "Der S3-Speicher lehnt die Zugangsschlüssel ab.");
  if (!list.ok) throw new HttpError(502, `Liste der Sicherungen: HTTP ${list.status}`);
  const names = [...(await list.text()).matchAll(/<Key>([^<]+)<\/Key>/g)]
    .map((m) => m[1])
    .filter((k) => k.startsWith(key("backups/")) && BACKUP_FILE.test(k.slice(key("backups/").length)));
  const newest = names.sort().pop();
  if (!newest) throw new HttpError(404, "Im Bucket liegt keine geplante Sicherung (Ordner backups/).");
  const tmp = resolve(dataDir(), "tmp");
  mkdirSync(tmp, { recursive: true });
  const file = resolve(tmp, `setup-download-${id()}`);
  try {
    progress.phase = "download";
    const response = await aws.fetch(`${base}/${newest.split("/").map(encodeURIComponent).join("/")}`);
    if (!response.ok) throw new HttpError(502, `Herunterladen: HTTP ${response.status}`);
    progress.bytesTotal = Number(response.headers.get("content-length")) || 0;
    await saveBody(response, file, progress);
    const fetchFiles: Fetcher = async (ids, folder) => {
      // Files deleted after the backup was made wait in .deleted/uploads/
      // (lib/deleted-uploads.ts).
      let deleted: Map<string, DeletedCopy> | null = null;
      const deletedCopy = async (name: string) => {
        deleted ??= newestDeleted(
          (await listS3(aws, base, key(`${DELETED_UPLOADS}/`)).catch(() => []))
            .map((k) => parseDeleted(k.slice(key(`${DELETED_UPLOADS}/`).length)))
            .filter((c): c is DeletedCopy => !!c),
        );
        return deleted.get(name);
      };
      const get = (path: string) => aws.fetch(`${base}/${key(path).split("/").map(encodeURIComponent).join("/")}`).catch(() => null);
      let missing = 0;
      for (const name of ids) {
        let object = await get(`uploads/${name}`);
        if (!object?.ok) {
          const copy = await deletedCopy(name);
          if (copy) object = await get(`${DELETED_UPLOADS}/${copy.name}`);
        }
        if (!object?.ok) {
          missing++;
          continue;
        }
        const raw = Buffer.from(await object.arrayBuffer());
        let data: Buffer;
        try {
          data = unseal(raw, keys);
        } catch {
          throw isEncrypted(raw) ? new KeyRequired(keys.length > 0) : new HttpError(400, "Eine Datei im Bucket ist beschädigt.");
        }
        writeFileSync(resolve(folder, name), data, { flag: "wx" });
        progress.filesDone++;
      }
      return missing;
    };
    return await restoreBackupFile(file, keys, progress, fetchFiles, dateFromName(newest));
  } finally {
    rmSync(file, { force: true });
  }
}

async function fromSftp(input: unknown, keys: Key[], progress: RestoreProgress) {
  const { login, directory, fingerprint } = sftpTarget(input);
  if (!fingerprint) throw new HttpError(400, "Bitte zuerst den Hostschlüssel des SFTP-Servers prüfen und bestätigen.");
  progress.phase = "connect";
  const session: SftpSession = await connectSftp(login, fingerprint).catch((error) => {
    throw error instanceof HostKeyError ? new HttpError(409, "Der Hostschlüssel des SFTP-Servers stimmt nicht mit dem bestätigten überein.") : error;
  });
  const tmp = resolve(dataDir(), "tmp");
  mkdirSync(tmp, { recursive: true });
  const file = resolve(tmp, `setup-download-${id()}`);
  try {
    const entries = await sftpList(session.sftp, directory).catch(() => {
      throw new HttpError(404, "Den Ordner gibt es auf dem SFTP-Server nicht.");
    });
    const newest = entries
      .filter((e) => BACKUP_FILE.test(e.filename))
      .sort((a, b) => (a.filename < b.filename ? -1 : 1))
      .pop();
    if (!newest) throw new HttpError(404, "Im Ordner auf dem SFTP-Server liegt keine Sicherung.");
    if (newest.attrs.size > SETUP_RESTORE_LIMIT) throw new HttpError(413, "Sicherung ist zu groß.");
    progress.phase = "download";
    progress.bytesTotal = newest.attrs.size;
    await sftpDownload(session.sftp, remotePath(directory, newest.filename), file, (done) => {
      progress.bytesDone = done;
    });
    const fetchFiles: Fetcher = async (ids, folder) => {
      const there = new Set(
        (await sftpList(session.sftp, remotePath(directory, "uploads")).catch(() => [])).map((e) => e.filename).filter((n) => UPLOAD.test(n)),
      );
      // Files deleted after the backup was made wait in .deleted/uploads/
      // (lib/deleted-uploads.ts).
      const deleted = newestDeleted(
        (await sftpList(session.sftp, remotePath(directory, DELETED_UPLOADS)).catch(() => []))
          .map((e) => parseDeleted(e.filename))
          .filter((c): c is DeletedCopy => !!c),
      );
      let missing = 0;
      for (const name of ids) {
        const copy = there.has(name) ? null : deleted.get(name);
        if (!there.has(name) && !copy) {
          missing++;
          continue;
        }
        const target = resolve(folder, name);
        const download = `${target}.download`;
        await sftpDownload(session.sftp, remotePath(directory, copy ? `${DELETED_UPLOADS}/${copy.name}` : `uploads/${name}`), download);
        if (fileIsEncrypted(download)) {
          if (!fileKeyKnown(download, keys)) throw new KeyRequired(keys.length > 0);
          await unsealFile(download, target, keys);
          rmSync(download, { force: true });
        } else renameSync(download, target);
        progress.filesDone++;
      }
      return missing;
    };
    return await restoreBackupFile(file, keys, progress, fetchFiles, dateFromName(newest.filename));
  } finally {
    session.end();
    rmSync(file, { force: true });
  }
}

// Starts fetching and restoring in the background; the setup screen asks
// for the progress (setupRestoreStatus).
export function startRemoteRestore(source: "s3" | "sftp", input: unknown, keyText: unknown) {
  if (running()) throw new HttpError(409, "Es läuft schon eine Wiederherstellung.");
  const keys = keysFrom(keyText);
  // Checked now, so the form shows mistakes right away.
  if (source === "s3") s3Target(input);
  else if (!sftpTarget(input).fingerprint) throw new HttpError(400, "Bitte zuerst den Hostschlüssel des SFTP-Servers prüfen und bestätigen.");
  const progress: RestoreProgress = {
    source,
    phase: "connect",
    bytesDone: 0,
    bytesTotal: 0,
    filesDone: 0,
    filesTotal: 0,
    startedAt: Date.now(),
    error: null,
    needsKey: false,
    result: null,
  };
  runtime.flowplanSetupRestore = progress;
  void (source === "s3" ? fromS3(input, keys, progress) : fromSftp(input, keys, progress))
    .then((result) => {
      progress.result = result;
      progress.phase = "done";
    })
    .catch((error) => {
      progress.phase = "error";
      progress.needsKey = error instanceof KeyRequired;
      progress.error = error instanceof HttpError ? error.message : "Wiederherstellung fehlgeschlagen.";
      // Never the error object: it could carry what was entered.
      if (!(error instanceof HttpError)) console.error("Wiederherstellung beim Einrichten fehlgeschlagen:", (error as Error)?.message);
    });
  return progress;
}
// Waits for a running restore (tests).
export async function setupRestoreSettled() {
  while (running()) await new Promise((done) => setTimeout(done, 20));
  return runtime.flowplanSetupRestore ?? null;
}
// Where an upload is streamed to (the data folder's tmp).
export function uploadTarget() {
  const tmp = resolve(dataDir(), "tmp");
  mkdirSync(tmp, { recursive: true });
  return resolve(tmp, `setup-upload-${id()}`);
}
