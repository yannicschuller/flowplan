// "Schriftart" (#512, lib/personal-font.ts) as a style element: this
// person's typeface over the workspace's look. Rendered on the server with
// the page (no flash of the default face) and again when the choice
// changes; nothing for the default. Works in server and client components.
import { personalFontCss, type PersonalFont } from "@/lib/personal-font";

export function PersonalFontStyle({ font }: { font: PersonalFont | undefined }) {
  const css = personalFontCss(font ?? null);
  if (!css) return null;
  return <style data-personal-font="" dangerouslySetInnerHTML={{ __html: css }} />;
}
