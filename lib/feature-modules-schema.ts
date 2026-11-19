import { z } from "zod";
import { FEATURE_MODULES } from "./feature-modules";

// What the server accepts as switched-off features (#378,
// lib/feature-modules.ts): known features, each once. Apart from the
// list itself, so the browser's copy stays without zod.
export const hiddenModulesSchema = z
  .array(z.enum(FEATURE_MODULES))
  .max(FEATURE_MODULES.length)
  .refine((list) => new Set(list).size === list.length, "A feature may be listed only once.");
