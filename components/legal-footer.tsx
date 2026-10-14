// Legal notice and privacy policy under public pages and the sign-in page –
// only when the instance sets IMPRINT_URL or PRIVACY_URL.
import type { LegalLinks } from "@/lib/legal-links";
import { translate, type Locale } from "@/lib/i18n";

export function LegalFooter({ links, locale }: { links: LegalLinks; locale: Locale }) {
  if (!links.imprint && !links.privacy) return null;
  const say = translate(locale);
  return (
    <nav className="legal-footer" aria-label={say("Rechtliches", "Legal")}>
      {links.imprint && (
        <a href={links.imprint} rel="noopener">
          {say("Impressum", "Legal notice")}
        </a>
      )}
      {links.privacy && (
        <a href={links.privacy} rel="noopener">
          {say("Datenschutz", "Privacy")}
        </a>
      )}
    </nav>
  );
}
