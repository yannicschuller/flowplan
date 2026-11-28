// The status of linked issues, pull requests and merge requests (#654,
// lib/issue-preview.ts): the hover card and state icon of links to GitHub,
// GitLab and Forgejo/Gitea in documents. POST { urls: [...] } (at most 20)
// answers { previews: { <url>: preview | { error } } }. Signed-in people in
// the browser only – API tokens never (no proxy to the providers' APIs).
import { readTextLimited } from "@/lib/request-body";
import { serverError } from "@/lib/request-context";
import { z } from "zod";
import { checkOrigin, HttpError, identityFromRequest } from "@/lib/auth";
import { withRequestLocale } from "@/lib/content-locale";
import { issuePreviews, MAX_PREVIEW_URLS } from "@/lib/issue-preview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { headers: { "Cache-Control": "no-store" } };
function failure(e: unknown) {
  if (e instanceof z.ZodError || e instanceof SyntaxError) return Response.json({ error: "Ungültige Eingabe." }, { status: 400, ...noStore });
  if (!(e instanceof HttpError)) console.error(e);
  return Response.json(
    { error: e instanceof HttpError ? e.message : "Die Anfrage konnte nicht verarbeitet werden." },
    { status: e instanceof HttpError ? e.status : serverError(e), ...noStore },
  );
}
const input = z.object({ urls: z.array(z.string().max(2000)).min(1).max(MAX_PREVIEW_URLS) });

export const POST = withRequestLocale(async (req: Request) => {
  try {
    await checkOrigin(req);
    const user = await identityFromRequest(req);
    if (!user) throw new HttpError(401, "Bitte melde dich an.");
    if (user.apiScope) throw new HttpError(403, "Mit einem API-Token nicht möglich.");
    if (user.twoFactorSetup) throw new HttpError(403, "Bitte richte zuerst die Zwei-Faktor-Anmeldung ein.");
    const { urls } = input.parse(JSON.parse((await readTextLimited(req, 50_000)) || "{}"));
    return Response.json({ previews: await issuePreviews(user, urls) }, noStore);
  } catch (e) {
    return failure(e);
  }
});
