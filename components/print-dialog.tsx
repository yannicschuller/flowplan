"use client";
// "Drucken / PDF" (#215): the options dialog before a page, a record or the
// combined print view (a page with sub-pages, a space) goes to the browser's
// print dialog – content (cover, icon, tags, properties, page numbers, title
// page, table of contents) and look (paper, title size, typefaces, links) –
// with the print presets: the person's own and the workspace's (owners
// define those, everyone uses them). The last choice is remembered on the
// server (lib/print-settings.ts). Mounted once by the workspace shell;
// requestPrint() opens it from anywhere.
import { useEffect, useId, useState, useSyncExternalStore, type ReactNode } from "react";
import { Buildings, FloppyDisk, PencilSimple, Printer, Star, Trash } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { Modal, reportError } from "./ui";
import { Select } from "./select";
import {
  DEFAULT_PRINT_OPTIONS,
  PRINT_PRESET_LIMITS,
  initialPrintOptions,
  sameOptions,
  type PrintContext,
  type PrintOptions,
  type PrintPreset,
  type UserPrintSettings,
  type WorkspacePrintPresets,
} from "@/lib/print-options";

type Say = (de: string, en: string) => string;
export type PrintRequest = { kind: PrintContext; run: (options: PrintOptions) => void | Promise<void> };
type Command = (body: Record<string, unknown>) => Promise<unknown>;

// ---- Opening it from anywhere ----

let pending: PrintRequest | null = null;
let hostMounted = 0;
let lastKnown: PrintOptions = { ...DEFAULT_PRINT_OPTIONS };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
// Without the shell (a shared or published page) it prints right away
// with the last options.
export function requestPrint(request: PrintRequest) {
  if (!hostMounted) return void request.run(lastKnown);
  pending = request;
  emit();
}
const closeRequest = () => {
  pending = null;
  emit();
};

// ---- The options ----

const id = () => (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);

function Check({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (on: boolean) => void; hint?: string }) {
  return (
    <label className="checkbox-label print-check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {hint && <small>{hint}</small>}
      </span>
    </label>
  );
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="print-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

// The switches and choices. `kind`: which apply ("all" in the settings).
export function PrintOptionsForm({ options, onChange, kind }: { options: PrintOptions; onChange: (next: PrintOptions) => void; kind: PrintContext | "all" }) {
  const t = useT();
  const set = <K extends keyof PrintOptions>(key: K) => (value: PrintOptions[K]) => onChange({ ...options, [key]: value });
  const page = kind !== "book",
    book = kind !== "page";
  const fonts = (
    <>
      <option value="default">{t("Standard", "Default")}</option>
      <option value="serif">{t("Serifenschrift", "Serif")}</option>
      <option value="sans">{t("Serifenlose Schrift", "Sans-serif")}</option>
      <option value="workspace">{t("Schrift des Arbeitsbereichs", "Workspace font")}</option>
    </>
  );
  return (
    <div className="print-options-form">
      <details className="print-section" open>
        <summary>{t("Inhalt", "Content")}</summary>
        <div className="print-checks">
          <Check label={t("Titelbild", "Cover image")} checked={options.cover} onChange={set("cover")} />
          {page && <Check label={t("Icon", "Icon")} checked={options.icon} onChange={set("icon")} />}
          {page && <Check label={t("Tags", "Tags")} checked={options.tags} onChange={set("tags")} />}
          {page && <Check label={t("Eigenschaften", "Properties")} checked={options.properties} onChange={set("properties")} />}
          {book && <Check label={t("Titelseite", "Title page")} checked={options.titlePage} onChange={set("titlePage")} />}
          {book && <Check label={t("Inhaltsverzeichnis", "Table of contents")} checked={options.toc} onChange={set("toc")} />}
          <Check label={t("Seitenzahlen", "Page numbers")} checked={options.pageNumbers} onChange={set("pageNumbers")} />
        </div>
      </details>
      <details className="print-section" open>
        <summary>{t("Aussehen", "Look")}</summary>
        <div className="print-fields">
          <Field label={t("Papierformat", "Paper size")}>
            <Select value={options.paper} onChange={(e) => set("paper")(e.target.value as PrintOptions["paper"])}>
              <option value="auto">{kind === "book" ? t("Standard (A4)", "Default (A4)") : t("Standard", "Default")}</option>
              <option value="a4">A4</option>
              <option value="letter">{t("US Letter", "US Letter")}</option>
            </Select>
          </Field>
          <Field label={t("Titelgröße", "Title size")}>
            <Select value={options.titleSize} onChange={(e) => set("titleSize")(e.target.value as PrintOptions["titleSize"])}>
              <option value="small">{t("Klein", "Small")}</option>
              <option value="normal">{t("Normal", "Normal")}</option>
              <option value="large">{t("Groß", "Large")}</option>
            </Select>
          </Field>
          <Field label={t("Schrift für Text", "Body font")}>
            <Select value={options.bodyFont} onChange={(e) => set("bodyFont")(e.target.value as PrintOptions["bodyFont"])}>
              {fonts}
            </Select>
          </Field>
          <Field label={t("Schrift für Überschriften", "Heading font")}>
            <Select value={options.headingFont} onChange={(e) => set("headingFont")(e.target.value as PrintOptions["headingFont"])}>
              {fonts}
            </Select>
          </Field>
          <Field label={t("Links", "Links")}>
            <Select value={options.links} onChange={(e) => set("links")(e.target.value as PrintOptions["links"])}>
              <option value="auto">{kind === "book" ? t("Standard (mit Adresse)", "Default (with address)") : t("Standard", "Default")}</option>
              <option value="plain">{t("Wie normaler Text", "Like normal text")}</option>
              <option value="underline">{t("Unterstrichen", "Underlined")}</option>
              <option value="dashed">{t("Gestrichelt unterstrichen", "Dashed underline")}</option>
              <option value="address">{t("Mit Adresse in Klammern", "With the address in brackets")}</option>
            </Select>
          </Field>
        </div>
      </details>
      {options.pageNumbers && (
        <p className="print-note muted">
          {t(
            "Seitenzahlen setzen Chrome und Edge in die Fußzeile. Firefox und Safari zeigen stattdessen ihre eigenen Kopf- und Fußzeilen, wenn du sie im Druckdialog einschaltest.",
            "Chrome and Edge put page numbers in the footer. Firefox and Safari show their own headers and footers instead when you turn them on in the print dialog.",
          )}
        </p>
      )}
    </div>
  );
}

// ---- Presets ----

type Scope = "user" | "workspace";
export type PresetLists = { user: PrintPreset[]; workspace: WorkspacePrintPresets };

// Saves a whole list: the person's own or the workspace's.
export async function savePresets(command: Command, workspaceId: string, scope: Scope, presets: PrintPreset[], defaultId?: string | null) {
  if (scope === "user") return ((await command({ action: "profile.print", presets })) as UserPrintSettings).presets;
  const result = (await command({ action: "workspace.printPresets", workspaceId, presets, defaultId: defaultId ?? null })) as WorkspacePrintPresets;
  return result;
}

const presetKey = (scope: Scope, presetId: string) => `${scope}:${presetId}`;
function NameForm({ initial, onSave, onCancel, label, children }: { initial: string; onSave: (name: string) => void; onCancel: () => void; label: string; children?: ReactNode }) {
  const t = useT();
  const [name, setName] = useState(initial);
  const inputId = useId();
  return (
    <div className="print-preset-name" role="group" aria-label={label}>
      <label htmlFor={inputId} className="sr-only">
        {t("Name der Vorlage", "Preset name")}
      </label>
      <input
        id={inputId}
        autoFocus
        value={name}
        maxLength={PRINT_PRESET_LIMITS.name}
        placeholder={t("z. B. Sauber für extern", "e.g. Clean for external")}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            if (name.trim()) onSave(name.trim());
          }
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
      />
      {children}
      <button type="button" className="button compact" onClick={onCancel}>
        {t("Abbrechen", "Cancel")}
      </button>
      <button type="button" className="button compact primary" disabled={!name.trim()} onClick={() => onSave(name.trim())}>
        {t("Speichern", "Save")}
      </button>
    </div>
  );
}

// ---- The dialog ----

export function PrintDialogHost({
  settings,
  workspace,
  workspaceId,
  owner,
  command,
}: {
  settings: UserPrintSettings | undefined;
  workspace: WorkspacePrintPresets | undefined;
  workspaceId: string;
  // May change the workspace's presets.
  owner: boolean;
  command: Command;
}) {
  const request = useSyncExternalStore(subscribe, () => pending, () => null);
  const [mine, setMine] = useState<UserPrintSettings>(settings ?? { last: null, presets: [] });
  const [shared, setShared] = useState<WorkspacePrintPresets>(workspace ?? { presets: [], defaultId: null });
  useEffect(() => setMine(settings ?? { last: null, presets: [] }), [settings]);
  useEffect(() => setShared(workspace ?? { presets: [], defaultId: null }), [workspace]);
  useEffect(() => {
    hostMounted++;
    return () => void hostMounted--;
  }, []);
  useEffect(() => {
    lastKnown = initialPrintOptions(mine, shared);
  }, [mine, shared]);
  if (!request) return null;
  return (
    <PrintDialog
      key={String(request.kind)}
      request={request}
      mine={mine}
      shared={shared}
      owner={owner}
      onMine={setMine}
      onShared={setShared}
      workspaceId={workspaceId}
      command={command}
    />
  );
}

function PrintDialog({
  request,
  mine,
  shared,
  owner,
  onMine,
  onShared,
  workspaceId,
  command,
}: {
  request: PrintRequest;
  mine: UserPrintSettings;
  shared: WorkspacePrintPresets;
  owner: boolean;
  onMine: (next: UserPrintSettings) => void;
  onShared: (next: WorkspacePrintPresets) => void;
  workspaceId: string;
  command: Command;
}) {
  const t = useT();
  const [options, setOptions] = useState<PrintOptions>(() => initialPrintOptions(mine, shared));
  const [naming, setNaming] = useState<null | { mode: "new" } | { mode: "rename"; scope: Scope; id: string }>(null);
  const [saveScope, setSaveScope] = useState<Scope>("user");
  const [busy, setBusy] = useState(false);
  const all = [
    ...mine.presets.map((preset) => ({ scope: "user" as const, preset })),
    ...shared.presets.map((preset) => ({ scope: "workspace" as const, preset })),
  ];
  // The preset the options match (none once something is changed).
  const matching = all.find((entry) => sameOptions(entry.preset.options, options));
  const [chosen, setChosen] = useState<string>(() => (matching ? presetKey(matching.scope, matching.preset.id) : ""));
  const current = all.find((entry) => presetKey(entry.scope, entry.preset.id) === chosen && sameOptions(entry.preset.options, options));
  const canEdit = current && (current.scope === "user" || owner);
  const close = () => closeRequest();
  const fail = (e: unknown) => reportError(e);

  async function store(scope: Scope, presets: PrintPreset[], defaultId?: string | null) {
    setBusy(true);
    try {
      const result = await savePresets(command, workspaceId, scope, presets, defaultId);
      if (scope === "user") onMine({ ...mine, presets: result as PrintPreset[] });
      else onShared(result as WorkspacePrintPresets);
      return true;
    } catch (e) {
      fail(e);
      return false;
    } finally {
      setBusy(false);
    }
  }
  const listOf = (scope: Scope) => (scope === "user" ? mine.presets : shared.presets);
  async function saveNew(name: string) {
    const preset: PrintPreset = { id: id(), name, options };
    if (await store(saveScope, [...listOf(saveScope), preset], saveScope === "workspace" ? shared.defaultId : undefined)) {
      setChosen(presetKey(saveScope, preset.id));
      setNaming(null);
    }
  }
  async function rename(scope: Scope, presetId: string, name: string) {
    if (await store(scope, listOf(scope).map((p) => (p.id === presetId ? { ...p, name } : p)), scope === "workspace" ? shared.defaultId : undefined)) setNaming(null);
  }
  async function remove(scope: Scope, presetId: string) {
    const preset = listOf(scope).find((p) => p.id === presetId);
    if (!preset || !confirm(t(`Druckvorlage „${preset.name}“ löschen?`, `Delete the print preset “${preset.name}”?`))) return;
    if (await store(scope, listOf(scope).filter((p) => p.id !== presetId), scope === "workspace" && shared.defaultId !== presetId ? shared.defaultId : null)) setChosen("");
  }
  function print() {
    close();
    // The last choice, for the next time and other devices.
    const last = options;
    onMine({ ...mine, last });
    void command({ action: "profile.print", options: last }).catch(() => {});
    void Promise.resolve(request.run(last)).catch(fail);
  }
  return (
    <Modal open onClose={close} title={request.kind === "book" ? t("Drucken / PDF mit Unterseiten", "Print / PDF with sub-pages") : t("Drucken / PDF", "Print / PDF")} className="print-dialog" sheet>
      <form
        className="print-dialog-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!naming) print();
        }}
      >
        <div className="print-presets">
          <Field label={t("Druckvorlage", "Print preset")}>
            <Select
              value={current ? chosen : ""}
              onChange={(e) => {
                const entry = all.find((x) => presetKey(x.scope, x.preset.id) === e.target.value);
                setChosen(e.target.value);
                if (entry) setOptions({ ...entry.preset.options });
              }}
            >
              <option value="">{t("Eigene Auswahl", "Custom")}</option>
              {mine.presets.length > 0 && (
                <optgroup label={t("Meine Vorlagen", "My presets")}>
                  {mine.presets.map((p) => (
                    <option key={p.id} value={presetKey("user", p.id)}>
                      {p.name}
                    </option>
                  ))}
                </optgroup>
              )}
              {shared.presets.length > 0 && (
                <optgroup label={t("Vorlagen des Arbeitsbereichs", "Workspace presets")}>
                  {shared.presets.map((p) => (
                    <option key={p.id} value={presetKey("workspace", p.id)}>
                      {`${p.name}${shared.defaultId === p.id ? ` · ${t("Standard", "Default")}` : ""}`}
                    </option>
                  ))}
                </optgroup>
              )}
            </Select>
          </Field>
          <div className="print-preset-actions">
            {current?.scope === "workspace" && (
              <span className="print-badge" title={owner ? t("Vorlage des Arbeitsbereichs", "Workspace preset") : t("Vorlage des Arbeitsbereichs – nur Eigentümer können sie ändern", "Workspace preset – only owners can change it")}>
                <Buildings size={13} aria-hidden /> {t("Arbeitsbereich", "Workspace")}
              </span>
            )}
            {canEdit && current && (
              <>
                <button type="button" className="icon-button" aria-label={t("Vorlage umbenennen", "Rename preset")} title={t("Umbenennen", "Rename")} disabled={busy} onClick={() => setNaming({ mode: "rename", scope: current.scope, id: current.preset.id })}>
                  <PencilSimple size={16} />
                </button>
                <button type="button" className="icon-button" aria-label={t("Vorlage löschen", "Delete preset")} title={t("Löschen", "Delete")} disabled={busy} onClick={() => void remove(current.scope, current.preset.id)}>
                  <Trash size={16} />
                </button>
              </>
            )}
            {!current && !naming && (
              <button type="button" className="text-button" disabled={busy} onClick={() => setNaming({ mode: "new" })}>
                <FloppyDisk size={15} aria-hidden /> {t("Als Vorlage speichern …", "Save as preset …")}
              </button>
            )}
          </div>
          {naming?.mode === "new" && (
            <NameForm initial="" label={t("Als Vorlage speichern", "Save as preset")} onCancel={() => setNaming(null)} onSave={(name) => void saveNew(name)}>
              {owner && (
                <Select value={saveScope} aria-label={t("Speichern für", "Save for")} onChange={(e) => setSaveScope(e.target.value as Scope)}>
                  <option value="user">{t("Nur für mich", "Just for me")}</option>
                  <option value="workspace">{t("Für den Arbeitsbereich", "For the workspace")}</option>
                </Select>
              )}
            </NameForm>
          )}
          {naming?.mode === "rename" && (
            <NameForm
              initial={listOf(naming.scope).find((p) => p.id === naming.id)?.name || ""}
              label={t("Vorlage umbenennen", "Rename preset")}
              onCancel={() => setNaming(null)}
              onSave={(name) => void rename(naming.scope, naming.id, name)}
            />
          )}
        </div>
        <PrintOptionsForm options={options} onChange={setOptions} kind={request.kind} />
        <div className="modal-actions">
          <button type="button" className="button" onClick={close}>
            {t("Abbrechen", "Cancel")}
          </button>
          <button className="button primary" disabled={busy}>
            <Printer size={16} aria-hidden /> {t("Drucken", "Print")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---- Settings: managing a list of presets ----

export function PresetManager({
  presets,
  editable,
  scope,
  defaultId,
  onSave,
  emptyText,
}: {
  presets: PrintPreset[];
  editable: boolean;
  scope: Scope;
  defaultId?: string | null;
  // The whole list (and the workspace's default); false when it failed.
  onSave: (presets: PrintPreset[], defaultId: string | null) => Promise<boolean>;
  emptyText: string;
}) {
  const t = useT();
  const [editing, setEditing] = useState<PrintPreset | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async (list: PrintPreset[], nextDefault: string | null = defaultId ?? null) => {
    setBusy(true);
    try {
      return await onSave(list, list.some((p) => p.id === nextDefault) ? nextDefault : null);
    } finally {
      setBusy(false);
    }
  };
  const nameTaken = (name: string, except?: string) => presets.some((p) => p.id !== except && p.name.trim().toLowerCase() === name.trim().toLowerCase());
  return (
    <div className="print-preset-manager">
      {presets.length === 0 && !editing && <p className="muted print-preset-empty">{emptyText}</p>}
      {presets.length > 0 && (
        <ul className="print-preset-list">
          {presets.map((preset) => (
            <li key={preset.id}>
              <span className="print-preset-title">
                {preset.name}
                {scope === "workspace" && (
                  <span className="print-badge">
                    <Buildings size={12} aria-hidden /> {t("Arbeitsbereich", "Workspace")}
                  </span>
                )}
                {defaultId === preset.id && <span className="print-badge">{t("Standard", "Default")}</span>}
              </span>
              <span className="muted print-preset-summary">{summary(preset.options, t)}</span>
              {editable && (
                <span className="print-preset-row-actions">
                  {scope === "workspace" && (
                    <button
                      type="button"
                      className="icon-button"
                      aria-pressed={defaultId === preset.id}
                      aria-label={defaultId === preset.id ? t("Nicht mehr Standard", "No longer the default") : t("Als Standard festlegen", "Make the default")}
                      title={defaultId === preset.id ? t("Nicht mehr Standard", "No longer the default") : t("Als Standard festlegen", "Make the default")}
                      disabled={busy}
                      onClick={() => void save(presets, defaultId === preset.id ? null : preset.id)}
                    >
                      <Star size={16} weight={defaultId === preset.id ? "fill" : "regular"} />
                    </button>
                  )}
                  <button type="button" className="icon-button" aria-label={t(`${preset.name} bearbeiten`, `Edit ${preset.name}`)} title={t("Bearbeiten", "Edit")} disabled={busy} onClick={() => setEditing({ ...preset })}>
                    <PencilSimple size={16} />
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={t(`${preset.name} löschen`, `Delete ${preset.name}`)}
                    title={t("Löschen", "Delete")}
                    disabled={busy}
                    onClick={() => {
                      if (confirm(t(`Druckvorlage „${preset.name}“ löschen?`, `Delete the print preset “${preset.name}”?`))) void save(presets.filter((p) => p.id !== preset.id));
                    }}
                  >
                    <Trash size={16} />
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <div className="print-preset-editor">
          <Field label={t("Name der Vorlage", "Preset name")}>
            <input value={editing.name} maxLength={PRINT_PRESET_LIMITS.name} placeholder={t("z. B. Sauber für extern", "e.g. Clean for external")} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
          </Field>
          {nameTaken(editing.name, editing.id) && <p className="print-problem">{t("Eine Vorlage mit diesem Namen gibt es schon.", "A preset with this name already exists.")}</p>}
          <PrintOptionsForm options={editing.options} onChange={(options) => setEditing({ ...editing, options })} kind="all" />
          <div className="modal-actions">
            <button type="button" className="button" onClick={() => setEditing(null)}>
              {t("Abbrechen", "Cancel")}
            </button>
            <button
              type="button"
              className="button primary"
              disabled={busy || !editing.name.trim() || nameTaken(editing.name, editing.id)}
              onClick={async () => {
                const next = { ...editing, name: editing.name.trim() };
                const list = presets.some((p) => p.id === next.id) ? presets.map((p) => (p.id === next.id ? next : p)) : [...presets, next];
                if (await save(list)) setEditing(null);
              }}
            >
              {t("Speichern", "Save")}
            </button>
          </div>
        </div>
      )}
      {editable && !editing && presets.length < PRINT_PRESET_LIMITS.presets && (
        <button type="button" className="button compact" onClick={() => setEditing({ id: id(), name: "", options: { ...DEFAULT_PRINT_OPTIONS } })}>
          {t("Neue Druckvorlage", "New print preset")}
        </button>
      )}
    </div>
  );
}

// "Ohne Titelbild, ohne Tags, Seitenzahlen" – what differs from the defaults.
function summary(options: PrintOptions, t: Say) {
  const parts: string[] = [];
  if (!options.cover) parts.push(t("ohne Titelbild", "no cover image"));
  if (!options.icon) parts.push(t("ohne Icon", "no icon"));
  if (!options.tags) parts.push(t("ohne Tags", "no tags"));
  if (!options.properties) parts.push(t("ohne Eigenschaften", "no properties"));
  if (!options.pageNumbers) parts.push(t("ohne Seitenzahlen", "no page numbers"));
  if (!options.titlePage) parts.push(t("ohne Titelseite", "no title page"));
  if (!options.toc) parts.push(t("ohne Inhaltsverzeichnis", "no table of contents"));
  if (options.paper !== "auto") parts.push(options.paper === "a4" ? "A4" : t("US Letter", "US Letter"));
  if (options.titleSize !== "normal") parts.push(options.titleSize === "small" ? t("kleine Titel", "small titles") : t("große Titel", "large titles"));
  if (options.bodyFont !== "default" || options.headingFont !== "default") parts.push(t("eigene Schriften", "own fonts"));
  if (options.links !== "auto") parts.push(t("eigene Linkdarstellung", "own link style"));
  return parts.length ? parts.join(", ") : t("wie Standard", "as the default");
}
