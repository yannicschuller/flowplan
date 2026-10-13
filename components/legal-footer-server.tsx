// The legal links for server-rendered public pages.
import { legalLinks } from "@/lib/legal-links";
import { requestLocale } from "@/lib/i18n-server";
import { LegalFooter } from "./legal-footer";

export async function PublicLegalFooter() {
  return <LegalFooter links={legalLinks()} de={(await requestLocale()) === "de"} />;
}
