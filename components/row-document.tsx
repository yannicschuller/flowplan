"use client";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { useT } from "./i18n";
import { useState, useCallback, useEffect } from "react";
import dynamic from "next/dynamic";
import { Clock, Plus, SquaresFour } from "@phosphor-icons/react";
import { api, Modal } from "./ui";
import { VersionChanges } from "./version-changes";
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
  const t = useT();
  const [data, setData] = useState<RowDocumentData | null>(null),
    [status, setStatus] = useState(t("Laden …", "Loading …")),
    [history, setHistory] = useState(false),
    [changes, setChanges] = useState<string | null>(null),
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
        <h3>{t("Inhalt", "Content")}</h3>
        <span className="muted" role="status">
          {status}
        </span>
        <button
          className="icon-button"
          title={t("Datensatz-Versionen", "Record versions")}
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
            {t("Als Vorlage speichern", "Save as template")}
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
        <p className="muted">{t("Dokument wird geladen …", "Loading document …")}</p>
      )}
      <Modal
        open={history}
        onClose={() => setHistory(false)}
        title={t("Datensatz-Versionen", "Record versions")}
      >
        {editable && (
          <button
            className="button primary"
            onClick={() => act("row.snapshot")}
          >
            <Plus />
            {t("Aktuelle Version sichern", "Save current version")}
          </button>
        )}
        {data?.snapshots.map((s) => (
          <div className="utility-row" key={s.id}>
            <Clock />
            <span>
              {new Date(s.created_at.replace(" ", "T") + "Z").toLocaleString(
                LOCALE_TAG,
              )}
            </span>
            <button
              className="button compact"
              onClick={() => {
                setHistory(false);
                setChanges(s.id);
              }}
            >
              {t("Änderungen", "Changes")}
            </button>
            {editable && (
              <button
                className="button compact"
                onClick={async () => {
                  if (await act("row.snapshot.restore", { snapshotId: s.id }))
                    setHistory(false);
                }}
              >
                {t("Wiederherstellen", "Restore")}
              </button>
            )}
          </div>
        ))}
        {!data?.snapshots.length && (
          <p className="muted">{t("Noch keine gesicherten Versionen.", "No saved versions yet.")}</p>
        )}
      </Modal>
      {changes && data && (
        <VersionChanges
          pageId={pageId}
          rowId={rowId}
          snapshotId={changes}
          label={new Date(
            (
              data.snapshots.find((s) => s.id === changes)?.created_at || ""
            ).replace(" ", "T") + "Z",
          ).toLocaleString(LOCALE_TAG)}
          versions={data.snapshots.map((s) => ({
            id: s.id,
            label: new Date(
              s.created_at.replace(" ", "T") + "Z",
            ).toLocaleString(LOCALE_TAG),
          }))}
          onClose={() => {
            setChanges(null);
            setHistory(true);
          }}
        />
      )}
      <Modal
        open={saveTemplate}
        onClose={() => setSaveTemplate(false)}
        title={t("Datensatzvorlage speichern", "Save record template")}
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
            {t("Name", "Name")}
            <input
              autoFocus
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="z. B. Projektbriefing"
            />
          </label>
          <p className="muted">
            {t("Eigenschaften und gespeicherter Dokumentinhalt werden übernommen. Berechnete Werte entstehen für jeden neuen Eintrag neu.", "Properties and the saved document content are taken over. Calculated values are created anew for every new record.")}
          </p>
          <button
            className="button primary"
            disabled={status !== "Gespeichert"}
          >
            {t("Vorlage speichern", "Save template")}
          </button>
          {status !== "Gespeichert" && (
            <p className="muted">
              {t("Bitte warten, bis der Dokumentinhalt gespeichert ist.", "Please wait until the document content is saved.")}
            </p>
          )}
        </form>
      </Modal>
    </section>
  );
}
