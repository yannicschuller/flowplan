import { withRequestLocale } from "@/lib/content-locale";
import { listPlugins, pluginsForPage, publicPlugin, queryPluginDatabase, registerPlugin } from "@/lib/plugins";
import { domainAllowed, domainRobots, domainSettings, domainSitemap, verifyDomain } from "@/lib/custom-domains";
import { aiAllowedUsers, instanceAiSettings } from "@/lib/ai/settings";
import { teamThread } from "@/lib/service-desk";
import { readablePrefixes, resolveTicket } from "@/lib/ticket-refs";
import { recordTime, timeReport } from "@/lib/time-tracking";
import { sprintCharts } from "@/lib/sprints";
import { gitConfig, gitLinks } from "@/lib/git-integration";
import { crossRecords, recordViews } from "@/lib/cross-records";
import { hasCalDavAccess } from "@/lib/caldav";
import { withMeetingNotes } from "@/lib/meeting-notes";
import { transferTargets } from "@/lib/row-transfer";
import { computeMetric, metricSchema, metricSources } from "@/lib/dashboard-metric";
import { requireBodySize, sanitizeFileName, stripLocation, verifiedMime } from "@/lib/upload-safety";
import { boardCursors, moveCursor, watchBoard } from "@/lib/whiteboard-presence";
import { storageOverview } from "@/lib/storage-overview";
import { offlineChanges, parseSince } from "@/lib/offline-changes";
import { offlineAssets } from "@/lib/offline-assets-server";
import { notificationFeed } from "@/lib/notification-feed";
import { avatarFor } from "@/lib/avatars";
import { mediaLibrary } from "@/lib/media-library";
import { resolveEmbed } from "@/lib/oembed";
import { instanceSettings } from "@/lib/instance-settings";
import { pendingRestore } from "@/lib/instance-backup";
import { linkedDatabaseData } from "@/lib/linked-databases";
import { editorPresence } from "@/lib/editor-presence";
import { inlineThreads, inlineMentionCandidates } from "@/lib/inline-comments";
import { imageMimes } from "@/lib/page-appearance";
import { after } from "next/server";
import { cookies } from "next/headers";
import {
  pushKeys,
  subscribePush,
  unsubscribePush,
  dispatchPush,
} from "@/lib/push";
import { sendTestPush } from "@/lib/push-test";
import { listPageTemplates } from "@/lib/page-templates";
import { fileResponse } from "@/lib/file-response";
import { publicFile } from "@/lib/publication";
import { withShareRequest } from "@/lib/share-access";
import { requireRow, rowDocumentData } from "@/lib/row-documents";
import { documentKey, publishPresence, watchDocument } from "@/lib/document-live";
import { calendarFeed, hasCalendarFeed } from "@/lib/calendar-feed";
import { listApiTokens } from "@/lib/api-tokens";
import { createWebhook, listWebhooks, testWebhook, updateWebhook, webhookEvents } from "@/lib/webhooks";
import { listSsoMappings, ssoSources } from "@/lib/sso-mappings";
import { mailStatus, sendTestMail } from "@/lib/mail";
import { runScheduledBackup, scheduledBackupStatus } from "@/lib/scheduled-backup";
import { encryptExisting, encryptionOverview } from "@/lib/encryption-status";
import { pageShares } from "@/lib/page-share";
import { documentLog, encryptedArchive, identityOf, isEncryptedPage, requirePlaintext, requirePlaintextSpace, spaceKeys } from "@/lib/e2ee-server";
import { exportablePages, markdownExportStatus, runMarkdownExports, setMarkdownExport } from "@/lib/scheduled-markdown-export";
import { runSpaceGitExport, spaceGitOverview, spaceGitStatus } from "@/lib/space-git-export";
import { NextResponse } from "next/server";
import { z } from "zod";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  requireUser,
  currentUser,
  checkOrigin,
  HttpError,
  adminGroup,
  cookieName,
  rememberPolicy,
  hash,
  inviteToken,
} from "@/lib/auth";
import { bootstrap, pageData, command, rows, database } from "@/lib/api";
import {
  requirePage,
  requireMember,
  requireAdmin,
  pageRole,
} from "@/lib/permissions";
import { one, all, run, id, audit } from "@/lib/db";
import type { Page } from "@/lib/types";
import { searchWorkspace } from "@/lib/search-index";
import { rowSnapshotChanges, snapshotChanges } from "@/lib/version-history";
import { importZip } from "@/lib/zip-import";
import { importWhiteboardFile } from "@/lib/whiteboard-import-server";
import { documentAuthors } from "@/lib/document-authors";
import { bibliography, bibliographyForDoi, resolveDoi } from "@/lib/citations-server";
import { transaction } from "@/lib/db";
import { BOARD_IMPORT_LIMITS } from "@/lib/whiteboard-import";
import { importMarkdownRecords, markdownEntries } from "@/lib/markdown-records";
import { captureTargets } from "@/lib/capture";
import { listInboundAddresses } from "@/lib/inbound-mail";
import { endMySessions, mySessions } from "@/lib/my-sessions";
import { pageToRecordPlan } from "@/lib/page-to-record";
import { recordToPagePlan } from "@/lib/record-to-page";
import { importTracker } from "@/lib/tracker-import";
import { trackJob } from "@/lib/background-jobs";
import { recordBacklinks } from "@/lib/relation-backlinks";
import { hiddenFileIds } from "@/lib/row-files";
import { pagePreview } from "@/lib/page-preview";
import { withActivity } from "@/lib/page-activity";
import { myTasks, otherWorkspaceTasks } from "@/lib/doc-tasks";
import { homeAction, homeData, homeOptions } from "@/lib/home-widgets";
import { localAccountInfo, localLoginEnabled } from "@/lib/local-auth";
import { listSyncedBlocks } from "@/lib/synced-blocks";
import { pageGraph, unlinkedMentions } from "@/lib/page-graph";
import { clipArticle } from "@/lib/web-clip";
import { downloadImage, searchImages } from "@/lib/image-search";
import { whiteboardRowCards } from "@/lib/whiteboard-cards";
import { transcribe } from "@/lib/transcribe";
import { journalDate } from "@/lib/journal";
import {
  calendarEvents,
  databaseEvents,
  journalReview,
  requireUnlocked,
  lockedPageIds,
} from "@/lib/journal-extras";
import { visibleRows } from "@/lib/row-access";
import { readableDatabase } from "@/lib/field-access";
import { listRowTrash } from "@/lib/row-trash";
import { ARCHIVE_LIMIT } from "@/lib/archive";
import { buildInfo } from "@/lib/build-info";
import { updateStatus } from "@/lib/update-check";
import { enforceUserStorage, maxUploadMbFor, usersUsage } from "@/lib/user-limits";
import { exportTemplate, importTemplate } from "@/lib/template-exchange";
import {
  enforceQuota,
  instanceMetrics,
  workspaceUsage,
} from "@/lib/instance-ops";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
function error(e: unknown) {
  if (e instanceof z.ZodError)
    return NextResponse.json(
      { error: "Ungültige Eingabe.", details: e.issues.map((i) => i.message) },
      { status: 400 },
    );
  if (!(e instanceof HttpError)) console.error(e);
  return NextResponse.json(
    {
      error:
        e instanceof HttpError
          ? e.message
          : "Die Anfrage konnte nicht verarbeitet werden.",
    },
    { status: e instanceof HttpError ? e.status : 500 },
  );
}
export const GET = withRequestLocale(handleGET);
async function handleGET(
  req: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  try {
    const { path } = await params;
    const url = new URL(req.url);
    // Block extensions on published pages (lib/plugins.ts): only those the
    // owners allowed there.
    if (path.length === 4 && path[0] === "share" && path[2] === "plugins")
      return NextResponse.json(withShareRequest(req, () => publicPlugin(path[1], z.uuid().parse(path[3]))), {
        headers: { "Cache-Control": "no-store" },
      });
    // Custom domains (lib/custom-domains.ts): Caddy's on-demand TLS asks
    // whether a certificate may be requested – 200 only for verified domains.
    if (path.length === 2 && path[0] === "domains" && path[1] === "allowed") {
      const allowed = domainAllowed(url.searchParams.get("domain") || "");
      return new Response(allowed ? "ok" : "unknown", {
        status: allowed ? 200 : 404,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    // robots.txt and sitemap.xml of a custom domain (the proxy rewrites them
    // here); the Host decides, other hosts get nothing.
    if (path.length === 2 && path[0] === "domains" && (path[1] === "sitemap" || path[1] === "robots")) {
      const host = req.headers.get("host") || "";
      const body = path[1] === "sitemap" ? domainSitemap(host) : domainRobots(host);
      if (body === null) throw new HttpError(404, "Nicht gefunden.");
      return new Response(body, {
        headers: {
          "Content-Type": path[1] === "sitemap" ? "application/xml; charset=utf-8" : "text/plain; charset=utf-8",
          "Cache-Control": "public, max-age=3600",
        },
      });
    }
    // Keep public asset authorization identical when the catch-all handles the URL.
    if (path.length === 4 && path[0] === "share" && path[2] === "files")
      return await fileResponse(req, withShareRequest(req, () => publicFile(path[1], path[3])));
    // Calendar subscriptions: the secret link is the authorization.
    if (path.length === 2 && path[0] === "calendar" && path[1].endsWith(".ics"))
      return new Response(calendarFeed(path[1].slice(0, -4)), {
        headers: {
          "Content-Type": "text/calendar; charset=utf-8",
          "Cache-Control": "private, no-store",
          "Content-Disposition": 'inline; filename="flowplan.ics"',
        },
      });
    const user = await requireUser();
    if (path.length === 1 && path[0] === "tokens")
      return NextResponse.json(listApiTokens(user));
    // Choices for the start page's widget settings (lib/home-widgets.ts).
    if (path.length === 2 && path[0] === "home" && path[1] === "options")
      return NextResponse.json(
        homeOptions(user, { workspaceId: url.searchParams.get("workspace"), kind: url.searchParams.get("kind"), pageId: url.searchParams.get("page") }),
        { headers: { "Cache-Control": "no-store" } },
      );
    // Block extensions of a workspace (settings) or of a page's workspace (editor).
    if (path.length === 1 && path[0] === "plugins")
      return NextResponse.json(
        url.searchParams.get("page")
          ? pluginsForPage(user, z.uuid().parse(url.searchParams.get("page")))
          : listPlugins(user, z.uuid().parse(url.searchParams.get("workspace"))),
        { headers: { "Cache-Control": "no-store" } },
      );
    // A frame's database query: the reader's own rights, granted databases only.
    if (path.length === 3 && path[0] === "plugins" && path[2] === "query")
      return NextResponse.json(
        queryPluginDatabase(user, {
          pluginId: path[1],
          pageId: url.searchParams.get("page"),
          databaseId: url.searchParams.get("database"),
          limit: url.searchParams.get("limit") || undefined,
        }),
        { headers: { "Cache-Control": "no-store" } },
      );
    // The custom domain and look of a publication.
    if (path.length === 1 && path[0] === "domains")
      return NextResponse.json(domainSettings(user, z.uuid().parse(url.searchParams.get("page"))), {
        headers: { "Cache-Control": "no-store" },
      });
    if (path.length === 1 && path[0] === "webhooks")
      return NextResponse.json({
        webhooks: listWebhooks(user, z.uuid().parse(url.searchParams.get("workspace"))),
        events: webhookEvents,
      });
    if (path.length === 1 && path[0] === "calendar-feed")
      return NextResponse.json({
        active: hasCalendarFeed(
          user,
          z.uuid().parse(url.searchParams.get("page")),
          z.string().max(100).parse(url.searchParams.get("view")),
        ),
        caldav: hasCalDavAccess(user, z.uuid().parse(url.searchParams.get("page")), z.string().max(100).parse(url.searchParams.get("view"))),
      });
    if (path.length === 2 && path[0] === "admin" && path[1] === "audit.csv") {
      requireAdmin(user);
      const cell = (v: unknown) => {
        const text = String(v ?? "");
        // Spreadsheet programs must not run formulas from the log.
        const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
        return `"${safe.replace(/"/g, '""')}"`;
      };
      const rowsCsv = all<Record<string, unknown>>(
        "SELECT a.created_at,u.name,u.email,a.action,a.resource_id,a.detail FROM audit a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.created_at DESC LIMIT 100000",
      );
      const csv = [
        ["Zeitpunkt", "Person", "E-Mail", "Aktion", "Ressource", "Details"].map(cell).join(";"),
        ...rowsCsv.map((r) =>
          [r.created_at, r.name, r.email, r.action, r.resource_id, r.detail].map(cell).join(";"),
        ),
      ].join("\r\n");
      return new Response("\ufeff" + csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="flowplan-aktivitaet-${new Date().toISOString().slice(0, 10)}.csv"`,
          "Cache-Control": "no-store",
        },
      });
    }
    if (path.length === 2 && path[0] === "threads" && path[1] === "mentions")
      return NextResponse.json(
        inlineMentionCandidates(
          user,
          z.uuid().parse(url.searchParams.get("page")),
          url.searchParams.get("row")
            ? z.uuid().parse(url.searchParams.get("row"))
            : undefined,
          url.searchParams.get("q") || "",
        ),
        { headers: { "Cache-Control": "no-store" } },
      );
    if (path.length === 1 && path[0] === "threads")
      return NextResponse.json(
        inlineThreads(
          user,
          z.uuid().parse(url.searchParams.get("page")),
          url.searchParams.get("row")
            ? z.uuid().parse(url.searchParams.get("row"))
            : undefined,
          true,
          url.searchParams.get("thread")
            ? z.uuid().parse(url.searchParams.get("thread"))
            : undefined,
        ),
        { headers: { "Cache-Control": "no-store" } },
      );
    if (path[0] === "trash" && path[1] === "rows") {
      const wid = z.uuid().parse(url.searchParams.get("workspace"));
      requireMember(user, wid);
      return NextResponse.json(listRowTrash(user, wid));
    }
    // The newest notifications in short, for the desktop app (no push in
    // Electron, lib/notification-feed.ts).
    if (path.length === 1 && path[0] === "notifications")
      return NextResponse.json(notificationFeed(user, parseSince(url.searchParams.get("since"))), {
        headers: { "Cache-Control": "no-store" },
      });
    if (path[0] === "bootstrap")
      return NextResponse.json(
        bootstrap(user, url.searchParams.get("workspace") || undefined),
      );
    // Offline copies on a device: readable pages and what changed since.
    if (path.length === 2 && path[0] === "offline" && path[1] === "changes") {
      const wid = z.uuid().parse(url.searchParams.get("workspace"));
      return NextResponse.json(
        offlineChanges(user, wid, parseSince(url.searchParams.get("since"))),
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    // The app's own files for the offline copy (#47): every file of the
    // client build, so parts never opened online load offline as well.
    if (path.length === 2 && path[0] === "offline" && path[1] === "assets")
      return NextResponse.json(offlineAssets(), { headers: { "Cache-Control": "no-store" } });
    // Openly licensed images (Openverse) for boards and documents.
    if (path.length === 2 && path[0] === "images" && path[1] === "search") {
      if (user.demo) throw new HttpError(403, "In der Demo nicht verfügbar. Registriere dich, um das zu nutzen.");
      return NextResponse.json(
        { results: await searchImages(url.searchParams.get("q") || "", Number(url.searchParams.get("page") || 1)) },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    // Live data of database records shown as cards on a whiteboard.
    if (path.length === 3 && path[0] === "whiteboards" && path[2] === "cards") {
      requirePage(user, z.uuid().parse(path[1]));
      const refs = (url.searchParams.get("rows") || "")
        .split(",")
        .filter(Boolean)
        .slice(0, 200)
        .map((ref) => {
          const [pageId, rowId] = ref.split(":");
          return { pageId: z.uuid().parse(pageId), rowId: z.uuid().parse(rowId) };
        });
      return NextResponse.json({ cards: whiteboardRowCards(user, refs) }, { headers: { "Cache-Control": "no-store" } });
    }
    // Links between pages as a graph; texts naming a page without a link.
    if (path.length === 1 && path[0] === "graph") {
      const wid = z.uuid().parse(url.searchParams.get("workspace"));
      requireMember(user, wid);
      return NextResponse.json(pageGraph(user, wid), { headers: { "Cache-Control": "no-store" } });
    }
    if (path.length === 3 && path[0] === "pages" && path[2] === "unlinked") {
      const page = requirePage(user, z.uuid().parse(path[1]));
      requireUnlocked(user, page);
      return NextResponse.json({ mentions: unlinkedMentions(user, page) }, { headers: { "Cache-Control": "no-store" } });
    }
    if (path.length === 5 && path[0] === "pages" && path[2] === "rows" && path[4] === "unlinked") {
      const page = requirePage(user, z.uuid().parse(path[1]));
      requireUnlocked(user, page);
      const rowId = z.uuid().parse(path[3]);
      requireRow(user, page.id, rowId);
      return NextResponse.json({ mentions: unlinkedMentions(user, page, rowId) }, { headers: { "Cache-Control": "no-store" } });
    }
    // The person's own sessions (devices).
    if (path.length === 1 && path[0] === "sessions")
      return NextResponse.json(
        { sessions: mySessions(user, (await cookies()).get(cookieName)?.value), rememberAvailable: !!rememberPolicy() },
        { headers: { "Cache-Control": "no-store" } },
      );
    // Who has access to exactly this page (the share dialog).
    if (path.length === 3 && path[0] === "pages" && path[2] === "shares")
      return NextResponse.json(pageShares(user, z.uuid().parse(path[1])), { headers: { "Cache-Control": "no-store" } });
    // What moving a page into a database would change (confirmation).
    if (path.length === 3 && path[0] === "pages" && path[2] === "to-record") {
      const plan = pageToRecordPlan(user, z.uuid().parse(path[1]));
      const { page, ...rest } = plan;
      return NextResponse.json({ ...rest, title: page.title }, { headers: { "Cache-Control": "no-store" } });
    }
    // What turning a record into a page would change (confirmation).
    if (path.length === 5 && path[0] === "pages" && path[2] === "rows" && path[4] === "to-page") {
      const plan = recordToPagePlan(user, z.uuid().parse(path[1]), z.uuid().parse(path[3]));
      return NextResponse.json(
        {
          title: plan.title,
          properties: plan.properties.map(({ name, text }) => ({ name, text })),
          comments: plan.comments,
          versions: plan.versions,
          restricted: plan.restricted,
          relations: plan.relations,
          targets: plan.targets,
          target: plan.target,
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    // E-mail inbound addresses of a workspace (owners, lib/inbound-mail.ts).
    if (path.length === 1 && path[0] === "inbound-mail")
      return NextResponse.json(listInboundAddresses(user, z.uuid().parse(url.searchParams.get("workspace"))), { headers: { "Cache-Control": "no-store" } });
    // Databases to capture into, and the person's default.
    if (path.length === 1 && path[0] === "capture") {
      const wid = z.uuid().parse(url.searchParams.get("workspace"));
      return NextResponse.json(captureTargets(user, wid), { headers: { "Cache-Control": "no-store" } });
    }
    // Synced blocks that can be inserted into another page.
    if (path.length === 1 && path[0] === "synced") {
      const wid = z.uuid().parse(url.searchParams.get("workspace"));
      requireMember(user, wid);
      return NextResponse.json({ blocks: listSyncedBlocks(user, wid) }, { headers: { "Cache-Control": "no-store" } });
    }
    // Tasks in documents assigned to the person ("Meine Aufgaben").
    if (path.length === 1 && path[0] === "tasks") {
      const wid = z.uuid().parse(url.searchParams.get("workspace"));
      requireMember(user, wid);
      const done = url.searchParams.get("done") === "1";
      return NextResponse.json(
        { tasks: myTasks(user, wid, done), others: otherWorkspaceTasks(user, wid, done) },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    // Journal: review of a period, appointments of a day.
    if (path.length === 3 && path[0] === "journals" && path[2] === "review") {
      const journal = requirePage(user, z.uuid().parse(path[1]));
      if (journal.kind !== "journal") throw new HttpError(400, "Kein Journal.");
      requireUnlocked(user, journal);
      return NextResponse.json(
        journalReview(
          journal,
          journalDate.parse(url.searchParams.get("from")),
          journalDate.parse(url.searchParams.get("to")),
        ),
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    if (path.length === 3 && path[0] === "journals" && path[2] === "events") {
      const day = requirePage(user, z.uuid().parse(path[1]));
      if (!day.journal_date || !day.parent_id) throw new HttpError(400, "Kein Journaltag.");
      requireUnlocked(user, day);
      const zone = z.string().max(100).catch("UTC").parse(url.searchParams.get("zone") || "UTC");
      const events = databaseEvents(user, day.workspace_id, day.journal_date, zone);
      let calendarError = "";
      try {
        if (!user.demo) events.push(...(await calendarEvents(day.parent_id, day.journal_date, zone)));
      } catch (e) {
        calendarError = e instanceof HttpError ? e.message : "Der Kalender konnte nicht geladen werden.";
      }
      events.sort((a, b) => Number(a.timed) - Number(b.timed) || a.start.localeCompare(b.start));
      return NextResponse.json({ events: withMeetingNotes(user, day, events), calendarError }, { headers: { "Cache-Control": "no-store" } });
    }
    if (path[0] === "pages" && path[1] && path[2] === "preview")
      return NextResponse.json(pagePreview(user, z.uuid().parse(path[1])), {
        headers: { "Cache-Control": "no-store" },
      });
    if (path[0] === "pages" && path[2] === "linked" && path[3])
      return NextResponse.json(linkedDatabaseData(user, path[1], path[3]));
    // Embeddings inside a record document.
    if (
      path[0] === "pages" &&
      path[2] === "rows" &&
      path[3] &&
      path[4] === "linked" &&
      path[5]
    )
      return NextResponse.json(
        linkedDatabaseData(user, path[1], path[5], z.uuid().parse(path[3])),
      );
    if (
      path[0] === "pages" &&
      path[2] === "snapshots" &&
      path[3] &&
      path[4] === "changes"
    )
      return NextResponse.json(
        snapshotChanges(
          user,
          z.uuid().parse(path[1]),
          z.uuid().parse(path[3]),
          url.searchParams.get("against")
            ? z.uuid().parse(url.searchParams.get("against"))
            : undefined,
        ),
      );
    if (
      path[0] === "pages" &&
      path[2] === "rows" &&
      path[4] === "snapshots" &&
      path[5] &&
      path[6] === "changes"
    )
      return NextResponse.json(
        rowSnapshotChanges(
          user,
          z.uuid().parse(path[1]),
          z.uuid().parse(path[3]),
          z.uuid().parse(path[5]),
          url.searchParams.get("against")
            ? z.uuid().parse(url.searchParams.get("against"))
            : undefined,
        ),
      );
    if (
      path[0] === "pages" &&
      path[2] === "rows" &&
      path[3] &&
      path[4] === "backlinks"
    )
      return NextResponse.json(
        recordBacklinks(
          user,
          z.uuid().parse(path[1]),
          z.uuid().parse(path[3]),
        ),
      );
    if (path[0] === "pages" && path[2] === "rows" && path[3])
      return NextResponse.json(rowDocumentData(user, path[1], path[3]));
    // Opening a page (header X-Flowplan-Visit) records the visit: read
    // receipts and changes since then. Reloads and embeds do not.
    if (path[0] === "pages" && path[1])
      return NextResponse.json(
        withActivity(
          user,
          // Offline refreshes (X-Flowplan-Offline) and loading ahead on hover
          // (X-Flowplan-Prefetch, components/prefetch.ts) do not count as presence.
          pageData(user, path[1], {
            presence: req.headers.get("x-flowplan-offline") !== "1" && req.headers.get("x-flowplan-prefetch") !== "1",
          }),
          req.headers.get("x-flowplan-visit") === "1",
        ),
      );
    if (path[0] === "settings") {
      const wid = url.searchParams.get("workspace") || "";
      requireMember(user, wid, "owner");
      return NextResponse.json({
        // With who invited, when, the pages waiting for them and the link.
        invites: (() => {
          type Invite = { id: string; email: string; role: string; guest: number; created_at: number | null; token: string; inviter: string | null; pages: string | null };
          for (const open of all<{ id: string }>("SELECT id FROM invites WHERE workspace_id=? AND token IS NULL", wid))
            run("UPDATE invites SET token=? WHERE id=?", inviteToken(), open.id);
          return all<Invite>(
          `SELECT i.id,i.email,i.role,i.guest,i.created_at,i.token,u.name inviter,
             (SELECT json_group_array(p.title) FROM invite_grants g JOIN pages p ON p.id=g.resource_id WHERE g.workspace_id=i.workspace_id AND lower(g.email)=lower(i.email) AND p.deleted_at IS NULL) pages
           FROM invites i LEFT JOIN users u ON u.id=i.created_by WHERE i.workspace_id=? ORDER BY i.created_at DESC`,
          wid,
        ).map((i) => ({ ...i, pages: JSON.parse(i.pages || "[]") as string[] }));
        })(),
        groups: all("SELECT * FROM groups WHERE workspace_id=?", wid),
        groupMembers: all(
          "SELECT gm.* FROM group_members gm JOIN groups g ON g.id=gm.group_id WHERE g.workspace_id=?",
          wid,
        ),
        grants: all(
          "SELECT g.* FROM grants g WHERE resource_id IN (SELECT id FROM pages WHERE workspace_id=? UNION SELECT id FROM spaces WHERE workspace_id=?)",
          wid,
          wid,
        ),
        // SSO groups mapped to membership and groups, and what they granted.
        sso: !!process.env.OIDC_ISSUER,
        ssoMappings: listSsoMappings(wid),
        ssoSources: ssoSources(wid),
      });
    }
    if (path[0] === "search") {
      const wid = url.searchParams.get("workspace") || "";
      requireMember(user, wid);
      return NextResponse.json(
        searchWorkspace(user, wid, url.searchParams.get("q") || "", {
          kind: z
            .enum(["all", "document", "database", "whiteboard", "row", "comment", "file"])
            .catch("all")
            .parse(url.searchParams.get("kind") || "all"),
          spaceId: url.searchParams.get("space")
            ? z.uuid().parse(url.searchParams.get("space"))
            : undefined,
        }),
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    // Link previews and players for pasted URLs (server-side, SSRF-safe).
    if (path[0] === "embed") {
      // Link cards make the server load foreign pages; anonymous demo
      // guests must not use it as a fetch service (players work without).
      if (user.demo)
        throw new HttpError(
          403,
          "In der Demo nicht verfügbar. Registriere dich, um das zu nutzen.",
        );
      const raw = z
        .string()
        .min(8)
        .max(2000)
        .parse(url.searchParams.get("url"));
      return NextResponse.json(await resolveEmbed(raw), {
        headers: { "Cache-Control": "no-store" },
      });
    }
    // The workspace's bibliography for citations.
    if (path.length === 1 && path[0] === "citations")
      return NextResponse.json(
        { items: bibliography(user, z.uuid().parse(url.searchParams.get("workspace"))) },
        { headers: { "Cache-Control": "no-store" } },
      );
    // Who wrote what: the people behind the editor sessions of a document.
    if (path.length === 1 && path[0] === "document-authors") {
      const row = url.searchParams.get("row");
      return NextResponse.json(
        documentAuthors(user, z.uuid().parse(url.searchParams.get("page")), row ? z.uuid().parse(row) : null),
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    // Dashboards: one number from a database, and the databases to choose from.
    if (path[0] === "dashboard-metric") {
      const query = metricSchema.parse(Object.fromEntries(url.searchParams));
      return NextResponse.json(computeMetric(user, query), { headers: { "Cache-Control": "no-store" } });
    }
    if (path[0] === "time-entries") {
      // Time worked on a record (time tracking property).
      const page = requirePage(user, z.uuid().parse(url.searchParams.get("page")));
      return NextResponse.json(
        recordTime(user, page, z.uuid().parse(url.searchParams.get("row")), z.string().max(500).parse(url.searchParams.get("field"))),
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    if (path[0] === "transfer-targets")
      return NextResponse.json(transferTargets(user, z.uuid().parse(url.searchParams.get("page"))), { headers: { "Cache-Control": "no-store" } });
    if (path[0] === "records") {
      // Records across all databases (My tasks → records).
      const wid = z.uuid().parse(url.searchParams.get("workspace"));
      let filter: unknown = {};
      try {
        filter = JSON.parse(url.searchParams.get("filter") || "{}");
      } catch {
        throw new HttpError(400, "Ungültiger Filter.");
      }
      return NextResponse.json(
        { ...crossRecords(user, wid, filter), views: recordViews(user, wid) },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    // Git export of a space: only its owner sees the settings (no token).
    if (path.length === 3 && path[0] === "spaces" && path[2] === "git-export")
      return NextResponse.json(spaceGitStatus(user, z.uuid().parse(path[1])), { headers: { "Cache-Control": "no-store" } });
    if (path[0] === "git-config")
      return NextResponse.json(gitConfig(user, z.uuid().parse(url.searchParams.get("page"))), { headers: { "Cache-Control": "no-store" } });
    if (path[0] === "git-links")
      return NextResponse.json(gitLinks(user, z.uuid().parse(url.searchParams.get("page")), z.uuid().parse(url.searchParams.get("row"))), {
        headers: { "Cache-Control": "no-store" },
      });
    if (path[0] === "sprint-charts") {
      return NextResponse.json(
        sprintCharts(user, z.uuid().parse(url.searchParams.get("page")), z.string().max(60).parse(url.searchParams.get("sprint"))),
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    if (path[0] === "time-report") {
      const weeks = Math.min(26, Math.max(1, Number(url.searchParams.get("weeks")) || 8));
      return NextResponse.json(timeReport(user, z.uuid().parse(url.searchParams.get("page")), weeks), { headers: { "Cache-Control": "no-store" } });
    }
    if (path[0] === "ticket-refs" || path[0] === "ticket-ref") {
      // Ticket numbers (WEB-123) in the workspace of a page.
      const page = requirePage(user, z.uuid().parse(url.searchParams.get("page")));
      if (path[0] === "ticket-refs")
        return NextResponse.json(readablePrefixes(user, page.workspace_id), { headers: { "Cache-Control": "no-store" } });
      const found = resolveTicket(user, page.workspace_id, z.string().max(30).parse(url.searchParams.get("key")));
      if (!found) throw new HttpError(404, "Eintrag nicht gefunden.");
      return NextResponse.json(found, { headers: { "Cache-Control": "no-store" } });
    }
    if (path[0] === "ticket-thread") {
      // The customer conversation of a record (service desk).
      const pageId = z.uuid().parse(url.searchParams.get("page")),
        rowId = z.uuid().parse(url.searchParams.get("row"));
      return NextResponse.json(teamThread(user, pageId, rowId), { headers: { "Cache-Control": "no-store" } });
    }
    if (path[0] === "dashboard-sources") {
      // The workspace of the page the dashboard is on.
      const wid = requirePage(user, z.uuid().parse(url.searchParams.get("page"))).workspace_id;
      requireMember(user, wid);
      return NextResponse.json(metricSources(user, wid), { headers: { "Cache-Control": "no-store" } });
    }
    if (path[0] === "media") {
      const wid = url.searchParams.get("workspace") || "";
      return NextResponse.json(
        mediaLibrary(user, wid, {
          kind: z
            .enum(["all", "image", "video", "audio", "pdf", "other"])
            .catch("all")
            .parse(url.searchParams.get("kind") || "all"),
          query: url.searchParams.get("q") || "",
          offset: Number(url.searchParams.get("offset") || 0) || 0,
        }),
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    if (path[0] === "push") {
      const sessionToken = hash((await cookies()).get(cookieName)?.value || "");
      return NextResponse.json({
        publicKey: pushKeys().publicKey,
        subscribed: !!one(
          "SELECT id FROM push_subscriptions WHERE session_token=? AND user_id=?",
          sessionToken,
          user.id,
        ),
      });
    }
    if (path[0] === "templates" && path[1] && path[2] === "export") {
      const exported = await exportTemplate(
        user,
        z.uuid().parse(url.searchParams.get("workspace")),
        z.uuid().parse(path[1]),
      );
      return new NextResponse(new Uint8Array(exported.zip), {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(
            exported.name.replace(/[\\/:*?"<>|]/g, "_"),
          )}.flowplan-template.zip`,
          "Cache-Control": "no-store",
        },
      });
    }
    if (path[0] === "templates") {
      const wid = url.searchParams.get("workspace") || "";
      return NextResponse.json(listPageTemplates(user, wid));
    }
    // Live stream of an open document or record content: changes and cursor
    // moves of the others arrive as they happen (lib/document-live.ts).
    if (path.length === 2 && path[0] === "documents" && path[1] === "live") {
      const pageId = z.uuid().parse(url.searchParams.get("page"));
      const rowId = url.searchParams.get("row")
        ? z.uuid().parse(url.searchParams.get("row"))
        : null;
      const generation = z.string().min(1).max(100).parse(url.searchParams.get("generation"));
      const clientId = z.uuid().parse(url.searchParams.get("client"));
      const check = () => {
        if (rowId) requireRow(user, pageId, rowId);
        else {
          const page = requirePage(user, pageId);
          if (page.kind !== "document") throw new HttpError(400, "Kein Dokument.");
          requireUnlocked(user, page);
        }
      };
      check();
      const allowed = streamGuard(
        hash((await cookies()).get(cookieName)?.value || ""),
        check,
      );
      const encoder = new TextEncoder();
      let stop = () => {};
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const send = (chunk: string) => controller.enqueue(encoder.encode(chunk));
          const unwatch = watchDocument(documentKey(pageId, rowId, generation), clientId, send);
          // Every keepalive checks session and read access again: whoever
          // loses access stops receiving changes within 15 seconds.
          const ping = setInterval(() => {
            try {
              if (!allowed()) {
                send(`data: ${JSON.stringify({ type: "revoked" })}\n\n`);
                return stop();
              }
              send(": ping\n\n");
            } catch {
              stop();
            }
          }, 15_000);
          stop = () => {
            clearInterval(ping);
            unwatch();
            try {
              controller.close();
            } catch {}
          };
          req.signal.addEventListener("abort", () => stop());
        },
        cancel() {
          stop();
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no",
        },
      });
    }
    if (path.length === 3 && path[0] === "whiteboards" && path[2] === "cursors") {
      const page = requirePage(user, z.uuid().parse(path[1]));
      if (page.kind !== "whiteboard") throw new HttpError(400, "Kein Whiteboard.");
      const boardAllowed = streamGuard(
        hash((await cookies()).get(cookieName)?.value || ""),
        () => requirePage(user, page.id),
      );
      if (!(req.headers.get("accept") || "").includes("text/event-stream"))
        return NextResponse.json(boardCursors(page.id, user.id), {
          headers: { "Cache-Control": "no-store" },
        });
      // Live stream of the other cursors on this board.
      const encoder = new TextEncoder();
      let stop = () => {};
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const send = (chunk: string) => controller.enqueue(encoder.encode(chunk));
          const unwatch = watchBoard(page.id, user.id, send);
          const ping = setInterval(() => {
            try {
              if (!boardAllowed()) return stop();
              send(": ping\n\n");
            } catch {
              stop();
            }
          }, 15_000);
          stop = () => {
            clearInterval(ping);
            unwatch();
            try {
              controller.close();
            } catch {}
          };
          req.signal.addEventListener("abort", () => stop());
        },
        cancel() {
          stop();
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no",
        },
      });
    }
    if (path.length === 2 && path[0] === "admin" && path[1] === "storage") {
      requireAdmin(user);
      return NextResponse.json(await storageOverview(), {
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (path.length === 2 && path[0] === "admin" && path[1] === "export-pages") {
      requireAdmin(user);
      return NextResponse.json({ pages: exportablePages(user) }, { headers: { "Cache-Control": "no-store" } });
    }
    if (path[0] === "admin") {
      requireAdmin(user);
      return NextResponse.json({
        build: buildInfo(),
        update: await updateStatus(),
        userUsage: usersUsage(),
        users: all(
          "SELECT id,name,email,disabled,created_at,last_login_at FROM users WHERE demo_until IS NULL AND subject NOT LIKE 'deleted:%' ORDER BY created_at DESC",
        ),
        mail: mailStatus(),
        backup: scheduledBackupStatus(),
        markdownExport: markdownExportStatus(),
        spaceGitExport: spaceGitOverview(),
        encryption: encryptionOverview(),
        workspaces: all(
          "SELECT w.id,w.name,(SELECT count(*) FROM members WHERE workspace_id=w.id) members,(SELECT count(*) FROM pages WHERE workspace_id=w.id AND deleted_at IS NULL) pages FROM workspaces w",
        ),
        sessions: one(
          "SELECT count(*) count FROM sessions WHERE expires>?",
          Date.now(),
        )?.count,
        audit: all(
          "SELECT a.*,u.name FROM audit a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.created_at DESC LIMIT 100",
        ),
        adminGroup: adminGroup(),
        oidcConfigured: !!process.env.OIDC_ISSUER,
        // SSO group mappings of every workspace, with the groups to pick from.
        ssoMappings: listSsoMappings(),
        workspaceGroups: all("SELECT id,workspace_id,name FROM groups ORDER BY name"),
        metrics: instanceMetrics(),
        usage: workspaceUsage(),
        settings: instanceSettings(),
        localAccounts: localAccountInfo(),
        localLogin: localLoginEnabled(),
        restorePending: pendingRestore(),
        // Who may use AI when the administration chose "selected people".
        aiPolicy: { access: instanceAiSettings().access, enabled: instanceAiSettings().enabled, allowed: aiAllowedUsers() },
      });
    }
    // End-to-end encrypted spaces (lib/e2ee-server.ts): my wrapped key
    // pair, a space's sealed keys, a document's encrypted log and the
    // encrypted archive of a space. Ciphertext only.
    if (path[0] === "e2ee") {
      if (path.length === 2 && path[1] === "identity") return NextResponse.json({ identity: identityOf(user.id) });
      if (path.length === 3 && path[1] === "spaces") return NextResponse.json(spaceKeys(user, z.uuid().parse(path[2])));
      if (path.length === 4 && path[1] === "spaces" && path[3] === "archive")
        return NextResponse.json(encryptedArchive(user, z.uuid().parse(path[2])), {
          headers: { "Content-Disposition": 'attachment; filename="flowplan-encrypted-archive.json"', "Cache-Control": "private, no-store" },
        });
      if (path.length === 4 && path[1] === "pages" && path[3] === "log") {
        const after = z.coerce.number().int().min(0).parse(url.searchParams.get("after") || "0");
        return NextResponse.json(documentLog(user, z.uuid().parse(path[2]), after));
      }
      throw new HttpError(404, "Nicht gefunden.");
    }
    if (path.length === 2 && path[0] === "avatars") {
      const picture = avatarFor(user, z.uuid().parse(path[1]));
      if (!picture) throw new HttpError(404, "Kein Profilbild.");
      return new Response(Buffer.from(picture.data), {
        headers: {
          "Content-Type": picture.mime,
          // The URL carries the version, so it can be cached for long.
          "Cache-Control": "private, max-age=604800, immutable",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    if (path[0] === "files" && path[1]) {
      const file = one<{
        id: string;
        page_id: string;
        name: string;
        mime: string;
      }>("SELECT * FROM files WHERE id=?", path[1]);
      if (!file) throw new HttpError(404, "Datei fehlt.");
      const owner = requirePage(user, file.page_id);
      requireUnlocked(user, owner);
      // A file used only by a record hidden from this person stays hidden.
      if (hiddenFileIds(user, owner).has(file.id)) throw new HttpError(404, "Datei fehlt.");
      return await fileResponse(req, file);
    }
    if (path[0] === "export") {
      const wid = url.searchParams.get("workspace") || "";
      requireMember(user, wid);
      // Readable pages outside the trash, no journal behind a PIN, and only
      // the records this person may see.
      const locked = lockedPageIds(user, wid);
      const pages = all<Page>(
        "SELECT * FROM pages WHERE workspace_id=? AND deleted_at IS NULL",
        wid,
      ).filter((p) => !locked.has(p.id) && pageRole(user, p));
      return NextResponse.json(
        {
          format: "flowplan-1",
          exportedAt: new Date().toISOString(),
          workspace: one("SELECT name,icon FROM workspaces WHERE id=?", wid),
          pages: pages.map((p) => ({
            ...p,
            data:
              p.kind === "database"
                ? { database: readableDatabase(user, p, database(p.id)), rows: visibleRows(user, p, rows(p.id)) }
                : one("SELECT html FROM documents WHERE page_id=?", p.id),
          })),
        },
        {
          headers: {
            "Content-Disposition":
              'attachment; filename="flowplan-export.json"',
          },
        },
      );
    }
    throw new HttpError(404, "Nicht gefunden.");
  } catch (e) {
    return error(e);
  }
}
export const POST = withRequestLocale(handlePOST);
async function handlePOST(
  req: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  try {
    checkOrigin(req);
    const { path } = await params;
    // ZIP imports may be as large as content archives. File uploads must
    // state their size, so the limit holds before anything is read.
    const maxBody = path[0] === "import" || path[1] === "import" || path[2] === "import-markdown" ? ARCHIVE_LIMIT + 1_000_000 : 12_000_000;
    if (req.headers.get("content-type")?.startsWith("multipart/form-data"))
      requireBodySize(req, maxBody, "Anfrage zu groß.");
    else if (Number(req.headers.get("content-length") || 0) > maxBody)
      throw new HttpError(413, "Anfrage zu groß.");
    const user = await requireUser();
    // Every POST here changes something; read tokens only read (the
    // Markdown export has a route of its own).
    // The start page: data of its widgets (reads, but with the layout in
    // the body) and what its widgets do (lib/home-widgets.ts).
    if (path.length === 2 && path[0] === "home" && path[1] === "data")
      return NextResponse.json(homeData(user, await req.json()), { headers: { "Cache-Control": "no-store" } });
    if (user.apiScope === "read") throw new HttpError(403, "Dieses API-Token darf nur lesen.");
    if (path.length === 2 && path[0] === "home" && path[1] === "action")
      return NextResponse.json(await homeAction(user, await req.json()), { headers: { "Cache-Control": "no-store" } });
    // Block extensions: the manifest is fetched and checked (lib/plugins.ts).
    if (path.length === 1 && path[0] === "plugins")
      return NextResponse.json(await registerPlugin(user, await req.json()));
    // Custom domains: checks the TXT record or the verification file.
    if (path.length === 2 && path[0] === "domains" && path[1] === "verify")
      return NextResponse.json(await verifyDomain(user, await req.json()));
    // Owners register webhooks, also with a write API token (n8n trigger).
    if (path.length === 1 && path[0] === "webhooks")
      return NextResponse.json(await createWebhook(user, await req.json()));
    // Changing a webhook (format, templates, …) and its test message.
    if (path.length === 2 && path[0] === "webhooks" && path[1] === "update")
      return NextResponse.json(await updateWebhook(user, await req.json()));
    if (path.length === 2 && path[0] === "webhooks" && path[1] === "test")
      return NextResponse.json(await testWebhook(user, await req.json()));
    if (path.length === 2 && path[0] === "admin" && path[1] === "mail-test") {
      requireAdmin(user);
      const to = z.email().parse((await req.json()).to);
      await sendTestMail(to);
      return NextResponse.json({ ok: true });
    }
    // The pages of the scheduled Markdown export (lib/scheduled-markdown-export.ts).
    if (path.length === 2 && path[0] === "admin" && path[1] === "markdown-export") {
      requireAdmin(user);
      return NextResponse.json(setMarkdownExport(user, (await req.json().catch(() => ({}))).pageIds));
    }
    // Uploads the objects in the bucket that are not yet encrypted again.
    if (path.length === 2 && path[0] === "admin" && path[1] === "encrypt-existing") {
      requireAdmin(user);
      return NextResponse.json(encryptExisting(user));
    }
    // "Run now" in the Git export settings of a space.
    if (path.length === 4 && path[0] === "spaces" && path[2] === "git-export" && path[3] === "run")
      return NextResponse.json(await trackJob(user, "git", "Git", () => runSpaceGitExport(user, z.uuid().parse(path[1]))));
    if (path.length === 2 && path[0] === "admin" && path[1] === "backup-run") {
      requireAdmin(user);
      const backup = await runScheduledBackup();
      return NextResponse.json({ ...backup, exports: await runMarkdownExports() });
    }
    if (path.length === 3 && path[0] === "whiteboards" && path[2] === "cursor") {
      if (Number(req.headers.get("content-length") || 0) > 512)
        throw new HttpError(413, "Cursoranfrage zu groß.");
      const page = requirePage(user, z.uuid().parse(path[1]));
      if (page.kind !== "whiteboard") throw new HttpError(400, "Kein Whiteboard.");
      const body = z
        .object({
          x: z.number().finite().min(-1e7).max(1e7),
          y: z.number().finite().min(-1e7).max(1e7),
          laser: z.boolean().optional(),
          view: z
            .object({
              x: z.number().finite().min(-1e7).max(1e7),
              y: z.number().finite().min(-1e7).max(1e7),
              w: z.number().finite().min(1).max(1e6),
              h: z.number().finite().min(1).max(1e6),
            })
            .optional(),
        })
        .nullable()
        .parse(await req.json());
      moveCursor(page.id, user, body);
      return new Response(null, { status: 204 });
    }
    if (path.length === 1 && path[0] === "presence") {
      if (Number(req.headers.get("content-length") || 0) > 4096)
        throw new HttpError(413, "Cursoranfrage zu groß.");
      const reader = req.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader)
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 4096) {
            await reader.cancel();
            throw new HttpError(413, "Cursoranfrage zu groß.");
          }
          chunks.push(value);
        }
      let data: unknown;
      try {
        data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw new HttpError(400, "Ungültige Cursoranfrage.");
      }
      const presence = editorPresence(
        user,
        hash((await cookies()).get(cookieName)?.value || ""),
        data,
      );
      // A moved cursor reaches the others right away.
      if (presence.changed)
        publishPresence(presence.key, presence.clientId);
      return NextResponse.json(
        { peers: presence.peers },
        {
          headers: { "Cache-Control": "no-store" },
        },
      );
    }
    // An image from the image search, stored like an upload.
    if (path.length === 2 && path[0] === "images" && path[1] === "import") {
      if (user.demo || user.apiScope) throw new HttpError(403, "Hier nicht verfügbar.");
      const body = z
        .object({ pageId: z.uuid(), url: z.string().max(2000), credit: z.string().max(500).optional() })
        .parse(await req.json());
      const p = requirePage(user, body.pageId, true);
      if (p.locked) throw new HttpError(409, "Seite ist gesperrt");
      requirePlaintext(p);
      const maxUpload = maxUploadMbFor(user);
      const image = await downloadImage(body.url, Math.min(maxUpload, 15) * 1024 * 1024);
      enforceQuota(p.workspace_id, image.data.length);
      enforceUserStorage(user, image.data.length);
      const fid = id(),
        dir = resolve(process.env.FLOWPLAN_DATA_DIR || "./data", "uploads");
      await mkdir(dir, { recursive: true });
      await writeFile(resolve(dir, fid), image.data);
      const name = `${(body.credit || "Bild").replace(/[\\/:*?"<>|]+/g, " ").slice(0, 80)}.${image.ext}`;
      run(
        "INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)",
        fid,
        p.id,
        name,
        image.type,
        image.data.length,
        user.id,
      );
      audit(user.id, "file.upload", p.id, name);
      return NextResponse.json({ id: fid, url: `/api/files/${fid}`, name, mime: image.type });
    }
    // Voice notes: the recording goes to the local Whisper service.
    if (path.length === 1 && path[0] === "transcribe") {
      if (user.demo || user.apiScope)
        throw new HttpError(403, "Hier nicht verfügbar.");
      const data = await req.formData();
      // The recording would reach the transcription service as plaintext.
      requirePlaintext(requirePage(user, z.uuid().parse(data.get("pageId")), true));
      const file = data.get("file");
      if (!(file instanceof Blob) || !file.type.startsWith("audio/"))
        throw new HttpError(400, "Keine Aufnahme.");
      return NextResponse.json(await transcribe(file, file instanceof File ? file.name : undefined));
    }
    // Web clipper: the readable text of an article (server-side, SSRF-safe).
    if (path.length === 1 && path[0] === "clip") {
      if (user.demo)
        throw new HttpError(403, "In der Demo nicht verfügbar. Registriere dich, um das zu nutzen.");
      const body = z.object({ url: z.string().max(2000) }).parse(await req.json());
      return NextResponse.json(await clipArticle(body.url));
    }
    if (path[0] === "command") {
      const text = await req.text();
      if (text.length > 10_000_000)
        throw new HttpError(413, "Anfrage zu groß.");
      const result = command(user, JSON.parse(text));
      after(dispatchPush);
      return NextResponse.json(result);
    }
    if (path[0] === "push") {
      const sessionToken = hash((await cookies()).get(cookieName)?.value || "");
      const text = await req.text();
      if (text.length > 10000) throw new HttpError(413, "Anfrage zu groß.");
      const body = JSON.parse(text);
      const result =
        body.action === "unsubscribe"
          ? unsubscribePush(user, body.endpoint)
          : body.action === "test"
            ? // Waits (≤ 10 s) for the outcome per device (lib/push-test.ts).
              await sendTestPush(user, sessionToken)
            : body.action === "subscribe"
              ? subscribePush(user, sessionToken, body.subscription)
              : (() => {
                  throw new HttpError(400, "Unbekannte Push-Aktion.");
                })();
      after(dispatchPush);
      return NextResponse.json(result);
    }
    if (path[0] === "templates" && path[1] === "import") {
      const data = await req.formData();
      const file = data.get("file");
      if (!(file instanceof File)) throw new HttpError(400, "Datei fehlt.");
      if (file.size > ARCHIVE_LIMIT)
        throw new HttpError(413, "Vorlage darf maximal 100 MB groß sein.");
      return NextResponse.json(
        await importTemplate(
          user,
          z.uuid().parse(data.get("workspaceId")),
          Buffer.from(await file.arrayBuffer()),
          data.get("private") === "true" ? "private" : "workspace",
        ),
      );
    }
    if (path[0] === "import" && path[1] === "tracker") {
      // Jira (CSV) or Trello (JSON) into a new database.
      const data = await req.formData();
      const file = data.get("file");
      if (!(file instanceof File)) throw new HttpError(400, "Datei fehlt.");
      if (file.size > 30 * 1024 * 1024) throw new HttpError(413, "Die Datei darf maximal 30 MB groß sein.");
      requirePlaintextSpace({ id: z.uuid().parse(data.get("spaceId")) });
      const text = await file.text();
      const kind = /\.json$/i.test(file.name) || text.trimStart().startsWith("{") ? "trello" : "jira";
      return NextResponse.json(
        await trackJob(user, "import", file.name, () =>
          importTracker(user, z.uuid().parse(data.get("workspaceId")), z.uuid().parse(data.get("spaceId")), kind, text, file.name),
        ),
      );
    }
    // Markdown files (one, several or a ZIP) as records of a database.
    if (path.length === 3 && path[0] === "pages" && path[2] === "import-markdown") {
      const data = await req.formData();
      const files = data.getAll("file").filter((f): f is File => f instanceof File);
      if (!files.length) throw new HttpError(400, "Datei fehlt.");
      if (files.reduce((sum, f) => sum + f.size, 0) > ARCHIVE_LIMIT)
        throw new HttpError(413, "Die Dateien dürfen zusammen maximal 100 MB groß sein.");
      const entries = new Map<string, Buffer>();
      for (const file of files)
        for (const [name, bytes] of await markdownEntries(file.name, Buffer.from(await file.arrayBuffer())))
          entries.set(entries.has(name) ? `${entries.size}-${name}` : name, bytes);
      const records = () =>
        importMarkdownRecords(user, z.uuid().parse(path[1]), entries, {
          dryRun: data.get("dryRun") === "1",
          createMissing: data.get("createMissing") === "1",
          updateExisting: data.get("updateExisting") === "1",
        });
      return NextResponse.json(data.get("dryRun") === "1" ? records() : await trackJob(user, "import", files[0].name, records));
    }
    // Confluence, Evernote, Google Docs and Obsidian (lib/importers):
    // dryRun=1 answers with a preview (counts and warnings) only.
    if (path.length === 2 && path[0] === "import" && path[1] === "source") {
      const data = await req.formData();
      const file = data.get("file");
      if (!(file instanceof File)) throw new HttpError(400, "Datei fehlt.");
      if (file.size > ARCHIVE_LIMIT) throw new HttpError(413, "Die Datei darf maximal 100 MB groß sein.");
      const { importFromSource } = await import("@/lib/importers");
      const dryRun = data.get("dryRun") === "1";
      const bytes = Buffer.from(await file.arrayBuffer());
      const imported = () =>
        importFromSource(
          user,
          z.uuid().parse(data.get("workspaceId")),
          z.uuid().parse(data.get("spaceId")),
          { name: file.name, bytes },
          {
            source: z.enum(["auto", "confluence", "evernote", "gdocs", "obsidian"]).catch("auto").parse(data.get("source") || "auto"),
            mode: data.get("mode") === "database" ? "database" : "pages",
            dryRun,
          },
        );
      return NextResponse.json(dryRun ? await imported() : await trackJob(user, "import", file.name, imported));
    }
    if (path[0] === "import" && path[1] === "zip") {
      const data = await req.formData();
      const file = data.get("file");
      if (!(file instanceof File)) throw new HttpError(400, "Datei fehlt.");
      if (file.size > ARCHIVE_LIMIT)
        throw new HttpError(413, "ZIP darf maximal 100 MB groß sein.");
      requirePlaintextSpace({ id: z.uuid().parse(data.get("spaceId")) });
      const bytes = Buffer.from(await file.arrayBuffer());
      return NextResponse.json(
        await trackJob(user, "import", file.name, () =>
          importZip(user, z.uuid().parse(data.get("workspaceId")), z.uuid().parse(data.get("spaceId")), bytes),
        ),
      );
    }
    // A DOI as a citation: metadata via DOI content negotiation (cached),
    // then into the workspace's bibliography.
    if (path.length === 2 && path[0] === "citations" && path[1] === "doi") {
      // The server would fetch for anonymous demo guests.
      if (user.demo || user.apiScope) throw new HttpError(403, "Hier nicht verfügbar.");
      const body = z.object({ workspaceId: z.uuid(), doi: z.string().min(4).max(400) }).parse(await req.json());
      requireMember(user, body.workspaceId, "editor");
      const data = await resolveDoi(body.doi);
      return NextResponse.json({ item: transaction(() => bibliographyForDoi(user, body.workspaceId, data), user) });
    }
    // Excalidraw and draw.io files: onto a board (pageId) or as a new one.
    if (path.length === 2 && path[0] === "whiteboards" && path[1] === "import") {
      if (user.apiScope) throw new HttpError(403, "Hier nicht verfügbar.");
      const data = await req.formData();
      const file = data.get("file");
      if (!(file instanceof File)) throw new HttpError(400, "Datei fehlt.");
      if (file.size > BOARD_IMPORT_LIMITS.bytes)
        throw new HttpError(413, "Die Datei ist zu groß (höchstens 20 MB).");
      for (const key of ["pageId", "parentId"]) {
        const value = data.get(key);
        if (typeof value === "string" && value) requirePlaintext(one<Page>("SELECT * FROM pages WHERE id=?", value));
      }
      if (typeof data.get("spaceId") === "string" && data.get("spaceId")) requirePlaintextSpace({ id: String(data.get("spaceId")) });
      const fields = Object.fromEntries(
        ["pageId", "workspaceId", "spaceId", "parentId"]
          .map((key) => [key, data.get(key)])
          .filter(([, value]) => typeof value === "string" && value),
      );
      return NextResponse.json(
        await importWhiteboardFile(user, file.name, Buffer.from(await file.arrayBuffer()), fields),
      );
    }
    // Signs out one of the person's devices, or all others.
    if (path.length === 2 && path[0] === "sessions" && path[1] === "end") {
      const jar = await cookies();
      const result = endMySessions(user, jar.get(cookieName)?.value, await req.json().catch(() => ({})));
      if (result.current) jar.delete(cookieName);
      return NextResponse.json(result);
    }
    if (path[0] === "upload") {
      const data = await req.formData();
      const pageId = z.string().uuid().parse(data.get("pageId"));
      const p = requirePage(user, pageId, true);
      if (p.locked) throw new HttpError(409, "Seite ist gesperrt");
      const file = data.get("file");
      if (!(file instanceof File)) throw new HttpError(400, "Datei fehlt.");
      // Pages of encrypted spaces take only files the browser encrypted
      // (lib/e2ee.ts encryptFile): no name, no type, no content to inspect.
      const encrypted = isEncryptedPage(p);
      if (encrypted && data.get("purpose") !== "e2ee")
        throw new HttpError(409, "Für verschlüsselte Seiten nicht verfügbar.");
      const maxUpload = maxUploadMbFor(user);
      if (file.size > maxUpload * 1024 * 1024)
        throw new HttpError(413, `Maximal ${maxUpload} MB pro Datei.`);
      enforceQuota(p.workspace_id, file.size);
      enforceUserStorage(user, file.size);
      if (
        data.get("purpose") === "cover" &&
        !imageMimes.includes(file.type as (typeof imageMimes)[number])
      )
        throw new HttpError(
          400,
          "Bitte PNG, JPEG, GIF, WebP oder AVIF verwenden.",
        );
      const fid = id(),
        dir = resolve(process.env.FLOWPLAN_DATA_DIR || "./data", "uploads");
      // The type must match the content; photos lose their location.
      const raw = Buffer.from(await file.arrayBuffer());
      if (encrypted && raw.subarray(0, 4).toString("latin1") !== "FPX1") throw new HttpError(400, "Ungültige Eingabe.");
      const mime = encrypted ? "application/octet-stream" : verifiedMime(file.type, raw);
      const content = encrypted ? raw : stripLocation(raw, mime);
      const name = encrypted ? "encrypted.bin" : sanitizeFileName(file.name);
      await mkdir(dir, { recursive: true });
      await writeFile(resolve(dir, fid), content);
      run(
        "INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)",
        fid,
        pageId,
        name,
        mime,
        content.length,
        user.id,
      );
      audit(user.id, "file.upload", pageId, name);
      return NextResponse.json({
        id: fid,
        url: `/api/files/${fid}`,
        name,
        mime,
      });
    }
    throw new HttpError(404, "Nicht gefunden.");
  } catch (e) {
    return error(e);
  }
}

export const HEAD = GET;

// Long-lived streams: whether the session is still valid, the account
// active and the resource still readable. Used on every keepalive.
function streamGuard(sessionToken: string, check: () => unknown) {
  return () => {
    const session = one<{ ok: number }>(
      "SELECT 1 ok FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>? AND u.disabled=0",
      sessionToken,
      Date.now(),
    );
    if (!session) return false;
    try {
      check();
      return true;
    } catch {
      return false;
    }
  };
}
