import { NextResponse } from "next/server";
import { z } from "zod";
import { checkOrigin, HttpError, requireUser } from "@/lib/auth";
import { withRequestLocale } from "@/lib/content-locale";
import { withIdempotency } from "@/lib/idempotency";
import { issueLinkOf, issueSyncDatabase, issueSyncOverview, runIssueSync, testIssueConnection } from "@/lib/issue-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function failure(e: unknown) {
  if (e instanceof z.ZodError) return NextResponse.json({ error: "Ungültige Eingabe." }, { status: 400 });
  if (!(e instanceof HttpError)) console.error(e);
  return NextResponse.json(
    { error: e instanceof HttpError ? e.message : "Die Anfrage konnte nicht verarbeitet werden." },
    { status: e instanceof HttpError ? e.status : 500 },
  );
}
const noStore = { headers: { "Cache-Control": "no-store" } };

// GitHub/GitLab issue sync (lib/issue-sync.ts):
//   ?workspace=<id>         connections (owners and administrators)
//   ?page=<id>              mapping and sync status of a database
//   ?page=<id>&row=<id>     the issue linked to a record
export const GET = withRequestLocale(async (req: Request) => {
  try {
    const user = await requireUser();
    const url = new URL(req.url);
    const workspace = url.searchParams.get("workspace");
    if (workspace) return NextResponse.json(issueSyncOverview(user, z.uuid().parse(workspace)), noStore);
    const page = z.uuid().parse(url.searchParams.get("page"));
    const row = url.searchParams.get("row");
    if (row) return NextResponse.json(issueLinkOf(user, page, z.uuid().parse(row)), noStore);
    return NextResponse.json(issueSyncDatabase(user, page), noStore);
  } catch (e) {
    return failure(e);
  }
});

// { op: "test", workspaceId, provider, baseUrl, repo, token?, id? } checks
// a connection with one API call; { op: "run", pageId } syncs a database now.
export const POST = withRequestLocale(
  withIdempotency(async (req: Request) => {
    try {
      checkOrigin(req);
      const user = await requireUser();
      if (user.apiScope === "read") throw new HttpError(403, "Dieses API-Token darf nur lesen.");
      const text = await req.text();
      if (text.length > 20_000) throw new HttpError(413, "Anfrage zu groß.");
      const body = z.object({ op: z.enum(["test", "run"]) }).passthrough().parse(JSON.parse(text || "{}"));
      if (body.op === "test") return NextResponse.json(await testIssueConnection(user, body));
      return NextResponse.json(await runIssueSync(user, z.uuid().parse(body.pageId)));
    } catch (e) {
      return failure(e);
    }
  }, { check: checkOrigin }),
);
