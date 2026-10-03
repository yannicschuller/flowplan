"use client";
import { serverMessage } from "@/lib/i18n-errors";
import { tr } from "@/lib/locale-tag";
import { useT } from "./i18n";
import { Select } from "./select";
import { useEffect, useState, useCallback } from "react";
import { api, Modal, PageIcon } from "./ui";
import {
  templateCategories,
  type TemplateCategory,
} from "@/lib/template-categories";
type Template = {
  id: string;
  name: string;
  kind: string;
  visibility: "private" | "workspace" | "instance" | "public";
  category: TemplateCategory;
  version: number;
  deleted_at: string | null;
  can_manage: boolean;
  shared?: boolean;
};
const visibilityLabels = {
  private: tr("Nur für mich", "Only me"),
  workspace: tr("Arbeitsbereich", "Workspace"),
  instance: tr("Alle Arbeitsbereiche", "All workspaces"),
  public: tr("Öffentliche Galerie", "Public gallery"),
};
export default function SavedTemplates({
  workspaceId,
  canCreate,
  isAdmin = false,
  onUse,
  onError,
}: {
  workspaceId: string;
  canCreate: boolean;
  isAdmin?: boolean;
  onUse: (t: Template) => Promise<void>;
  onError: (message: string) => void;
}) {
  const t = useT();
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
        category: t.category || "",
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
  const [search, setSearch] = useState(""),
    [kind, setKind] = useState<"all" | "document" | "database">("all"),
    [category, setCategory] = useState<"all" | TemplateCategory>("all");
  const shown = items.filter(
    (t) =>
      !!t.deleted_at === deleted &&
      (kind === "all" || t.kind === kind) &&
      (category === "all" || (t.category || "") === category) &&
      t.name.toLocaleLowerCase("de").includes(search.toLocaleLowerCase("de")),
  );
  async function importFile(file: File) {
    setBusy(true);
    try {
      const body = new FormData();
      body.set("workspaceId", workspaceId);
      body.set("file", file);
      const response = await fetch("/api/templates/import", {
        method: "POST",
        body,
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(serverMessage(result.error) || t("Import fehlgeschlagen.", "Import failed."));
      await refresh();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="saved-templates">
      <h3>{t("Deine Vorlagen", "Your templates")}</h3>
      <p className="muted">
        <a href="/templates" target="_blank" rel="noopener">
          {t("Öffentliche Vorlagengalerie öffnen", "Open the public template gallery")}
        </a>
      </p>
      <div className="template-filters">
        <input
          type="search"
          aria-label={t("Vorlagen durchsuchen", "Search templates")}
          placeholder={t("Vorlagen suchen …", "Search templates …")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select
          aria-label={t("Vorlagentyp", "Template type")}
          value={kind}
          onChange={(e) => setKind(e.target.value as typeof kind)}
        >
          <option value="all">{t("Alle", "All")}</option>
          <option value="document">{t("Dokumente", "Documents")}</option>
          <option value="database">{t("Datenbanken", "Databases")}</option>
        </Select>
        <Select
          aria-label={t("Vorlagenkategorie", "Template category")}
          value={category}
          onChange={(e) => setCategory(e.target.value as typeof category)}
        >
          <option value="all">{t("Alle Kategorien", "All categories")}</option>
          {Object.entries(templateCategories).map(([id, label]) => (
            <option key={id} value={id}>
              {t(label)}
            </option>
          ))}
          <option value="">{t("Ohne Kategorie", "No category")}</option>
        </Select>
        {canCreate && (
          <label className="button compact">
            {t("Vorlage importieren", "Import template")}
            <input
              type="file"
              accept=".zip,application/zip"
              hidden
              aria-label={t("Vorlagendatei importieren", "Import template file")}
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void importFile(file);
              }}
            />
          </label>
        )}
      </div>
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={deleted}
          onChange={(e) => setDeleted(e.target.checked)}
        />
        {t("Vorlagen-Papierkorb (", "Template trash (")}{items.filter((item) => item.deleted_at).length})
      </label>
      {loading ? (
        <p className="muted">{t("Vorlagen werden geladen …", "Loading templates …")}</p>
      ) : shown.length === 0 ? (
        <p className="muted">
          {deleted
            ? t("Keine gelöschten Vorlagen.", "No deleted templates.")
            : t("Noch keine gespeicherten Vorlagen.", "No saved templates yet.")}
        </p>
      ) : (
        shown.map((template) => (
          <div className="utility-row saved-template-row" key={template.id}>
            <PageIcon name={template.kind === "database" ? "table" : "file"} />
            <div className="saved-template-name">
              <strong>{template.name}</strong>
              <small>
                {template.shared
                  ? t("Instanzvorlage", "Instance template")
                  : visibilityLabels[template.visibility] ||
                    visibilityLabels.workspace}
                {template.category && ` · ${t(templateCategories[template.category])}`}
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
                      await onUse(template);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {t("Verwenden", "Use")}
                </button>
              )}
              {!deleted && (
                <a
                  className="button compact"
                  aria-label={`${template.name} exportieren`}
                  href={`/api/templates/${template.id}/export?workspace=${workspaceId}`}
                  download
                >
                  {t("Exportieren", "Export")}
                </a>
              )}
              {template.can_manage &&
                (deleted ? (
                  <button
                    className="button compact"
                    disabled={busy}
                    onClick={() => change(template, "template.restore")}
                  >
                    {t("Wiederherstellen", "Restore")}
                  </button>
                ) : (
                  <>
                    <button
                      className="button compact"
                      aria-label={t(`${template.name} bearbeiten`, `Edit ${template.name}`)}
                      disabled={busy}
                      onClick={() => setEditing({ ...template })}
                    >
                      {t("Bearbeiten", "Edit")}
                    </button>
                    <button
                      className="button compact danger"
                      aria-label={t(`${template.name} löschen`, `Delete ${template.name}`)}
                      disabled={busy}
                      onClick={() => setRemoving(template)}
                    >
                      {t("Löschen", "Delete")}
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
        title={t("Vorlage bearbeiten", "Edit template")}
      >
        {editing && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void change(editing, "template.update");
            }}
          >
            <label>
              {t("Name", "Name")}
              <input
                required
                maxLength={500}
                value={editing.name}
                onChange={(e) =>
                  setEditing({ ...editing, name: e.target.value })
                }
              />
            </label>
            <label>
              {t("Kategorie", "Category")}
              <Select
                value={editing.category || ""}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    category: e.target.value as TemplateCategory,
                  })
                }
              >
                <option value="">{t("Ohne Kategorie", "No category")}</option>
                {Object.entries(templateCategories).map(([id, label]) => (
                  <option key={id} value={id}>
                    {t(label)}
                  </option>
                ))}
              </Select>
            </label>
            <label>
              {t("Sichtbar für", "Visible to")}
              <Select
                value={editing.visibility}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    visibility: e.target.value as Template["visibility"],
                  })
                }
              >
                <option value="private">{visibilityLabels.private}</option>
                <option value="workspace">{visibilityLabels.workspace}</option>
                {(isAdmin || editing.visibility === "instance") && (
                  <option value="instance" disabled={!isAdmin}>
                    {visibilityLabels.instance} (Admin)
                  </option>
                )}
                {(isAdmin || editing.visibility === "public") && (
                  <option value="public" disabled={!isAdmin}>
                    {visibilityLabels.public} {t("– auch ohne Anmeldung (Admin)", "– also without signing in (admin)")}
                  </option>
                )}
              </Select>
            </label>
            <p className="muted">
              {t("Gespeicherte Inhalte und Anhänge bleiben erhalten. Bereits erstellte Seiten werden nicht verändert.", "Saved content and attachments are kept. Pages already created are not changed.")}
            </p>
            <button
              className="button primary"
              disabled={busy || !editing.name.trim()}
            >
              {t("Änderungen speichern", "Save changes")}
            </button>
          </form>
        )}
      </Modal>
      <Modal
        open={!!removing}
        onClose={() => !busy && setRemoving(null)}
        title={t("Vorlage löschen", "Delete template")}
      >
        <p>
          „{removing?.name}{t("“ in den Vorlagen-Papierkorb verschieben? Die Vorlage kann wiederhergestellt werden. Bereits erstellte Seiten bleiben erhalten.", "” to the template trash? The template can be restored. Pages already created are kept.")}
        </p>
        <button
          className="button danger"
          disabled={busy}
          onClick={() => removing && change(removing, "template.delete")}
        >
          {t("In den Papierkorb", "Move to trash")}
        </button>
      </Modal>
    </section>
  );
}
