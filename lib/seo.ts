// The app is a private workspace: search engines and AI crawlers only see
// the doors (sign-in, sign-up) and the public template gallery. What
// Flowplan is lives on the website and in the documentation.
import { catalogFor } from "./template-catalogs";
import { publicTemplates } from "./public-templates";

export const siteUrl = () => (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
export const WEBSITE_URL = "https://flowplan.org";
export const DOCS_URL = "https://docs.flowplan.org";
export const GITHUB_URL = "https://github.com/yannicschuller/flowplan";

// Indexed pages: always the same for every reader, so no language versions.
export function publicPaths() {
  const builtIn = Object.keys(catalogFor("de")).map((key) => `/templates/starter-${key}`);
  const published = publicTemplates().map((t) => `/templates/${t.id}`);
  return ["/login", "/register", "/templates", ...builtIn, ...published];
}

export function llmsText() {
  return [
    "# Flowplan (app)",
    "",
    "> This is a Flowplan instance: the open-source workspace (AGPL-3.0) for documents, databases, whiteboards and a daily journal. Workspaces are private and need an account; only sign-in, sign-up and the template gallery are public.",
    "",
    "## Links",
    "",
    `- [What Flowplan is](${WEBSITE_URL}/llms.txt)`,
    `- [Documentation](${DOCS_URL}/llms.txt)`,
    `- [Template gallery](${siteUrl()}/templates)`,
    `- [Source code](${GITHUB_URL})`,
    "",
  ].join("\n");
}
