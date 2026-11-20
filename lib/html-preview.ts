// The HTML preview (#398): the bytes of an uploaded .html/.htm file as a
// page that can show but never do anything. The app frames it in an
// <iframe sandbox=""> (components/html-viewer-dialog.tsx); the response's
// own policy sandboxes it as well, so the address opened directly is just
// as inert: no scripts, no forms, no popups, no navigating the app, and
// nothing loaded from anywhere – only pictures and fonts inside the file
// (data:) and its own styles. Who may see it is decided by the caller
// with the download's own checks (lib/file-access.ts, lib/publication.ts).
import { open } from "node:fs/promises";
import { HttpError } from "./auth";
import { localUpload, uploadPath } from "./storage";
import { HTML_PREVIEW_LIMIT, isHtmlName } from "./html-files";

export const HTML_PREVIEW_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox";

// The character set to declare: a byte order mark, else a <meta charset>
// (or http-equiv Content-Type) in the first 1024 bytes the browser's
// decoder knows, else UTF-8. The bytes themselves are sent unchanged.
export function htmlCharset(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  const head = Buffer.from(bytes.subarray(0, 1024)).toString("latin1");
  const label = /<meta\b[^>]*?\bcharset\s*=\s*["']?\s*([A-Za-z0-9._:-]{1,40})/i.exec(head)?.[1];
  if (label)
    try {
      const encoding = new TextDecoder(label).encoding;
      // As browsers do: a page cannot claim UTF-16 from inside itself, and
      // the "replacement" encodings would show nothing.
      if (!/^utf-16|^replacement$/.test(encoding)) return encoding;
    } catch {
      // An unknown name: UTF-8.
    }
  return "utf-8";
}

export async function htmlPreviewResponse(req: Request, file: { id: string; name: string; mime: string }) {
  // Only files named .html/.htm, stored as a download (as every HTML upload
  // is) – never a picture or a PDF that happens to be named so.
  if (!isHtmlName(file.name) || !/^(application\/octet-stream|text\/html)$/.test(file.mime))
    throw new HttpError(415, "Keine HTML-Datei.");
  let handle;
  try {
    handle = await open((await localUpload(file.id)) ?? uploadPath(file.id), "r");
  } catch {
    throw new HttpError(404, "Datei fehlt.");
  }
  try {
    const { size } = await handle.stat();
    if (size > HTML_PREVIEW_LIMIT) throw new HttpError(413, "Die Datei ist zu groß für die Vorschau (höchstens 5 MB).");
    // HEAD (the viewer asks before it frames the page) reads only as much
    // as the character set needs.
    const head = req.method === "HEAD";
    const bytes = head ? (await handle.read(Buffer.alloc(1024), 0, 1024, 0)).buffer.subarray(0, Math.min(size, 1024)) : await handle.readFile();
    return new Response(head ? null : new Uint8Array(bytes), {
      headers: {
        "Content-Type": `text/html; charset=${htmlCharset(bytes)}`,
        "Content-Length": String(head ? size : bytes.length),
        "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        "Content-Security-Policy": HTML_PREVIEW_CSP,
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Referrer-Policy": "no-referrer",
        "Cache-Control": "private, no-store",
      },
    });
  } finally {
    await handle.close();
  }
}
