// The OpenAPI 3.1 description of Flowplan's public HTTP API: what scripts,
// n8n, Home Assistant and the generated SDKs (sdk/) call with a personal API
// token. Built from the code where it exists as zod schemas (database
// properties and views, command actions, export options); the rest is
// described by hand from the route handlers in app/api. Served at
// /api/openapi.json, readable at /api/docs; tests/openapi.test.ts keeps the
// routes, the command actions and the SDKs in step with it.
import { workspaceThemeSchema } from "./workspace-theme";
import { autoLinkRulesSchema } from "./auto-link";
import { textMenuPrefSchema } from "./text-menu-pref";
import { printOptionsSchema, printPresetSchema, printPresetsSchema } from "./print-options";
import { pageIconPrefSchema } from "./page-icon-pref";
import { externalLinkIconSchema } from "./external-link-icon-pref";
import { quoteShortcutSchema } from "./quote-shortcut-pref";
import { updateNotesLevelSchema } from "./update-notes-pref";
import { releaseNoteItemSchema } from "./release-notes";
import { MAX_HOME_WIDGETS, MAX_LAYOUT_BYTES, saveSchema } from "./home-layout-schema";
import { MAX_TILES, tileSizes, tileTypes } from "./dashboard-schema";
import { PAPER_COLORS, PAPER_ORIENTATIONS, PAPER_SIZES, PAPER_TEMPLATES } from "./notebook-paper";
import { z } from "zod";
import { field, view } from "./database-schema";
import { optionRenamesSchema } from "./option-renames";
import { coverSchema, iconSizeSchema, pageIconSchema } from "./page-appearance";
import { buildInfo } from "./build-info";
import { disclosedVersion } from "./instance-disclosure";
import { repeatSchema } from "./recurrence";
import { settingsSchema } from "./database-settings-schema";
import { chatFormats, hookConfigSchema, noticeEvents, templatesSchema } from "./notification-templates";
import { MAX_COMBOS, SHORTCUT_ACTIONS } from "./keymap";
import { toRecordsInput } from "./whiteboard-ai";
import { workflowEdgeSchema, workflowNodeSchema, workflowSettingsSchema } from "./workflows/graph";
import { actionSchemas, dataRequestSchema, MAX_ITEMS, MAX_WIDGET_BYTES, MAX_WIDGETS, widgetActions, widgetConfigs, widgetKinds } from "./mobile-widget-schema";

type Json = Record<string, unknown>;
const uuid = z.uuid();
const str = z.string().min(1).max(500);

// ---- Zod → JSON Schema ----

// Zod's own converter; the schema URL and the long UUID pattern (the format
// says enough) are dropped so the document stays readable.
export function jsonSchema(schema: z.ZodType): Json {
  const out = z.toJSONSchema(schema, { unrepresentable: "any", io: "input" }) as Json;
  delete out.$schema;
  const tidy = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(tidy);
    if (!node || typeof node !== "object") return;
    const o = node as Json;
    if (o.format === "uuid") delete o.pattern;
    for (const value of Object.values(o)) tidy(value);
  };
  tidy(out);
  return out;
}
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

// ---- Command actions (POST /api/command) ----

// Actions a write token may send. The names come from lib/api.ts command();
// tests/openapi.test.ts fails when the switch there and this list differ.
// Administration (admin.*), tokens (token.*) and AI (ai.*) are refused for
// API tokens and therefore not listed.
export const commandActionNames = [
  "workspace.create", "workspace.update", "workspace.delete", "workspace.leave", "workspace.import",
  "workspace.look", "workspace.theme", "workspace.linkRules", "workspace.printPresets", "workspace.font.rename", "workspace.font.delete",
  "profile.onboarded", "profile.language", "profile.plainLook", "profile.textMenu", "profile.print", "profile.pageIcon", "profile.externalLinkIcon", "profile.quoteShortcut", "profile.updateNotes", "releaseNotes.list", "notification.reset", "notification.email", "notification.weekly", "shortcuts.save",
  "home.save", "home.reset", "home.note", "home.config", "home.default",
  "account.deletePlan", "account.delete",
  "space.create", "space.update", "space.delete", "space.restore", "space.purge", "space.duplicate", "space.gitExport", "space.reorder",
  "page.create", "page.update", "page.delete", "page.restore", "page.purge", "trash.empty", "file.delete", "files.deleteUnused", "file.restore", "file.purge", "page.duplicate", "page.move", "page.moveCheck", "page.import",
  "pages.bulk", "page.follow", "page.collapseProperties", "database.collapseRecordProperties", "sidebar.state", "page.snapshot", "page.publish", "page.share", "page.shareUpdate", "page.fromShare",
  "page.toRecord", "record.toPage", "page.owner", "page.review", "page.aliases",
  "page.properties", "pages.tag", "tag.save", "tag.delete", "tag.merge", "tag.reorder", "tag.scope", "property.save", "property.delete", "property.reorder", "property.scope", "meta.usage", "favorite", "favorite.row", "task.update", "task.add", "tasks.seen", "synced.create", "table.toDatabase", "mention.link",
  "journal.settings", "journal.lock", "journal.unlock", "journal.relock", "journal.entry", "journal.roll", "journal.link", "journal.removeEmpty", "journal.summary", "journal.aiSummary", "journal.completedMine", "block.ids",
  "linked.command", "document.sync", "document.markdown", "document.markdown.apply",
  "snapshot.restoreBlock", "snapshot.restore",
  "database.update", "database.settings", "database.recordLayout",
  "row.create", "row.update", "row.delete", "row.move", "row.schedule", "row.access", "row.appearance",
  "row.recurrence", "row.repeat", "row.detachOccurrence", "row.document.sync", "row.snapshot", "row.snapshot.restore",
  "row.template.save", "row.template.default", "row.template.delete", "row.template.apply", "row.trash.restore", "row.trash.purge",
  "rows.import", "rows.bulk", "rows.transfer", "timeline.cascade", "timeline.link",
  "citation.import", "citation.remove", "whiteboard.sync", "whiteboard.toRecords", "dashboard.save",
  "notebook.paper", "notebook.sheet.add", "notebook.sheet.duplicate", "notebook.sheet.delete", "notebook.sheet.move", "notebook.sheet.paper", "notebook.import",
  "notebook.pictures", "notebook.stickers", "notebook.sticker.save", "notebook.sticker.rename", "notebook.sticker.delete", "notebook.sticker.insert", "notebook.templates", "notebook.template.update", "notebook.template.delete",
  "notebook.sheet.meta", "notebook.sheet.links", "notebook.outline", "notebook.outline.add", "notebook.sheets.duplicate", "notebook.sheets.delete",
  "notebook.trash.restore", "notebook.sheets.transfer", "search.save", "search.delete",
  "collection.create", "collection.update", "collection.delete", "collection.restore", "collection.duplicate", "collection.reorder",
  "thread.create", "thread.reply", "thread.resolve", "thread.edit", "thread.deleteMessage", "thread.react",
  "comment.create", "comment.resolve", "comment.react", "reminder.set",
  "notification.prefs", "notification.read", "notification.mark", "notification.delete",
  "share.create", "share.revoke", "share.protect", "publication.protect", "publication.copy", "publication.theme",
  "record.shares", "record.share.create", "record.share.revoke", "record.share.protect", "record.share.fields", "record.publish", "record.publication.protect",
  "domain.add", "domain.remove", "plugin.update", "plugin.delete",
  "form.update", "form.submit", "survey.save",
  "sprint.setup", "sprint.create", "sprint.update", "sprint.start", "sprint.complete", "sprint.delete", "sprint.points",
  "recordView.save", "recordView.delete", "git.setup", "git.disable", "git.token",
  "time.start", "time.stop", "time.add", "time.delete", "ticket.reply",
  "member.invite", "invite.cancel", "invite.resend", "member.role", "member.guest",
  "sso.mapping.add", "sso.mapping.delete", "grant.set", "group.create", "group.member",
  "template.save", "template.update", "template.delete", "template.restore", "template.purge", "template.apply", "template.copy", "template.dependencies",
  "capture.record", "capture.target", "bookmarks.import",
  "calendar.feed", "calendar.feed.revoke", "calendar.caldav", "calendar.caldav.revoke",
  "webhook.delete", "inbound.save", "inbound.rotate", "inbound.delete",
  "issueSync.connect", "issueSync.disconnect", "issueSync.map", "issueSync.unmap",
  "calendarSync.map", "calendarSync.unmap", "calendarSync.disconnect", "meeting.note",
  "e2ee.identity.setup", "e2ee.identity.update", "e2ee.identity.reset", "e2ee.member.add", "e2ee.member.remove", "e2ee.rotate",
  "e2ee.append", "e2ee.compact", "e2ee.title",
  // Workflows (#168, lib/workflows/commands.ts).
  "workflow.sync", "workflow.draft", "workflow.validate", "workflow.activate", "workflow.pause", "workflow.test", "workflow.run", "workflow.run.cancel", "workflow.restore", "workflow.fromRule",
  "workflow.run.retry", "workflow.approve", "workflow.hook", "workflow.credential.set", "workflow.credential.remove", "workflow.import",
] as const;
// Prefixes command() refuses for every API token.
export const tokenRefusedActionPrefixes = ["admin.", "token.", "ai."] as const;

// A choice per tag or property (by id, or `tag:<name>` for templates), or
// one word for all: auto (the same-named one there, else a copy), copy, remove.
const metaChoiceInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("map"), to: z.string() }),
  z.object({ action: z.literal("copy") }),
  z.object({ action: z.literal("remove") }),
]);
const metaPlanInput = z.union([
  z.enum(["auto", "copy", "remove"]),
  z.object({
    tags: z.record(z.string(), metaChoiceInput).optional(),
    properties: z.record(z.string(), metaChoiceInput).optional(),
    default: z.enum(["auto", "copy", "remove"]).optional(),
  }),
]);
type ActionDoc = { action: string; summary: string; description?: string; input: z.ZodObject; result?: z.ZodType };
const okResult = z.object({ ok: z.literal(true) });
const idResult = z.object({ id: uuid });
const cells = z
  .record(z.string(), z.unknown())
  .describe(
    "Property values by property ID (the first property is the title). Text properties other than the title hold inline Markdown (#126): **bold**, _italic_ (or *italic*), ~~strike~~, `code`, [label](https://…) links (http, https and mailto only) and \\n for a line break – no headings, lists or other blocks. A backslash keeps * _ ~ ` [ ] \\ literal, so plain text is sent escaped. Records are read the same way; the title is plain text.",
  );
// Actions with their own schema: the ones integrations use. Everything else
// is accepted as `{ action, ... }` (CommandOther) and checked by the server.
export const commandActions: ActionDoc[] = [
  {
    action: "workspace.create",
    summary: "Create a workspace",
    input: z.object({ action: z.literal("workspace.create"), name: str }),
    result: idResult,
  },
  {
    action: "workspace.theme",
    summary: "Set the workspace's appearance",
    description:
      "Needs the owner role. The look every member, guest, publication and form of the workspace shows: `accent` (#rrggbb; its light and dark palette is derived, its lightness adjusted for WCAG AA contrast), `background` (a preset) and `fonts` per slot (`ui`, `display`, `mono`): a bundled face id or `custom:<id>` of a face uploaded with POST /api/workspace-fonts. Values equal to the default are dropped; `theme: null` restores Flowplan's own look. No custom CSS. Answers the look with every uploaded face.",
    input: z.object({
      action: z.literal("workspace.theme"),
      workspaceId: uuid,
      theme: workspaceThemeSchema.nullable(),
    }),
    result: z.object({ theme: workspaceThemeSchema.nullable(), fonts: z.array(z.object({ id: uuid, name: str, format: z.enum(["woff2", "woff", "truetype", "opentype"]), variable: z.boolean() })) }),
  },
  {
    action: "workspace.linkRules",
    summary: "Set the workspace's automatic link rules",
    description:
      "Needs the owner role. Replaces the whole list (at most 50 rules). Text that matches a rule's `pattern` (a JavaScript regular expression, at most 200 characters, run with the `g` and `u` flags; it may not match empty text or repeat a group that repeats itself) becomes a link while someone types or pastes it in a page, a record's document or a comment. `template` is an http(s) or mailto address with `{match}` (the whole match) and `$1`…`$9` or `{1}`…`{9}` (capture groups), each URL-encoded. Existing text is not changed. Every member and guest gets the rules in the bootstrap (`linkRules`).",
    input: z.object({
      action: z.literal("workspace.linkRules"),
      workspaceId: uuid,
      rules: autoLinkRulesSchema,
    }),
    result: z.object({ rules: z.array(z.object({ id: str, name: str, pattern: str, template: str, enabled: z.boolean() })) }),
  },
  {
    action: "workspace.printPresets",
    summary: "Set the workspace's print presets",
    description:
      "Needs the owner role (guests never). Replaces the whole list (at most 30 presets): named sets of print options (cover, icon, tags, properties, page numbers, title page, table of contents, paper, title size, typefaces, links) that every member and guest can pick in the print dialog but not change. `defaultId` names the preset the dialog starts with for people who have not printed yet (null: none). Every member and guest gets them in the bootstrap (`printPresets`).",
    input: z.object({
      action: z.literal("workspace.printPresets"),
      workspaceId: uuid,
      presets: printPresetsSchema,
      defaultId: z.string().max(64).nullable().optional(),
    }),
    result: z.object({ presets: z.array(printPresetSchema.extend({ options: printOptionsSchema })), defaultId: z.string().nullable() }),
  },
  {
    action: "profile.print",
    summary: "Remember the caller's print options and own print presets",
    description:
      "For the caller, on all devices. `options` is the last choice in the print dialog (null forgets it); `presets` replaces the caller's own list of presets (at most 30). Either may be left out. Unknown or invalid option values in a preset are replaced by the defaults.",
    input: z.object({
      action: z.literal("profile.print"),
      options: printOptionsSchema.nullable().optional(),
      presets: printPresetsSchema.optional(),
    }),
    result: z.object({ last: printOptionsSchema.nullable(), presets: z.array(printPresetSchema.extend({ options: printOptionsSchema })) }),
  },
  {
    action: "profile.plainLook",
    summary: "Use Flowplan's own look instead of the workspaces' appearance",
    description: "For the caller, in every workspace and on all devices; light or dark stays a choice per device.",
    input: z.object({ action: z.literal("profile.plainLook"), plain: z.boolean() }),
    result: z.object({ plainLook: z.boolean() }),
  },
  {
    action: "profile.textMenu",
    summary: "When selecting text shows the text menu",
    description: "For the caller, on all devices: always, only for a selection made with a mouse, trackpad or keyboard (computer, the default), or never. A right click opens the menu in every case.",
    input: z.object({ action: z.literal("profile.textMenu"), textMenu: textMenuPrefSchema }),
    result: z.object({ textMenu: textMenuPrefSchema }),
  },
  {
    action: "profile.pageIcon",
    summary: "Where the page icon sits in the page header",
    description: "For the caller, on all devices: the large icon above the title (above, the default) or a small icon next to the title on its first line (inline). Only how the caller sees pages; published pages keep the default.",
    input: z.object({ action: z.literal("profile.pageIcon"), pageIcon: pageIconPrefSchema }),
    result: z.object({ pageIcon: pageIconPrefSchema }),
  },
  {
    action: "profile.externalLinkIcon",
    summary: "Show the arrow after links to the web",
    description: "For the caller, on all devices: whether links to the web show a small outward arrow after them (true, the default) or only their colour and underline (false). Only how the caller sees pages, comments and records; published pages keep the default, and the arrow is never printed.",
    input: z.object({ action: z.literal("profile.externalLinkIcon"), externalLinkIcon: externalLinkIconSchema }),
    result: z.object({ externalLinkIcon: externalLinkIconSchema }),
  },
  {
    action: "profile.quoteShortcut",
    summary: "Choose what typing \"> \" creates",
    description: "For the caller, on all devices: what typing \"> \" at the start of an empty line in the editor creates – a toggle (\"toggle\", the default) or a quote as in Markdown (\"quote\"). Only that typing shortcut: pasted and imported Markdown \"> text\" stays a quote, and documents and exports do not change.",
    input: z.object({ action: z.literal("profile.quoteShortcut"), quoteShortcut: quoteShortcutSchema }),
    result: z.object({ quoteShortcut: quoteShortcutSchema }),
  },
  {
    action: "profile.updateNotes",
    summary: "What's new after updates: the level, or mark the running version as seen",
    description:
      "For the caller, on all devices. level: show the release notes of every version since the last one seen (all, the default), only when one of them has breaking changes and then only those (breaking), or never. seen: true marks the running version as seen (the dialog was closed); it only ever moves forward. The bootstrap's updateNotes carries the level and, once after an update, the versions to show.",
    input: z.object({
      action: z.literal("profile.updateNotes"),
      level: updateNotesLevelSchema.optional(),
      seen: z.literal(true).optional(),
    }),
    result: z.object({ level: updateNotesLevelSchema, seenVersion: z.string().nullable() }),
  },
  {
    action: "releaseNotes.list",
    summary: "The latest release notes up to the running version",
    description: "Curated notes bundled with the server (no request to the internet), newest first, whatever the caller's level. Release builds leave out pre-release notes.",
    input: z.object({ action: z.literal("releaseNotes.list"), limit: z.number().int().min(1).max(20).optional().describe("Default 5") }),
    result: z.object({
      current: z.string().nullable(),
      changelog: z.string(),
      versions: z.array(
        z.object({
          version: str,
          date: z.string().optional(),
          breaking: z.array(releaseNoteItemSchema).optional(),
          security: z.array(releaseNoteItemSchema).optional(),
          features: z.array(releaseNoteItemSchema).optional(),
          improvements: z.array(releaseNoteItemSchema).optional(),
          fixes: z.array(releaseNoteItemSchema).optional(),
        }),
      ),
    }),
  },
  {
    action: "space.create",
    summary: "Create a space in a workspace",
    input: z.object({
      action: z.literal("space.create"),
      workspaceId: uuid,
      name: str,
      private: z.boolean().optional().describe("Only visible to its owner"),
      icon: z.string().max(100).optional(),
      iconColor: z.string().max(40).optional(),
    }),
    result: idResult,
  },
  {
    action: "space.reorder",
    summary: "Change the order of the spaces in a workspace",
    description:
      "Needs the owner role in the workspace. `order` lists the spaces the caller sees in the sidebar in their new order; only those move, between their new neighbours, so spaces the caller cannot see keep their place. Visible spaces left out keep theirs too; an unknown or hidden space answers 404. Sending the same order again changes nothing. The answer lists the visible spaces in their new order.",
    input: z.object({
      action: z.literal("space.reorder"),
      workspaceId: uuid,
      order: z.array(uuid).min(1).max(1000).describe("Space IDs in the new order"),
    }),
    result: z.object({ ok: z.literal(true), order: z.array(uuid) }),
  },
  {
    action: "page.create",
    summary: "Create a page",
    description: "Needs editor rights on the space. Databases start with the `tasks` setup unless `databaseKind` says otherwise.",
    input: z.object({
      action: z.literal("page.create"),
      workspaceId: uuid,
      spaceId: uuid,
      title: str.optional().describe("Required unless `templateId` or `starterTemplate` is given: from a template the given title wins, without one the page takes the template's name"),
      kind: z.enum(["document", "database", "whiteboard", "journal", "dashboard", "notebook", "workflow"]).optional().describe("Default: document"),
      parentId: uuid.optional().describe("Parent page in the same space"),
      parentRowId: uuid.optional().describe("A record of the parent database (`parentId`): the page goes below that record and inherits its access. Needs edit rights on the record"),
      databaseKind: z.enum(["tasks", "documents", "contacts", "empty"]).optional(),
      templateId: z.string().max(100).optional().describe("A saved page template of the workspace"),
      meta: metaPlanInput.optional().describe("With a template of another space: what to do with its space's tags and properties (see template.dependencies); default `auto`"),
      starterTemplate: z.string().max(100).optional().describe("A built-in starter template key"),
    }),
    result: idResult,
  },
  {
    action: "block.ids",
    summary: "Give the blocks of a document their ids",
    description:
      "For a link to a block (#88) of an older document whose block has no id yet: every linkable block of the page (or with `rowId` the record) gets one; the answer names the id of the `index`-th block (from GET /api/blocks), or of the block with that `text`. Needs read access only and does not count as an edit. Refused for end-to-end encrypted pages.",
    input: z.object({
      action: z.literal("block.ids"),
      pageId: uuid,
      rowId: uuid.optional(),
      index: z.number().int().min(0).max(100000),
      text: z.string().max(500).optional().describe("The start of the block's text, to find it when the document changed"),
    }),
    result: z.object({ blockId: z.string() }),
  },
  {
    action: "page.update",
    summary: "Change title, icon, cover or settings of a page",
    input: z.object({
      action: z.literal("page.update"),
      pageId: uuid,
      patch: z.object({
        title: str.optional(),
        icon: pageIconSchema.optional().describe("Emoji, `icon:<name>` or `/api/files/<id>`"),
        cover: coverSchema.optional().describe("`#rrggbb` or `/api/files/<id>`"),
        cover_position: z.number().min(0).max(100).optional(),
        locked: z.boolean().optional(),
        full_width: z.boolean().optional(),
        caption_numbers: z.boolean().optional().describe("Number the captions of images, tables and code blocks (Figure 1, Table 1, Listing 1)"),
        font: z.enum(["sans", "serif", "mono"]).optional(),
        icon_size: iconSizeSchema.optional(),
      }),
    }),
    result: okResult,
  },
  {
    action: "e2ee.append",
    summary: "Append an encrypted update to a document of an encrypted space",
    description:
      "End-to-end encrypted spaces (docs/e2ee-design.md): the client encrypts a Yjs update with the space key (AES-256-GCM, lib/e2ee.ts) and sends the ciphertext. Needs editor rights and the space's current key; `version` is the space key version used. Plaintext commands (`document.sync`, exports, comments, share links …) are refused for these pages.",
    input: z.object({
      action: z.literal("e2ee.append"),
      pageId: uuid,
      version: z.number().int().positive(),
      data: z.string().describe("Base64 ciphertext: format byte, 12-byte IV, AES-GCM ciphertext and tag"),
      client: z.string().max(100).optional().describe("Editor instance ID; the live channel does not echo the update to it"),
    }),
    result: z.object({ seq: z.number().int() }),
  },
  {
    action: "page.owner",
    summary: "Set or remove the owner of a page",
    description: "Needs editor rights. The owner must be a member (not a guest) of the workspace who can read the page; they get the review reminders.",
    input: z.object({ action: z.literal("page.owner"), pageId: uuid, ownerId: z.string().max(60).nullable() }),
    result: okResult,
  },
  {
    action: "page.review",
    summary: "Plan, change or complete the review of a page",
    description:
      "Needs editor rights. `reviewAt` is the next review date, `everyDays` repeats it; an interval without a date starts from today. `done: true` marks the page as reviewed: the date moves to today plus the interval, a one-off date is cleared. `null` removes a value.",
    input: z.object({
      action: z.literal("page.review"),
      pageId: uuid,
      reviewAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      everyDays: z.number().int().min(1).max(3650).nullable().optional(),
      done: z.literal(true).optional(),
    }),
    result: z.object({ ok: z.literal(true), reviewAt: z.string().nullable(), everyDays: z.number().nullable() }),
  },
  {
    action: "page.aliases",
    summary: "Set the aliases of a page",
    description:
      "Needs editor rights. Other names of the page (at most 10, each at most 100 characters; trimmed, duplicates ignoring case removed). @ mentions, the search and unlinked mentions find the page by them like by its title. An empty list removes them. Records keep their aliases in a property of type `aliases`.",
    input: z.object({
      action: z.literal("page.aliases"),
      pageId: uuid,
      aliases: z.array(z.string().max(100)).max(10),
    }),
    result: z.object({ ok: z.literal(true), aliases: z.array(z.string()) }),
  },
  {
    action: "page.properties",
    summary: "Set the tags and property values of a page",
    description:
      "Needs editor rights on the page. `tags` replaces the page's tags, `addTags` and `removeTags` change them; each entry is a tag ID or a name (a new name creates the tag – members with edit rights, not guests). `values` sets property values by property ID or name; `null` removes a value. Values follow the property type: text, url, email and phone as text (at most 2000 characters), number, date (YYYY-MM-DD or with time), select (one option), multiselect (options), checkbox (boolean), person (member ID). created_at/updated_at/created_by/updated_by are read-only. Not for pages of end-to-end encrypted spaces (409). The definitions and tags of a workspace: GET /api/tags.",
    input: z.object({
      action: z.literal("page.properties"),
      pageId: uuid,
      tags: z.array(z.string().max(200)).max(200).optional(),
      addTags: z.array(z.string().max(200)).max(200).optional(),
      removeTags: z.array(z.string().max(200)).max(200).optional(),
      values: z.record(z.string(), z.unknown()).optional(),
    }),
    result: z.object({ ok: z.literal(true), tags: z.array(uuid), values: z.record(z.string(), z.unknown()) }),
  },
  {
    action: "pages.tag",
    summary: "Add or remove tags on several pages",
    description: "Needs editor rights on every page. Tags by ID or name, as in page.properties.",
    input: z.object({
      action: z.literal("pages.tag"),
      workspaceId: uuid,
      pageIds: z.array(uuid).min(1).max(500),
      addTags: z.array(z.string().max(200)).max(200).optional(),
      removeTags: z.array(z.string().max(200)).max(200).optional(),
    }),
    result: z.object({ ok: z.literal(true), pages: z.number().int() }),
  },
  {
    action: "tag.save",
    summary: "Create or change a tag",
    description:
      "Without `tagId` a new tag: with `spaceId` one of that space (members who may write there), without it (or `spaceId: null`) one of the whole workspace (workspace owners). With `tagId` rename or recolour it (workspace owners; space owners for their space's tags). A space's tags are used only by pages of that space; names are unique within a space together with the workspace's tags, ignoring case (409) – two spaces may each have a tag of the same name. Colours: gray, blue, green, red, yellow, orange, purple, pink, teal. Also tag.delete {workspaceId, tagId}, tag.merge {workspaceId, tagId, into} (into a workspace tag or one of the same space) and tag.reorder {workspaceId, order}. Renaming, merging and deleting also change the values of database properties with the tags as options (`tagOptions`) where the tag is known. Tags in GET /api/tags carry `spaceId` (null: whole workspace).",
    input: z.object({
      action: z.literal("tag.save"),
      workspaceId: uuid,
      tagId: uuid.optional(),
      spaceId: uuid.nullable().optional().describe("New tags: the space it belongs to; null or missing: the whole workspace"),
      name: z.string().max(60),
      color: z.enum(["gray", "blue", "green", "red", "yellow", "orange", "purple", "pink", "teal"]).optional(),
    }),
    result: idResult,
  },
  {
    action: "collection.create",
    summary: "Create a collection",
    description:
      "A saved query in the search language (see GET /api/search): pages and database records that match it whenever it is run (GET /api/collections/{id}). Private unless `shared` – then every member of the workspace (not guests) sees it; guests cannot share. The query is stored in its canonical form (returned as `query`). At most 100 collections per person and workspace and 100 shared ones per workspace (409).",
    input: z.object({
      action: z.literal("collection.create"),
      workspaceId: uuid,
      name: z.string().min(1).max(120),
      query: z.string().min(1).max(1000),
      icon: z.string().max(16).optional().describe("An emoji"),
      shared: z.boolean().optional(),
    }),
    result: z.object({ id: uuid, query: z.string() }),
  },
  {
    action: "collection.update",
    summary: "Change a collection",
    description:
      "Its creator, and workspace owners for shared collections. Only the creator shares or unshares it. Also: collection.delete {collectionId} (into the trash for 30 days), collection.restore {collectionId}, collection.duplicate {collectionId, name?} (a private copy, for anyone who sees it) and collection.reorder {workspaceId, order} (the person's own order of the collections they see).",
    input: z.object({
      action: z.literal("collection.update"),
      collectionId: uuid,
      name: z.string().min(1).max(120).optional(),
      query: z.string().min(1).max(1000).optional(),
      icon: z.string().max(16).optional(),
      shared: z.boolean().optional(),
    }),
    result: z.object({ id: uuid, query: z.string() }),
  },
  {
    action: "property.save",
    summary: "Create or change a page property",
    description:
      "Workspace owners; for a space's own properties (`spaceId` on creation) also that space's owner. A property every page of the workspace – or of that space – can have a value for; names are unique within a space together with the workspace's properties. Types: text, number, date, select, multiselect, checkbox, person, url, email, phone, created_at, updated_at, created_by, updated_by (the last four are read from the page). `options` for select and multiselect. Changing the type or removing options converts the values where possible and removes the others. Also property.delete {workspaceId, propertyId} and property.reorder {workspaceId, order}.",
    input: z.object({
      action: z.literal("property.save"),
      workspaceId: uuid,
      propertyId: uuid.optional(),
      name: z.string().max(80),
      type: z.enum(["text", "number", "date", "select", "multiselect", "checkbox", "person", "url", "email", "phone", "created_at", "updated_at", "created_by", "updated_by"]).optional(),
      options: z.array(z.string().max(100)).max(100).optional(),
      spaceId: uuid.nullable().optional().describe("New properties: the space it belongs to; null or missing: the whole workspace"),
    }),
    result: idResult,
  },
  {
    action: "tag.scope",
    summary: "Change the scope of a tag (whole workspace or one space)",
    description:
      "Workspace owners. `spaceId: null` makes a space's tag one of the whole workspace (same-named tags of other spaces are refused with 409 unless `mergeSameName` folds them into it). A space's id limits it to that space: pages and database records outside it that carry the tag are refused with 409 (`resolve: \"block\"`, the default), get a tag of the same name in their own space (`resolve: \"copy\"`) or lose it (`resolve: \"remove\"`). See where it is used first with meta.usage. property.scope {workspaceId, propertyId, spaceId, resolve?, mergeSameName?} does the same for page properties (merging needs the same type).",
    input: z.object({
      action: z.literal("tag.scope"),
      workspaceId: uuid,
      tagId: uuid,
      spaceId: uuid.nullable(),
      resolve: z.enum(["block", "copy", "remove"]).optional(),
      mergeSameName: z.boolean().optional(),
    }),
    result: idResult.extend({ ok: z.literal(true) }),
  },
  {
    action: "property.scope",
    summary: "Change the scope of a page property (whole workspace or one space)",
    description: "As tag.scope, for page properties.",
    input: z.object({
      action: z.literal("property.scope"),
      workspaceId: uuid,
      propertyId: uuid,
      spaceId: uuid.nullable(),
      resolve: z.enum(["block", "copy", "remove"]).optional(),
      mergeSameName: z.boolean().optional(),
    }),
    result: idResult.extend({ ok: z.literal(true) }),
  },
  {
    action: "meta.usage",
    summary: "Where a tag or property is used outside a space",
    description: "Workspace owners. Before tag.scope/property.scope: per other space the pages and records using it (`usage`), and same-named ones it would meet (`clashes`). Changes nothing.",
    input: z.object({ action: z.literal("meta.usage"), workspaceId: uuid, kind: z.enum(["tag", "property"]), id: uuid, spaceId: uuid.nullable() }),
    result: z.object({
      usage: z.array(z.object({ spaceId: uuid, spaceName: z.string(), pages: z.number().int(), records: z.number().int(), titles: z.array(z.string()) })),
      clashes: z.array(z.object({ id: uuid, spaceId: uuid.nullable(), spaceName: z.string() }).passthrough()),
    }),
  },
  {
    action: "page.moveCheck",
    summary: "What a move would bring that its destination lacks",
    description:
      "Same input as page.move. Lists the tags and properties of the source space (into another workspace: all) that the page, its sub-pages and their databases' records carry and that the destination does not use (`foreign`: kind, id, name, pages, records, `sameName` – the same-named one there – and `candidates` to map to). Changes nothing.",
    input: z.object({
      action: z.literal("page.moveCheck"),
      pageId: uuid,
      targetId: uuid.optional(),
      placement: z.enum(["before", "after", "inside"]).optional(),
      parentId: uuid.optional(),
      spaceId: uuid.optional(),
    }),
    result: z.object({ foreign: z.array(z.object({}).passthrough()), target: z.object({ workspaceId: uuid, spaceId: uuid, spaceName: z.string() }) }),
  },
  {
    action: "template.copy",
    summary: "Copy a saved template into another space or the whole workspace",
    description:
      "Needs write access to the target space; for the whole workspace (`spaceId: null`, not private) workspace owners, and only with the workspace's tags and properties (409, or `spaceMeta: \"remove\"` leaves the space's out). Into another space its space's tags and properties are mapped, copied (created there now) or removed per `meta` (see template.dependencies; default `auto`). template.update takes `spaceId`, `spaceMeta` and `meta` the same way to change a template's own scope.",
    input: z.object({
      action: z.literal("template.copy"),
      workspaceId: uuid,
      templateId: uuid,
      spaceId: uuid.nullable(),
      name: z.string().max(500).optional(),
      private: z.boolean().optional(),
      meta: metaPlanInput.optional(),
      spaceMeta: z.literal("remove").optional(),
    }),
    result: idResult.extend({ ok: z.literal(true) }),
  },
  {
    action: "template.dependencies",
    summary: "What a template of another space brings into a space",
    description:
      "The tags and properties of the template's own space (and names the target lacks) when it is used in `spaceId`: each with `sameName` (the same-named one there) and `candidates`. Their ids (`tag:<name>`, `property:<name>`) are the keys of `meta` in page.create, template.apply and template.copy. Empty for templates of the whole workspace or of that space. Changes nothing.",
    input: z.object({ action: z.literal("template.dependencies"), workspaceId: uuid, templateId: uuid, spaceId: uuid }),
    result: z.object({ items: z.array(z.object({}).passthrough()) }),
  },
  {
    action: "row.repeat",
    summary: "Make a record repeat when it is done",
    description:
      "Needs editor rights on the record. When the record becomes done (the database's done rule), a copy is created with `field` (a date property) moved to the next occurrence and other dates moved by as many days. Monthly and yearly rules keep the day of the month (`day`, default: the current date's day); `weekdays` (1 = Monday) picks days of a weekly rule. `timeZone` (IANA, default UTC) is the zone a timed date's day and local time are counted in. `repeat: null` removes the rule.",
    input: z.object({
      action: z.literal("row.repeat"),
      pageId: uuid,
      rowId: uuid,
      version: z.number().int().positive(),
      repeat: repeatSchema.nullable(),
    }),
    result: okResult,
  },
  {
    action: "database.settings",
    summary: "Change the settings of a database (done rule, workflow, automations, sprints)",
    description:
      "Needs editor rights. Each key replaces that setting; `null` removes it. Automations with a `schedule` trigger only take `create` actions (a new record from a record template, with dates relative to the run); they run as the person who last saved them, at most once per scheduled time. `createdBy` and `since` are set by the server.",
    input: z.object({
      action: z.literal("database.settings"),
      pageId: uuid,
      settings: z.object({
        done: settingsSchema.shape.done.nullable(),
        workflow: settingsSchema.shape.workflow.nullable(),
        automations: settingsSchema.shape.automations.nullable(),
        sprints: settingsSchema.shape.sprints.nullable(),
        pointsField: settingsSchema.shape.pointsField.nullable(),
      }).partial(),
    }),
  },
  {
    action: "page.move",
    summary: "Move a page",
    input: z.object({
      action: z.literal("page.move"),
      pageId: uuid,
      targetId: uuid.optional().describe("The page to place it next to or inside"),
      placement: z.enum(["before", "after", "inside"]).optional().describe("Default: inside"),
      parentId: uuid.optional().describe("New parent when there is no target"),
      parentRowId: uuid.optional().describe("Below this record of the new parent database (with `parentId`, or `targetId` and placement `inside`). Next to a page (`before`/`after`) the page joins that page's record, if any"),
      spaceId: uuid.optional().describe("Move into another space"),
      meta: metaPlanInput
        .optional()
        .describe(
          "Into another space or workspace: what to do with the source space's tags and properties the pages carry (page.moveCheck lists them, by id): map to one of the destination, copy there, or remove. Without it such a move is refused with 409 – nothing is dropped silently.",
        ),
    }),
    result: okResult,
  },
  {
    action: "page.delete",
    summary: "Move a page and its sub-pages to the trash",
    input: z.object({ action: z.literal("page.delete"), pageId: uuid }),
    result: okResult,
  },
  {
    action: "page.restore",
    summary: "Restore a page from the trash",
    input: z.object({ action: z.literal("page.restore"), pageId: uuid }),
    result: okResult,
  },
  {
    action: "page.purge",
    summary: "Delete a page from the trash permanently",
    description:
      "The page must be in the trash (`page.delete`), and the caller needs edit rights on it – the same right as moving it to the trash. Its sub-pages in the trash that the caller may edit go with it; others stay in the trash on their own. Deleted for good: the page's content, versions, comments, records and database schema, uploads, favorites, publications, share links, notifications and search entries. Cannot be undone. Pages in the trash are also deleted automatically after the instance's trash period (default 30 days, set by admins).",
    input: z.object({ action: z.literal("page.purge"), pageId: uuid }),
    result: z.object({ ok: z.literal(true), pages: z.number().int().describe("Pages deleted, the page itself included") }),
  },
  {
    action: "file.delete",
    summary: "Move files to the trash",
    description:
      "Files of pages the caller may edit (full members only, not guests; not on a locked page). All or none. A file in the trash is no longer served (`/api/files/<id>` answers 404), listed, searched, copied or exported; documents that still show it get a missing-image placeholder. Restore it with `file.restore`; it is deleted for good with `file.purge`, `trash.empty` or after the trash period. Removing an image from a document never deletes the file.",
    input: z.object({ action: z.literal("file.delete"), fileIds: z.array(uuid).min(1).max(500) }),
    result: z.object({ ok: z.literal(true), files: z.number().int() }),
  },
  {
    action: "files.deleteUnused",
    summary: "Move all unused files to the trash",
    description:
      "Every file of the media library (`GET /api/media`, same `kind` and `query` filter) that no current content of the workspace refers to – documents, records, whiteboards, comments, page icons and covers – and that the caller may delete. Version history does not count: restoring a version whose file was deleted for good shows the image as missing.",
    input: z.object({
      action: z.literal("files.deleteUnused"),
      workspaceId: uuid,
      kind: z.enum(["all", "image", "video", "audio", "pdf", "other"]).optional(),
      query: z.string().max(200).optional(),
    }),
    result: z.object({ ok: z.literal(true), files: z.number().int().describe("Files moved to the trash") }),
  },
  {
    action: "file.restore",
    summary: "Restore a file from the trash",
    input: z.object({ action: z.literal("file.restore"), fileId: uuid }),
    result: okResult,
  },
  {
    action: "file.purge",
    summary: "Delete a file from the trash permanently",
    description:
      "The file must be in the trash (`file.delete`); the same right as moving it there. Deleted for good: the upload on disk and in object storage, its extracted text, handwriting, placeholder and search entries. Cannot be undone.",
    input: z.object({ action: z.literal("file.purge"), fileId: uuid }),
    result: okResult,
  },
  {
    action: "template.purge",
    summary: "Delete a template from the template trash permanently",
    description:
      "The template must be in the template trash (`template.delete`). Its creator or a workspace owner may delete it; templates for all workspaces or the public gallery need an administrator. Its stored files go with it. Pages already created from it are kept.",
    input: z.object({
      action: z.literal("template.purge"),
      workspaceId: uuid,
      templateId: uuid,
      version: z.number().int().optional().describe("The template's version, refused when it changed meanwhile"),
    }),
    result: okResult,
  },
  {
    action: "trash.empty",
    summary: "Empty the trash of a workspace",
    description:
      "Deletes for good everything in the workspace's trash the caller may delete: pages they can edit, spaces they manage, and deleted records they can edit. Pages of others' private spaces and read-only items are never touched. With `scope: \"templates\"` the template trash is emptied instead (templates the caller manages). Needs the editor role. Cannot be undone.",
    input: z.object({
      action: z.literal("trash.empty"),
      workspaceId: uuid,
      scope: z.enum(["workspace", "templates"]).optional().describe("What to empty (default `workspace`)"),
    }),
    result: z.object({
      ok: z.literal(true),
      pages: z.number().int().optional(),
      spaces: z.number().int().optional(),
      records: z.number().int().optional(),
      templates: z.number().int().optional(),
    }),
  },
  {
    action: "page.duplicate",
    summary: "Duplicate a page with its sub-pages",
    input: z.object({ action: z.literal("page.duplicate"), pageId: uuid }),
  },
  {
    action: "page.follow",
    summary: "Follow or unfollow a page (notifications about changes)",
    input: z.object({ action: z.literal("page.follow"), pageId: uuid, follow: z.boolean() }),
    result: z.object({ following: z.boolean() }),
  },
  {
    action: "page.collapseProperties",
    summary: "Collapse or open the bar with tags and properties of a page, for yourself on all devices (null: back to the default)",
    input: z.object({ action: z.literal("page.collapseProperties"), pageId: uuid, collapsed: z.boolean().nullable() }),
    result: z.object({ collapsed: z.boolean().nullable() }),
  },
  {
    action: "database.collapseRecordProperties",
    summary: "Fold or open the properties of a database's records, for yourself – one choice for all records of the database, separately for phones and larger screens (null: back to the default)",
    description: "`pageId` is the database. Without a choice records open with their properties shown, on phones folded when a record shows more than four. The page data of the database (GET /api/pages/{id}) carries the choices as `recordPropertiesCollapsed` ({ phone, desktop }).",
    input: z.object({ action: z.literal("database.collapseRecordProperties"), pageId: uuid, device: z.enum(["phone", "desktop"]), collapsed: z.boolean().nullable() }),
    result: z.object({ device: z.enum(["phone", "desktop"]), collapsed: z.boolean().nullable() }),
  },
  {
    action: "journal.completedMine",
    summary: "Choose \"Only mine\" or \"All\" for the records completed below the days of a journal, for yourself on all devices",
    description: "`pageId` is the journal. GET /api/journals/{dayId}/completed without `mine` then answers with this choice (\"Only mine\" until one is made).",
    input: z.object({ action: z.literal("journal.completedMine"), pageId: uuid, mine: z.boolean() }),
    result: z.object({ mine: z.boolean() }),
  },
  {
    action: "sidebar.state",
    summary: "Remember what you folded or unfolded in the sidebar of a workspace, for yourself on all devices",
    description:
      "`changes` maps keys to true (set) or false (remove): `p:<pageId>` a page unfolded in the tree (pages start folded), `s:<spaceId>` a space folded, `g:favorites` / `g:collections` that group folded, `jo:<journalId>:<YYYY or YYYY-MM>` / `jc:…` a journal folder opened / closed by hand. Unknown keys are ignored; keys of deleted pages and spaces, and of pages without sub-pages, drop out. The answer is the stored list (the bootstrap sends it as `sidebar`).",
    input: z.object({
      action: z.literal("sidebar.state"),
      workspaceId: uuid,
      changes: z.record(z.string().max(80), z.boolean()).describe("At most 2000 changes"),
    }),
    result: z.object({ keys: z.array(z.string()), updatedAt: z.number().int() }),
  },
  {
    action: "task.add",
    summary: "Add a task to your own task page (\"Add a task\" in My tasks)",
    description:
      "Writes an open task into your own page \"Aufgaben\"/\"Tasks\" of the workspace, a normal document made on first use in your first private space (a new private space when you have none; not an encrypted one). The page is remembered by id; when it was deleted or you can no longer edit it, the next task makes a new one. The shorthand of quick capture applies to `text`: a date (\"tomorrow\", \"Friday\", \"24.12.\" – relative to `today`, read in `locale`) becomes the due date, `@name` gives the task to that member only when they may open the page (otherwise the name stays in the text and `unassigned` names them). `due` wins over a date in the text. Needs full membership with edit rights (not guests or readers).",
    input: z.object({
      action: z.literal("task.add"),
      workspaceId: uuid,
      text: z.string().min(1).max(500),
      today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      locale: z.enum(["de", "en", "fr"]).optional(),
      due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    }),
    result: z.object({
      pageId: uuid,
      title: z.string(),
      created: z.boolean().describe("Whether the page was made now"),
      spaceCreated: z.boolean().describe("Whether a private space was made for it"),
      task: z.object({ text: z.string(), due: z.string().nullable(), assignee: z.string().nullable() }),
      unassigned: z.string().nullable().describe("The member `@name` named who cannot open the page: the task is not given to them, the name stays in the text"),
    }),
  },
  {
    action: "tasks.seen",
    summary: "Mark My tasks as seen: tasks given to you until now are no longer new",
    description: "The bootstrap's `newTasks` counts open tasks given to you by others since then; GET /api/tasks marks them `fresh`.",
    input: z.object({ action: z.literal("tasks.seen") }),
    result: z.object({ seenAt: z.number().int() }),
  },
  {
    action: "favorite",
    summary: "Add a page to or remove it from the favourites",
    input: z.object({ action: z.literal("favorite"), pageId: uuid, value: z.boolean() }),
    result: okResult,
  },
  {
    action: "database.update",
    summary: "Change the properties and views of a database",
    description:
      "`version` must be the database's current version (optimistic locking, 409 otherwise). A multiselect with `tagOptions: true` offers the workspace's tags as its options (its `options` are set by the server); cells keep the tag names, and a new name creates the tag (members with edit rights, not guests). Switching an existing multiselect to `tagOptions` maps its options to tags (missing ones are created) and keeps the values; switching back makes the tags in use its own options. Not in end-to-end encrypted spaces (409). `optionRenames` renames options of select and multiselect properties (not tag-backed ones): `from` must be one of the property's current options and missing from the new `options`, `to` one of the new `options`. Records, record templates, records in the trash, the views' filters and groups, the done rule, workflow, automations, form conditions and the issue sync's status mapping follow; a `to` that already was an option merges the two. Without `optionRenames`, changed options leave the records' values as they are. `optionColors` gives options of select and multiselect properties a colour (gray, blue, green, red, yellow, orange, purple, pink, teal): options new to the property without one get the next colour in turn, options without a colour keep the default look, a renamed option keeps its colour, colours of removed options are dropped. A property sent without `optionColors` keeps its stored colours; `{}` removes them. Tag-backed properties use the tags' colours.",
    input: z.object({
      action: z.literal("database.update"),
      pageId: uuid,
      version: z.number().int(),
      fields: z.array(field).min(1).max(80),
      views: z.array(view).min(1).max(30).optional(),
      optionRenames: optionRenamesSchema.optional(),
    }),
    result: okResult,
  },
  {
    action: "row.create",
    summary: "Create a record in a database",
    input: z.object({
      action: z.literal("row.create"),
      pageId: uuid.describe("Page ID of the database"),
      cells: cells.optional(),
      templateId: z.string().max(100).optional().describe("Record template to start from"),
      rowId: uuid.optional().describe("Own ID (idempotent: repeating the call is a no-op)"),
    }),
    result: idResult,
  },
  {
    action: "row.update",
    summary: "Change properties of a record",
    description:
      "`version` must match the record's current version – or, with `base`, the properties in `cells` must still have the values in `base` (the values the change was made on); properties not named stay as they are. The answer holds the record's new `rowVersion`.",
    input: z.object({
      action: z.literal("row.update"),
      pageId: uuid,
      rowId: uuid,
      version: z.number().int(),
      cells: cells.optional(),
      base: cells.optional().describe("The values of the changed properties the change was made on"),
    }),
    result: z.object({ ok: z.literal(true), rowVersion: z.number().int() }),
  },
  {
    action: "row.delete",
    summary: "Move a record to the trash of its database",
    input: z.object({ action: z.literal("row.delete"), pageId: uuid, rowId: uuid }),
    result: okResult,
  },
  {
    action: "whiteboard.toRecords",
    summary: "Turn sticky notes of a whiteboard into database records",
    description:
      "Needs edit rights on the whiteboard and the database (same workspace). Each note becomes a record: its first line the title, further lines the record's document; optionally its colour a select option (`colorField`, `colorOptions`) and its author a person (`personField`). Values are checked like every edit. At most 100 records per call; `rowId` makes it idempotent (an existing record answers `created: false`). The whiteboard itself is not changed – the app replaces or links the notes with record cards.",
    input: toRecordsInput,
    result: z.object({ records: z.array(z.object({ itemId: z.string(), rowId: uuid, created: z.boolean() })) }),
  },
  {
    action: "rows.import",
    summary: "Add several records at once",
    description:
      "Needs edit rights on the database. Values are checked like every edit: numbers, checkboxes and dates must fit their property, or the whole call is refused (400). Values of select and multi-select properties that are not options yet become new options (a different letter case takes the existing option's spelling); at most 100 new options per call. `newOptions` lists what was added.",
    input: z.object({ action: z.literal("rows.import"), pageId: uuid, rows: z.array(cells).max(5000) }),
    result: z.object({
      imported: z.number().int(),
      newOptions: z.array(z.object({ id: z.string(), name: z.string(), options: z.array(z.string()) })),
    }),
  },
  {
    action: "comment.create",
    summary: "Comment on a page or record",
    input: z.object({
      action: z.literal("comment.create"),
      pageId: uuid,
      rowId: uuid.optional(),
      body: z.string().trim().min(1).max(5000),
    }),
    result: okResult,
  },
  {
    action: "comment.resolve",
    summary: "Resolve or reopen a comment",
    input: z.object({ action: z.literal("comment.resolve"), pageId: uuid, commentId: uuid, resolved: z.boolean() }),
    result: okResult,
  },
  {
    action: "member.invite",
    summary: "Invite a person to a workspace",
    description: "Owners only. At most 40 invitations per hour per person (429 beyond that).",
    input: z.object({
      action: z.literal("member.invite"),
      workspaceId: uuid,
      email: z.email(),
      role: z.enum(["editor", "viewer"]),
    }),
  },
  {
    action: "calendar.feed",
    summary: "Create the iCalendar link of a calendar view",
    description: "Only signed in in the browser or the app: refused with 403 for personal API tokens, since the link would outlive the token.",
    input: z.object({ action: z.literal("calendar.feed"), pageId: uuid, viewId: z.string().max(100) }),
  },
  {
    action: "calendar.feed.revoke",
    summary: "Revoke the iCalendar link of a calendar view",
    input: z.object({ action: z.literal("calendar.feed.revoke"), pageId: uuid, viewId: z.string().max(100) }),
    result: okResult,
  },
  {
    action: "dashboard.save",
    summary: "Replace the tiles of a dashboard page",
    description: "Needs editor rights on the page. Each tile has an `id`, a `type` (view, number, chart, journal, tasks, recent, text), a `size` (small, medium, large, full) and the settings of its type; the order of the list is the order on the page.",
    input: z.object({
      action: z.literal("dashboard.save"),
      pageId: uuid,
      tiles: z.array(z.object({ id: z.string().max(40), type: z.enum(tileTypes), size: z.enum(tileSizes).optional() }).passthrough()).max(MAX_TILES),
    }),
    result: z.object({ tiles: z.array(z.object({ id: z.string() }).passthrough()) }),
  },
  {
    action: "notebook.sheet.add",
    summary: "Add sheets to a notebook page",
    description:
      "Needs editor rights. Adds `count` (default 1) empty sheets after the sheet `after` (null or missing: at the end; `at` = start: before the first sheet), optionally with their own `paper` (template blank, lined-college, lined-wide, grid, dotted, cornell, music; size a4 or letter; orientation portrait or landscape; color light or dark). The ink of a sheet is read and written with GET/POST /api/pages/{id}/ink?surface={sheetId}. Other notebook actions: notebook.sheet.duplicate {sheetId}, notebook.sheet.delete {sheetId}, notebook.sheet.move {order}, notebook.sheet.paper {sheetIds, paper|null}, notebook.paper {paper, all?}, notebook.import {fileId (a PDF attached to the page), pages: [{width, height}] (at most 500), after? or at = start, replaceEmpty?} – each PDF page becomes a sheet with that page as background. Organising: notebook.sheet.meta {sheetIds, title? (one sheet), bookmark?}, notebook.sheet.links {sheetId, links: [{id, x, y, w, h, label?, target: {sheet} | {page}}]}, notebook.outline {outline: [{id, sheet, title, level 0–2, y?}]} (the table of contents), notebook.outline.add {sheetId, title, level?, y?}, notebook.sheets.duplicate {sheetIds}, notebook.sheets.delete {sheetIds} (into the notebook's trash, kept 30 days; answers `trashed`), notebook.trash.restore {trashIds}, notebook.sheets.transfer {sheetIds, targetPageId, mode copy|move, after? or at = start} (editor rights on the target, and on the source to move). All answer with the notebook's paper, sheets (with title, bookmark, links where set) and outline.",
    input: z.object({
      action: z.literal("notebook.sheet.add"),
      pageId: uuid,
      after: z.string().max(40).nullable().optional(),
      at: z.literal("start").optional(),
      count: z.number().int().min(1).max(50).optional(),
      paper: z
        .object({
          template: z.enum(PAPER_TEMPLATES).optional(),
          size: z.enum(PAPER_SIZES).optional(),
          orientation: z.enum(PAPER_ORIENTATIONS).optional(),
          color: z.enum(PAPER_COLORS).optional(),
        })
        .optional(),
    }),
    result: z.object({
      created: z.array(z.string()),
      paper: z.object({ template: z.string(), size: z.string(), orientation: z.string(), color: z.string() }),
      sheets: z.array(
        z.object({
          id: z.string(),
          position: z.number(),
          paper: z.object({}).passthrough(),
          background: z.object({}).passthrough().nullable(),
          title: z.string().optional(),
          bookmark: z.boolean().optional(),
          links: z.array(z.object({}).passthrough()).optional(),
        }),
      ),
      outline: z.array(z.object({ id: z.string(), sheet: z.string(), title: z.string(), level: z.number(), y: z.number().optional() })).optional(),
    }),
  },
  {
    action: "webhook.delete",
    summary: "Remove a webhook",
    description: "Workspace owners only.",
    input: z.object({ action: z.literal("webhook.delete"), workspaceId: uuid, id: z.string() }),
    result: okResult,
  },
  {
    action: "inbound.save",
    summary: "Create or change an inbound e-mail address",
    description:
      "Workspace owners only. Mail to the address becomes a page below `pageId` (a document) or a record in it (a database). Only the listed senders (addresses or domains) get in. Without `id` a new address with a fresh token is created (at most 50 per workspace). `secret` sets a signing key for the HMAC check of the webhook (\"\" removes it).",
    input: z.object({
      action: z.literal("inbound.save"),
      workspaceId: uuid,
      id: uuid.optional().describe("Change this address instead of creating one"),
      pageId: uuid.describe("Target page (document) or database"),
      label: z.string().max(100).optional(),
      senders: z.array(z.string().max(254)).min(1).max(100).describe("Allowed senders: e-mail addresses or domains"),
      secret: z.string().max(500).optional().describe("Signing key (X-Flowplan-Signature or Mailgun signature)"),
    }),
    result: idResult,
  },
  {
    action: "inbound.rotate",
    summary: "Give an inbound e-mail address a new token",
    description: "Workspace owners only. The old webhook URL and address stop working at once.",
    input: z.object({ action: z.literal("inbound.rotate"), workspaceId: uuid, id: uuid }),
    result: z.object({ id: uuid, token: z.string() }),
  },
  {
    action: "inbound.delete",
    summary: "Remove an inbound e-mail address",
    description: "Workspace owners only.",
    input: z.object({ action: z.literal("inbound.delete"), workspaceId: uuid, id: uuid }),
    result: okResult,
  },
  {
    action: "issueSync.connect",
    summary: "Connect GitHub, GitLab or Forgejo/Gitea for issue sync",
    description:
      "Workspace owners and administrators. Without `id` a new connection (token required); with `id` an update (the token stays unless given). The token is stored encrypted. Self-hosted servers only when listed in ISSUE_SYNC_ALLOWED_HOSTS; Forgejo/Gitea (`forgejo`) always needs `baseUrl`, codeberg.org without a listing. Check the token first with POST /api/issue-sync `{ op: \"test\" }`.",
    input: z.object({
      action: z.literal("issueSync.connect"),
      workspaceId: uuid,
      id: uuid.optional().describe("Existing connection to update"),
      provider: z.enum(["github", "gitlab", "forgejo"]).describe("`forgejo` for Forgejo and Gitea (the same API)"),
      baseUrl: z.string().max(500).optional().describe("Self-hosted server, e.g. https://gitlab.example.org; empty for github.com or gitlab.com; required for Forgejo/Gitea"),
      repo: z.string().max(300).optional().describe("Default repository: `owner/name` (GitHub, Forgejo/Gitea) or `group/project` (GitLab)"),
      token: z.string().max(1000).optional(),
      people: z.array(z.object({ login: z.string().max(100), email: z.string().max(200) })).max(500).optional().describe("Login ↔ e-mail of a member, for assignees"),
    }),
    result: idResult,
  },
  {
    action: "issueSync.disconnect",
    summary: "Remove a GitHub, GitLab or Forgejo/Gitea connection",
    description: "Workspace owners and administrators. Ends the sync of every database using it; records stay.",
    input: z.object({ action: z.literal("issueSync.disconnect"), workspaceId: uuid, id: uuid }),
    result: okResult,
  },
  {
    action: "issueSync.map",
    summary: "Sync a database with the issues of a repository",
    description:
      "Workspace owners and administrators with edit rights on the database. The sync acts as the person who set up the connection. `config` maps properties: `title`, `body` (a text property or `@document`), `status` ({ field, map: [{ value, state: open|closed, label }] }), `labels` (multi-select), `assignee` (person), `milestone` (date ↔ milestone due date), `number` and `url` (read-only), `direction` (both, pull, push), `comments` ({ pull, push }), `importExisting`.",
    input: z.object({
      action: z.literal("issueSync.map"),
      pageId: uuid,
      connectionId: uuid,
      repo: z.string().max(300).optional().describe("Default: the repository of the connection"),
      config: z.object({}).passthrough(),
    }),
    result: okResult,
  },
  {
    action: "issueSync.unmap",
    summary: "Stop syncing a database with issues",
    description: "Workspace owners and administrators. Records and issues stay; only the links end.",
    input: z.object({ action: z.literal("issueSync.unmap"), pageId: uuid }),
    result: okResult,
  },  {
    action: "calendarSync.map",
    summary: "Sync a database view with a Google or Microsoft 365 calendar",
    description:
      "Needs editor rights on the database and a calendar connection of the caller (set up in the browser under Settings → Calendars & issues). The view needs a date property. One calendar per view and person; changing the calendar starts the sync anew. The sync runs every ten minutes.",
    input: z.object({
      action: z.literal("calendarSync.map"),
      connectionId: uuid,
      pageId: uuid,
      viewId: z.string().max(100),
      calendarId: z.string().min(1).max(1000).describe("Calendar ID from the provider's calendar list"),
      calendarName: z.string().max(300).optional(),
    }),
    result: idResult,
  },
  {
    action: "calendarSync.unmap",
    summary: "Stop syncing a view with its calendar",
    description: "Events already in the calendar and records in the database stay.",
    input: z.object({ action: z.literal("calendarSync.unmap"), id: uuid }),
    result: okResult,
  },
  {
    action: "calendarSync.disconnect",
    summary: "Remove a calendar connection of the caller",
    description: "Ends all syncs of the connection and forgets its tokens. Access can also be revoked in the Google or Microsoft account.",
    input: z.object({ action: z.literal("calendarSync.disconnect"), connectionId: uuid }),
    result: okResult,
  },
  {
    action: "meeting.note",
    summary: "Create a meeting note for an appointment of a journal day",
    description:
      "Needs editor rights on the journal. For a record (`event.pageId` and `event.rowId`) the title, people and attendees come from the record; for a calendar event they come from `event`. Attendees whose e-mail belongs to a member become mentions. Returns the existing note when there already is one for the appointment.",
    input: z.object({
      action: z.literal("meeting.note"),
      pageId: uuid.describe("The journal day"),
      zone: z.string().max(100).optional().describe("IANA time zone for the times in the note"),
      event: z.object({
        title: z.string().max(500).optional(),
        start: z.string().max(40),
        end: z.string().max(40).optional(),
        timed: z.boolean().optional(),
        pageId: uuid.optional(),
        rowId: uuid.optional(),
        uid: z.string().max(500).optional(),
        attendees: z.array(z.object({ email: z.string().max(254), name: z.string().max(200).optional() })).max(200).optional(),
      }),
    }),
    result: z.object({ id: uuid, existing: z.boolean() }),
  },
  {
    action: "notification.weekly",
    summary: "Weekly digest e-mail on or off",
    description:
      "Every Monday at 07:00 in `timeZone`: changes in followed pages, open and overdue tasks. `aiSummary` adds a short AI summary only while AI is usable for you; otherwise the plain list is sent. Needs SMTP on the instance.",
    input: z.object({
      action: z.literal("notification.weekly"),
      enabled: z.boolean(),
      aiSummary: z.boolean().optional(),
      timeZone: z.string().max(100).optional().describe("IANA time zone, e.g. Europe/Berlin"),
    }),
    result: z.object({ enabled: z.boolean(), aiSummary: z.boolean(), timeZone: z.string() }),
  },
  {
    action: "shortcuts.save",
    summary: "Save your own keyboard shortcuts",
    description:
      "Replaces the whole set. Keys are actions (" + SHORTCUT_ACTIONS.join(", ") + "), values up to " + MAX_COMBOS + " combinations such as `Mod+Alt+N` (`Mod` is ⌘ on Apple devices, Ctrl elsewhere); an empty list removes the shortcut, a missing action uses its default. `{}` resets everything.",
    input: z.object({
      action: z.literal("shortcuts.save"),
      bindings: z.partialRecord(z.enum(SHORTCUT_ACTIONS), z.array(z.string().max(40)).max(MAX_COMBOS)),
    }),
    result: z.object({ bindings: z.record(z.string(), z.array(z.string())) }),
  },
  {
    action: "home.save",
    summary: "Save your start page layout",
    description:
      "The widgets of your start page (kind, size, settings) and its look, versioned (`version: 1`, see lib/home-layout-schema.ts). `scope: \"workspace\"` keeps it for this workspace, `\"personal\"` makes it your default for every workspace without its own. At most " + MAX_HOME_WIDGETS + " widgets and " + MAX_LAYOUT_BYTES + " bytes. `home.reset` goes back one step, `home.note` saves the text of one note widget, `home.config` one setting changed on a widget itself (`{ widgetId, config: { period } }` of a `myActivity` widget), `home.default` (owners) sets the layout members see by default.",
    input: saveSchema.extend({ action: z.literal("home.save") }),
    result: z.object({ layout: z.unknown(), source: z.enum(["workspace", "personal", "team", "builtin"]), fallback: z.unknown(), fallbackSource: z.string(), teamDefault: z.boolean(), updatedAt: z.number().nullable() }),
  },
];
const otherActions = commandActionNames.filter((name) => !commandActions.some((a) => a.action === name));
export const commandSchemaName = (action: string) =>
  "Command" + action.split(".").map((part) => part[0].toUpperCase() + part.slice(1)).join("");

// ---- Request and response schemas ----

const webhookEventSchema = z.enum(noticeEvents);
const webhookFormatSchema = z
  .enum(chatFormats)
  .describe("json: the signed event envelope (WebhookDelivery); slack: Block Kit for an Incoming Webhook or chat.postMessage; matrix: a room webhook or the Matrix client API; teams: an Adaptive Card for an Incoming Webhook / Workflow; discord: embeds for a Discord webhook");
const webhookTemplatesSchema = templatesSchema.describe(
  "Message text per event for chat formats, with the placeholders {title}, {actor}, {page}, {changes}, {url}, {text}, {date}, {count} and Markdown (**bold**, _italic_, `code`, [text](url), - lists, > quotes); missing events use the default text",
);
const webhookConfigSchema = hookConfigSchema
  .partial()
  .describe("language of chat messages; digestTime (HH:MM) and timeZone of the daily digest; matrixRoom for the Matrix client API; slackChannel (channel ID) for a Slack bot token");
const webhookCredentialsSchema = z
  .object({
    token: z.string().min(8).max(500).optional().describe("Matrix access token (url is then the homeserver) or Slack bot token (xoxb-…, sent via chat.postMessage)"),
    signingSecret: z.string().min(8).max(200).optional().describe("Slack signing secret: thread replies come back as comments (Event Subscriptions URL: repliesUrl)"),
  })
  .describe("Stored encrypted, never returned");
export const webhookCreateSchema = z.object({
  workspaceId: uuid,
  url: z.string().max(2000).describe("Public HTTPS address (FLOWPLAN_WEBHOOK_ALLOW_PRIVATE=true allows internal ones)"),
  events: z.array(webhookEventSchema).min(1),
  pageId: uuid.nullable().optional().describe("Only events of this database"),
  format: webhookFormatSchema.optional(),
  templates: webhookTemplatesSchema.optional(),
  config: webhookConfigSchema.optional(),
  credentials: webhookCredentialsSchema.optional(),
});
export const webhookUpdateSchema = webhookCreateSchema.extend({
  id: z.string().max(60),
  url: z.string().max(2000).optional().describe("A new address (checked again); left out: unchanged"),
  credentials: webhookCredentialsSchema.nullable().optional().describe("Left out: unchanged; null: removed; given: the parts replace the stored ones"),
});
export const markdownExportSchema = z
  .object({
    pageId: uuid.optional().describe("The page to export (or spaceId)"),
    spaceId: uuid.optional().describe("A whole space as ZIP (or pageId)"),
    format: z.enum(["markdown", "zip"]),
    includeSubpages: z.boolean().default(false),
    rowId: uuid.optional().describe("One record of a database page"),
    history: z.boolean().default(false).describe("Include the version history"),
  })
  .describe("Exactly one of pageId and spaceId.");
const mcpRequest = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string().describe("initialize, tools/list, tools/call, resources/read, prompts/list, …"),
  params: z.record(z.string(), z.unknown()).optional(),
});

// The mobile widget API: one configuration schema per kind, one body per action.
const widgetName = (name: string) => name.replace(/(^|[.-])(\w)/g, (_, __, c: string) => c.toUpperCase());
const widgetSchemas: Record<string, Json> = {
  ...Object.fromEntries(widgetKinds.map((kind) => [`WidgetConfig${widgetName(kind)}`, { ...jsonSchema(widgetConfigs[kind]), description: `Configuration of a \`${kind}\` widget.` }])),
  ...Object.fromEntries(
    widgetActions.map((action) => {
      const schema = jsonSchema(actionSchemas[action]);
      const properties = { action: { type: "string", const: action }, ...((schema.properties as Json) || {}) };
      return [`WidgetAction${widgetName(action)}`, { ...schema, properties, required: ["action", ...((schema.required as string[]) || [])] }];
    }),
  ),
  WidgetDataRequest: {
    ...jsonSchema(dataRequestSchema),
    description: `Up to ${MAX_WIDGETS} widgets in one request. \`config\` follows the WidgetConfig schema of its \`kind\` (e.g. WidgetConfigTasks); \`today\` and \`zone\` are the phone's day and IANA time zone, \`lang\` de, en or fr.`,
  },
  WidgetDataResponse: {
    type: "object",
    properties: {
      at: { type: "integer", description: "Server time (ms)" },
      today: { type: "string", format: "date" },
      zone: { type: "string" },
      widgets: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: ["string", "null"], description: "The `id` sent with the widget" },
            kind: { type: "string", enum: [...widgetKinds] },
            ok: { type: "boolean" },
            data: { type: "object", additionalProperties: true, description: `The widget's data: at most ${MAX_ITEMS} items and about ${MAX_WIDGET_BYTES} bytes (\`truncated: true\` when shortened). Pages behind a journal PIN answer \`locked: true\`, end-to-end encrypted ones \`encrypted: true\`, without content.` },
            status: { type: "integer", description: "HTTP status of a widget that failed (403, 404 …)" },
            error: { type: "string" },
          },
          required: ["id", "kind", "ok"],
        },
      },
    },
    required: ["at", "today", "zone", "widgets"],
  },
  WidgetAction: { oneOf: widgetActions.map((action) => ref(`WidgetAction${widgetName(action)}`)), discriminator: { propertyName: "action" } },
};

const schemas: Record<string, Json> = {
  ...widgetSchemas,
  ErrorResponse: {
    type: "object",
    description: "Every error answer. `error` is a sentence in the reader's language (German by default, English with Accept-Language).",
    properties: {
      error: { type: "string" },
      details: { type: "array", items: { type: "string" }, description: "Validation messages (400)" },
      code: {
        type: "string",
        description:
          "Set on refusals of the Idempotency-Key: `idempotency_key_invalid` (400), `idempotency_key_reused` (422, the key was used for another request), `idempotency_in_progress` (409, try again after `Retry-After`), `idempotency_already_applied` (409, the answer is not kept – it held a secret or was larger than 64 KB).",
      },
    },
    required: ["error"],
  },
  Ok: jsonSchema(okResult),
  Created: jsonSchema(idResult),
  Workspace: {
    type: "object",
    properties: {
      id: { type: "string", format: "uuid" },
      name: { type: "string" },
      icon: { type: "string" },
      role: { type: "string", enum: ["owner", "editor", "viewer"], description: "Your role" },
      guest: { type: "integer", description: "1 when you only see pages shared with you" },
    },
    required: ["id", "name", "icon", "role"],
  },
  Space: {
    type: "object",
    properties: {
      id: { type: "string", format: "uuid" },
      workspace_id: { type: "string", format: "uuid" },
      name: { type: "string" },
      icon: { type: "string" },
      icon_color: { type: "string" },
      visibility: { type: "string", enum: ["team", "private"] },
      owner_id: { type: "string", format: "uuid" },
      deleted_at: { type: ["string", "null"] },
    },
    required: ["id", "workspace_id", "name", "icon", "visibility", "owner_id"],
  },
  Page: {
    type: "object",
    properties: {
      id: { type: "string", format: "uuid" },
      workspace_id: { type: "string", format: "uuid" },
      space_id: { type: "string", format: "uuid" },
      parent_id: { type: ["string", "null"], format: "uuid" },
      parent_row_id: { type: ["string", "null"], format: "uuid", description: "Below this record of the parent database (parent_id)" },
      title: { type: "string" },
      icon: { type: "string" },
      cover: { type: "string" },
      cover_position: { type: "number" },
      kind: { type: "string", enum: ["document", "database", "whiteboard", "journal", "dashboard", "notebook", "workflow"] },
      position: { type: "number" },
      deleted_at: { type: ["string", "null"] },
      created_by: { type: "string", format: "uuid" },
      updated_at: { type: "string" },
      locked: { type: "integer", description: "1 when locked" },
      public_token: { type: ["string", "null"] },
      full_width: { type: "integer" },
      caption_numbers: { type: "integer", description: "1 when captions of images, tables and code blocks are numbered" },
      icon_size: { type: "string", enum: ["", "small", "medium", "large"] },
      font: { type: "string" },
      journal_date: { type: ["string", "null"], description: "Day pages of a journal: YYYY-MM-DD" },
    },
    required: ["id", "workspace_id", "space_id", "parent_id", "title", "icon", "cover", "kind", "position", "deleted_at", "created_by", "updated_at", "locked", "public_token", "full_width", "font"],
  },
  Field: { ...jsonSchema(field), description: "A database property (column)." },
  View: { ...jsonSchema(view), description: "A view of a database (table, board, calendar, …)." },
  Database: {
    type: "object",
    properties: {
      page_id: { type: "string", format: "uuid" },
      fields: { type: "array", items: ref("Field") },
      views: { type: "array", items: ref("View") },
      version: { type: "integer", description: "Changes with every database.update" },
      recordLayout: { type: "object", additionalProperties: true },
      settings: { type: "object", additionalProperties: true },
    },
    required: ["page_id", "fields", "views", "version"],
  },
  Row: {
    type: "object",
    description: "A database record. `cells` maps property IDs to values: strings, numbers, booleans, option names, arrays of option names or record IDs, `YYYY-MM-DD` dates.",
    properties: {
      id: { type: "string", format: "uuid" },
      page_id: { type: "string", format: "uuid" },
      cells: { type: "object", additionalProperties: true },
      position: { type: "number" },
      created_at: { type: "string" },
      updated_at: { type: "string" },
      created_by: { type: "string", format: "uuid" },
      updated_by: { type: "string", format: "uuid" },
      version: { type: "integer", description: "Pass it with row.update (optimistic locking)" },
      number: { type: ["integer", "null"], description: "Running number in its database" },
      icon: { type: "string" },
      cover: { type: "string" },
      recurrence: { type: "string" },
      access: { type: "string", description: "Record permissions mode" },
      role: { type: "string", enum: ["owner", "editor", "viewer"], description: "Your role on this record" },
      preview: { type: "object", additionalProperties: true, description: "Preview of the record document (not the full content)" },
    },
    required: ["id", "page_id", "cells", "position", "created_at", "updated_at", "created_by", "updated_by", "version"],
  },
  Comment: {
    type: "object",
    properties: {
      id: { type: "string" },
      page_id: { type: "string", format: "uuid" },
      row_id: { type: ["string", "null"], format: "uuid" },
      author_id: { type: ["string", "null"] },
      name: { type: "string" },
      body: { type: "string" },
      resolved: { type: "integer" },
      created_at: { type: "string" },
    },
    required: ["id", "page_id", "row_id", "name", "body", "resolved", "created_at"],
  },
  Member: {
    type: "object",
    properties: {
      id: { type: "string", format: "uuid" },
      name: { type: "string" },
      email: { type: "string" },
      disabled: { type: "integer" },
      avatar: { type: ["string", "null"] },
      role: { type: "string", enum: ["owner", "editor", "viewer"] },
      guest: { type: "integer" },
    },
    required: ["id", "name", "email", "role"],
  },
  Bootstrap: {
    type: "object",
    description: "Everything the workspace shell needs. Only the parts integrations use are described; the answer carries more.",
    properties: {
      user: { type: "object", properties: { id: { type: "string", format: "uuid" }, name: { type: "string" }, email: { type: "string" }, apiScope: { type: "string", enum: ["read", "write"] } }, required: ["id", "name", "email"] },
      workspaces: { type: "array", items: ref("Workspace") },
      workspace: ref("Workspace"),
      spaces: { type: "array", items: ref("Space") },
      pages: { type: "array", items: ref("Page"), description: "Pages you may read, outside the trash" },
      favorites: { type: "array", items: { type: "string", format: "uuid" } },
      members: { type: "array", items: ref("Member") },
      instance: { type: "object", properties: { name: { type: "string" }, announcement: { type: "string" } }, additionalProperties: true },
    },
    required: ["user", "workspaces", "workspace", "spaces", "pages", "favorites", "members"],
    additionalProperties: true,
  },
  PageData: {
    type: "object",
    description: "A page with its content. Documents carry `html`; databases `database`, `rows` and `related`; whiteboards `whiteboard`.",
    properties: {
      page: ref("Page"),
      role: { type: "string", enum: ["owner", "editor", "viewer"] },
      comments: { type: "array", items: ref("Comment") },
      snapshots: { type: "array", items: { type: "object", additionalProperties: true } },
      backlinks: { type: "array", items: { type: "object", additionalProperties: true } },
      html: { type: "string", description: "Documents and whiteboards: the content as HTML" },
      generation: { type: "string" },
      database: ref("Database"),
      rows: { type: "array", items: ref("Row"), description: "Databases: the records you may see" },
      related: { type: "object", additionalProperties: { type: "array", items: ref("Row") }, description: "Rows of related databases by page ID" },
      files: { type: "array", items: ref("FileInfo") },
      whiteboard: { type: "object", additionalProperties: true },
      locked: { type: "object", properties: { journalId: { type: "string", format: "uuid" } }, description: "Present when a journal PIN hides the content" },
    },
    required: ["page", "role", "comments", "snapshots"],
    additionalProperties: true,
  },
  RowDocument: {
    type: "object",
    description: "A record with its document.",
    properties: { row: ref("Row"), html: { type: "string" }, generation: { type: "string" } },
    required: ["row"],
    additionalProperties: true,
  },
  FileInfo: {
    type: "object",
    properties: {
      id: { type: "string", format: "uuid" },
      url: { type: "string", description: "`/api/files/<id>`" },
      name: { type: "string" },
      mime: { type: "string" },
      size: { type: "integer" },
      placeholder: ref("ImagePlaceholder"),
    },
    required: ["id", "url", "name", "mime"],
  },
  ImagePlaceholder: {
    type: "object",
    description: "Uploaded images: the size they are shown in and a ThumbHash (https://evanw.github.io/thumbhash/, base64) of a blurred preview. Never for files of end-to-end encrypted spaces.",
    properties: {
      w: { type: "integer", minimum: 1 },
      h: { type: "integer", minimum: 1 },
      hash: { type: "string", description: "Missing for types without a preview (AVIF, HEIC)" },
    },
    required: ["w", "h"],
  },
  SearchResult: {
    type: "object",
    properties: {
      id: { type: "string", format: "uuid", description: "Page ID" },
      rowId: { type: "string", format: "uuid", description: "Record ID for kind `row`" },
      title: { type: "string" },
      pageTitle: { type: "string" },
      icon: { type: "string" },
      space_id: { type: "string", format: "uuid" },
      kind: { type: "string", enum: ["document", "database", "whiteboard", "row", "comment", "file"] },
      snippet: { type: "string", description: "Matches are wrapped in U+0002 … U+0003" },
      alias: { type: "string", description: "The alias the query matched" },
      journalDate: { type: "string", format: "date", description: "A hit on a journal day: its date (ranked after other pages)" },
      updatedAt: { type: "string", format: "date-time", description: "Last change of the page or record (UTC)" },
    },
    required: ["id", "title", "icon", "space_id", "kind", "snippet"],
  },
  RecentVisit: {
    allOf: [
      ref("SearchResult"),
      { type: "object", properties: { visitedAt: { type: "integer", description: "Your last visit, milliseconds since 1970" } }, required: ["visitedAt"] },
    ],
  },
  ApiToken: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      scope: { type: "string", enum: ["read", "write", "clipper"], description: "`clipper` tokens (browser extension) only reach /api/clipper/*" },
      prefix: { type: "string", description: "The first characters of the token" },
      created_at: { type: "integer", description: "Milliseconds since 1970" },
      last_used_at: { type: ["integer", "null"] },
      expires_at: { type: ["integer", "null"] },
      ai: { type: "integer", enum: [0, 1], description: "1: the token has the permission “AI and transcription” (AI features, transcription, meeting notes)" },
      marketplace_check: { type: "integer", enum: [0, 1], description: "1: the token has the permission “Marketplace check” (POST /api/marketplace/check only, never a real import)" },
    },
    required: ["id", "name", "scope", "prefix", "created_at"],
  },
  WebhookEvent: { ...jsonSchema(webhookEventSchema), description: "row.created: new record (also from a form); row.updated: record changed (`changed` names the properties); row.done: a record became done; form.submitted; page.created; comment.created (`text`); mention (`userId`, `text` = the name); digest.due: once a day at `config.digestTime`, the open records due today or overdue (`items`). Test messages carry the event `test`." },
  Webhook: {
    type: "object",
    properties: {
      id: { type: "string" },
      url: { type: "string" },
      events: { type: "array", items: ref("WebhookEvent") },
      page_id: { type: ["string", "null"], format: "uuid" },
      created_at: { type: "integer" },
      format: jsonSchema(webhookFormatSchema),
      templates: jsonSchema(webhookTemplatesSchema),
      config: jsonSchema(webhookConfigSchema),
      credentials: {
        type: "object",
        description: "Which credentials are stored (never their values)",
        properties: { token: { type: "boolean" }, signingSecret: { type: "boolean" } },
        required: ["token", "signingSecret"],
      },
      repliesUrl: { type: ["string", "null"], description: "Slack Event Subscriptions Request URL, when a signing secret is stored" },
      last: {
        type: ["object", "null"],
        description: "The last delivery",
        properties: { status: { type: ["integer", "null"] }, error: { type: ["string", "null"] }, delivered_at: { type: ["integer", "null"] } },
      },
      lastError: {
        type: ["object", "null"],
        description: "The last failed attempt",
        properties: { error: { type: "string" }, at: { type: "integer" } },
      },
    },
    required: ["id", "url", "events", "page_id", "created_at", "format", "templates", "config", "credentials", "repliesUrl", "last", "lastError"],
  },
  WebhookCreate: jsonSchema(webhookCreateSchema),
  WebhookUpdate: jsonSchema(webhookUpdateSchema),
  WebhookTestResult: {
    type: "object",
    properties: { ok: { type: "boolean" }, status: { type: ["integer", "null"] }, error: { type: ["string", "null"] } },
    required: ["ok", "status", "error"],
  },
  WebhookCreated: {
    type: "object",
    properties: { id: { type: "string" }, secret: { type: "string", description: "Signs deliveries (X-Flowplan-Signature: sha256=HMAC); shown only here" } },
    required: ["id", "secret"],
  },
  WebhookDelivery: {
    type: "object",
    description: "What a webhook of the format json receives (POST, JSON). The header `X-Flowplan-Signature: sha256=<hex>` is the HMAC-SHA256 of the body with the webhook's secret. Chat formats receive the platform's own message instead.",
    properties: {
      event: ref("WebhookEvent"),
      id: { type: "string" },
      createdAt: { type: "string", format: "date-time" },
      workspaceId: { type: "string", format: "uuid" },
      data: { type: "object", properties: { pageId: { type: "string", format: "uuid" }, rowId: { type: "string", format: "uuid" }, cells: { type: "object", additionalProperties: true } }, additionalProperties: true },
    },
    required: ["event", "id", "createdAt", "workspaceId", "data"],
  },
  MarkdownExportOptions: jsonSchema(markdownExportSchema),
  WorkspaceExport: {
    type: "object",
    properties: {
      format: { type: "string", enum: ["flowplan-1"] },
      exportedAt: { type: "string", format: "date-time" },
      workspace: { type: "object", properties: { name: { type: "string" }, icon: { type: "string" } } },
      pages: {
        type: "array",
        items: {
          allOf: [ref("Page"), { type: "object", properties: { data: { description: "Databases: `{ database, rows }`; otherwise `{ html }`", type: "object", additionalProperties: true } } }],
        },
      },
    },
    required: ["format", "exportedAt", "workspace", "pages"],
  },
  Task: {
    type: "object",
    description: "A task in a document or record.",
    additionalProperties: true,
    properties: {
      pageId: { type: "string", format: "uuid" },
      text: { type: "string" },
      done: { type: "boolean" },
      due: { type: ["string", "null"] },
      own: { type: "boolean", description: "In your own task page (My tasks)" },
      fresh: { type: "boolean", description: "Given to you by someone else since you last opened My tasks" },
    },
  },
  McpRequest: jsonSchema(mcpRequest),
  McpResponse: {
    type: "object",
    properties: {
      jsonrpc: { type: "string", enum: ["2.0"] },
      id: { type: ["string", "number", "null"] },
      result: { type: "object", additionalProperties: true },
      error: { type: "object", properties: { code: { type: "integer" }, message: { type: "string" } }, required: ["code", "message"] },
    },
    required: ["jsonrpc"],
  },
  Health: {
    type: "object",
    properties: {
      service: { type: "string", enum: ["flowplan"] },
      status: { type: "string", enum: ["ok", "error"] },
      checks: { type: "object", description: "Details only with the metrics token or for an administrator.", additionalProperties: { type: "string", enum: ["ok", "error"] } },
      searchBacklog: { type: "integer" },
      failedPushDeliveries: { type: "integer" },
      objectStorage: { oneOf: [{ type: "string", enum: ["off"] }, { type: "object", properties: { pending: { type: "integer" }, retrying: { type: "boolean" } } }] },
      uptimeSeconds: { type: "integer" },
    },
    required: ["service", "status"],
    additionalProperties: true,
  },
  SiteInfo: {
    type: "object",
    properties: {
      signupOpen: { type: "boolean" },
      demo: { type: "boolean" },
      sso: { type: "boolean" },
      movedTo: { type: ["string", "null"], description: "After an instance move: the new address (apps can point there)" },
      readOnly: { type: "boolean", description: "The instance is read-only during or after a move; changes are refused with 423" },
    },
    required: ["signupOpen", "demo", "sso"],
  },
  CommandResult: {
    type: "object",
    description: "Depends on the action: `{ ok: true }` for most changes, `{ id }` for everything created.",
    additionalProperties: true,
  },
  CommandOther: {
    type: "object",
    description: "Every other action the interface sends. The server validates the fields of each; see lib/api.ts command() in the source.",
    properties: { action: { type: "string", enum: [...otherActions] } },
    required: ["action"],
    additionalProperties: true,
  },
};
// Workflows (#168): the graph format (lib/workflows/graph.ts) and what the routes answer.
const loose = (properties: Record<string, Json>, required: string[] = []): Json => ({ type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: true });
const person: Json = { type: ["object", "null"], properties: { id: { type: "string" }, name: { type: "string" }, email: { type: "string" } } };
Object.assign(schemas, {
  WorkflowNode: { ...jsonSchema(workflowNodeSchema), description: "A node: `type` from the catalogue (GET /api/workflows/catalog), `config` per its schema; ids n_ + 6–12 of [a-z0-9]; labels unique, without . | { } [ ]." },
  WorkflowEdge: { ...jsonSchema(workflowEdgeSchema), description: "A connection from a node's output port to another node's input." },
  WorkflowGraph: {
    type: "object",
    description: "A workflow graph (format flowplan.workflow, version 1): at least one trigger, at most 150 nodes, 300 edges and 1 MB; no cycles outside “For each”.",
    properties: {
      format: { type: "string", const: "flowplan.workflow" },
      version: { type: "integer", minimum: 1 },
      settings: jsonSchema(workflowSettingsSchema),
      nodes: { type: "array", items: ref("WorkflowNode"), maxItems: 150 },
      edges: { type: "array", items: ref("WorkflowEdge"), maxItems: 300 },
    },
    required: ["nodes", "edges"],
  },
  WorkflowIssue: loose({ level: { type: "string", enum: ["error", "warning"] }, code: { type: "string" }, nodeId: { type: "string" }, edgeId: { type: "string" }, params: { type: "object", additionalProperties: true }, message: { type: "string" } }, ["level", "code", "message"]),
  WorkflowCheckResult: loose({ ok: { type: "boolean" }, issues: { type: "array", items: ref("WorkflowIssue") } }, ["ok", "issues"]),
  WorkflowSummary: loose({ pageId: { type: "string", format: "uuid" }, title: { type: "string" }, status: { type: "string", enum: ["draft", "active", "paused", "auto_paused"] }, runner: person, manual: { type: "boolean" }, lastRun: { type: ["object", "null"], additionalProperties: true } }, ["pageId", "title", "status"]),
  WorkflowCatalogNode: loose({ type: { type: "string" }, category: { type: "string" }, name: { type: "array", items: { type: "string" } }, description: { type: "array", items: { type: "string" } }, icon: { type: "string" }, inline: { type: "boolean" }, event: { type: ["string", "null"] }, ports: { type: "array", items: { type: "string" } }, outputs: { type: "array", items: { type: "object", additionalProperties: true } }, config: { type: "object", additionalProperties: true } }, ["type", "category", "config"]),
  WorkflowState: loose(
    {
      pageId: { type: "string", format: "uuid" },
      title: { type: "string" },
      status: { type: "string", enum: ["draft", "active", "paused", "auto_paused"] },
      pauseReason: { type: ["string", "null"] },
      runner: person,
      canEdit: { type: "boolean" },
      active: { type: ["object", "null"], properties: { id: { type: "string" }, number: { type: "integer" }, graph: ref("WorkflowGraph"), note: { type: "string" } }, additionalProperties: true },
      draft: { type: ["object", "null"], properties: { graph: ref("WorkflowGraph"), changed: { type: "boolean" }, issues: { type: "array", items: ref("WorkflowIssue") } }, additionalProperties: true },
      lastRun: { type: ["object", "null"], additionalProperties: true },
    },
    ["pageId", "status", "canEdit"],
  ),
  WorkflowRun: loose({ id: { type: "string" }, status: { type: "string", enum: ["queued", "running", "waiting", "held", "succeeded", "failed", "cancelled"] }, mode: { type: "string", enum: ["live", "test", "dry"] }, version: { type: ["integer", "null"] }, triggerNodeId: { type: "string" }, steps: { type: "integer" }, error: { type: ["string", "null"] }, failedNodeId: { type: ["string", "null"] }, createdAt: { type: "integer" }, finishedAt: { type: ["integer", "null"] } }, ["id", "status", "mode"]),
  WorkflowStep: loose({ id: { type: "string" }, nodeId: { type: "string" }, iteration: { type: "string" }, status: { type: "string" }, attempt: { type: "integer" }, port: { type: ["string", "null"] }, errorKind: { type: ["string", "null"] }, error: { type: ["string", "null"] }, input: {}, output: {} }, ["id", "nodeId", "status"]),
  WorkflowRunDetail: loose({ id: { type: "string" }, pageId: { type: "string" }, status: { type: "string" }, mode: { type: "string" }, graph: ref("WorkflowGraph"), runner: person, contentsVisible: { type: "boolean" }, timeline: { type: "array", items: ref("WorkflowStep") } }, ["id", "status", "timeline"]),
  WorkflowUnresolved: loose({ id: { type: "string" }, kind: { type: "string", enum: ["page", "database", "person", "chatHook", "address", "credential", "template", "tag", "field"] }, title: { type: "string" }, of: { type: "string" } }, ["id", "kind"]),
  WorkflowExport: loose(
    {
      format: { type: "string", const: "flowplan.workflow" },
      version: { type: "integer" },
      exportedAt: { type: "string" },
      source: { type: "object", additionalProperties: true },
      title: { type: "string" },
      graph: ref("WorkflowGraph"),
      references: { type: "object", additionalProperties: { type: "object", properties: { kind: { type: "string" }, title: { type: "string" } }, additionalProperties: true } },
    },
    ["format", "version", "graph"],
  ),
});
const okSchema = (): Json => ({ type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] });

for (const a of commandActions) {
  const name = commandSchemaName(a.action);
  schemas[name] = { ...jsonSchema(a.input), title: a.action, description: [a.summary, a.description].filter(Boolean).join(". ") };
  if (a.result) schemas[`${name}Result`] = jsonSchema(a.result);
}
schemas.Command = {
  description: "One action of the interface, as sent by POST /api/command.",
  oneOf: [...commandActions.map((a) => ref(commandSchemaName(a.action))), ref("CommandOther")],
};

// ---- Operations ----

type Param = { name: string; in: "path" | "query" | "header"; required?: boolean; description?: string; schema: Json };
type Op = {
  id: string;
  summary: string;
  description?: string;
  tag: string;
  params?: Param[];
  body?: { content: string; schema: Json; description?: string; required?: boolean };
  ok?: { status?: number; content?: string; schema?: Json; description: string };
  errors?: number[];
  security?: "token" | "none" | "metrics" | "device";
  write?: boolean;
};
const errorText: Record<number, string> = {
  400: "Invalid input (`details` lists the validation messages)",
  401: "No or invalid token",
  403: "Not allowed: no access, a read token on a write request, or an action tokens may not take",
  404: "Not found",
  409: "Conflict: the page is locked, the version is stale or a limit is reached",
  413: "Request too large",
  422: "The Idempotency-Key was already used for a different request",
  423: "Locked: the instance is read-only for an instance move, or has moved (the message names the new address)",
  415: "Unsupported file type",
  428: "Consent required: the workspace asks to confirm that everyone recorded agreed (`consent: true`)",
  429: "Too many requests; wait for `Retry-After` seconds (MCP) or try again later",
  501: "Not set up on this instance (e.g. no transcription service)",
  503: "Not healthy",
};
const p = (name: string, description: string, schema: Json = { type: "string", format: "uuid" }): Param => ({ name, in: "path", required: true, description, schema });
const q = (name: string, description: string, schema: Json = { type: "string" }, required = false): Param => ({ name, in: "query", required, description, schema });
const workspace = q("workspace", "Workspace ID", { type: "string", format: "uuid" }, true);
const noStore = "Answered with `Cache-Control: no-store`.";

const operations: { path: string; method: "get" | "post"; op: Op }[] = [
  // Instance
  { path: "/api/health", method: "get", op: { id: "health", tag: "Instance", summary: "Liveness and readiness", description: "No authentication: answers only `service` and `status` (200, or 503 when the database or the storage fails). The details (`checks`, backlogs, object storage, uptime) come with `FLOWPLAN_METRICS_TOKEN` as bearer token or for a signed-in instance administrator.", security: "none", ok: { schema: ref("Health"), description: "Healthy" }, errors: [503] } },
  { path: "/api/site-info", method: "get", op: { id: "siteInfo", tag: "Instance", summary: "Whether sign-up, the demo and SSO are open", security: "none", ok: { schema: ref("SiteInfo"), description: "Public facts" }, errors: [] } },
  { path: "/api/openapi.json", method: "get", op: { id: "openapi", tag: "Instance", summary: "This document", description: "Signed-in people and API tokens; public (`info.version` with the major version only for visitors) when the instance sets `FLOWPLAN_PUBLIC_API_DOCS=true`.", ok: { schema: { type: "object", additionalProperties: true }, description: "The OpenAPI document" }, errors: [401] } },
  { path: "/api/metrics", method: "get", op: { id: "metrics", tag: "Instance", summary: "Prometheus metrics", description: "Only with `FLOWPLAN_METRICS_TOKEN` set, sent as bearer token. 404 when metrics are off.", security: "metrics", ok: { content: "text/plain", description: "Prometheus text format" }, errors: [401, 404] } },
  // Workspace
  { path: "/api/bootstrap", method: "get", op: { id: "bootstrap", tag: "Workspace", summary: "Workspaces, spaces, pages and members", description: "Without `workspace` the first workspace. Start here to find IDs.", params: [q("workspace", "Workspace ID (default: the first)", { type: "string", format: "uuid" })], ok: { schema: ref("Bootstrap"), description: "The workspace" }, errors: [401, 404] } },
  { path: "/api/search", method: "get", op: { id: "search", tag: "Workspace", summary: "Full-text search", description: `Pages, records, comments and file contents of a workspace. In \`q\`, \`#tag\` (or \`#"two words"\`) keeps pages with that tag, \`-#tag\` leaves them out, and \`name:value\` compares a page property (text contains; select and multiselect equal an option; numbers and dates also \`>\`, \`<\`, \`>=\`, \`<=\`, \`a..b\`; checkboxes yes/no; people by name or \`me\`; \`name:*\` set, \`name:-\` empty). Tokens that name no tag or property are searched as words; with only tokens, the matching pages are listed by last change. Also \`OR\` (or \`|\`), \`AND\` (implicit), \`NOT\` or \`-\` before any term or group, parentheses (NOT binds tightest, then AND, then OR), \`created_by:\`/\`creator:\` and \`updated_by:\`/\`editor:\` (a name or \`me\`), \`created:\` and \`updated:\` (\`2026-03\`, \`>2026-01-01\`, \`a..b\`, \`-7d\`, \`-2w\`, \`-3m\`, \`-1y\`, \`today\`, \`yesterday\`, \`this-week\`, \`last-week\`, \`this-month\`, \`last-month\`, \`this-year\`, \`last-year\`), \`type:document|database|whiteboard|record\`, \`in:\"Space name\"\` and \`title:\`; such queries list the matching pages and records (without snippets) by last change. ${noStore}`, params: [workspace, q("q", "Search words", { type: "string" }, true), q("kind", "Only this kind", { type: "string", enum: ["all", "document", "database", "whiteboard", "row", "comment", "file"], default: "all" }), q("space", "Only in this space", { type: "string", format: "uuid" }), q("days", "0: leave out journal days (they are ranked after other pages otherwise)", { type: "string", enum: ["0", "1"] }), q("tz", "IANA time zone for relative dates such as created:today (default UTC)"), q("sort", "`relevance`: the best match – text relevance (exact and prefix title matches first) plus your own visits, recent edits and favourites; `edited`/`created`: newest first", { type: "string", enum: ["relevance", "edited", "created"], default: "relevance" })], ok: { schema: { type: "array", items: ref("SearchResult") }, description: "Matches" }, errors: [400, 401, 403] } },
  { path: "/api/search/recent", method: "get", op: { id: "searchRecent", tag: "Workspace", summary: "Your recently visited pages and records", description: `The pages and records you opened last in the workspace, newest first – what the quick search shows with nothing typed. Only your own visits (never other people's), only what you may still read; visits through API tokens are not recorded. ${noStore}`, params: [workspace, q("kind", "Only this kind", { type: "string", enum: ["all", "document", "database", "whiteboard", "row"], default: "all" }), q("space", "Only in this space", { type: "string", format: "uuid" }), q("limit", "At most this many (1–50)", { type: "integer", default: 20 })], ok: { schema: { type: "array", items: ref("RecentVisit") }, description: "Visited pages and records" }, errors: [400, 401, 403] } },
  { path: "/api/notifications", method: "get", op: { id: "notifications", tag: "Workspace", summary: "My newest notifications", description: "What the inbox shows, in short: the line in the reader's language (`Accept-Language` or the language cookie), the record title as `detail`, where it leads and whether push is switched on for its kind (`push`, false for a page that is gone or no longer readable). Without `since` the latest 20; with `since` (server time, e.g. a previous `createdAt`) up to 50 from that second on, newest first. `unread` counts every unread notification. The desktop app polls this instead of Web Push. Marked read with `notification.mark` or `notification.read` via POST /api/command.", params: [q("since", "Server time (ISO 8601 or milliseconds)")], ok: { schema: { type: "object", properties: { now: { type: "string", format: "date-time" }, unread: { type: "integer", minimum: 0 }, notifications: { type: "array", items: { type: "object", properties: { id: { type: "string" }, kind: { type: ["string", "null"] }, text: { type: "string" }, detail: { type: "string" }, url: { type: "string", description: "Path on this instance, e.g. `/#page=…`" }, createdAt: { type: "string", format: "date-time" }, read: { type: "boolean" }, push: { type: "boolean" } }, required: ["id", "kind", "text", "detail", "url", "createdAt", "read", "push"] } } }, required: ["now", "unread", "notifications"] }, description: "Notifications" }, errors: [400, 401] } },
  { path: "/api/tasks", method: "get", op: { id: "tasks", tag: "Workspace", summary: "My tasks", description: "Tasks in documents assigned to you, your own dated ones, those of your journals and of your own task page (`tasks`, command `task.add`), and yours in your other workspaces (`others`). `own` marks tasks of your own task page, `fresh` tasks given to you by others since you last opened My tasks (command `tasks.seen`). `personal` says which page is your own task page (null until the first task) and whether you may add tasks here.", params: [workspace, q("done", "`1` for completed tasks", { type: "string", enum: ["0", "1"] })], ok: { schema: { type: "object", properties: { tasks: { type: "array", items: ref("Task") }, others: { type: "array", items: ref("Task") }, personal: { type: "object", properties: { pageId: { type: ["string", "null"], format: "uuid" }, canAdd: { type: "boolean" } } } }, required: ["tasks", "others"] }, description: "Tasks" }, errors: [400, 401, 403] } },
  { path: "/api/records", method: "get", op: { id: "records", tag: "Workspace", summary: "Records across all databases", description: "With an optional filter (JSON, same shape as a view filter group) and the saved record views.", params: [workspace, q("filter", "Filter as JSON")], ok: { schema: { type: "object", additionalProperties: true }, description: "Records with their databases and views" }, errors: [400, 401, 403] } },
  { path: "/api/export", method: "get", op: { id: "exportWorkspace", tag: "Workspace", summary: "Whole workspace as JSON", description: "Every readable page outside the trash with its content; records only as far as you may see them.", params: [workspace], ok: { schema: ref("WorkspaceExport"), description: "The export (Content-Disposition: attachment)" }, errors: [401, 403] } },
  { path: "/api/offline/changes", method: "get", op: { id: "offlineChanges", tag: "Workspace", summary: "What changed for an offline copy", description: "Every page you may read now (outside the trash, no journal behind a PIN) and, since `since`, the pages and visible records whose content changed. Without `since` (or one older than the change log) `full` is true and every page counts as changed. Pass `now` as the next `since`.", params: [workspace, q("since", "Server time of the previous answer (ISO 8601 or milliseconds)")], ok: { schema: { type: "object", properties: { now: { type: "string", format: "date-time" }, full: { type: "boolean" }, pages: { type: "array", items: { type: "string", format: "uuid" } }, changed: { type: "array", items: { type: "string", format: "uuid" } }, rows: { type: "object", additionalProperties: { type: "array", items: { type: "string", format: "uuid" } } } }, required: ["now", "full", "pages", "changed", "rows"] }, description: "Readable and changed pages" }, errors: [400, 401, 403] } },
  { path: "/api/offline/assets", method: "get", op: { id: "offlineAssets", tag: "Workspace", summary: "The app's files for an offline copy", description: "Every file of the running client build under `/_next/static` (scripts, styles, fonts, workers) with its size, followed by the fonts (`/fonts.css`, `/fonts/*.woff2`) and icons the app's page loads from `public`, the build id and the version. A device that keeps an offline copy stores them in a cache named after the build, so parts of the app never opened online load offline as well – also in the iPhone and iPad app, which has no service worker to catch the fonts as they load.", ok: { schema: { type: "object", properties: { build: { type: "string" }, version: { type: "string" }, bytes: { type: "integer" }, files: { type: "array", items: { type: "object", properties: { path: { type: "string" }, size: { type: "integer" } }, required: ["path", "size"] } } }, required: ["build", "version", "bytes", "files"] }, description: "Files of the client build" }, errors: [401] } },
  { path: "/api/graph", method: "get", op: { id: "graph", tag: "Workspace", summary: "Links between pages as a graph", params: [workspace, q("days", "Journal days: left out, one node per journal and month, or each day", { type: "string", enum: ["hide", "month", "show"], default: "hide" })], ok: { schema: { type: "object", additionalProperties: true }, description: "Nodes and edges" }, errors: [400, 401, 403] } },
  { path: "/api/tags", method: "get", op: { id: "tags", tag: "Workspace", summary: "Tags and page properties of a workspace", description: `The tags (\`id\`, \`name\`, \`color\`, \`position\`, \`spaceId\` – null for the whole workspace, else the space it belongs to –, \`pages\`: how many readable pages carry it, \`records\`: how many readable database records carry it in a property with the tags as options) and the property definitions (\`id\`, \`name\`, \`type\`, \`options\`, \`spaceId\`). A space's own tags and properties are listed for those who may open that space (or see a page carrying them) and for workspace owners. Guests see only the tags and properties of pages and records shared with them. A page's own tags and values come with GET /api/pages/{id} as \`properties\` (\`tags\`: tag IDs, \`values\`: by property ID, \`info\`: created and changed at and by). ${noStore}`, params: [workspace], ok: { schema: { type: "object", additionalProperties: true }, description: "Tags and properties" }, errors: [400, 401, 403] } },
  { path: "/api/collections", method: "get", op: { id: "collections", tag: "Workspace", summary: "Collections of a workspace", description: `The person's own collections and those shared with the workspace (not for guests), in their order: \`id\`, \`name\`, \`icon\`, \`query\`, \`shared\`, \`mine\`, \`canEdit\`, \`ownerName\`. Change them with the command actions collection.*. ${noStore}`, params: [workspace], ok: { schema: { type: "array", items: { type: "object", additionalProperties: true } }, description: "Collections" }, errors: [400, 401, 403] } },
  { path: "/api/collections/{id}", method: "get", op: { id: "runCollection", tag: "Workspace", summary: "Run a collection", description: `The collection and its current results: \`items\` (pages and database records with \`pageId\`, \`rowId\`, \`type\`, \`title\`, \`icon\`, \`spaceId\`, \`database\`, \`tags\`, \`createdAt\`, \`updatedAt\`, \`createdBy\`, \`creatorName\`; latest change first, at most 500), \`total\`, \`truncated\` and \`encryptedLeftOut\` (end-to-end encrypted spaces the reader may read are not searched). Results follow the reader's own permissions, also for collections shared by others. ${noStore}`, params: [p("id", "Collection ID"), q("tz", "IANA time zone for relative dates (default UTC)")], ok: { schema: { type: "object", additionalProperties: true }, description: "The collection with its results" }, errors: [400, 401, 403, 404] } },
  { path: "/api/collections/preview", method: "get", op: { id: "previewCollection", tag: "Workspace", summary: "Results of a query", description: `Like GET /api/collections/{id} for a query that is not saved: \`query\` (its canonical form) and the first 50 results. ${noStore}`, params: [workspace, q("q", "The query", { type: "string" }, true), q("tz", "IANA time zone for relative dates (default UTC)")], ok: { schema: { type: "object", additionalProperties: true }, description: "Canonical query and results" }, errors: [400, 401, 403] } },
  { path: "/api/tags/{id}", method: "get", op: { id: "tagPages", tag: "Workspace", summary: "Pages and records with a tag", description: `Like /api/tags, plus \`pages\`: the readable pages with this tag, and \`records\`: the readable database records carrying it in a property with the tags as options, latest change first. A tag is one id; with \`sameName=1\` also the tags of the same name in other spaces. ${noStore}`, params: [p("id", "Tag ID"), workspace, q("sameName", "1: also the same-named tags of other spaces", { type: "string", enum: ["0", "1"] })], ok: { schema: { type: "object", additionalProperties: true }, description: "Tags, properties and pages" }, errors: [400, 401, 403, 404] } },
  { path: "/api/related", method: "get", op: { id: "related", tag: "Workspace", summary: "Related pages, or pages with a similar title", description: `With \`page\` (and \`row\`): related pages and records (\`items\` with their \`reasons\`) – by meaning when semantic search is on for you, else by links, backlinks, shared links, tags and title. With \`workspace\` and \`title\`: existing pages, or records of \`database\`, with a similar title (duplicate hint). Only what you may read. ${noStore}`, params: [q("page", "Page or database ID", { type: "string", format: "uuid" }), q("row", "Record ID", { type: "string", format: "uuid" }), q("workspace", "Workspace ID (with title)", { type: "string", format: "uuid" }), q("title", "Title to compare"), q("database", "Only records of this database (with title)", { type: "string", format: "uuid" }), q("exclude", "Page to leave out (with title)", { type: "string", format: "uuid" }), q("excludeRow", "Record to leave out (with title)", { type: "string", format: "uuid" })], ok: { schema: { type: "object", additionalProperties: true }, description: "Items" }, errors: [400, 401, 403, 404] } },
  { path: "/api/templates", method: "get", op: { id: "templates", tag: "Workspace", summary: "Saved page templates of a workspace", params: [workspace], ok: { schema: { type: "array", items: { type: "object", additionalProperties: true } }, description: "Templates" }, errors: [401, 403] } },
  { path: "/api/media", method: "get", op: { id: "media", tag: "Workspace", summary: "Media library", description: "Files of the pages you may read, 60 per call.", params: [workspace, q("kind", "Only this kind", { type: "string", enum: ["all", "image", "video", "audio", "pdf", "other"], default: "all" }), q("q", "Name contains"), q("offset", "Paging offset", { type: "integer", minimum: 0 }), q("usage", "`unused`: only files no current content refers to", { type: "string", enum: ["all", "unused"], default: "all" })], ok: { schema: { type: "object", additionalProperties: true }, description: "Files with their pages, whether each is unused and may be deleted (`file.delete`), and the counts of unused files" }, errors: [401, 403] } },
  { path: "/api/citations", method: "get", op: { id: "citations", tag: "Workspace", summary: "Bibliography of a workspace", params: [workspace], ok: { schema: { type: "object", properties: { items: { type: "array", items: { type: "object", additionalProperties: true } } }, required: ["items"] }, description: "Items" }, errors: [400, 401, 403] } },
  { path: "/api/capture", method: "get", op: { id: "captureTargets", tag: "Workspace", summary: "Databases to capture into, and your default", params: [workspace], ok: { schema: { type: "object", additionalProperties: true }, description: "Targets" }, errors: [400, 401, 403] } },
  { path: "/api/capture/targets", method: "get", op: { id: "desktopCaptureTargets", tag: "Workspace", summary: "Where quick capture can save", description: `For the desktop app's quick capture: the inbox (null when none is set), every database and document you may add to and the journals you may write in (today's entry), with what the shorthand fills in a database and its record templates. Pages of end-to-end encrypted spaces are never targets (\`encryptedExcluded\` counts them). \`voice\`: the instance transcribes voice notes; \`suggest\`: AI suggestions on the server and/or the device. ${noStore}`, ok: { schema: { type: "object", properties: { inbox: { type: ["object", "null"] }, targets: { type: "array", items: { type: "object" } }, encryptedExcluded: { type: "integer" }, voice: { type: "boolean" }, suggest: { type: ["object", "null"] }, maxFiles: { type: "integer" }, maxUploadMb: { type: "number" } }, required: ["inbox", "targets"], additionalProperties: true }, description: "Targets" }, errors: [401, 403] } },
  { path: "/api/capture/preview", method: "post", op: { id: "capturePreview", tag: "Workspace", summary: "Quick capture shorthand as chips", description: "Reads a text like `Angebot schreiben morgen 15 Uhr #kunde @anna !hoch` (German, English, French) for a target: a due date with time, tags, a person and a priority – each mapped to a property the target database has, or left as text. Chip ids in `literal` stay text. Nothing is saved.", body: { content: "application/json", schema: { type: "object", properties: { targetId: { type: "string" }, text: { type: "string", maxLength: 20000 }, today: { type: "string", format: "date" }, literal: { type: "array", items: { type: "string" }, maxItems: 50 }, task: { type: "boolean" }, locale: { type: "string", enum: ["de", "en", "fr"] } }, required: ["text", "today"], additionalProperties: false }, required: true }, ok: { schema: { type: "object", properties: { title: { type: "string" }, text: { type: "string" }, chips: { type: "array", items: { type: "object" } } }, required: ["chips"], additionalProperties: true }, description: "Title, text and chips" }, errors: [400, 401, 403, 404, 409] } },
  { path: "/api/capture/save", method: "post", op: { id: "captureSave", tag: "Workspace", summary: "Save a quick capture", description: "JSON, or multipart/form-data with the fields and up to 10 `file` parts (images, PDFs, Markdown or text files – their text –, a voice note with `transcribe`). The shorthand is read again (`parse`, `literal`) with the capturing computer's `today` and `timeZone`. Into a database as a record (properties from the shorthand, `templateId` for a record template, accepted AI values in `cells`), appended to a page, or to today's journal entry (a journal's id). Send an `Idempotency-Key`: a retry saves nothing twice.", write: true, body: { content: "application/json", schema: { type: "object", properties: { targetId: { type: "string" }, text: { type: "string", maxLength: 20000 }, parse: { type: "boolean" }, literal: { type: "array", items: { type: "string" } }, task: { type: "boolean" }, today: { type: "string", format: "date" }, timeZone: { type: "string" }, locale: { type: "string", enum: ["de", "en", "fr"] }, url: { type: "string", maxLength: 2000 }, linkTitle: { type: "string" }, linkDescription: { type: "string" }, linkProvider: { type: "string" }, linkImage: { type: "string" }, templateId: { type: "string" }, transcribe: { type: "boolean" }, cells: { type: "object", additionalProperties: true } }, required: ["today"], additionalProperties: false }, required: true }, ok: { schema: { type: "object", properties: { ok: { type: "boolean" }, kind: { type: "string", enum: ["record", "append"] }, pageId: { type: "string" }, rowId: { type: "string" }, url: { type: "string" }, title: { type: "string" }, undo: { type: "object" }, files: { type: "array", items: { type: "string" } } }, required: ["ok", "kind", "pageId", "url"], additionalProperties: true }, description: "Where it was saved" }, errors: [400, 401, 403, 404, 409, 413, 422, 423] } },
  { path: "/api/capture/undo", method: "post", op: { id: "captureUndo", tag: "Workspace", summary: "Take a quick capture back", description: "A captured record goes to the trash (your own only); appended blocks are removed while they are still the last ones, unchanged (`undo` from the save's answer).", write: true, body: { content: "application/json", schema: { type: "object", properties: { kind: { type: "string", enum: ["record", "append"] }, pageId: { type: "string", format: "uuid" }, rowId: { type: "string", format: "uuid" }, blocks: { type: "integer" }, digest: { type: "string" } }, required: ["kind", "pageId"] }, required: true }, ok: { schema: { type: "object", properties: { undone: { type: "boolean" }, reason: { type: "string" } }, required: ["undone"] }, description: "Whether it was taken back" }, errors: [400, 401, 403, 404, 409] } },
  { path: "/api/synced", method: "get", op: { id: "syncedBlocks", tag: "Workspace", summary: "Synced blocks of a workspace", params: [workspace], ok: { schema: { type: "object", properties: { blocks: { type: "array", items: { type: "object", additionalProperties: true } } }, required: ["blocks"] }, description: "Blocks" }, errors: [400, 401, 403] } },
  { path: "/api/trash/summary", method: "get", op: { id: "trashSummary", tag: "Workspace", summary: "What emptying the trash would delete", params: [workspace], ok: { schema: { type: "object", properties: { pages: { type: "integer" }, spaces: { type: "integer" }, records: { type: "integer" }, files: { type: "integer" }, days: { type: "integer", description: "Days items stay in the trash before they are deleted permanently (0 = never)" } }, required: ["pages", "spaces", "records", "days"] }, description: "Counts of pages, spaces, records and files the caller may delete permanently (`trash.empty`)" }, errors: [400, 401, 403] } },
  { path: "/api/trash/files", method: "get", op: { id: "fileTrash", tag: "Workspace", summary: "Files in the trash", description: "Files the caller may restore (`file.restore`) or delete permanently (`file.purge`).", params: [workspace], ok: { schema: { type: "array", items: { type: "object", additionalProperties: true } }, description: "Trashed files with their pages" }, errors: [400, 401, 403] } },
  { path: "/api/trash/rows", method: "get", op: { id: "rowTrash", tag: "Workspace", summary: "Records in the trash", params: [workspace], ok: { schema: { type: "array", items: { type: "object", additionalProperties: true } }, description: "Trashed records with their databases" }, errors: [400, 401, 403] } },
  { path: "/api/settings", method: "get", op: { id: "workspaceSettings", tag: "Workspace", summary: "Invitations, groups and grants of a workspace", description: "Owners only.", params: [workspace], ok: { schema: { type: "object", additionalProperties: true }, description: "Settings" }, errors: [401, 403] } },
  { path: "/api/command", method: "post", op: { id: "command", tag: "Workspace", summary: "Change something", description: "The same actions the interface sends: one JSON object with `action` and its fields. Write tokens only; `admin.*`, `token.*` and `ai.*` are refused for every token. Bodies up to 10 MB. Actions that send mail (`member.invite`, `page.share`) are limited to 40 per hour per person (429).", write: true, body: { content: "application/json", schema: ref("Command"), required: true }, ok: { schema: ref("CommandResult"), description: "The result of the action" }, errors: [400, 401, 403, 404, 409, 413, 429] } },
  // Pages
  { path: "/api/pages/{pageId}", method: "get", op: { id: "getPage", tag: "Pages", summary: "A page with its content", description: "Documents with their HTML, databases with properties, views and the records you may see (`rows`, with `preview` instead of the full document), whiteboards with their elements. The header `X-Flowplan-Visit: 1` records a visit (read receipts, and your own quick-search history; not for API tokens).", params: [p("pageId", "Page ID")], ok: { schema: ref("PageData"), description: "The page" }, errors: [401, 403, 404] } },
  { path: "/api/pages/{pageId}/blocks/{blockId}", method: "get", op: { id: "blockPreview", tag: "Pages", summary: "Preview of a block link", description: `What a pasted block link shows: the page's (or with \`row\` the record's) title and the start of the block's text, as \`Page › text\` (#88). A block link is the page address with the block: \`/#page=<page>&block=<blockId>\` (records: \`/#page=<database>&row=<record>&block=<blockId>\`). \`found\` is false for a block that no longer exists. End-to-end encrypted pages have no text on the server: \`encrypted\` is true and title and text stay empty. ${noStore}`, params: [p("pageId", "Page ID (the database for a record)"), p("blockId", "Block ID", { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$" }), q("row", "Record ID, for a block of a record's document", { type: "string", format: "uuid" })], ok: { schema: { type: "object", properties: { pageId: { type: "string", format: "uuid" }, rowId: { type: "string", format: "uuid" }, workspaceId: { type: "string", format: "uuid" }, blockId: { type: "string" }, title: { type: "string" }, text: { type: "string" }, found: { type: "boolean" }, encrypted: { type: "boolean" } }, required: ["pageId", "workspaceId", "blockId", "title", "text", "found", "encrypted"] }, description: "Title and text" }, errors: [400, 401, 403, 404] } },
  { path: "/api/blocks", method: "get", op: { id: "blockSearch", tag: "Workspace", summary: "Headings and blocks of documents", description: `For links to a block: headings and blocks of the documents a person may read whose text matches \`q\` (at least two characters). \`Page › Heading\` (or \`Page#Heading\`) lists the headings of the pages whose title matches the first part. A hit without \`blockId\` has no id yet; \`block.ids\` (POST /api/command with \`pageId\`, \`index\` and \`text\`) gives it one. ${noStore}`, params: [workspace, q("q", "Search words", { type: "string" }, true), q("exclude", "Leave out this page", { type: "string", format: "uuid" })], ok: { schema: { type: "array", items: { type: "object", properties: { pageId: { type: "string", format: "uuid" }, pageTitle: { type: "string" }, blockId: { type: ["string", "null"] }, index: { type: "integer", minimum: 0 }, text: { type: "string" }, level: { type: ["integer", "null"], description: "Heading level, null for other blocks" } }, required: ["pageId", "pageTitle", "blockId", "index", "text", "level"] } }, description: "Matches" }, errors: [400, 401, 403] } },
  { path: "/api/link-targets", method: "get", op: { id: "linkTargets", tag: "Pages", summary: "Icons of linked pages and records", description: `For links in documents: the icon (emoji, \`icon:<name>:<colour>\`, \`/api/files/<id>\` or empty for the default) and kind of each page (\`<pageId>\`) or record (\`<pageId>:<rowId>\`) the caller may read; others are left out. At most 100 IDs. ${noStore}`, params: [q("ids", "Comma-separated `<pageId>` or `<pageId>:<rowId>`", { type: "string" }, true)], ok: { schema: { type: "object", properties: { targets: { type: "object", additionalProperties: { type: "object", properties: { icon: { type: "string" }, kind: { type: "string" } } } } } }, description: "Icon and kind by ID" }, errors: [401] } },
  { path: "/api/pages/{pageId}/recordings", method: "get", op: { id: "notebookRecordings", tag: "Pages", summary: "Audio recordings of a notebook", description: `The recordings (\`fileId\` is served by GET /api/files/{fileId} with range requests), whether you may add some, the storage left for them (\`room\`, bytes; null: no limit) and the limits (three hours, size, chunk size). With \`upload\`: how much of an unfinished upload the server has. Ink written during a recording carries \`rec: {id, t}\` (lib/ink/README.md). Journals behind a PIN: 423 until unlocked. ${noStore}`, params: [p("pageId", "Page ID of the notebook"), q("upload", "Recording ID of an upload in progress", { type: "string", format: "uuid" })], ok: { schema: { type: "object", additionalProperties: true }, description: "Recordings, or the upload's size" }, errors: [400, 401, 403, 404, 423] } },
  { path: "/api/pages/{pageId}/recordings", method: "post", op: { id: "notebookRecordingAction", tag: "Pages", summary: "Upload, finish, rename or delete a notebook recording", description: "Upload: `?upload=<recording id>&offset=<bytes the server has>&type=<audio/webm|audio/ogg|audio/mp4>` with the raw bytes as `application/octet-stream` (at most 4 MiB per request; a repeated chunk is ignored, a gap answers 409). Then JSON `{action: \"finish\", recId, name, durationMs}` stores it as a file of the notebook (counted against the quota; at most three hours; 413 when too long, too large for its length or over the quota; 415 for other content). Also `{action: \"rename\", recId, name}`, `{action: \"delete\", recId}` (into the trash with its file) and `{action: \"discard\", recId}` (drops an unfinished upload). Needs editor rights; not on locked pages or in encrypted spaces.", write: true, params: [p("pageId", "Page ID of the notebook")], body: { content: "application/json", schema: { type: "object", properties: { action: { type: "string", enum: ["finish", "rename", "delete", "discard"] }, recId: { type: "string", format: "uuid" }, name: { type: "string", maxLength: 120 }, durationMs: { type: "integer", minimum: 0 } }, required: ["action", "recId"] }, required: true }, ok: { schema: { type: "object", additionalProperties: true }, description: "The recording, the upload's size, or ok" }, errors: [400, 401, 403, 404, 409, 413, 415, 423] } },
  { path: "/api/pages/{pageId}/preview", method: "get", op: { id: "pagePreview", tag: "Pages", summary: "Short preview of a page", description: noStore, params: [p("pageId", "Page ID")], ok: { schema: { type: "object", additionalProperties: true }, description: "Title, icon and the first lines" }, errors: [401, 403, 404] } },
  { path: "/api/pages/{pageId}/shares", method: "get", op: { id: "pageShares", tag: "Pages", summary: "Who has access to exactly this page", params: [p("pageId", "Page ID")], ok: { schema: { type: "object", additionalProperties: true }, description: "People, groups and links" }, errors: [401, 403, 404] } },
  { path: "/api/pages/{pageId}/unlinked", method: "get", op: { id: "unlinkedMentions", tag: "Pages", summary: "Texts naming this page without a link", params: [p("pageId", "Page ID")], ok: { schema: { type: "object", properties: { mentions: { type: "array", items: { type: "object", additionalProperties: true } } }, required: ["mentions"] }, description: "Mentions" }, errors: [401, 403, 404] } },
  { path: "/api/pages/{pageId}/snapshots/{snapshotId}/changes", method: "get", op: { id: "snapshotChanges", tag: "Pages", summary: "What a version changed", params: [p("pageId", "Page ID"), p("snapshotId", "Version ID"), q("against", "Compare with this version instead of the current content", { type: "string", format: "uuid" })], ok: { schema: { type: "object", additionalProperties: true }, description: "The differences" }, errors: [401, 403, 404] } },
  { path: "/api/pages/{pageId}/linked/{databaseId}", method: "get", op: { id: "linkedDatabase", tag: "Pages", summary: "A database embedded in a page (linked view)", params: [p("pageId", "Page ID"), p("databaseId", "Page ID of the database")], ok: { schema: { type: "object", additionalProperties: true }, description: "Database and rows" }, errors: [401, 403, 404] } },
  { path: "/api/pages/{pageId}/import-markdown", method: "post", op: { id: "importMarkdownRecords", tag: "Pages", summary: "Markdown files as records of a database", description: "One or more `.md` files or a ZIP (100 MB together); frontmatter becomes properties. `dryRun=1` only reports what would change.", write: true, params: [p("pageId", "Page ID of the database")], body: { content: "multipart/form-data", schema: { type: "object", properties: { file: { type: "array", items: { type: "string", format: "binary" } }, dryRun: { type: "string", enum: ["0", "1"] }, createMissing: { type: "string", enum: ["0", "1"], description: "Add properties the files use" }, updateExisting: { type: "string", enum: ["0", "1"], description: "Update records with the same ID" } }, required: ["file"] }, required: true }, ok: { schema: { type: "object", additionalProperties: true }, description: "What was (or would be) imported" }, errors: [400, 401, 403, 404, 413] } },
  // Records
  { path: "/api/pages/{pageId}/rows/{rowId}", method: "get", op: { id: "getRow", tag: "Records", summary: "A record with its document", description: "The header `X-Flowplan-Visit: 1` records the opening in your own quick-search history (not for API tokens).", params: [p("pageId", "Page ID of the database"), p("rowId", "Record ID")], ok: { schema: ref("RowDocument"), description: "The record" }, errors: [401, 403, 404] } },
  { path: "/api/pages/{pageId}/rows/{rowId}/backlinks", method: "get", op: { id: "rowBacklinks", tag: "Records", summary: "Records relating to this one", params: [p("pageId", "Page ID of the database"), p("rowId", "Record ID")], ok: { schema: { type: "object", additionalProperties: true }, description: "Backlinks by database" }, errors: [401, 403, 404] } },
  { path: "/api/pages/{pageId}/rows/{rowId}/unlinked", method: "get", op: { id: "rowUnlinkedMentions", tag: "Records", summary: "Texts naming this record without a link", params: [p("pageId", "Page ID of the database"), p("rowId", "Record ID")], ok: { schema: { type: "object", properties: { mentions: { type: "array", items: { type: "object", additionalProperties: true } } }, required: ["mentions"] }, description: "Mentions" }, errors: [401, 403, 404] } },
  { path: "/api/pages/{pageId}/rows/{rowId}/snapshots/{snapshotId}/changes", method: "get", op: { id: "rowSnapshotChanges", tag: "Records", summary: "What a version of a record changed", params: [p("pageId", "Page ID of the database"), p("rowId", "Record ID"), p("snapshotId", "Version ID"), q("against", "Compare with this version instead", { type: "string", format: "uuid" })], ok: { schema: { type: "object", additionalProperties: true }, description: "The differences" }, errors: [401, 403, 404] } },
  { path: "/api/threads", method: "get", op: { id: "threads", tag: "Records", summary: "Inline comment threads of a page or record", params: [q("page", "Page ID", { type: "string", format: "uuid" }, true), q("row", "Record ID", { type: "string", format: "uuid" }), q("thread", "Only this thread", { type: "string", format: "uuid" })], ok: { schema: { type: "object", additionalProperties: true }, description: "Threads" }, errors: [400, 401, 403, 404] } },
  { path: "/api/document-authors", method: "get", op: { id: "documentAuthors", tag: "Pages", summary: "Who wrote what in a document", params: [q("page", "Page ID", { type: "string", format: "uuid" }, true), q("row", "Record ID", { type: "string", format: "uuid" })], ok: { schema: { type: "object", additionalProperties: true }, description: "Authors" }, errors: [400, 401, 403, 404] } },
  { path: "/api/time-entries", method: "get", op: { id: "timeEntries", tag: "Records", summary: "Time worked on a record", params: [q("page", "Page ID", { type: "string", format: "uuid" }, true), q("row", "Record ID", { type: "string", format: "uuid" }, true), q("field", "ID of the time property", { type: "string" }, true)], ok: { schema: { type: "object", additionalProperties: true }, description: "Entries" }, errors: [400, 401, 403, 404] } },
  { path: "/api/time-report", method: "get", op: { id: "timeReport", tag: "Records", summary: "Time report of a database", params: [q("page", "Page ID", { type: "string", format: "uuid" }, true), q("weeks", "1 to 26, default 8", { type: "integer", minimum: 1, maximum: 26 })], ok: { schema: { type: "object", additionalProperties: true }, description: "Hours per week and person" }, errors: [400, 401, 403, 404] } },
  { path: "/api/time-reports", method: "get", op: { id: "timeReports", tag: "Records", summary: "Time report of a database or a workspace", description: "Your own entries and those of records you may read (field permissions apply). Periods use the server's time zone, weeks start on Monday. `format=csv` returns comma-separated values, `format=excel` semicolons, decimal commas and a byte order mark. Amounts only for workspace members with edit rights. " + noStore, params: [q("page", "Page ID of a database (or `workspace`)", { type: "string", format: "uuid" }), q("workspace", "Workspace ID (or `page`)", { type: "string", format: "uuid" }), q("period", "Period", { type: "string", enum: ["this-week", "this-month", "last-month", "custom"], default: "this-month" }), q("from", "First day for `custom` (YYYY-MM-DD)", { type: "string", format: "date" }), q("to", "Last day for `custom` (YYYY-MM-DD)", { type: "string", format: "date" }), q("person", "Only this person", { type: "string", format: "uuid" }), q("database", "Only this database", { type: "string", format: "uuid" }), q("project", "Only this related record, or `none`"), q("status", "Billing status", { type: "string", enum: ["open", "billed", "unbillable"] }), q("billable", "Billable (`yes`: open or billed) or not", { type: "string", enum: ["yes", "no"] }), q("group", "Grouping", { type: "string", enum: ["person", "project", "record", "database", "day", "week"], default: "person" }), q("format", "Answer format", { type: "string", enum: ["json", "csv", "excel"], default: "json" })], ok: { schema: { type: "object", additionalProperties: true }, description: "Totals, groups and entries (or a CSV file)" }, errors: [400, 401, 403, 404] } },
  { path: "/api/time-reports", method: "post", op: { id: "timeReportAction", tag: "Records", summary: "Billing status of time entries, hourly rates and currency", description: "`{ action: \"billing\", status: open|billed|unbillable, ids, workspace }` or with `filter` (the GET parameters) for the whole filtered set – marking it billed leaves entries that are not billable as they are. Needs edit rights on the record and its time property; audit-logged. `{ action: \"rate\", workspace, kind: person|project, targetId, rate | null }` and `{ action: \"currency\", workspace, currency }` are for workspace owners.", write: true, body: { content: "application/json", schema: { type: "object", properties: { action: { type: "string", enum: ["billing", "rate", "currency"] }, status: { type: "string", enum: ["open", "billed", "unbillable"] }, ids: { type: "array", items: { type: "string", format: "uuid" } }, filter: { type: "object", additionalProperties: true }, workspace: { type: "string", format: "uuid" }, kind: { type: "string", enum: ["person", "project"] }, targetId: { type: "string", format: "uuid" }, rate: { type: ["number", "null"] }, currency: { type: "string", pattern: "^[A-Z]{3}$" } }, required: ["action"], additionalProperties: false }, required: true }, ok: { schema: { type: "object", additionalProperties: true }, description: "`{ changed, skipped }`, the rates or the currency" }, errors: [400, 401, 403, 404, 413] } },
  { path: "/api/banners", method: "get", op: { id: "listBanners", tag: "Workspace", summary: "Banners of the administration for the signed-in person", description: "Banners each person sees until they close them (Administration → Maintenance & notices). Not with API tokens: the answer is empty. " + noStore, ok: { schema: { type: "object", properties: { banners: { type: "array", items: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, message: { type: "string" }, linkUrl: { type: ["string", "null"] }, linkLabel: { type: ["string", "null"] }, tone: { type: "string", enum: ["info", "promo", "success", "warning"] }, surface: { type: "string", enum: ["everywhere", "browser"] } } } } }, required: ["banners"] }, description: "The banners" }, errors: [401] } },
  { path: "/api/maintenance", method: "get", op: { id: "maintenanceNotice", tag: "Workspace", summary: "Scheduled maintenance announced by the administration", description: "`notice` is null when none is announced or it has ended. " + noStore, ok: { schema: { type: "object", properties: { notice: { type: ["object", "null"], properties: { message: { type: "string" }, start: { type: "integer", description: "Unix time in ms" }, end: { type: "integer", description: "Unix time in ms" } } }, move: { type: "object", description: "Instance move: read-only (changes are refused with 423) and, once moved, the new address", properties: { readOnly: { type: "boolean" }, movedTo: { type: ["string", "null"] }, redirect: { type: "boolean" } } } }, required: ["notice"] }, description: "The notice" }, errors: [401] } },
  { path: "/api/sprint-charts", method: "get", op: { id: "sprintCharts", tag: "Records", summary: "Burndown of a sprint", params: [q("page", "Page ID", { type: "string", format: "uuid" }, true), q("sprint", "Sprint ID", { type: "string" }, true)], ok: { schema: { type: "object", additionalProperties: true }, description: "Chart data" }, errors: [400, 401, 403, 404] } },
  { path: "/api/ticket-refs", method: "get", op: { id: "ticketPrefixes", tag: "Records", summary: "Ticket prefixes (WEB-123) readable in the workspace of a page", params: [q("page", "Page ID", { type: "string", format: "uuid" }, true)], ok: { schema: { type: "array", items: { type: "object", additionalProperties: true } }, description: "Prefixes" }, errors: [400, 401, 403, 404] } },
  { path: "/api/ticket-ref", method: "get", op: { id: "ticketByKey", tag: "Records", summary: "The record behind a ticket number", params: [q("page", "Page ID (names the workspace)", { type: "string", format: "uuid" }, true), q("key", "e.g. WEB-123", { type: "string" }, true)], ok: { schema: { type: "object", additionalProperties: true }, description: "The record" }, errors: [400, 401, 403, 404] } },
  { path: "/api/ticket-thread", method: "get", op: { id: "ticketThread", tag: "Records", summary: "Customer conversation of a service desk record", params: [q("page", "Page ID", { type: "string", format: "uuid" }, true), q("row", "Record ID", { type: "string", format: "uuid" }, true)], ok: { schema: { type: "object", additionalProperties: true }, description: "Messages" }, errors: [400, 401, 403, 404] } },
  { path: "/api/transfer-targets", method: "get", op: { id: "transferTargets", tag: "Records", summary: "Databases a record can move to", params: [q("page", "Page ID", { type: "string", format: "uuid" }, true)], ok: { schema: { type: "object", additionalProperties: true }, description: "Targets" }, errors: [400, 401, 403, 404] } },
  { path: "/api/dashboard-metric", method: "get", op: { id: "dashboardMetric", tag: "Records", summary: "One number from a database", params: [q("source", "Page ID of the database", { type: "string", format: "uuid" }, true), q("view", "View ID (its filters)"), q("aggregate", "How to combine", { type: "string", enum: ["count", "sum", "average", "min", "max"], default: "count" }), q("field", "Property ID for sum, average, min, max")], ok: { schema: { type: "object", additionalProperties: true }, description: "The value" }, errors: [400, 401, 403, 404] } },
  { path: "/api/dashboard-sources", method: "get", op: { id: "dashboardSources", tag: "Records", summary: "Databases a dashboard may count", params: [q("page", "Page ID of the dashboard", { type: "string", format: "uuid" }, true)], ok: { schema: { type: "object", additionalProperties: true }, description: "Sources" }, errors: [400, 401, 403, 404] } },
  { path: "/api/git-config", method: "get", op: { id: "gitConfig", tag: "Records", summary: "Git integration of a database", params: [q("page", "Page ID", { type: "string", format: "uuid" }, true)], ok: { schema: { type: "object", additionalProperties: true }, description: "Settings" }, errors: [400, 401, 403, 404] } },
  { path: "/api/git-links", method: "get", op: { id: "gitLinks", tag: "Records", summary: "Branches and pull requests linked to a record", params: [q("page", "Page ID", { type: "string", format: "uuid" }, true), q("row", "Record ID", { type: "string", format: "uuid" }, true)], ok: { schema: { type: "object", additionalProperties: true }, description: "Links" }, errors: [400, 401, 403, 404] } },
  { path: "/api/whiteboards/{pageId}/cards", method: "get", op: { id: "whiteboardCards", tag: "Pages", summary: "Live data of records shown as cards on a whiteboard", params: [p("pageId", "Page ID of the whiteboard"), q("rows", "Comma-separated `pageId:rowId` pairs, at most 200", { type: "string" }, true)], ok: { schema: { type: "object", additionalProperties: true }, description: "Cards" }, errors: [400, 401, 403, 404] } },
  // Meeting notes (#199): the /meet block, its recording, transcript and summary
  { path: "/api/meetings", method: "post", op: { id: "createMeeting", tag: "Meetings", summary: "Create a meeting note from audio or a transcript", description: "Creates a meeting block (title, date, attendees, summary, agenda, transcript) at the end of the document `pageId`, or a new record in the database `databaseId` with the block as its document (its date, attendees (person), duration (number, minutes) and status properties are filled when present). `audio` is one file with everyone; `me` and `others` are the microphone and the call as separate tracks (with loudspeakers, echoes of the call in `me` are dropped). M4A, MP3, WAV, AAC, OGG and WebM; each track at most WHISPER_MAX_MB (default 200 MB). Alternatively `transcript` as text (one passage per line, optionally `Name: text`). Transcription (the instance's Whisper service) and the summary (the instance's AI: action items with owner and due date as tasks – owners who are members become mentions and see them in My tasks –, topics and open points, each with numbered citations of transcript segments; at least one minute of audio) run in the background: answers 202 with the meeting's id; poll `statusUrl`. Needs a write token with the permission “AI and transcription”; `consent: true` when the workspace requires consent (428 otherwise). The audio is deleted after the transcript unless the workspace keeps it.", write: true, body: { content: "multipart/form-data", schema: { type: "object", properties: { pageId: { type: "string", format: "uuid" }, databaseId: { type: "string", format: "uuid" }, title: { type: "string", maxLength: 300 }, date: { type: "string", format: "date" }, attendees: { type: "string", description: "JSON array or comma-separated names or e-mail addresses" }, instructions: { type: "string", enum: ["auto", "status", "oneonone", "workshop", "customer", "custom"] }, prompt: { type: "string", maxLength: 4000 }, audio: { type: "string", format: "binary" }, me: { type: "string", format: "binary" }, others: { type: "string", format: "binary" }, transcript: { type: "string" }, consent: { type: "boolean" }, language: { type: "string", enum: ["de", "en", "fr", "zh"] } } }, required: true }, ok: { status: 202, schema: { type: "object", properties: { id: { type: "string", format: "uuid" }, pageId: { type: "string" }, rowId: { type: ["string", "null"] }, status: { type: "string" }, statusUrl: { type: "string" } }, required: ["id", "status", "statusUrl"] }, description: "The meeting, processing in the background" }, errors: [400, 401, 403, 404, 409, 413, 415, 428, 501] } },
  { path: "/api/meetings/{meetingId}", method: "get", op: { id: "getMeeting", tag: "Meetings", summary: "Status of a meeting note", description: "`status`: new, recording, transcribing, summarizing, done or failed (`error` says why; `done` with an `error` means the transcript is there but no summary; `errorDetail` – for instance administrators only – what went wrong, e.g. a timeout or the transcription service's answer). With `content=1` also `title`, `summary` and `agenda` (the participants' notes) as Markdown and the `transcript` segments (time in seconds, speaker, track `me`/`others`/`mixed`, session, `hallucination`: no speech – silence phrases or repetitions the recogniser made up, left out of the summary –, `edited`: corrected by a person). Needs read access to the page; kept audio is listed as file URLs. " + noStore, params: [p("meetingId", "Meeting ID"), q("content", "1: with summary, agenda and transcript")], ok: { schema: { type: "object", additionalProperties: true }, description: "The meeting" }, errors: [401, 403, 404] } },
  { path: "/api/meetings/{meetingId}/summarize", method: "post", op: { id: "regenerateMeetingSummary", tag: "Meetings", summary: "Write the summary again", description: "With other instructions, without transcribing again. Needs edit rights and “AI and transcription” for tokens.", write: true, params: [p("meetingId", "Meeting ID")], body: { content: "application/json", schema: { type: "object", properties: { instructions: { type: "string", enum: ["auto", "status", "oneonone", "workshop", "customer", "custom"] }, prompt: { type: "string", maxLength: 4000 } } }, required: false }, ok: { schema: { type: "object", additionalProperties: true }, description: "The meeting" }, errors: [400, 401, 403, 404, 409] } },
  { path: "/api/meetings/{meetingId}/retranscribe", method: "post", op: { id: "retranscribeMeeting", tag: "Meetings", summary: "Transcribe the kept audio again", description: "For sessions whose audio the workspace keeps: transcribes it again (e.g. with a better glossary or model) and writes the summary anew; the earlier summary stays in the page's versions. Transcript passages people corrected stay and new segments at their time are left out, unless `force: true`. `dryRun: true` changes nothing and only answers how many corrected passages there are (`edited`). Answers the meeting with `edited`, `keepsEdited` and `started`; poll the status. 409 when no audio is kept or the meeting is being processed. Needs edit rights and “AI and transcription” for tokens.", write: true, params: [p("meetingId", "Meeting ID")], body: { content: "application/json", schema: { type: "object", properties: { force: { type: "boolean", description: "Replace corrected passages too" }, dryRun: { type: "boolean", description: "Only count the corrected passages" }, language: { type: "string", enum: ["de", "en", "fr", "zh"] } } }, required: false }, ok: { schema: { type: "object", properties: { edited: { type: "integer" }, keepsEdited: { type: "boolean" }, started: { type: "boolean" } }, additionalProperties: true }, description: "The meeting" }, errors: [400, 401, 403, 404, 409, 501] } },
  { path: "/api/meetings/{meetingId}/ask", method: "post", op: { id: "askMeeting", tag: "Meetings", summary: "Ask a question about one meeting", description: "Answered from the meeting's transcript and agenda only, as a text stream; `[S12]` names the transcript segment (header `X-Flowplan-Segments`: base64 JSON list of segment ids, S1 first).", write: true, params: [p("meetingId", "Meeting ID")], body: { content: "application/json", schema: { type: "object", properties: { question: { type: "string", maxLength: 2000 } }, required: ["question"] }, required: true }, ok: { content: "text/plain", description: "The answer" }, errors: [400, 401, 403, 404, 409, 429] } },
  // Journal
  { path: "/api/journals/{journalId}/review", method: "get", op: { id: "journalReview", tag: "Journal", summary: "Review of a period", params: [p("journalId", "Page ID of the journal"), q("from", "YYYY-MM-DD", { type: "string", format: "date" }, true), q("to", "YYYY-MM-DD", { type: "string", format: "date" }, true)], ok: { schema: { type: "object", additionalProperties: true }, description: "Days, trackers and entries" }, errors: [400, 401, 403, 404] } },
  { path: "/api/journals/{dayId}/events", method: "get", op: { id: "journalEvents", tag: "Journal", summary: "Appointments of a journal day", params: [p("dayId", "Page ID of the day page"), q("zone", "IANA time zone, default UTC")], ok: { schema: { type: "object", additionalProperties: true }, description: "Events" }, errors: [400, 401, 403, 404] } },
  { path: "/api/journals/{dayId}/completed", method: "get", op: { id: "journalCompleted", tag: "Journal", summary: "Records and tasks completed on a journal day", description: "Tasks ticked off in documents that day (`kind: \"task\"`; any page you may read, your own task page included, not the day page itself; while still done; with `mine=1` those you ticked off or that are given to you) and database records whose latest change to done (by their database's done rule) falls on the day in the given time zone and that are still done; only records the caller may read. With `mine=1` (\"Only mine\") only the caller's: records they made done themselves (an automation counts for the person who set it up) and records a person property assigns to them, whoever completed them; changes recorded before Flowplan knew who made them count only by the assignment. Without `mine` the caller's choice for the journal (command `journal.completedMine`), `1` until they made one. Empty when the journal switched the list off (option `completed`).", params: [p("dayId", "Page ID of the day page"), q("zone", "IANA time zone, default UTC"), q("mine", "1: only mine, 0: all; default: your choice for the journal, else 1", { type: "string", enum: ["0", "1"] })], ok: { schema: { type: "object", additionalProperties: true }, description: "items (kind record or task, pageId, rowId (\"\" for a task in a page), title (a task: its text), database (a task: its page title), icon, at in ms), more (how many beyond the first 100), mine (whether the list is only mine) and all (how many the list would have with mine=0)" }, errors: [400, 401, 403, 404, 423] } },
  // End-to-end encrypted spaces: ciphertext only
  { path: "/api/e2ee/identity", method: "get", op: { id: "e2eeIdentity", tag: "Encryption", summary: "My key pair as stored on the server", description: "The public key and the private key wrapped with the passphrase and with the recovery key (opaque to the server); null before setup.", ok: { schema: { type: "object", additionalProperties: true }, description: "Identity" }, errors: [401] } },
  { path: "/api/e2ee/spaces/{spaceId}", method: "get", op: { id: "e2eeSpaceKeys", tag: "Encryption", summary: "Sealed keys and key holders of an encrypted space", params: [p("spaceId", "Space ID")], ok: { schema: { type: "object", additionalProperties: true }, description: "Key version, my sealed keys, members holding the key" }, errors: [401, 403, 404] } },
  { path: "/api/e2ee/spaces/{spaceId}/archive", method: "get", op: { id: "e2eeArchive", tag: "Encryption", summary: "Encrypted archive of a space", description: "Every document as encrypted snapshot and updates, encrypted titles, my sealed space keys and my wrapped private key. Decryptable with the passphrase or the recovery key only.", params: [p("spaceId", "Space ID")], ok: { schema: { type: "object", additionalProperties: true }, description: "The archive (Content-Disposition: attachment)" }, errors: [401, 403, 404] } },
  { path: "/api/e2ee/pages/{pageId}/log", method: "get", op: { id: "e2eeLog", tag: "Encryption", summary: "Encrypted updates of a document", description: "The encrypted snapshot (when `after` is before it) and every encrypted update after `after`.", params: [p("pageId", "Page ID"), q("after", "Last sequence number already known", { type: "integer", minimum: 0 })], ok: { schema: { type: "object", additionalProperties: true }, description: "Snapshot and updates" }, errors: [400, 401, 403, 404] } },
  // Files
  { path: "/api/files/{fileId}", method: "get", op: { id: "getFile", tag: "Files", summary: "Download a file", description: "Needs read access to the page the file belongs to. Supports `Range` requests.", params: [p("fileId", "File ID")], ok: { content: "application/octet-stream", description: "The file with its own content type" }, errors: [401, 403, 404] } },
  { path: "/api/upload", method: "post", op: { id: "uploadFile", tag: "Files", summary: "Upload a file to a page", description: "The size limit is the person's upload limit (default 50 MB). Photos lose their location data. `purpose=cover` requires an image. Pages of encrypted spaces take only client-encrypted files with `purpose=e2ee`.", write: true, body: { content: "multipart/form-data", schema: { type: "object", properties: { pageId: { type: "string", format: "uuid" }, file: { type: "string", format: "binary" }, purpose: { type: "string", enum: ["cover", "e2ee"] } }, required: ["pageId", "file"] }, required: true }, ok: { schema: ref("FileInfo"), description: "The stored file" }, errors: [400, 401, 403, 404, 409, 413] } },
  { path: "/api/files/placeholders", method: "get", op: { id: "imagePlaceholders", tag: "Files", summary: "Placeholders of images", description: "Size and ThumbHash of uploaded images, for showing a blurred preview in the right proportions while the image loads. `ids` lists up to 100 file IDs and `avatar:<user ID>` entries. Only files you may download and profile pictures you may see are answered; anything else is left out, as are files without a placeholder. Placeholders of older files are computed on the first request.", params: [q("ids", "Comma-separated file IDs and `avatar:<user ID>` entries", { type: "string" }, true)], ok: { schema: { type: "object", properties: { placeholders: { type: "object", additionalProperties: ref("ImagePlaceholder") } }, required: ["placeholders"] }, description: "Placeholders by ID" }, errors: [400, 401] } },
  { path: "/api/notebook-library", method: "post", op: { id: "createNotebookTemplate", tag: "Files", summary: "Add an own paper template for notebooks", description: "Needs editor rights in the workspace of the notebook page `pageId` (not guests). `file` is a picture (PNG, JPEG, WebP) or a PDF; of a PDF only page `pdfPage` (default 1) is kept. `fit` is stretch (default) or tile. Checked like uploads (type from the content, no photo location) and counted against the workspace quota and the person's storage; at most 20 MB and 200 templates per workspace. Choose it for sheets with `paper.image = {template, fit?}` in notebook.paper, notebook.sheet.paper or notebook.sheet.add: the template is copied onto the page. Listed with notebook.templates, changed with notebook.template.update and notebook.template.delete.", write: true, body: { content: "multipart/form-data", schema: { type: "object", properties: { pageId: { type: "string", format: "uuid" }, file: { type: "string", format: "binary" }, name: { type: "string", maxLength: 120 }, fit: { type: "string", enum: ["stretch", "tile"] }, pdfPage: { type: "integer", minimum: 1 } }, required: ["pageId", "file"] }, required: true }, ok: { schema: { type: "object", additionalProperties: true }, description: "The new template" }, errors: [400, 401, 403, 404, 409, 413] } },
  { path: "/api/workspace-fonts", method: "post", op: { id: "uploadWorkspaceFont", tag: "Files", summary: "Upload a font for the workspace's appearance", description: "Needs the owner role in `workspaceId`. `file` is WOFF2, WOFF, TrueType or OpenType (checked by its content), at most 5 MB and 20 per workspace, counted against the workspace quota and the caller's storage. Choose it with `custom:<id>` in workspace.theme; delete it with workspace.font.delete.", write: true, body: { content: "multipart/form-data", schema: { type: "object", properties: { workspaceId: { type: "string", format: "uuid" }, file: { type: "string", format: "binary" }, name: { type: "string", maxLength: 60 } }, required: ["workspaceId", "file"] }, required: true }, ok: { schema: { type: "object", additionalProperties: true }, description: "The new font" }, errors: [400, 401, 403, 409, 413] } },
  { path: "/api/workspace-fonts/{fontId}", method: "get", op: { id: "workspaceFontFile", tag: "Files", summary: "A font uploaded for a workspace's appearance", description: "For members and guests of its workspace (publications and forms serve it under their own token).", params: [p("fontId", "Font ID")], ok: { content: "application/octet-stream", description: "The font file (font/woff2, font/woff, font/ttf or font/otf)" }, errors: [401, 404] } },
  { path: "/api/notebook-library/{assetId}", method: "get", op: { id: "notebookLibraryFile", tag: "Files", summary: "Picture of an own sticker or paper template", description: "Stickers only for the person they belong to, paper templates for members of their workspace.", params: [p("assetId", "Sticker or template ID")], ok: { content: "application/octet-stream", description: "The picture or PDF page" }, errors: [401, 403, 404] } },
  { path: "/api/avatars/{userId}", method: "get", op: { id: "avatar", tag: "Files", summary: "Profile picture of a person you share a workspace with", params: [p("userId", "User ID")], ok: { content: "image/*", description: "The picture" }, errors: [401, 404] } },
  // Import and export
  { path: "/api/export/docx", method: "get", op: { id: "exportDocx", tag: "Import and export", summary: "A page or record as a Word file", description: "Reads only, so read tokens may use it. `row` picks one record of the database `page`.", params: [q("page", "Page ID", { type: "string", format: "uuid" }, true), q("row", "Record ID (one record of the database)", { type: "string", format: "uuid" })], ok: { content: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", description: "The DOCX file (Content-Disposition: attachment)" }, errors: [400, 401, 403, 404, 413] } },
  { path: "/api/export/jira", method: "get", op: { id: "exportJira", tag: "Import and export", summary: "A page or record as Jira wiki markup", description: "Reads only, so read tokens may use it. `row` picks one record of the database `page`. One page without sub-pages, like the single Markdown file: headings `h1.`–`h6.`, `*bold*`, `_italic_`, `-strike-`, `+underline+`, `{{monospace}}`, `{code:language}`/`{noformat}`, `{quote}`, `*`/`#` lists, tasks as `[ ]`/`[x]`, tables, `[text|url]` links, `!url!` pictures, `{info}`/`{tip}`/`{note}`/`{warning}` callouts, `{panel}` toggles. Links and pictures keep absolute addresses of the instance.", params: [q("page", "Page ID", { type: "string", format: "uuid" }, true), q("row", "Record ID (one record of the database)", { type: "string", format: "uuid" })], ok: { content: "text/plain", description: "The markup as UTF-8 text (Content-Disposition: attachment, `.jira.txt`)" }, errors: [400, 401, 403, 404, 413] } },
  { path: "/api/export/confluence", method: "get", op: { id: "exportConfluence", tag: "Import and export", summary: "A page or record in Confluence's storage format", description: "Reads only, so read tokens may use it. `row` picks one record of the database `page`. One page without sub-pages, as Confluence storage-format XHTML (the body of a page for the REST API's `storage` representation or the source editor): code macro with language and CDATA body, info/tip/note/warning macros for callouts, expand for toggles, `<ac:task-list>` for tasks, `<ac:image><ri:url/></ac:image>` for pictures. Links and pictures keep absolute addresses of the instance.", params: [q("page", "Page ID", { type: "string", format: "uuid" }, true), q("row", "Record ID (one record of the database)", { type: "string", format: "uuid" })], ok: { content: "text/plain", description: "The XHTML as UTF-8 text (Content-Disposition: attachment, `.confluence.xhtml`)" }, errors: [400, 401, 403, 404, 413] } },
  { path: "/api/export/pdf", method: "get", op: { id: "exportPrintView", tag: "Import and export", summary: "A page with sub-pages or a whole space as one print view", description: "Reads only. Either `page` (with `children=1` its sub-pages) or `space`. Answers with an HTML print view (cover, table of contents, one chapter per page) that a browser turns into a PDF; at most 200 pages.", params: [q("page", "Page ID", { type: "string", format: "uuid" }), q("children", "`1` includes the sub-pages", { type: "string", enum: ["0", "1"] }), q("space", "Space ID", { type: "string", format: "uuid" })], ok: { content: "text/html", description: "The print view" }, errors: [400, 401, 403, 404, 413] } },
  { path: "/api/export/epub", method: "get", op: { id: "exportEpub", tag: "Import and export", summary: "A page tree or a whole space as an e-book", description: "Reads only. Either `page` (with `children=1` its sub-pages) or `space`; EPUB 3 with one chapter per page, at most 200 pages.", params: [q("page", "Page ID", { type: "string", format: "uuid" }), q("children", "`1` includes the sub-pages", { type: "string", enum: ["0", "1"] }), q("space", "Space ID", { type: "string", format: "uuid" })], ok: { content: "application/epub+zip", description: "The EPUB file (Content-Disposition: attachment)" }, errors: [400, 401, 403, 404, 413] } },
  { path: "/api/markdown-export", method: "post", op: { id: "markdownExport", tag: "Import and export", summary: "Export a page, record or space as Markdown", description: "Reads only, so read tokens may use it. `markdown` answers with one file, `zip` with an archive (files, sub-pages, history). Code blocks are fenced with their language id as in VS Code/Shiki (```typescript, ```python, ```terraform …); the Markdown import also understands older ids and aliases (js, ts, py, sh, yml). A block's options follow the language: ```ts {3-5} showLineNumbers startLine=10, view=preview|split|code, collapsed, collapsedLines=15.", body: { content: "application/json", schema: ref("MarkdownExportOptions"), required: true }, ok: { content: "application/octet-stream", description: "`text/markdown` or `application/zip` (Content-Disposition: attachment)" }, errors: [400, 401, 403, 404, 413] } },
  { path: "/api/backup", method: "get", op: { id: "exportBackup", tag: "Import and export", summary: "Workspace backup as ZIP", description: "Streams everything you may read, with files.", params: [workspace], ok: { content: "application/zip", description: "The archive" }, errors: [400, 401, 403] } },
  { path: "/api/backup", method: "post", op: { id: "importBackup", tag: "Import and export", summary: "Restore a workspace backup", description: "Write tokens of an editor. The body is the ZIP itself, up to 2 GB.", write: true, params: [workspace], body: { content: "application/zip", schema: { type: "string", format: "binary" }, required: true }, ok: { schema: { type: "object", additionalProperties: true }, description: "What was imported" }, errors: [400, 401, 403, 413] } },
  { path: "/api/import/zip", method: "post", op: { id: "importZip", tag: "Import and export", summary: "Import a ZIP of Markdown, HTML or Notion pages into a space", write: true, body: { content: "multipart/form-data", schema: { type: "object", properties: { workspaceId: { type: "string", format: "uuid" }, spaceId: { type: "string", format: "uuid" }, file: { type: "string", format: "binary", description: "Up to 100 MB" } }, required: ["workspaceId", "spaceId", "file"] }, required: true }, ok: { schema: { type: "object", additionalProperties: true }, description: "The pages created" }, errors: [400, 401, 403, 413] } },
  { path: "/api/import/source", method: "post", op: { id: "importSource", tag: "Import and export", summary: "Import from AFFiNE, Confluence, Evernote, Google Docs, GoodNotes, Microsoft Word or Obsidian", description: "AFFiNE workspace file (`.affine`) or snapshot ZIP, Confluence space export (HTML or XML ZIP), Evernote `.enex` (several in a ZIP), Google Takeout ZIP or a single `.html`/`.docx`, GoodNotes PDF export (or any PDF; several in a ZIP, folders become parent pages): each PDF becomes a notebook whose sheets have the PDF pages as background (at most 500 pages per PDF), Microsoft Word `.docx` (several in a ZIP, folders become parent pages), Obsidian vault ZIP. Older Word files (`.doc`), OneNote files (`.one`, `.onetoc2`, `.onepkg`) and GoodNotes files (`.goodnotes`) are refused with 400 and what to do instead (save as `.docx`; export from OneNote as a Word document; export from GoodNotes as PDF); inside a ZIP they are skipped and listed in `warnings`. `source` defaults to `auto` (recognised from the file). `mode=database` creates one new database (tags, dates, folder, source as properties) instead of a page tree. `dryRun=1` only answers with the preview (counts and warnings). As a form the file may be up to 100 MB. Larger AFFiNE workspace files (up to the import limit: the person's largest upload, at least 100 MB, or `FLOWPLAN_IMPORT_MAX_MB`) go as the raw request body (`Content-Type: application/octet-stream` with `Content-Length`) with the fields and `name` (the file name) as query parameters; the server streams it to disk. A raw dry run answers with `upload` (an id): the import then passes `upload=<id>` without a body instead of sending the file again, `upload=<id>&discard=1` drops it (otherwise it is deleted after six hours). ZIP-based exports stay within 100 MB. `background=1` answers at once with 202 and `job` (an id) and runs the preview or import afterwards, so a large file does not outlast a reverse proxy's timeout; `GET /api/import/source/job?id=<job>` then reports it. Only one such import per person runs at a time (409).", write: true, body: { content: "multipart/form-data", schema: { type: "object", properties: { workspaceId: { type: "string", format: "uuid" }, spaceId: { type: "string", format: "uuid" }, file: { type: "string", format: "binary", description: "Up to 100 MB" }, source: { type: "string", enum: ["auto", "affine", "confluence", "evernote", "gdocs", "goodnotes", "obsidian", "word"] }, mode: { type: "string", enum: ["pages", "database"] }, dryRun: { type: "string", enum: ["0", "1"] }, background: { type: "string", enum: ["0", "1"] } }, required: ["workspaceId", "spaceId", "file"] }, required: true }, ok: { schema: { type: "object", additionalProperties: true }, description: "Preview (source, title, pages, folders, files, bytes, tags, warnings; for GoodNotes also notebooks and sheets; for AFFiNE also whiteboards, databases, journalDays, collections, properties, icons, rowDocuments (documents made from database rows that become their record's content), templates and templateVisibility (documents AFFiNE marks as templates, saved as templates of the workspace – or only for the importing person when they may not create workspace templates); `tooMany` when the file brings more pages than the instance allows per import, `FLOWPLAN_IMPORT_MAX_DOCS`, default 10,000) or, without dryRun, also rootIds, rows and databaseId" }, errors: [400, 401, 403, 409, 413] } },
  { path: "/api/import/source/job", method: "get", op: { id: "importSourceJob", tag: "Import and export", summary: "State of an import started with background=1", description: "`status` is `running` (with `progress`, 0–1 or null), `done` (with `result`: the preview or the result the import would have answered) or `failed` (with `error` and `code`, the status the import would have answered). 410 when the job is unknown: started by someone else, interrupted by a restart of the server, or finished more than an hour ago.", params: [q("id", "The `job` of the import", { type: "string", format: "uuid" }, true)], ok: { schema: { type: "object", additionalProperties: true }, description: "The job's state" }, errors: [400, 401, 410] } },
  { path: "/api/import/tracker", method: "post", op: { id: "importTracker", tag: "Import and export", summary: "Jira (CSV) or Trello (JSON) into a new database", write: true, body: { content: "multipart/form-data", schema: { type: "object", properties: { workspaceId: { type: "string", format: "uuid" }, spaceId: { type: "string", format: "uuid" }, file: { type: "string", format: "binary", description: "Up to 30 MB" } }, required: ["workspaceId", "spaceId", "file"] }, required: true }, ok: { schema: { type: "object", additionalProperties: true }, description: "The database created" }, errors: [400, 401, 403, 413] } },
  { path: "/api/templates/import", method: "post", op: { id: "importTemplate", tag: "Import and export", summary: "Import a template archive", write: true, body: { content: "multipart/form-data", schema: { type: "object", properties: { workspaceId: { type: "string", format: "uuid" }, file: { type: "string", format: "binary", description: "`.flowplan-template.zip`, up to 100 MB" }, private: { type: "string", enum: ["true", "false"] } }, required: ["workspaceId", "file"] }, required: true }, ok: { schema: { type: "object", additionalProperties: true }, description: "The template" }, errors: [400, 401, 403, 413] } },
  { path: "/api/marketplace/draft", method: "get", op: { id: "marketplaceDraft", tag: "Import and export", summary: "What a marketplace package would carry", description: "Defaults for the publish dialog (title, category, minVersion) and notes on what stays on this instance. Checked like building the package: own document and database templates (creator or owner), workflows (editors), own whiteboard templates, the appearance and the link rules (owners); never guests. 404 when the marketplace is switched off (`FLOWPLAN_MARKETPLACE_URL=off` or Administration).", params: [q("kind", "What to publish", { type: "string", enum: ["document", "database", "workflow", "whiteboard", "appearance", "link-rules"] }, true), workspace, q("id", "Template, workflow page or whiteboard template (not for appearance and link-rules)", { type: "string", format: "uuid" })], ok: { schema: { type: "object", additionalProperties: true }, description: "kind, title, category, minVersion, notes, bytes" }, errors: [400, 401, 403, 404] } },
  { path: "/api/marketplace/package", method: "post", op: { id: "marketplacePackage", tag: "Import and export", summary: "Build a marketplace package (.flowplan-template)", description: "A ZIP in the `flowplan-marketplace-1` format: template.json, the kind's own exchange format under payload/ and up to four preview pictures (`preview`, PNG/JPEG/WebP, 1 MB each). Secrets, the instance address and names of people are never included. Nothing is sent anywhere – the browser hands the file to the marketplace.", write: true, body: { content: "multipart/form-data", schema: { type: "object", properties: { kind: { type: "string", enum: ["document", "database", "workflow", "whiteboard", "appearance", "link-rules"] }, workspaceId: { type: "string", format: "uuid" }, id: { type: "string", format: "uuid" }, meta: { type: "string", description: "JSON: {title, summary: {de, en}, category, tags, language}" }, preview: { type: "array", items: { type: "string", format: "binary" } } }, required: ["kind", "workspaceId", "meta"] }, required: true }, ok: { content: "application/zip", description: "The package (Content-Disposition: attachment)" }, errors: [400, 401, 403, 404, 413] } },
  { path: "/api/marketplace/check", method: "post", op: { id: "marketplaceCheck", tag: "Import and export", summary: "Check whether a marketplace package would import", description: "Reads the package exactly like the import (`/api/marketplace/import`) and then imports it in the target workspace inside a database transaction that is always rolled back: the template and a page made from it (fields, views, records, attachments), the whiteboard template, the look with its typefaces, the link rules – so errors that only show on insert are caught. Workflows are read, matched against the workspace and validated, not inserted. Nothing is kept, no webhooks or events are sent. `workspaceId`: the workspace for the dry run (member, not a guest); without it the first one the caller owns or edits. `dryRun=0` only reads. Answers 200 with `ok: false` and `errors` when the package would not import. API tokens need the permission “Marketplace check” (also read tokens; it never allows a real import). At most 30 checks in 10 minutes per person; 25 MB per package. 404 when the marketplace is switched off.", body: { content: "multipart/form-data", schema: { type: "object", properties: { file: { type: "string", format: "binary", description: "`.flowplan-template`, up to 25 MB" }, workspaceId: { type: "string", format: "uuid" }, dryRun: { type: "string", enum: ["0", "1"] } }, required: ["file"] }, required: true }, ok: { schema: { type: "object", properties: { ok: { type: "boolean" }, kind: { type: ["string", "null"] }, title: { type: ["string", "null"] }, minVersion: { type: ["string", "null"] }, version: { type: "string", description: "This instance's version" }, sha256: { type: "string" }, size: { type: "integer" }, creates: { type: "object", description: "What the import would create: templates, pages, fields, views, records, files, nodes, items, fonts, rules, theme", additionalProperties: true }, errors: { type: "array", items: { type: "object", properties: { code: { type: "string" }, de: { type: "string" }, en: { type: "string" }, at: { type: "string" } }, required: ["code", "de", "en"] } }, warnings: { type: "array", items: { type: "object", properties: { code: { type: "string" }, de: { type: "string" }, en: { type: "string" }, at: { type: "string" } }, required: ["code", "de", "en"] } }, dryRun: { type: "object", properties: { ran: { type: "boolean" }, rolledBack: { type: "boolean" }, workspace: { type: "boolean" }, ms: { type: "integer" }, reason: { type: "string", enum: ["off", "no_workspace", "errors"] } } }, checkedAt: { type: "string", format: "date-time" } }, required: ["ok", "kind", "creates", "errors", "warnings", "dryRun"] }, description: "The check's result" }, errors: [400, 401, 403, 404, 413, 429] } },
  { path: "/api/marketplace/import", method: "post", op: { id: "marketplaceImport", tag: "Import and export", summary: "Check or import a marketplace package", description: "Every check runs again here (size ≤ 25 MB, ZIP safety, template.json, the kind's schema). `preview=1` only answers what would be created (for workflows: nodes, external hosts, AI and e-mail steps). Otherwise imported with the kind's own import: templates and whiteboard templates (editors; `spaceId`, `private`), a workflow as a paused draft on a new page (`spaceId` required, `parentId`), the appearance (replaces the current one) and link rules (owners).", write: true, body: { content: "multipart/form-data", schema: { type: "object", properties: { file: { type: "string", format: "binary", description: "`.flowplan-template`, up to 25 MB" }, preview: { type: "string", enum: ["1"] }, workspaceId: { type: "string", format: "uuid" }, spaceId: { type: "string", format: "uuid" }, parentId: { type: "string", format: "uuid" }, private: { type: "string", enum: ["true", "false"] } }, required: ["file"] }, required: true }, ok: { schema: { type: "object", additionalProperties: true }, description: "The preview, or what was created" }, errors: [400, 401, 403, 404, 413] } },
  { path: "/api/templates/{templateId}/export", method: "get", op: { id: "exportTemplate", tag: "Import and export", summary: "Export a saved template as archive", params: [p("templateId", "Template ID"), workspace], ok: { content: "application/zip", description: "The archive" }, errors: [401, 403, 404] } },
  { path: "/api/clip", method: "post", op: { id: "clipArticle", tag: "Import and export", summary: "Readable text of a web article", description: "Fetched by the server (internal addresses are refused).", write: true, body: { content: "application/json", schema: { type: "object", properties: { url: { type: "string", maxLength: 2000 } }, required: ["url"] }, required: true }, ok: { schema: { type: "object", additionalProperties: true }, description: "Title, text and images" }, errors: [400, 401, 403] } },
  { path: "/api/clipper/targets", method: "get", op: { id: "clipperTargets", tag: "Import and export", summary: "Where the browser extension may save", description: "For `clipper` (or write) tokens: workspaces with the spaces and the documents and databases you may write to. Answers carry CORS headers for browser-extension origins only, without credentials.", ok: { schema: { type: "object", additionalProperties: true }, description: "User name and workspaces with spaces and pages" }, errors: [401, 403] } },
  { path: "/api/clipper/save", method: "post", op: { id: "clipperSave", tag: "Import and export", summary: "Save a clip from the browser extension", description: "For `clipper` (or write) tokens. `mode`: `page` or `selection` (HTML, sanitised on the server) as a new page in a space, a sub-page of a document or a record of a database; `bookmark` into the space's bookmarks database (title, URL, description, favicon, tags); `highlight` as a quote with a link to the source, appended to the target document (into a space: a new page for the source). Tags go into a property named Tags if the database has one.", write: true, body: { content: "application/json", schema: { type: "object", properties: { mode: { type: "string", enum: ["page", "selection", "bookmark", "highlight"] }, target: { type: "object", properties: { workspaceId: { type: "string", format: "uuid" }, spaceId: { type: "string", format: "uuid" }, pageId: { type: "string", format: "uuid" } }, required: ["workspaceId"] }, url: { type: "string", maxLength: 2000 }, title: { type: "string", maxLength: 300 }, description: { type: "string", maxLength: 2000 }, favicon: { type: "string", maxLength: 2000 }, html: { type: "string" }, text: { type: "string", maxLength: 20000 }, tags: { type: "array", items: { type: "string", maxLength: 60 }, maxItems: 20 } }, required: ["mode", "target", "url"] }, required: true }, ok: { schema: { type: "object", properties: { pageId: { type: "string" }, rowId: { type: "string" }, url: { type: "string" } }, required: ["pageId", "url"] }, description: "The page (and record) saved to" }, errors: [400, 401, 403, 404, 409, 413] } },
  { path: "/api/embed", method: "get", op: { id: "embed", tag: "Import and export", summary: "Link preview or player for a URL", params: [q("url", "The address", { type: "string", minLength: 8, maxLength: 2000 }, true)], ok: { schema: { type: "object", additionalProperties: true }, description: "Card or player data" }, errors: [400, 401, 403] } },
  { path: "/api/spaces/{spaceId}/git-export", method: "get", op: { id: "spaceGitExport", tag: "Import and export", summary: "Git export settings of a space", description: "Space owners only.", params: [p("spaceId", "Space ID")], ok: { schema: { type: "object", additionalProperties: true }, description: "Status" }, errors: [401, 403, 404] } },
  { path: "/api/spaces/{spaceId}/git-export/run", method: "post", op: { id: "runSpaceGitExport", tag: "Import and export", summary: "Run the Git export of a space now", write: true, params: [p("spaceId", "Space ID")], ok: { schema: { type: "object", additionalProperties: true }, description: "The result" }, errors: [401, 403, 404] } },
  // Tokens and webhooks
  { path: "/api/tokens", method: "get", op: { id: "listTokens", tag: "Tokens and webhooks", summary: "Your API tokens", description: "Tokens cannot create or revoke tokens (the settings do).", ok: { schema: { type: "array", items: ref("ApiToken") }, description: "Tokens, newest first" }, errors: [401] } },
  { path: "/api/webhooks", method: "get", op: { id: "listWebhooks", tag: "Tokens and webhooks", summary: "Webhooks of a workspace", description: "Owners only.", params: [workspace], ok: { schema: { type: "object", properties: { webhooks: { type: "array", items: ref("Webhook") }, events: { type: "object", additionalProperties: { type: "string" }, description: "Event IDs with their German labels" } }, required: ["webhooks", "events"] }, description: "Webhooks" }, errors: [400, 401, 403] } },
  { path: "/api/webhooks", method: "post", op: { id: "createWebhook", tag: "Tokens and webhooks", summary: "Register a webhook", description: "Owners with a write token. At most 20 per workspace. Deliveries are signed and retried up to six times; see the WebhookDelivery schema. Removing: `webhook.delete` via POST /api/command.", write: true, body: { content: "application/json", schema: ref("WebhookCreate"), required: true }, ok: { schema: ref("WebhookCreated"), description: "ID and secret" }, errors: [400, 401, 403, 409] } },
  { path: "/api/inbound-mail", method: "get", op: { id: "listInboundMail", tag: "Tokens and webhooks", summary: "Inbound e-mail addresses of a workspace", description: "Owners only. Each address with its target, allowed senders, webhook URL, e-mail address (IMAP mode, when INBOUND_MAIL_DOMAIN is set) and the last delivery. Created, rotated and removed with `inbound.save`, `inbound.rotate` and `inbound.delete`.", params: [workspace], ok: { schema: { type: "object", additionalProperties: true }, description: "Addresses" }, errors: [400, 401, 403] } },
  { path: "/api/workflow-hooks/{token}", method: "post", op: { id: "receiveWorkflowHook", tag: "Tokens and webhooks", summary: "Start a workflow through its inbound webhook", description: "External: the secret token of the webhook trigger is the address; no bearer token. Signed mode (the default) needs `X-Flowplan-Timestamp: <unix seconds>` (at most 5 minutes off) and `X-Flowplan-Signature: sha256=<hex HMAC-SHA256(secret, timestamp + \".\" + body)>`; each signature counts once (a repeat with the same body answers 200 with the first run, another body 409). Token-only mode (chosen deliberately in the trigger) skips the signature and allows 10 calls a minute. `Idempotency-Key` or `X-Delivery-Id` makes a delivery count once. Body up to 256 KB, JSON, a form or text. Answers 202 with the run's id; 409 while the workflow is paused.", security: "none", params: [p("token", "Token of the webhook trigger", { type: "string" })], body: { content: "application/json", schema: { type: "object", additionalProperties: true }, required: false }, ok: { schema: { type: "object", properties: { runId: { type: "string", nullable: true }, duplicate: { type: "boolean" } } }, description: "The run (202), or the earlier run of a repeated delivery (200)" }, errors: [400, 401, 404, 409, 413, 429] } },
  { path: "/api/inbound-mail/{token}", method: "post", op: { id: "receiveInboundMail", tag: "Tokens and webhooks", summary: "Receive an e-mail (for mail providers)", description: "External: the secret token of the address is the authorization; no bearer token. Accepts the generic JSON format (`from`, `to`, `subject`, `text`, `html`, `messageId`, `date`, `attachments[]` with base64 `content`, or `raw` for a whole message), multipart/form-data with the same fields, Mailgun, Postmark and SendGrid Inbound Parse posts, and raw `message/rfc822`. With a signing key the request needs `X-Flowplan-Signature: sha256=<HMAC of the body>` or Mailgun's signature fields. 60 mails per address and hour (429). Answers 200 for stored, duplicate (same Message-ID) and rejected (sender not allowed) mail.", security: "none", params: [p("token", "Token of the inbound address", { type: "string" })], body: { content: "application/json", schema: { type: "object", additionalProperties: true }, required: true }, ok: { schema: { type: "object", additionalProperties: true }, description: "Result: stored, duplicate or rejected" }, errors: [400, 401, 404, 409, 413, 415, 429] } },
  { path: "/api/issue-sync", method: "get", op: { id: "issueSync", tag: "Records", summary: "GitHub/GitLab/Forgejo issue sync: connections, a database's mapping or a record's issue", description: "`workspace` lists the connections (owners and administrators); `page` the mapping and status of a database; `page` with `row` the linked issue or null.", params: [q("workspace", "Workspace ID", { type: "string", format: "uuid" }), q("page", "Page ID of the database", { type: "string", format: "uuid" }), q("row", "Record ID", { type: "string", format: "uuid" })], ok: { schema: { type: "object", additionalProperties: true }, description: "Status" }, errors: [400, 401, 403, 404] } },
  { path: "/api/issue-sync", method: "post", op: { id: "issueSyncAction", tag: "Records", summary: "Test a GitHub/GitLab/Forgejo connection or sync a database now", description: "`{ op: \"test\", workspaceId, provider, baseUrl, repo, token | id }` makes one API call with the token; `{ op: \"run\", pageId }` pulls and pushes now. Rate limits of the provider (403/429) pause the connection until `Retry-After`.", write: true, body: { content: "application/json", schema: { type: "object", properties: { op: { type: "string", enum: ["test", "run"] }, pageId: { type: "string", format: "uuid" }, workspaceId: { type: "string", format: "uuid" } }, required: ["op"], additionalProperties: true }, required: true }, ok: { schema: { type: "object", additionalProperties: true }, description: "The result" }, errors: [400, 401, 403, 404, 429] } },
  { path: "/api/webhooks/update", method: "post", op: { id: "updateWebhook", tag: "Tokens and webhooks", summary: "Change a webhook", description: "Owners with a write token: events, database, format, templates, settings, credentials and (checked again) the address. The secret stays.", write: true, body: { content: "application/json", schema: ref("WebhookUpdate"), required: true }, ok: { schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] }, description: "Changed" }, errors: [400, 401, 403, 404] } },
  { path: "/api/webhooks/test", method: "post", op: { id: "testWebhook", tag: "Tokens and webhooks", summary: "Send a test message", description: "Owners with a write token. Sends a sample message (event `test`) right away, without retries, and answers with the result.", write: true, body: { content: "application/json", schema: { type: "object", properties: { workspaceId: { type: "string", format: "uuid" }, id: { type: "string" } }, required: ["workspaceId", "id"] }, required: true }, ok: { schema: ref("WebhookTestResult"), description: "Result of the delivery" }, errors: [400, 401, 403, 404] } },
  { path: "/api/calendar-feed", method: "get", op: { id: "calendarFeedStatus", tag: "Tokens and webhooks", summary: "Whether a calendar view has an iCalendar link or CalDAV access", params: [q("page", "Page ID of the database", { type: "string", format: "uuid" }, true), q("view", "View ID", { type: "string" }, true)], ok: { schema: { type: "object", properties: { active: { type: "boolean" }, caldav: { type: "boolean" } }, required: ["active", "caldav"] }, description: "Status" }, errors: [400, 401, 403, 404] } },
  { path: "/api/calendar/{token}.ics", method: "get", op: { id: "calendarFeed", tag: "Calendar", summary: "iCalendar feed of a calendar view", description: "External: the secret link (from `calendar.feed`) is the authorization; no bearer token. Subscribe to it in a calendar program.", security: "none", params: [p("token", "Feed token", { type: "string" })], ok: { content: "text/calendar", description: "The feed" }, errors: [404] } },
  // Block extensions (lib/plugins.ts)
  { path: "/api/plugins", method: "get", op: { id: "listPlugins", tag: "Extensions", summary: "Block extensions of a workspace or of a page's workspace", description: "With `workspace`: every member sees the enabled plugins, owners also switched-off ones. With `page`: the enabled plugins of that page's workspace. Each plugin with its blocks (absolute frame addresses), granted and requested permissions, frame size and settings. Changed with `plugin.update` and removed with `plugin.delete` via POST /api/command.", params: [q("workspace", "Workspace ID", { type: "string", format: "uuid" }), q("page", "Page ID", { type: "string", format: "uuid" })], ok: { schema: { type: "object", properties: { plugins: { type: "array", items: { type: "object", additionalProperties: true } }, canManage: { type: "boolean" } }, required: ["plugins"] }, description: "Plugins" }, errors: [400, 401, 403, 404] } },
  { path: "/api/plugins", method: "post", op: { id: "registerPlugin", tag: "Extensions", summary: "Register a block extension by its manifest address", description: "Workspace owners, in the browser (API tokens are refused). The server fetches `flowplan-plugin.json` (HTTPS, an origin on PLUGIN_ALLOWED_ORIGINS unless the administration allows any), validates it and grants the permissions it requests; `databases` picks the databases for a bare `read:database`. Registering the same address again refreshes the manifest.", write: true, body: { content: "application/json", schema: { type: "object", properties: { workspaceId: { type: "string", format: "uuid" }, url: { type: "string", maxLength: 2000 }, databases: { type: "array", items: { type: "string", format: "uuid" }, maxItems: 20 } }, required: ["workspaceId", "url"] }, required: true }, ok: { schema: { type: "object", additionalProperties: true }, description: "The plugin" }, errors: [400, 401, 403, 409] } },
  { path: "/api/plugins/{pluginId}/query", method: "get", op: { id: "queryPluginDatabase", tag: "Extensions", summary: "Records of a database a plugin was granted", description: "What a plugin frame's `query` message returns: at most `limit` (default 50, max 200) records with the caller's own rights – hidden records and properties stay hidden.", params: [p("pluginId", "Plugin ID"), q("page", "Page with the plugin block", { type: "string", format: "uuid" }, true), q("database", "Page ID of the granted database", { type: "string", format: "uuid" }, true), q("limit", "Number of records", { type: "integer", minimum: 1, maximum: 200 })], ok: { schema: { type: "object", additionalProperties: true }, description: "Fields and records" }, errors: [400, 401, 403, 404] } },
  // Custom domains for publications (lib/custom-domains.ts)
  { path: "/api/domains", method: "get", op: { id: "publicationDomain", tag: "Extensions", summary: "Custom domain and look of a publication", description: "The domain with its verification record (TXT `_flowplan-verify.<host>`) and the publication's theme. Set with `domain.add`, `domain.remove` and `publication.theme` via POST /api/command.", params: [q("page", "Page ID of the publication", { type: "string", format: "uuid" }, true)], ok: { schema: { type: "object", additionalProperties: true }, description: "Domain and theme" }, errors: [400, 401, 403, 404] } },
  { path: "/api/domains/verify", method: "post", op: { id: "verifyPublicationDomain", tag: "Extensions", summary: "Verify a publication's custom domain", description: "Checks the DNS TXT record `_flowplan-verify.<host>`, the only accepted proof. Needs edit rights on the page.", write: true, body: { content: "application/json", schema: { type: "object", properties: { pageId: { type: "string", format: "uuid" } }, required: ["pageId"] }, required: true }, ok: { schema: { type: "object", additionalProperties: true }, description: "Domain status and the method that matched (or null)" }, errors: [400, 401, 403, 404] } },
  { path: "/api/domains/allowed", method: "get", op: { id: "customDomainAllowed", tag: "Extensions", summary: "Whether a host is a verified custom domain", description: "For the `ask` endpoint of Caddy's on-demand TLS: 200 for verified domains of active publications, 404 otherwise. No authentication.", security: "none", params: [q("domain", "Host name", { type: "string" }, true)], ok: { content: "text/plain", description: "Verified" }, errors: [404] } },
  // Mobile widgets (lib/mobile-widgets.ts)
  { path: "/api/mobile/widgets/options", method: "get", op: { id: "widgetOptions", tag: "Mobile widgets", security: "device", summary: "What a widget instance can be configured to", description: `The choices for the configuration screen of one widget kind (targets, databases, views, calendars, journals, forms …), only what the person may see; with \`pageId\` also the views and properties of that database. 60 requests per person and minute. ${noStore}`, params: [q("kind", "Widget kind", { type: "string", enum: [...widgetKinds] }, true), q("pageId", "A database for its views and properties", { type: "string", format: "uuid" }), q("lang", "Language of the titles (de, en, fr); the profile's language wins", { type: "string" })], ok: { schema: { type: "object", properties: { kind: { type: "string" } }, required: ["kind"], additionalProperties: true }, description: "Options" }, errors: [400, 401, 404, 429] } },
  { path: "/api/mobile/widgets/data", method: "post", op: { id: "widgetData", tag: "Mobile widgets", security: "device", summary: "The data of all configured widgets in one request", description: `Each widget answers on its own (\`ok\`, \`data\` or \`status\` and \`error\`), so one widget whose page is gone does not fail the others. Counters keep one value per configuration and day for their 14-day history. 60 requests per person and minute. ${noStore}`, body: { content: "application/json", schema: ref("WidgetDataRequest"), required: true }, ok: { schema: ref("WidgetDataResponse"), description: "The widgets" }, errors: [400, 401, 413, 429] } },
  { path: "/api/mobile/widgets/action", method: "post", op: { id: "widgetAction", tag: "Mobile widgets", security: "device", summary: "What a widget, Live Activity or Shortcut does", description: "Capture a note or task, upload a photo or voice memo (`capture.upload` as multipart/form-data with the fields and `file`), save what was shared from another app (`capture.share`: title, text and link, with up to 10 photos or PDFs as repeated `file` parts), tick off a task or habit, track the journal, start and stop the timer or a focus session, mark mentions read, create a meeting note. Goes through the same permission checks, versions and activity log as the web app. 30 actions per person and minute, 20 uploads per hour.", write: true, body: { content: "application/json", schema: ref("WidgetAction"), required: true }, ok: { schema: { type: "object", properties: { ok: { type: "boolean" }, action: { type: "string" } }, required: ["ok", "action"], additionalProperties: true }, description: "The result" }, errors: [400, 401, 403, 404, 409, 413, 429] } },
  // Siri, Shortcuts and Focus filters of the apps (lib/mobile-intents.ts)
  { path: "/api/mobile/intents/pages", method: "get", op: { id: "intentPages", tag: "Mobile widgets", security: "device", summary: "Pages to open from Siri and Shortcuts", description: `At most 20 readable pages across the person's workspaces: whose title contains \`q\`, the ones listed in \`ids\`, or – without either – favorites and recently opened pages. Nothing of end-to-end encrypted spaces. 60 requests per person and minute. ${noStore}`, params: [q("q", "Part of the title"), q("ids", "Comma-separated page IDs"), q("lang", "Language of the titles (de, en, fr); the profile's language wins")], ok: { schema: { type: "object", properties: { pages: { type: "array", items: { type: "object", additionalProperties: true } } }, required: ["pages"] }, description: "Pages" }, errors: [400, 401, 429] } },
  { path: "/api/mobile/intents/search", method: "get", op: { id: "intentSearch", tag: "Mobile widgets", security: "device", summary: "Full-text search for Siri and Shortcuts", description: `The web app's search in every workspace of the person, at most 10 hits with plain-text snippets. 60 requests per person and minute. ${noStore}`, params: [q("q", "Search text", { type: "string" }, true), q("lang", "Language of the titles (de, en, fr)")], ok: { schema: { type: "object", properties: { query: { type: "string" }, results: { type: "array", items: { type: "object", additionalProperties: true } } }, required: ["query", "results"] }, description: "Hits" }, errors: [400, 401, 429] } },
  { path: "/api/mobile/intents/workspaces", method: "get", op: { id: "intentWorkspaces", tag: "Mobile widgets", security: "device", summary: "Workspaces for a Focus filter", description: `The person's workspaces by name. ${noStore}`, params: [q("lang", "Language (de, en, fr)")], ok: { schema: { type: "object", properties: { workspaces: { type: "array", items: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } } } } }, required: ["workspaces"] }, description: "Workspaces" }, errors: [401, 429] } },
  { path: "/api/mobile/intents/focus", method: "post", op: { id: "intentFocus", tag: "Mobile widgets", security: "device", summary: "Hold back push notifications during a Focus", description: "While `hide` is true, push notifications to this device that belong to another workspace than `workspaceId` (all of them when it is null) are left out; they stay in the inbox. Ends after `hours` (default 24) or with `hide: false`. 30 requests per person and minute.", write: true, body: { content: "application/json", schema: { type: "object", properties: { workspaceId: { type: ["string", "null"], format: "uuid" }, hide: { type: "boolean" }, hours: { type: "integer", minimum: 1, maximum: 48 } } }, required: true }, ok: { schema: { type: "object", properties: { ok: { type: "boolean" }, focus: { type: ["object", "null"], additionalProperties: true } }, required: ["ok"] }, description: "The rule now" }, errors: [400, 401, 404, 413, 429] } },
  // Share extension, document scanner and Spotlight (lib/mobile-capture.ts)
  { path: "/api/mobile/capture/targets", method: "get", op: { id: "mobileCaptureTargets", tag: "Mobile widgets", security: "device", summary: "Where the share extension can save", description: `The inbox (the person's capture database, null when none is set) and every database and document the person may add to, with the upload limits. 60 requests per person and minute. ${noStore}`, params: [q("lang", "Language of the titles (de, en, fr); the profile's language wins", { type: "string" })], ok: { schema: { type: "object", properties: { inbox: { type: ["object", "null"] }, targets: { type: "array", items: { type: "object" } }, maxFiles: { type: "integer" }, maxUploadMb: { type: "number" } }, required: ["inbox", "targets"], additionalProperties: true }, description: "Targets" }, errors: [401, 429] } },
  { path: "/api/mobile/capture/save", method: "post", op: { id: "mobileCaptureSave", tag: "Mobile widgets", security: "device", summary: "Save shared text, a link, images or PDFs", description: "From the share extension and the document scanner: JSON, or multipart/form-data with the fields and up to 10 `file` parts (images and PDFs). Into a database as a record (files in its first files property), into a document as a sub page (`place: subpage`) or at its end (`place: append`; also a record's document with `rowId`). `targetId: inbox` uses the capture database. `recognized` is the text the phone read in a scanned PDF, stored as its search text. 30 saves per person and minute, 20 with files per hour.", write: true, body: { content: "application/json", schema: { type: "object", properties: { targetId: { type: "string" }, rowId: { type: "string", format: "uuid" }, place: { type: "string", enum: ["subpage", "append"] }, title: { type: "string", maxLength: 300 }, text: { type: "string", maxLength: 20000 }, url: { type: "string", maxLength: 2000 }, recognized: { type: "string" }, scan: { type: "boolean" } }, additionalProperties: false }, required: true }, ok: { schema: { type: "object", properties: { ok: { type: "boolean" }, pageId: { type: "string" }, rowId: { type: "string" }, url: { type: "string" }, files: { type: "array", items: { type: "string" } } }, required: ["ok", "pageId", "url"], additionalProperties: true }, description: "Where it was saved" }, errors: [400, 401, 403, 404, 409, 413, 429] } },
  { path: "/api/mobile/capture/spotlight", method: "get", op: { id: "mobileSpotlight", tag: "Mobile widgets", security: "device", summary: "Pages and open tasks for the phone's search", description: `The 500 most recently changed pages the person may read (title, place, a short excerpt) and up to 200 open tasks, for the on-device search index (iOS Spotlight). Nothing of end-to-end encrypted spaces, pages behind a journal PIN or journal days. ${noStore}`, ok: { schema: { type: "object", properties: { pages: { type: "array", items: { type: "object" } }, tasks: { type: "array", items: { type: "object" } }, at: { type: "integer" } }, required: ["pages", "tasks"], additionalProperties: true }, description: "Index entries" }, errors: [401, 429] } },
  // Workflows (#168, lib/workflows/commands.ts, rest.ts, portable.ts)
  { path: "/api/workflows", method: "get", op: { id: "listWorkflows", tag: "Workflows", summary: "Workflows of a workspace", description: `The workflow pages you can see (none for guests): \`pageId\`, \`title\`, \`status\` (draft, active, paused, auto_paused), \`runner\` (who it runs as), \`manual\` (has an active manual trigger) and \`lastRun\`. ${noStore}`, params: [q("workspaceId", "Workspace ID", { type: "string", format: "uuid" }, true)], ok: { schema: { type: "object", properties: { workflows: { type: "array", items: ref("WorkflowSummary") } }, required: ["workflows"] }, description: "Workflows" } } },
  { path: "/api/workflows/catalog", method: "get", op: { id: "workflowCatalog", tag: "Workflows", summary: "The node catalogue", description: "Every node type with names [de, en], category, symbol, whether it runs inside the writing transaction (`inline`), its trigger event, ports, output fields (for placeholders) and configuration as JSON Schema.", params: [q("workspaceId", "Optional: checks membership of this workspace", { type: "string", format: "uuid" })], ok: { schema: { type: "object", properties: { nodes: { type: "array", items: ref("WorkflowCatalogNode") } }, required: ["nodes"] }, description: "Catalogue" } } },
  { path: "/api/workflows/{pageId}", method: "get", op: { id: "getWorkflow", tag: "Workflows", summary: "State, active version and draft of a workflow", description: `\`active\` is the running version (graph, number, who activated it); \`draft\` (editors only, never for read tokens) holds the draft graph, whether it differs from the active version and its check (\`issues\`: errors keep it from being activated, warnings not). ${noStore}`, params: [p("pageId", "Page ID of the workflow")], ok: { schema: ref("WorkflowState"), description: "The workflow" } } },
  { path: "/api/workflows/{pageId}/runs", method: "get", op: { id: "listWorkflowRuns", tag: "Workflows", summary: "Runs of a workflow", description: `Newest first. ${noStore}`, params: [p("pageId", "Page ID of the workflow"), q("status", "Only these", { type: "string", enum: ["failed", "succeeded", "cancelled", "open", "waiting"] }), q("mode", "Live runs or tests", { type: "string", enum: ["live", "test"] }), q("q", "Search in the run id and errors"), q("limit", "1–200, default 50", { type: "integer", minimum: 1, maximum: 200 }), q("before", "Only runs created before this time (ms)", { type: "integer" })], ok: { schema: { type: "object", properties: { runs: { type: "array", items: ref("WorkflowRun") } }, required: ["runs"] }, description: "Runs" } } },
  { path: "/api/workflows/{pageId}/versions", method: "get", op: { id: "listWorkflowVersions", tag: "Workflows", summary: "Activated versions and draft snapshots", params: [p("pageId", "Page ID of the workflow")], ok: { schema: { type: "object", properties: { versions: { type: "array", items: { type: "object", additionalProperties: true } }, drafts: { type: "array", items: { type: "object", additionalProperties: true } } }, required: ["versions", "drafts"] }, description: "Timeline" } } },
  { path: "/api/workflows/{pageId}/versions/{versionId}", method: "get", op: { id: "getWorkflowVersion", tag: "Workflows", summary: "One version (or draft snapshot) with its graph", params: [p("pageId", "Page ID of the workflow"), p("versionId", "Version or snapshot ID")], ok: { schema: { type: "object", properties: { id: { type: "string" }, number: { type: "integer" }, draft: { type: "boolean" }, graph: ref("WorkflowGraph") }, required: ["id", "graph"], additionalProperties: true }, description: "Version" } } },
  { path: "/api/workflows/{pageId}/approvals", method: "get", op: { id: "listWorkflowApprovals", tag: "Workflows", summary: "Approvals of a workflow", description: "Decided only signed in, never with a token.", params: [p("pageId", "Page ID of the workflow")], ok: { schema: { type: "object", additionalProperties: true }, description: "Approvals" } } },
  { path: "/api/workflows/{pageId}/start", method: "get", op: { id: "workflowStartInfo", tag: "Workflows", summary: "What a workflow button may start", description: "The manual trigger's inputs and whether you may start it: editors of the workflow by default; with the trigger's `who: members` every full member who reads the workflow – or `host`, a page carrying its button. Never guests.", params: [p("pageId", "Page ID of the workflow"), q("host", "The page with the button", { type: "string", format: "uuid" })], ok: { schema: { type: "object", properties: { may: { type: "boolean" }, inputs: { type: "array", items: { type: "object", additionalProperties: true } }, title: { type: ["string", "null"] }, status: { type: "string" } }, additionalProperties: true }, description: "Start information" } } },
  { path: "/api/workflows/{pageId}/export", method: "get", op: { id: "exportWorkflow", tag: "Workflows", summary: "Export a workflow as JSON", description: "The draft (editors) or the active version (readers) with its references (`references`: kind and title of every page, database with its properties, person, chat webhook, address and credential the graph names). Never runs, secrets, webhook addresses or inbound tokens: a credential is only its name, kind and host, to link again after an import.", params: [p("pageId", "Page ID of the workflow")], ok: { schema: ref("WorkflowExport"), description: "The file" } } },
  { path: "/api/workflows/import", method: "post", op: { id: "importWorkflow", tag: "Workflows", summary: "Import a workflow as a new draft", description: "Creates a workflow page from an export (or a bare graph) – always a draft, never active. References are matched by id in this workspace, by title (databases, pages), name (people, properties of a matched database) or `mapping` (`{\"<id in the file>\": \"<id here>\"}`, properties as `\"<database id>:<property id>\"`); what stays unmatched is cleared and listed in `unresolved`. `preview: true` only answers `unresolved`. Credentials are never imported: link them again.", write: true, body: { content: "application/json", schema: { type: "object", properties: { workspaceId: { type: "string", format: "uuid" }, spaceId: { type: "string", format: "uuid" }, parentId: { type: "string", format: "uuid" }, title: { type: "string", maxLength: 200 }, data: ref("WorkflowExport"), mapping: { type: "object", additionalProperties: { type: "string" } }, preview: { type: "boolean" } }, required: ["workspaceId", "spaceId", "data"] }, required: true }, ok: { schema: { type: "object", properties: { ok: { type: "boolean" }, id: { type: "string", format: "uuid" }, unresolved: { type: "array", items: ref("WorkflowUnresolved") }, issues: { type: "array", items: ref("WorkflowIssue") } }, required: ["ok"], additionalProperties: true }, description: "The new workflow page" }, errors: [400, 401, 403, 404, 409, 413] } },
  { path: "/api/workflows/{pageId}/draft", method: "post", op: { id: "saveWorkflowDraft", tag: "Workflows", summary: "Replace the draft by a graph", description: "Merges into the live draft like an edit in the browser (people editing see it at once). Answers the check. Never activates. Same as the action `workflow.draft`.", write: true, params: [p("pageId", "Page ID of the workflow")], body: { content: "application/json", schema: { type: "object", properties: { graph: ref("WorkflowGraph") }, required: ["graph"] }, required: true }, ok: { schema: ref("WorkflowCheckResult"), description: "Saved, with the check" }, errors: [400, 401, 403, 404, 409, 413] } },
  { path: "/api/workflows/{pageId}/validate", method: "post", op: { id: "validateWorkflow", tag: "Workflows", summary: "Check a graph or the draft", description: "As the caller would run it: structure, references and rights.", write: true, params: [p("pageId", "Page ID of the workflow")], body: { content: "application/json", schema: { type: "object", properties: { graph: ref("WorkflowGraph") } }, required: false }, ok: { schema: { type: "object", properties: { issues: { type: "array", items: ref("WorkflowIssue") } }, required: ["issues"] }, description: "Issues" } } },
  { path: "/api/workflows/{pageId}/activate", method: "post", op: { id: "activateWorkflow", tag: "Workflows", summary: "Activate the draft", description: "The draft becomes the next version and the caller the person it runs as (it never does more than they may). A draft with errors is not activated: `{ ok: false, issues }`. Write tokens may (for deployments); the MCP server may not.", write: true, params: [p("pageId", "Page ID of the workflow")], body: { content: "application/json", schema: { type: "object", properties: { note: { type: "string", maxLength: 500 } } }, required: false }, ok: { schema: { type: "object", properties: { ok: { type: "boolean" }, versionId: { type: "string" }, number: { type: "integer" }, issues: { type: "array", items: ref("WorkflowIssue") } }, required: ["ok", "issues"] }, description: "Activated, or why not" }, errors: [400, 401, 403, 404, 409] } },
  { path: "/api/workflows/{pageId}/pause", method: "post", op: { id: "pauseWorkflow", tag: "Workflows", summary: "Pause a workflow", description: "No new runs; open runs are held (or cancelled with `cancelRuns`).", write: true, params: [p("pageId", "Page ID of the workflow")], body: { content: "application/json", schema: { type: "object", properties: { cancelRuns: { type: "boolean" }, reason: { type: "string", maxLength: 300 } } }, required: false }, ok: { schema: okSchema(), description: "Paused" } } },
  { path: "/api/workflows/{pageId}/run", method: "post", op: { id: "runWorkflow", tag: "Workflows", summary: "Start a workflow with a manual trigger", description: "`live` (default) starts the active version as the person it runs as (you are `startedBy`, source `api`) and answers the event; `test`/`dry` run the draft as you (editors) and answer the run. Who may start live runs: the trigger decides (editors, or all members who see it).", write: true, params: [p("pageId", "Page ID of the workflow")], body: { content: "application/json", schema: { type: "object", properties: { nodeId: { type: "string" }, inputs: { type: "object", additionalProperties: true }, mode: { type: "string", enum: ["live", "test", "dry"] } } }, required: false }, ok: { schema: { type: "object", properties: { ok: { type: "boolean" }, eventId: { type: ["string", "null"] }, runId: { type: ["string", "null"] } }, required: ["ok"], additionalProperties: true }, description: "Started" }, errors: [400, 401, 403, 404, 409, 429] } },
  { path: "/api/workflows/{pageId}/test", method: "post", op: { id: "testWorkflow", tag: "Workflows", summary: "Test or dry-run the draft", description: "`dry` reports what every node would do; `test` really acts, as you. Data of the trigger: `sample`, `last` (the last real event), `record`, `page` or `custom`. 10 per person and minute. A draft with errors answers `{ ok: false, issues }`.", write: true, params: [p("pageId", "Page ID of the workflow")], body: { content: "application/json", schema: { type: "object", properties: { mode: { type: "string", enum: ["test", "dry"] }, nodeId: { type: "string" }, data: { type: "object", additionalProperties: true }, assume: { type: "string", enum: ["approved", "rejected"] } } }, required: false }, ok: { schema: { type: "object", properties: { ok: { type: "boolean" }, runId: { type: ["string", "null"] }, issues: { type: "array", items: ref("WorkflowIssue") } }, required: ["ok"] }, description: "The run" }, errors: [400, 401, 403, 404, 409, 429] } },
  { path: "/api/workflows/{pageId}/restore", method: "post", op: { id: "restoreWorkflowVersion", tag: "Workflows", summary: "A version or snapshot becomes the draft", description: "Never the active version directly.", write: true, params: [p("pageId", "Page ID of the workflow")], body: { content: "application/json", schema: { type: "object", properties: { versionId: { type: "string", format: "uuid" } }, required: ["versionId"] }, required: true }, ok: { schema: ref("WorkflowCheckResult"), description: "Restored into the draft" } } },
  { path: "/api/workflow-runs/{runId}", method: "get", op: { id: "getWorkflowRun", tag: "Workflows", summary: "A run with its steps", description: `\`timeline\` lists every step (attempts, ports, errors). Inputs and outputs only for the person the run ran as (\`contentsVisible\`). ${noStore}`, params: [p("runId", "Run ID")], ok: { schema: ref("WorkflowRunDetail"), description: "The run" } } },
  { path: "/api/workflow-runs/{runId}/retry", method: "post", op: { id: "retryWorkflowRun", tag: "Workflows", summary: "Retry a failed run from its failed node", write: true, params: [p("runId", "Run ID")], body: { content: "application/json", schema: { type: "object", properties: { fromNode: { type: "string" } } }, required: false }, ok: { schema: { type: "object", additionalProperties: true }, description: "Retried" }, errors: [400, 401, 403, 404, 409] } },
  { path: "/api/workflow-runs/{runId}/cancel", method: "post", op: { id: "cancelWorkflowRun", tag: "Workflows", summary: "Cancel an open run", write: true, params: [p("runId", "Run ID")], ok: { schema: { type: "object", properties: { ok: { type: "boolean" }, cancelled: { type: "boolean" } }, required: ["ok"] }, description: "Cancelled" } } },
  { path: "/api/workflow-approvals", method: "get", op: { id: "myWorkflowApprovals", tag: "Workflows", summary: "Approvals waiting for me", params: [q("workspaceId", "Only this workspace", { type: "string", format: "uuid" })], ok: { schema: { type: "object", additionalProperties: true }, description: "Approvals" } } },
  { path: "/api/workflow-approvals/{approvalId}", method: "get", op: { id: "getWorkflowApproval", tag: "Workflows", summary: "One approval with its message and context", params: [p("approvalId", "Approval ID")], ok: { schema: { type: "object", additionalProperties: true }, description: "Approval" } } },
  { path: "/api/workflow-approvals/{approvalId}", method: "post", op: { id: "decideWorkflowApproval", tag: "Workflows", summary: "Approve or reject (signed in only)", description: "A person's decision: refused for every API token (403) and not offered over MCP. The first decision wins (409 afterwards).", write: true, params: [p("approvalId", "Approval ID")], body: { content: "application/json", schema: { type: "object", properties: { decision: { type: "string", enum: ["approved", "rejected"] }, comment: { type: "string", maxLength: 2000 } }, required: ["decision"] }, required: true }, ok: { schema: okSchema(), description: "Decided" }, errors: [400, 401, 403, 404, 409] } },
  // MCP
  { path: "/api/mcp", method: "post", op: { id: "mcp", tag: "MCP", summary: "MCP server (Streamable HTTP, JSON answers)", description: "For AI assistants. Only API tokens sign in; read tokens get the reading tools, write tokens all. 120 calls per person and minute, then 429 with `Retry-After`. Tools: list_workspaces, list_pages, search, read_page, query_database, get_record, my_tasks, create_page, append_to_page, create_record, update_record.", body: { content: "application/json", schema: ref("McpRequest"), required: true }, ok: { schema: ref("McpResponse"), description: "The JSON-RPC answer (202 without a body for notifications)" }, errors: [400, 401, 403, 413, 429] } },
];

// Route files under app/api that the specification leaves out on purpose:
// they are not for API tokens. tests/openapi.test.ts checks that every
// other route file has at least one path here.
export const routesOutsideSpec: Record<string, string> = {
  "app/api/health/live/route.ts": "Liveness probe for orchestrators (Kubernetes, load balancers); /api/health is the documented check",
  "app/api/health/ready/route.ts": "Readiness probe for orchestrators (database, and in cluster mode Redis and object storage); /api/health is the documented check",
  "app/api/issue-sync/hook/[token]/route.ts": "GitHub/GitLab/Forgejo issue webhooks, verified by their own token and signature",
  "app/api/admin/instance-backup/route.ts": "Administration only; tokens never administer",
  "app/api/admin/instance-move/route.ts": "Administration only; tokens never administer",
  "app/api/admin/sftp-backup/route.ts": "Administration only; tokens never administer",
  "app/api/setup/restore/route.ts": "Restore on a new instance before its first account, only with the setup link; never API tokens",
  "app/api/move/[...path]/route.ts": "Instance move between two servers: only the one-time move token of the old instance (fpmove_…), never API tokens",
  "app/api/admin/directory/route.ts": "Administration only; tokens never administer",
  "app/api/admin/operations/route.ts": "Administration only; tokens never administer",
  "app/api/admin/summary/route.ts": "Administration only; tokens never administer",
  "app/api/admin/monitoring/route.ts": "Administration only; tokens never administer",
  "app/api/admin/security/route.ts": "Administration only; tokens never administer",
  "app/api/admin/push/route.ts": "Administration only; tokens never administer",
  "app/api/admin/messengers/route.ts": "Administration only; tokens never administer",
  "app/api/messengers/route.ts": "Chat-app connections with their credentials: the browser's settings only, never API tokens",
  "app/api/scim/v2/[...path]/route.ts": "SCIM 2.0 (RFC 7643/7644) is its own standard with its own bearer tokens; discovery at /api/scim/v2/ServiceProviderConfig",
  "app/api/ai/[...path]/route.ts": "AI features of the browser app (settings and actions refuse API tokens; run, ask, write and summarize accept tokens with the permission “AI and transcription”)",
  "app/api/auth/[action]/route.ts": "Browser sign-in and account settings",
  "app/api/calendar-sync/[...path]/route.ts": "Browser OAuth connection to Google and Microsoft 365 calendars",
  "app/api/forms/[token]/route.ts": "Public forms with their own link token",
  "app/api/forms/[token]/fonts/[fontId]/route.ts": "Public forms with their own link token",
  "app/api/git/[token]/route.ts": "Git integration callbacks with their own token",
  "app/api/mobile/[action]/route.ts": "The mobile apps (session cookie or device token: registration with push relay token and encryption key, Live Activity relay tokens; the administrators' widget summary only for instance administrators)",
  "app/api/mobile/notifications/route.ts": "Buttons on the mobile apps' push notifications, only with the device token",
  "app/api/calendar-profile/route.ts": "Apple configuration profile with CalDAV accounts: created from the browser's account settings, downloaded once by its link",
  "app/api/contacts/route.ts": "Contacts databases of the browser app: LDAP directory import and sync, vCard import/export, CardDAV accesses and their Apple configuration profile (CardDAV itself is /api/carddav/…, basic auth with such an access)",
  "app/api/print/[token]/route.ts": "Print views of the browser app",
  "app/api/print/route.ts": "Print views of the browser app",
  "app/api/public-templates/[id]/files/[fileId]/route.ts": "Public template gallery",
  "app/api/share/[token]/route.ts": "Share links with their own token",
  "app/api/share/[token]/files/route.ts": "Share links with their own token",
  "app/api/share/[token]/files/[fileId]/route.ts": "Share links with their own token",
  "app/api/share/[token]/files/[fileId]/ink/route.ts": "Share links with their own token",
  "app/api/share/[token]/ink/route.ts": "Share links with their own token",
  "app/api/share/[token]/live/route.ts": "Share links with their own token",
  "app/api/share/[token]/fonts/[fontId]/route.ts": "Share links with their own token",
  "app/api/share/[token]/unlock/route.ts": "Share links with their own token",
  "app/api/tickets/[token]/route.ts": "Service desk links for customers",
  "app/api/transcribe/[...path]/route.ts": "Voice notes of the browser app (chunked upload to the transcription service; tokens need “AI and transcription”)",
  "app/api/whiteboards/[id]/facilitation/route.ts": "Workshop facilitation on whiteboards (private mode, planning poker, gathering everyone) of the browser app",
  "app/api/webhooks/slack/[id]/route.ts": "Slack Event Subscriptions of a Slack webhook, signed with its signing secret",
};

const appBase = () => (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");

// Operations that take an Idempotency-Key (lib/idempotency.ts): applied once
// per key, retries answered from the store. The SDKs send one per call and
// keep it when they retry.
export const idempotentOperations = new Set([
  "command",
  "activateWorkflow",
  "runWorkflow",
  "importWorkflow",
  "importMarkdownRecords",
  "timeReportAction",
  "uploadFile",
  "importZip",
  "importSource",
  "importTracker",
  "importTemplate",
  "clipperSave",
  "runSpaceGitExport",
  "createWebhook",
  "issueSyncAction",
  "updateWebhook",
  "testWebhook",
  "registerPlugin",
  "verifyPublicationDomain",
  "widgetAction",
  "intentFocus",
  "mobileCaptureSave",
]);
const idempotencyKeyParam: Param = {
  name: "Idempotency-Key",
  in: "header",
  description:
    "Optional. One key per logical action (e.g. a UUID v4), 8–128 characters of `A–Z a–z 0–9 _ -`; send the same key again when retrying the same request. The first request is applied; a repeat with the same key and the same request (method, path, body) gets the stored status and body with `Idempotent-Replayed: true`, a repeat with another request 422, a repeat while the first still runs 409 with `Retry-After`. Answers that held a secret (a new token, a feed address) or were larger than 64 KB are not kept: a repeat gets 409 `idempotency_already_applied`. Keys belong to the token (or device) that sent them and expire after 24 hours.",
  schema: { type: "string", pattern: "^[A-Za-z0-9_-]{8,128}$" },
};

function operation(o: Op): Json {
  const responses: Json = {};
  const ok = o.ok || { description: "OK" };
  const idempotent = idempotentOperations.has(o.id);
  responses[String(ok.status || 200)] = {
    description: ok.description,
    ...(ok.schema || ok.content ? { content: { [ok.content || "application/json"]: ok.schema ? { schema: ok.schema } : {} } } : {}),
    ...(idempotent
      ? { headers: { "Idempotent-Replayed": { description: "`true` when the answer is the stored one of an earlier request with the same Idempotency-Key.", schema: { type: "string", enum: ["true"] } } } }
      : {}),
  };
  // Every change may meet an instance that is read-only for a move (423).
  const errors = [...new Set([...(o.errors ?? [400, 401, 403, 404]), ...(idempotent ? [409, 422] : []), ...(o.write ? [423] : [])])];
  const params = [...(o.params || []), ...(idempotent ? [idempotencyKeyParam] : [])];
  for (const status of [...errors].sort()) responses[String(status)] = { description: errorText[status] || "Error", content: { "application/json": { schema: ref("ErrorResponse") } } };
  return {
    operationId: o.id,
    tags: [o.tag],
    summary: o.summary,
    ...(o.description ? { description: o.description } : {}),
    ...(params.length ? { parameters: params.map((prm) => ({ name: prm.name, in: prm.in, required: !!prm.required, ...(prm.description ? { description: prm.description } : {}), schema: prm.schema })) } : {}),
    ...(o.body ? { requestBody: { required: o.body.required !== false, ...(o.body.description ? { description: o.body.description } : {}), content: { [o.body.content]: { schema: o.body.schema } } } } : {}),
    responses,
    security: o.security === "none" ? [] : o.security === "metrics" ? [{ metricsToken: [] }] : o.security === "device" ? [{ deviceToken: [] }] : [{ bearerAuth: [] }],
    ...(o.write ? { "x-write-token": true } : {}),
    ...(idempotent ? { "x-idempotent": true } : {}),
  };
}

// `exactVersion: false` for readers without a session (lib/instance-disclosure.ts).
export function openApiDocument(options: { exactVersion?: boolean } = {}): Json {
  const paths: Record<string, Json> = {};
  for (const { path, method, op } of operations) (paths[path] ||= {})[method] = operation(op);
  const tags = [
    { name: "Instance", description: "Facts about this installation, without a token." },
    { name: "Workspace", description: "Workspaces, search, tasks and the command endpoint that changes things." },
    { name: "Pages", description: "Documents, databases, whiteboards and journals." },
    { name: "Records", description: "Records of databases and what belongs to them." },
    { name: "Journal", description: "Journals and their days." },
    { name: "Meetings", description: "Meeting notes: recording, transcript and AI summary of the /meet block. Tokens need the permission “AI and transcription”." },
    { name: "Files", description: "Uploads and downloads." },
    { name: "Encryption", description: "End-to-end encrypted spaces: keys and ciphertext, never content." },
    { name: "Import and export", description: "Markdown, ZIP archives, backups and the Git export." },
    { name: "Tokens and webhooks", description: "Your tokens, and webhooks that tell other services about changes." },
    { name: "Calendar", description: "iCalendar feeds. CalDAV (`/api/caldav/…`, PROPFIND and REPORT, basic auth with the access created by `calendar.caldav`) is served outside this document." },
    { name: "MCP", description: "The Model Context Protocol server for AI assistants." },
    { name: "Extensions", description: "Block extensions (plugins rendered in sandboxed frames) and custom domains for publications." },
    { name: "Workflows", description: "Workflow pages: their graphs, drafts, versions, runs, approvals, export and import. A draft never runs until a person (or a write token) activates it." },
    { name: "Mobile widgets", description: "Widgets, Live Activities and Shortcuts of the mobile apps: configurable per widget instance, signed in with the app's device token (`fpd_…`), never with a personal API token." },
  ];
  return {
    openapi: "3.1.0",
    info: {
      title: "Flowplan API",
      version: disclosedVersion(buildInfo().version, options.exactVersion !== false),
      summary: "The HTTP API of a Flowplan instance for scripts, integrations and the generated SDKs.",
      description: [
        "Every request carries a personal API token (`Authorization: Bearer fp_…`, created under Settings → API & AI assistants) and acts with the rights of the person who created it. Read tokens may only call GET endpoints and the Markdown export; write tokens also `POST /api/command`, uploads, imports and webhooks. Tokens never get administration rights and cannot create further tokens.",
        "",
        "Errors answer with JSON `{ \"error\": \"…\" }` and the status: 400 invalid input (with `details`), 401 no valid token, 403 not allowed, 404 not found, 409 conflict (locked page, stale version, a limit reached), 413 too large, 429 too many requests, 500 unexpected. Messages follow `Accept-Language` (German by default).",
        "",
        "Idempotency: changes (`POST /api/command`, uploads, imports, webhooks, widget actions) take an optional `Idempotency-Key` header – one key per logical action, sent again unchanged on every retry. The change is applied once; retries with the same key and request get the stored answer (`Idempotent-Replayed: true`), with another request 422, while the first still runs 409 with `Retry-After`. Keys belong to the token or device and expire after 24 hours. The generated SDKs send a key with every such call and keep it when they retry.",
        "",
        "Rate limits: the MCP endpoint allows 120 calls per person and minute (429 with `Retry-After: 60`); invitations and shares that send mail are limited to 40 per person and hour, each address to 5 mails per hour (429). Request bodies are limited (12 MB for JSON, more for archives; 413 beyond).",
        "",
        "Generated clients: `sdk/typescript` and `sdk/python` in the source repository are built from this document (`npm run sdk`).",
      ].join("\n"),
      license: { name: "AGPL-3.0-only", url: "https://www.gnu.org/licenses/agpl-3.0.html" },
      contact: { name: "Flowplan", url: "https://flowplan.org" },
    },
    externalDocs: { description: "API and webhooks", url: "https://docs.flowplan.org/api-and-webhooks" },
    servers: [{ url: appBase(), description: "This instance" }],
    tags,
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "fp_…", description: "A personal API token with read, write or clipper scope. AI features, transcription and meeting notes additionally need the token permission “AI and transcription” (chosen when the token is created, off by default; the administration can switch it off for the instance). Such requests count against the same AI limits as the interface. The import check of marketplace packages (POST /api/marketplace/check) needs the token permission “Marketplace check” (off by default; also for read tokens – it never imports)." },
        metricsToken: { type: "http", scheme: "bearer", description: "`FLOWPLAN_METRICS_TOKEN` of the instance (Prometheus, and the details of the health check)." },
        deviceToken: { type: "http", scheme: "bearer", bearerFormat: "fpd_…", description: "The device token of a mobile app installation (POST /api/mobile/register from the signed-in app). Lives as long as the session it was registered with; using it keeps a remembered session alive, and signing in again in the app moves it to the new session." },
      },
      schemas,
    },
    webhooks: {
      delivery: {
        post: {
          summary: "A webhook delivery",
          description: "Flowplan posts this to the registered address; answer with 2xx. Retried up to six times with growing delays.",
          requestBody: { required: true, content: { "application/json": { schema: ref("WebhookDelivery") } } },
          responses: { "2XX": { description: "Received" } },
        },
      },
    },
  };
}
