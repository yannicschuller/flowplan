// Administration → Sicherheit (lib/security-admin.ts): the summary, more
// events (`?events=1&severity=&kind=&before=`), one incident with its events
// (`?incident=<id>`), the export (`?export=csv|json`)
// and the actions (POST). Administrators in the browser only; API tokens
// never.
import { z } from "zod";
import { checkOrigin, HttpError, requireUser } from "@/lib/auth";
import { withRequestLocale } from "@/lib/content-locale";
import { requireOpsAdmin } from "@/lib/admin-ops";
import { securityAction, securityEvents, securityExport, securityIncident, securityOverview } from "@/lib/security-admin";
import { securityEvent } from "@/lib/security-events";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { headers: { "Cache-Control": "no-store" } };
function failure(e: unknown) {
  if (e instanceof z.ZodError) return Response.json({ error: "Ungültige Eingabe.", details: e.issues.map((i) => i.message) }, { status: 400 });
  if (!(e instanceof HttpError)) console.error(e);
  return Response.json({ error: e instanceof HttpError ? e.message : "Aktion fehlgeschlagen." }, { status: e instanceof HttpError ? e.status : 500 });
}
const admin = async () => requireOpsAdmin(await requireUser());

export const GET = withRequestLocale(async (req: Request) => {
  try {
    const user = await admin();
    const params = new URL(req.url).searchParams;
    const format = params.get("export");
    if (format === "csv" || format === "json") {
      const file = securityExport(format);
      securityEvent("data.export", { actorId: user.id, headers: req.headers, detail: `security events ${format}` });
      return new Response(file.body, {
        headers: {
          "Content-Type": file.type,
          "Content-Disposition": `attachment; filename="${file.name}"`,
          "Cache-Control": "no-store",
        },
      });
    }
    const incident = params.get("incident");
    if (incident) return Response.json(securityIncident(incident), noStore);
    if (params.get("events")) return Response.json(securityEvents(Object.fromEntries(params)), noStore);
    return Response.json(securityOverview(), noStore);
  } catch (e) {
    return failure(e);
  }
});

export const POST = withRequestLocale(async (req: Request) => {
  try {
    checkOrigin(req);
    const user = await admin();
    return Response.json(securityAction(user, await req.json().catch(() => ({})), req.headers), noStore);
  } catch (e) {
    return failure(e);
  }
});
