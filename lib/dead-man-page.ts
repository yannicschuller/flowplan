// The page behind "Ich bin da" in a warning about the inactivity message
// (#282, lib/dead-man-switch.ts): it asks once more – programs that scan
// mail links only open it, and must not check in for a holder who is no
// longer there – and the button checks in. Plain HTML without scripts or
// styles (strict policy below), in the holder's language.
import { herePreview, hereWithToken, DEADMAN_LINK } from "./dead-man-switch";
import { translate, type Locale } from "./i18n";
import { mailAppUrl } from "./mail";

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const when = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
function page(locale: Locale, title: string, body: string, status = 200) {
  return new Response(
    `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escape(title)}</title></head><body><main><h1>${escape(title)}</h1>${body}</main></body></html>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      },
    },
  );
}
const open = (locale: Locale) =>
  `<p><a href="${escape(mailAppUrl())}/${DEADMAN_LINK}">${escape(translate(locale)("Flowplan öffnen", "Open Flowplan"))}</a></p>`;
function gone(locale: Locale = "de") {
  const t = translate(locale);
  return page(
    locale,
    t("Link nicht mehr gültig", "Link no longer valid"),
    `<p>${escape(
      t(
        "Dieser Link wurde schon benutzt, ist abgelaufen, oder die Nachricht ist inzwischen ausgeschaltet oder verschickt. Melde dich einfach in Flowplan an – jede Anmeldung zählt als Lebenszeichen. Den Stand siehst du unter Einstellungen → Konto & Sicherheit → Nachricht bei Inaktivität.",
        "This link was already used or has expired, or the message has been switched off or sent meanwhile. Simply sign in to Flowplan – every sign-in counts as a sign of life. See where things stand under Settings → Account & security → Inactivity message.",
      ),
    )}</p>${open(locale)}`,
    410,
  );
}

export async function deadmanHerePage(token: string) {
  const preview = await herePreview(token);
  if (!preview) return gone();
  const t = translate(preview.locale);
  return page(
    preview.locale,
    t("Bist du da?", "Are you there?"),
    `<p>${escape(
      t(
        `Mit dem Knopf meldest du dich zurück: Deine Nachricht bei Inaktivität für „${preview.workspace}“ wird nicht verschickt, die Frist beginnt neu.`,
        `The button checks you in: your inactivity message for “${preview.workspace}” is not sent, the period starts again.`,
      ),
    )}</p><form method="post" action="/api/deadman/here"><input type="hidden" name="token" value="${escape(token)}"><button type="submit">${escape(
      t("Ich bin da", "I'm here"),
    )}</button></form>`,
  );
}

export async function deadmanHere(token: string) {
  const result = await hereWithToken(token);
  if (!result) return gone();
  const t = translate(result.locale);
  return page(
    result.locale,
    t("Danke – du bist zurückgemeldet", "Thanks – you are checked in"),
    `<p>${escape(
      t(
        `Deine Nachricht bei Inaktivität für „${result.workspace}“ bleibt eingeschaltet und wird frühestens am ${when(result.fireAt)} verschickt – nur wenn du bis dahin Flowplan nicht nutzt. Warst du das nicht? Prüfe in Flowplan unter Einstellungen → Konto & Sicherheit deine Geräte und die Nachricht bei Inaktivität.`,
        `Your inactivity message for “${result.workspace}” stays on and is sent on ${when(result.fireAt)} at the earliest – only if you do not use Flowplan until then. Wasn't you? Check your devices and the inactivity message in Flowplan under Settings → Account & security.`,
      ),
    )}</p>${open(result.locale)}`,
  );
}
