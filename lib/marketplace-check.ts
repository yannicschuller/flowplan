// The import check of a marketplace package (docs: Marketplace, "Import
// check"): would importing it here work? For flowplan-admin's review – a
// reviewer's server posts each submission to a dedicated test workspace of
// a Flowplan instance and shows the answer – and for anyone who wants to
// know before importing.
//
// Two stages:
//   1. The package is read exactly like the import reads it
//      (readPackage: sizes, ZIP safety, envelope, the kind's schema).
//   2. A dry run in the target workspace: the kind's own import runs inside
//      a transaction that is always rolled back – the template, the page
//      made from it with its fields, views, records and attachments, the
//      whiteboard template, the look with its typefaces, the link rules.
//      Errors that only show on insert (duplicate ids, a broken database
//      schema, quotas) are caught that way. Nothing stays: the rows go with
//      the rollback, attachment files written meanwhile are removed by the
//      rollback hooks, and nothing outside the database is called – no
//      command() (it would send webhooks), no page events, no audit entry.
//      Workflows are not inserted at all: their check is the import's own
//      reading, reference matching and graph validation in the workspace.
//
// API tokens need the permission "Marketplace-Prüfung" (lib/api-tokens.ts,
// column marketplace_check, off unless chosen); it reaches this check only,
// never a real import (that needs a write token as before). Read tokens
// with the permission may use it – it never keeps anything: the dry run
// acts as the token's account (its permissions in the workspace count, the
// token's read scope would refuse the writes that are rolled back anyway).
import { createHash } from "node:crypto";
import { z } from "zod";
import { HttpError } from "./auth";
import { all, one, transaction } from "./db";
import { allow } from "./action-limits";
import { buildInfo } from "./build-info";
import { englishMessage } from "./i18n-errors";
import { isGuest, requireMember, spaceRole } from "./permissions";
import { readPackage, type ParsedPackage } from "./marketplace-package";
import { importTemplate } from "./template-exchange";
import { applyPageTemplate, type PageTemplate } from "./page-templates";
import { createPage } from "./seed";
import { importBoardTemplate } from "./whiteboard-user-templates";
import { importLook } from "./workspace-fonts";
import { importLinkRules } from "./auto-link-rules";
import { applyReferences, resolveReferences } from "./workflows/portable";
import { checkGraph, issueMessage, parseGraph, type GraphIssue } from "./workflows/graph";
import { validateGraph } from "./workflows/validate";
import { nodeSpec } from "./workflows/catalog";
import { workflowLimits } from "./workflows/limits";
import type { Identity, Page, Space } from "./types";

export const TOKEN_MARKETPLACE_MISSING = "Dieses API-Token hat keine Berechtigung „Marketplace-Prüfung“.";
export const CHECK_LIMITS = { bytes: 25 * 1024 * 1024, perWindow: 30, windowMs: 10 * 60_000, issues: 40 } as const;

export type CheckIssue = { code: string; de: string; en: string; at?: string };
export type CheckResult = {
  ok: boolean;
  kind: string | null;
  title: string | null;
  minVersion: string | null;
  // This instance's version (what the check ran on).
  version: string;
  sha256: string;
  size: number;
  // What the import would create.
  creates: { templates?: number; pages?: number; fields?: number; views?: number; records?: number; files?: number; nodes?: number; items?: number; fonts?: number; rules?: number; theme?: boolean };
  errors: CheckIssue[];
  warnings: CheckIssue[];
  dryRun: { ran: boolean; rolledBack: boolean; workspace: boolean; ms: number; reason?: string };
  checkedAt: string;
};

// Browser sessions pass (members of the target workspace); tokens only with
// the permission; demo accounts and clipper tokens never.
export function requireMarketplaceCheck(user: Pick<Identity, "apiScope" | "apiMarketplaceCheck" | "demo">) {
  if (user.demo) throw new HttpError(403, "In der Demo nicht verfügbar.");
  if (!user.apiScope) return;
  if (user.apiScope === "clipper" || !user.apiMarketplaceCheck) throw new HttpError(403, TOKEN_MARKETPLACE_MISSING);
}

const issue = (code: string, de: string, at?: string): CheckIssue => ({ code, de, en: englishMessage(de), ...(at ? { at } : {}) });
// The import's own refusals, by their German message.
const READ_CODES: [RegExp, string][] = [
  [/größer als|zu groß/i, "package_too_large"],
  [/Dateipfad/i, "package_unsafe_path"],
  [/ZIP|Archiv/i, "package_zip"],
  [/template\.json|Beschreibung der Vorlage|Keine Marketplace-Vorlage/i, "package_manifest"],
  [/JSON/i, "package_json"],
  [/fehlt/i, "package_missing_part"],
  [/Schrift/i, "package_font"],
  [/Linkregel/i, "package_link_rules"],
  [/Workflow/i, "package_workflow"],
  [/Whiteboard/i, "package_whiteboard"],
  [/Erscheinungsbild/i, "package_appearance"],
];
const readCode = (message: string) => READ_CODES.find(([re]) => re.test(message))?.[1] ?? "package_invalid";

class DryRunDone<T> extends Error {
  constructor(readonly value: T) {
    super("dry run rolled back");
  }
}
// `fn` inside a transaction that never commits.
async function rolledBack<T>(fn: () => Promise<T>): Promise<T> {
  try {
    await transaction(async () => {
      throw new DryRunDone(await fn());
    });
  } catch (error) {
    if (error instanceof DryRunDone) return error.value as T;
    throw error;
  }
  throw new Error("unreachable");
}

const versionTuple = (v: string) => (/^(\d{1,4})\.(\d{1,4})\.(\d{1,4})/.exec(v || "") ?? []).slice(1).map(Number);
function newer(min: string, own: string) {
  const a = versionTuple(min);
  const b = versionTuple(own);
  if (a.length !== 3 || b.length !== 3) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

// The workspace the dry run uses: the given one (the caller must be a member,
// not a guest), else the first the caller owns, else one they edit.
async function targetWorkspace(user: Identity, workspaceId: unknown): Promise<string | null> {
  if (workspaceId) {
    const wid = z.uuid().parse(workspaceId);
    await requireMember(user, wid);
    if (await isGuest(user, wid)) throw new HttpError(403, "Gäste können keine Vorlagen importieren.");
    return wid;
  }
  const rows = await all<{ workspace_id: string; role: string }>(
    "SELECT m.workspace_id,m.role FROM members m WHERE m.user_id=? AND m.role IN ('owner','editor') AND NOT EXISTS(SELECT 1 FROM workspace_guests g WHERE g.workspace_id=m.workspace_id AND g.user_id=m.user_id) ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END, m.workspace_id",
    user.id,
  );
  return rows[0]?.workspace_id ?? null;
}
async function plainSpace(user: Identity, wid: string): Promise<Space | null> {
  for (const s of await all<Space>("SELECT * FROM spaces WHERE workspace_id=? AND encrypted=0 ORDER BY name,id", wid))
    if (["editor", "owner"].includes((await spaceRole(user, s)) || "")) return s;
  return null;
}

const graphIssue = (i: GraphIssue, at: string): CheckIssue => ({ code: `graph_${i.code}`, de: issueMessage(i, "de"), en: issueMessage(i, "en"), at: i.nodeId ? `${at}:${i.nodeId}` : at });

async function dryRun(user: Identity, pkg: ParsedPackage, wid: string, result: CheckResult) {
  const p = pkg.payload;
  const { errors, warnings, creates } = result;
  const role = (await one<{ role: string }>("SELECT role FROM members WHERE workspace_id=? AND user_id=?", wid, user.id))?.role ?? null;
  switch (p.kind) {
    case "document":
    case "database": {
      if (role !== "owner" && role !== "editor") {
        warnings.push(issue("dry_run_role", "Probelauf übersprungen: Für Vorlagen braucht es Bearbeitungsrechte im Arbeitsbereich."));
        return false;
      }
      const space = await plainSpace(user, wid);
      const made = await rolledBack(async () => {
        const template = await importTemplate(user, wid, p.zip, "private", null);
        const row = (await one<PageTemplate>("SELECT * FROM templates WHERE id=?", template.id))!;
        const files = Number((await one<{ n: number }>("SELECT COUNT(*) n FROM template_files WHERE template_id=?", template.id))?.n ?? 0);
        if (!space) return { files, page: null };
        // A page made from it, the way "Neue Seite aus Vorlage" does.
        const pageId = await createPage(wid, space.id, user.id, row.name, row.kind, null, "empty");
        const page = (await one<Page>("SELECT * FROM pages WHERE id=?", pageId))!;
        await applyPageTemplate(user, page, row, false);
        const records = p.kind === "database" ? Number((await one<{ n: number }>("SELECT COUNT(*) n FROM rows WHERE page_id=?", pageId))?.n ?? 0) : undefined;
        const pageFiles = Number((await one<{ n: number }>("SELECT COUNT(*) n FROM files WHERE page_id=?", pageId))?.n ?? 0);
        return { files, page: { records, pageFiles } };
      });
      creates.templates = 1;
      creates.files = made.files;
      if (made.page) {
        creates.pages = 1;
        if (made.page.records !== undefined) creates.records = made.page.records;
      } else warnings.push(issue("dry_run_partial", "Probelauf ohne Seite aus der Vorlage: Kein Bereich, in dem du Seiten anlegen darfst."));
      return true;
    }
    case "whiteboard": {
      if (role !== "owner" && role !== "editor") {
        warnings.push(issue("dry_run_role", "Probelauf übersprungen: Für Vorlagen braucht es Bearbeitungsrechte im Arbeitsbereich."));
        return false;
      }
      const made = await rolledBack(() => importBoardTemplate(user, wid, { name: p.name, items: p.items, private: true }));
      creates.templates = 1;
      creates.items = made.items;
      return true;
    }
    case "appearance": {
      if (role !== "owner") {
        warnings.push(issue("dry_run_role", "Probelauf übersprungen: Das Erscheinungsbild übernehmen nur Besitzer."));
        return false;
      }
      const made = await rolledBack(() => importLook(user, wid, { theme: p.theme, fonts: p.fonts }, { replace: true }));
      if (made.droppedTheme) errors.push(issue("theme_invalid", "Das Erscheinungsbild ist ungültig."));
      if (made.droppedFonts) warnings.push(issue("fonts_dropped", `${made.droppedFonts} Schrift(en) würden nicht übernommen (Größe, Anzahl oder Speicherplatz).`));
      creates.fonts = p.fonts.length - made.droppedFonts;
      creates.theme = made.imported;
      return true;
    }
    case "link-rules": {
      if (role !== "owner") {
        warnings.push(issue("dry_run_role", "Probelauf übersprungen: Linkregeln übernehmen nur Besitzer."));
        return false;
      }
      const made = await rolledBack(() => importLinkRules(user, wid, p.rules));
      creates.rules = made.added;
      if (made.dropped) warnings.push(issue("rules_dropped", `${made.dropped} Linkregel(n) würden nicht übernommen.`));
      if (!made.added && !made.dropped) warnings.push(issue("rules_present", "Alle Linkregeln gibt es im Arbeitsbereich schon."));
      return true;
    }
    case "workflow": {
      if (!(await workflowLimits()).enabled) errors.push(issue("workflows_off", "Workflows sind auf dieser Instanz abgeschaltet."));
      if (role !== "owner" && role !== "editor") warnings.push(issue("dry_run_role", "Für einen Workflow braucht es Bearbeitungsrechte in einem Bereich."));
      // What workflow.import does with it, without saving the draft.
      const resolved = await resolveReferences(user, wid, p.data);
      const graph = applyReferences(resolved.graph, resolved.map, resolved.fieldMap, resolved.dropFields, resolved.unresolved);
      if (resolved.unresolved.length)
        warnings.push(issue("references_unresolved", `${resolved.unresolved.length} Verweis(e) bleiben nach dem Import offen und werden dort festgelegt.`));
      for (const i of await validateGraph(graph, { workspaceId: wid, runner: user })) {
        if (i.code === "unknown_type") continue;
        // After the import the person fills in what is missing: warnings, not errors.
        if (warnings.length < CHECK_LIMITS.issues) warnings.push(graphIssue(i, "workflow"));
      }
      return true;
    }
  }
}

export async function checkPackage(user: Identity, bytes: Buffer, options: { workspaceId?: unknown; dryRun?: boolean } = {}): Promise<CheckResult> {
  requireMarketplaceCheck(user);
  if (!allow(`marketplace-check:${user.id}`, CHECK_LIMITS.perWindow, CHECK_LIMITS.windowMs))
    throw new HttpError(429, "Zu viele Prüfungen in kurzer Zeit. Bitte später erneut versuchen.");
  const version = buildInfo().version || "";
  const result: CheckResult = {
    ok: false,
    kind: null,
    title: null,
    minVersion: null,
    version,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
    creates: {},
    errors: [],
    warnings: [],
    dryRun: { ran: false, rolledBack: false, workspace: false, ms: 0 },
    checkedAt: new Date().toISOString(),
  };
  if (bytes.length > CHECK_LIMITS.bytes) {
    result.errors.push(issue("package_too_large", "Das Paket ist größer als 25 MB."));
    return result;
  }
  // The workspace first: a wrong id is the caller's mistake, not the package's.
  const wid = options.dryRun === false ? null : await targetWorkspace(user, options.workspaceId);

  // 1. Read like the import.
  let pkg: ParsedPackage;
  try {
    pkg = await readPackage(bytes);
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    result.errors.push(issue(error.status === 413 ? "package_too_large" : readCode(error.message), error.message));
    return result;
  }
  const m = pkg.manifest;
  const p = pkg.payload;
  result.kind = m.kind;
  result.title = m.title;
  result.minVersion = m.minVersion;
  if (version && newer(m.minVersion, version))
    result.warnings.push(issue("min_version", `Die Vorlage braucht Flowplan ${m.minVersion} – diese Instanz hat ${version}.`));
  switch (p.kind) {
    case "document":
    case "database":
      result.creates = { templates: 1, pages: 1, files: p.files, ...(p.kind === "database" ? { fields: p.fields, views: p.views, records: p.rows } : {}) };
      break;
    case "workflow": {
      const graph = parseGraph(p.data.graph);
      result.creates = { pages: 1, nodes: graph.nodes.length };
      for (const n of graph.nodes)
        if (!nodeSpec(n.type)) result.errors.push({ code: "node_unknown", de: `Unbekannter Schritt-Typ ${n.type}.`, en: `Unknown step type ${n.type}.`, at: `workflow:${n.id}` });
      for (const i of checkGraph(graph)) {
        if (i.code === "unknown_type") continue;
        const list = i.level === "error" ? result.errors : result.warnings;
        if (list.length < CHECK_LIMITS.issues) list.push(graphIssue(i, "workflow"));
      }
      if (p.gaps.length) result.warnings.push(issue("gaps", `${p.gaps.length} Angabe(n) legt die Person beim Import fest.`));
      break;
    }
    case "whiteboard":
      result.creates = { templates: 1, items: p.items.length };
      if (p.dropped) result.warnings.push(issue("items_dropped", `${p.dropped} Element(e) würden nicht übernommen.`));
      break;
    case "appearance":
      result.creates = { theme: true, fonts: p.fonts.length };
      break;
    case "link-rules":
      result.creates = { rules: p.rules.length };
      if (p.invalid) result.warnings.push(issue("rules_invalid", `${p.invalid} Linkregel(n) sind ungültig und würden nicht übernommen.`));
      break;
  }

  // 2. The dry run.
  if (options.dryRun === false) result.dryRun.reason = "off";
  else if (!wid) {
    result.dryRun.reason = "no_workspace";
    result.warnings.push(issue("dry_run_no_workspace", "Probelauf übersprungen: kein Arbeitsbereich, in dem du Vorlagen anlegen darfst."));
  } else if (!result.errors.length) {
    const t = Date.now();
    result.dryRun.workspace = true;
    try {
      // As the token's account: a read token's scope would refuse the writes
      // that are rolled back anyway; the account's permissions still apply.
      const { apiScope: _scope, apiAi: _ai, apiMarketplaceCheck: _check, ...account } = user;
      void [_scope, _ai, _check];
      result.dryRun.ran = await dryRun(account, pkg, wid, result);
      result.dryRun.rolledBack = result.dryRun.ran && p.kind !== "workflow";
    } catch (error) {
      result.dryRun.ran = true;
      result.dryRun.rolledBack = true;
      if (error instanceof HttpError) result.errors.push(issue("import_failed", error.message));
      else if (error instanceof z.ZodError) result.errors.push(issue("import_invalid", "Der Inhalt der Vorlage ist ungültig."));
      else {
        console.error("Marketplace check: dry run failed", error);
        result.errors.push(issue("import_error", "Der Import würde mit einem Fehler abbrechen."));
      }
    }
    result.dryRun.ms = Date.now() - t;
  } else result.dryRun.reason = "errors";
  result.ok = !result.errors.length;
  return result;
}
