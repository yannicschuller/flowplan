// Client-safe texts for invitation links for several people (#320): the
// sign-in page and the app say why a link did not open.
// Why an invitation link for several people does not open (lib/invite-links.ts).
export function joinRefusalText(reason: string, t: (de: string, en: string) => string) {
  switch (reason) {
    case "expired":
      return t("Dieser Einladungslink ist abgelaufen. Bitte frag nach einem neuen.", "This invite link has expired. Please ask for a new one.");
    case "revoked":
      return t("Dieser Einladungslink wurde zurückgezogen.", "This invite link was revoked.");
    case "used_up":
      return t("Dieser Einladungslink wurde schon so oft verwendet wie erlaubt.", "This invite link has been used as often as allowed.");
    case "disabled":
      return t("Einladungslinks sind auf dieser Instanz ausgeschaltet.", "Invite links are switched off on this instance.");
    case "limited":
      return t("Zu viele Versuche mit Einladungslinks. Bitte versuch es später erneut.", "Too many attempts with invite links. Please try again later.");
    default:
      return t("Dieser Einladungslink ist ungültig.", "This invite link is not valid.");
  }
}
