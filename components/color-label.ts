// The name of a tag or option colour (Settings → Tags, database options).
// Its own module, so a database does not load the tags settings for it.
import type { PageTagColor } from "@/lib/page-properties";

export function colorLabel(color: PageTagColor, t: (de: string, en: string) => string) {
  const labels: Record<PageTagColor, string> = {
    gray: t("Grau", "Gray"),
    blue: t("Blau", "Blue"),
    green: t("Grün", "Green"),
    red: t("Rot", "Red"),
    yellow: t("Gelb", "Yellow"),
    orange: t("Orange", "Orange"),
    purple: t("Lila", "Purple"),
    pink: t("Rosa", "Pink"),
    teal: t("Türkis", "Teal"),
  };
  return labels[color];
}
