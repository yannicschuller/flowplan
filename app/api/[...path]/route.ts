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
import { rowDocumentData } from "@/lib/row-documents";
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
    const user = await requireUser();
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
    if (path[0] === "pages" && path[1] && path[2] === "preview")
      return NextResponse.json(pagePreview(user, z.uuid().parse(path[1])), {
        headers: { "Cache-Control": "no-store" },
      });
    if (path[0] === "pages" && path[2] === "linked" && path[3])
      return NextResponse.json(linkedDatabaseData(user, path[1], path[3]));
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
            .enum(["all", "document", "database", "row", "comment", "file"])
            .catch("all")
            .parse(url.searchParams.get("kind") || "all"),
          spaceId: url.searchParams.get("space")
            ? z.uuid().parse(url.searchParams.get("space"))
            : undefined,
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
    if (path[0] === "admin") {
      requireAdmin(user);
      return NextResponse.json({
        users: all(
          "SELECT id,name,email,disabled,created_at FROM users ORDER BY created_at DESC",
        ),
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
      requirePage(user, file.page_id);
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
      return NextResponse.json(
        editorPresence(
          user,
          hash((await cookies()).get(cookieName)?.value || ""),
          data,
        ),
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
      if (file.size > 10 * 1024 * 1024)
        throw new HttpError(413, "Maximal 10 MB pro Datei.");
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
