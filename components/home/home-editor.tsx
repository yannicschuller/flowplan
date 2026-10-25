"use client";
// Customizing the start page (loaded only when "Anpassen" is pressed): add,
// remove, reorder (drag the handle, or with the keyboard: arrow keys on the
// handle, or the up/down buttons) and resize widgets, change their
// settings and the page's look, then save for this workspace or as the
// default for all of them. Owners can make the layout the workspace's
// default for members who have not set up their own.
import dynamic from "next/dynamic";
import { loadView } from "@/components/view-fallback";
import { useEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import {
  ArrowDown,
  ArrowUp,
  ArrowsOutSimple,
  Check,
  DotsSixVertical,
  DotsThree,
  GearSix,
  PaintBrush,
  Plus,
  Trash,
  X,
} from "@phosphor-icons/react";
import { safeCollisionPadding } from "../safe-area";
import { useT } from "../i18n";
import { api, Modal } from "../ui";
import { Select } from "../select";
import { useCaptureTargets } from "../capture-target";
import { imageFileId } from "@/lib/page-appearance";
import { reveal } from "@/lib/motion";
import type { Page, Space, Workspace } from "@/lib/types";
import type { HomeState } from "@/lib/home-layout";
import {
  headerGradients,
  homeWidgetKinds,
  linkUrl,
  makeWidget,
  MAX_HOME_WIDGETS,
  MAX_LINKS,
  widgetConfigs,
  widgetSizes,
  type HomeAppearance,
  type HomeLayout,
  type HomeWidget,
  type HomeWidgetKind,
  type WidgetSize,
} from "@/lib/home-layout-schema";
import { groupNames, widgetIcon, widgetMeta, widgetName, type WidgetGroup } from "./meta";
import { WidgetBody, WidgetFrame } from "./widgets";
import { GRADIENTS, headerStyle } from "./look";

const EmojiPicker = dynamic(() => loadView(() => import("../emoji-picker")), { ssr: false });

type T = (de: string, en: string) => string;
const sizeName = (size: WidgetSize, t: T) =>
  ({ s: t("Klein · 1 Spalte", "Small · 1 column"), m: t("Mittel · 2 Spalten", "Medium · 2 columns"), l: t("Groß · 3 Spalten", "Large · 3 columns"), full: t("Volle Breite", "Full width") })[size];
const newId = (kind: string) => `${kind}-${Math.random().toString(36).slice(2, 8)}`;

export default function HomeEditor({
  draft,
  setDraft,
  state,
  workspace,
  isAdmin,
  pages,
  spaces,
  onDone,
  onError,
}: {
  draft: HomeLayout;
  setDraft: Dispatch<SetStateAction<HomeLayout | null>>;
  state: HomeState;
  workspace: Workspace;
  isAdmin: boolean;
  pages: Page[];
  spaces: Space[];
  onDone: (home?: HomeState) => void;
  onError: (error: unknown) => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [gallery, setGallery] = useState(false);
  const [settings, setSettings] = useState<string | null>(null);
  const [appearance, setAppearance] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [everywhere, setEverywhere] = useState(state.source === "personal");
  const [teamDefault, setTeamDefault] = useState(state.teamDefault);
  const [announce, setAnnounce] = useState("");
  const [dragging, setDragging] = useState<string | null>(null);
  const owner = workspace.role === "owner" && !workspace.guest;
  const widgets = draft.widgets;
  const update = (change: (layout: HomeLayout) => HomeLayout) => setDraft((d) => (d ? change(d) : d));
  const setWidgets = (change: (list: HomeWidget[]) => HomeWidget[]) => update((d) => ({ ...d, widgets: change(d.widgets) }));
  const say = (text: string) => setAnnounce((prior) => (prior === text ? `${text} ` : text));

  // ---- Order ----
  const moveTo = (id: string, to: number) =>
    setWidgets((list) => {
      const from = list.findIndex((w) => w.id === id);
      if (from < 0) return list;
      const target = Math.max(0, Math.min(list.length - 1, to));
      if (target === from) return list;
      const next = [...list];
      const [item] = next.splice(from, 1);
      next.splice(target, 0, item);
      return next;
    });
  const move = (widget: HomeWidget, by: number) => {
    const from = widgets.findIndex((w) => w.id === widget.id);
    const to = Math.max(0, Math.min(widgets.length - 1, from + by));
    if (to === from) return;
    moveTo(widget.id, to);
    say(t(`${widgetName(widget, t)}: Position ${to + 1} von ${widgets.length}`, `${widgetName(widget, t)}: position ${to + 1} of ${widgets.length}`));
  };
  // Dragging by the handle (mouse, pen, touch): the widget takes the place
  // of the one under the pointer; near the edges the page scrolls.
  const drag = useRef<{ id: string; pointer: number; scroller: HTMLElement | null } | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>, widget: HomeWidget) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { id: widget.id, pointer: e.pointerId, scroller: e.currentTarget.closest(".main-scroll") };
    setDragging(widget.id);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (!current || e.pointerId !== current.pointer) return;
    const scroller = current.scroller;
    if (scroller) {
      const box = scroller.getBoundingClientRect();
      if (e.clientY < box.top + 56) scroller.scrollBy(0, -14);
      else if (e.clientY > box.bottom - 56) scroller.scrollBy(0, 14);
    }
    const over = document
      .elementsFromPoint(e.clientX, e.clientY)
      .map((el) => el.closest<HTMLElement>("[data-widget-id]"))
      .find((el) => el && el.dataset.widgetId !== current.id && grid.current?.contains(el));
    if (!over) return;
    const rect = over.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height * 0.25 || (e.clientY <= rect.bottom - rect.height * 0.25 && e.clientX < rect.left + rect.width / 2);
    setWidgets((list) => {
      const from = list.findIndex((w) => w.id === current.id);
      const target = list.findIndex((w) => w.id === over.dataset.widgetId);
      if (from < 0 || target < 0) return list;
      const next = [...list];
      const [item] = next.splice(from, 1);
      const at = next.findIndex((w) => w.id === over.dataset.widgetId) + (before ? 0 : 1);
      next.splice(at, 0, item);
      return next.map((w) => w.id).join() === list.map((w) => w.id).join() ? list : next;
    });
  };
  const onPointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (!current || e.pointerId !== current.pointer) return;
    drag.current = null;
    setDragging(null);
    const index = widgets.findIndex((w) => w.id === current.id);
    const widget = widgets[index];
    if (widget) say(t(`${widgetName(widget, t)}: Position ${index + 1} von ${widgets.length}`, `${widgetName(widget, t)}: position ${index + 1} of ${widgets.length}`));
  };
  const onHandleKey = (e: React.KeyboardEvent<HTMLButtonElement>, widget: HomeWidget) => {
    const by = { ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1 }[e.key];
    if (by) {
      e.preventDefault();
      move(widget, by);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      move(widget, e.key === "Home" ? -widgets.length : widgets.length);
    }
  };

  // ---- Add, remove, resize ----
  const add = (kind: HomeWidgetKind) => {
    const widget = makeWidget(kind, newId(kind));
    setWidgets((list) => [...list, widget]);
    setGallery(false);
    say(t(`${widgetName(widget, t)} hinzugefügt`, `${widgetName(widget, t)} added`));
    // Widgets that need a page start with their settings.
    if (kind === "database" || kind === "pinned" || kind === "counter") setSettings(widget.id);
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`[data-widget-id="${widget.id}"]`);
      reveal(el, "center");
      if (kind !== "database" && kind !== "pinned" && kind !== "counter") el?.querySelector<HTMLElement>(".home-drag")?.focus();
    });
  };
  const remove = (widget: HomeWidget) => {
    const index = widgets.findIndex((w) => w.id === widget.id);
    setWidgets((list) => list.filter((w) => w.id !== widget.id));
    say(t(`${widgetName(widget, t)} entfernt`, `${widgetName(widget, t)} removed`));
    // Focus goes to the neighbour's handle, or to "Add widget".
    requestAnimationFrame(() => {
      const handles = [...document.querySelectorAll<HTMLElement>(".home-grid .home-drag")];
      (handles[Math.min(index, handles.length - 1)] || document.querySelector<HTMLElement>(".home-add-tile"))?.focus();
    });
  };
  const resize = (widget: HomeWidget, size: WidgetSize) => {
    setWidgets((list) => list.map((w) => (w.id === widget.id ? ({ ...w, size } as HomeWidget) : w)));
    say(`${widgetName(widget, t)}: ${sizeName(size, t)}`);
  };

  // ---- Saving ----
  const save = async () => {
    setBusy(true);
    try {
      onDone(await api<HomeState>("/api/command", { action: "home.save", workspaceId: workspace.id, scope: everywhere ? "personal" : "workspace", layout: draft }));
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };
  const reset = async () => {
    setBusy(true);
    try {
      onDone(await api<HomeState>("/api/command", { action: "home.reset", workspaceId: workspace.id, scope: state.source === "personal" ? "personal" : "workspace" }));
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
      setConfirmReset(false);
    }
  };
  const makeTeamDefault = async (layout: HomeLayout | null) => {
    setBusy(true);
    try {
      await api("/api/command", { action: "home.default", workspaceId: workspace.id, layout });
      setTeamDefault(!!layout);
      say(layout ? t("Als Standard für Mitglieder festgelegt.", "Set as the default for members.") : t("Standard für Mitglieder entfernt.", "Default for members removed."));
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };
  const look = draft.appearance;
  const cover = headerStyle(look.header);
  const editing = widgets.find((w) => w.id === settings) || null;
  return (
    <>
      <div className="home-edit-bar" role="toolbar" aria-label={t("Startseite anpassen", "Customize home page")}>
        <div className="home-edit-title">
          <strong>{t("Startseite anpassen", "Customize home page")}</strong>
          <small>{t("Ziehen zum Sortieren · Pfeiltasten am Griff verschieben", "Drag to reorder · arrow keys on the handle move")}</small>
        </div>
        <div className="home-edit-actions">
          <button type="button" className="button compact" onClick={() => setGallery(true)} disabled={busy} aria-label={t("Widget hinzufügen", "Add widget")}>
            <Plus size={15} aria-hidden />
            <span className="home-edit-label">{t("Widget", "Widget")}</span>
          </button>
          <button type="button" className="button compact" onClick={() => setAppearance(true)} disabled={busy} aria-label={t("Darstellung", "Appearance")}>
            <PaintBrush size={15} aria-hidden />
            <span className="home-edit-label">{t("Darstellung", "Appearance")}</span>
          </button>
          <Dropdown.Root modal={false}>
            <Dropdown.Trigger className="button compact" aria-label={t("Weitere Optionen", "More options")} disabled={busy}>
              <DotsThree size={16} aria-hidden />
            </Dropdown.Trigger>
            <Dropdown.Portal>
              <Dropdown.Content className="dropdown" align="end" sideOffset={6} collisionPadding={safeCollisionPadding()}>
                <Dropdown.CheckboxItem className="dropdown-item" checked={everywhere} onCheckedChange={(v) => setEverywhere(v === true)}>
                  <Dropdown.ItemIndicator>
                    <Check size={14} />
                  </Dropdown.ItemIndicator>
                  {t("Für alle meine Arbeitsbereiche speichern", "Save for all my workspaces")}
                </Dropdown.CheckboxItem>
                {owner && (
                  <Dropdown.Item className="dropdown-item" onSelect={() => void makeTeamDefault(draft)}>
                    {t("Als Standard für Mitglieder festlegen", "Set as default for members")}
                  </Dropdown.Item>
                )}
                {owner && teamDefault && (
                  <Dropdown.Item className="dropdown-item" onSelect={() => void makeTeamDefault(null)}>
                    {t("Standard für Mitglieder entfernen", "Remove default for members")}
                  </Dropdown.Item>
                )}
                <Dropdown.Separator className="dropdown-separator" />
                <Dropdown.Item className="dropdown-item danger" onSelect={() => setConfirmReset(true)}>
                  {t("Zurücksetzen …", "Reset …")}
                </Dropdown.Item>
              </Dropdown.Content>
            </Dropdown.Portal>
          </Dropdown.Root>
          <button type="button" className="button compact" onClick={() => onDone()} disabled={busy}>
            {t("Abbrechen", "Cancel")}
          </button>
          <button type="button" className="button compact primary" onClick={() => void save()} disabled={busy}>
            <Check size={15} aria-hidden />
            {t("Fertig", "Done")}
          </button>
        </div>
      </div>
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
      <p className="sr-only" id="home-drag-hint">
        {t("Mit den Pfeiltasten verschieben, Pos1 und Ende an den Anfang oder das Ende.", "Move with the arrow keys, Home and End to the start or the end.")}
      </p>
      {(cover || look.icon) && (
        <div className={`home-header${cover ? " with-cover" : ""}`}>
          {cover && <div className="home-cover" style={cover} aria-hidden />}
          {look.icon && (
            <span className="home-icon" aria-hidden>
              {look.icon}
            </span>
          )}
        </div>
      )}
      <div className="home-grid-wrap">
        <div className={`home-grid${dragging ? " dragging" : ""}`} ref={grid}>
          {widgets.map((w, i) => {
            const name = widgetName(w, t);
            const Icon = widgetIcon(w);
            return (
              <WidgetFrame
                key={w.id}
                widget={w}
                tools={
                  <div className={`home-widget-tools${dragging === w.id ? " active" : ""}`} role="group" aria-label={t(`Widget ${name}`, `Widget ${name}`)}>
                    <button
                      type="button"
                      className="icon-button home-drag"
                      aria-label={t(`${name} verschieben`, `Move ${name}`)}
                      aria-describedby="home-drag-hint"
                      onPointerDown={(e) => onPointerDown(e, w)}
                      onPointerMove={onPointerMove}
                      onPointerUp={onPointerUp}
                      onPointerCancel={onPointerUp}
                      onKeyDown={(e) => onHandleKey(e, w)}
                    >
                      <DotsSixVertical size={18} weight="bold" />
                    </button>
                    <span className="home-widget-label">
                      <Icon size={14} aria-hidden />
                      {name}
                    </span>
                    <button type="button" className="icon-button" aria-label={t(`${name} nach oben`, `Move ${name} up`)} title={t("Nach oben", "Move up")} disabled={i === 0} onClick={() => move(w, -1)}>
                      <ArrowUp size={15} />
                    </button>
                    <button type="button" className="icon-button" aria-label={t(`${name} nach unten`, `Move ${name} down`)} title={t("Nach unten", "Move down")} disabled={i === widgets.length - 1} onClick={() => move(w, 1)}>
                      <ArrowDown size={15} />
                    </button>
                    <Dropdown.Root modal={false}>
                      <Dropdown.Trigger className="icon-button" aria-label={t(`Größe von ${name}: ${sizeName(w.size, t)}`, `Size of ${name}: ${sizeName(w.size, t)}`)} title={t("Größe", "Size")}>
                        <ArrowsOutSimple size={15} />
                      </Dropdown.Trigger>
                      <Dropdown.Portal>
                        <Dropdown.Content className="dropdown" align="end" sideOffset={4} collisionPadding={safeCollisionPadding()}>
                          <Dropdown.RadioGroup value={w.size} onValueChange={(v) => resize(w, v as WidgetSize)}>
                            {widgetSizes.map((size) => (
                              <Dropdown.RadioItem key={size} value={size} className="dropdown-item">
                                <Dropdown.ItemIndicator>
                                  <Check size={14} />
                                </Dropdown.ItemIndicator>
                                {sizeName(size, t)}
                              </Dropdown.RadioItem>
                            ))}
                          </Dropdown.RadioGroup>
                        </Dropdown.Content>
                      </Dropdown.Portal>
                    </Dropdown.Root>
                    <button type="button" className="icon-button" aria-label={t(`${name} einstellen`, `Settings of ${name}`)} title={t("Einstellungen", "Settings")} onClick={() => setSettings(w.id)}>
                      <GearSix size={15} />
                    </button>
                    <button type="button" className="icon-button" aria-label={t(`${name} entfernen`, `Remove ${name}`)} title={t("Entfernen", "Remove")} onClick={() => remove(w)}>
                      <Trash size={15} />
                    </button>
                  </div>
                }
              >
                <WidgetBody widget={w} />
              </WidgetFrame>
            );
          })}
          <button type="button" className="home-add-tile" onClick={() => setGallery(true)} disabled={widgets.length >= MAX_HOME_WIDGETS}>
            <Plus size={20} aria-hidden />
            {t("Widget hinzufügen", "Add widget")}
          </button>
        </div>
      </div>
      {!widgets.length && <p className="home-empty home-edit-empty">{t("Die Startseite ist leer – füge ein Widget hinzu.", "The home page is empty – add a widget.")}</p>}
      {gallery && <Gallery widgets={widgets} isAdmin={isAdmin} onAdd={add} onClose={() => setGallery(false)} />}
      {editing && (
        <WidgetSettings
          key={editing.id}
          widget={editing}
          workspaceId={workspace.id}
          pages={pages}
          spaces={spaces}
          onClose={() => setSettings(null)}
          onSave={(next) => {
            setWidgets((list) => list.map((w) => (w.id === next.id ? next : w)));
            setSettings(null);
          }}
        />
      )}
      {appearance && <AppearanceDialog value={look} pages={pages} onChange={(next) => update((d) => ({ ...d, appearance: next }))} onClose={() => setAppearance(false)} />}
      {confirmReset && (
        <Modal open title={t("Startseite zurücksetzen?", "Reset the home page?")} onClose={() => setConfirmReset(false)}>
          <p>
            {state.source === "workspace"
              ? state.fallbackSource === "personal"
                ? t("Dieser Arbeitsbereich zeigt danach wieder deine Standard-Startseite.", "This workspace then shows your default home page again.")
                : state.fallbackSource === "team"
                  ? t("Du siehst danach die Startseite, die dieser Arbeitsbereich für Mitglieder vorgibt.", "You then see the home page this workspace sets for its members.")
                  : t("Du siehst danach wieder die ursprüngliche Startseite.", "You then see the original home page again.")
              : state.source === "personal"
                ? t("Deine Standard-Startseite für alle Arbeitsbereiche wird entfernt.", "Your default home page for all workspaces is removed.")
                : t("Du siehst danach wieder die ursprüngliche Startseite.", "You then see the original home page again.")}
          </p>
          <div className="modal-actions">
            <button type="button" className="button" onClick={() => setConfirmReset(false)}>
              {t("Abbrechen", "Cancel")}
            </button>
            <button type="button" className="button primary" disabled={busy} onClick={() => void reset()}>
              {t("Zurücksetzen", "Reset")}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

// ---- Gallery ----

function Gallery({ widgets, isAdmin, onAdd, onClose }: { widgets: HomeWidget[]; isAdmin: boolean; onAdd: (kind: HomeWidgetKind) => void; onClose: () => void }) {
  const t = useT();
  const full = widgets.length >= MAX_HOME_WIDGETS;
  const groups: WidgetGroup[] = ["overview", "plan", "write", "tools"];
  return (
    <Modal open wide title={t("Widget hinzufügen", "Add widget")} onClose={onClose} className="home-gallery">
      {full && <p className="muted">{t(`Höchstens ${MAX_HOME_WIDGETS} Widgets – entferne zuerst eines.`, `At most ${MAX_HOME_WIDGETS} widgets – remove one first.`)}</p>}
      {groups.map((group) => (
        <section key={group}>
          <h3>{t(groupNames[group].de, groupNames[group].en)}</h3>
          <div className="home-gallery-grid">
            {homeWidgetKinds
              .filter((kind) => widgetMeta[kind].group === group && (!widgetMeta[kind].adminOnly || isAdmin))
              .map((kind) => {
                const meta = widgetMeta[kind];
                const taken = !!meta.single && widgets.some((w) => w.kind === kind);
                return (
                  <button key={kind} type="button" className="home-gallery-tile" disabled={full || taken} onClick={() => onAdd(kind)}>
                    <span className="home-gallery-icon">
                      <meta.icon size={20} aria-hidden />
                    </span>
                    <span>
                      <strong>{t(meta.name.de, meta.name.en)}</strong>
                      <small>{taken ? t("Schon auf der Startseite.", "Already on the home page.") : t(meta.description.de, meta.description.en)}</small>
                    </span>
                  </button>
                );
              })}
          </div>
        </section>
      ))}
    </Modal>
  );
}

// ---- Settings of one widget ----

function useOptions<T>(workspaceId: string, kind: "calendar" | "habits" | "database", pageId?: string) {
  const [value, setValue] = useState<T | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (kind === "database" && !pageId) return;
    let current = true;
    setValue(null);
    setFailed(false);
    api<T>(`/api/home/options?${new URLSearchParams({ workspace: workspaceId, kind, ...(pageId ? { page: pageId } : {}) })}`)
      .then((v) => current && setValue(v))
      .catch(() => current && setFailed(true));
    return () => {
      current = false;
    };
  }, [workspaceId, kind, pageId]);
  return { value, failed };
}
type DatabaseDetail = { database: { id: string; views?: { id: string; name: string; type: string }[]; properties?: { id: string; name: string; type: string }[]; locked?: true; encrypted?: true } | null };

function Choice<V extends string>({ legend, value, options, onChange }: { legend: string; value: V; options: [V, string][]; onChange: (v: V) => void }) {
  return (
    <fieldset className="home-choice">
      <legend>{legend}</legend>
      <div>
        {options.map(([v, label]) => (
          <label key={v}>
            <input type="radio" checked={value === v} onChange={() => onChange(v)} />
            <span>{label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="checkbox-label">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}
function PagePicker({ label, value, pages, onChange, empty }: { label: string; value?: string; pages: Page[]; onChange: (id: string | undefined) => void; empty?: string }) {
  const t = useT();
  return (
    <label>
      {label}
      <Select value={value || ""} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">{empty ?? t("Bitte wählen …", "Please choose …")}</option>
        {pages.map((p) => (
          <option key={p.id} value={p.id}>
            {p.title || t("Ohne Titel", "Untitled")}
          </option>
        ))}
      </Select>
    </label>
  );
}
function ViewPicker({ workspaceId, pageId, viewId, onChange, children }: { workspaceId: string; pageId?: string; viewId?: string; onChange: (id: string | undefined) => void; children?: (detail: DatabaseDetail["database"]) => ReactNode }) {
  const t = useT();
  const { value, failed } = useOptions<DatabaseDetail>(workspaceId, "database", pageId);
  if (!pageId) return null;
  if (failed) return <p className="muted">{t("Die Datenbank lässt sich nicht laden.", "The database cannot be loaded.")}</p>;
  if (!value) return <p className="muted">{t("Wird geladen …", "Loading …")}</p>;
  const detail = value.database;
  if (detail?.locked || detail?.encrypted) return <p className="muted">{t("Diese Datenbank ist geschützt.", "This database is protected.")}</p>;
  return (
    <>
      <label>
        {t("Ansicht", "View")}
        <Select value={viewId || ""} onChange={(e) => onChange(e.target.value || undefined)}>
          <option value="">{t("Standardansicht", "Default view")}</option>
          {(detail?.views || []).map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </Select>
      </label>
      {children?.(detail)}
    </>
  );
}

function WidgetSettings({ widget, workspaceId, pages, spaces, onClose, onSave }: { widget: HomeWidget; workspaceId: string; pages: Page[]; spaces: Space[]; onClose: () => void; onSave: (widget: HomeWidget) => void }) {
  const t = useT();
  const [config, setConfig] = useState<Record<string, unknown>>({ ...widget.config });
  const [size, setSize] = useState<WidgetSize>(widget.size);
  const [error, setError] = useState("");
  const set = (patch: Record<string, unknown>) => setConfig((c) => ({ ...c, ...patch }));
  const c = config as Record<string, any>;
  const defaultName = widgetName({ ...widget, config: { ...widget.config, title: "" } } as HomeWidget, t);
  const databases = pages.filter((p) => p.kind === "database");
  const journals = pages.filter((p) => p.kind === "journal");
  const linkable = pages.filter((p) => !p.journal_date);
  const apply = () => {
    const parsed = widgetConfigs[widget.kind].safeParse({ ...config, title: (c.title || "").trim() || undefined });
    if (!parsed.success) {
      setError(widget.kind === "links" ? t("Bitte prüfe die Adressen: sie beginnen mit https:// oder mailto:.", "Please check the addresses: they start with https:// or mailto:.") : t("Bitte prüfe die Eingaben.", "Please check the entries."));
      return;
    }
    onSave({ ...widget, size, config: parsed.data } as HomeWidget);
  };
  let fields: ReactNode = null;
  switch (widget.kind) {
    case "greeting":
      fields = (
        <>
          <Toggle label={t("Datum anzeigen", "Show the date")} checked={!!c.showDate} onChange={(v) => set({ showDate: v })} />
          <Toggle label={t("Satz unter der Begrüßung anzeigen", "Show a line under the greeting")} checked={!!c.showMessage} onChange={(v) => set({ showMessage: v })} />
          {c.showMessage && (
            <label>
              {t("Eigener Satz", "Own line")}
              <input value={c.message || ""} maxLength={140} placeholder={t("Gute Ideen beginnen hier. Mach dort weiter, wo du aufgehört hast.", "Good ideas start here. Pick up where you left off.")} onChange={(e) => set({ message: e.target.value })} />
            </label>
          )}
        </>
      );
      break;
    case "recent":
      fields = (
        <>
          <Choice legend={t("Welche Seiten", "Which pages")} value={c.mode} options={[["edited", t("Zuletzt bearbeitet", "Recently edited")], ["viewed", t("Zuletzt angesehen", "Recently viewed")]]} onChange={(v) => set({ mode: v })} />
          <Choice legend={t("Darstellung", "Display")} value={c.style} options={[["cards", t("Karten", "Cards")], ["list", t("Liste", "List")]]} onChange={(v) => set({ style: v })} />
          <Count label={t("Anzahl", "Number")} value={c.max} min={2} max={12} onChange={(v) => set({ max: v })} />
        </>
      );
      break;
    case "quick": {
      const all = [
        ["page", t("Neue Seite", "New page")],
        ["capture", t("Schnell erfassen", "Quick capture")],
        ["database", t("Neue Datenbank", "New database")],
        ["journal", t("Neues Journal", "New journal")],
        ["whiteboard", t("Neues Whiteboard", "New whiteboard")],
      ] as const;
      fields = (
        <fieldset className="home-choice">
          <legend>{t("Schnellstarts", "Quick starts")}</legend>
          {all.map(([key, label]) => (
            <Toggle
              key={key}
              label={label}
              checked={(c.actions as string[]).includes(key)}
              onChange={(on) => set({ actions: on ? all.map(([k]) => k).filter((k) => k === key || (c.actions as string[]).includes(k)) : (c.actions as string[]).filter((k) => k !== key) })}
            />
          ))}
        </fieldset>
      );
      break;
    }
    case "pages":
      fields = (
        <label>
          {t("Bereich", "Space")}
          <Select value={c.spaceId || ""} onChange={(e) => set({ spaceId: e.target.value || undefined })}>
            <option value="">{t("Alle Bereiche", "All spaces")}</option>
            {spaces
              .filter((s) => !s.deleted_at)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </Select>
        </label>
      );
      break;
    case "favorites":
      fields = <Count label={t("Anzahl", "Number")} value={c.max} min={3} max={20} onChange={(v) => set({ max: v })} />;
      break;
    case "tasks":
      fields = (
        <>
          <Choice legend={t("Quelle", "Source")} value={c.source} options={[["mine", t("Meine Aufgaben", "My tasks")], ["view", t("Ansicht einer Datenbank", "Database view")]]} onChange={(v) => set({ source: v })} />
          {c.source === "view" && (
            <>
              <PagePicker label={t("Datenbank", "Database")} value={c.pageId} pages={databases} onChange={(id) => set({ pageId: id, viewId: undefined })} />
              <ViewPicker workspaceId={workspaceId} pageId={c.pageId} viewId={c.viewId} onChange={(id) => set({ viewId: id })} />
            </>
          )}
          <Choice
            legend={t("Zeigen", "Show")}
            value={c.filter}
            options={[
              ["due", t("Heute fällig und überfällig", "Due today and overdue")],
              ["today", t("Heute fällig", "Due today")],
              ["overdue", t("Überfällig", "Overdue")],
              ["open", t("Alle offenen", "All open")],
            ]}
            onChange={(v) => set({ filter: v })}
          />
          <Count label={t("Anzahl", "Number")} value={c.max} min={1} max={10} onChange={(v) => set({ max: v })} />
        </>
      );
      break;
    case "inbox":
      fields = (
        <>
          <Toggle label={t("Nur ungelesene", "Unread only")} checked={!!c.unreadOnly} onChange={(v) => set({ unreadOnly: v })} />
          <Count label={t("Anzahl", "Number")} value={c.max} min={1} max={10} onChange={(v) => set({ max: v })} />
        </>
      );
      break;
    case "journal":
      fields = (
        <>
          <PagePicker label={t("Journal", "Journal")} value={c.journalId} pages={journals} empty={t("Mein Journal (automatisch)", "My journal (automatic)")} onChange={(id) => set({ journalId: id })} />
          <Toggle label={t("Schnell schreiben anbieten", "Offer quick writing")} checked={!!c.quickWrite} onChange={(v) => set({ quickWrite: v })} />
        </>
      );
      break;
    case "calendar":
      fields = <CalendarFields workspaceId={workspaceId} config={c} set={set} />;
      break;
    case "database":
      fields = (
        <>
          <PagePicker label={t("Datenbank", "Database")} value={c.pageId} pages={databases} onChange={(id) => set({ pageId: id, viewId: undefined, properties: [] })} />
          <ViewPicker workspaceId={workspaceId} pageId={c.pageId} viewId={c.viewId} onChange={(id) => set({ viewId: id })}>
            {(detail) =>
              detail?.properties && (
                <fieldset className="home-choice">
                  <legend>{t("Eigenschaften (höchstens 3)", "Properties (at most 3)")}</legend>
                  {detail.properties.slice(1).map((p) => (
                    <Toggle
                      key={p.id}
                      label={p.name}
                      checked={(c.properties as string[]).includes(p.id)}
                      onChange={(on) => set({ properties: on ? [...(c.properties as string[]), p.id].slice(-3) : (c.properties as string[]).filter((id) => id !== p.id) })}
                    />
                  ))}
                </fieldset>
              )
            }
          </ViewPicker>
          <Choice legend={t("Darstellung", "Display")} value={c.style} options={[["list", t("Liste", "List")], ["table", t("Tabelle", "Table")], ["board", t("Board (nach der ersten Eigenschaft)", "Board (by the first property)")]]} onChange={(v) => set({ style: v })} />
          <Count label={t("Einträge", "Records")} value={c.max} min={1} max={10} onChange={(v) => set({ max: v })} />
        </>
      );
      break;
    case "pinned":
      fields = (
        <>
          <PagePicker label={t("Seite", "Page")} value={c.pageId} pages={linkable} onChange={(id) => set({ pageId: id })} />
          <Toggle label={t("Vorschau und Unterseiten zeigen", "Show a preview and sub pages")} checked={!!c.preview} onChange={(v) => set({ preview: v })} />
        </>
      );
      break;
    case "capture":
      fields = <CaptureFields workspaceId={workspaceId} value={c.targetId} onChange={(id) => set({ targetId: id })} />;
      break;
    case "focus":
      fields = <Count label={t("Fokuszeit in Minuten", "Focus time in minutes")} value={c.minutes} min={5} max={120} onChange={(v) => set({ minutes: v })} />;
      break;
    case "habits":
      fields = <HabitFields workspaceId={workspaceId} value={c.pageId} onChange={(id) => set({ pageId: id })} />;
      break;
    case "counter":
      fields = (
        <>
          <PagePicker label={t("Datenbank", "Database")} value={c.pageId} pages={databases} onChange={(id) => set({ pageId: id, viewId: undefined, fieldId: undefined })} />
          <ViewPicker workspaceId={workspaceId} pageId={c.pageId} viewId={c.viewId} onChange={(id) => set({ viewId: id })}>
            {(detail) => (
              <>
                <Choice legend={t("Wert", "Value")} value={c.aggregate} options={[["count", t("Anzahl", "Count")], ["sum", t("Summe", "Sum")], ["average", t("Durchschnitt", "Average")]]} onChange={(v) => set({ aggregate: v })} />
                {c.aggregate !== "count" && (
                  <label>
                    {t("Eigenschaft", "Property")}
                    <Select value={c.fieldId || ""} onChange={(e) => set({ fieldId: e.target.value || undefined })}>
                      <option value="">{t("Bitte wählen …", "Please choose …")}</option>
                      {(detail?.properties || [])
                        .filter((p) => p.type === "number" || p.type === "formula" || p.type === "rollup")
                        .map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                    </Select>
                  </label>
                )}
              </>
            )}
          </ViewPicker>
          <Toggle label={t("Verlauf der letzten 14 Tage", "History of the last 14 days")} checked={!!c.history} onChange={(v) => set({ history: v })} />
        </>
      );
      break;
    case "activity":
      fields = (
        <>
          <Toggle label={t("Auch Datenbankeinträge", "Database records too")} checked={!!c.records} onChange={(v) => set({ records: v })} />
          <Count label={t("Anzahl", "Number")} value={c.max} min={3} max={15} onChange={(v) => set({ max: v })} />
        </>
      );
      break;
    case "links":
      fields = <LinkFields links={c.links} onChange={(links) => set({ links })} />;
      break;
  }
  return (
    <Modal open title={t(`${defaultName} einstellen`, `${defaultName} settings`)} onClose={onClose} className="home-settings">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          apply();
        }}
      >
        {widget.kind !== "greeting" && (
          <label>
            {t("Überschrift", "Heading")}
            <input value={c.title || ""} maxLength={60} placeholder={defaultName} onChange={(e) => set({ title: e.target.value })} />
          </label>
        )}
        {fields}
        <label>
          {t("Größe", "Size")}
          <Select value={size} onChange={(e) => setSize(e.target.value as WidgetSize)}>
            {widgetSizes.map((s) => (
              <option key={s} value={s}>
                {sizeName(s, t)}
              </option>
            ))}
          </Select>
        </label>
        {error && (
          <p role="alert" className="math-validation">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            {t("Abbrechen", "Cancel")}
          </button>
          <button type="submit" className="button primary">
            {t("Übernehmen", "Apply")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Count({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <label>
      {label}
      <input type="number" inputMode="numeric" min={min} max={max} value={value} onChange={(e) => onChange(Math.max(min, Math.min(max, Math.round(Number(e.target.value) || min))))} />
    </label>
  );
}

function CalendarFields({ workspaceId, config, set }: { workspaceId: string; config: Record<string, any>; set: (patch: Record<string, unknown>) => void }) {
  const t = useT();
  const { value } = useOptions<{ calendars: { pageId: string; viewId: string; name: string; database: string; synced: string | null }[] }>(workspaceId, "calendar");
  const chosen = (config.sources || []) as { pageId: string; viewId?: string }[];
  const has = (c: { pageId: string; viewId: string }) => chosen.some((s) => s.pageId === c.pageId && (s.viewId || "") === c.viewId);
  return (
    <>
      <Choice legend={t("Zeitraum", "Period")} value={config.range} options={[["today", t("Heute", "Today")], ["3days", t("Nächste 3 Tage", "Next 3 days")], ["week", t("Nächste 7 Tage", "Next 7 days")]]} onChange={(v) => set({ range: v })} />
      <fieldset className="home-choice">
        <legend>{t("Kalender", "Calendars")}</legend>
        {!value && <p className="muted">{t("Wird geladen …", "Loading …")}</p>}
        {value && !value.calendars.length && <p className="muted">{t("Noch keine Datenbank mit Kalender- oder Zeitleistenansicht.", "No database with a calendar or timeline view yet.")}</p>}
        {value && value.calendars.length > 0 && <p className="muted">{t("Keine Auswahl: alle Kalender dieses Arbeitsbereichs.", "Nothing chosen: all calendars of this workspace.")}</p>}
        {value?.calendars.map((cal) => (
          <Toggle
            key={`${cal.pageId}:${cal.viewId}`}
            label={`${cal.synced || cal.database} · ${cal.name}`}
            checked={has(cal)}
            onChange={(on) =>
              set({
                sources: on ? [...chosen, { pageId: cal.pageId, viewId: cal.viewId }].slice(0, 10) : chosen.filter((s) => !(s.pageId === cal.pageId && (s.viewId || "") === cal.viewId)),
              })
            }
          />
        ))}
      </fieldset>
      <Toggle label={t("Fällige Aufgaben mit anzeigen", "Show due tasks too")} checked={!!config.tasks} onChange={(v) => set({ tasks: v })} />
      <Count label={t("Anzahl", "Number")} value={config.max} min={1} max={10} onChange={(v) => set({ max: v })} />
    </>
  );
}

function CaptureFields({ workspaceId, value, onChange }: { workspaceId: string; value?: string; onChange: (id: string | undefined) => void }) {
  const t = useT();
  const [targets] = useCaptureTargets(workspaceId);
  return (
    <label>
      {t("Datenbank", "Database")}
      <Select value={value || ""} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">{t("Meine Standard-Erfassung", "My default capture database")}</option>
        {(targets?.databases || []).map((d) => (
          <option key={d.id} value={d.id}>
            {d.title || t("Ohne Titel", "Untitled")}
          </option>
        ))}
      </Select>
    </label>
  );
}

function HabitFields({ workspaceId, value, onChange }: { workspaceId: string; value?: string; onChange: (id: string | undefined) => void }) {
  const t = useT();
  const { value: options } = useOptions<{ habits: { id: string; name: string; habits: { id: string; name: string }[] }[] }>(workspaceId, "habits");
  return (
    <>
      <label>
        {t("Datenbank mit Gewohnheiten", "Habit database")}
        <Select value={value || ""} onChange={(e) => onChange(e.target.value || undefined)}>
          <option value="">{t("Automatisch", "Automatic")}</option>
          {(options?.habits || []).map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </Select>
      </label>
      <p className="muted">{t("Eine Datenbank mit einem Datum und Kontrollkästchen: jeder Tag ein Eintrag, jedes Kästchen eine Gewohnheit.", "A database with a date and checkboxes: one record per day, one checkbox per habit.")}</p>
    </>
  );
}

function LinkFields({ links, onChange }: { links: { title: string; url: string }[]; onChange: (links: { title: string; url: string }[]) => void }) {
  const t = useT();
  const set = (i: number, patch: Partial<{ title: string; url: string }>) => onChange(links.map((l, n) => (n === i ? { ...l, ...patch } : l)));
  const swap = (i: number, j: number) => {
    const next = [...links];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  return (
    <fieldset className="home-choice home-links-edit">
      <legend>{t("Links", "Links")}</legend>
      {links.map((link, i) => (
        <div key={i} className="home-link-row">
          <input value={link.title} maxLength={80} placeholder={t("Name", "Name")} aria-label={t(`Name von Link ${i + 1}`, `Name of link ${i + 1}`)} onChange={(e) => set(i, { title: e.target.value })} />
          <input
            value={link.url}
            maxLength={2000}
            inputMode="url"
            placeholder="https://"
            aria-label={t(`Adresse von Link ${i + 1}`, `Address of link ${i + 1}`)}
            aria-invalid={!!link.url && !linkUrl.safeParse(link.url).success}
            onChange={(e) => set(i, { url: e.target.value })}
          />
          <button type="button" className="icon-button" aria-label={t(`Link ${i + 1} nach oben`, `Move link ${i + 1} up`)} disabled={i === 0} onClick={() => swap(i, i - 1)}>
            <ArrowUp size={14} />
          </button>
          <button type="button" className="icon-button" aria-label={t(`Link ${i + 1} entfernen`, `Remove link ${i + 1}`)} onClick={() => onChange(links.filter((_, n) => n !== i))}>
            <X size={14} />
          </button>
        </div>
      ))}
      <button type="button" className="button compact" disabled={links.length >= MAX_LINKS} onClick={() => onChange([...links, { title: "", url: "https://" }])}>
        <Plus size={14} aria-hidden />
        {t("Link hinzufügen", "Add link")}
      </button>
    </fieldset>
  );
}

// ---- Look ----

const COLORS = ["#dce7f5", "#cdded8", "#f1dfc8", "#e2dded", "#f4d9d6", "#263b55", "#2f3b2f", "#c4d4e6"];
const ICONS = ["🏠", "🚀", "🌿", "☀️", "📚", "🎯", "✨", "🧭", "🗂️", "☕"];
function AppearanceDialog({ value, pages, onChange, onClose }: { value: HomeAppearance; pages: Page[]; onChange: (next: HomeAppearance) => void; onClose: () => void }) {
  const t = useT();
  const [picker, setPicker] = useState(false);
  const set = (patch: Partial<HomeAppearance>) => onChange({ ...value, ...patch });
  const header = value.header;
  const setHeader = (patch: Partial<HomeAppearance["header"]>) => set({ header: { ...header, ...patch } });
  // Images the person can see already: covers of pages in this workspace.
  const images = [...new Map(pages.filter((p) => imageFileId(p.cover)).map((p) => [p.cover, p])).values()].slice(0, 24);
  const gradientName: Record<string, string> = {
    dawn: t("Morgenrot", "Dawn"),
    ocean: t("Ozean", "Ocean"),
    forest: t("Wald", "Forest"),
    dusk: t("Dämmerung", "Dusk"),
    sand: t("Sand", "Sand"),
    slate: t("Schiefer", "Slate"),
  };
  return (
    <Modal open wide title={t("Darstellung der Startseite", "Home page appearance")} onClose={onClose} className="home-appearance">
      <p className="muted">{t("Änderungen siehst du sofort; gespeichert wird mit „Fertig“.", "Changes show at once; “Done” saves them.")}</p>
      <Choice
        legend={t("Kopfbereich", "Header")}
        value={header.type}
        options={[
          ["none", t("Keiner", "None")],
          ["color", t("Farbe", "Colour")],
          ["gradient", t("Verlauf", "Gradient")],
          ["image", t("Bild", "Image")],
        ]}
        onChange={(type) =>
          setHeader({ type, value: type === "color" ? COLORS[0] : type === "gradient" ? headerGradients[0] : type === "image" ? images[0]?.cover || "" : "" })
        }
      />
      {header.type === "color" && (
        <div className="home-swatches" role="radiogroup" aria-label={t("Farbe", "Colour")}>
          {COLORS.map((color) => (
            <button key={color} type="button" role="radio" aria-checked={header.value === color} aria-label={color} style={{ background: color }} onClick={() => setHeader({ value: color })} />
          ))}
        </div>
      )}
      {header.type === "gradient" && (
        <div className="home-swatches wide" role="radiogroup" aria-label={t("Verlauf", "Gradient")}>
          {headerGradients.map((g) => (
            <button key={g} type="button" role="radio" aria-checked={header.value === g} aria-label={gradientName[g]} title={gradientName[g]} style={{ background: GRADIENTS[g] }} onClick={() => setHeader({ value: g })} />
          ))}
        </div>
      )}
      {header.type === "image" &&
        (images.length ? (
          <>
            <div className="home-swatches images" role="radiogroup" aria-label={t("Bild", "Image")}>
              {images.map((p) => (
                <button key={p.cover} type="button" role="radio" aria-checked={header.value === p.cover} aria-label={t(`Cover von ${p.title}`, `Cover of ${p.title}`)} style={{ backgroundImage: `url("${p.cover}")` }} onClick={() => setHeader({ value: p.cover })} />
              ))}
            </div>
            <label>
              {t("Bildausschnitt", "Image crop")} · {Math.round(header.position)} %
              <input type="range" min={0} max={100} value={header.position} aria-label={t("Vertikale Position", "Vertical position")} onChange={(e) => setHeader({ position: Number(e.target.value) })} />
            </label>
          </>
        ) : (
          <p className="muted">{t("Noch keine Seite mit Coverbild – gib einer Seite ein Cover, dann steht es hier zur Auswahl.", "No page with a cover image yet – give a page a cover and it shows up here.")}</p>
        ))}
      <fieldset className="home-choice">
        <legend>{t("Symbol", "Icon")}</legend>
        <div className="home-icons">
          {ICONS.map((icon) => (
            <button key={icon} type="button" className={`icon-button${value.icon === icon ? " active" : ""}`} aria-pressed={value.icon === icon} onClick={() => set({ icon: value.icon === icon ? "" : icon })}>
              <span aria-hidden>{icon}</span>
              <span className="sr-only">{icon}</span>
            </button>
          ))}
          <button type="button" className="button compact" onClick={() => setPicker((v) => !v)} aria-expanded={picker}>
            {t("Weitere …", "More …")}
          </button>
          {value.icon && (
            <button type="button" className="button compact" onClick={() => set({ icon: "" })}>
              {t("Kein Symbol", "No icon")}
            </button>
          )}
        </div>
        {picker && (
          <EmojiPicker
            selected={value.icon}
            allowSymbols={false}
            onSelect={async (icon) => {
              if ([...icon].length <= 8 && !icon.startsWith("icon:")) set({ icon });
              setPicker(false);
            }}
          />
        )}
      </fieldset>
      <Choice legend={t("Abstände", "Spacing")} value={value.density} options={[["comfortable", t("Großzügig", "Comfortable")], ["compact", t("Kompakt", "Compact")]]} onChange={(density) => set({ density })} />
      <Choice
        legend={t("Hintergrund", "Background")}
        value={value.background}
        options={[
          ["none", t("Schlicht", "Plain")],
          ["dots", t("Punkte", "Dots")],
          ["grid", t("Raster", "Grid")],
          ["tint", t("Getönt", "Tinted")],
        ]}
        onChange={(background) => set({ background })}
      />
      <Choice legend={t("Breite", "Width")} value={value.width} options={[["normal", t("Normal", "Normal")], ["wide", t("Breit", "Wide")]]} onChange={(width) => set({ width })} />
      <div className="modal-actions">
        <button type="button" className="button primary" onClick={onClose}>
          {t("Schließen", "Close")}
        </button>
      </div>
    </Modal>
  );
}
