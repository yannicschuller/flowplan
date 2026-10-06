import type { MetadataRoute } from "next";
import { publicPaths, siteUrl } from "@/lib/seo";

export const dynamic = "force-dynamic";

export default function sitemap(): MetadataRoute.Sitemap {
  return publicPaths().map((path) => ({
    url: `${siteUrl()}${path}`,
    changeFrequency: "weekly",
    priority: path.startsWith("/templates/") ? 0.5 : 0.8,
  }));
}
