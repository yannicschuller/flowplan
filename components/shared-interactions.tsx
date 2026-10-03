"use client";
import { useT } from "./i18n";
import { useRef, useState } from "react";
import { useSharedLive } from "./shared-live";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { CellInput, type CellFile } from "./cell-input";
import type { SharedComment } from "@/lib/shared-content";
import type { Field, Row } from "@/lib/types";
import { compressImage } from "@/lib/image-compress";
const SharedEditor = dynamic(() => import("./shared-editor"), { ssr: false });
type Content = {
  pageId: string;
  rowId?: string;
  role: "viewer" | "commenter" | "editor";
  locked: boolean;
  title: string;
  html: string;
  version: string;
  canEditContent: boolean;
  titleField?: string;
  fields: Field[];
  related?: Record<string, { id: string; cells: { title: string } }[]>;
  files?: CellFile[];
  cells: Record<string, unknown>;
  comments: SharedComment[];
};
export function SharedInteractions({
  token,
  initial,
}: {
  token: string;
  initial: Content;
}) {
  const t = useT();
  const router = useRouter();
  const [data, setData] = useState(initial),
    [editing, setEditing] = useState(false),
    [title, setTitle] = useState(initial.title),
    [html, setHtml] = useState(initial.html),
    [cells, setCells] = useState(initial.cells),
    [name, setName] = useState(""),
    [body, setBody] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [status, setStatus] = useState(""),
    [newTitle, setNewTitle] = useState(""),
    [uploaded, setUploaded] = useState<CellFile[]>([]);
  // Content is edited live together with members and other guests.
  const versionRef = useRef(data.version);
  versionRef.current = data.version;
  const live = useSharedLive({
    token,
    pageId: data.pageId,
    rowId: data.rowId,
    active: editing && data.canEditContent,
    onVersion: (version) => {
      versionRef.current = version;
      setData((d) => (d.version === version ? d : { ...d, version }));
    },
  });
  async function upload(original: File) {
    setError("");
    const file = await compressImage(original);
    const form = new FormData();
    form.set("pageId", data.pageId);
    form.set("file", file);
    try {
      const response = await fetch(`/api/share/${token}/files`, {
        method: "POST",
        body: form,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      const file = result as CellFile;
      setUploaded((list) => [...list, file]);
      return file;
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  }
  async function send(payload: Record<string, unknown>) {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const response = await fetch(`/api/share/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...payload,
          pageId: data.pageId,
          rowId: data.rowId,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setData(result);
      return result as Content;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  }
  async function startEdit() {
    setBusy(true);
    setError("");
    try {
      const query = new URLSearchParams({
        pageId: data.pageId,
        ...(data.rowId ? { rowId: data.rowId } : {}),
      });
      const response = await fetch(`/api/share/${token}?${query}`, {
        cache: "no-store",
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setData(result);
      setTitle(result.title);
      setHtml(result.html);
      setCells(result.cells);
      setEditing(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="shared-interactions">
      <p className="shared-permission">
        {t("Dein Link:", "Your link:")}{" "}
        {data.role === "viewer"
          ? t("Lesen", "Read")
          : data.role === "commenter"
            ? t("Lesen und kommentieren", "Read and comment")
            : t("Lesen, kommentieren und bearbeiten", "Read, comment and edit")}
        {data.locked && t(" · Seite gesperrt", " · page locked")}
      </p>
      {data.role === "editor" && !data.locked && !editing && (
        <button className="button" disabled={busy} onClick={startEdit}>
          {t("Inhalt bearbeiten", "Edit content")}
        </button>
      )}
      {editing && (
        <div className="shared-edit-form">
          {!data.rowId && (
            <label>
              {t("Seitentitel", "Page title")}
              <input
                aria-label={t("Seitentitel", "Page title")}
                maxLength={500}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
          )}
          {data.fields
            .filter((f) => !["created_at", "updated_at"].includes(f.type))
            .map((f) => (
              <label key={f.id}>
                {f.name}
                <CellInput
                  field={f}
                  value={cells[f.id]}
                  members={[]}
                  related={
                    (data.related || {}) as unknown as Record<string, Row[]>
                  }
                  files={[...(data.files || []), ...uploaded]}
                  upload={async (file) => {
                    const result = await upload(file);
                    if (!result) throw new Error(t("Upload fehlgeschlagen.", "Upload failed."));
                    return result.url;
                  }}
                  disabled={busy}
                  commit="change"
                  onChange={(value) => setCells({ ...cells, [f.id]: value })}
                />
              </label>
            ))}
          {data.canEditContent &&
            (live.doc ? (
              <>
                <SharedEditor
                  key={live.docKey}
                  html=""
                  ydoc={live.doc}
                  presence={{ token, pageId: data.pageId, rowId: data.rowId, clientId: live.clientId }}
                  onChange={setHtml}
                  disabled={busy}
                  upload={upload}
                />
                <p className="shared-live-status" aria-live="polite">
                  {live.state === "error"
                    ? t(`Live-Bearbeitung: ${live.error}`, `Live editing: ${live.error}`)
                    : live.state === "saving"
                      ? t("Live · wird gespeichert …", "Live · saving …")
                      : t("Live · Inhalt gespeichert, Änderungen anderer erscheinen automatisch", "Live · content saved, changes by others appear automatically")}
                </p>
              </>
            ) : (
              <p className="muted">{t("Live-Bearbeitung wird verbunden …", "Connecting live editing …")}</p>
            ))}
          <div className="shared-actions">
            <button
              className="button primary"
              disabled={busy || !title.trim()}
              onClick={async () => {
                if (data.canEditContent) {
                  try {
                    await live.flush();
                  } catch (e) {
                    setError((e as Error).message);
                    return;
                  }
                }
                const changedCells = Object.fromEntries(
                  data.fields
                    .filter(
                      (f) =>
                        !["created_at", "updated_at"].includes(f.type) &&
                        JSON.stringify(cells[f.id]) !==
                          JSON.stringify(data.cells[f.id]),
                    )
                    .map((f) => [f.id, cells[f.id]]),
                );
                // The content was saved live; only title and properties remain.
                const result =
                  data.canEditContent &&
                  title === data.title &&
                  !Object.keys(changedCells).length
                    ? data
                    : await send({
                        action: "save",
                        version: versionRef.current,
                        title,
                        ...(data.canEditContent ? {} : { html }),
                        cells: changedCells,
                      });
                if (result) {
                  setEditing(false);
                  setStatus(t("Änderungen gespeichert", "Changes saved"));
                  router.refresh();
                }
              }}
            >
              {t("Änderungen speichern", "Save changes")}
            </button>
            <button
              className="button"
              disabled={busy}
              onClick={() => setEditing(false)}
            >
              {t("Abbrechen", "Cancel")}
            </button>
          </div>
        </div>
      )}
      {data.role === "editor" && !data.locked && data.titleField && (
        <form
          className="shared-new-record"
          onSubmit={async (e) => {
            e.preventDefault();
            const result = (await send({
              action: "create",
              cells: { [data.titleField!]: newTitle.trim() },
            })) as (Content & { createdRowId?: string }) | null;
            if (result?.createdRowId) {
              setNewTitle("");
              router.push(
                `${location.pathname}?row=${encodeURIComponent(result.createdRowId)}`,
              );
            }
          }}
        >
          <label>
            {t("Neuer Eintrag", "New record")}
            <input
              aria-label={t("Name des neuen Eintrags", "Name of the new record")}
              maxLength={500}
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
            />
          </label>
          <button
            className="button primary"
            disabled={busy || !newTitle.trim()}
          >
            {t("Eintrag anlegen", "Create record")}
          </button>
        </form>
      )}
      <h2>{t("Kommentare zur Freigabe", "Comments on this share")}</h2>
      {data.comments.length === 0 && (
        <p className="muted">{t("Noch keine Gastkommentare.", "No guest comments yet.")}</p>
      )}
      {data.comments.map((c) => (
        <article className="shared-comment" key={c.id}>
          <strong>
            {c.name} <small>(Gast)</small>
          </strong>
          {!!c.resolved && <span> · Erledigt</span>}
          <p>{c.body}</p>
        </article>
      ))}
      {data.role !== "viewer" && !data.locked && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const result = await send({ action: "comment", name, body });
            if (result) {
              setBody("");
              setStatus(t("Kommentar veröffentlicht", "Comment published"));
            }
          }}
        >
          <label>
            {t("Dein Name", "Your name")}
            <input
              aria-label={t("Dein Name", "Your name")}
              required
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            {t("Kommentar", "Comment")}
            <textarea
              aria-label={t("Kommentar", "Comment")}
              required
              maxLength={5000}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </label>
          <button
            className="button primary"
            disabled={busy || !body.trim() || !name.trim()}
          >
            {t("Kommentar veröffentlichen", "Publish comment")}
          </button>
        </form>
      )}
      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}
      {status && <p role="status">{status}</p>}
    </section>
  );
}
