// What the download routes of the document exports share (app/api/export/*):
// the signed-in person, the query, error answers as JSON in the reader's
// language, and the attachment headers.
import { z } from "zod";
import { requireUser, HttpError } from "./auth";
import { withRequestLocale } from "./content-locale";
import type { Identity } from "./types";

export const uuid = z.string().uuid();
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };

export function exportRoute(run: (user: Identity, query: URLSearchParams) => Promise<Response>) {
  return withRequestLocale(async (req: Request) => {
    try {
      const user = await requireUser();
      return await run(user, new URL(req.url).searchParams);
    } catch (error) {
      if (!(error instanceof HttpError) && !(error instanceof z.ZodError)) console.error(error);
      return Response.json(
        {
          error:
            error instanceof HttpError
              ? error.message
              : error instanceof z.ZodError
                ? "Ungültige Exportoptionen."
                : "Export konnte nicht erstellt werden.",
        },
        { status: error instanceof HttpError ? error.status : error instanceof z.ZodError ? 400 : 500, headers },
      );
    }
  });
}

// A file to download: the name in the header twice, ASCII and UTF-8.
export function attachment(bytes: Buffer, name: string, mime: string, extension: string) {
  const encoded = encodeURIComponent(name).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return new Response(new Uint8Array(bytes), {
    headers: {
      ...headers,
      "Content-Type": mime,
      "Content-Disposition": `attachment; filename="flowplan.${extension}"; filename*=UTF-8''${encoded}`,
    },
  });
}

// The selection of a page (with sub-pages) or a space from the query.
export function selection(query: URLSearchParams) {
  const page = query.get("page"),
    space = query.get("space");
  if (!!page === !!space) throw new HttpError(400, "Entweder eine Seite oder einen Bereich exportieren.");
  return {
    pageId: page ? uuid.parse(page) : undefined,
    spaceId: space ? uuid.parse(space) : undefined,
    children: query.get("children") === "1",
  };
}
