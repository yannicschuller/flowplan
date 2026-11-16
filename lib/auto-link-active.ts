// The automatic link rules of the open workspace (#202) in the browser, set
// by the app from the bootstrap and read by the editors' plugin
// (lib/auto-link-plugin.ts). Apart from the plugin, so the workspace sets
// them without loading TipTap.
import { compileRules, type AutoLinkRule, type CompiledRule } from "./auto-link";

// Compiled once per rule set.
let current: { key: string; rules: CompiledRule[] } = { key: "[]", rules: [] };
export function setAutoLinkRules(rules: readonly AutoLinkRule[] | null | undefined) {
  const key = JSON.stringify(rules || []);
  if (key !== current.key) current = { key, rules: compileRules(rules) };
}
export const workspaceAutoLinkRules = () => current.rules;
