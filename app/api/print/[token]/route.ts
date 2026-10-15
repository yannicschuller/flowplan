import { randomBytes } from "node:crypto";
import { printSnapshot } from "@/lib/print-snapshots";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A stored print view (lib/print-snapshots.ts), opened in Safari. Its only
// script is the print button with this answer's nonce; everything else in
// the view stays inert.
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
  const nonce = randomBytes(16).toString("base64");
  const script = `<script nonce="${nonce}">document.querySelector(".print-view-print").addEventListener("click",()=>window.print())</script>`;
  return new Response(html.replace(/<\/body>\s*<\/html>\s*$/, `${script}</body></html>`), {
    headers: {
      ...base,
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": [
        "default-src 'none'",
        `script-src 'nonce-${nonce}'`,
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob: https:",
        "font-src 'self' data:",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
      ].join("; "),
    },
  });
}
