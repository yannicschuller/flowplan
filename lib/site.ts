// The official instance (app.flowplan.org) may offer the public demo that
// the website (flowplan.org, its own project) links to. Self-hosted
// instances leave FLOWPLAN_PUBLIC_SITE unset: there is no demo.
export function publicSite() {
  return process.env.FLOWPLAN_PUBLIC_SITE === "true";
}
