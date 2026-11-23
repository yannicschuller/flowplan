// Comment pins on whiteboards (#455, lib/whiteboard-comments-server.ts).
// Browser sessions only – API tokens are refused; changes also need the
// origin check.
//   GET  ?mentions=<page>,<page>:<record>,…   titles of mentioned pages this
//                                             person may read (null: no access)
//   POST {notify: {item, message}}            the people a new message mentions
//                                             hear of it (once)
//   POST {trash: [fileId, …]}                 files of deleted comments to the
//                                             file trash when nothing uses them
import { requireModule } from "@/lib/instance-modules";
import { serverError } from "@/lib/request-context";
import { NextResponse } from "next/server";
import { z } from "zod";
import { checkOrigin, HttpError, sessionIdentityFromRequest } from "@/lib/auth";
import { withRequestLocale } from "@/lib/content-locale";
import { boardMentionTitles, MENTION_KEYS_LIMIT, notifyBoardMentions, trashBoardCommentFiles } from "@/lib/whiteboard-comments-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };
const noStore = { headers: { "Cache-Control": "no-store" } };

async function signedIn(req: Request) {
  if (req.headers.get("authorization")) throw new HttpError(403, "Nur im Browser verfügbar.");
  const user = await sessionIdentityFromRequest(req);
  if (!user) throw new HttpError(401, "Bitte melde dich an.");
  if (user.twoFactorSetup) throw new HttpError(403, "Bitte richte zuerst die Zwei-Faktor-Anmeldung ein.");
  return user;
}
function error(e: unknown) {
  if (e instanceof z.ZodError) return NextResponse.json({ error: "Ungültige Eingabe." }, { status: 400 });
  if (!(e instanceof HttpError)) console.error(e);
  return NextResponse.json(
    { error: e instanceof HttpError ? e.message : "Die Anfrage konnte nicht verarbeitet werden." },
    { status: e instanceof HttpError ? e.status : serverError(e) },
  );
}

export const GET = withRequestLocale(async (req: Request, { params }: Context) => {
  try {
    const user = await signedIn(req);
    const pageId = z.uuid().parse((await params).id);
    const keys = (new URL(req.url).searchParams.get("mentions") || "").split(",").filter(Boolean).slice(0, MENTION_KEYS_LIMIT);
    return NextResponse.json({ titles: await boardMentionTitles(user, pageId, keys) }, noStore);
  } catch (e) {
    return error(e);
  }
});

const postSchema = z.union([
  z.object({ notify: z.object({ item: z.string().regex(/^[\w-]{1,64}$/), message: z.string().regex(/^[\w-]{1,64}$/) }) }).strict(),
  z.object({ trash: z.array(z.uuid()).min(1).max(100) }).strict(),
]);

export const POST = withRequestLocale(async (req: Request, { params }: Context) => {
  try {
    await checkOrigin(req);
    const user = await signedIn(req);
    // Whiteboards switched off for the instance (#386): read-only.
    await requireModule("whiteboards");
    const pageId = z.uuid().parse((await params).id);
    if (Number(req.headers.get("content-length") || 0) > 16_384) throw new HttpError(413, "Anfrage zu groß.");
    const text = await req.text();
    if (text.length > 16_384) throw new HttpError(413, "Anfrage zu groß.");
    let raw: unknown;
    try {
      raw = JSON.parse(text || "{}");
    } catch {
      throw new HttpError(400, "Ungültige Eingabe.");
    }
    const body = postSchema.parse(raw);
    if ("notify" in body) return NextResponse.json({ notified: await notifyBoardMentions(user, pageId, body.notify.item, body.notify.message) }, noStore);
    return NextResponse.json({ trashed: await trashBoardCommentFiles(user, pageId, body.trash) }, noStore);
  } catch (e) {
    return error(e);
  }
});
