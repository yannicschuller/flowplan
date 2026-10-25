// Administration → Push-Benachrichtigungen (lib/push-status.ts): the push
// relay in use, its live checks (cached a minute), the Expo fallback, Web
// Push and the deliveries of 24 hours. POST { action: "check" } checks the
// relay and /.well-known/flowplan-push again at once. Administrators in the
// browser only; API tokens never. Rate limited per person; the answer
// carries addresses, codes and key ids – never a token, key or secret.
import { z } from "zod";
import { checkOrigin, HttpError, requireUser } from "@/lib/auth";
import { withRequestLocale } from "@/lib/content-locale";
import { requireOpsAdmin } from "@/lib/admin-ops";
import { pushStatusFor } from "@/lib/push-status";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { headers: { "Cache-Control": "no-store" } };

function failure(e: unknown) {
  if (e instanceof z.ZodError) return Response.json({ error: "Ungültige Eingabe." }, { status: 400 });
  if (!(e instanceof HttpError)) console.error(e);
  return Response.json({ error: e instanceof HttpError ? e.message : "Aktion fehlgeschlagen." }, { status: e instanceof HttpError ? e.status : 500 });
}

export const GET = withRequestLocale(async () => {
  try {
    return Response.json(await pushStatusFor(await requireUser()), noStore);
  } catch (e) {
    return failure(e);
  }
});

const postSchema = z.object({ action: z.literal("check") });

export const POST = withRequestLocale(async (req: Request) => {
  try {
    checkOrigin(req);
    const user = requireOpsAdmin(await requireUser());
    postSchema.parse(await req.json().catch(() => ({})));
    return Response.json(await pushStatusFor(user, { force: true }), noStore);
  } catch (e) {
    return failure(e);
  }
});
