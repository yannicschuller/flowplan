// Links to the operator's legal notice and privacy policy (IMPRINT_URL,
// PRIVACY_URL). Shown only when set; only http(s) addresses count.
export type LegalLinks = { imprint?: string; privacy?: string };

const url = (value: string | undefined) => {
  const v = (value || "").trim();
  return /^https?:\/\/\S+$/i.test(v) ? v : undefined;
};

export function legalLinks(): LegalLinks {
  const links: LegalLinks = {};
  const imprint = url(process.env.IMPRINT_URL),
    privacy = url(process.env.PRIVACY_URL);
  if (imprint) links.imprint = imprint;
  if (privacy) links.privacy = privacy;
  return links;
}
