import { createHash } from "node:crypto";
import { printSnapshot } from "@/lib/print-snapshots";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A stored print view (lib/print-snapshots.ts), opened in Safari. Its only
// script is the print button, allowed by its hash; the view runs sandboxed
// (no access to Flowplan's origin), everything else in it stays inert.
const PRINT_SCRIPT = `document.querySelector(".print-view-print").addEventListener("click",()=>window.print())`;
const PRINT_HASH = createHash("sha256").update(PRINT_SCRIPT).digest("base64");
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const html = printSnapshot((await params).token);
  const base = {
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex",
  };
  if (!html)
    return new Response(
      '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Flowplan</title></head><body style="font:16px system-ui;margin:40px 24px"><p>Diese Druckansicht ist abgelaufen. In Flowplan erneut „Drucken / PDF“ wählen.</p><p>This print view has expired. Choose “Print / PDF” in Flowplan again.</p></body></html>',
      { status: 404, headers: { ...base, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" } },
    );
  const script = `<script>${PRINT_SCRIPT}</script>`;
  return new Response(html.replace(/<\/body>\s*<\/html>\s*$/, `${script}</body></html>`), {
    headers: {
      ...base,
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": [
        "default-src 'none'",
        `script-src 'sha256-${PRINT_HASH}'`,
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob: https:",
        "font-src 'self' data:",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
        "sandbox allow-scripts allow-modals allow-popups",
      ].join("; "),
    },
  });
}
