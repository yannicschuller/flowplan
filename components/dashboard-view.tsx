"use client";
// Dashboard pages: a grid of tiles (lib/dashboard-schema.ts) with data the
// server computes per person (lib/dashboard.ts). Editors switch to edit
// mode to add, configure, resize and reorder tiles (drag or menu); viewers
// only read.
import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import {
  ArrowDown,
  ArrowUp,
  ArrowsOutLineHorizontal,
  Bell,
  CheckSquare,
  DotsSixVertical,
  DotsThree,
  Fire,
  PencilSimple,
  Plus,
  Trash,
} from "@phosphor-icons/react";
import { useT } from "./i18n";
import { Modal, PageIcon, api } from "./ui";
import { Select } from "./select";
import { ContextMenu, type ContextMenuItem } from "./context-menu";
import { currentStreak, localDay } from "./journal-view";
import { localToday } from "@/lib/task-due-plugin";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { chartGroupField, chartNumberField } from "@/lib/database-chart";
import { tileTypes, tileSizes, type Tile, type TileSize, type TileType } from "@/lib/dashboard-schema";
import type { DashboardSources } from "@/lib/dashboard";
import type { DatabaseData } from "./database-view";
import type { Field, Page, Role, Row, User, View } from "@/lib/types";

const DatabaseView = dynamic(() => import("./database-view"), { ssr: false });
const DatabaseChart = dynamic(() => import("./database-chart"), { ssr: false });

export type DashboardPayload = {
  tiles: Tile[];
  data: Record<string, TileData>;
  sources?: DashboardSources;
};
type Unavailable = { available: false };
type TileData =
  | Unavailable
  | ({ available: true } & Partial<{
      title: string;
      view: string | View;
      viewName: string;
      role: Role | null;
      formatted: string;
      value: number | null;
      source: string;
      field: string;
      records: number;
      target: number | null;
      progress: number | null;
      fields: Field[];
      rows: Row[];
      related: Record<string, Row[]>;
      journalId: string;
      days: { id: string; date: string; written: boolean; excerpt: string }[];
      tasks: { pageId: string; rowId: string | null; index: number; text: string; due: string | null; title: string; icon: string }[];
      pages: { id: string; title: string; icon: string; kind: string; updated_at: string }[];
      unread: number;
      html: string;
    }>);

const newId = () => Math.random().toString(36).slice(2, 10);

export default function DashboardView({
  pageId,
  dashboard,
  editable,
  userId,
  members,
  pages,
  onRefresh,
  onError,
}: {
  pageId: string;
  dashboard: DashboardPayload;
  editable: boolean;
  userId: string;
  members: User[];
  pages: Page[];
  onRefresh: () => Promise<unknown>;
  onError: (message: string) => void;
}) {
  const t = useT();
  const [tiles, setTiles] = useState<Tile[]>(dashboard.tiles);
  const [editing, setEditing] = useState(false),
    [configuring, setConfiguring] = useState<Tile | null>(null),
    [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null),
    [dragged, setDragged] = useState<string | null>(null),
    [saving, setSaving] = useState(false);
  // The server's tiles win whenever they change (reload, someone else saved).
  useEffect(() => setTiles(dashboard.tiles), [dashboard.tiles]);
  const typeNames: Record<TileType, string> = {
    view: t("Datenbankansicht", "Database view"),
    number: t("Kennzahl", "Metric"),
    chart: t("Diagramm", "Chart"),
    journal: t("Journal-Serie", "Journal streak"),
    tasks: t("Meine fälligen Aufgaben", "My due tasks"),
    recent: t("Zuletzt geändert", "Recently changed"),
    text: t("Text", "Text"),
  };
  const sizeNames: Record<TileSize, string> = {
    small: t("Klein", "Small"),
    medium: t("Mittel", "Medium"),
    large: t("Groß", "Large"),
    full: t("Volle Breite", "Full width"),
  };
  async function save(next: Tile[]) {
    const previous = tiles;
    setTiles(next);
    setSaving(true);
    try {
      await api("/api/command", { action: "dashboard.save", pageId, tiles: next });
      await onRefresh();
    } catch (error) {
      setTiles(previous);
      onError((error as Error).message);
    } finally {
      setSaving(false);
    }
  }
  const move = (from: number, to: number) => {
    if (to < 0 || to >= tiles.length || from === to) return;
    const next = [...tiles];
    const [tile] = next.splice(from, 1);
    next.splice(to, 0, tile);
    void save(next);
  };
  const canEdit = editable && editing;
  const menuTile = menu && tiles.find((tile) => tile.id === menu.id);
  const menuIndex = menuTile ? tiles.indexOf(menuTile) : -1;
  return (
    <div className="dashboard">
      {editable && (
        <div className="dashboard-toolbar">
          {editing && (
            <button
              type="button"
              className="button compact"
              onClick={() => setConfiguring({ id: newId(), type: "text", size: "medium", title: "", text: "" })}
            >
              <Plus size={14} /> {t("Kachel hinzufügen", "Add tile")}
            </button>
          )}
          <button
            type="button"
            className={`button compact${editing ? " primary" : ""}`}
            aria-pressed={editing}
            disabled={saving}
            onClick={() => setEditing(!editing)}
          >
            {editing ? t("Fertig", "Done") : <><PencilSimple size={14} /> {t("Bearbeiten", "Edit")}</>}
          </button>
        </div>
      )}
      {!tiles.length && (
        <div className="dashboard-empty">
          <p>{t("Dieses Dashboard hat noch keine Kacheln.", "This dashboard has no tiles yet.")}</p>
          {editable && (
            <button
              type="button"
              className="button primary"
              onClick={() => {
                setEditing(true);
                setConfiguring({ id: newId(), type: "text", size: "medium", title: "", text: "" });
              }}
            >
              <Plus size={14} /> {t("Erste Kachel hinzufügen", "Add the first tile")}
            </button>
          )}
        </div>
      )}
      <div className={`dashboard-grid${canEdit ? " editing" : ""}`}>
        {tiles.map((tile, index) => (
          <section
            key={tile.id}
            className={`dashboard-tile size-${tile.size} type-${tile.type}${dragged === tile.id ? " dragging" : ""}`}
            aria-label={tile.title || typeNames[tile.type]}
            draggable={canEdit}
            onDragStart={(e) => {
              if (!canEdit) return;
              setDragged(tile.id);
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", tile.id);
            }}
            onDragEnd={() => setDragged(null)}
            onDragOver={(e) => {
              if (canEdit && dragged && dragged !== tile.id) e.preventDefault();
            }}
            onDrop={(e) => {
              e.preventDefault();
              const from = tiles.findIndex((x) => x.id === dragged);
              setDragged(null);
              if (from >= 0) move(from, index);
            }}
          >
            <header className="dashboard-tile-header">
              {canEdit && <DotsSixVertical size={16} className="dashboard-grip" aria-hidden="true" />}
              <h2>{tile.title || defaultTitle(tile, dashboard.data[tile.id], typeNames)}</h2>
              {canEdit && (
                <button
                  type="button"
                  className="icon-button"
                  aria-label={t("Kachel-Menü", "Tile menu")}
                  onClick={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    setMenu({ id: tile.id, x: rect.left, y: rect.bottom + 4 });
                  }}
                >
                  <DotsThree size={18} />
                </button>
              )}
            </header>
            <div className="dashboard-tile-body">
              <TileBody
                tile={tile}
                data={dashboard.data[tile.id]}
                userId={userId}
                members={members}
                pages={pages}
                onError={onError}
              />
            </div>
          </section>
        ))}
      </div>
      {menu && menuTile && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={t("Kachel-Menü", "Tile menu")}
          onClose={() => setMenu(null)}
          items={[
            { icon: <PencilSimple size={16} />, label: t("Einstellen …", "Configure …"), run: () => setConfiguring(menuTile) },
            "separator",
            ...tileSizes.map(
              (size): ContextMenuItem => ({
                icon: <ArrowsOutLineHorizontal size={16} />,
                label: (menuTile.size === size ? "✓ " : "") + sizeNames[size],
                disabled: menuTile.size === size,
                run: () => void save(tiles.map((x) => (x.id === menuTile.id ? { ...x, size } : x))),
              }),
            ),
            "separator",
            { icon: <ArrowUp size={16} />, label: t("Nach vorne", "Move earlier"), disabled: menuIndex <= 0, run: () => move(menuIndex, menuIndex - 1) },
            { icon: <ArrowDown size={16} />, label: t("Nach hinten", "Move later"), disabled: menuIndex >= tiles.length - 1, run: () => move(menuIndex, menuIndex + 1) },
            "separator",
            { icon: <Trash size={16} />, label: t("Entfernen", "Remove"), danger: true, run: () => void save(tiles.filter((x) => x.id !== menuTile.id)) },
          ]}
        />
      )}
      {configuring && (
        <TileEditor
          initial={configuring}
          isNew={!tiles.some((x) => x.id === configuring.id)}
          sources={dashboard.sources || { databases: [], journals: [] }}
          typeNames={typeNames}
          sizeNames={sizeNames}
          onClose={() => setConfiguring(null)}
          onSave={(tile) => {
            setConfiguring(null);
            const exists = tiles.some((x) => x.id === tile.id);
            void save(exists ? tiles.map((x) => (x.id === tile.id ? tile : x)) : [...tiles, tile]);
          }}
        />
      )}
    </div>
  );
}

function defaultTitle(tile: Tile, data: TileData | undefined, names: Record<TileType, string>) {
  if (data?.available && data.title && (tile.type === "view" || tile.type === "chart" || tile.type === "journal"))
    return tile.type === "view" && data.viewName ? `${data.title} · ${data.viewName}` : data.title;
  return names[tile.type];
}

function Unavailable() {
  const t = useT();
  return <p className="dashboard-muted">{t("Nicht verfügbar – keine Berechtigung oder Quelle entfernt.", "Not available – no permission or the source was removed.")}</p>;
}

function TileBody({
  tile,
  data,
  userId,
  members,
  pages,
  onError,
}: {
  tile: Tile;
  data: TileData | undefined;
  userId: string;
  members: User[];
  pages: Page[];
  onError: (message: string) => void;
}) {
  const t = useT();
  if (!data || !data.available) return <Unavailable />;
  switch (tile.type) {
    case "text":
      return data.html ? (
        <div className="dashboard-text" dangerouslySetInnerHTML={{ __html: data.html }} />
      ) : (
        <p className="dashboard-muted">{t("Noch kein Text.", "No text yet.")}</p>
      );
    case "number":
      return (
        <div className="dashboard-number">
          <a className="dashboard-value" href={`/#page=${tile.source}`}>
            {data.formatted}
          </a>
          {tile.target !== null && (
            <>
              <div
                className="dashboard-progress"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round((data.progress || 0) * 100)}
              >
                <span style={{ width: `${(data.progress || 0) * 100}%` }} />
              </div>
              <small>
                {t("Ziel", "Target")}: {tile.target.toLocaleString(LOCALE_TAG)} · {Math.round((data.progress || 0) * 100)} %
              </small>
            </>
          )}
          <small className="dashboard-muted">{[data.source, data.view as string, data.field].filter(Boolean).join(" · ")}</small>
        </div>
      );
    case "chart":
      return data.view && data.fields && data.rows ? (
        <div className="dashboard-chart">
          <DatabaseChart
            view={data.view as View}
            version={0}
            fields={data.fields}
            rows={data.rows}
            related={data.related || {}}
            members={members}
            editable={false}
            onSave={async () => undefined}
            onOpenRow={(row) => {
              location.hash = `page=${tile.source}&row=${row}`;
            }}
          />
        </div>
      ) : (
        <Unavailable />
      );
    case "journal":
      return <JournalTile tile={tile} data={data} />;
    case "tasks": {
      const today = localToday();
      const due = (data.tasks || []).filter((task) => task.due && task.due <= today);
      if (!due.length) return <p className="dashboard-muted">{t("Nichts fällig – alles erledigt.", "Nothing due – all done.")}</p>;
      return (
        <ul className="dashboard-list">
          {due.slice(0, 12).map((task) => (
            <li key={`${task.pageId}-${task.rowId}-${task.index}`}>
              <CheckSquare size={16} aria-hidden="true" />
              <a href={task.rowId ? `/#page=${task.pageId}&row=${task.rowId}` : `/#page=${task.pageId}`}>
                {task.text || t("Ohne Text", "No text")}
              </a>
              <small className={task.due! < today ? "dashboard-overdue" : "dashboard-muted"}>
                {task.due! < today ? t("Überfällig", "Overdue") : t("Heute", "Today")} · {task.title}
              </small>
            </li>
          ))}
          {due.length > 12 && (
            <li>
              <a href="/#tasks">{t("Alle Aufgaben", "All tasks")} ({due.length})</a>
            </li>
          )}
        </ul>
      );
    }
    case "recent":
      return (
        <>
          <a className="dashboard-inbox" href="/#inbox">
            <Bell size={16} aria-hidden="true" />
            {data.unread
              ? t(`${data.unread} ungelesene Benachrichtigungen`, `${data.unread} unread notifications`)
              : t("Posteingang gelesen", "Inbox read")}
          </a>
          <ul className="dashboard-list">
            {(data.pages || []).map((page) => (
              <li key={page.id}>
                <PageIcon name={page.icon} size={16} />
                <a href={`/#page=${page.id}`}>{page.title || t("Ohne Titel", "Untitled")}</a>
                <small className="dashboard-muted">{shortDate(page.updated_at)}</small>
              </li>
            ))}
          </ul>
        </>
      );
    case "view":
      return <ViewTile tile={tile} data={data} userId={userId} members={members} pages={pages} onError={onError} />;
  }
}

function shortDate(value: string) {
  const date = new Date(value.includes("T") ? value : value.replace(" ", "T") + "Z");
  return Number.isNaN(date.getTime())
    ? ""
    : new Intl.DateTimeFormat(LOCALE_TAG, { day: "numeric", month: "short" }).format(date);
}

function JournalTile({ tile, data }: { tile: Extract<Tile, { type: "journal" }>; data: TileData }) {
  const t = useT();
  if (!data.available) return <Unavailable />;
  const today = localDay();
  const days = data.days || [];
  const streak = currentStreak(new Set(days.filter((d) => d.written).map((d) => d.date)), today);
  const entry = days.find((d) => d.date === today);
  return (
    <div className="dashboard-journal">
      <div className="dashboard-number">
        <span className="dashboard-value">
          <Fire size={26} weight="fill" aria-hidden="true" /> {streak}
        </span>
        <small className="dashboard-muted">{streak === 1 ? t("Tag in Folge", "day in a row") : t("Tage in Folge", "days in a row")}</small>
      </div>
      {entry ? (
        <a className="dashboard-entry" href={`/#page=${entry.id}`}>
          <strong>{t("Heutiger Eintrag", "Today's entry")}</strong>
          <span>{entry.excerpt || t("Noch leer – jetzt schreiben", "Still empty – write now")}</span>
        </a>
      ) : (
        <a className="button compact" href={`/#page=${tile.source}`}>
          {t("Heute schreiben", "Write today")}
        </a>
      )}
    </div>
  );
}

// A view of a database: loaded like the page itself (the server checks
// access and hides private records), showing only the chosen view.
function ViewTile({
  tile,
  data,
  userId,
  members,
  pages,
  onError,
}: {
  tile: Extract<Tile, { type: "view" }>;
  data: TileData;
  userId: string;
  members: User[];
  pages: Page[];
  onError: (message: string) => void;
}) {
  const t = useT();
  const [source, setSource] = useState<(DatabaseData & { page: Page; role: Role }) | null>(null),
    [failed, setFailed] = useState(false);
  const alive = useRef(true);
  async function load() {
    try {
      const next = await api<DatabaseData & { page: Page; role: Role }>(`/api/pages/${tile.source}`);
      if (alive.current) setSource(next);
    } catch {
      if (alive.current) setFailed(true);
    }
  }
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tile.source]);
  if (failed || !data.available) return <Unavailable />;
  if (!source || !source.database) return <p className="dashboard-muted">{t("Ansicht wird geöffnet …", "Opening view …")}</p>;
  const chosen = source.database.views.filter((v) => v.id === (data.view || tile.view) && v.type !== "form");
  const views = chosen.length ? chosen : source.database.views.filter((v) => v.type !== "form").slice(0, 1);
  return (
    <div className="dashboard-view-embed">
      <DatabaseView
        key={`${tile.source}-${views[0]?.id}`}
        data={{ ...source, database: { ...source.database, views } }}
        page={source.page}
        userId={userId}
        members={members}
        pages={pages}
        editable={tile.interactive && source.role !== "viewer" && !source.page.locked}
        viewEditable={false}
        allowFieldChanges={false}
        mutate={async (body) => {
          const result = await api("/api/command", body);
          await load();
          return result;
        }}
        onRefresh={load}
        onError={onError}
      />
    </div>
  );
}

function TileEditor({
  initial,
  isNew,
  sources,
  typeNames,
  sizeNames,
  onClose,
  onSave,
}: {
  initial: Tile;
  isNew: boolean;
  sources: DashboardSources;
  typeNames: Record<TileType, string>;
  sizeNames: Record<TileSize, string>;
  onClose: () => void;
  onSave: (tile: Tile) => void;
}) {
  const t = useT();
  // One flat draft for every type; only the fields of the chosen type are kept.
  const [draft, setDraft] = useState<Record<string, unknown>>({
    source: "",
    view: "",
    aggregate: "count",
    field: "",
    target: null,
    kind: "bar",
    xField: "",
    yField: "",
    interactive: false,
    limit: 6,
    text: "",
    ...initial,
  });
  const set = (patch: Record<string, unknown>) => setDraft((d) => ({ ...d, ...patch }));
  const type = draft.type as TileType;
  const database = sources.databases.find((d) => d.id === draft.source);
  const numberFields = (database?.fields || []).filter((f) => chartNumberField(f as Field));
  const groupFields = (database?.fields || []).filter((f) => chartGroupField(f as Field));
  const needsDatabase = type === "view" || type === "number" || type === "chart";
  const ready =
    (needsDatabase ? !!database : true) &&
    (type !== "journal" || sources.journals.some((j) => j.id === draft.source)) &&
    (type !== "number" || draft.aggregate === "count" || !!draft.field);
  function build(): Tile {
    const base = { id: String(draft.id), size: draft.size as TileSize, title: String(draft.title || "").slice(0, 120) };
    switch (type) {
      case "view":
        return { ...base, type, source: String(draft.source), view: String(draft.view), interactive: !!draft.interactive };
      case "number":
        return {
          ...base,
          type,
          source: String(draft.source),
          view: String(draft.view),
          aggregate: draft.aggregate as "count",
          field: draft.aggregate === "count" ? "" : String(draft.field),
          target: typeof draft.target === "number" && Number.isFinite(draft.target) ? draft.target : null,
        };
      case "chart":
        return {
          ...base,
          type,
          source: String(draft.source),
          view: String(draft.view),
          kind: draft.kind as "bar",
          xField: String(draft.xField),
          aggregate: draft.aggregate as "count",
          yField: draft.aggregate === "count" ? "" : String(draft.yField),
        };
      case "journal":
        return { ...base, type, source: String(draft.source) };
      case "tasks":
        return { ...base, type };
      case "recent":
        return { ...base, type, limit: Math.max(1, Math.min(20, Number(draft.limit) || 6)) };
      case "text":
        return { ...base, type, text: String(draft.text || "") };
    }
  }
  const aggregates: [string, string][] = [
    ["count", t("Anzahl Einträge", "Number of records")],
    ["sum", t("Summe", "Sum")],
    ["average", t("Mittelwert", "Average")],
    ["min", t("Minimum", "Minimum")],
    ["max", t("Maximum", "Maximum")],
  ];
  return (
    <Modal open onClose={onClose} title={isNew ? t("Kachel hinzufügen", "Add tile") : t("Kachel einstellen", "Configure tile")}>
      <form
        className="dashboard-editor"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) onSave(build());
        }}
      >
        <label>
          {t("Art", "Type")}
          <Select value={type} onChange={(e) => set({ type: e.target.value, source: "", view: "", field: "", xField: "", yField: "" })}>
            {tileTypes.map((kind) => (
              <option key={kind} value={kind}>
                {typeNames[kind]}
              </option>
            ))}
          </Select>
        </label>
        <label>
          {t("Titel (optional)", "Title (optional)")}
          <input value={String(draft.title || "")} maxLength={120} onChange={(e) => set({ title: e.target.value })} />
        </label>
        <label>
          {t("Größe", "Size")}
          <Select value={String(draft.size)} onChange={(e) => set({ size: e.target.value })}>
            {tileSizes.map((size) => (
              <option key={size} value={size}>
                {sizeNames[size]}
              </option>
            ))}
          </Select>
        </label>
        {needsDatabase && (
          <>
            <label>
              {t("Datenbank", "Database")}
              <Select value={String(draft.source)} onChange={(e) => set({ source: e.target.value, view: "", field: "", xField: "", yField: "" })}>
                <option value="">{t("Auswählen …", "Choose …")}</option>
                {sources.databases.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.title || t("Ohne Titel", "Untitled")}
                  </option>
                ))}
              </Select>
            </label>
            {!sources.databases.length && (
              <p className="dashboard-muted">{t("Keine Datenbank, die du lesen kannst.", "No database you can read.")}</p>
            )}
            {database && (
              <label>
                {type === "view" ? t("Ansicht", "View") : t("Filter einer Ansicht", "Filters of a view")}
                <Select value={String(draft.view)} onChange={(e) => set({ view: e.target.value })}>
                  <option value="">{type === "view" ? t("Erste Ansicht", "First view") : t("Alle Einträge", "All records")}</option>
                  {database.views.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </Select>
              </label>
            )}
          </>
        )}
        {type === "view" && (
          <label className="dashboard-check">
            <input type="checkbox" checked={!!draft.interactive} onChange={(e) => set({ interactive: e.target.checked })} />
            {t("Einträge hier bearbeitbar (sonst nur lesen)", "Records editable here (otherwise read-only)")}
          </label>
        )}
        {(type === "number" || type === "chart") && database && (
          <>
            {type === "chart" && (
              <>
                <label>
                  {t("Diagrammart", "Chart type")}
                  <Select value={String(draft.kind)} onChange={(e) => set({ kind: e.target.value })}>
                    <option value="bar">{t("Säulen", "Columns")}</option>
                    <option value="horizontal">{t("Balken", "Bars")}</option>
                    <option value="line">{t("Linie", "Line")}</option>
                    <option value="donut">{t("Donut", "Donut")}</option>
                  </Select>
                </label>
                <label>
                  {t("Gruppieren nach", "Group by")}
                  <Select value={String(draft.xField)} onChange={(e) => set({ xField: e.target.value })}>
                    <option value="">{t("Automatisch", "Automatic")}</option>
                    {groupFields.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </Select>
                </label>
              </>
            )}
            <label>
              {t("Wert", "Value")}
              <Select value={String(draft.aggregate)} onChange={(e) => set({ aggregate: e.target.value })}>
                {aggregates.map(([value, label]) => (
                  <option key={value} value={value} disabled={value !== "count" && !numberFields.length}>
                    {label}
                  </option>
                ))}
              </Select>
            </label>
            {draft.aggregate !== "count" && (
              <label>
                {t("Zahl-Eigenschaft", "Number property")}
                <Select
                  value={String(type === "chart" ? draft.yField : draft.field)}
                  onChange={(e) => set(type === "chart" ? { yField: e.target.value } : { field: e.target.value })}
                >
                  <option value="">{t("Auswählen …", "Choose …")}</option>
                  {numberFields.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </Select>
              </label>
            )}
            {type === "number" && (
              <label>
                {t("Ziel (optional, zeigt einen Fortschrittsbalken)", "Target (optional, shows a progress bar)")}
                <input
                  type="number"
                  step="any"
                  value={typeof draft.target === "number" ? draft.target : ""}
                  onChange={(e) => set({ target: e.target.value === "" ? null : Number(e.target.value) })}
                />
              </label>
            )}
          </>
        )}
        {type === "journal" && (
          <label>
            {t("Journal", "Journal")}
            <Select value={String(draft.source)} onChange={(e) => set({ source: e.target.value })}>
              <option value="">{t("Auswählen …", "Choose …")}</option>
              {sources.journals.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.title || t("Ohne Titel", "Untitled")}
                </option>
              ))}
            </Select>
          </label>
        )}
        {type === "recent" && (
          <label>
            {t("Anzahl Seiten", "Number of pages")}
            <input type="number" min={1} max={20} value={Number(draft.limit) || 6} onChange={(e) => set({ limit: Number(e.target.value) })} />
          </label>
        )}
        {type === "text" && (
          <label>
            {t("Text (Markdown)", "Text (Markdown)")}
            <textarea rows={8} maxLength={20000} value={String(draft.text || "")} onChange={(e) => set({ text: e.target.value })} />
          </label>
        )}
        <div className="dashboard-editor-actions">
          <button type="button" className="button" onClick={onClose}>
            {t("Abbrechen", "Cancel")}
          </button>
          <button type="submit" className="button primary" disabled={!ready}>
            {isNew ? t("Hinzufügen", "Add") : t("Übernehmen", "Apply")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
