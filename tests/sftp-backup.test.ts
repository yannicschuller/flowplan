// SFTP as a target of the scheduled backup (#128), against an SFTP server
// in this process (tests/helpers/sftp-server.ts).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ssh2 from "ssh2";
import { startSftpServer } from "./helpers/sftp-server";

const dir = mkdtempSync(join(tmpdir(), "flowplan-sftp-backup-"));
process.env.FLOWPLAN_DATA_DIR = dir;
const remote = mkdtempSync(join(tmpdir(), "flowplan-sftp-remote-"));
const { one, run, id } = await import("../lib/db");
const backup = await import("../lib/sftp-backup");
const { runScheduledBackup, scheduledBackupStatus } = await import("../lib/scheduled-backup");
const { remoteDirectory } = await import("../lib/sftp");

const server = await startSftpServer(remote, { user: "backup", password: "richtig-geheim" });
after(() => server.close());
const admin = id();
const settings = (extra: Record<string, unknown> = {}) => ({
  enabled: true,
  host: "127.0.0.1",
  port: server.port,
  username: "backup",
  auth: "password",
  password: "richtig-geheim",
  directory: "sicherungen/flowplan",
  keep: 2,
  uploads: true,
  ...extra,
});
const remoteFiles = () => readdirSync(join(remote, "sicherungen/flowplan")).filter((n) => n.startsWith("flowplan-")).sort();
const deletedFiles = () => {
  const trash = join(remote, "sicherungen/flowplan/.deleted/uploads");
  return existsSync(trash) ? readdirSync(trash).sort() : [];
};
const HOUR = 3_600_000;
let deletedLater = "";

test("the password is stored sealed and never shown again", () => {
  backup.saveSftpBackup(admin, settings());
  const raw = one<{ value: string }>("SELECT value FROM instance_settings WHERE key='sftpBackup'")!.value;
  assert.ok(!raw.includes("richtig-geheim"));
  const shown = backup.sftpBackupSettings();
  assert.equal(shown.hasPassword, true);
  assert.ok(!JSON.stringify(shown).includes("richtig-geheim"));
  // Not in the activity log either.
  assert.ok(!JSON.stringify(one("SELECT detail FROM audit WHERE action='backup.sftp.saved'")).includes("richtig-geheim"));
  // Saving again without a password keeps it.
  backup.saveSftpBackup(admin, { ...settings(), password: undefined });
  assert.equal(backup.sftpBackupSettings().hasPassword, true);
});

test("the host key is confirmed before any credential is sent", async () => {
  const before = server.logins;
  const first = await backup.testSftpBackup();
  assert.equal(first.state, "unknown");
  assert.equal(first.fingerprint, server.hostKey);
  assert.equal(server.logins, before, "no sign-in with an unknown host key");
  // Backups refuse while the key is not confirmed.
  const refused = await backup.runSftpBackup();
  assert.match(refused.error!, /Hostschlüssel/);
  // Only the key the test saw can be confirmed.
  assert.throws(() => backup.trustSftpHostKey(admin, "SHA256:anders"), /zuerst die Verbindung testen/);
  backup.trustSftpHostKey(admin, first.fingerprint);
  const ok = await backup.testSftpBackup();
  assert.equal(ok.state, "ok");
  assert.equal(server.logins, before + 1);
  assert.ok(existsSync(join(remote, "sicherungen/flowplan")), "the folder was created");
});

test("backups go to the SFTP server, with the files, keeping the newest N", async () => {
  mkdirSync(join(dir, "uploads"), { recursive: true });
  const kept = id(),
    gone = id();
  writeFileSync(join(dir, "uploads", kept), "Anhang");
  writeFileSync(join(dir, "uploads", gone), "später gelöscht");
  const start = Date.UTC(2026, 10, 6, 3, 0);
  // The scheduled backup sends the same copy to SFTP as well.
  const local = await runScheduledBackup(start);
  assert.equal(local.error, null);
  assert.equal(scheduledBackupStatus().sftp.last?.error, null);
  assert.deepEqual(remoteFiles(), ["flowplan-2026-11-06-03-00.sqlite"]);
  assert.equal(readFileSync(join(remote, "sicherungen/flowplan/uploads", kept), "utf8"), "Anhang");
  // A file deleted here leaves uploads/ there, into .deleted/uploads/.
  rmSync(join(dir, "uploads", gone));
  const second = await backup.runSftpBackup(start + HOUR);
  assert.equal(second.error, null);
  assert.equal(second.removed, 1);
  assert.equal(second.files, 0, "files already there are not sent again");
  await backup.runSftpBackup(start + 2 * HOUR);
  // keep: 2 – the oldest went.
  assert.deepEqual(remoteFiles(), ["flowplan-2026-11-06-04-00.sqlite", "flowplan-2026-11-06-05-00.sqlite"]);
  assert.deepEqual(readdirSync(join(remote, "sicherungen/flowplan/uploads")), [kept]);
  // The copy is a working SQLite database.
  assert.equal(readFileSync(join(remote, "sicherungen/flowplan", remoteFiles()[1])).subarray(0, 15).toString(), "SQLite format 3");
  // The backup of 04:00 still refers to it: kept, with the time of the move.
  assert.deepEqual(deletedFiles(), [`${gone}.${start + HOUR}`]);
  assert.equal(readFileSync(join(remote, "sicherungen/flowplan/.deleted/uploads", `${gone}.${start + HOUR}`), "utf8"), "später gelöscht");
  deletedLater = gone;
});

test("deleted files wait in .deleted/ until no kept backup refers to them", async () => {
  const start = Date.UTC(2026, 10, 6, 3, 0);
  const gone = deletedLater;
  // Back here (e.g. restored from a backup): moved back, not sent again.
  writeFileSync(join(dir, "uploads", gone), "später gelöscht");
  const back = await backup.runSftpBackup(start + 3 * HOUR);
  assert.deepEqual([back.error, back.files, back.removed], [null, 0, 0]);
  assert.equal(readFileSync(join(remote, "sicherungen/flowplan/uploads", gone), "utf8"), "später gelöscht");
  assert.deepEqual(deletedFiles(), []);
  // Deleted again at 07:00: kept while the backups of 06:00 and 07:00 stay.
  rmSync(join(dir, "uploads", gone));
  assert.equal((await backup.runSftpBackup(start + 4 * HOUR)).removed, 1);
  assert.deepEqual(deletedFiles(), [`${gone}.${start + 4 * HOUR}`]);
  // 07:00 and 08:00 kept: the oldest one still has the file.
  const kept = await backup.runSftpBackup(start + 5 * HOUR);
  assert.deepEqual([kept.error, kept.purged], [null, 0]);
  assert.deepEqual(remoteFiles(), ["flowplan-2026-11-06-07-00.sqlite", "flowplan-2026-11-06-08-00.sqlite"]);
  assert.deepEqual(deletedFiles(), [`${gone}.${start + 4 * HOUR}`]);
  // 08:00 and 09:00 kept: both were made after the move – it goes for good.
  const purged = await backup.runSftpBackup(start + 6 * HOUR);
  assert.deepEqual([purged.error, purged.purged], [null, 1]);
  assert.deepEqual(deletedFiles(), []);
  assert.ok(!readdirSync(join(remote, "sicherungen/flowplan/uploads")).includes(gone));
});

test("a changed host key stops the backups until it is confirmed again", async () => {
  const stored = JSON.parse(one<{ value: string }>("SELECT value FROM instance_settings WHERE key='sftpBackup'")!.value);
  run("UPDATE instance_settings SET value=? WHERE key='sftpBackup'", JSON.stringify({ ...stored, hostKey: "SHA256:frueher" }));
  const before = server.logins;
  const result = await backup.runSftpBackup(Date.UTC(2026, 10, 7, 3, 0));
  assert.match(result.error!, /Hostschlüssel.*geändert/);
  assert.equal(server.logins, before, "nothing was sent to the changed server");
  assert.equal(remoteFiles().length, 2);
  const seen = await backup.testSftpBackup();
  assert.deepEqual([seen.state, seen.expected, seen.fingerprint], ["changed", "SHA256:frueher", server.hostKey]);
  backup.trustSftpHostKey(admin, seen.fingerprint);
  assert.equal((await backup.testSftpBackup()).state, "ok");
});

test("a wrong password is reported, not retried with something else", async () => {
  backup.saveSftpBackup(admin, settings({ password: "falsch" }));
  await assert.rejects(backup.testSftpBackup(), /Anmeldung am SFTP-Server fehlgeschlagen/);
  const result = await backup.runSftpBackup();
  assert.match(result.error!, /Anmeldung am SFTP-Server fehlgeschlagen/);
  assert.ok(!result.error!.includes("falsch"));
  backup.saveSftpBackup(admin, settings());
});

test("sign-in with a private key and passphrase", async () => {
  const keys = ssh2.utils.generateKeyPairSync("ed25519", { passphrase: "schluessel-satz", cipher: "aes256-ctr", rounds: 16 });
  const keyRemote = mkdtempSync(join(tmpdir(), "flowplan-sftp-key-"));
  const keyServer = await startSftpServer(keyRemote, { user: "schluessel", publicKey: keys.public });
  try {
    backup.saveSftpBackup(admin, settings({ port: keyServer.port, username: "schluessel", auth: "key", password: "", privateKey: keys.private, passphrase: "schluessel-satz", directory: "/" }));
    // Another port: the host key is confirmed anew.
    assert.equal(backup.sftpBackupSettings().hostKey, null);
    const seen = await backup.testSftpBackup();
    backup.trustSftpHostKey(admin, seen.fingerprint);
    const result = await backup.runSftpBackup(Date.UTC(2026, 10, 8, 3, 0));
    assert.equal(result.error, null);
    assert.ok(existsSync(join(keyRemote, "flowplan-2026-11-08-03-00.sqlite")));
    // A wrong passphrase is a readable error.
    backup.saveSftpBackup(admin, settings({ port: keyServer.port, username: "schluessel", auth: "key", passphrase: "falsch", directory: "/" }));
    await assert.rejects(backup.testSftpBackup(), /private Schlüssel kann nicht gelesen werden/);
  } finally {
    await keyServer.close();
  }
});

test("folders on the server cannot leave the login folder by ..", () => {
  assert.throws(() => remoteDirectory("../etc"), /Ungültiger Ordner/);
  assert.throws(() => remoteDirectory("backups/../../x"), /Ungültiger Ordner/);
  assert.throws(() => remoteDirectory("a\nb"), /Ungültiger Ordner/);
  assert.equal(remoteDirectory("/srv/backups/"), "/srv/backups");
  assert.equal(remoteDirectory(""), ".");
  assert.throws(() => backup.saveSftpBackup(admin, settings({ host: "ssh://example.org" })), /Ungültiger SFTP-Server/);
});
