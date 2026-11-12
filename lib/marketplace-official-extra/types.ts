// The official templates that exist only in the Flowplan Marketplace
// (lib/marketplace-official.ts, scripts/marketplace-official.mjs): plain
// data, one file per kind. Never imported by client code – the built-in
// catalog (lib/template-catalog*.ts) is what the app ships; these would
// only make its bundle bigger (tests/marketplace-official-extra.test.ts).
//
// Texts: German content, title and summary in German and English, a short
// Markdown description in both. `id` is the slug after the kind
// (`<kind>-<id>.flowplan-template`): kebab case, stable – the marketplace
// knows a template by its file name, renaming it makes a new one.
import type { CatalogRow } from "../template-catalog";
import type { Field, View } from "../types";
import type { TemplateCategory } from "../template-categories";
import type { Draft } from "../whiteboard-template-gallery";
import type { WorkflowEdge, WorkflowNode } from "../workflows/graph";
import type { GapKind } from "../workflows/templates";
import type { WorkspaceTheme } from "../workspace-theme";

export type Text = { de: string; en: string };
export type ExtraBase = {
  id: string;
  title: Text;
  category: Exclude<TemplateCategory, "">;
  tags: string[];
  summary: Text;
  // Markdown: what is inside and how to use it.
  description: Text;
  // "multi": mostly structure (a look, link rules).
  language?: "de" | "multi";
};
export type ExtraDocument = ExtraBase & { kind: "document"; icon: string; html: string };
// Example dates as "@+3" (resolved against OFFICIAL_REFERENCE_DAY), or none.
export type ExtraDatabase = ExtraBase & { kind: "database"; icon: string; fields: Field[]; views: View[]; rows: CatalogRow[] };
export type ExtraWhiteboard = ExtraBase & { kind: "whiteboard"; items: Draft[] };
// A graph with "$ask:<gap>" tokens where the importing person picks a
// database, a property, a page or a person (lib/workflows/templates.ts).
export type ExtraGap = { id: string; kind: Exclude<GapKind, "toggle">; label: Text; optional?: boolean };
export type ExtraWorkflow = ExtraBase & { kind: "workflow"; nodes: WorkflowNode[]; edges: WorkflowEdge[]; gaps: ExtraGap[] };
// Bundled typefaces only (lib/theme-fonts.ts), no uploaded fonts.
export type ExtraAppearance = ExtraBase & { kind: "appearance"; theme: WorkspaceTheme };
export type ExtraLinkRule = { name: string; pattern: string; template: string };
export type ExtraLinkRules = ExtraBase & { kind: "link-rules"; rules: ExtraLinkRule[] };
export type ExtraItem = ExtraDocument | ExtraDatabase | ExtraWhiteboard | ExtraWorkflow | ExtraAppearance | ExtraLinkRules;
