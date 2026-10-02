// The product website (landing page and the public demo) runs only on the
// official instance (flowplan.org). Self-hosted instances leave
// FLOWPLAN_PUBLIC_SITE unset: visitors get the sign-in page and there is no
// demo.
export function publicSite() {
  return process.env.FLOWPLAN_PUBLIC_SITE === "true";
}
