// The page behind the link in the e-mail about a request for emergency
// access (#281, lib/emergency-access.ts): it asks once more – programs that
// scan mail links only open it – and the button sends the denial. Plain
// HTML without scripts or styles (strict policy below), in the holder's
// language.
import { denyPreview, denyWithToken } from "./emergency-access";
import { translate, type Locale } from "./i18n";
import { mailAppUrl } from "./mail";

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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
function gone(locale: Locale = "de") {
  const t = translate(locale);
  return page(
    locale,
    t("Link nicht mehr gültig", "Link no longer valid"),
    `<p>${escape(
      t(
        "Diese Anfrage auf Notfallzugriff ist schon beendet (abgelehnt, zurückgezogen oder durch eine neue ersetzt). Den aktuellen Stand siehst du in Flowplan unter Einstellungen → Konto & Sicherheit → Notfallzugriff.",
        "This emergency access request has already ended (denied, withdrawn or replaced by a new one). See where things stand in Flowplan under Settings → Account & security → Emergency access.",
      ),
    )}</p><p><a href="${escape(mailAppUrl())}/#settings/account/emergency">${escape(t("Flowplan öffnen", "Open Flowplan"))}</a></p>`,
    410,
  );
}

export async function emergencyDenyPage(token: string) {
  const preview = await denyPreview(token);
  if (!preview) return gone();
  const t = translate(preview.locale);
  const granted = preview.status === "granted";
  return page(
    preview.locale,
    granted ? t("Notfallzugriff beenden", "End emergency access") : t("Notfallzugriff ablehnen", "Deny emergency access"),
    `<p>${escape(
      granted
        ? t(`${preview.contact} hat Lesezugriff auf deine Inhalte. Mit dem Knopf endet er sofort.`, `${preview.contact} has read access to your content. The button ends it right away.`)
        : t(
            `${preview.contact} hat Notfallzugriff auf deine Inhalte angefragt. Mit dem Knopf lehnst du ab; ${preview.contact} bekommt dann keinen Zugriff.`,
            `${preview.contact} asked for emergency access to your content. The button denies it; ${preview.contact} then gets no access.`,
          ),
    )}</p><form method="post" action="/api/emergency/deny"><input type="hidden" name="token" value="${escape(token)}"><button type="submit">${escape(
      granted ? t("Zugriff beenden", "End access") : t("Anfrage ablehnen", "Deny the request"),
    )}</button></form>`,
  );
}

export async function emergencyDenied(token: string) {
  const result = await denyWithToken(token);
  if (!result) return gone();
  const t = translate(result.locale);
  return page(
    result.locale,
    result.ended === "access" ? t("Notfallzugriff beendet", "Emergency access ended") : t("Anfrage abgelehnt", "Request denied"),
    `<p>${escape(
      t(
        "Erledigt. Deine Vertrauensperson wurde benachrichtigt. Wenn du die Anfrage nicht erwartet hast, sprich mit ihr – und prüfe in Flowplan unter Einstellungen → Konto & Sicherheit, wer deine Vertrauenspersonen sind.",
        "Done. Your trusted contact has been told. If you did not expect the request, talk to them – and check who your trusted contacts are in Flowplan under Settings → Account & security.",
      ),
    )}</p><p><a href="${escape(mailAppUrl())}/#settings/account/emergency">${escape(t("Flowplan öffnen", "Open Flowplan"))}</a></p>`,
  );
}
