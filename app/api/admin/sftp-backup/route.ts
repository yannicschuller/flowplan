// Administration → Speicher & Sicherung → SFTP (lib/sftp-backup.ts, #128),
// admins only. GET: settings (without secrets) and the last run.
// POST { action }: save, remove, test, trust { fingerprint }, run.
import { z } from "zod";
import { checkOrigin, HttpError, requireUser } from "@/lib/auth";
import { requireAdmin } from "@/lib/permissions";
import {
  removeSftpBackup,
  runSftpBackup,
  saveSftpBackup,
  sftpBackupSettings,
  sftpBackupStatus,
  testSftpBackup,
  trustSftpHostKey,
} from "@/lib/sftp-backup";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "private, no-store" };
const failure = (e: unknown) => {
  if (e instanceof z.ZodError) return Response.json({ error: "Ungültige Eingabe." }, { status: 400, headers });
  // Never the error object itself: it could carry what was entered.
  if (!(e instanceof HttpError)) console.error("SFTP-Sicherung:", (e as Error)?.message);
  return Response.json({ error: e instanceof HttpError ? e.message : "Die Anfrage konnte nicht verarbeitet werden." }, { status: e instanceof HttpError ? e.status : 500, headers });
};
const state = () => ({ settings: sftpBackupSettings(), status: sftpBackupStatus() });

export async function GET() {
  try {
    const user = await requireUser();
    requireAdmin(user);
    return Response.json(state(), { headers });
  } catch (e) {
    return failure(e);
  }
}

export async function POST(req: Request) {
  try {
    checkOrigin(req);
    const user = await requireUser();
    requireAdmin(user);
    if (user.apiScope) throw new HttpError(403, "Mit einem API-Token nicht erlaubt.");
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = z.enum(["save", "remove", "test", "trust", "run"]).parse(body.action);
    switch (action) {
      case "save":
        saveSftpBackup(user.id, body.settings);
        return Response.json(state(), { headers });
      case "remove":
        removeSftpBackup(user.id);
        return Response.json(state(), { headers });
      case "test":
        return Response.json({ ...state(), test: await testSftpBackup() }, { headers });
      case "trust":
        trustSftpHostKey(user.id, body.fingerprint);
        return Response.json(state(), { headers });
      case "run": {
        const result = await runSftpBackup();
        return Response.json({ ...state(), run: result }, { headers });
      }
    }
  } catch (e) {
    return failure(e);
  }
}
