import { createWriteStream, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireMember } from "@/lib/permissions";
import { requireUser, checkOrigin, HttpError } from "@/lib/auth";
import {
  LARGE_ARCHIVE_LIMIT,
  exportArchiveStream,
  importArchive,
} from "@/lib/archive";
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
// Large archives are streamed in both directions and never held in memory.
export async function GET(req: Request) {
  try {
    const user = await requireUser(),
      wid = z
        .string()
        .uuid()
        .parse(new URL(req.url).searchParams.get("workspace"));
    const stream = exportArchiveStream(user, wid);
    return new Response(Readable.toWeb(stream) as ReadableStream, {
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
  const dir = resolve(process.env.FLOWPLAN_DATA_DIR || "./data", "tmp");
  const file = resolve(dir, `upload-${randomUUID()}.zip`);
  try {
    checkOrigin(req);
    const user = await requireUser();
    const wid = z
      .string()
      .uuid()
      .parse(new URL(req.url).searchParams.get("workspace"));
    requireMember(user, wid, "editor");
    if (Number(req.headers.get("content-length") || 0) > LARGE_ARCHIVE_LIMIT)
      throw new HttpError(413, "ZIP darf maximal 2 GB groß sein.");
    if (!req.body) throw new HttpError(400, "Archiv fehlt.");
    mkdirSync(dir, { recursive: true });
    let length = 0;
    const limit = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        length += chunk.length;
        if (length > LARGE_ARCHIVE_LIMIT)
          controller.error(
            new HttpError(413, "ZIP darf maximal 2 GB groß sein."),
          );
        else controller.enqueue(chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(req.body.pipeThrough(limit) as never),
      createWriteStream(file, { flags: "wx" }),
    );
    return Response.json(await importArchive(user, wid, file));
  } catch (e) {
    return error(e);
  } finally {
    rmSync(file, { force: true });
  }
}
