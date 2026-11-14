"use client";
// Whiteboards and notebooks on an edit link (#280): the picture the page
// shows to everyone, and – on "Bearbeiten" – the editor of the app working
// through the link (lib/share-canvas.ts), live with members and other
// guests. The editor's code loads only then, and only for these pages.
import dynamic from "next/dynamic";
import { useCallback, useMemo, useState } from "react";
import { PencilSimple } from "@phosphor-icons/react";
import { serverMessage } from "@/lib/i18n-errors";
import { useT } from "./i18n";
import { api } from "./ui";
import { shareBoardUrl, shareNotebookUrl, type ShareGuest } from "./share-guest";
import type { NotebookPayload } from "@/lib/notebook";

const Whiteboard = dynamic(() => import("./whiteboard/whiteboard"), { ssr: false, loading: () => <Loading /> });
const NotebookView = dynamic(() => import("./notebook/notebook-view"), { ssr: false, loading: () => <Loading /> });
function Loading() {
  const t = useT();
  return <p className="muted shared-canvas-loading">{t("Editor wird geladen …", "Loading the editor …")}</p>;
}
type PageRef = { id: string; title: string; kind: string; icon?: string };
type Board = { state: string; generation: string };

export function SharedCanvas({
  token,
  pageId,
  kind,
  title,
  pages,
  children,
}: {
  token: string;
  pageId: string;
  kind: "whiteboard" | "notebook";
  title: string;
  // The pages of the link (cards and links only to them).
  pages: PageRef[];
  // The picture shown until editing starts.
  children: React.ReactNode;
}) {
  const t = useT();
  const guest = useMemo<ShareGuest>(() => ({ token, clientId: crypto.randomUUID() }), [token]);
  const [board, setBoard] = useState<Board | null>(null);
  const [notebook, setNotebook] = useState<NotebookPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      if (kind === "whiteboard") setBoard(await api<Board>(`${shareBoardUrl(guest)}?pageId=${pageId}`));
      else setNotebook(await api<NotebookPayload>(`${shareNotebookUrl(guest)}?pageId=${pageId}`));
    } catch (e) {
      setError(serverMessage((e as Error).message));
    } finally {
      setBusy(false);
    }
  }, [guest, kind, pageId]);
  const editing = !!board || !!notebook;
  const onError = useCallback((message: string) => setError(serverMessage(message)), []);
  return (
    <section className={`shared-canvas${editing ? " is-editing" : ""}`}>
      {!editing && (
        <div className="shared-canvas-start">
          <button type="button" className="button primary" disabled={busy} onClick={() => void load()}>
            <PencilSimple size={16} aria-hidden="true" />{" "}
            {kind === "whiteboard" ? t("Whiteboard bearbeiten", "Edit whiteboard") : t("Notizbuch bearbeiten", "Edit notebook")}
          </button>
          <span className="muted">
            {t("Live mit allen, die gerade daran arbeiten – ohne Konto. Hochladen ist für Gäste nicht möglich.", "Live with everyone working on it – no account needed. Uploading is not available to guests.")}
          </span>
        </div>
      )}
      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}
      {board ? (
        <Whiteboard
          key={board.generation}
          pageId={pageId}
          state={board.state}
          generation={board.generation}
          editable
          pages={pages.map((p) => ({ id: p.id, title: p.title, icon: p.icon || "", kind: p.kind }))}
          onReload={() => void load()}
          onError={onError}
          onOpenPage={(id) => {
            if (pages.some((p) => p.id === id)) window.location.href = `/share/${encodeURIComponent(token)}/${id}`;
          }}
          userName={t("Gast", "Guest")}
          guest={guest}
        />
      ) : notebook ? (
        <NotebookView pageId={pageId} title={title} notebook={notebook} editable={notebook.canEdit} onError={onError} guest={guest} />
      ) : (
        children
      )}
    </section>
  );
}
