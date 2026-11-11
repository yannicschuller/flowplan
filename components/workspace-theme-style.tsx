// The look of a workspace (#196, lib/workspace-theme.ts) as a style element:
// CSS variables on the root for light and dark, and @font-face rules of the
// faces it uses. Rendered on the server with the page (no flash of the
// default look) and again when the workspace or its look changes; nothing
// for the default look. Works in server and client components alike.
import { appFontUrl, themeCss, type WorkspaceLook } from "@/lib/workspace-theme";

export function WorkspaceThemeStyle({ look, fontUrl = appFontUrl }: { look: WorkspaceLook | null | undefined; fontUrl?: (id: string) => string }) {
  const css = themeCss(look, fontUrl);
  if (!css) return null;
  return <style data-workspace-theme="" dangerouslySetInnerHTML={{ __html: css }} />;
}
