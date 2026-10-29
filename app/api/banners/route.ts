// Banners people click away once (lib/instance-banners.ts): the ones for the
// signed-in person, and closing one (`{ action: "dismiss", id, clicked }`;
// clicked: its link was followed). Not with API tokens.
import { z } from "zod";
import { checkOrigin, HttpError, requireUser } from "@/lib/auth";
import { bannersFor, dismissBanner } from "@/lib/instance-banners";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function failure(e: unknown) {
  if (e instanceof z.ZodError) return Response.json({ error: "Ungültige Eingabe." }, { status: 400 });
  if (!(e instanceof HttpError)) console.error(e);
  return Response.json({ error: e instanceof HttpError ? e.message : "Die Anfrage konnte nicht verarbeitet werden." }, { status: e instanceof HttpError ? e.status : 500 });
}

export async function GET() {
  try {
    return Response.json({ banners: bannersFor(await requireUser()) }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return failure(e);
  }
}

export async function POST(req: Request) {
  try {
    checkOrigin(req);
    const user = await requireUser();
    const body = z.object({ action: z.literal("dismiss"), id: z.string().uuid(), clicked: z.boolean().default(false) }).parse(await req.json().catch(() => ({})));
    return Response.json(dismissBanner(user, body.id, body.clicked));
  } catch (e) {
    return failure(e);
  }
}
