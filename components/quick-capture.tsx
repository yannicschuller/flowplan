"use client";
// Quick capture: one field for the title, one for the text, saved straight
// into the default capture database (an inbox). Works offline: the record
// waits on the device and is created once the connection is back.
import { useEffect, useState } from "react";
import { useT } from "./i18n";
import { Modal } from "./ui";
import { CaptureTargetPicker, rememberCaptureTarget, useCaptureTargets } from "./capture-target";

export function QuickCapture({
  workspaceId,
  onClose,
  mutate,
  onSaved,
  notify,
}: {
  workspaceId: string;
  onClose: () => void;
  mutate: (b: Record<string, unknown>) => Promise<unknown>;
  onSaved: (pageId: string, rowId: string, offline: boolean) => void;
  notify: (message: string) => void;
}) {
  const t = useT();
  const [targets] = useCaptureTargets(workspaceId);
  const [database, setDatabase] = useState("");
  const [makeDefault, setMakeDefault] = useState(false);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (targets) setDatabase((current) => current || targets.default || targets.databases[0]?.id || "");
  }, [targets]);
  // Offline the list of databases is not available: the last one is kept.
  useEffect(() => {
    if (!targets || targets.databases.length) return;
    try {
      const last = localStorage.getItem(`flowplan-capture:${workspaceId}`);
      if (last) setDatabase(last);
    } catch {}
  }, [targets, workspaceId]);
  const save = async () => {
    if (!database || (!title.trim() && !text.trim())) return;
    setBusy(true);
    try {
      const rowId = crypto.randomUUID();
      const result = (await mutate({ action: "capture.record", pageId: database, rowId, title, text })) as { offline?: boolean } | null;
      try {
        localStorage.setItem(`flowplan-capture:${workspaceId}`, database);
      } catch {}
      if (makeDefault && !result?.offline) await rememberCaptureTarget(workspaceId, database, targets).catch(() => undefined);
      onSaved(database, rowId, !!result?.offline);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const offlineFallback = targets && !targets.databases.length && database;
  return (
    <Modal open sheet onClose={onClose} title={t("Erfassen", "Capture")}>
      <form
        className="quick-capture"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label>
          {t("Titel", "Title")}
          <input autoFocus value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} placeholder={t("Was willst du festhalten?", "What do you want to capture?")} />
        </label>
        <label>
          {t("Text", "Text")}
          <textarea
            rows={5}
            value={text}
            maxLength={20000}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void save();
              }
            }}
            placeholder={t("Optional – Gedanken, Link, Notiz …", "Optional – thoughts, link, note …")}
          />
        </label>
        {offlineFallback ? (
          <p className="muted small">{t("Offline: wird in die zuletzt gewählte Datenbank erfasst, sobald die Verbindung zurück ist.", "Offline: captured into the last chosen database once the connection is back.")}</p>
        ) : (
          <CaptureTargetPicker targets={targets} value={database} onChange={setDatabase} makeDefault={makeDefault} onMakeDefault={setMakeDefault} />
        )}
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            {t("Abbrechen", "Cancel")}
          </button>
          <button className="button primary" disabled={busy || !database || (!title.trim() && !text.trim())}>
            {busy ? t("Wird gespeichert …", "Saving …") : t("Erfassen", "Capture")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
