// Settings → Benachrichtigungen → Chat-Apps (lib/messengers.ts): the
// person's connections to Telegram, Gotify, ntfy and Matrix. GET lists them
// (where messages go, "…abcd" of a token – never a token); POST connects,
// changes, removes, switches on again, sends a test message, changes the
// person's choices or makes a Telegram connection link. Signed-in people in
// the browser only; API tokens never (they are about credentials).
import { z } from "zod";
import { checkOrigin, HttpError, requireUser } from "@/lib/auth";
import { withRequestLocale } from "@/lib/content-locale";
import {
  connectMessenger,
  createTelegramLink,
  enableMessenger,
  messengerOverview,
  removeMessenger,
  setMessengerSettings,
  testMessenger,
} from "@/lib/messengers";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { headers: { "Cache-Control": "no-store" } };

function failure(e: unknown) {
  if (e instanceof z.ZodError) return Response.json({ error: "Ungültige Eingabe." }, { status: 400, ...noStore });
  if (!(e instanceof HttpError)) console.error(e);
  return Response.json({ error: e instanceof HttpError ? e.message : "Aktion fehlgeschlagen." }, { status: e instanceof HttpError ? e.status : 500, ...noStore });
}

async function browserUser() {
  const user = await requireUser();
  if (user.apiScope) throw new HttpError(403, "Mit einem API-Token nicht möglich.");
  return user;
}

export const GET = withRequestLocale(async () => {
  try {
    return Response.json(messengerOverview(await browserUser()), noStore);
  } catch (e) {
    return failure(e);
  }
});

const actionSchema = z.object({ action: z.enum(["connect", "remove", "enable", "settings", "test", "link"]) });

export const POST = withRequestLocale(async (req: Request) => {
  try {
    checkOrigin(req);
    const user = await browserUser();
    const text = await req.text();
    if (text.length > 10_000) throw new HttpError(413, "Anfrage zu groß.");
    const body = JSON.parse(text || "{}") as Record<string, unknown>;
    const { action } = actionSchema.parse(body);
    switch (action) {
      case "connect":
        return Response.json(await connectMessenger(user, body), noStore);
      case "remove":
        return Response.json(removeMessenger(user, body), noStore);
      case "enable":
        return Response.json(enableMessenger(user, body), noStore);
      case "settings":
        return Response.json(setMessengerSettings(user, body), noStore);
      case "test":
        return Response.json(await testMessenger(user, body), noStore);
      case "link":
        return Response.json(await createTelegramLink(user), noStore);
    }
  } catch (e) {
    if (e instanceof SyntaxError) return Response.json({ error: "Ungültige Eingabe." }, { status: 400 });
    return failure(e);
  }
});
