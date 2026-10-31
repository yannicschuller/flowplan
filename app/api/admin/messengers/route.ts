// Administration → Chat-Apps (lib/messengers.ts): which services people may
// connect, which server addresses they may use, the instance's Telegram bot
// and the deliveries of 24 hours. Administrators in the browser only; API
// tokens never. The answer carries "…abcd" of the bot token, never the token.
import { z } from "zod";
import { checkOrigin, HttpError, requireUser } from "@/lib/auth";
import { withRequestLocale } from "@/lib/content-locale";
import { requireOpsAdmin } from "@/lib/admin-ops";
import { messengerAdminStatusFresh, removeMessengerBot, saveMessengerAdmin, saveMessengerBot } from "@/lib/messengers";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { headers: { "Cache-Control": "no-store" } };

function failure(e: unknown) {
  if (e instanceof z.ZodError) return Response.json({ error: "Ungültige Eingabe." }, { status: 400, ...noStore });
  if (!(e instanceof HttpError)) console.error(e);
  return Response.json({ error: e instanceof HttpError ? e.message : "Aktion fehlgeschlagen." }, { status: e instanceof HttpError ? e.status : 500, ...noStore });
}

export const GET = withRequestLocale(async () => {
  try {
    requireOpsAdmin(await requireUser());
    return Response.json(await messengerAdminStatusFresh(), noStore);
  } catch (e) {
    return failure(e);
  }
});

const actionSchema = z.object({ action: z.enum(["save", "bot", "bot.remove"]) });

export const POST = withRequestLocale(async (req: Request) => {
  try {
    checkOrigin(req);
    const user = requireOpsAdmin(await requireUser());
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const { action } = actionSchema.parse(body);
    if (action === "save") return Response.json(saveMessengerAdmin(user, body), noStore);
    if (action === "bot") return Response.json(await saveMessengerBot(user, body), noStore);
    return Response.json(removeMessengerBot(user), noStore);
  } catch (e) {
    return failure(e);
  }
});
