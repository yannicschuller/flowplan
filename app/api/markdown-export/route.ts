import { z } from "zod";
import { requireUser, checkOrigin, HttpError } from "@/lib/auth";
import { exportMarkdown } from "@/lib/markdown-export";
import { withRequestLocale } from "@/lib/content-locale";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const options = z
  .object({
    pageId: z.string().uuid(),
    format: z.enum(["markdown", "zip"]),
    includeSubpages: z.boolean().default(false),
    rowId: z.string().uuid().optional(),
    history: z.boolean().default(false),
  })
  .strict();
// Labels, README and frontmatter keys follow the reader's language. Exporting
// only reads, so personal API tokens with read access may use it (e.g. a
// cron job that commits the export to Git); see the API documentation.
export const POST = withRequestLocale(exportPost);
async function exportPost(req: Request) {
  try {
    checkOrigin(req);
    const user = await requireUser();
    if (!req.body) throw new HttpError(400, "Exportoptionen fehlen.");
    const reader = req.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 16000) {
          await reader.cancel();
          throw new HttpError(413, "Exportanfrage zu groß.");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const result = await exportMarkdown(
      user,
      options.parse(JSON.parse(Buffer.concat(chunks).toString("utf8"))),
    );
    const name = encodeURIComponent(result.name).replace(
      /[!'()*]/g,
      (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
    );
    return new Response(new Uint8Array(result.bytes), {
      headers: {
        "Content-Type": result.mime,
        "Content-Disposition": `attachment; filename="flowplan.${result.name.endsWith(".zip") ? "zip" : "md"}"; filename*=UTF-8''${name}`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (
      !(error instanceof HttpError) &&
      !(error instanceof z.ZodError) &&
      !(error instanceof SyntaxError)
    )
      console.error(error);
    return Response.json(
      {
        error:
          error instanceof HttpError
            ? error.message
            : error instanceof z.ZodError || error instanceof SyntaxError
              ? "Ungültige Exportoptionen."
              : "Export konnte nicht erstellt werden.",
      },
      {
        status:
          error instanceof HttpError
            ? error.status
            : error instanceof z.ZodError || error instanceof SyntaxError
              ? 400
              : 500,
      },
    );
  }
}
