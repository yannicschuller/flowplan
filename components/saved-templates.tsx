"use client";
import { serverMessage } from "@/lib/i18n-errors";
import { tr } from "@/lib/locale-tag";
import { useT } from "./i18n";
import { Select } from "./select";
import { useEffect, useState, useCallback } from "react";
import { api, ApiError, Modal, PageIcon } from "./ui";
import { MetaResolveDialog, ScopeBadge } from "./meta-scope";
import type { ForeignMeta, MetaPlan } from "@/lib/meta-scope";
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
  // An emoji (imported templates).
  icon?: string;
  // The space it belongs to (#136); null: the whole workspace.
  space_id?: string | null;
  space_name?: string;
};
const visibilityLabels = {
  private: tr("Nur für mich", "Only me"),
  workspace: tr("Arbeitsbereich", "Workspace"),
  instance: tr("Alle Arbeitsbereiche", "All workspaces"),
  public: tr("Öffentliche Galerie", "Public gallery"),
};
// Templates belong to a space or to the whole workspace (#136): the list
// shows those of `spaceId` (where a new page would go) and the workspace's,
// or all one may see; a template of another space brings its space's tags
// and properties, resolved before it is used or copied.
export default function SavedTemplates({
  workspaceId,
  canCreate,
  isAdmin = false,
  trashDays = 30,
  onUse,
  onError,
  onCount,
  spaceId,
  spaces = [],
  manageWorkspace = false,
}: {
  workspaceId: string;
  canCreate: boolean;
  isAdmin?: boolean;
  // Days in the template trash before deletion for good (0 = never, #123).
  trashDays?: number;
  onUse: (t: Template, meta?: MetaPlan) => Promise<void>;
  onError: (message: string) => void;
  // How many saved templates (not in the trash) there are, for the
  // gallery's "My templates" category (#132).
  onCount?: (count: number) => void;
  spaceId?: string;
  spaces?: { id: string; name: string }[];
  manageWorkspace?: boolean;
}) {
  const t = useT();
  const [items, setItems] = useState<Template[]>([]),
    [deleted, setDeleted] = useState(false),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true);
  const [scopeFilter, setScopeFilter] = useState<"here" | "all">("here"),
    // A template of another space waiting for its tags and properties.
    [resolving, setResolving] = useState<{ items: ForeignMeta[]; target: string; run: (meta: MetaPlan) => Promise<unknown> } | null>(null),
    [copying, setCopying] = useState<Template | null>(null),
    [copyTo, setCopyTo] = useState<string>(""),
    // The server's answer when a template for the whole workspace would
    // carry a space's tags: save without them on confirming.
    [spaceRefs, setSpaceRefs] = useState("");
  const spaceName = (id: string | null | undefined) => spaces.find((sp) => sp.id === id)?.name ?? "";
  // What a template of another space brings into `target`; `run` gets the
  // choices (none needed: at once).
  async function withDependencies(template: Template, target: string | null | undefined, run: (meta?: MetaPlan) => Promise<unknown>) {
    if (!target || !template.space_id || template.space_id === target || template.shared) return run();
    const deps = await api<{ items: ForeignMeta[] }>("/api/command", { action: "template.dependencies", workspaceId, templateId: template.id, spaceId: target }).catch(() => ({
      items: [] as ForeignMeta[],
    }));
    if (!deps.items.length) return run();
    setResolving({ items: deps.items, target: spaceName(target), run });
  }
  const [editing, setEditing] = useState<Template | null>(null),
    [removing, setRemoving] = useState<Template | null>(null),
    [purging, setPurging] = useState<Template | null>(null),
    [emptying, setEmptying] = useState(false);
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
  async function change(t: Template, action: string, extra: Record<string, unknown> = {}) {
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
        ...extra,
      });
      await refresh();
      setEditing(null);
      setRemoving(null);
      setPurging(null);
      setCopying(null);
      setSpaceRefs("");
    } catch (e) {
      // For the whole workspace without the space's tags: confirm first.
      if (e instanceof ApiError && e.status === 409 && /spaceMeta/.test(e.message) && !extra.spaceMeta) setSpaceRefs(e.message);
      else onError((e as Error).message);
      await refresh().catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  // Saving the edit dialog: a new scope is sent along, a template moving to
  // another space resolves its space's tags there first.
  function saveEdit(t: Template) {
    const before = items.find((x) => x.id === t.id);
    const next = t.space_id ?? null;
    if ((before?.space_id ?? null) === next) return change(t, "template.update");
    const extra = { spaceId: next, ...(spaceRefs ? { spaceMeta: "remove" } : {}) };
    if (!next) return change(t, "template.update", extra);
    return withDependencies({ ...t, space_id: before?.space_id ?? null }, next, (meta) => change(t, "template.update", { ...extra, ...(meta ? { meta } : {}) }));
  }
  function copyTemplate(t: Template) {
    const target = copyTo || null;
    const extra = { spaceId: target, ...(spaceRefs ? { spaceMeta: "remove" } : {}) };
    if (!target) return change(t, "template.copy", extra);
    return withDependencies(t, target, (meta) => change(t, "template.copy", { ...extra, ...(meta ? { meta } : {}) }));
  }
  // The template trash, emptied: only templates this person manages.
  async function emptyTemplates() {
    setBusy(true);
    try {
      await api("/api/command", { action: "trash.empty", workspaceId, scope: "templates" });
      await refresh();
      setEmptying(false);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const available = items.filter((item) => !item.deleted_at).length;
  useEffect(() => {
    if (!loading) onCount?.(available);
  }, [available, loading, onCount]);
  const purgeable = items.filter((item) => item.deleted_at && item.can_manage);
  const [search, setSearch] = useState(""),
    [kind, setKind] = useState<"all" | "document" | "database">("all"),
    [category, setCategory] = useState<"all" | TemplateCategory>("all");
  const shown = items.filter(
    (t) =>
      !!t.deleted_at === deleted &&
      (scopeFilter === "all" || !spaceId || !t.space_id || t.space_id === spaceId) &&
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
        {spaceId && (
          <Select aria-label={t("Vorlagen welcher Bereiche", "Templates of which spaces")} value={scopeFilter} onChange={(e) => setScopeFilter(e.target.value as typeof scopeFilter)}>
            <option value="here">{t(`„${spaceName(spaceId)}“ und Arbeitsbereich`, `“${spaceName(spaceId)}” and workspace`)}</option>
            <option value="all">{t("Alle Bereiche", "All spaces")}</option>
          </Select>
        )}
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
      {deleted && (
        <div className="trash-toolbar">
          <p className="muted">
            {trashDays > 0
              ? t(`Vorlagen im Papierkorb werden nach ${trashDays} Tagen endgültig gelöscht.`, `Templates in the trash are deleted permanently after ${trashDays} days.`)
              : t("Vorlagen bleiben im Papierkorb, bis er geleert wird.", "Templates stay in the trash until it is emptied.")}
          </p>
          {purgeable.length > 0 && (
            <button className="button danger compact" disabled={busy} onClick={() => setEmptying(true)}>
              {t("Vorlagen-Papierkorb leeren", "Empty template trash")}
            </button>
          )}
        </div>
      )}
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
            <PageIcon name={template.icon || (template.kind === "database" ? "table" : "file")} />
            <div className="saved-template-name">
              <strong>{template.name}</strong>
              <small>
                {template.shared
                  ? t("Instanzvorlage", "Instance template")
                  : visibilityLabels[template.visibility] ||
                    visibilityLabels.workspace}
                {template.category && ` · ${t(templateCategories[template.category])}`}
              </small>
              {!template.shared && <ScopeBadge spaceId={template.space_id} spaces={spaces} />}
            </div>
            <div className="saved-template-actions">
              {!deleted && (
                <button
                  className="button compact"
                  disabled={busy || !canCreate}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await withDependencies(template, spaceId, (meta) => onUse(template, meta));
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
                  <>
                    <button
                      className="button compact"
                      disabled={busy}
                      onClick={() => change(template, "template.restore")}
                    >
                      {t("Wiederherstellen", "Restore")}
                    </button>
                    <button
                      className="button compact danger"
                      aria-label={t(`${template.name} endgültig löschen`, `Delete ${template.name} permanently`)}
                      disabled={busy}
                      onClick={() => setPurging(template)}
                    >
                      {t("Endgültig löschen", "Delete permanently")}
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      className="button compact"
                      aria-label={t(`${template.name} in einen Bereich kopieren`, `Copy ${template.name} to a space`)}
                      disabled={busy}
                      onClick={() => {
                        setSpaceRefs("");
                        setCopyTo(spaceId && spaceId !== template.space_id ? spaceId : "");
                        setCopying(template);
                      }}
                    >
                      {t("Kopieren", "Copy")}
                    </button>
                    <button
                      className="button compact"
                      aria-label={t(`${template.name} bearbeiten`, `Edit ${template.name}`)}
                      disabled={busy}
                      onClick={() => {
                        setSpaceRefs("");
                        setEditing({ ...template });
                      }}
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
              void saveEdit(editing);
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
            {!["instance", "public"].includes(editing.visibility) && (
              <label>
                {t("Gilt", "Applies")}
                <Select
                  value={editing.space_id ?? ""}
                  onChange={(e) => {
                    setSpaceRefs("");
                    setEditing({ ...editing, space_id: e.target.value || null });
                  }}
                >
                  <option value="" disabled={editing.visibility === "workspace" && !manageWorkspace && !!editing.space_id}>
                    {t("Im ganzen Arbeitsbereich", "In the whole workspace")}
                  </option>
                  {spaces.map((sp) => (
                    <option key={sp.id} value={sp.id}>
                      {t(`Nur im Bereich „${sp.name}“`, `Only in the space “${sp.name}”`)}
                    </option>
                  ))}
                </Select>
              </label>
            )}
            {spaceRefs && (
              <p className="callout" role="alert">
                {spaceRefs} {t("Beim Speichern werden sie aus der Vorlage genommen.", "Saving takes them out of the template.")}
              </p>
            )}
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
      <Modal open={!!copying} onClose={() => !busy && setCopying(null)} title={t("Vorlage kopieren", "Copy template")}>
        {copying && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void copyTemplate(copying);
            }}
          >
            <label>
              {t("Kopie gilt", "The copy applies")}
              <Select
                value={copyTo}
                onChange={(e) => {
                  setSpaceRefs("");
                  setCopyTo(e.target.value);
                }}
              >
                {manageWorkspace && <option value="">{t("Im ganzen Arbeitsbereich", "In the whole workspace")}</option>}
                {spaces.map((sp) => (
                  <option key={sp.id} value={sp.id}>
                    {t(`Nur im Bereich „${sp.name}“`, `Only in the space “${sp.name}”`)}
                  </option>
                ))}
              </Select>
            </label>
            <p className="muted">
              {t(
                "Tags und Eigenschaften des Bereichs der Vorlage werden im Zielbereich zugeordnet oder kopiert – du wählst gleich, wie.",
                "Tags and properties of the template's space are mapped or copied in the target space – you choose how next.",
              )}
            </p>
            {spaceRefs && (
              <p className="callout" role="alert">
                {spaceRefs} {t("Beim Kopieren werden sie aus der Vorlage genommen.", "Copying takes them out of the template.")}
              </p>
            )}
            <button className="button primary" disabled={busy || (!copyTo && !manageWorkspace)}>
              {t("Kopieren", "Copy")}
            </button>
          </form>
        )}
      </Modal>
      {resolving && (
        <MetaResolveDialog
          open
          title={t("Tags und Eigenschaften der Vorlage", "The template's tags and properties")}
          intro={t(
            `Die Vorlage stammt aus einem anderen Bereich und bringt Tags und Eigenschaften mit, die in „${resolving.target}“ nicht gelten. Wähle, was daraus wird.`,
            `The template comes from another space and brings tags and properties that do not apply in “${resolving.target}”. Choose what they become.`,
          )}
          items={resolving.items}
          target={resolving.target}
          confirm={t("Weiter", "Continue")}
          onClose={() => setResolving(null)}
          onConfirm={async (plan) => {
            const run = resolving.run;
            setResolving(null);
            setBusy(true);
            try {
              await run(plan);
            } finally {
              setBusy(false);
            }
          }}
        />
      )}
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
      <Modal
        open={!!purging}
        onClose={() => !busy && setPurging(null)}
        title={t("Vorlage endgültig löschen", "Delete template permanently")}
      >
        <p>
          „{purging?.name}{t("“ endgültig löschen? Die Vorlage und ihre Dateien werden gelöscht; bereits erstellte Seiten bleiben erhalten. Das kann nicht rückgängig gemacht werden.", "” permanently? The template and its files are deleted; pages already created are kept. This cannot be undone.")}
        </p>
        <div className="modal-actions">
          <button className="button" disabled={busy} onClick={() => setPurging(null)}>
            {t("Abbrechen", "Cancel")}
          </button>
          <button
            className="button danger"
            disabled={busy}
            onClick={() => purging && change(purging, "template.purge")}
          >
            {t("Endgültig löschen", "Delete permanently")}
          </button>
        </div>
      </Modal>
      <Modal
        open={emptying}
        onClose={() => !busy && setEmptying(false)}
        title={t("Vorlagen-Papierkorb leeren", "Empty template trash")}
      >
        <p>
          {purgeable.length === 1
            ? t("1 Vorlage endgültig löschen?", "Delete 1 template permanently?")
            : t(`${purgeable.length} Vorlagen endgültig löschen?`, `Delete ${purgeable.length} templates permanently?`)}{" "}
          {t("Nur Vorlagen, die du verwalten darfst. Das kann nicht rückgängig gemacht werden.", "Only templates you may manage. This cannot be undone.")}
        </p>
        <div className="modal-actions">
          <button className="button" disabled={busy} onClick={() => setEmptying(false)}>
            {t("Abbrechen", "Cancel")}
          </button>
          <button className="button danger" disabled={busy} onClick={() => void emptyTemplates()}>
            {t("Vorlagen-Papierkorb leeren", "Empty template trash")}
          </button>
        </div>
      </Modal>
    </section>
  );
}
