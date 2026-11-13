import { z } from "zod";
import { MAX_WORKSPACE_IMAGE, workspaceImage } from "./workspace-icon";
export const spaceColors = [
  ["none", "Ohne Farbe"],
  ["gray", "Grau"],
  ["brown", "Braun"],
  ["orange", "Orange"],
  ["yellow", "Gelb"],
  ["green", "Grün"],
  ["blue", "Blau"],
  ["purple", "Violett"],
  ["pink", "Rosa"],
  ["red", "Rot"],
] as const;
export const spaceColorSchema = z.enum(spaceColors.map(([value]) => value));
// The symbol a new space gets, and what "Entfernen" goes back to.
export const DEFAULT_SPACE_ICON = "folder";
// A space symbol is an emoji, a built-in or library icon name, or – like the
// workspace symbol (lib/workspace-icon.ts, #251) – a small image stored
// inline as a data URL, with the same types, size limit and processing. It
// travels with the space row, so it reaches exactly the people the space is
// listed for, and goes with the space when it changes or is deleted.
export const spaceImage = workspaceImage;
export const spaceIconSchema = z.union([
  z.string().min(1).max(30).refine((icon) => !icon.startsWith("data:")),
  z.string().max(MAX_WORKSPACE_IMAGE).refine(workspaceImage),
]);
