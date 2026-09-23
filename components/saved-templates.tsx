"use client";
import { useEffect, useState, useCallback } from "react";
import { api, Modal, PageIcon } from "./ui";
type Template = {
  id: string;
  name: string;
  kind: string;
  visibility: "private" | "workspace";
  version: number;
  deleted_at: string | null;
  can_manage: boolean;
};
export default function SavedTemplates({
  workspaceId,
  canCreate,
  onUse,
  onError,
}: {
  workspaceId: string;
  canCreate: boolean;
  onUse: (t: Template) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [items, setItems] = useState<Template[]>([]),
    [deleted, setDeleted] = useState(false),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Template | null>(null),
    [removing, setRemoving] = useState<Template | null>(null);
  const refresh = useCallback(async () => {
    setItems(await api<Template[]>(`/api/templates?workspace=${workspaceId}`));
    setLoading(false);
  }, [workspaceId]);
  useEffect(() => {
    void refresh().catch((e) => {
      setLoading(false);
      onError((e as Error).message);
    });
  }, [refresh, onError]);
  async function change(t: Template, action: string) {
    setBusy(true);
    try {
      await api("/api/command", {
        action,
        workspaceId,
        templateId: t.id,
        version: t.version,
        name: t.name,
        visibility: t.visibility,
      });
      await refresh();
      setEditing(null);
      setRemoving(null);
    } catch (e) {
      onError((e as Error).message);
      await refresh().catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  const shown = items.filter((t) => !!t.deleted_at === deleted);
  return (
    <section className="saved-templates">
      <h3>Deine Vorlagen</h3>
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={deleted}
          onChange={(e) => setDeleted(e.target.checked)}
        />
        Vorlagen-Papierkorb ({items.filter((t) => t.deleted_at).length})
      </label>
      {loading ? (
        <p className="muted">Vorlagen werden geladen …</p>
      ) : shown.length === 0 ? (
        <p className="muted">
          {deleted
            ? "Keine gelöschten Vorlagen."
            : "Noch keine gespeicherten Vorlagen."}
        </p>
      ) : (
        shown.map((t) => (
          <div className="utility-row saved-template-row" key={t.id}>
            <PageIcon name={t.kind === "database" ? "table" : "file"} />
            <div className="saved-template-name">
              <strong>{t.name}</strong>
              <small>
                {t.visibility === "private" ? "Nur für mich" : "Arbeitsbereich"}
              </small>
            </div>
            <div className="saved-template-actions">
              {!deleted && (
                <button
                  className="button compact"
                  disabled={busy || !canCreate}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await onUse(t);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Verwenden
                </button>
              )}
              {t.can_manage &&
                (deleted ? (
                  <button
                    className="button compact"
                    disabled={busy}
                    onClick={() => change(t, "template.restore")}
                  >
                    Wiederherstellen
                  </button>
                ) : (
                  <>
                    <button
                      className="button compact"
                      aria-label={`${t.name} bearbeiten`}
                      disabled={busy}
                      onClick={() => setEditing({ ...t })}
                    >
                      Bearbeiten
                    </button>
                    <button
                      className="button compact danger"
                      aria-label={`${t.name} löschen`}
                      disabled={busy}
                      onClick={() => setRemoving(t)}
                    >
                      Löschen
                    </button>
                  </>
                ))}
            </div>
          </div>
        ))
      )}
      <Modal
        open={!!editing}
        onClose={() => !busy && setEditing(null)}
        title="Vorlage bearbeiten"
      >
        {editing && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void change(editing, "template.update");
            }}
          >
            <label>
              Name
              <input
                required
                maxLength={500}
                value={editing.name}
                onChange={(e) =>
                  setEditing({ ...editing, name: e.target.value })
                }
              />
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={editing.visibility === "private"}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    visibility: e.target.checked ? "private" : "workspace",
                  })
                }
              />
              Nur für mich sichtbar
            </label>
            <p className="muted">
              Gespeicherte Inhalte und Anhänge bleiben erhalten. Bereits
              erstellte Seiten werden nicht verändert.
            </p>
            <button
              className="button primary"
              disabled={busy || !editing.name.trim()}
            >
              Änderungen speichern
            </button>
          </form>
        )}
      </Modal>
      <Modal
        open={!!removing}
        onClose={() => !busy && setRemoving(null)}
        title="Vorlage löschen"
      >
        <p>
          „{removing?.name}“ in den Vorlagen-Papierkorb verschieben? Die Vorlage
          kann wiederhergestellt werden. Bereits erstellte Seiten bleiben
          erhalten.
        </p>
        <button
          className="button danger"
          disabled={busy}
          onClick={() => removing && change(removing, "template.delete")}
        >
          In den Papierkorb
        </button>
      </Modal>
    </section>
  );
}
