import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/seo";

// Addresses come from APP_URL at runtime.
export const dynamic = "force-dynamic";

// Only the doors and the template gallery are for crawlers; workspaces,
// share links, forms, customer requests and the API are not.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: ["/login", "/register", "/templates", "/llms.txt", "/opengraph-image"],
      disallow: ["/"],
    },
    sitemap: `${siteUrl()}/sitemap.xml`,
    host: siteUrl(),
  };
}
