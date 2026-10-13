// Legal notice and privacy policy under public pages and the sign-in page –
// only when the instance sets IMPRINT_URL or PRIVACY_URL.
import type { LegalLinks } from "@/lib/legal-links";

export function LegalFooter({ links, de }: { links: LegalLinks; de: boolean }) {
  if (!links.imprint && !links.privacy) return null;
  return (
    <nav className="legal-footer" aria-label={de ? "Rechtliches" : "Legal"}>
      {links.imprint && (
        <a href={links.imprint} rel="noopener">
          {de ? "Impressum" : "Legal notice"}
        </a>
      )}
      {links.privacy && (
        <a href={links.privacy} rel="noopener">
          {de ? "Datenschutz" : "Privacy"}
        </a>
      )}
    </nav>
  );
}
