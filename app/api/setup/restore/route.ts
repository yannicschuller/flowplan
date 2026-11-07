// "Restore from a backup" on the setup screen of a new instance
// (lib/setup-restore.ts, #128). Only while no account exists and, with
// FLOWPLAN_SETUP_TOKEN, only with the setup token (header
// X-Flowplan-Setup). Never API tokens.
//   GET                      status of a running or finished restore
//   POST application/octet-stream   an uploaded backup file (streamed to
//                            disk; key in X-Flowplan-Backup-Key, file name in
//                            X-Flowplan-File-Name)
//   POST application/json { action: "probe-sftp" | "s3" | "sftp", … }
import { createWriteStream, rmSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { checkOrigin, HttpError } from "@/lib/auth";
import { allow } from "@/lib/action-limits";
import { clientAddress } from "@/lib/client-address";
import { securityEvent } from "@/lib/security-events";
import { setupAllowed } from "@/lib/local-auth";
import {
  KeyRequired,
  SETUP_RESTORE_LIMIT,
  probeSftp,
  requireSetupRestore,
  restoreUpload,
  setupRestoreStatus,
  startRemoteRestore,
  uploadTarget,
} from "@/lib/setup-restore";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "private, no-store" };
const failure = (e: unknown) => {
  if (e instanceof z.ZodError) return Response.json({ error: "Ungültige Eingabe." }, { status: 400, headers });
  // Never the error object itself: it could carry what was entered.
  if (!(e instanceof HttpError)) console.error("Wiederherstellung beim Einrichten:", (e as Error)?.message);
  return Response.json(
    { error: e instanceof HttpError ? e.message : "Wiederherstellung fehlgeschlagen.", ...(e instanceof KeyRequired ? { needsKey: true } : {}) },
    { status: e instanceof HttpError ? e.status : 500, headers },
  );
};

// Who may: the instance has no account yet and the setup token fits. Wrong
// tokens count against the address like sign-up attempts.
async function guard(req: Request) {
  if (req.headers.get("authorization")) throw new HttpError(403, "Mit einem API-Token nicht erlaubt.");
  const address = clientAddress(req.headers);
  if (!allow(`setup-restore:${address}`, 60, 3_600_000)) throw new HttpError(429, "Zu viele Versuche. Bitte in 15 Minuten erneut versuchen.");
  const token = req.headers.get("x-flowplan-setup") || "";
  if (!setupAllowed(token)) securityEvent("login.refused", { headers: req.headers, detail: "setup restore without setup token" });
  await requireSetupRestore(token);
}

export async function GET(req: Request) {
  try {
    await guard(req);
    return Response.json(setupRestoreStatus(), { headers });
  } catch (e) {
    return failure(e);
  }
}

export async function POST(req: Request) {
  let upload = "";
  try {
    checkOrigin(req);
    await guard(req);
    if ((req.headers.get("content-type") || "").startsWith("application/json")) {
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const action = z.enum(["probe-sftp", "s3", "sftp"]).parse(body.action);
      if (action === "probe-sftp") return Response.json(await probeSftp(body.target), { headers });
      return Response.json({ progress: startRemoteRestore(action, body.target, body.key) }, { headers });
    }
    if (!req.body) throw new HttpError(400, "Sicherung fehlt.");
    const announced = Number(req.headers.get("content-length") || 0);
    if (announced > SETUP_RESTORE_LIMIT) throw new HttpError(413, "Sicherung ist zu groß.");
    upload = uploadTarget();
    let length = 0;
    const limit = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        length += chunk.length;
        if (length > SETUP_RESTORE_LIMIT) controller.error(new HttpError(413, "Sicherung ist zu groß."));
        else controller.enqueue(chunk);
      },
    });
    await pipeline(Readable.fromWeb(req.body.pipeThrough(limit) as never), createWriteStream(upload, { flags: "wx" }));
    if (!length) throw new HttpError(400, "Sicherung fehlt.");
    let name = "";
    try {
      name = decodeURIComponent(req.headers.get("x-flowplan-file-name") || "");
    } catch {}
    const result = await restoreUpload(upload, req.headers.get("x-flowplan-backup-key") || "", name);
    return Response.json({ result }, { headers });
  } catch (e) {
    return failure(e);
  } finally {
    if (upload) rmSync(upload, { force: true });
  }
}
