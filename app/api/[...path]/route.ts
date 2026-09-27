import { boardCursors, moveCursor, watchBoard } from "@/lib/whiteboard-presence";
import { storageOverview } from "@/lib/storage-overview";
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
  testPush,
  dispatchPush,
} from "@/lib/push";
import { listPageTemplates } from "@/lib/page-templates";
import { fileResponse } from "@/lib/file-response";
import { publicFile } from "@/lib/publication";
import { requireRow, rowDocumentData } from "@/lib/row-documents";
import { documentKey, publishPresence, watchDocument } from "@/lib/document-live";
import { calendarFeed, hasCalendarFeed } from "@/lib/calendar-feed";
import { listApiTokens } from "@/lib/api-tokens";
import { createWebhook, listWebhooks, webhookEvents } from "@/lib/webhooks";
import { mailStatus, sendTestMail } from "@/lib/mail";
import { runScheduledBackup, scheduledBackupStatus } from "@/lib/scheduled-backup";
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
  hash,
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
import { relationBacklinks } from "@/lib/relation-backlinks";
import { pagePreview } from "@/lib/page-preview";
import { journalDate } from "@/lib/journal";
import {
  calendarEvents,
  databaseEvents,
  journalReview,
  requireUnlocked,
} from "@/lib/journal-extras";
import { listRowTrash } from "@/lib/row-trash";
import { ARCHIVE_LIMIT } from "@/lib/archive";
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
export async function GET(
  req: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  try {
    const { path } = await params;
    const url = new URL(req.url);
    // Keep public asset authorization identical when the catch-all handles the URL.
    if (path.length === 4 && path[0] === "share" && path[2] === "files")
      return await fileResponse(req, publicFile(path[1], path[3]));
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
    if (path[0] === "bootstrap")
      return NextResponse.json(
        bootstrap(user, url.searchParams.get("workspace") || undefined),
      );
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
      return NextResponse.json({ events, calendarError }, { headers: { "Cache-Control": "no-store" } });
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
        relationBacklinks(
          user,
          z.uuid().parse(path[1]),
          z.uuid().parse(path[3]),
        ),
      );
    if (path[0] === "pages" && path[2] === "rows" && path[3])
      return NextResponse.json(rowDocumentData(user, path[1], path[3]));
    if (path[0] === "pages" && path[1])
      return NextResponse.json(pageData(user, path[1]));
    if (path[0] === "settings") {
      const wid = url.searchParams.get("workspace") || "";
      requireMember(user, wid, "owner");
      return NextResponse.json({
        invites: all("SELECT * FROM invites WHERE workspace_id=?", wid),
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
    if (path[0] === "admin") {
      requireAdmin(user);
      return NextResponse.json({
        users: all(
          "SELECT id,name,email,disabled,created_at,last_login_at FROM users WHERE demo_until IS NULL ORDER BY created_at DESC",
        ),
        mail: mailStatus(),
        backup: scheduledBackupStatus(),
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
        metrics: instanceMetrics(),
        usage: workspaceUsage(),
        settings: instanceSettings(),
        restorePending: pendingRestore(),
      });
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
      requireUnlocked(user, requirePage(user, file.page_id));
      return await fileResponse(req, file);
    }
    if (path[0] === "export") {
      const wid = url.searchParams.get("workspace") || "";
      requireMember(user, wid);
      const pages = all<Page>(
        "SELECT * FROM pages WHERE workspace_id=?",
        wid,
      ).filter((p) => pageRole(user, p));
      return NextResponse.json(
        {
          format: "flowplan-1",
          exportedAt: new Date().toISOString(),
          workspace: one("SELECT name,icon FROM workspaces WHERE id=?", wid),
          pages: pages.map((p) => ({
            ...p,
            data:
              p.kind === "database"
                ? { database: database(p.id), rows: rows(p.id) }
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
export async function POST(
  req: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  try {
    checkOrigin(req);
    const { path } = await params;
    // ZIP imports may be as large as content archives.
    if (
      Number(req.headers.get("content-length") || 0) >
      (path[0] === "import" || path[1] === "import"
        ? ARCHIVE_LIMIT + 1_000_000
        : 12_000_000)
    )
      throw new HttpError(413, "Anfrage zu groß.");
    const user = await requireUser();
    if (path.length === 1 && path[0] === "webhooks") {
      if (user.apiScope) throw new HttpError(403, "Mit einem API-Token nicht erlaubt.");
      return NextResponse.json(await createWebhook(user, await req.json()));
    }
    if (path.length === 2 && path[0] === "admin" && path[1] === "mail-test") {
      requireAdmin(user);
      const to = z.email().parse((await req.json()).to);
      await sendTestMail(to);
      return NextResponse.json({ ok: true });
    }
    if (path.length === 2 && path[0] === "admin" && path[1] === "backup-run") {
      requireAdmin(user);
      return NextResponse.json(await runScheduledBackup());
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
            ? testPush(user, sessionToken)
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
    if (path[0] === "import" && path[1] === "zip") {
      const data = await req.formData();
      const file = data.get("file");
      if (!(file instanceof File)) throw new HttpError(400, "Datei fehlt.");
      if (file.size > ARCHIVE_LIMIT)
        throw new HttpError(413, "ZIP darf maximal 100 MB groß sein.");
      return NextResponse.json(
        await importZip(
          user,
          z.uuid().parse(data.get("workspaceId")),
          z.uuid().parse(data.get("spaceId")),
          Buffer.from(await file.arrayBuffer()),
        ),
      );
    }
    if (path[0] === "upload") {
      const data = await req.formData();
      const pageId = z.string().uuid().parse(data.get("pageId"));
      const p = requirePage(user, pageId, true);
      if (p.locked) throw new HttpError(409, "Seite ist gesperrt");
      const file = data.get("file");
      if (!(file instanceof File)) throw new HttpError(400, "Datei fehlt.");
      const maxUpload = instanceSettings().maxUploadMb;
      if (file.size > maxUpload * 1024 * 1024)
        throw new HttpError(413, `Maximal ${maxUpload} MB pro Datei.`);
      enforceQuota(p.workspace_id, file.size);
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
      await mkdir(dir, { recursive: true });
      await writeFile(resolve(dir, fid), Buffer.from(await file.arrayBuffer()));
      run(
        "INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)",
        fid,
        pageId,
        file.name,
        file.type,
        file.size,
        user.id,
      );
      audit(user.id, "file.upload", pageId, file.name);
      return NextResponse.json({
        id: fid,
        url: `/api/files/${fid}`,
        name: file.name,
        mime: file.type,
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
