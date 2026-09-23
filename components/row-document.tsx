"use client";
import { useState, useCallback, useEffect } from "react";
import dynamic from "next/dynamic";
import { Clock, Plus, SquaresFour } from "@phosphor-icons/react";
import { api, Modal } from "./ui";
import type { Page, User } from "@/lib/types";
const DocumentEditor = dynamic(() => import("./editor"), { ssr: false });
type RowDocumentData = {
  html: string;
  state: string;
  generation: string;
  snapshots: { id: string; created_at: string }[];
};
export default function RowDocument({
  pageId,
  rowId,
  userId,
  pages,
  members,
  editable,
  onError,
  onChanged,
}: {
  pageId: string;
  rowId: string;
  userId: string;
  pages: Page[];
  members: User[];
  editable: boolean;
  onError: (s: string) => void;
  onChanged: () => Promise<unknown>;
}) {
  const [data, setData] = useState<RowDocumentData | null>(null),
    [status, setStatus] = useState("Laden …"),
    [history, setHistory] = useState(false),
    [saveTemplate, setSaveTemplate] = useState(false),
    [name, setName] = useState("");
  const refresh = useCallback(async () => {
    const next = await api<RowDocumentData>(
      `/api/pages/${pageId}/rows/${rowId}`,
    );
    setData((previous) =>
      previous?.generation === next.generation
        ? { ...previous, snapshots: next.snapshots }
        : next,
    );
  }, [pageId, rowId]);
  useEffect(() => {
    void refresh().catch((e) => onError(e.message));
    const timer = setInterval(() => {
      if (navigator.onLine) void refresh().catch(() => {});
    }, 8000);
    return () => clearInterval(timer);
  }, [refresh, onError]);
  const onHtml = useCallback(() => {}, []);
  async function act(action: string, extra: Record<string, unknown> = {}) {
    try {
      await api("/api/command", { action, pageId, rowId, ...extra });
      await refresh();
      await onChanged();
      return true;
    } catch (e) {
      onError((e as Error).message);
      return false;
    }
  }
  return (
    <section className="row-document">
      <div className="row-document-heading">
        <h3>Inhalt</h3>
        <span className="muted" role="status">
          {status}
        </span>
        <button
          className="icon-button"
          title="Datensatz-Versionen"
          onClick={() => setHistory(true)}
        >
          <Clock size={18} />
        </button>
        {editable && (
          <button
            className="button compact"
            onClick={() => setSaveTemplate(true)}
          >
            <SquaresFour />
            Als Vorlage speichern
          </button>
        )}
      </div>
      {data ? (
        <DocumentEditor
          key={`${rowId}-${data.generation}`}
          pageId={pageId}
          rowId={rowId}
          userId={userId}
          pages={pages}
          members={members}
          state={data.state}
          html={data.html}
          generation={data.generation}
          editable={editable}
          onStatus={setStatus}
          onError={onError}
          onHtml={onHtml}
        />
      ) : (
        <p className="muted">Dokument wird geladen …</p>
      )}
      <Modal
        open={history}
        onClose={() => setHistory(false)}
        title="Datensatz-Versionen"
      >
        {editable && (
          <button
            className="button primary"
            onClick={() => act("row.snapshot")}
          >
            <Plus />
            Aktuelle Version sichern
          </button>
        )}
        {data?.snapshots.map((s) => (
          <div className="utility-row" key={s.id}>
            <Clock />
            <span>
              {new Date(s.created_at.replace(" ", "T") + "Z").toLocaleString(
                "de-DE",
              )}
            </span>
            {editable && (
              <button
                className="button compact"
                onClick={async () => {
                  if (await act("row.snapshot.restore", { snapshotId: s.id }))
                    setHistory(false);
                }}
              >
                Wiederherstellen
              </button>
            )}
          </div>
        ))}
        {!data?.snapshots.length && (
          <p className="muted">Noch keine gesicherten Versionen.</p>
        )}
      </Modal>
      <Modal
        open={saveTemplate}
        onClose={() => setSaveTemplate(false)}
        title="Datensatzvorlage speichern"
      >
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (await act("row.template.save", { name })) {
              setSaveTemplate(false);
              setName("");
            }
          }}
        >
          <label>
            Name
            <input
              autoFocus
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="z. B. Projektbriefing"
            />
          </label>
          <p className="muted">
            Eigenschaften und gespeicherter Dokumentinhalt werden übernommen.
            Berechnete Werte entstehen für jeden neuen Eintrag neu.
          </p>
          <button
            className="button primary"
            disabled={status !== "Gespeichert"}
          >
            Vorlage speichern
          </button>
          {status !== "Gespeichert" && (
            <p className="muted">
              Bitte warten, bis der Dokumentinhalt gespeichert ist.
            </p>
          )}
        </form>
      </Modal>
    </section>
  );
}
