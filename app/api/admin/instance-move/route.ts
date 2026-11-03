// Administration → Speicher & Sicherung → Instanz umziehen (lib/instance-move.ts),
// admins only. GET: both sides of a move. POST { action }:
//   source: prepare (step-up: password or a fresh sign-in), revoke,
//           unfreeze, redirect
//   target: start { url, token, confirm }, resume, preflight, final,
//           apply, cancel
import { z } from "zod";
import { checkOrigin, HttpError, requireUser } from "@/lib/auth";
import { requireAdmin } from "@/lib/permissions";
import { requestLocale } from "@/lib/i18n-server";
import {
  applyIncoming,
  cancelIncoming,
  finalSync,
  moveSourceStatus,
  moveTargetStatus,
  prepareMove,
  preflight,
  requireStepUp,
  resumeIncoming,
  revokeMove,
  setMoveRedirect,
  startIncoming,
  stepUpKind,
  unfreezeSource,
} from "@/lib/instance-move";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "private, no-store" };
const failure = (e: unknown) => {
  if (e instanceof z.ZodError) return Response.json({ error: "Ungültige Eingabe." }, { status: 400, headers });
  if (!(e instanceof HttpError)) console.error(e);
  return Response.json({ error: e instanceof HttpError ? e.message : "Die Anfrage konnte nicht verarbeitet werden." }, { status: e instanceof HttpError ? e.status : 500, headers });
};

export async function GET() {
  try {
    const user = await requireUser();
    requireAdmin(user);
    return Response.json({ source: moveSourceStatus(), target: moveTargetStatus(), stepUp: stepUpKind(user) }, { headers });
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
    const action = z.enum(["prepare", "revoke", "unfreeze", "redirect", "start", "resume", "preflight", "final", "apply", "cancel"]).parse(body.action);
    const reply = (data: unknown) => Response.json(data, { headers });
    switch (action) {
      case "prepare": {
        await requireStepUp(user, req, body.password, await requestLocale());
        // The token is in this answer only.
        return reply({ ...prepareMove(user), source: moveSourceStatus() });
      }
      case "revoke":
        return reply({ source: revokeMove(user) });
      case "unfreeze":
        return reply({ source: unfreezeSource(user) });
      case "redirect":
        return reply({ source: setMoveRedirect(user, z.boolean().parse(body.on)) });
      case "start":
        return reply({ target: await startIncoming(user, body) });
      case "resume":
        return reply({ target: resumeIncoming() });
      case "preflight":
        return reply(await preflight());
      case "final":
        return reply({ target: await finalSync(user) });
      case "apply":
        return reply({ ...(await applyIncoming(user)), target: moveTargetStatus() });
      case "cancel":
        return reply({ target: cancelIncoming(user) });
    }
  } catch (e) {
    return failure(e);
  }
}
