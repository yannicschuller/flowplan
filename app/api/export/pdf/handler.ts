import { exportPrintHtml } from "@/lib/export-pdf";
import { exportRoute, selection } from "@/lib/export-route";
import { printOptionsFromQuery } from "@/lib/print-options";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A page with its sub-pages (?page=<id>&children=1) or a whole space
// (?space=<id>) as one print view with a cover and a table of contents. The
// browser turns it into a PDF (components/print-page.ts, printDocument);
// opened directly, it is a plain page without scripts. `print` holds the
// print options as JSON (#215, lib/print-options.ts printOptionsQuery).
export const GET = exportRoute(async (user, query) => {
  const result = await exportPrintHtml(user, selection(query), printOptionsFromQuery(query.get("print")));
  const name = encodeURIComponent(result.name).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return new Response(result.html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Disposition": `inline; filename="flowplan.html"; filename*=UTF-8''${name}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex",
      "Content-Security-Policy": "default-src 'none'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: https:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
    },
  });
});
