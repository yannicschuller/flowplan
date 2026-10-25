// Time reports (lib/time-reports.ts): GET the report of a database (`page`)
// or a workspace (`workspace`) as JSON or CSV; POST changes the billing
// status of entries and the hourly rates of a workspace.
import { z } from "zod";
import { checkOrigin, HttpError, requireUser } from "@/lib/auth";
import { withRequestLocale } from "@/lib/content-locale";
import { withIdempotency } from "@/lib/idempotency";
import { setBilling, setCurrency, setRate, timeReportCsv, timeReportData } from "@/lib/time-reports";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function failure(e: unknown) {
  if (e instanceof z.ZodError) return Response.json({ error: "Ungültige Eingabe.", details: e.issues.map((i) => i.message) }, { status: 400 });
  if (!(e instanceof HttpError)) console.error(e);
  return Response.json(
    { error: e instanceof HttpError ? e.message : "Die Anfrage konnte nicht verarbeitet werden." },
    { status: e instanceof HttpError ? e.status : 500 },
  );
}

export const GET = withRequestLocale(async (req: Request) => {
  try {
    const user = await requireUser();
    const url = new URL(req.url);
    const query = Object.fromEntries([...url.searchParams].filter(([, v]) => v !== ""));
    const format = z.enum(["json", "csv", "excel"]).default("json").parse(query.format);
    delete query.format;
    if (format === "json") return Response.json(timeReportData(user, query), { headers: { "Cache-Control": "no-store" } });
    const file = timeReportCsv(user, query, format);
    return new Response(file.body, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="time-report.csv"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return failure(e);
  }
});

export const POST = withRequestLocale(
  withIdempotency(async (req: Request) => {
    try {
      checkOrigin(req);
      if (Number(req.headers.get("content-length") || 0) > 1_000_000) throw new HttpError(413, "Anfrage zu groß.");
      const user = await requireUser();
      if (user.apiScope === "read") throw new HttpError(403, "Dieses API-Token darf nur lesen.");
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      if (body.action === "billing") return Response.json(setBilling(user, body));
      if (body.action === "rate") return Response.json({ rates: setRate(user, body) });
      if (body.action === "currency") return Response.json(setCurrency(user, body));
      throw new HttpError(400, "Unbekannte Aktion.");
    } catch (e) {
      return failure(e);
    }
  }, { check: checkOrigin }),
);
