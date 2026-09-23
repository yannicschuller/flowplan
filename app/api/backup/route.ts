import { z } from "zod";
import { requireMember } from "@/lib/permissions";
import { requireUser, checkOrigin, HttpError } from "@/lib/auth";
import { ARCHIVE_LIMIT, exportArchive, importArchive } from "@/lib/archive";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
function error(e: unknown) {
  if (!(e instanceof HttpError) && !(e instanceof z.ZodError)) console.error(e);
  return Response.json(
    {
      error:
        e instanceof HttpError
          ? e.message
          : e instanceof z.ZodError
            ? "Das Archiv entspricht nicht dem unterstützten Flowplan-Format."
            : "Sicherung konnte nicht verarbeitet werden.",
    },
    {
      status:
        e instanceof HttpError ? e.status : e instanceof z.ZodError ? 400 : 500,
    },
  );
}
export async function GET(req: Request) {
  try {
    const user = await requireUser(),
      wid = z
        .string()
        .uuid()
        .parse(new URL(req.url).searchParams.get("workspace"));
    const archive = await exportArchive(user, wid);
    return new Response(new Uint8Array(archive), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="flowplan-${new Date().toISOString().slice(0, 10)}.zip"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (e) {
    return error(e);
  }
}
export async function POST(req: Request) {
  try {
    checkOrigin(req);
    const user = await requireUser();
    const wid = z
      .string()
      .uuid()
      .parse(new URL(req.url).searchParams.get("workspace"));
    requireMember(user, wid, "editor");
    if (Number(req.headers.get("content-length") || 0) > ARCHIVE_LIMIT)
      throw new HttpError(413, "ZIP darf maximal 100 MB groß sein.");
    if (!req.body) throw new HttpError(400, "Archiv fehlt.");
    const reader = req.body.getReader(),
      chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > ARCHIVE_LIMIT) {
          await reader.cancel();
          throw new HttpError(413, "ZIP darf maximal 100 MB groß sein.");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return Response.json(await importArchive(user, wid, Buffer.concat(chunks)));
  } catch (e) {
    return error(e);
  }
}
