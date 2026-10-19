import type { MetadataRoute } from "next";
import { cookies, headers } from "next/headers";
import { LOCALE_COOKIE, pickLocale, translate } from "@/lib/i18n";

// The web app manifest in the reader's language: name, description and the
// shortcuts of the installed app (long press on its icon).
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const t = translate(pickLocale((await cookies()).get(LOCALE_COOKIE)?.value, (await headers()).get("accept-language")));
  const icon = [{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }];
  return {
    name: "Flowplan",
    short_name: "Flowplan",
    description: t("Dein Arbeitsbereich für Notizen und Projekte", "Your workspace for notes and projects"),
    start_url: "/",
    display: "standalone",
    background_color: "#fcfbf8",
    theme_color: "#3b3fd8",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    ],
    id: "/",
    scope: "/",
    shortcuts: [
      { name: t("Erfassen", "Capture"), short_name: t("Erfassen", "Capture"), description: t("Ein Eintrag in deiner Datenbank zum Erfassen", "A record in your capture database"), url: "/#capture", icons: icon },
      { name: t("Neue Seite", "New page"), short_name: t("Neue Seite", "New page"), url: "/#new", icons: icon },
      { name: t("Suchen", "Search"), short_name: t("Suchen", "Search"), url: "/#search", icons: icon },
    ],
    share_target: {
      action: "/share-target",
      method: "GET",
      params: { title: "title", text: "text", url: "url" },
    },
  };
}
