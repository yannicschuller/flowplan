// "Drucken / PDF" options (#215): what a print of a page, a record or the
// combined print view (lib/export-pdf.ts) contains and how it looks, and the
// named sets of them, the print presets ("Druckvorlagen"): a person's own
// (users.print_settings) and the workspace's (workspaces.print_presets, set
// by its owners, lib/print-settings.ts). The last choice is remembered per
// person.
// Pure: no React, no DOM types beyond what happy-dom and the browser share,
// no database – the dialog (components/print-dialog.tsx), the print copy
// (components/print-page.ts), the server's print view and the tests use it.
import { z } from "zod";

export const PAPER_SIZES = ["auto", "a4", "letter"] as const;
export const TITLE_SIZES = ["small", "normal", "large"] as const;
// "default": the look of the print as before (the app's typefaces for a
// page, Georgia and Helvetica for the combined view); "workspace": the
// workspace's typefaces (Settings → Workspace → Appearance).
export const PRINT_FONTS = ["default", "serif", "sans", "workspace"] as const;
// "auto": as before – links as in the app for a page, the address in
// brackets after web links in the combined view.
export const LINK_STYLES = ["auto", "plain", "underline", "dashed", "address"] as const;
export type PaperSize = (typeof PAPER_SIZES)[number];
export type TitleSize = (typeof TITLE_SIZES)[number];
export type PrintFont = (typeof PRINT_FONTS)[number];
export type LinkStyle = (typeof LINK_STYLES)[number];

export const printOptionsSchema = z.object({
  // Content
  cover: z.boolean(),
  icon: z.boolean(),
  tags: z.boolean(),
  properties: z.boolean(),
  pageNumbers: z.boolean(),
  // Only the combined print view: its title page and table of contents.
  titlePage: z.boolean(),
  toc: z.boolean(),
  // Look
  paper: z.enum(PAPER_SIZES),
  titleSize: z.enum(TITLE_SIZES),
  bodyFont: z.enum(PRINT_FONTS),
  headingFont: z.enum(PRINT_FONTS),
  links: z.enum(LINK_STYLES),
});
export type PrintOptions = z.infer<typeof printOptionsSchema>;

// Everything as it printed before #215 – plus page numbers, which the
// combined view always had and a page now gets too.
export const DEFAULT_PRINT_OPTIONS: PrintOptions = {
  cover: true,
  icon: true,
  tags: true,
  properties: true,
  pageNumbers: true,
  titlePage: true,
  toc: true,
  paper: "auto",
  titleSize: "normal",
  bodyFont: "default",
  headingFont: "default",
  links: "auto",
};

// Whatever was stored or sent: each known key that is valid, the default
// for the rest (an older or newer set of options still reads).
export function printOptionsOf(value: unknown): PrintOptions {
  const out: PrintOptions = { ...DEFAULT_PRINT_OPTIONS };
  if (!value || typeof value !== "object") return out;
  const shape = printOptionsSchema.shape;
  for (const key of Object.keys(shape) as (keyof PrintOptions)[]) {
    const parsed = shape[key].safeParse((value as Record<string, unknown>)[key]);
    if (parsed.success) (out as Record<string, unknown>)[key] = parsed.data;
  }
  return out;
}

// ---- Presets ----

export const PRINT_PRESET_LIMITS = { presets: 30, name: 60 };
export const printPresetSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(PRINT_PRESET_LIMITS.name),
  options: z.unknown(),
});
export type PrintPreset = { id: string; name: string; options: PrintOptions };
export const printPresetsSchema = z.array(printPresetSchema).max(PRINT_PRESET_LIMITS.presets);
// A person's: the last choice and their own presets.
export type UserPrintSettings = { last: PrintOptions | null; presets: PrintPreset[] };
// A workspace's: its presets and the one the dialog starts with.
export type WorkspacePrintPresets = { presets: PrintPreset[]; defaultId: string | null };

export const normalizePreset = (preset: z.infer<typeof printPresetSchema>): PrintPreset => ({
  id: preset.id,
  name: preset.name.trim(),
  options: printOptionsOf(preset.options),
});
// A stored list: unreadable entries are left out.
export function presetsOf(value: unknown): PrintPreset[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: PrintPreset[] = [];
  for (const entry of value.slice(0, PRINT_PRESET_LIMITS.presets)) {
    const parsed = printPresetSchema.safeParse(entry);
    if (!parsed.success || seen.has(parsed.data.id)) continue;
    seen.add(parsed.data.id);
    out.push(normalizePreset(parsed.data));
  }
  return out;
}

// What the dialog starts with: the last choice, else the workspace's
// default preset, else the defaults.
export function initialPrintOptions(user: UserPrintSettings | null | undefined, workspace: WorkspacePrintPresets | null | undefined): PrintOptions {
  if (user?.last) return printOptionsOf(user.last);
  const preset = workspace?.defaultId ? workspace.presets.find((p) => p.id === workspace.defaultId) : undefined;
  return preset ? printOptionsOf(preset.options) : { ...DEFAULT_PRINT_OPTIONS };
}
export const sameOptions = (a: PrintOptions, b: PrintOptions) =>
  (Object.keys(DEFAULT_PRINT_OPTIONS) as (keyof PrintOptions)[]).every((key) => a[key] === b[key]);

// ---- The print view ----

export type PrintContext = "page" | "book";

// What leaves the copy of a page or a record (components/print-page.ts):
// the elements of components/workspace-app.tsx, page-properties.tsx and
// database-view.tsx. A record's tag fields are among its properties.
export function hiddenSelectors(options: PrintOptions): string[] {
  const out: string[] = [];
  if (!options.cover) out.push(".page-cover", ".row-cover");
  if (!options.icon) out.push(".large-page-icon", ".row-title-icon");
  if (!options.tags && !options.properties) out.push(".page-properties", ".row-properties");
  else if (!options.tags) out.push(".page-properties-tags", ".page-properties-summary");
  else if (!options.properties) out.push(".page-properties-list", ".row-properties");
  return out;
}
// Buttons for editing that are no use on paper ("Cover ändern", "+ Tag",
// "+ Eigenschaft", a tag's ×).
export const EDIT_CONTROLS = [".cover-change", ".add-cover", ".page-properties-add", ".page-tag-remove"];
// Removes them from the copy (never from the page itself).
export function applyPrintOptions(copy: Element, options: PrintOptions) {
  const selectors = [...hiddenSelectors(options), ...EDIT_CONTROLS];
  if (selectors.length) copy.querySelectorAll(selectors.join(",")).forEach((el) => el.remove());
  copy.classList.add("print-options");
}

const SERIF = `Georgia, "Iowan Old Style", "Times New Roman", "Songti SC", "Noto Serif SC", serif`;
const SANS = `Helvetica, Arial, system-ui, "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif`;
const PAGE_SIZE: Record<Exclude<PaperSize, "auto">, string> = { a4: "A4", letter: "letter" };
const TITLE_SCALE: Record<TitleSize, number> = { small: 0.8, normal: 1, large: 1.25 };
// The stacks of the workspace's typefaces, for "workspace" (the server's
// print view resolves them from the look; the copy of a page uses the
// app's variables, which the look sets).
export type PrintFontStacks = { body?: string | null; heading?: string | null };
// Only characters that are safe in a declaration (the stacks come from the
// look, validated already).
const cssSafe = (value: string) => value.replace(/[^\w\s"',.-]/g, "");

function fontStack(font: PrintFont, slot: "body" | "heading", context: PrintContext, stacks?: PrintFontStacks) {
  if (font === "serif") return SERIF;
  if (font === "sans") return SANS;
  if (font === "workspace") {
    if (context === "page") return slot === "body" ? "var(--font-ui)" : "var(--font-display)";
    const stack = slot === "body" ? stacks?.body : stacks?.heading;
    return stack ? cssSafe(stack) : null;
  }
  return null;
}

// The style sheet that applies the options: @page (paper, page numbers),
// title size, typefaces and links. For a page it is scoped to the copy
// (.print-options); for the combined view to .print-book. The default
// options give what printed before (empty for a page, besides the page
// numbers).
export function printOptionsCss(options: PrintOptions, context: PrintContext, stacks?: PrintFontStacks) {
  const root = context === "page" ? ".print-options" : ".print-book";
  const rules: string[] = [];
  const page: string[] = [];
  const size = options.paper === "auto" ? (context === "book" ? "A4" : null) : PAGE_SIZE[options.paper];
  if (size) page.push(`size: ${size};`);
  if (context === "book") page.push("margin: 18mm 16mm 20mm;");
  if (options.pageNumbers) page.push("@bottom-center { content: counter(page); font: 10pt Helvetica, Arial, sans-serif; color: #666; }");
  if (page.length) rules.push(`@page { ${page.join(" ")} }`);
  const scale = TITLE_SCALE[options.titleSize];
  if (scale !== 1) {
    const sizes =
      context === "page"
        ? ([
            [".page-title, .row-detail h2", 38],
            ["h1:not(.page-title)", 30],
            ["h2", 24],
            ["h3", 20],
          ] as const)
        : ([
            [".cover h1", 30],
            [".chapter-title", 24],
            ["h1:not(.chapter-title)", 20],
            ["h2", 15],
            ["h3", 13],
          ] as const);
    const unit = context === "page" ? "px" : "pt";
    for (const [selector, base] of sizes)
      rules.push(`${selector.split(", ").map((s) => `${root} ${s}`).join(", ")} { font-size: ${Math.round(base * scale * 10) / 10}${unit}; }`);
  }
  const body = fontStack(options.bodyFont, "body", context, stacks);
  if (body)
    rules.push(
      context === "page"
        ? `${root}, ${root} .document-editor, ${root} .ProseMirror { font-family: ${body}; }`
        : `${root} { font-family: ${body}; }`,
    );
  const heading = fontStack(options.headingFont, "heading", context, stacks);
  if (heading)
    rules.push(
      `${["h1", "h2", "h3", "h4", "h5", "h6", ...(context === "page" ? [".page-title", ".row-detail h2"] : [".chapter-title"])].map((h) => `${root} ${h}`).join(", ")} { font-family: ${heading}; }`,
    );
  const links = options.links === "auto" ? (context === "book" ? "address" : null) : options.links;
  if (links === "plain") rules.push(`${root} a { color: inherit; text-decoration: none; }`);
  if (links === "underline") rules.push(`${root} a { color: inherit; text-decoration: underline; text-underline-offset: 2px; }`);
  if (links === "dashed") rules.push(`${root} a { color: inherit; text-decoration: underline dashed; text-underline-offset: 2px; }`);
  if (links === "address")
    rules.push(`${root} a[href^="http"]::after { content: " (" attr(href) ")"; font-size: 0.8em; color: #666; word-break: break-all; }`);
  return rules.join("\n");
}

// The options in the query of the combined print view
// (app/api/export/pdf?print=…): only what differs from the defaults.
export function printOptionsQuery(options: PrintOptions) {
  const changed = Object.fromEntries(
    (Object.keys(DEFAULT_PRINT_OPTIONS) as (keyof PrintOptions)[]).filter((key) => options[key] !== DEFAULT_PRINT_OPTIONS[key]).map((key) => [key, options[key]]),
  );
  return Object.keys(changed).length ? JSON.stringify(changed) : "";
}
export function printOptionsFromQuery(value: string | null | undefined): PrintOptions {
  if (!value || value.length > 2000) return { ...DEFAULT_PRINT_OPTIONS };
  try {
    return printOptionsOf(JSON.parse(value));
  } catch {
    return { ...DEFAULT_PRINT_OPTIONS };
  }
}
