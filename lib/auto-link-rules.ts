// A workspace's automatic link rules on the server (#202, lib/auto-link.ts):
// stored as JSON in workspaces.link_rules (NULL = none), delivered to every
// member and guest in the bootstrap, changed by owners only.
import { audit, id, one, run } from "./db";
import { HttpError } from "./auth";
import { requireMember } from "./permissions";
import { AUTO_LINK_LIMITS, autoLinkRuleSchema, autoLinkRulesSchema, ruleProblems, type AutoLinkProblem, type AutoLinkRule, type AutoLinkRuleInput } from "./auto-link";
import type { Identity } from "./types";

// The server's (German) message for the first problem of a rule
// (English in lib/i18n-errors.ts).
const MESSAGES: Record<AutoLinkProblem, string> = {
  "pattern-empty": "Das Muster fehlt.",
  "pattern-long": "Das Muster ist länger als 200 Zeichen.",
  "pattern-invalid": "Das Muster ist kein gültiger regulärer Ausdruck.",
  "pattern-empty-match": "Das Muster darf nicht auf leeren Text passen.",
  "pattern-nested": "Das Muster wiederholt eine Gruppe, die selbst schon wiederholt (zu langsam).",
  "template-empty": "Die Link-Vorlage fehlt.",
  "template-long": "Die Link-Vorlage ist länger als 500 Zeichen.",
  "template-scheme": "Die Link-Vorlage muss mit https://, http:// oder mailto: beginnen.",
  "template-unsafe": "Die Link-Vorlage ergibt keine gültige Adresse.",
  "name-long": "Der Name ist länger als 60 Zeichen.",
};
export const autoLinkProblemMessage = (problem: AutoLinkProblem) => MESSAGES[problem];

// Stored rules; anything unreadable counts as none.
export async function workspaceLinkRules(workspaceId: string): Promise<AutoLinkRule[]> {
  const raw = (await one<{ link_rules: string | null }>("SELECT link_rules FROM workspaces WHERE id=?", workspaceId))?.link_rules;
  if (!raw) return [];
  try {
    const parsed = autoLinkRulesSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.map(normalize) : [];
  } catch {
    return [];
  }
}

const normalize = (rule: AutoLinkRuleInput): AutoLinkRule => ({
  id: rule.id || id(),
  name: (rule.name || "").trim(),
  pattern: rule.pattern,
  template: rule.template.trim(),
  enabled: rule.enabled !== false,
});

// Owners replace the whole list; every rule must be valid.
export async function saveWorkspaceLinkRules(user: Identity, workspaceId: string, input: unknown) {
  await requireMember(user, workspaceId, "owner");
  if (Array.isArray(input) && input.length > AUTO_LINK_LIMITS.rules) throw new HttpError(400, "Höchstens 50 Regeln.");
  const rules = autoLinkRulesSchema.parse(input).map(normalize);
  const seen = new Set<string>();
  for (const rule of rules) {
    if (seen.has(rule.id)) rule.id = id();
    seen.add(rule.id);
    const [problem] = ruleProblems(rule);
    if (problem) throw new HttpError(400, MESSAGES[problem]);
  }
  await run("UPDATE workspaces SET link_rules=? WHERE id=?", rules.length ? JSON.stringify(rules) : null, workspaceId);
  await audit(user.id, "workspace.linkRules", workspaceId, String(rules.length));
  return { rules };
}

// ---- Archives (lib/archive.ts) and the JSON backup ----

// An archive's rules in the workspace it is imported into: only by an owner
// (as in the settings), checked rule by rule like saveWorkspaceLinkRules –
// an invalid one is left out and counted (`dropped`), never the whole
// import. Added to the workspace's own rules like tags and property
// definitions: a rule whose pattern the workspace already has keeps the
// workspace's version; at most AUTO_LINK_LIMITS.rules in all (the rest
// counts as dropped).
export async function importLinkRules(user: Identity, workspaceId: string, input: unknown) {
  if (input === undefined || input === null) return { added: 0, dropped: 0 };
  if ((await one<{ role: string }>("SELECT role FROM members WHERE workspace_id=? AND user_id=?", workspaceId, user.id))?.role !== "owner") return { added: 0, dropped: 0 };
  if (!Array.isArray(input)) return { added: 0, dropped: 1 };
  const rules = await workspaceLinkRules(workspaceId);
  const patterns = new Set(rules.map((r) => r.pattern));
  const ids = new Set(rules.map((r) => r.id));
  let added = 0,
    dropped = 0;
  for (const entry of input) {
    const parsed = autoLinkRuleSchema.safeParse(entry);
    const rule = parsed.success ? normalize(parsed.data) : null;
    if (!rule || ruleProblems(rule).length) {
      dropped++;
      continue;
    }
    if (patterns.has(rule.pattern)) continue;
    if (rules.length >= AUTO_LINK_LIMITS.rules) {
      dropped++;
      continue;
    }
    if (ids.has(rule.id)) rule.id = id();
    patterns.add(rule.pattern);
    ids.add(rule.id);
    rules.push(rule);
    added++;
  }
  if (added) await run("UPDATE workspaces SET link_rules=? WHERE id=?", JSON.stringify(rules), workspaceId);
  return { added, dropped };
}
