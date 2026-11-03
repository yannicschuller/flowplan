// The endpoints of an instance move on the OLD instance (lib/instance-move.ts),
// for the new instance only: Authorization: Bearer fpmove_… (the move token
// from Administration → Speicher & Sicherung → Instanz umziehen). No session,
// no cookie: a request from a browser carries no such token, so no other
// site can trigger them.
//   GET  manifest            database snapshot + list of files with SHA-256
//   GET  database?snapshot=  the snapshot (Range: resumable)
//   GET  file/<id>           one upload (Range: resumable)
//   GET  extra/<name>        web-push-keys.json, secrets.key
//   GET  env                 configuration: names and keyed hashes only
//   POST freeze              read-only for the final copy
//   POST finish              the move is done: banner, token used up
import { HttpError } from "@/lib/auth";
import { authorizeMove, envReport, finishSource, freezeSource, moveManifest, movePath, serveMoveFile, snapshotPath } from "@/lib/instance-move";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const failure = (e: unknown) => {
  if (!(e instanceof HttpError)) console.error(e);
  return Response.json({ error: e instanceof HttpError ? e.message : "Die Anfrage konnte nicht verarbeitet werden." }, { status: e instanceof HttpError ? e.status : 500, headers });
};

export async function GET(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  try {
    const { path } = await params;
    const what = path.join("/");
    if (what === "manifest") {
      authorizeMove(req, "manifest");
      return Response.json(await moveManifest(), { headers });
    }
    if (what === "env") {
      const { token } = authorizeMove(req, "env");
      return Response.json(envReport(token), { headers });
    }
    if (what === "database") {
      authorizeMove(req, "file");
      const file = snapshotPath(new URL(req.url).searchParams.get("snapshot") || "");
      if (!file) throw new HttpError(404, "Dieser Datenbankstand ist nicht mehr vorhanden – bitte die Übertragung neu starten.");
      return serveMoveFile(file, req.headers.get("range"));
    }
    if (path.length === 2 && (path[0] === "file" || path[0] === "extra")) {
      authorizeMove(req, "file");
      const file = movePath(path[0], path[1]);
      if (!file) throw new HttpError(404, "Datei nicht gefunden.");
      return serveMoveFile(file, req.headers.get("range"));
    }
    throw new HttpError(404, "Nicht gefunden.");
  } catch (e) {
    return failure(e);
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  try {
    const { path } = await params;
    const what = path.join("/");
    if (Number(req.headers.get("content-length") || 0) > 10_000) throw new HttpError(413, "Anfrage zu groß.");
    if (what === "freeze") {
      const { state } = authorizeMove(req, "freeze");
      return Response.json(freezeSource(state), { headers });
    }
    if (what === "finish") {
      const { state } = authorizeMove(req, "finish");
      return Response.json(finishSource(state, await req.json().catch(() => ({}))), { headers });
    }
    throw new HttpError(404, "Nicht gefunden.");
  } catch (e) {
    return failure(e);
  }
}
