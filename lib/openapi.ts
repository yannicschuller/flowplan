// The OpenAPI 3.1 description of Flowplan's public HTTP API: what scripts,
// n8n, Home Assistant and the generated SDKs (sdk/) call with a personal API
// token. Built from the code where it exists as zod schemas (database
// properties and views, command actions, export options); the rest is
// described by hand from the route handlers in app/api. Served at
// /api/openapi.json, readable at /api/docs; tests/openapi.test.ts keeps the
// routes, the command actions and the SDKs in step with it.
import { MAX_HOME_WIDGETS, MAX_LAYOUT_BYTES, saveSchema } from "./home-layout-schema";
import { MAX_TILES, tileSizes, tileTypes } from "./dashboard-schema";
import { PAPER_COLORS, PAPER_ORIENTATIONS, PAPER_SIZES, PAPER_TEMPLATES } from "./notebook-paper";
import { z } from "zod";
import { field, view } from "./database-schema";
import { coverSchema, iconSizeSchema, pageIconSchema } from "./page-appearance";
import { buildInfo } from "./build-info";
import { disclosedVersion } from "./instance-disclosure";
import { repeatSchema } from "./recurrence";
import { settingsSchema } from "./database-settings-schema";
import { chatFormats, hookConfigSchema, noticeEvents, templatesSchema } from "./notification-templates";
import { MAX_COMBOS, SHORTCUT_ACTIONS } from "./keymap";
import { toRecordsInput } from "./whiteboard-ai";
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
  "profile.onboarded", "profile.language", "notification.reset", "notification.email", "notification.weekly", "shortcuts.save",
  "home.save", "home.reset", "home.note", "home.default",
  "account.deletePlan", "account.delete",
  "space.create", "space.update", "space.delete", "space.restore", "space.purge", "space.duplicate", "space.gitExport", "space.reorder",
  "page.create", "page.update", "page.delete", "page.restore", "page.duplicate", "page.move", "page.import",
  "pages.bulk", "page.follow", "page.snapshot", "page.publish", "page.share", "page.shareUpdate", "page.fromShare",
  "page.toRecord", "record.toPage", "page.owner", "page.review", "page.aliases", "favorite", "favorite.row", "task.update", "synced.create", "mention.link",
  "journal.settings", "journal.lock", "journal.unlock", "journal.relock", "journal.entry", "journal.roll", "journal.link", "journal.removeEmpty", "journal.summary",
  "linked.command", "document.sync", "document.markdown", "document.markdown.apply",
  "snapshot.restoreBlock", "snapshot.restore",
  "database.update", "database.settings", "database.recordLayout",
  "row.create", "row.update", "row.delete", "row.move", "row.schedule", "row.access", "row.appearance",
  "row.recurrence", "row.repeat", "row.detachOccurrence", "row.document.sync", "row.snapshot", "row.snapshot.restore",
  "row.template.save", "row.template.default", "row.template.delete", "row.trash.restore", "row.trash.purge",
  "rows.import", "rows.bulk", "rows.transfer", "timeline.cascade", "timeline.link",
  "citation.import", "citation.remove", "whiteboard.sync", "whiteboard.toRecords", "dashboard.save",
  "notebook.paper", "notebook.sheet.add", "notebook.sheet.duplicate", "notebook.sheet.delete", "notebook.sheet.move", "notebook.sheet.paper", "notebook.import", "search.save", "search.delete",
  "thread.create", "thread.reply", "thread.resolve", "thread.edit", "thread.deleteMessage", "thread.react",
  "comment.create", "comment.resolve", "comment.react", "reminder.set",
  "notification.prefs", "notification.read", "notification.mark", "notification.delete",
  "share.create", "share.revoke", "share.protect", "publication.protect", "publication.copy", "publication.theme",
  "domain.add", "domain.remove", "plugin.update", "plugin.delete",
  "form.update", "form.submit", "survey.save",
  "sprint.setup", "sprint.create", "sprint.update", "sprint.start", "sprint.complete", "sprint.delete", "sprint.points",
  "recordView.save", "recordView.delete", "git.setup", "git.disable",
  "time.start", "time.stop", "time.add", "time.delete", "ticket.reply",
  "member.invite", "invite.cancel", "invite.resend", "member.role", "member.guest",
  "sso.mapping.add", "sso.mapping.delete", "grant.set", "group.create", "group.member",
  "template.save", "template.update", "template.delete", "template.restore", "template.apply",
  "capture.record", "capture.target", "bookmarks.import",
  "calendar.feed", "calendar.feed.revoke", "calendar.caldav", "calendar.caldav.revoke",
  "webhook.delete", "inbound.save", "inbound.rotate", "inbound.delete",
  "issueSync.connect", "issueSync.disconnect", "issueSync.map", "issueSync.unmap",
  "calendarSync.map", "calendarSync.unmap", "calendarSync.disconnect", "meeting.note",
  "e2ee.identity.setup", "e2ee.identity.update", "e2ee.identity.reset", "e2ee.member.add", "e2ee.member.remove", "e2ee.rotate",
  "e2ee.append", "e2ee.compact", "e2ee.title",
] as const;
// Prefixes command() refuses for every API token.
export const tokenRefusedActionPrefixes = ["admin.", "token.", "ai."] as const;

type ActionDoc = { action: string; summary: string; description?: string; input: z.ZodObject; result?: z.ZodType };
const okResult = z.object({ ok: z.literal(true) });
const idResult = z.object({ id: uuid });
const cells = z.record(z.string(), z.unknown()).describe("Property values by property ID (the first property is the title).");
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
      title: str,
      kind: z.enum(["document", "database", "whiteboard", "journal", "dashboard", "notebook"]).optional().describe("Default: document"),
      parentId: uuid.optional().describe("Parent page in the same space"),
      databaseKind: z.enum(["tasks", "documents", "empty"]).optional(),
      templateId: z.string().max(100).optional().describe("A saved page template of the workspace"),
      starterTemplate: z.string().max(100).optional().describe("A built-in starter template key"),
    }),
    result: idResult,
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
    action: "row.repeat",
    summary: "Make a record repeat when it is done",
    description:
      "Needs editor rights on the record. When the record becomes done (the database's done rule), a copy is created with `field` (a date property) moved to the next occurrence and other dates moved by as many days. Monthly and yearly rules keep the day of the month (`day`, default: the current date's day); `weekdays` (1 = Monday) picks days of a weekly rule. `repeat: null` removes the rule.",
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
      spaceId: uuid.optional().describe("Move into another space"),
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
    action: "favorite",
    summary: "Add a page to or remove it from the favourites",
    input: z.object({ action: z.literal("favorite"), pageId: uuid, value: z.boolean() }),
    result: okResult,
  },
  {
    action: "database.update",
    summary: "Change the properties and views of a database",
    description: "`version` must be the database's current version (optimistic locking, 409 otherwise).",
    input: z.object({
      action: z.literal("database.update"),
      pageId: uuid,
      version: z.number().int(),
      fields: z.array(field).min(1).max(80),
      views: z.array(view).min(1).max(30).optional(),
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
    description: "`version` must match the record's current version; properties not named stay as they are.",
    input: z.object({
      action: z.literal("row.update"),
      pageId: uuid,
      rowId: uuid,
      version: z.number().int(),
      cells: cells.optional(),
    }),
    result: okResult,
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
    input: z.object({ action: z.literal("rows.import"), pageId: uuid, rows: z.array(cells).max(5000) }),
    result: okResult,
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
      "Needs editor rights. Adds `count` (default 1) empty sheets after the sheet `after` (null or missing: at the end), optionally with their own `paper` (template blank, lined-college, lined-wide, grid, dotted, cornell, music; size a4 or letter; orientation portrait or landscape; color light or dark). The ink of a sheet is read and written with GET/POST /api/pages/{id}/ink?surface={sheetId}. Other notebook actions: notebook.sheet.duplicate {sheetId}, notebook.sheet.delete {sheetId}, notebook.sheet.move {order}, notebook.sheet.paper {sheetIds, paper|null}, notebook.paper {paper, all?}, notebook.import {fileId, pages: [{width, height}], after?} – all answer with the notebook's paper and sheets.",
    input: z.object({
      action: z.literal("notebook.sheet.add"),
      pageId: uuid,
      after: z.string().max(40).nullable().optional(),
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
      sheets: z.array(z.object({ id: z.string(), position: z.number(), paper: z.object({}).passthrough(), background: z.object({}).passthrough().nullable() })),
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
    summary: "Connect GitHub or GitLab for issue sync",
    description:
      "Workspace owners and administrators. Without `id` a new connection (token required); with `id` an update (the token stays unless given). The token is stored encrypted. Self-hosted servers only when listed in ISSUE_SYNC_ALLOWED_HOSTS. Check the token first with POST /api/issue-sync `{ op: \"test\" }`.",
    input: z.object({
      action: z.literal("issueSync.connect"),
      workspaceId: uuid,
      id: uuid.optional().describe("Existing connection to update"),
      provider: z.enum(["github", "gitlab"]),
      baseUrl: z.string().max(500).optional().describe("Self-hosted server, e.g. https://gitlab.example.org; empty for github.com or gitlab.com"),
      repo: z.string().max(300).optional().describe("Default repository: `owner/name` (GitHub) or `group/project` (GitLab)"),
      token: z.string().max(1000).optional(),
      people: z.array(z.object({ login: z.string().max(100), email: z.string().max(200) })).max(500).optional().describe("Login ↔ e-mail of a member, for assignees"),
    }),
    result: idResult,
  },
  {
    action: "issueSync.disconnect",
    summary: "Remove a GitHub or GitLab connection",
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
      "The widgets of your start page (kind, size, settings) and its look, versioned (`version: 1`, see lib/home-layout-schema.ts). `scope: \"workspace\"` keeps it for this workspace, `\"personal\"` makes it your default for every workspace without its own. At most " + MAX_HOME_WIDGETS + " widgets and " + MAX_LAYOUT_BYTES + " bytes. `home.reset` goes back one step, `home.note` saves the text of one note widget, `home.default` (owners) sets the layout members see by default.",
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
      title: { type: "string" },
      icon: { type: "string" },
      cover: { type: "string" },
      cover_position: { type: "number" },
      kind: { type: "string", enum: ["document", "database", "whiteboard", "journal", "dashboard", "notebook"] },
      position: { type: "number" },
      deleted_at: { type: ["string", "null"] },
      created_by: { type: "string", format: "uuid" },
      updated_at: { type: "string" },
      locked: { type: "integer", description: "1 when locked" },
      public_token: { type: ["string", "null"] },
      full_width: { type: "integer" },
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
    },
    required: ["id", "title", "icon", "space_id", "kind", "snippet"],
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
    properties: { pageId: { type: "string", format: "uuid" }, text: { type: "string" }, done: { type: "boolean" }, due: { type: ["string", "null"] } },
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
    properties: { signupOpen: { type: "boolean" }, demo: { type: "boolean" }, sso: { type: "boolean" } },
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
  429: "Too many requests; wait for `Retry-After` seconds (MCP) or try again later",
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
  { path: "/api/search", method: "get", op: { id: "search", tag: "Workspace", summary: "Full-text search", description: `Pages, records, comments and file contents of a workspace. ${noStore}`, params: [workspace, q("q", "Search words", { type: "string" }, true), q("kind", "Only this kind", { type: "string", enum: ["all", "document", "database", "whiteboard", "row", "comment", "file"], default: "all" }), q("space", "Only in this space", { type: "string", format: "uuid" }), q("days", "0: leave out journal days (they are ranked after other pages otherwise)", { type: "string", enum: ["0", "1"] })], ok: { schema: { type: "array", items: ref("SearchResult") }, description: "Matches" }, errors: [400, 401, 403] } },
  { path: "/api/notifications", method: "get", op: { id: "notifications", tag: "Workspace", summary: "My newest notifications", description: "What the inbox shows, in short: the line in the reader's language (`Accept-Language` or the language cookie), the record title as `detail`, where it leads and whether push is switched on for its kind (`push`, false for a page that is gone or no longer readable). Without `since` the latest 20; with `since` (server time, e.g. a previous `createdAt`) up to 50 from that second on, newest first. `unread` counts every unread notification. The desktop app polls this instead of Web Push. Marked read with `notification.mark` or `notification.read` via POST /api/command.", params: [q("since", "Server time (ISO 8601 or milliseconds)")], ok: { schema: { type: "object", properties: { now: { type: "string", format: "date-time" }, unread: { type: "integer", minimum: 0 }, notifications: { type: "array", items: { type: "object", properties: { id: { type: "string" }, kind: { type: ["string", "null"] }, text: { type: "string" }, detail: { type: "string" }, url: { type: "string", description: "Path on this instance, e.g. `/#page=…`" }, createdAt: { type: "string", format: "date-time" }, read: { type: "boolean" }, push: { type: "boolean" } }, required: ["id", "kind", "text", "detail", "url", "createdAt", "read", "push"] } } }, required: ["now", "unread", "notifications"] }, description: "Notifications" }, errors: [400, 401] } },
  { path: "/api/tasks", method: "get", op: { id: "tasks", tag: "Workspace", summary: "My tasks", description: "Tasks in documents assigned to you (`tasks`) and the ones you wrote for others (`others`).", params: [workspace, q("done", "`1` for completed tasks", { type: "string", enum: ["0", "1"] })], ok: { schema: { type: "object", properties: { tasks: { type: "array", items: ref("Task") }, others: { type: "array", items: ref("Task") } }, required: ["tasks", "others"] }, description: "Tasks" }, errors: [400, 401, 403] } },
  { path: "/api/records", method: "get", op: { id: "records", tag: "Workspace", summary: "Records across all databases", description: "With an optional filter (JSON, same shape as a view filter group) and the saved record views.", params: [workspace, q("filter", "Filter as JSON")], ok: { schema: { type: "object", additionalProperties: true }, description: "Records with their databases and views" }, errors: [400, 401, 403] } },
  { path: "/api/export", method: "get", op: { id: "exportWorkspace", tag: "Workspace", summary: "Whole workspace as JSON", description: "Every readable page outside the trash with its content; records only as far as you may see them.", params: [workspace], ok: { schema: ref("WorkspaceExport"), description: "The export (Content-Disposition: attachment)" }, errors: [401, 403] } },
  { path: "/api/offline/changes", method: "get", op: { id: "offlineChanges", tag: "Workspace", summary: "What changed for an offline copy", description: "Every page you may read now (outside the trash, no journal behind a PIN) and, since `since`, the pages and visible records whose content changed. Without `since` (or one older than the change log) `full` is true and every page counts as changed. Pass `now` as the next `since`.", params: [workspace, q("since", "Server time of the previous answer (ISO 8601 or milliseconds)")], ok: { schema: { type: "object", properties: { now: { type: "string", format: "date-time" }, full: { type: "boolean" }, pages: { type: "array", items: { type: "string", format: "uuid" } }, changed: { type: "array", items: { type: "string", format: "uuid" } }, rows: { type: "object", additionalProperties: { type: "array", items: { type: "string", format: "uuid" } } } }, required: ["now", "full", "pages", "changed", "rows"] }, description: "Readable and changed pages" }, errors: [400, 401, 403] } },
  { path: "/api/offline/assets", method: "get", op: { id: "offlineAssets", tag: "Workspace", summary: "The app's files for an offline copy", description: "Every file of the running client build under `/_next/static` (scripts, styles, fonts, workers) with its size, followed by the fonts (`/fonts.css`, `/fonts/*.woff2`) and icons the app's page loads from `public`, the build id and the version. A device that keeps an offline copy stores them in a cache named after the build, so parts of the app never opened online load offline as well – also in the iPhone and iPad app, which has no service worker to catch the fonts as they load.", ok: { schema: { type: "object", properties: { build: { type: "string" }, version: { type: "string" }, bytes: { type: "integer" }, files: { type: "array", items: { type: "object", properties: { path: { type: "string" }, size: { type: "integer" } }, required: ["path", "size"] } } }, required: ["build", "version", "bytes", "files"] }, description: "Files of the client build" }, errors: [401] } },
  { path: "/api/graph", method: "get", op: { id: "graph", tag: "Workspace", summary: "Links between pages as a graph", params: [workspace, q("days", "Journal days: left out, one node per journal and month, or each day", { type: "string", enum: ["hide", "month", "show"], default: "hide" })], ok: { schema: { type: "object", additionalProperties: true }, description: "Nodes and edges" }, errors: [400, 401, 403] } },
  { path: "/api/related", method: "get", op: { id: "related", tag: "Workspace", summary: "Related pages, or pages with a similar title", description: `With \`page\` (and \`row\`): related pages and records (\`items\` with their \`reasons\`) – by meaning when semantic search is on for you, else by links, backlinks, shared links, tags and title. With \`workspace\` and \`title\`: existing pages, or records of \`database\`, with a similar title (duplicate hint). Only what you may read. ${noStore}`, params: [q("page", "Page or database ID", { type: "string", format: "uuid" }), q("row", "Record ID", { type: "string", format: "uuid" }), q("workspace", "Workspace ID (with title)", { type: "string", format: "uuid" }), q("title", "Title to compare"), q("database", "Only records of this database (with title)", { type: "string", format: "uuid" }), q("exclude", "Page to leave out (with title)", { type: "string", format: "uuid" }), q("excludeRow", "Record to leave out (with title)", { type: "string", format: "uuid" })], ok: { schema: { type: "object", additionalProperties: true }, description: "Items" }, errors: [400, 401, 403, 404] } },
  { path: "/api/templates", method: "get", op: { id: "templates", tag: "Workspace", summary: "Saved page templates of a workspace", params: [workspace], ok: { schema: { type: "array", items: { type: "object", additionalProperties: true } }, description: "Templates" }, errors: [401, 403] } },
  { path: "/api/media", method: "get", op: { id: "media", tag: "Workspace", summary: "Media library", description: "Files of the pages you may read, 60 per call.", params: [workspace, q("kind", "Only this kind", { type: "string", enum: ["all", "image", "video", "audio", "pdf", "other"], default: "all" }), q("q", "Name contains"), q("offset", "Paging offset", { type: "integer", minimum: 0 })], ok: { schema: { type: "object", additionalProperties: true }, description: "Files with their pages" }, errors: [401, 403] } },
  { path: "/api/citations", method: "get", op: { id: "citations", tag: "Workspace", summary: "Bibliography of a workspace", params: [workspace], ok: { schema: { type: "object", properties: { items: { type: "array", items: { type: "object", additionalProperties: true } } }, required: ["items"] }, description: "Items" }, errors: [400, 401, 403] } },
  { path: "/api/capture", method: "get", op: { id: "captureTargets", tag: "Workspace", summary: "Databases to capture into, and your default", params: [workspace], ok: { schema: { type: "object", additionalProperties: true }, description: "Targets" }, errors: [400, 401, 403] } },
  { path: "/api/capture/targets", method: "get", op: { id: "desktopCaptureTargets", tag: "Workspace", summary: "Where quick capture can save", description: `For the desktop app's quick capture: the inbox (null when none is set), every database and document you may add to and the journals you may write in (today's entry), with what the shorthand fills in a database and its record templates. Pages of end-to-end encrypted spaces are never targets (\`encryptedExcluded\` counts them). \`voice\`: the instance transcribes voice notes; \`suggest\`: AI suggestions on the server and/or the device. ${noStore}`, ok: { schema: { type: "object", properties: { inbox: { type: ["object", "null"] }, targets: { type: "array", items: { type: "object" } }, encryptedExcluded: { type: "integer" }, voice: { type: "boolean" }, suggest: { type: ["object", "null"] }, maxFiles: { type: "integer" }, maxUploadMb: { type: "number" } }, required: ["inbox", "targets"], additionalProperties: true }, description: "Targets" }, errors: [401, 403] } },
  { path: "/api/capture/preview", method: "post", op: { id: "capturePreview", tag: "Workspace", summary: "Quick capture shorthand as chips", description: "Reads a text like `Angebot schreiben morgen 15 Uhr #kunde @anna !hoch` (German, English, French) for a target: a due date with time, tags, a person and a priority – each mapped to a property the target database has, or left as text. Chip ids in `literal` stay text. Nothing is saved.", body: { content: "application/json", schema: { type: "object", properties: { targetId: { type: "string" }, text: { type: "string", maxLength: 20000 }, today: { type: "string", format: "date" }, literal: { type: "array", items: { type: "string" }, maxItems: 50 }, task: { type: "boolean" }, locale: { type: "string", enum: ["de", "en", "fr"] } }, required: ["text", "today"], additionalProperties: false }, required: true }, ok: { schema: { type: "object", properties: { title: { type: "string" }, text: { type: "string" }, chips: { type: "array", items: { type: "object" } } }, required: ["chips"], additionalProperties: true }, description: "Title, text and chips" }, errors: [400, 401, 403, 404, 409] } },
  { path: "/api/capture/save", method: "post", op: { id: "captureSave", tag: "Workspace", summary: "Save a quick capture", description: "JSON, or multipart/form-data with the fields and up to 10 `file` parts (images, PDFs, Markdown or text files – their text –, a voice note with `transcribe`). The shorthand is read again (`parse`, `literal`) with the capturing computer's `today` and `timeZone`. Into a database as a record (properties from the shorthand, `templateId` for a record template, accepted AI values in `cells`), appended to a page, or to today's journal entry (a journal's id). Send an `Idempotency-Key`: a retry saves nothing twice.", write: true, body: { content: "application/json", schema: { type: "object", properties: { targetId: { type: "string" }, text: { type: "string", maxLength: 20000 }, parse: { type: "boolean" }, literal: { type: "array", items: { type: "string" } }, task: { type: "boolean" }, today: { type: "string", format: "date" }, timeZone: { type: "string" }, locale: { type: "string", enum: ["de", "en", "fr"] }, url: { type: "string", maxLength: 2000 }, linkTitle: { type: "string" }, linkDescription: { type: "string" }, linkProvider: { type: "string" }, linkImage: { type: "string" }, templateId: { type: "string" }, transcribe: { type: "boolean" }, cells: { type: "object", additionalProperties: true } }, required: ["today"], additionalProperties: false }, required: true }, ok: { schema: { type: "object", properties: { ok: { type: "boolean" }, kind: { type: "string", enum: ["record", "append"] }, pageId: { type: "string" }, rowId: { type: "string" }, url: { type: "string" }, title: { type: "string" }, undo: { type: "object" }, files: { type: "array", items: { type: "string" } } }, required: ["ok", "kind", "pageId", "url"], additionalProperties: true }, description: "Where it was saved" }, errors: [400, 401, 403, 404, 409, 413, 422, 423] } },
  { path: "/api/capture/undo", method: "post", op: { id: "captureUndo", tag: "Workspace", summary: "Take a quick capture back", description: "A captured record goes to the trash (your own only); appended blocks are removed while they are still the last ones, unchanged (`undo` from the save's answer).", write: true, body: { content: "application/json", schema: { type: "object", properties: { kind: { type: "string", enum: ["record", "append"] }, pageId: { type: "string", format: "uuid" }, rowId: { type: "string", format: "uuid" }, blocks: { type: "integer" }, digest: { type: "string" } }, required: ["kind", "pageId"] }, required: true }, ok: { schema: { type: "object", properties: { undone: { type: "boolean" }, reason: { type: "string" } }, required: ["undone"] }, description: "Whether it was taken back" }, errors: [400, 401, 403, 404, 409] } },
  { path: "/api/synced", method: "get", op: { id: "syncedBlocks", tag: "Workspace", summary: "Synced blocks of a workspace", params: [workspace], ok: { schema: { type: "object", properties: { blocks: { type: "array", items: { type: "object", additionalProperties: true } } }, required: ["blocks"] }, description: "Blocks" }, errors: [400, 401, 403] } },
  { path: "/api/trash/rows", method: "get", op: { id: "rowTrash", tag: "Workspace", summary: "Records in the trash", params: [workspace], ok: { schema: { type: "array", items: { type: "object", additionalProperties: true } }, description: "Trashed records with their databases" }, errors: [400, 401, 403] } },
  { path: "/api/settings", method: "get", op: { id: "workspaceSettings", tag: "Workspace", summary: "Invitations, groups and grants of a workspace", description: "Owners only.", params: [workspace], ok: { schema: { type: "object", additionalProperties: true }, description: "Settings" }, errors: [401, 403] } },
  { path: "/api/command", method: "post", op: { id: "command", tag: "Workspace", summary: "Change something", description: "The same actions the interface sends: one JSON object with `action` and its fields. Write tokens only; `admin.*`, `token.*` and `ai.*` are refused for every token. Bodies up to 10 MB. Actions that send mail (`member.invite`, `page.share`) are limited to 40 per hour per person (429).", write: true, body: { content: "application/json", schema: ref("Command"), required: true }, ok: { schema: ref("CommandResult"), description: "The result of the action" }, errors: [400, 401, 403, 404, 409, 413, 429] } },
  // Pages
  { path: "/api/pages/{pageId}", method: "get", op: { id: "getPage", tag: "Pages", summary: "A page with its content", description: "Documents with their HTML, databases with properties, views and the records you may see (`rows`, with `preview` instead of the full document), whiteboards with their elements. The header `X-Flowplan-Visit: 1` records a visit (read receipts).", params: [p("pageId", "Page ID")], ok: { schema: ref("PageData"), description: "The page" }, errors: [401, 403, 404] } },
  { path: "/api/pages/{pageId}/preview", method: "get", op: { id: "pagePreview", tag: "Pages", summary: "Short preview of a page", description: noStore, params: [p("pageId", "Page ID")], ok: { schema: { type: "object", additionalProperties: true }, description: "Title, icon and the first lines" }, errors: [401, 403, 404] } },
  { path: "/api/pages/{pageId}/shares", method: "get", op: { id: "pageShares", tag: "Pages", summary: "Who has access to exactly this page", params: [p("pageId", "Page ID")], ok: { schema: { type: "object", additionalProperties: true }, description: "People, groups and links" }, errors: [401, 403, 404] } },
  { path: "/api/pages/{pageId}/unlinked", method: "get", op: { id: "unlinkedMentions", tag: "Pages", summary: "Texts naming this page without a link", params: [p("pageId", "Page ID")], ok: { schema: { type: "object", properties: { mentions: { type: "array", items: { type: "object", additionalProperties: true } } }, required: ["mentions"] }, description: "Mentions" }, errors: [401, 403, 404] } },
  { path: "/api/pages/{pageId}/snapshots/{snapshotId}/changes", method: "get", op: { id: "snapshotChanges", tag: "Pages", summary: "What a version changed", params: [p("pageId", "Page ID"), p("snapshotId", "Version ID"), q("against", "Compare with this version instead of the current content", { type: "string", format: "uuid" })], ok: { schema: { type: "object", additionalProperties: true }, description: "The differences" }, errors: [401, 403, 404] } },
  { path: "/api/pages/{pageId}/linked/{databaseId}", method: "get", op: { id: "linkedDatabase", tag: "Pages", summary: "A database embedded in a page (linked view)", params: [p("pageId", "Page ID"), p("databaseId", "Page ID of the database")], ok: { schema: { type: "object", additionalProperties: true }, description: "Database and rows" }, errors: [401, 403, 404] } },
  { path: "/api/pages/{pageId}/import-markdown", method: "post", op: { id: "importMarkdownRecords", tag: "Pages", summary: "Markdown files as records of a database", description: "One or more `.md` files or a ZIP (100 MB together); frontmatter becomes properties. `dryRun=1` only reports what would change.", write: true, params: [p("pageId", "Page ID of the database")], body: { content: "multipart/form-data", schema: { type: "object", properties: { file: { type: "array", items: { type: "string", format: "binary" } }, dryRun: { type: "string", enum: ["0", "1"] }, createMissing: { type: "string", enum: ["0", "1"], description: "Add properties the files use" }, updateExisting: { type: "string", enum: ["0", "1"], description: "Update records with the same ID" } }, required: ["file"] }, required: true }, ok: { schema: { type: "object", additionalProperties: true }, description: "What was (or would be) imported" }, errors: [400, 401, 403, 404, 413] } },
  // Records
  { path: "/api/pages/{pageId}/rows/{rowId}", method: "get", op: { id: "getRow", tag: "Records", summary: "A record with its document", params: [p("pageId", "Page ID of the database"), p("rowId", "Record ID")], ok: { schema: ref("RowDocument"), description: "The record" }, errors: [401, 403, 404] } },
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
  { path: "/api/maintenance", method: "get", op: { id: "maintenanceNotice", tag: "Workspace", summary: "Scheduled maintenance announced by the administration", description: "`notice` is null when none is announced or it has ended. " + noStore, ok: { schema: { type: "object", properties: { notice: { type: ["object", "null"], properties: { message: { type: "string" }, start: { type: "integer", description: "Unix time in ms" }, end: { type: "integer", description: "Unix time in ms" } } } }, required: ["notice"] }, description: "The notice" }, errors: [401] } },
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
  // Journal
  { path: "/api/journals/{journalId}/review", method: "get", op: { id: "journalReview", tag: "Journal", summary: "Review of a period", params: [p("journalId", "Page ID of the journal"), q("from", "YYYY-MM-DD", { type: "string", format: "date" }, true), q("to", "YYYY-MM-DD", { type: "string", format: "date" }, true)], ok: { schema: { type: "object", additionalProperties: true }, description: "Days, trackers and entries" }, errors: [400, 401, 403, 404] } },
  { path: "/api/journals/{dayId}/events", method: "get", op: { id: "journalEvents", tag: "Journal", summary: "Appointments of a journal day", params: [p("dayId", "Page ID of the day page"), q("zone", "IANA time zone, default UTC")], ok: { schema: { type: "object", additionalProperties: true }, description: "Events" }, errors: [400, 401, 403, 404] } },
  // End-to-end encrypted spaces: ciphertext only
  { path: "/api/e2ee/identity", method: "get", op: { id: "e2eeIdentity", tag: "Encryption", summary: "My key pair as stored on the server", description: "The public key and the private key wrapped with the passphrase and with the recovery key (opaque to the server); null before setup.", ok: { schema: { type: "object", additionalProperties: true }, description: "Identity" }, errors: [401] } },
  { path: "/api/e2ee/spaces/{spaceId}", method: "get", op: { id: "e2eeSpaceKeys", tag: "Encryption", summary: "Sealed keys and key holders of an encrypted space", params: [p("spaceId", "Space ID")], ok: { schema: { type: "object", additionalProperties: true }, description: "Key version, my sealed keys, members holding the key" }, errors: [401, 403, 404] } },
  { path: "/api/e2ee/spaces/{spaceId}/archive", method: "get", op: { id: "e2eeArchive", tag: "Encryption", summary: "Encrypted archive of a space", description: "Every document as encrypted snapshot and updates, encrypted titles, my sealed space keys and my wrapped private key. Decryptable with the passphrase or the recovery key only.", params: [p("spaceId", "Space ID")], ok: { schema: { type: "object", additionalProperties: true }, description: "The archive (Content-Disposition: attachment)" }, errors: [401, 403, 404] } },
  { path: "/api/e2ee/pages/{pageId}/log", method: "get", op: { id: "e2eeLog", tag: "Encryption", summary: "Encrypted updates of a document", description: "The encrypted snapshot (when `after` is before it) and every encrypted update after `after`.", params: [p("pageId", "Page ID"), q("after", "Last sequence number already known", { type: "integer", minimum: 0 })], ok: { schema: { type: "object", additionalProperties: true }, description: "Snapshot and updates" }, errors: [400, 401, 403, 404] } },
  // Files
  { path: "/api/files/{fileId}", method: "get", op: { id: "getFile", tag: "Files", summary: "Download a file", description: "Needs read access to the page the file belongs to. Supports `Range` requests.", params: [p("fileId", "File ID")], ok: { content: "application/octet-stream", description: "The file with its own content type" }, errors: [401, 403, 404] } },
  { path: "/api/upload", method: "post", op: { id: "uploadFile", tag: "Files", summary: "Upload a file to a page", description: "The size limit is the person's upload limit (default 50 MB). Photos lose their location data. `purpose=cover` requires an image. Pages of encrypted spaces take only client-encrypted files with `purpose=e2ee`.", write: true, body: { content: "multipart/form-data", schema: { type: "object", properties: { pageId: { type: "string", format: "uuid" }, file: { type: "string", format: "binary" }, purpose: { type: "string", enum: ["cover", "e2ee"] } }, required: ["pageId", "file"] }, required: true }, ok: { schema: ref("FileInfo"), description: "The stored file" }, errors: [400, 401, 403, 404, 409, 413] } },
  { path: "/api/files/placeholders", method: "get", op: { id: "imagePlaceholders", tag: "Files", summary: "Placeholders of images", description: "Size and ThumbHash of uploaded images, for showing a blurred preview in the right proportions while the image loads. `ids` lists up to 100 file IDs and `avatar:<user ID>` entries. Only files you may download and profile pictures you may see are answered; anything else is left out, as are files without a placeholder. Placeholders of older files are computed on the first request.", params: [q("ids", "Comma-separated file IDs and `avatar:<user ID>` entries", { type: "string" }, true)], ok: { schema: { type: "object", properties: { placeholders: { type: "object", additionalProperties: ref("ImagePlaceholder") } }, required: ["placeholders"] }, description: "Placeholders by ID" }, errors: [400, 401] } },
  { path: "/api/avatars/{userId}", method: "get", op: { id: "avatar", tag: "Files", summary: "Profile picture of a person you share a workspace with", params: [p("userId", "User ID")], ok: { content: "image/*", description: "The picture" }, errors: [401, 404] } },
  // Import and export
  { path: "/api/export/docx", method: "get", op: { id: "exportDocx", tag: "Import and export", summary: "A page or record as a Word file", description: "Reads only, so read tokens may use it. `row` picks one record of the database `page`.", params: [q("page", "Page ID", { type: "string", format: "uuid" }, true), q("row", "Record ID (one record of the database)", { type: "string", format: "uuid" })], ok: { content: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", description: "The DOCX file (Content-Disposition: attachment)" }, errors: [400, 401, 403, 404, 413] } },
  { path: "/api/export/pdf", method: "get", op: { id: "exportPrintView", tag: "Import and export", summary: "A page with sub-pages or a whole space as one print view", description: "Reads only. Either `page` (with `children=1` its sub-pages) or `space`. Answers with an HTML print view (cover, table of contents, one chapter per page) that a browser turns into a PDF; at most 200 pages.", params: [q("page", "Page ID", { type: "string", format: "uuid" }), q("children", "`1` includes the sub-pages", { type: "string", enum: ["0", "1"] }), q("space", "Space ID", { type: "string", format: "uuid" })], ok: { content: "text/html", description: "The print view" }, errors: [400, 401, 403, 404, 413] } },
  { path: "/api/export/epub", method: "get", op: { id: "exportEpub", tag: "Import and export", summary: "A page tree or a whole space as an e-book", description: "Reads only. Either `page` (with `children=1` its sub-pages) or `space`; EPUB 3 with one chapter per page, at most 200 pages.", params: [q("page", "Page ID", { type: "string", format: "uuid" }), q("children", "`1` includes the sub-pages", { type: "string", enum: ["0", "1"] }), q("space", "Space ID", { type: "string", format: "uuid" })], ok: { content: "application/epub+zip", description: "The EPUB file (Content-Disposition: attachment)" }, errors: [400, 401, 403, 404, 413] } },
  { path: "/api/markdown-export", method: "post", op: { id: "markdownExport", tag: "Import and export", summary: "Export a page, record or space as Markdown", description: "Reads only, so read tokens may use it. `markdown` answers with one file, `zip` with an archive (files, sub-pages, history).", body: { content: "application/json", schema: ref("MarkdownExportOptions"), required: true }, ok: { content: "application/octet-stream", description: "`text/markdown` or `application/zip` (Content-Disposition: attachment)" }, errors: [400, 401, 403, 404, 413] } },
  { path: "/api/backup", method: "get", op: { id: "exportBackup", tag: "Import and export", summary: "Workspace backup as ZIP", description: "Streams everything you may read, with files.", params: [workspace], ok: { content: "application/zip", description: "The archive" }, errors: [400, 401, 403] } },
  { path: "/api/backup", method: "post", op: { id: "importBackup", tag: "Import and export", summary: "Restore a workspace backup", description: "Write tokens of an editor. The body is the ZIP itself, up to 2 GB.", write: true, params: [workspace], body: { content: "application/zip", schema: { type: "string", format: "binary" }, required: true }, ok: { schema: { type: "object", additionalProperties: true }, description: "What was imported" }, errors: [400, 401, 403, 413] } },
  { path: "/api/import/zip", method: "post", op: { id: "importZip", tag: "Import and export", summary: "Import a ZIP of Markdown, HTML or Notion pages into a space", write: true, body: { content: "multipart/form-data", schema: { type: "object", properties: { workspaceId: { type: "string", format: "uuid" }, spaceId: { type: "string", format: "uuid" }, file: { type: "string", format: "binary", description: "Up to 100 MB" } }, required: ["workspaceId", "spaceId", "file"] }, required: true }, ok: { schema: { type: "object", additionalProperties: true }, description: "The pages created" }, errors: [400, 401, 403, 413] } },
  { path: "/api/import/source", method: "post", op: { id: "importSource", tag: "Import and export", summary: "Import from Confluence, Evernote, Google Docs or Obsidian", description: "Confluence space export (HTML or XML ZIP), Evernote `.enex` (several in a ZIP), Google Takeout ZIP or a single `.html`/`.docx`, Obsidian vault ZIP. `source` defaults to `auto` (recognised from the file). `mode=database` creates one new database (tags, dates, folder, source as properties) instead of a page tree. `dryRun=1` only answers with the preview (counts and warnings).", write: true, body: { content: "multipart/form-data", schema: { type: "object", properties: { workspaceId: { type: "string", format: "uuid" }, spaceId: { type: "string", format: "uuid" }, file: { type: "string", format: "binary", description: "Up to 100 MB" }, source: { type: "string", enum: ["auto", "confluence", "evernote", "gdocs", "obsidian"] }, mode: { type: "string", enum: ["pages", "database"] }, dryRun: { type: "string", enum: ["0", "1"] } }, required: ["workspaceId", "spaceId", "file"] }, required: true }, ok: { schema: { type: "object", additionalProperties: true }, description: "Preview (source, title, pages, folders, files, bytes, tags, warnings) or, without dryRun, also rootIds, rows and databaseId" }, errors: [400, 401, 403, 413] } },
  { path: "/api/import/tracker", method: "post", op: { id: "importTracker", tag: "Import and export", summary: "Jira (CSV) or Trello (JSON) into a new database", write: true, body: { content: "multipart/form-data", schema: { type: "object", properties: { workspaceId: { type: "string", format: "uuid" }, spaceId: { type: "string", format: "uuid" }, file: { type: "string", format: "binary", description: "Up to 30 MB" } }, required: ["workspaceId", "spaceId", "file"] }, required: true }, ok: { schema: { type: "object", additionalProperties: true }, description: "The database created" }, errors: [400, 401, 403, 413] } },
  { path: "/api/templates/import", method: "post", op: { id: "importTemplate", tag: "Import and export", summary: "Import a template archive", write: true, body: { content: "multipart/form-data", schema: { type: "object", properties: { workspaceId: { type: "string", format: "uuid" }, file: { type: "string", format: "binary", description: "`.flowplan-template.zip`, up to 100 MB" }, private: { type: "string", enum: ["true", "false"] } }, required: ["workspaceId", "file"] }, required: true }, ok: { schema: { type: "object", additionalProperties: true }, description: "The template" }, errors: [400, 401, 403, 413] } },
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
  { path: "/api/inbound-mail/{token}", method: "post", op: { id: "receiveInboundMail", tag: "Tokens and webhooks", summary: "Receive an e-mail (for mail providers)", description: "External: the secret token of the address is the authorization; no bearer token. Accepts the generic JSON format (`from`, `to`, `subject`, `text`, `html`, `messageId`, `date`, `attachments[]` with base64 `content`, or `raw` for a whole message), multipart/form-data with the same fields, Mailgun, Postmark and SendGrid Inbound Parse posts, and raw `message/rfc822`. With a signing key the request needs `X-Flowplan-Signature: sha256=<HMAC of the body>` or Mailgun's signature fields. 60 mails per address and hour (429). Answers 200 for stored, duplicate (same Message-ID) and rejected (sender not allowed) mail.", security: "none", params: [p("token", "Token of the inbound address", { type: "string" })], body: { content: "application/json", schema: { type: "object", additionalProperties: true }, required: true }, ok: { schema: { type: "object", additionalProperties: true }, description: "Result: stored, duplicate or rejected" }, errors: [400, 401, 404, 409, 413, 415, 429] } },
  { path: "/api/issue-sync", method: "get", op: { id: "issueSync", tag: "Records", summary: "GitHub/GitLab issue sync: connections, a database's mapping or a record's issue", description: "`workspace` lists the connections (owners and administrators); `page` the mapping and status of a database; `page` with `row` the linked issue or null.", params: [q("workspace", "Workspace ID", { type: "string", format: "uuid" }), q("page", "Page ID of the database", { type: "string", format: "uuid" }), q("row", "Record ID", { type: "string", format: "uuid" })], ok: { schema: { type: "object", additionalProperties: true }, description: "Status" }, errors: [400, 401, 403, 404] } },
  { path: "/api/issue-sync", method: "post", op: { id: "issueSyncAction", tag: "Records", summary: "Test a GitHub/GitLab connection or sync a database now", description: "`{ op: \"test\", workspaceId, provider, baseUrl, repo, token | id }` makes one API call with the token; `{ op: \"run\", pageId }` pulls and pushes now. Rate limits of the provider (403/429) pause the connection until `Retry-After`.", write: true, body: { content: "application/json", schema: { type: "object", properties: { op: { type: "string", enum: ["test", "run"] }, pageId: { type: "string", format: "uuid" }, workspaceId: { type: "string", format: "uuid" } }, required: ["op"], additionalProperties: true }, required: true }, ok: { schema: { type: "object", additionalProperties: true }, description: "The result" }, errors: [400, 401, 403, 404, 429] } },
  { path: "/api/webhooks/update", method: "post", op: { id: "updateWebhook", tag: "Tokens and webhooks", summary: "Change a webhook", description: "Owners with a write token: events, database, format, templates, settings, credentials and (checked again) the address. The secret stays.", write: true, body: { content: "application/json", schema: ref("WebhookUpdate"), required: true }, ok: { schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] }, description: "Changed" }, errors: [400, 401, 403, 404] } },
  { path: "/api/webhooks/test", method: "post", op: { id: "testWebhook", tag: "Tokens and webhooks", summary: "Send a test message", description: "Owners with a write token. Sends a sample message (event `test`) right away, without retries, and answers with the result.", write: true, body: { content: "application/json", schema: { type: "object", properties: { workspaceId: { type: "string", format: "uuid" }, id: { type: "string" } }, required: ["workspaceId", "id"] }, required: true }, ok: { schema: ref("WebhookTestResult"), description: "Result of the delivery" }, errors: [400, 401, 403, 404] } },
  { path: "/api/calendar-feed", method: "get", op: { id: "calendarFeedStatus", tag: "Tokens and webhooks", summary: "Whether a calendar view has an iCalendar link or CalDAV access", params: [q("page", "Page ID of the database", { type: "string", format: "uuid" }, true), q("view", "View ID", { type: "string" }, true)], ok: { schema: { type: "object", properties: { active: { type: "boolean" }, caldav: { type: "boolean" } }, required: ["active", "caldav"] }, description: "Status" }, errors: [400, 401, 403, 404] } },
  { path: "/api/calendar/{token}.ics", method: "get", op: { id: "calendarFeed", tag: "Calendar", summary: "iCalendar feed of a calendar view", description: "External: the secret link (from `calendar.feed`) is the authorization; no bearer token. Subscribe to it in a calendar program.", security: "none", params: [p("token", "Feed token", { type: "string" })], ok: { content: "text/calendar", description: "The feed" }, errors: [404] } },
  // Block extensions (lib/plugins.ts)
  { path: "/api/plugins", method: "get", op: { id: "listPlugins", tag: "Extensions", summary: "Block extensions of a workspace or of a page's workspace", description: "With `workspace`: every member sees the enabled plugins, owners also switched-off ones. With `page`: the enabled plugins of that page's workspace. Each plugin with its blocks (absolute frame addresses), granted and requested permissions, frame size and settings. Changed with `plugin.update` and removed with `plugin.delete` via POST /api/command.", params: [q("workspace", "Workspace ID", { type: "string", format: "uuid" }), q("page", "Page ID", { type: "string", format: "uuid" })], ok: { schema: { type: "object", properties: { plugins: { type: "array", items: { type: "object", additionalProperties: true } }, canManage: { type: "boolean" } }, required: ["plugins"] }, description: "Plugins" }, errors: [400, 401, 403, 404] } },
  { path: "/api/plugins", method: "post", op: { id: "registerPlugin", tag: "Extensions", summary: "Register a block extension by its manifest address", description: "Workspace owners, in the browser (API tokens are refused). The server fetches `flowplan-plugin.json` (HTTPS, an origin on PLUGIN_ALLOWED_ORIGINS unless the administration allows any), validates it and grants the permissions it requests; `databases` picks the databases for a bare `read:database`. Registering the same address again refreshes the manifest.", write: true, body: { content: "application/json", schema: { type: "object", properties: { workspaceId: { type: "string", format: "uuid" }, url: { type: "string", maxLength: 2000 }, databases: { type: "array", items: { type: "string", format: "uuid" }, maxItems: 20 } }, required: ["workspaceId", "url"] }, required: true }, ok: { schema: { type: "object", additionalProperties: true }, description: "The plugin" }, errors: [400, 401, 403, 409] } },
  { path: "/api/plugins/{pluginId}/query", method: "get", op: { id: "queryPluginDatabase", tag: "Extensions", summary: "Records of a database a plugin was granted", description: "What a plugin frame's `query` message returns: at most `limit` (default 50, max 200) records with the caller's own rights – hidden records and properties stay hidden.", params: [p("pluginId", "Plugin ID"), q("page", "Page with the plugin block", { type: "string", format: "uuid" }, true), q("database", "Page ID of the granted database", { type: "string", format: "uuid" }, true), q("limit", "Number of records", { type: "integer", minimum: 1, maximum: 200 })], ok: { schema: { type: "object", additionalProperties: true }, description: "Fields and records" }, errors: [400, 401, 403, 404] } },
  // Custom domains for publications (lib/custom-domains.ts)
  { path: "/api/domains", method: "get", op: { id: "publicationDomain", tag: "Extensions", summary: "Custom domain and look of a publication", description: "The domain with its verification record (TXT `_flowplan-verify.<host>`) and file, and the publication's theme. Set with `domain.add`, `domain.remove` and `publication.theme` via POST /api/command.", params: [q("page", "Page ID of the publication", { type: "string", format: "uuid" }, true)], ok: { schema: { type: "object", additionalProperties: true }, description: "Domain and theme" }, errors: [400, 401, 403, 404] } },
  { path: "/api/domains/verify", method: "post", op: { id: "verifyPublicationDomain", tag: "Extensions", summary: "Verify a publication's custom domain", description: "Checks the TXT record `_flowplan-verify.<host>`, then `https://<host>/.well-known/flowplan-verify.txt`. Needs edit rights on the page.", write: true, body: { content: "application/json", schema: { type: "object", properties: { pageId: { type: "string", format: "uuid" } }, required: ["pageId"] }, required: true }, ok: { schema: { type: "object", additionalProperties: true }, description: "Domain status and the method that matched (or null)" }, errors: [400, 401, 403, 404] } },
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
  // MCP
  { path: "/api/mcp", method: "post", op: { id: "mcp", tag: "MCP", summary: "MCP server (Streamable HTTP, JSON answers)", description: "For AI assistants. Only API tokens sign in; read tokens get the reading tools, write tokens all. 120 calls per person and minute, then 429 with `Retry-After`. Tools: list_workspaces, list_pages, search, read_page, query_database, get_record, my_tasks, create_page, append_to_page, create_record, update_record.", body: { content: "application/json", schema: ref("McpRequest"), required: true }, ok: { schema: ref("McpResponse"), description: "The JSON-RPC answer (202 without a body for notifications)" }, errors: [400, 401, 403, 413, 429] } },
];

// Route files under app/api that the specification leaves out on purpose:
// they are not for API tokens. tests/openapi.test.ts checks that every
// other route file has at least one path here.
export const routesOutsideSpec: Record<string, string> = {
  "app/api/issue-sync/hook/[token]/route.ts": "GitHub/GitLab issue webhooks, verified by their own token and signature",
  "app/api/admin/instance-backup/route.ts": "Administration only; tokens never administer",
  "app/api/admin/directory/route.ts": "Administration only; tokens never administer",
  "app/api/admin/operations/route.ts": "Administration only; tokens never administer",
  "app/api/admin/summary/route.ts": "Administration only; tokens never administer",
  "app/api/admin/monitoring/route.ts": "Administration only; tokens never administer",
  "app/api/admin/push/route.ts": "Administration only; tokens never administer",
  "app/api/scim/v2/[...path]/route.ts": "SCIM 2.0 (RFC 7643/7644) is its own standard with its own bearer tokens; discovery at /api/scim/v2/ServiceProviderConfig",
  "app/api/ai/[...path]/route.ts": "AI features refuse API tokens",
  "app/api/auth/[action]/route.ts": "Browser sign-in and account settings",
  "app/api/calendar-sync/[...path]/route.ts": "Browser OAuth connection to Google and Microsoft 365 calendars",
  "app/api/forms/[token]/route.ts": "Public forms with their own link token",
  "app/api/git/[token]/route.ts": "Git integration callbacks with their own token",
  "app/api/mobile/[action]/route.ts": "The mobile apps (session cookie or device token: registration with push relay token and encryption key, Live Activity relay tokens; the administrators' widget summary only for instance administrators)",
  "app/api/mobile/notifications/route.ts": "Buttons on the mobile apps' push notifications, only with the device token",
  "app/api/calendar-profile/route.ts": "Apple configuration profile with CalDAV accounts: created from the browser's account settings, downloaded once by its link",
  "app/api/print/[token]/route.ts": "Print views of the browser app",
  "app/api/print/route.ts": "Print views of the browser app",
  "app/api/public-templates/[id]/files/[fileId]/route.ts": "Public template gallery",
  "app/api/share/[token]/route.ts": "Share links with their own token",
  "app/api/share/[token]/files/route.ts": "Share links with their own token",
  "app/api/share/[token]/files/[fileId]/route.ts": "Share links with their own token",
  "app/api/share/[token]/files/[fileId]/ink/route.ts": "Share links with their own token",
  "app/api/share/[token]/ink/route.ts": "Share links with their own token",
  "app/api/share/[token]/live/route.ts": "Share links with their own token",
  "app/api/share/[token]/unlock/route.ts": "Share links with their own token",
  "app/api/tickets/[token]/route.ts": "Service desk links for customers",
  "app/api/transcribe/[...path]/route.ts": "Voice notes of the browser app (chunked upload to the transcription service)",
  "app/api/whiteboards/[id]/facilitation/route.ts": "Workshop facilitation on whiteboards (private mode, planning poker, gathering everyone) of the browser app",
  "app/api/webhooks/slack/[id]/route.ts": "Slack Event Subscriptions of a Slack webhook, signed with its signing secret",
};

const appBase = () => (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");

// Operations that take an Idempotency-Key (lib/idempotency.ts): applied once
// per key, retries answered from the store. The SDKs send one per call and
// keep it when they retry.
export const idempotentOperations = new Set([
  "command",
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
  const errors = [...new Set([...(o.errors ?? [400, 401, 403, 404]), ...(idempotent ? [409, 422] : [])])];
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
    { name: "Files", description: "Uploads and downloads." },
    { name: "Encryption", description: "End-to-end encrypted spaces: keys and ciphertext, never content." },
    { name: "Import and export", description: "Markdown, ZIP archives, backups and the Git export." },
    { name: "Tokens and webhooks", description: "Your tokens, and webhooks that tell other services about changes." },
    { name: "Calendar", description: "iCalendar feeds. CalDAV (`/api/caldav/…`, PROPFIND and REPORT, basic auth with the access created by `calendar.caldav`) is served outside this document." },
    { name: "MCP", description: "The Model Context Protocol server for AI assistants." },
    { name: "Extensions", description: "Block extensions (plugins rendered in sandboxed frames) and custom domains for publications." },
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
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "fp_…", description: "A personal API token with read, write or clipper scope." },
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
