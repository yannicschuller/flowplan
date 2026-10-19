import { createWriteStream, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import { checkOrigin, HttpError, requireUser } from "@/lib/auth";
import { requireAdmin } from "@/lib/permissions";
import { audit } from "@/lib/db";
import {
  INSTANCE_ARCHIVE_LIMIT,
  cancelRestore,
  instanceBackupStream,
  stageInstanceRestore,
} from "@/lib/instance-backup";
import { encryptionEnabled, fileIsEncrypted, sealStream, unsealFile } from "@/lib/encryption";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const failure = (e: unknown) => {
  if (!(e instanceof HttpError)) console.error(e);
  return Response.json(
    { error: e instanceof HttpError ? e.message : "Sicherung fehlgeschlagen." },
    { status: e instanceof HttpError ? e.status : 500 },
  );
};
// Download of the whole instance (admins only), streamed. With
// FLOWPLAN_ENCRYPTION_KEY encrypted on the way (flowplan-instanz-….zip.enc).
export async function GET() {
  try {
    const user = await requireUser();
    requireAdmin(user);
    const encrypted = encryptionEnabled();
    audit(user.id, "instance.backup", "", encrypted ? "encrypted" : "");
    const zip = instanceBackupStream();
    let body: Readable = zip;
    if (encrypted) {
      body = zip.pipe(sealStream());
      zip.once("error", (e) => body.destroy(e));
    }
    return new Response(
      Readable.toWeb(body) as ReadableStream,
      {
        headers: {
          "Content-Type": encrypted ? "application/octet-stream" : "application/zip",
          "Content-Disposition": `attachment; filename="flowplan-instanz-${new Date().toISOString().slice(0, 10)}.zip${encrypted ? ".enc" : ""}"`,
          "Cache-Control": "private, no-store",
        },
      },
    );
  } catch (e) {
    return failure(e);
  }
}
// Upload of a backup; it is checked now and applied on the next restart.
// An encrypted one (.zip.enc) is decrypted first, with the current or an
// earlier key.
export async function POST(req: Request) {
  const dir = resolve(process.env.FLOWPLAN_DATA_DIR || "./data", "tmp");
  const file = resolve(dir, `instance-upload-${randomUUID()}.zip`);
  const plain = `${file}.plain`;
  try {
    checkOrigin(req);
    const user = await requireUser();
    requireAdmin(user);
    if (!req.body) throw new HttpError(400, "Sicherung fehlt.");
    mkdirSync(dir, { recursive: true });
    let length = 0;
    const limit = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        length += chunk.length;
        if (length > INSTANCE_ARCHIVE_LIMIT)
          controller.error(new HttpError(413, "Sicherung ist zu groß."));
        else controller.enqueue(chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(req.body.pipeThrough(limit) as never),
      createWriteStream(file, { flags: "wx" }),
    );
    let zip = file;
    if (fileIsEncrypted(file)) {
      try {
        await unsealFile(file, plain);
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
      zip = plain;
    }
    const summary = await stageInstanceRestore(zip);
    audit(user.id, "instance.restore.staged", "", JSON.stringify(summary));
    return Response.json(summary);
  } catch (e) {
    return failure(e);
  } finally {
    rmSync(file, { force: true });
    rmSync(plain, { force: true });
  }
}
export async function DELETE(req: Request) {
  try {
    checkOrigin(req);
    const user = await requireUser();
    requireAdmin(user);
    cancelRestore();
    audit(user.id, "instance.restore.cancelled", "");
    return Response.json({ ok: true });
  } catch (e) {
    return failure(e);
  }
}
