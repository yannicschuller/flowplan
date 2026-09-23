import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { HttpError } from "./auth";

export async function fileResponse(
  req: Request,
  file: { id: string; name: string; mime: string },
) {
  let handle;
  try {
    handle = await open(
      resolve(process.env.FLOWPLAN_DATA_DIR || "./data", "uploads", file.id),
      "r",
    );
  } catch {
    throw new HttpError(404, "Datei fehlt.");
  }
  try {
    const { size } = await handle.stat();
    const inline =
      /^(image\/(png|jpeg|gif|webp|avif)|video\/(mp4|webm)|audio\/(mpeg|ogg|wav|mp4|webm))$/.test(
        file.mime,
      );
    const headers: Record<string, string> = {
      "Content-Type": inline ? file.mime : "application/octet-stream",
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Accept-Ranges": "bytes",
    };
    let start = 0,
      end = size - 1,
      status = 200;
    const range = req.headers.get("range");
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!m || (!m[1] && !m[2]) || !size)
        return new Response(null, {
          status: 416,
          headers: { ...headers, "Content-Range": `bytes */${size}` },
        });
      if (!m[1]) start = Math.max(0, size - Number(m[2]));
      else {
        start = Number(m[1]);
        if (m[2]) end = Math.min(Number(m[2]), size - 1);
      }
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        start >= size ||
        end < start
      )
        return new Response(null, {
          status: 416,
          headers: { ...headers, "Content-Range": `bytes */${size}` },
        });
      status = 206;
      headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
    }
    headers["Content-Length"] = String(Math.max(0, end - start + 1));
    if (req.method === "HEAD") return new Response(null, { status, headers });
    const buffer = Buffer.alloc(Math.max(0, end - start + 1));
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        start + offset,
      );
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    return new Response(new Uint8Array(buffer.subarray(0, offset)), {
      status,
      headers,
    });
  } finally {
    await handle.close();
  }
}
