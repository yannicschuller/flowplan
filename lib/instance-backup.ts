import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { open as openZip, type Entry } from "yauzl";
import { ZipFile } from "yazl";
import { id, run } from "./db";
import { HttpError } from "./auth";

// Whole-instance backups for admins: a consistent SQLite copy, all uploads
// and a manifest, streamed as ZIP. Restores are validated and applied on
// the next start (see instance-restore-apply.ts).
export const INSTANCE_FORMAT = "flowplan-instance-1";
export const INSTANCE_ARCHIVE_LIMIT = 50 * 1024 * 1024 * 1024;
const dataDir = () => resolve(process.env.FLOWPLAN_DATA_DIR || "./data");
const UPLOAD = /^uploads\/[A-Za-z0-9_-]{1,100}$/;

export function instanceBackupStream() {
  const dir = dataDir(),
    tmp = resolve(dir, "tmp");
  mkdirSync(tmp, { recursive: true });
  const copy = resolve(tmp, `instance-${id()}.sqlite`);
  run(`VACUUM INTO '${copy.replaceAll("'", "''")}'`);
  const uploads = resolve(dir, "uploads");
  const files = existsSync(uploads)
    ? readdirSync(uploads).filter((n) => /^[A-Za-z0-9_-]{1,100}$/.test(n))
    : [];
  const zip = new ZipFile();
  zip.addBuffer(
    Buffer.from(
      JSON.stringify({
        format: INSTANCE_FORMAT,
        createdAt: new Date().toISOString(),
        files: files.length,
      }),
    ),
    "manifest.json",
  );
  zip.addFile(copy, "flowplan.sqlite");
  for (const name of files)
    zip.addFile(resolve(uploads, name), `uploads/${name}`);
  zip.end();
  const stream = zip.outputStream as Readable;
  const cleanup = () => rmSync(copy, { force: true });
  stream.once("end", cleanup);
  stream.once("close", cleanup);
  stream.once("error", cleanup);
  return stream;
}

type Summary = {
  createdAt: string;
  users: number;
  workspaces: number;
  pages: number;
  files: number;
};
export function pendingRestore(): Summary | null {
  const file = resolve(dataDir(), "restore-pending", "READY");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
export function cancelRestore() {
  rmSync(resolve(dataDir(), "restore-pending"), {
    recursive: true,
    force: true,
  });
}
// Unpacks and checks an uploaded instance backup; applied on restart.
export async function stageInstanceRestore(zipPath: string): Promise<Summary> {
  if (statSync(zipPath).size > INSTANCE_ARCHIVE_LIMIT)
    throw new HttpError(413, "Sicherung ist zu groß.");
  const dir = dataDir(),
    staging = resolve(dir, `restore-staging-${id()}`);
  mkdirSync(resolve(staging, "uploads"), { recursive: true });
  let manifest: { format?: string; createdAt?: string; files?: number } = {};
  let uploads = 0,
    database = false;
  try {
    await new Promise<void>((done, reject) =>
      openZip(
        zipPath,
        { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
        (error, zip) => {
          if (error) return reject(new HttpError(400, "Ungültige ZIP-Datei."));
          let failed = false;
          const fail = (e: unknown) => {
            if (failed) return;
            failed = true;
            zip.close();
            reject(
              e instanceof HttpError
                ? e
                : new HttpError(400, "Beschädigte Sicherung."),
            );
          };
          const seen = new Set<string>();
          zip.on("error", fail);
          zip.on("end", () => !failed && done());
          zip.on("entry", (entry: Entry) => {
            const name = entry.fileName;
            if (
              seen.has(name) ||
              entry.isEncrypted() ||
              !(
                name === "manifest.json" ||
                name === "flowplan.sqlite" ||
                UPLOAD.test(name)
              )
            )
              return fail(
                new HttpError(
                  400,
                  "Die Sicherung enthält unbekannte Einträge.",
                ),
              );
            seen.add(name);
            zip.openReadStream(entry, (err, stream) => {
              if (err) return fail(err);
              stream.on("error", fail);
              if (name === "manifest.json") {
                if (entry.uncompressedSize > 100_000)
                  return fail(new HttpError(400, "Ungültiges Manifest."));
                const chunks: Buffer[] = [];
                stream.on("data", (c: Buffer) => chunks.push(c));
                stream.once("end", () => {
                  try {
                    manifest = JSON.parse(
                      Buffer.concat(chunks).toString("utf8"),
                    );
                  } catch {
                    return fail(new HttpError(400, "Ungültiges Manifest."));
                  }
                  zip.readEntry();
                });
                return;
              }
              const out = createWriteStream(resolve(staging, name), {
                flags: "wx",
              });
              out.on("error", fail);
              out.once("finish", () => {
                if (name === "flowplan.sqlite") database = true;
                else uploads++;
                zip.readEntry();
              });
              stream.pipe(out);
            });
          });
          zip.readEntry();
        },
      ),
    );
    if (manifest.format !== INSTANCE_FORMAT || !database)
      throw new HttpError(400, "Keine Flowplan-Instanzsicherung.");
    // The database must be intact and look like a Flowplan database.
    const db = new DatabaseSync(resolve(staging, "flowplan.sqlite"), {
      readOnly: true,
    });
    let summary: Summary;
    try {
      const check = db.prepare("PRAGMA integrity_check").get() as Record<
        string,
        string
      >;
      if (Object.values(check)[0] !== "ok")
        throw new HttpError(400, "Die Datenbank der Sicherung ist beschädigt.");
      const count = (table: string) =>
        Number(
          (db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number })
            .n,
        );
      summary = {
        createdAt: String(manifest.createdAt || ""),
        users: count("users"),
        workspaces: count("workspaces"),
        pages: count("pages"),
        files: uploads,
      };
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(
        400,
        "Die Sicherung enthält keine gültige Flowplan-Datenbank.",
      );
    } finally {
      db.close();
    }
    writeFileSync(resolve(staging, "READY"), JSON.stringify(summary));
    cancelRestore();
    renameSync(staging, resolve(dir, "restore-pending"));
    return summary;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
