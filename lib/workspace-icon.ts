import { parseLibraryIcon } from "./icon-library";

// Workspace symbols: an emoji, a library icon ("icon:Name:#color") or a
// small image stored inline (data URL, resized in the browser). An empty
// value or the old single letter shows the first letter of the name.
export const MAX_WORKSPACE_IMAGE = 150_000;
const IMAGE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
export const workspaceImage = (icon?: string | null) =>
  !!icon && IMAGE.test(icon);
export const workspaceLetterIcon = (icon?: string | null) =>
  !icon || /^[A-Za-z0-9]$/.test(icon);
export function validWorkspaceIcon(icon: unknown): string | null {
  if (typeof icon !== "string") return null;
  if (icon === "") return "";
  if (icon.startsWith("data:"))
    return icon.length <= MAX_WORKSPACE_IMAGE && IMAGE.test(icon) ? icon : null;
  if (icon.startsWith("icon:")) return parseLibraryIcon(icon) ? icon : null;
  // Emoji (including sequences with joiners and skin tones).
  return icon.length <= 16 &&
    /^[\p{Extended_Pictographic}\p{Emoji_Component}‍️]+$/u.test(icon)
    ? icon
    : null;
}
