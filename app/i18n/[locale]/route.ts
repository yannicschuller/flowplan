// /i18n/<code>?v=<version>: the catalogue of one language as a script that
// registers it in the page (lib/i18n-catalogs-server.ts). Public – the
// sign-in page needs it too – and cached for a year under its version.
import { catalogScript } from "@/lib/i18n-catalogs-server";
export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ locale: string }> }) {
  const script = catalogScript((await params).locale);
  if (!script) return new Response("Not found", { status: 404 });
  const current = new URL(req.url).searchParams.get("v") === script.version;
  return new Response(script.body, {
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": current ? "public, max-age=31536000, immutable" : "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
