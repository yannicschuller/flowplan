// SFTP for backups (#128): the connection, host key check and the few file
// operations the scheduled backup (lib/sftp-backup.ts) and the restore on a
// new instance (lib/setup-restore.ts) need. ssh2 is pure JavaScript; its
// optional native helpers (faster ciphers, CPU detection) are used when
// they were built and skipped otherwise, so amd64 and arm64 behave alike.
//
// Host keys: trust on first use. The fingerprint (SHA256:…, as OpenSSH shows
// it) is checked before any credential is sent; an unknown or changed key
// ends the connection right there and the admin confirms it in the interface.
import { createHash } from "node:crypto";
import { posix } from "node:path";
import ssh2 from "ssh2";
import type { ConnectConfig, FileEntryWithStats, SFTPWrapper } from "ssh2";
import { HttpError } from "./auth";

export type SftpLogin = {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
};
export type SftpSession = { sftp: SFTPWrapper; fingerprint: string; end: () => void };

// The host key is not the one confirmed before (or none was confirmed):
// nothing was sent to the server.
export class HostKeyError extends HttpError {
  constructor(
    public fingerprint: string,
    public expected: string | null,
  ) {
    super(
      409,
      expected
        ? "Der Hostschlüssel des SFTP-Servers hat sich geändert. Erst nach einer Bestätigung in der Administration wird wieder gesichert."
        : "Der Hostschlüssel des SFTP-Servers ist noch nicht bestätigt.",
    );
  }
}

export const fingerprintOf = (key: Buffer) => `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;

// A host name or IP address: no scheme, path, user or spaces.
export function sftpHost(input: string) {
  const host = input.trim().replace(/^\[(.+)\]$/, "$1");
  if (!host || host.length > 253 || !/^[A-Za-z0-9.:_-]+$/.test(host) || host.startsWith("-"))
    throw new HttpError(400, "Ungültiger SFTP-Server.");
  return host;
}
// The folder on the server: relative to the login folder or absolute, never
// with "..", control characters or backslashes.
export function remoteDirectory(input: string) {
  const value = input.trim() || ".";
  if (value.length > 500 || /[\0-\x1f\x7f\\]/.test(value) || value.split("/").includes(".."))
    throw new HttpError(400, "Ungültiger Ordner auf dem SFTP-Server.");
  const normal = posix.normalize(value);
  return normal.length > 1 ? normal.replace(/\/+$/, "") : normal;
}
export const remotePath = (dir: string, name: string) => posix.join(dir, name);

function friendly(error: Error & { level?: string; code?: string }) {
  if (error instanceof HttpError) return error;
  if (error.level === "client-authentication") return new HttpError(400, "Anmeldung am SFTP-Server fehlgeschlagen: Benutzer, Passwort oder Schlüssel stimmen nicht.");
  if (error.level === "client-timeout" || /Timed out/i.test(error.message)) return new HttpError(504, "Zeitüberschreitung beim Verbinden mit dem SFTP-Server.");
  if (error.code === "ENOTFOUND" || error.code === "EAI_AGAIN") return new HttpError(400, "Den SFTP-Server gibt es unter diesem Namen nicht.");
  if (error.code === "ECONNREFUSED" || error.code === "EHOSTUNREACH" || error.code === "ECONNRESET" || error.code === "ENETUNREACH")
    return new HttpError(502, "Der SFTP-Server ist nicht erreichbar.");
  if (/private key|passphrase|Unsupported key format|Cannot parse privateKey/i.test(error.message))
    return new HttpError(400, "Der private Schlüssel kann nicht gelesen werden (Format oder Passphrase).");
  return new HttpError(502, "Verbindung zum SFTP-Server fehlgeschlagen.");
}

// Connects and opens SFTP. expected: the confirmed fingerprint; null means
// none yet – then the connection only learns the key (HostKeyError).
export function connectSftp(login: SftpLogin, expected: string | null, timeoutMs = 20_000): Promise<SftpSession> {
  return new Promise((done, fail) => {
    const client = new ssh2.Client();
    let seen = "";
    let settled = false;
    const finish = (error: Error | null, session?: SftpSession) => {
      if (settled) return;
      settled = true;
      if (error) {
        client.end();
        fail(error);
      } else done(session!);
    };
    const config: ConnectConfig = {
      host: login.host,
      port: login.port,
      username: login.username,
      readyTimeout: timeoutMs,
      keepaliveInterval: 15_000,
      // Called before authentication: a wrong key never sees the password.
      hostVerifier: (key: Buffer) => {
        seen = fingerprintOf(key);
        return !!expected && seen === expected;
      },
    };
    if (login.privateKey) {
      config.privateKey = login.privateKey;
      if (login.passphrase) config.passphrase = login.passphrase;
    } else if (login.password) config.password = login.password;
    client.on("ready", () =>
      client.sftp((error, sftp) => {
        if (error) return finish(friendly(error));
        finish(null, { sftp, fingerprint: seen, end: () => client.end() });
      }),
    );
    client.on("error", (error: Error & { level?: string }) => {
      if (seen && seen !== expected) return finish(new HostKeyError(seen, expected));
      finish(friendly(error));
    });
    client.on("close", () => finish(seen && seen !== expected ? new HostKeyError(seen, expected) : new HttpError(502, "Der SFTP-Server hat die Verbindung beendet.")));
    try {
      client.connect(config);
    } catch (error) {
      finish(friendly(error as Error));
    }
  });
}

const call = <T>(fn: (cb: (error: Error | null | undefined, value: T) => void) => void) =>
  new Promise<T>((done, fail) => fn((error, value) => (error ? fail(error) : done(value))));

export const sftpList = (sftp: SFTPWrapper, dir: string) => call<FileEntryWithStats[]>((cb) => sftp.readdir(dir, cb));
export const sftpUnlink = (sftp: SFTPWrapper, path: string) => call<void>((cb) => sftp.unlink(path, (e) => cb(e, undefined)));
const statOrNull = (sftp: SFTPWrapper, path: string) =>
  new Promise<{ isDirectory: () => boolean } | null>((done) => sftp.stat(path, (error, stats) => done(error ? null : stats)));

// Creates the folder and its parents where they are missing.
export async function sftpMkdirs(sftp: SFTPWrapper, dir: string) {
  if (dir === "." || dir === "/") return;
  const parts = dir.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const path = parts.slice(0, i).join("/");
    if (!path || path === ".") continue;
    const stats = await statOrNull(sftp, path);
    if (stats?.isDirectory()) continue;
    if (stats) throw new HttpError(400, "Auf dem SFTP-Server liegt eine Datei, wo der Ordner hin soll.");
    await call<void>((cb) => sftp.mkdir(path, (e) => cb(e, undefined))).catch(async (error) => {
      // Created in the meantime (two runs) is fine.
      if (!(await statOrNull(sftp, path))?.isDirectory()) throw error;
    });
  }
}

// Replaces the file at `to` with `from` (rename does not overwrite in SFTP v3).
export async function sftpReplace(sftp: SFTPWrapper, from: string, to: string) {
  try {
    await call<void>((cb) => sftp.rename(from, to, (e) => cb(e, undefined)));
  } catch {
    await sftpUnlink(sftp, to).catch(() => {});
    await call<void>((cb) => sftp.rename(from, to, (e) => cb(e, undefined)));
  }
}

export function sftpUpload(sftp: SFTPWrapper, local: string, remote: string) {
  return call<void>((cb) => sftp.fastPut(local, remote, (e) => cb(e, undefined)));
}
export function sftpDownload(sftp: SFTPWrapper, remote: string, local: string, step?: (done: number, total: number) => void) {
  return call<void>((cb) =>
    sftp.fastGet(remote, local, { step: step ? (done, _chunk, total) => step(done, total) : undefined }, (e) => cb(e, undefined)),
  );
}
