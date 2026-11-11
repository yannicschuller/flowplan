// Automatic links of a workspace (#202): rules its owners set ("ABC-\d+" →
// "https://jira.example/browse/{match}") turn matching text into a real link
// mark while someone types or pastes it (lib/auto-link-plugin.ts). This file
// is plain logic shared by the server (validation, lib/auto-link-rules.ts),
// the settings (live tester) and the editors.
//
// Templates: {match} is the whole match, $1 … $9 and {1} … {9} its capture
// groups. Every value is URL-encoded (encodeURIComponent) when it goes into
// the template, and the result must be an http(s) or mailto address
// (safeHref of lib/inline-markdown.ts) – otherwise nothing is linked.
//
// Regular expressions of others run in every member's browser, so they are
// kept small and simple: at most 200 characters, no pattern that can match
// nothing, no quantified group that itself repeats ("(a+)+", the usual
// catastrophic backtracking), and the editors only ever look at the text
// around what was just typed or pasted, capped in length.
import { z } from "zod";
import { safeHref } from "./inline-markdown";

export type AutoLinkRule = {
  id: string;
  // Optional label shown in the settings.
  name: string;
  pattern: string;
  template: string;
  enabled: boolean;
};

export const AUTO_LINK_LIMITS = { rules: 50, pattern: 200, template: 500, name: 60 };
// What the API takes (workspace.linkRules); ruleProblems() checks the rest.
export const autoLinkRuleSchema = z.object({
  id: z.string().max(64).optional(),
  name: z.string().max(AUTO_LINK_LIMITS.name).optional(),
  pattern: z.string().max(AUTO_LINK_LIMITS.pattern),
  template: z.string().max(AUTO_LINK_LIMITS.template),
  enabled: z.boolean().optional(),
});
export const autoLinkRulesSchema = z.array(autoLinkRuleSchema).max(AUTO_LINK_LIMITS.rules);
export type AutoLinkRuleInput = z.infer<typeof autoLinkRuleSchema>;
// Characters of a text block the editors look at per change (typing: before
// the cursor; pasting: each pasted block, and all of them together).
export const AUTO_LINK_SCAN = { typed: 1000, block: 4000, total: 20000, matches: 200 };

export type AutoLinkProblem =
  | "pattern-empty"
  | "pattern-long"
  | "pattern-invalid"
  | "pattern-empty-match"
  | "pattern-nested"
  | "template-empty"
  | "template-long"
  | "template-scheme"
  | "template-unsafe"
  | "name-long";

// The flags rules run with: global and Unicode; patterns written for the
// non-Unicode syntax ("\-" outside a class) fall back to global only.
export function compilePattern(pattern: string): RegExp | null {
  for (const flags of ["gu", "g"])
    try {
      return new RegExp(pattern, flags);
    } catch {}
  return null;
}

// A group that holds an unbounded quantifier and is itself repeated:
// "(a+)+", "(?:x*y)*", "(\d+){2,}". Escapes and classes are skipped.
export function hasNestedQuantifier(pattern: string): boolean {
  const stack: boolean[] = [];
  let inner = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "[") {
      for (i++; i < pattern.length && pattern[i] !== "]"; i++) if (pattern[i] === "\\") i++;
      continue;
    }
    if (c === "(") {
      stack.push(inner);
      inner = false;
      continue;
    }
    const rest = pattern.slice(i + 1);
    const repeated = /^(?:[+*]|\{\d*,\d*\})/.test(rest);
    if (c === ")") {
      const had = inner;
      inner = stack.pop() ?? false;
      if (had && repeated) return true;
      // The group counts as repeating inside its parent.
      if (had || repeated) inner = true;
      continue;
    }
    if (c === "+" || c === "*" || (c === "{" && /^\d*,\d*\}/.test(rest))) inner = true;
  }
  return false;
}

const PLACEHOLDER = /\{match\}|\{([1-9])\}|\$([1-9])/g;

// The template with the match's values put in, URL-encoded.
export function expandTemplate(template: string, match: readonly (string | undefined)[]): string {
  return template.replace(PLACEHOLDER, (token, brace?: string, dollar?: string) => {
    const index = token === "{match}" ? 0 : Number(brace || dollar);
    return encodeURIComponent(match[index] ?? "");
  });
}

// The link a match leads to, or null when the result is no safe address.
export function autoLinkHref(template: string, match: readonly (string | undefined)[]): string | null {
  const href = safeHref(expandTemplate(template, match));
  return href && /^(?:https?:\/\/|mailto:)/i.test(href) ? href : null;
}

// What is wrong with a rule; empty when it may be saved.
export function ruleProblems(rule: Pick<AutoLinkRule, "pattern" | "template"> & { name?: string }): AutoLinkProblem[] {
  const problems: AutoLinkProblem[] = [];
  if ((rule.name || "").length > AUTO_LINK_LIMITS.name) problems.push("name-long");
  const pattern = rule.pattern || "";
  if (!pattern) problems.push("pattern-empty");
  else if (pattern.length > AUTO_LINK_LIMITS.pattern) problems.push("pattern-long");
  else {
    const re = compilePattern(pattern);
    if (!re) problems.push("pattern-invalid");
    else if (hasNestedQuantifier(pattern)) problems.push("pattern-nested");
    else if (["", " ", "a", "A1 b-2 #3"].some((sample) => {
      re.lastIndex = 0;
      const m = re.exec(sample);
      return !!m && m[0] === "";
    }))
      problems.push("pattern-empty-match");
  }
  const template = (rule.template || "").trim();
  if (!template) problems.push("template-empty");
  else if (template.length > AUTO_LINK_LIMITS.template) problems.push("template-long");
  else if (!/^(?:https?:\/\/[^\s/]|mailto:)/i.test(template)) problems.push("template-scheme");
  else if (!autoLinkHref(template, ["ABC-123", "123", "x", "y", "z", "1", "2", "3", "4", "5"])) problems.push("template-unsafe");
  return problems;
}

// The rules as the editors use them: enabled and valid ones, compiled once.
export type CompiledRule = { id: string; re: RegExp; template: string };
export function compileRules(rules: readonly AutoLinkRule[] | null | undefined): CompiledRule[] {
  const out: CompiledRule[] = [];
  for (const rule of rules || []) {
    if (!rule?.enabled || ruleProblems(rule).length) continue;
    const re = compilePattern(rule.pattern);
    if (re) out.push({ id: rule.id, re, template: rule.template.trim() });
  }
  return out;
}

export type AutoLinkMatch = { from: number; to: number; text: string; href: string; rule: string };

// Every match of the rules in a text, without overlaps: the earliest start
// wins, the first rule on a tie. Empty matches never count.
export function findAutoLinks(text: string, rules: readonly CompiledRule[], limit = AUTO_LINK_SCAN.matches): AutoLinkMatch[] {
  const found: AutoLinkMatch[] = [];
  for (const rule of rules) {
    const re = rule.re;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    let count = 0;
    while ((m = re.exec(text)) && count < limit) {
      if (m[0] === "") {
        re.lastIndex++;
        continue;
      }
      count++;
      const href = autoLinkHref(rule.template, m);
      if (href) found.push({ from: m.index, to: m.index + m[0].length, text: m[0], href, rule: rule.id });
    }
  }
  found.sort((a, b) => a.from - b.from || rules.findIndex((r) => r.id === a.rule) - rules.findIndex((r) => r.id === b.rule));
  const out: AutoLinkMatch[] = [];
  for (const match of found) if (!out.length || match.from >= out[out.length - 1].to) out.push(match);
  return out.slice(0, limit);
}
