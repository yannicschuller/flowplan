"use client";
import { serverMessage } from "@/lib/i18n-errors";
import { suggestedPrefix } from "@/lib/ticket-ids";
import { parentField, treeOrder } from "@/lib/subtasks";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { useT } from "./i18n";
import { Select } from "./select";
import { RowAccess, rowAccessSummary } from "./row-access";
import TicketThread from "./ticket-thread";
import { DatabaseTools } from "./database-tools";
import { RecordSubtasks } from "./record-subtasks";
import { BoardWipSettings, WipCount } from "./board-wip";
import { RecordTime } from "./record-time";
import { formatDuration } from "@/lib/durations";
import { RecordLayoutEditor } from "./record-layout-editor";
import {
  defaultRecordLayout,
  emptyCell,
  recordOpenLabels,
  recordOpenModes,
  type RecordOpenMode,
} from "@/lib/record-layout";
import { parsePageLocation, pageLocationHash } from "@/lib/page-location";
import { scheduleFields } from "@/lib/database-timeline";
import DatabaseTimeline from "./database-timeline";
import { edgeScroller } from "./edge-scroll";
import { Reactions } from "./reactions";
import { startBoardCardDrag, type BoardCardDrag } from "./board-card-drag";
import DatabaseCalendar from "./database-calendar";
import FormulaEditor from "./formula-editor";
import {
  validateFormula,
  rewriteFormulaReferences,
  FORMULA_MAX_LENGTH,
  hasClockFormulas,
} from "@/lib/formula";
import {
  columnSummary,
  calculationFor,
  summaryText,
  type CalculationChoice,
} from "@/lib/database-summary";
import CalculationEditor from "./calculation-editor";
import {
  browserZone,
  formatDateValue,
  isTimed,
  validDateValue,
} from "@/lib/date-values";
import { defaultGallery, galleryImage } from "@/lib/database-gallery";
import { GalleryCover } from "./gallery-cover";
import type { PageImage } from "@/lib/page-appearance";
import {
  Fragment,
  type ReactNode,
  useMemo,
  useState,
  useLayoutEffect,
  useRef,
  useEffect,
  type DragEvent,
} from "react";
import DatabaseFeed from "./database-feed";
import { defaultFeed } from "@/lib/database-feed";
import DatabaseChart from "./database-chart";
import { useFilterClock } from "./use-filter-clock";
import DatabaseFilterEditor from "./database-filter-editor";
import {
  effectiveFilterGroup,
  filterCount,
  hasRelativeFilters,
} from "@/lib/database-filters";
import RowDocument from "./row-document";
import { RollupValue } from "./rollup-value";
import {
  allowedAggregates,
  aggregateNames,
  percentAggregate,
} from "@/lib/rollups";
import {
  databaseGroups,
  groupCellValue,
  groupingField,
  configuredGroups,
  canGroupField,
  moveGroupOrder,
  subgroupingField,
  databaseSubgroups,
  nestedKey,
  splitNestedKey,
  subgroupCollapseKey,
  pathCollapseKey,
  deeperGroupingFields,
  type DatabaseGroup,
} from "@/lib/database-groups";
import { CellInput } from "./cell-input";
export { CellInput } from "./cell-input";
import DatabaseForm from "./database-form";
import type { FormConfig } from "@/lib/form-settings";
import {
  Plus,
  MagnifyingGlass,
  Funnel,
  SortAscending,
  DotsThree,
  ArrowSquareOut,
  Trash,
  CalendarBlank,
  CaretLeft,
  CaretRight,
  Check,
  DownloadSimple,
  UploadSimple,
  SlidersHorizontal,
  Link as LinkIcon,
  Copy,
  DotsSixVertical,
  CaretUp,
  CaretDown,
  Star,
  AppWindow,
  SquareHalf,
  ArrowsOut,
  LockSimple,
  LockSimpleOpen,
  UsersThree,
  Smiley,
  Image as ImageIcon,
} from "@phosphor-icons/react";
import Papa from "papaparse";
import { Modal, viewIcons, download, Avatar, api, PageIcon } from "./ui";
import { CoverPicker } from "./cover-picker";
import { fileLabel, fileUrls } from "@/lib/file-cells";
import type { Backlink } from "@/lib/relation-backlinks";
import {
  parseRecurrence,
  recurrenceLabels,
  recurrenceText,
  type Recurrence,
} from "@/lib/recurrence";
import {
  dateFormats,
  formatFieldDate,
  formatNumber,
  numberFormats,
  ratingMax,
  timeFormats,
} from "@/lib/field-format";
import { IconImagePicker } from "./icon-image-picker";
import dynamic from "next/dynamic";
const EmojiPicker = dynamic(() => import("./emoji-picker"), { ssr: false });
import { cellText, computedCells, queryRows } from "@/lib/database";
import type {
  Database,
  Row,
  Field,
  FieldType,
  View,
  Page,
  User,
  Comment,
} from "@/lib/types";
import type { RelationPair } from "@/lib/relation-sync";
import {
  ARM_GRACE_MS,
  reminderLabel,
  reminderOffsets,
  reminderTarget,
  type DateReminder,
} from "@/lib/date-reminder-options";
export type DatabaseData = {
  images?: PageImage[];
  relationPairs?: RelationPair[];
  database: Database;
  rows: Row[];
  rowTemplates: { id: string; name: string; is_default: number }[];
  reminders?: DateReminder[];
  files?: { url: string; name: string; mime: string }[];
  related: Record<string, Row[]>;
  relatedSchemas?: Record<string, Field[]>;
  form: {
    token: string;
    enabled: number;
    internal: number;
    anonymous: number;
    config: FormConfig;
  } | null;
  comments: Comment[];
  role?: string;
  groups?: { id: string; name: string }[];
};
const fieldNames: Record<FieldType, [string, string]> = {
  text: ["Text", "Text"],
  number: ["Zahl", "Number"],
  date: ["Datum", "Date"],
  select: ["Auswahl", "Select"],
  multiselect: ["Mehrfachauswahl", "Multi-select"],
  checkbox: ["Checkbox", "Checkbox"],
  url: ["URL", "URL"],
  email: ["E-Mail", "Email"],
  phone: ["Telefon", "Phone"],
  checklist: ["Checkliste", "Checklist"],
  person: ["Person", "Person"],
  relation: ["Relation", "Relation"],
  rollup: ["Rollup", "Rollup"],
  formula: ["Formel", "Formula"],
  created_at: ["Erstellt am", "Created at"],
  updated_at: ["Bearbeitet am", "Edited at"],
  created_by: ["Erstellt von", "Created by"],
  updated_by: ["Bearbeitet von", "Edited by"],
  files: ["Dateien", "Files"],
  id: ["ID (Ticketnummer)", "ID (ticket number)"],
  progress: ["Fortschritt der Unteraufgaben", "Subtask progress"],
  time: ["Zeiterfassung", "Time tracking"],
};
type RowMove = {
  viewId: string;
  version: number;
  rowId: string;
  rowVersion: number;
  targetId?: string;
  placement: "before" | "after" | "start" | "end";
  group?: { from: string; to: string };
  subgroup?: { from: string; to: string };
};
const rowDragType = "application/x-flowplan-row-order";
const groupDragType = "application/x-flowplan-group-order";
const computedTypes = [
  "id",
  "progress",
  "time",
  "formula",
  "rollup",
  "created_at",
  "updated_at",
  "created_by",
  "updated_by",
];
export default function DatabaseView({
  data,
  page,
  userId,
  onRefresh,
  members,
  pages,
  editable,
  viewEditable = editable,
  favoriteRows = [],
  allowFieldChanges = true,
  routeNavigation = false,
  mutate,
  onError,
}: {
  data: DatabaseData;
  page: Page;
  userId: string;
  onRefresh: () => Promise<unknown>;
  members: User[];
  pages: Page[];
  editable: boolean;
  viewEditable?: boolean;
  favoriteRows?: { pageId: string; rowId: string; title: string }[];
  allowFieldChanges?: boolean;
  routeNavigation?: boolean;
  mutate: (b: Record<string, unknown>) => Promise<unknown>;
  onError: (s: string) => void;
}) {
  const t = useT();
  // The server sends this database's rows once (as rows); relations to
  // itself and rollups read them from here.
  const related = useMemo(
    () => ({ ...data.related, [page.id]: data.rows }),
    [data.related, data.rows, page.id],
  );
  const [viewId, setViewId] = useState(data.database.views[0].id),
    [query, setQuery] = useState(""),
    // Large databases: rows are drawn in steps (see MoreRows).
    [rowLimit, setRowLimit] = useState(ROW_STEP),
    [groupLimits, setGroupLimits] = useState<Record<string, number>>({}),
    [config, setConfig] = useState(false),
    [filterOpen, setFilterOpen] = useState(false),
    [newField, setNewField] = useState(false),
    [newView, setNewView] = useState(false),
    [rowId, setLocalRowId] = useState<string | null>(null),
    [fieldDraft, setFieldDraft] = useState<
      Field & { bidirectional?: boolean; inverseName?: string }
    >({
      id: "",
      name: "",
      type: "text",
    }),
    [viewName, setViewName] = useState(""),
    [viewType, setViewType] = useState<View["type"]>("table"),
    [comment, setComment] = useState(""),
    // Occurrence of a repeating record opened from the calendar.
    [occurrence, setOccurrence] = useState<{
      rowId: string;
      date: string;
    } | null>(null);
  // Board cards are dragged with pointer events (mouse on the card, touch on
  // the handle); see board-card-drag.ts. A tap without movement still opens
  // the record or the position dialog.
  const cardDrag = useRef<BoardCardDrag | null>(null),
    // A dropped card waits in its gap until the re-render with the move.
    cardLanding = useRef<{ drag: BoardCardDrag; rows: unknown } | null>(null),
    // Handle of the row whose finished drag may still send a click.
    suppressClick = useRef<string | null>(null),
    cardHoverRef = useRef((_x: number, _y: number) => {}),
    [cardScroll] = useState(() =>
      edgeScroller((x, y) => cardHoverRef.current(x, y), "x"),
    );
  // Touch devices move board columns with a handle; the board scrolls
  // sideways while the finger rests at its edge.
  const columnDrag = useRef<{ key: string; pointer: number } | null>(null),
    columnHoverRef = useRef((_x: number, _y: number) => {}),
    [columnScroll] = useState(() =>
      edgeScroller((x, y) => columnHoverRef.current(x, y), "x"),
    );
  // A record just created opens with its title ready for typing.
  const [freshRowId, setFreshRowId] = useState<string | null>(null);
  function setRowId(id: string | null, occurrence?: string) {
    setOccurrence(id && occurrence ? { rowId: id, date: occurrence } : null);
    setLocalRowId(id);
    if (routeNavigation)
      location.hash = pageLocationHash({
        pageId: page.id,
        rowId: id || undefined,
      });
  }
  useEffect(() => {
    if (!routeNavigation) return;
    const navigate = () => {
      const target = parsePageLocation(location.hash);
      setLocalRowId(target?.pageId === page.id ? target.rowId || null : null);
    };
    navigate();
    window.addEventListener("hashchange", navigate);
    return () => window.removeEventListener("hashchange", navigate);
  }, [routeNavigation, page.id]);
  const [editingCell, setEditingCell] = useState<{
    rowId: string;
    fieldId: string;
    groupKey?: string;
  } | null>(null);
  const [selection, setSelection] = useState<Map<string, number>>(new Map());
  const [bulk, setBulk] = useState<"update" | "delete" | null>(null),
    [bulkField, setBulkField] = useState(""),
    [bulkValue, setBulkValue] = useState<unknown>(undefined),
    [bulkBusy, setBulkBusy] = useState(false);
  const [resize, setResize] = useState<{
    id: string;
    startX: number;
    startWidth: number;
    width: number;
  } | null>(null);
  const [manageTemplates, setManageTemplates] = useState(false);
  const [readerCollapsed, setReaderCollapsed] = useState<
    Record<string, boolean>
  >({});
  const [schemaBusy, setSchemaBusy] = useState(false);
  const [calculationEdit, setCalculationEdit] = useState<{
    field: Field;
    viewId: string;
    version: number;
    choice?: CalculationChoice;
  } | null>(null);
  const [fieldVersion, setFieldVersion] = useState(data.database.version),
    [fieldError, setFieldError] = useState("");
  const [relationTarget, setRelationTarget] = useState<{
    id: string;
    version?: number;
    error?: string;
  }>();
  const [orderBusy, setOrderBusy] = useState(false),
    orderPending = useRef(false);
  const [moveDialog, setMoveDialog] = useState<{
    id: string;
    groupKey?: string;
  } | null>(null);
  const [moveTarget, setMoveTarget] = useState(""),
    [movePlacement, setMovePlacement] = useState<"before" | "after">("before");
  const [sortMove, setSortMove] = useState<RowMove | null>(null);
  const [groupDrop, setGroupDrop] = useState<string | null>(null);
  const [reminderBusy, setReminderBusy] = useState(false);
  // Record pages open as the database layout says, unless this browser
  // chose its own presentation.
  const recordLayout = data.database.recordLayout || defaultRecordLayout;
  const [recordModeChoice, setRecordModeChoice] = useState<RecordOpenMode | "">(
    "",
  );
  const [showEmpty, setShowEmpty] = useState(false),
    [layoutOpen, setLayoutOpen] = useState(false),
    [accessOpen, setAccessOpen] = useState(false);
  useEffect(() => {
    try {
      const stored = localStorage.getItem("flowplan-record-mode") || "";
      setRecordModeChoice(
        (recordOpenModes as readonly string[]).includes(stored)
          ? (stored as RecordOpenMode)
          : localStorage.getItem("flowplan-record-full") === "1"
            ? "full"
            : "",
      );
    } catch {}
  }, []);
  const recordMode = recordModeChoice || recordLayout.open;
  // A personal choice equal to the database default is no choice.
  const chooseRecordMode = (mode: RecordOpenMode) => {
    const choice = mode === recordLayout.open ? "" : mode;
    setRecordModeChoice(choice);
    try {
      if (choice) localStorage.setItem("flowplan-record-mode", choice);
      else localStorage.removeItem("flowplan-record-mode");
      localStorage.removeItem("flowplan-record-full");
    } catch {}
  };
  const [rowIconPicker, setRowIconPicker] = useState(false),
    [rowIconTab, setRowIconTab] = useState<"emoji" | "image">("emoji"),
    [rowCoverPicker, setRowCoverPicker] = useState(false);
  const [dropHint, setDropHint] = useState<{
    id: string;
    groupKey?: string;
    placement: "before" | "after";
  } | null>(null);
  // Moved records glide to their new place (see the FLIP effect below).
  const boardRef = useRef<HTMLDivElement | null>(null),
    cardPositions = useRef(new Map<string, { x: number; y: number }>()),
    lastMove = useRef(0),
    lastMovedId = useRef<string | null>(null);
  const [orderStatus, setOrderStatus] = useState("");
  const importRef = useRef<HTMLInputElement>(null);
  const view =
      data.database.views.find((v) => v.id === viewId) ||
      data.database.views[0],
    fields = data.database.fields,
    orderedFields = [...fields].sort((a, b) => {
      const order = view.fieldOrder || fields.map((f) => f.id);
      return (
        (order.includes(a.id) ? order.indexOf(a.id) : 999) -
        (order.includes(b.id) ? order.indexOf(b.id) : 999)
      );
    }),
    visibleFields = orderedFields.filter(
      (f) => !view.hiddenFields?.includes(f.id),
    );
  const formulaFields = fields.some((f) => f.id === fieldDraft.id)
    ? fields.map((f) => (f.id === fieldDraft.id ? fieldDraft : f))
    : [...fields, fieldDraft];
  const formulaProblem =
    fieldDraft.type === "formula"
      ? validateFormula(
          fieldDraft.formula || "",
          formulaFields.flatMap((f) => [f.id, f.name]),
        )
      : null;
  const formulaTooLong =
    fieldDraft.type === "formula" &&
    rewriteFormulaReferences(fieldDraft.formula || "", formulaFields, "store")
      .length > FORMULA_MAX_LENGTH;
  useEffect(
    () => setSelection(new Map()),
    [view.id, query, JSON.stringify(effectiveFilterGroup(view))],
  );
  const activeFilterCount = filterCount(effectiveFilterGroup(view));
  const selectionRows = data.rows.filter((r) => selection.has(r.id));
  function selectRow(row: Row, enabled: boolean) {
    setSelection((previous) => {
      const next = new Map(previous);
      if (enabled) next.set(row.id, row.version);
      else next.delete(row.id);
      return next;
    });
  }
  function columnWidth(field: Field) {
    return resize?.id === field.id
      ? resize.width
      : view.columnWidths?.[field.id] ||
          (field.id === fields[0].id ? 280 : 180);
  }
  async function moveColumn(source: string, target: string) {
    const order = orderedFields.map((f) => f.id).filter((id) => id !== source);
    order.splice(order.indexOf(target), 0, source);
    await updateView({ fieldOrder: order });
  }
  async function bulkAction(operation: "update" | "duplicate" | "delete") {
    setBulkBusy(true);
    const result = await act({
      action: "rows.bulk",
      operation,
      rows: selectionRows.map((r) => ({
        id: r.id,
        version: selection.get(r.id),
      })),
      ...(operation === "update" ? { cells: { [bulkField]: bulkValue } } : {}),
    });
    setBulkBusy(false);
    if (result) {
      setSelection(new Map());
      setBulk(null);
      onError(
        t(`${selectionRows.length} Einträge ${operation === "update" ? "aktualisiert" : operation === "duplicate" ? "dupliziert" : "gelöscht"}. Vorheriger Stand im Versionsverlauf gesichert.`, `${selectionRows.length} records ${operation === "update" ? "updated" : operation === "duplicate" ? "duplicated" : "deleted"}. The previous state was saved in the version history.`),
      );
    }
  }
  useEffect(() => {
    setRowLimit(ROW_STEP);
    setGroupLimits({});
  }, [viewId, query]);
  const filterNow = useFilterClock(
    hasRelativeFilters(effectiveFilterGroup(view)) ||
      hasClockFormulas(fields, data.relatedSchemas),
  );
  const shown = useMemo(
    () =>
      queryRows(
        data.rows,
        fields,
        view,
        query,
        related,
        data.relatedSchemas,
        new Date(filterNow),
      ),
    [data, fields, view, query, filterNow],
  );
  const selected = data.rows.find((r) => r.id === rowId);
  const selectedEditable = editable && selected?.role !== "viewer";
  // Subtasks: the parent property and, in tables, the tree.
  const subtaskParent = parentField(fields);
  const treeParent = view.type === "table" && view.tree ? subtaskParent : undefined;
  const [treeCollapsed, setTreeCollapsed] = useState<Set<string>>(() => new Set());
  // Another record: its permissions panel starts closed.
  const [accessFor, setAccessFor] = useState(selected?.id);
  if (accessFor !== selected?.id) {
    setAccessFor(selected?.id);
    setAccessOpen(false);
  }
  const canManageAccess = (row: Row) =>
    editable && (data.role === "owner" || row.created_by === userId);
  const recordModeIcons = { center: AppWindow, side: SquareHalf, full: ArrowsOut };
  const recordModeLabels = {
    center: t("Als Dialog öffnen", "Open as dialog"),
    side: t("In der Seitenleiste öffnen", "Open in side panel"),
    full: t("Als ganze Seite öffnen", "Open as full page"),
  };
  // The record's header: how it opens, favorite, permissions, layout.
  const recordActions = (row: Row) => {
    const starred = favoriteRows.some((f) => f.rowId === row.id);
    const access = row.access || "inherit";
    const AccessIcon =
      access === "inherit" ? UsersThree : access === "private" ? LockSimple : LockSimpleOpen;
    return (
      <>
        <div className="record-open-modes" role="group" aria-label={t("Eintrag öffnen als", "Open record as")}>
          {recordOpenModes.map((mode) => {
            const Icon = recordModeIcons[mode];
            const label = `${recordModeLabels[mode]}${mode === recordLayout.open ? t(" (Standard)", " (default)") : ""}`;
            return (
              <button
                key={mode}
                type="button"
                className="icon-button"
                aria-pressed={recordMode === mode}
                aria-label={label}
                title={label}
                onClick={() => chooseRecordMode(mode)}
              >
                <Icon size={17} />
              </button>
            );
          })}
        </div>
        <span className="modal-heading-divider" aria-hidden="true" />
        <button
          type="button"
          className={`icon-button record-star${starred ? " active" : ""}`}
          aria-pressed={starred}
          aria-label={starred ? t("Aus Favoriten entfernen", "Remove from favourites") : t("Zu Favoriten", "Add to favourites")}
          title={starred ? t("Aus Favoriten entfernen", "Remove from favourites") : t("Zu Favoriten", "Add to favourites")}
          onClick={() =>
            act({ action: "favorite.row", rowId: row.id, value: !starred })
          }
        >
          <Star size={17} weight={starred ? "fill" : "regular"} />
        </button>
        {canManageAccess(row) && (
          <button
            type="button"
            className={`icon-button record-access-button${access !== "inherit" ? " restricted" : ""}`}
            aria-expanded={accessOpen}
            aria-label={t(`${rowAccessSummary(row, t)} · Rechte des Eintrags`, `${rowAccessSummary(row, t)} · record permissions`)}
            title={t(`${rowAccessSummary(row, t)} · Rechte des Eintrags`, `${rowAccessSummary(row, t)} · record permissions`)}
            onClick={() => {
              setAccessOpen((v) => !v);
              setLayoutOpen(false);
            }}
          >
            <AccessIcon size={17} />
            {access !== "inherit" && (
              <span>{access === "private" ? t("Privat", "Private") : t("Nur lesen", "Read only")}</span>
            )}
          </button>
        )}
        {editable && allowFieldChanges && (
          <button
            type="button"
            className="icon-button"
            aria-expanded={layoutOpen}
            aria-label={t("Layout anpassen", "Adjust layout")}
            title={t("Layout anpassen", "Adjust layout")}
            onClick={() => {
              setLayoutOpen((v) => !v);
              setAccessOpen(false);
            }}
          >
            <SlidersHorizontal size={17} />
          </button>
        )}
      </>
    );
  };
  // Properties shown on the record page (layout: hidden and empty ones).
  const layoutFields = fields.filter(
    (f, i) => i === 0 || !recordLayout.hidden.includes(f.id),
  );
  const emptyFields = new Set(
    recordLayout.hideEmpty && selected
      ? layoutFields
          .filter(
            (f, i) =>
              i > 0 &&
              !computedTypes.includes(f.type) &&
              emptyCell(selected.cells[f.id], f.type),
          )
          .map((f) => f.id)
      : [],
  );
  // The title is edited in the heading, not again among the properties.
  const recordFields = (
    showEmpty ? layoutFields : layoutFields.filter((f) => !emptyFields.has(f.id))
  ).filter((f) => f.id !== fields[0]?.id);
  const emptyHidden = emptyFields.size;
  useEffect(() => {
    if (rowId && !selected)
      onError(t("Dieser Datensatz ist nicht mehr verfügbar.", "This record is no longer available."));
  }, [rowId, selected, onError]);
  const groupField = groupingField(fields, view);
  const dateField =
    fields.find((f) => f.id === view.dateField) ||
    fields.find((f) => f.type === "date");
  const allGroups = databaseGroups(shown, groupField, related, members);
  const groups = configuredGroups(allGroups, view);
  const grouped = !!groupField && ["table", "list"].includes(view.type);
  const groupSettings = view.groupSettings || {
    hideEmpty: view.type !== "board",
    sort: "manual" as const,
    collapsed: [],
  };
  const collapsed = (key: string) =>
    !viewEditable &&
    readerCollapsed[JSON.stringify([view.id, view.groupBy, key])] !== undefined
      ? readerCollapsed[JSON.stringify([view.id, view.groupBy, key])]
      : groupSettings.collapsed.includes(key);
  const subField =
    grouped || view.type === "board"
      ? subgroupingField(fields, view, groupField)
      : undefined;
  const lanes =
    view.type === "board" && subField
      ? databaseGroups(shown, subField, related, members).filter(
          (lane) => lane.rows.length,
        )
      : null;
  // Plain boards (no swimlanes) drag cards with pointer events.
  const plainBoard = view.type === "board" && !lanes;
  const subgroups = new Map<string, DatabaseGroup[]>(
    subField
      ? groups.map((g) => [
          g.key,
          databaseSubgroups(g, subField, related, members),
        ])
      : [],
  );
  const subCollapsed = (group: string, subgroup: string) =>
    collapsed(subgroupCollapseKey(group, subgroup));
  const deeperFields = subField
    ? deeperGroupingFields(fields, view, [groupField, subField])
    : [];
  const selectableRows = grouped
    ? [
        ...new Map(
          groups
            .filter((g) => !collapsed(g.key))
            .flatMap((g) =>
              subgroups.has(g.key)
                ? subgroups
                    .get(g.key)!
                    .filter((sg) => !subCollapsed(g.key, sg.key))
                    .flatMap((sg) => sg.rows)
                : g.rows,
            )
            .map((r) => [r.id, r]),
        ).values(),
      ]
    : shown;
  const canGroupEdit =
    editable && !!groupField && !computedTypes.includes(groupField.type);
  const canSubEdit =
    canGroupEdit && !!subField && !computedTypes.includes(subField.type);
  // Row moves address subgroups with a nested key; the server receives both levels.
  function groupChange(from: string, to: string) {
    const a = splitNestedKey(from),
      b = splitNestedKey(to);
    return {
      group: { from: a.group, to: b.group },
      ...(a.subgroup !== undefined && b.subgroup !== undefined
        ? { subgroup: { from: a.subgroup, to: b.subgroup } }
        : {}),
    };
  }
  function rowsOfGroup(key: string) {
    const { group, subgroup } = splitNestedKey(key);
    return subgroup === undefined
      ? groups.find((g) => g.key === group)?.rows
      : subgroups.get(group)?.find((sg) => sg.key === subgroup)?.rows;
  }
  const rollupRelation = fields.find(
    (f) => f.id === fieldDraft.relationField && f.type === "relation",
  );
  const rollupFields = rollupRelation?.relationPage
    ? data.relatedSchemas?.[rollupRelation.relationPage] || []
    : [];
  const rollupProperty = rollupFields.find(
    (f) => f.id === fieldDraft.rollupField,
  );
  const relationPair = data.relationPairs?.find(
    (p) =>
      (p.left_page === page.id && p.left_field === fieldDraft.id) ||
      (p.right_page === page.id && p.right_field === fieldDraft.id),
  );
  const bidirectional = fieldDraft.bidirectional ?? !!relationPair;
  const relationChanged =
    fieldDraft.type === "relation" && bidirectional !== !!relationPair;
  const inverseField =
    relationPair &&
    (relationPair.left_page === page.id &&
    relationPair.left_field === fieldDraft.id
      ? relationPair.right_field
      : relationPair.left_field);
  const inverseName =
    fieldDraft.relationPage &&
    data.relatedSchemas?.[fieldDraft.relationPage]?.find(
      (f) => f.id === inverseField,
    )?.name;
  useEffect(() => {
    if (
      !newField ||
      fieldDraft.type !== "relation" ||
      !fieldDraft.relationPage
    ) {
      setRelationTarget(undefined);
      return;
    }
    let active = true;
    const targetId = fieldDraft.relationPage;
    setRelationTarget({ id: targetId });
    api<{ database: Database; page: Page; role: string }>(
      `/api/pages/${targetId}`,
    )
      .then((target) => {
        if (active)
          setRelationTarget({
            id: targetId,
            version: target.database.version,
            error:
              target.role === "viewer"
                ? t("Für Rückrelationen brauchst du Bearbeitungsrechte auf beide Datenbanken.", "Two-way relations need edit rights on both databases.")
                : target.page.locked
                  ? t("Die verknüpfte Datenbank ist gesperrt.", "The linked database is locked.")
                  : undefined,
          });
      })
      .catch((error) => {
        if (active)
          setRelationTarget({ id: targetId, error: (error as Error).message });
      });
    return () => {
      active = false;
    };
  }, [newField, fieldDraft.type, fieldDraft.relationPage]);
  const relationReady =
    relationTarget?.id === fieldDraft.relationPage &&
    !!relationTarget?.version &&
    !relationTarget?.error;
  // Records can be read-only for this person (record permissions).
  const rowEditable = (r: Row) => editable && r.role !== "viewer";
  const act = async (b: Record<string, unknown>) => {
    try {
      return await mutate({ pageId: page.id, ...b });
    } catch (e) {
      onError((e as Error).message);
      return null;
    }
  };
  async function updateSchema(
    nextFields: Field[] = fields,
    nextViews: View[] = data.database.views,
    relation?: {
      fieldId: string;
      enabled: boolean;
      name?: string;
      targetVersion?: number;
    },
    version = data.database.version,
  ) {
    setSchemaBusy(true);
    try {
      return await act({
        action: "database.update",
        version,
        fields: nextFields,
        views: nextViews,
        relation,
      });
    } finally {
      setSchemaBusy(false);
    }
  }
  async function updateView(patch: Partial<View>) {
    return updateSchema(
      fields,
      data.database.views.map((v) =>
        v.id === view.id ? { ...v, ...patch } : v,
      ),
    );
  }
  const moveRow = data.rows.find((r) => r.id === moveDialog?.id);
  const moveSiblings =
    moveDialog?.groupKey !== undefined
      ? rowsOfGroup(moveDialog.groupKey) || []
      : shown;
  const moveIndex = moveSiblings.findIndex((r) => r.id === moveDialog?.id);
  function openMove(row: Row, groupKey?: string) {
    setMoveDialog({ id: row.id, groupKey });
    setMoveTarget("");
    setMovePlacement("before");
  }
  async function submitMove(move: RowMove, clearSorts = false) {
    if (orderPending.current) return;
    lastMove.current = Date.now();
    lastMovedId.current = move.rowId;
    if (view.sorts.length && !clearSorts) {
      setMoveDialog(null);
      setSortMove(move);
      return;
    }
    orderPending.current = true;
    setOrderBusy(true);
    setDropHint(null);
    try {
      const result = await act({ action: "row.move", ...move, clearSorts });
      if (result) {
        setMoveDialog(null);
        setSortMove(null);
        setOrderStatus(t(`Reihenfolge in „${view.name}“ gespeichert.`, `Order in “${view.name}” saved.`));
      }
    } finally {
      orderPending.current = false;
      setOrderBusy(false);
    }
  }
  function moveTo(
    row: Row,
    targetId: string | undefined,
    placement: RowMove["placement"],
    groupKey?: string,
  ) {
    return submitMove({
      viewId: view.id,
      version: data.database.version,
      rowId: row.id,
      rowVersion: row.version,
      targetId,
      placement,
      ...(groupKey !== undefined && canGroupEdit
        ? groupChange(groupKey, groupKey)
        : {}),
    });
  }
  function dragStart(e: DragEvent, row: Row, groupKey?: string) {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData(
      rowDragType,
      JSON.stringify({
        pageId: page.id,
        viewId: view.id,
        version: data.database.version,
        rowId: row.id,
        rowVersion: row.version,
        groupKey,
      }),
    );
  }
  function dragMove(
    e: DragEvent,
    target: Row | undefined,
    groupKey?: string,
    bottom = false,
  ) {
    if (
      !editable ||
      !viewEditable ||
      orderBusy ||
      !e.dataTransfer.types.includes(rowDragType)
    )
      return;
    e.preventDefault();
    e.stopPropagation();
    try {
      const source = JSON.parse(e.dataTransfer.getData(rowDragType));
      if (
        source.pageId !== page.id ||
        source.viewId !== view.id ||
        source.rowId === target?.id
      ) {
        setDropHint(null);
        return;
      }
      const change =
        groupKey !== undefined && source.groupKey !== undefined
          ? groupChange(source.groupKey, groupKey)
          : undefined;
      if (
        change &&
        ((change.group.from !== change.group.to && !canGroupEdit) ||
          (change.subgroup &&
            change.subgroup.from !== change.subgroup.to &&
            !canSubEdit))
      ) {
        onError(t("Diese Gruppierung kann nicht bearbeitet werden.", "This grouping cannot be edited."));
        return;
      }
      const bounds = e.currentTarget.getBoundingClientRect();
      const placement = bottom
        ? "after"
        : e.clientY < bounds.top + bounds.height / 2
          ? "before"
          : "after";
      void submitMove({
        viewId: view.id,
        version: source.version,
        rowId: source.rowId,
        rowVersion: source.rowVersion,
        targetId: target?.id,
        placement: target ? placement : "end",
        ...(groupKey !== undefined && canGroupEdit
          ? groupChange(source.groupKey, groupKey)
          : {}),
      });
    } catch {
      setDropHint(null);
    }
  }
  function dragOver(e: DragEvent, row: Row, groupKey?: string) {
    if (
      !editable ||
      !viewEditable ||
      orderBusy ||
      !e.dataTransfer.types.includes(rowDragType)
    )
      return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    const bounds = e.currentTarget.getBoundingClientRect();
    setDropHint({
      id: row.id,
      groupKey,
      placement:
        e.clientY < bounds.top + bounds.height / 2 ? "before" : "after",
    });
  }
  function dropClass(row: Row, groupKey?: string) {
    return dropHint?.id === row.id && dropHint.groupKey === groupKey
      ? `order-drop-${dropHint.placement}`
      : "";
  }
  // After a move, the moved record and its neighbours glide to their new
  // places (FLIP) instead of jumping; positions relative to the view so
  // scrolling does not count as movement.
  useLayoutEffect(() => {
    const root = boardRef.current;
    if (!root) return;
    // Mid-drag nothing moves by layout; the drag places the cards itself.
    if (cardDrag.current) return;
    // The committed move of a dropped card: cards glide on from where the
    // drag left them on screen.
    let seeds: Map<string, { left: number; top: number }> | undefined;
    const landing = cardLanding.current;
    if (landing && landing.rows !== data.rows) {
      cardLanding.current = null;
      seeds = landing.drag.settle();
    }
    const items = [
      ...root.querySelectorAll<HTMLElement>(
        ".record-card-wrap[data-row-id], tr[data-row-id], .record-list-item[data-row-id]",
      ),
    ];
    if (items.length > 500) return;
    const origin = root.getBoundingClientRect();
    const animate =
      Date.now() - lastMove.current < 3000 &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const seen = new Map<string, number>(),
      next = new Map<string, { x: number; y: number }>();
    for (const el of items) {
      const id = el.dataset.rowId!,
        n = seen.get(id) || 0;
      seen.set(id, n + 1);
      const key = `${view.id}:${id}:${n}`,
        rect = el.getBoundingClientRect(),
        at = { x: rect.left - origin.left, y: rect.top - origin.top },
        seed = n === 0 ? seeds?.get(id) : undefined,
        before = seed
          ? { x: seed.left - origin.left, y: seed.top - origin.top }
          : cardPositions.current.get(key);
      next.set(key, at);
      if (!animate || !before) continue;
      const dx = before.x - at.x,
        dy = before.y - at.y;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      const moved = id === lastMovedId.current;
      el.style.transition = "none";
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      if (moved) el.classList.add("row-sliding");
      requestAnimationFrame(() => {
        el.style.transition = `transform ${moved ? 320 : 220}ms cubic-bezier(0.2, 0.8, 0.2, 1)`;
        el.style.transform = "";
        setTimeout(() => {
          el.classList.remove("row-sliding");
          el.style.transition = "";
        }, 340);
      });
    }
    cardPositions.current = next;
  });
  cardHoverRef.current = (x, y) => cardDrag.current?.move(x, y);
  const latestRows = useRef(data.rows);
  latestRows.current = data.rows;
  // Starts watching a pointer on a board card; the drag begins once it has
  // moved past the threshold, so clicks and taps keep working.
  function beginCardDrag(
    e: React.PointerEvent<HTMLElement>,
    row: Row,
    groupKey: string,
    threshold: number,
  ) {
    suppressClick.current = null;
    if (!editable || !viewEditable || orderBusy || cardDrag.current) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const wrap = e.currentTarget.closest<HTMLElement>(".record-card-wrap"),
      board = e.currentTarget.closest<HTMLElement>(".board");
    if (!wrap || !board) return;
    const pointer = e.pointerId,
      x0 = e.clientX,
      y0 = e.clientY;
    let drag: BoardCardDrag | null = null;
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      cardScroll.stop();
      document.documentElement.classList.remove("card-grabbing");
    };
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointer) return;
      if (!drag) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) <= threshold) return;
        drag = startBoardCardDrag({
          board,
          wrap,
          rowId: row.id,
          groupKey,
          x: x0,
          y: y0,
          onHint: setDropHint,
        });
        if (!drag) return stop();
        cardDrag.current = drag;
        cardScroll.start(wrap);
        document.documentElement.classList.add("card-grabbing");
        window.getSelection()?.removeAllRanges();
      }
      ev.preventDefault();
      drag.move(ev.clientX, ev.clientY);
      cardScroll.move(ev.clientX, ev.clientY);
    };
    const end = (ev: PointerEvent) => {
      if (ev.pointerId !== pointer) return;
      stop();
      if (!drag) return;
      cardDrag.current = null;
      // The browser may still send a click to the dragged card or handle.
      suppressClick.current = row.id;
      setTimeout(() => {
        if (suppressClick.current === row.id) suppressClick.current = null;
      }, 400);
      setDropHint(null);
      if (ev.type === "pointercancel") return drag.cancel();
      const drop = drag.drop();
      if (!drop) return;
      const change = groupChange(groupKey, drop.groupKey);
      if (change.group.from !== change.group.to && !canGroupEdit) {
        onError(t("Diese Gruppierung kann nicht bearbeitet werden.", "This grouping cannot be edited."));
        return drag.cancel();
      }
      const landed = drag;
      cardLanding.current = { drag: landed, rows: latestRows.current };
      void submitMove({
        viewId: view.id,
        version: data.database.version,
        rowId: row.id,
        rowVersion: row.version,
        targetId: drop.targetId,
        placement: drop.placement,
        ...(canGroupEdit ? change : {}),
      }).finally(() =>
        // React commits the moved data shortly after the request resolves.
        // Without such a re-render (error, or the sort question first) the
        // card returns to its place.
        setTimeout(() => {
          if (cardLanding.current?.drag === landed) {
            cardLanding.current = null;
            landed.cancel();
          }
        }, 250),
      );
    };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }
  function orderHandle(row: Row, groupKey?: string) {
    if (!viewEditable) return null;
    const siblings =
      groupKey !== undefined
        ? allGroups.find((g) => g.key === groupKey)?.rows || []
        : shown;
    const index = siblings.findIndex((r) => r.id === row.id);
    return (
      <button
        type="button"
        className="row-order-handle"
        aria-label={t(`Eintrag verschieben: ${cellText(row.cells[fields[0].id]) || "Ohne Titel"}`, `Move record: ${cellText(row.cells[fields[0].id]) || "Untitled"}`)}
        title={t("Ziehen oder Position wählen · Alt + Pfeil hoch/runter", "Drag or choose a position · Alt + arrow up/down")}
        disabled={orderBusy}
        draggable={!orderBusy && !plainBoard}
        onDragStart={(e) => {
          e.stopPropagation();
          dragStart(e, row, groupKey);
        }}
        onDragEnd={() => setDropHint(null)}
        {...(plainBoard && groupKey !== undefined
          ? {
              onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => {
                e.stopPropagation();
                beginCardDrag(e, row, groupKey, e.pointerType === "mouse" ? 4 : 8);
              },
            }
          : {})}
        onClick={(e) => {
          e.stopPropagation();
          // A finished touch drag is not a tap.
          if (suppressClick.current === row.id) {
            suppressClick.current = null;
            return;
          }
          openMove(row, groupKey);
        }}
        onKeyDown={(e) => {
          if (e.altKey && ["ArrowUp", "ArrowDown"].includes(e.key)) {
            e.preventDefault();
            e.stopPropagation();
            const target = siblings[index + (e.key === "ArrowUp" ? -1 : 1)];
            if (target)
              void moveTo(
                row,
                target.id,
                e.key === "ArrowUp" ? "before" : "after",
                groupKey,
              );
          }
        }}
      >
        <DotsSixVertical size={17} />
      </button>
    );
  }
  async function updateCell(row: Row, field: Field, value: unknown) {
    if (JSON.stringify(row.cells[field.id]) === JSON.stringify(value)) return;
    const result = await act({
      action: "row.update",
      rowId: row.id,
      version: row.version,
      cells: { [field.id]: value },
    });
    if (result) setEditingCell(null);
    return result;
  }
  async function createRow(
    cells: Record<string, unknown> = {},
    open = true,
    templateId?: string | null,
  ) {
    const r = (await act({
      action: "row.create",
      cells:
        templateId ||
        (templateId !== null && data.rowTemplates?.some((t) => t.is_default))
          ? cells
          : { [fields[0].id]: t("Neue Aufgabe", "New task"), ...cells },
      templateId,
    })) as { id: string } | null;
    if (r && open) {
      setFreshRowId(r.id);
      setRowId(r.id);
    }
  }
  async function uploadFile(file: File) {
    if (file.size > 10 * 1024 * 1024)
      throw new Error(t(`${file.name}: maximal 10 MB pro Datei.`, `${file.name}: at most 10 MB per file.`));
    const body = new FormData();
    body.set("pageId", page.id);
    body.set("file", file);
    const response = await fetch("/api/upload", { method: "POST", body });
    const result = await response.json();
    if (!response.ok) throw new Error(serverMessage(result.error) || t("Upload fehlgeschlagen.", "Upload failed."));
    return result.url as string;
  }
  function display(r: Row, f: Field) {
    const v = r.cells[f.id];
    if (f.type === "files") {
      const names = new Map((data.files || []).map((x) => [x.url, x.name]));
      const urls = fileUrls(v);
      return (
        urls.length > 0 && (
          <span className="file-cell">
            {urls.slice(0, 3).map((url) => (
              <span key={url} className="file-chip">
                {data.files
                  ?.find((x) => x.url === url)
                  ?.mime.startsWith("image/") && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={url} alt="" />
                )}
                {fileLabel(url, names)}
              </span>
            ))}
            {urls.length > 3 && (
              <span className="muted">+{urls.length - 3}</span>
            )}
          </span>
        )
      );
    }
    if (f.type === "rollup") return <RollupValue field={f} value={v} />;
    if (f.type === "time") {
      const spent = typeof v === "number" ? v : 0;
      const estimate = f.estimateField ? Number(r.cells[f.estimateField]) : NaN;
      if (!spent && !Number.isFinite(estimate)) return null;
      return (
        <span className={`time-cell${Number.isFinite(estimate) && spent > estimate * 3600 ? " over" : ""}`}>
          {formatDuration(spent)}
          {Number.isFinite(estimate) && <span className="muted"> / {estimate} h</span>}
        </span>
      );
    }
    if (f.type === "progress")
      return typeof v === "number" ? (
        <span className="progress-cell" title={`${Math.round(v * 100)} %`}>
          <span className="progress-track">
            <span style={{ width: `${Math.round(v * 100)}%` }} />
          </span>
          {Math.round(v * 100)} %
        </span>
      ) : null;
    if (["person", "created_by", "updated_by"].includes(f.type)) {
      const u = members.find((m) => m.id === v);
      return u ? (
        <span className="person-cell">
          <Avatar name={u.name} userId={u.id} small />
          {u.name}
        </span>
      ) : (
        <span className="muted">—</span>
      );
    }
    if (f.type === "select" || f.type === "multiselect") {
      const values = Array.isArray(v) ? v : v ? [v] : [];
      return (
        <span className="tags">
          {values.map((s, i) => (
            <span
              key={String(s) + i}
              className={`tag tag-${tagColor(String(s))}`}
            >
              {String(s)}
            </span>
          ))}
        </span>
      );
    }
    if (f.type === "checkbox")
      return (
        <span className={`check-display ${v ? "checked" : ""}`}>
          {!!v && <Check size={12} />}
        </span>
      );
    if (f.type === "relation") {
      const ids = Array.isArray(v) ? (v as string[]) : [];
      // Each related record links to its own entry.
      return (
        <span className="relation-links">
          {ids.map((rid) => {
            const target = related[f.relationPage || ""]?.find(
              (x) => x.id === rid,
            );
            return target && f.relationPage ? (
              <a
                key={rid}
                href={pageLocationHash({
                  pageId: f.relationPage,
                  rowId: rid,
                })}
                onClick={(e) => e.stopPropagation()}
              >
                {cellText(target.cells.title) || t("Ohne Titel", "Untitled")}
              </a>
            ) : (
              <span key={rid} className="muted">
                {t("Nicht verfügbar", "Not available")}
              </span>
            );
          })}
        </span>
      );
    }
    if (f.type === "date" && v) {
      return (
        <span className="date-cell">
          <CalendarBlank size={14} />
          {formatFieldDate(v, f)}
        </span>
      );
    }
    if (f.type === "number" && v !== undefined) {
      if (v === null || v === "") return <span className="muted">—</span>;
      if (f.rollupDisplay && f.rollupDisplay !== "number")
        return <RollupValue field={f} value={Number(v)} />;
      return formatNumber(Number(v), f.format, f.decimals);
    }
    // Formulas with a number result take the chosen number format.
    if (f.type === "formula" && typeof v === "number" && f.format)
      return formatNumber(v, f.format, f.decimals);
    return cellText(v) || <span className="muted">—</span>;
  }
  const galleryConfig = view.gallery || defaultGallery;
  const galleryImages = new Set((data.images || []).map((image) => image.url));
  function card(r: Row, groupKey?: string) {
    return (
      <div
        key={r.id}
        className={`record-card-wrap ${dropClass(r, groupKey)}`}
        data-row-id={r.id}
        onDragOver={(e) => dragOver(e, r, groupKey)}
        onDrop={(e) => dragMove(e, r, groupKey)}
      >
        <button
          className="record-card"
          draggable={editable && viewEditable && !orderBusy && !plainBoard}
          onDragStart={(e) => dragStart(e, r, groupKey)}
          onDragEnd={() => setDropHint(null)}
          onPointerDown={(e) => {
            if (plainBoard && groupKey !== undefined && e.pointerType === "mouse")
              beginCardDrag(e, r, groupKey, 4);
          }}
          onClick={() => {
            // The end of a drag is not a click.
            if (suppressClick.current === r.id) {
              suppressClick.current = null;
              return;
            }
            setRowId(r.id);
          }}
        >
          {view.type === "gallery" && galleryConfig.cover !== "none" && (
            <GalleryCover
              key={
                galleryImage(r, galleryConfig, fields, galleryImages) || "empty"
              }
              url={galleryImage(r, galleryConfig, fields, galleryImages)}
              fit={galleryConfig.fit}
              color={galleryConfig.cover === "record" ? r.cover : undefined}
            />
          )}
          <strong>
            {r.icon && <PageIcon name={r.icon} size={16} />}
            {cellText(r.cells[fields[0].id]) || t("Ohne Titel", "Untitled")}
          </strong>
          <div className="card-properties">
            {visibleFields
              .slice(1, 4)
              .filter((f) => r.cells[f.id])
              .map((f) => (
                <span key={f.id}>{display(r, f)}</span>
              ))}
          </div>
          <span className="card-bottom">
            {dateField && display(r, dateField)}
            <span className="card-open">
              <ArrowSquareOut size={14} />
            </span>
          </span>
        </button>
        {editable && orderHandle(r, groupKey)}
      </div>
    );
  }

  function recurrenceControl(row: Row) {
    const rule = parseRecurrence(row.recurrence);
    const save = (next: Recurrence | null) =>
      act({
        action: "row.recurrence",
        rowId: row.id,
        version: row.version,
        recurrence: next,
      });
    const base: Recurrence = rule || { freq: "weekly", interval: 1 };
    return (
      <div className="row-property recurrence-property">
        <span>{t("Wiederholung", "Recurrence")}</span>
        <span className="recurrence-choice">
          <Select
            aria-label={t("Wiederholung", "Recurrence")}
            disabled={!rowEditable(row)}
            value={rule?.freq || ""}
            onChange={(e) =>
              void save(
                e.target.value
                  ? { ...base, freq: e.target.value as Recurrence["freq"] }
                  : null,
              )
            }
          >
            <option value="">{t("Keine", "None")}</option>
            {Object.entries(recurrenceLabels).map(([key, [label]]) => (
              <option key={key} value={key}>
                {t(label)}
              </option>
            ))}
          </Select>
          {rule && (
            <>
              <label>
                {t("Alle", "Every")}
                <input
                  type="number"
                  min={1}
                  max={99}
                  aria-label={t("Wiederholungsintervall", "Recurrence interval")}
                  disabled={!rowEditable(row)}
                  defaultValue={rule.interval}
                  onBlur={(e) => {
                    const interval = Math.min(
                      99,
                      Math.max(1, Math.round(Number(e.target.value) || 1)),
                    );
                    if (interval !== rule.interval)
                      void save({ ...rule, interval });
                  }}
                />
                {t(recurrenceLabels[rule.freq][1])}
              </label>
              <label>
                {t("Endet", "Ends")}
                <input
                  type="date"
                  aria-label={t("Wiederholung endet am", "Recurrence ends on")}
                  disabled={!rowEditable(row)}
                  defaultValue={rule.until || ""}
                  onBlur={(e) => {
                    const until = e.target.value || undefined;
                    if (until !== rule.until)
                      void save({ ...rule, count: undefined, until });
                  }}
                />
              </label>
              <label>
                {t("Termin auslassen", "Skip occurrence")}
                <input
                  type="date"
                  aria-label={t("Termin auslassen am", "Skip occurrence on")}
                  disabled={!rowEditable(row)}
                  onChange={(e) => {
                    const date = e.target.value;
                    e.target.value = "";
                    if (date && !rule.exclude?.includes(date))
                      void save({
                        ...rule,
                        exclude: [...(rule.exclude || []), date].sort(),
                      });
                  }}
                />
              </label>
              {!!rule.exclude?.length && (
                <span className="recurrence-exclusions">
                  {rule.exclude.map((date) => (
                    <button
                      key={date}
                      type="button"
                      className="chip"
                      disabled={!rowEditable(row)}
                      aria-label={`${date} wieder einplanen`}
                      onClick={() =>
                        void save({
                          ...rule,
                          exclude: rule.exclude!.filter((d) => d !== date),
                        })
                      }
                    >
                      {date} ×
                    </button>
                  ))}
                </span>
              )}
              <small className="muted">{recurrenceText(rule)}</small>
            </>
          )}
        </span>
      </div>
    );
  }
  function reminderControl(row: Row, field: Field) {
    const value = row.cells[field.id];
    const reminder = data.reminders?.find(
      (r) => r.rowId === row.id && r.fieldId === field.id,
    );
    if (!validDateValue(value) && !reminder) return null;
    const offsets = reminderOffsets(value);
    const target =
      reminder && reminderTarget(value, reminder.offset, reminder.timeZone);
    const hint = !reminder
      ? ""
      : !target
        ? t("Diese Erinnerung passt nicht zum aktuellen Datum und ist inaktiv.", "This reminder does not fit the current date and is inactive.")
        : target.epochMilliseconds < Date.now() - ARM_GRACE_MS
          ? t("Der Erinnerungszeitpunkt liegt in der Vergangenheit.", "The reminder time is in the past.")
          : t(`Erinnerung am ${new Date(target.epochMilliseconds).toLocaleString(
              LOCALE_TAG,
              {
                timeZone: reminder.timeZone,
                dateStyle: "medium",
                timeStyle: "short",
              },
            )}`, `Reminder on ${new Date(target.epochMilliseconds).toLocaleString("en-GB", { timeZone: reminder.timeZone, dateStyle: "medium", timeStyle: "short" })}`);
    return (
      <label className="row-property reminder-property">
        <span>{t("Erinnerung", "Reminder")}</span>
        <span className="reminder-choice">
          <Select
            aria-label={t(`Erinnerung für ${field.name}`, `Reminder for ${field.name}`)}
            disabled={reminderBusy || !validDateValue(value)}
            value={reminder ? String(reminder.offset) : ""}
            onChange={async (e) => {
              setReminderBusy(true);
              try {
                await act({
                  action: "reminder.set",
                  rowId: row.id,
                  fieldId: field.id,
                  offset: e.target.value === "" ? null : Number(e.target.value),
                  timeZone: reminder?.timeZone || browserZone(),
                });
              } finally {
                setReminderBusy(false);
              }
            }}
          >
            <option value="">{t("Keine Erinnerung", "No reminder")}</option>
            {reminder && !offsets.includes(reminder.offset) && (
              <option value={reminder.offset} disabled>
                {reminderLabel(reminder.offset, !isTimed(value))}
              </option>
            )}
            {offsets.map((o) => (
              <option key={o} value={o}>
                {reminderLabel(o, isTimed(value))}
              </option>
            ))}
          </Select>
          {hint && <small className="muted">{hint}</small>}
        </span>
      </label>
    );
  }
  async function setGroupsCollapsed(keys: string[], value: boolean) {
    if (!viewEditable) {
      setReaderCollapsed((previous) => ({
        ...previous,
        ...Object.fromEntries(
          keys.map((key) => [
            JSON.stringify([view.id, view.groupBy, key]),
            value,
          ]),
        ),
      }));
      return;
    }
    const next = new Set(groupSettings.collapsed);
    for (const key of keys) {
      if (value) next.add(key);
      else next.delete(key);
    }
    if (next.size > 1000) {
      onError(t("Maximal 1.000 eingeklappte Gruppen je Ansicht.", "At most 1,000 collapsed groups per view."));
      return;
    }
    await updateView({
      groupSettings: { ...groupSettings, collapsed: [...next] },
    });
  }
  async function moveGroup(key: string, target: number) {
    if (!viewEditable) return;
    const order = moveGroupOrder(
      groups.map((g) => g.key),
      groupSettings.order,
      key,
      target,
    );
    if (!order) return;
    await updateView({
      groupSettings: { ...groupSettings, sort: "manual", order },
    });
  }
  function groupMoveButtons(group: DatabaseGroup, horizontal = false) {
    if (!viewEditable) return null;
    const index = groups.findIndex((g) => g.key === group.key);
    const Before = horizontal ? CaretLeft : CaretUp;
    const After = horizontal ? CaretRight : CaretDown;
    const before = horizontal ? t("nach links", "to the left") : t("nach oben", "up");
    const after = horizontal ? t("nach rechts", "to the right") : t("nach unten", "down");
    return (
      <span className="group-move">
        <button
          className="icon-button"
          aria-label={t(`Gruppe ${group.label} ${before} verschieben`, `Move group ${group.label} ${before}`)}
          title={t(`Gruppe ${before} verschieben`, `Move group ${before}`)}
          disabled={schemaBusy || index <= 0}
          onClick={() => void moveGroup(group.key, index - 1)}
        >
          <Before size={14} />
        </button>
        <button
          className="icon-button"
          aria-label={t(`Gruppe ${group.label} ${after} verschieben`, `Move group ${group.label} ${after}`)}
          title={t(`Gruppe ${after} verschieben`, `Move group ${after}`)}
          disabled={schemaBusy || index >= groups.length - 1}
          onClick={() => void moveGroup(group.key, index + 1)}
        >
          <After size={14} />
        </button>
      </span>
    );
  }
  const columnAt = (x: number, y: number) =>
    document
      .elementFromPoint(x, y)
      ?.closest<HTMLElement>(".board-column[data-group-key]")?.dataset.groupKey;
  function columnHover(x: number, y: number) {
    const drag = columnDrag.current;
    if (!drag) return;
    const target = columnAt(x, y);
    setGroupDrop(target && target !== drag.key ? target : null);
  }
  columnHoverRef.current = columnHover;
  function dropGroup(e: DragEvent, target: DatabaseGroup) {
    if (!viewEditable || !e.dataTransfer.types.includes(groupDragType)) return;
    e.preventDefault();
    setGroupDrop(null);
    const source = e.dataTransfer.getData(groupDragType);
    const index = groups.findIndex((g) => g.key === target.key);
    if (source && index >= 0) void moveGroup(source, index);
  }
  function dropIntoGroup(e: DragEvent, group: DatabaseGroup) {
    if (
      !editable ||
      !viewEditable ||
      orderBusy ||
      !e.dataTransfer.types.includes(rowDragType)
    )
      return;
    try {
      const source = JSON.parse(e.dataTransfer.getData(rowDragType)).rowId;
      dragMove(
        e,
        group.rows.filter((r) => r.id !== source).at(-1),
        group.key,
        true,
      );
    } catch {
      setDropHint(null);
    }
  }
  function summaries(rows: Row[]) {
    return visibleFields.map((f) => {
      const summary = columnSummary(
        f,
        rows,
        calculationFor(view.calculations, f.id),
      );
      return (
        summary && (
          <span key={f.id}>
            {f.name}: {summaryText(summary, f, t)}
          </span>
        )
      );
    });
  }
  function nestedRows(
    group: DatabaseGroup,
    render: (r: Row, key: string) => ReactNode,
    table: boolean,
  ) {
    const list = subgroups.get(group.key);
    if (!list) {
      const limit = groupLimits[group.key] ?? ROW_STEP;
      return (
        <>
          {group.rows.slice(0, limit).map((r) => render(r, group.key))}
          {group.rows.length > limit && (
            <MoreRows
              table={table}
              colSpan={Math.max(1, visibleFields.length + (editable ? 2 : 0))}
              remaining={group.rows.length - limit}
              onMore={() =>
                setGroupLimits((current) => ({ ...current, [group.key]: limit + ROW_STEP }))
              }
            />
          )}
        </>
      );
    }
    return list.map((sg) => {
      const key = nestedKey(group.key, sg.key),
        header = subgroupHeader(group, sg);
      return (
        <Fragment key={key}>
          {table ? (
            <tr className="database-group-row database-subgroup-row">
              <th
                colSpan={Math.max(1, visibleFields.length + (editable ? 2 : 0))}
              >
                {header}
              </th>
            </tr>
          ) : (
            header
          )}
          {!subCollapsed(group.key, sg.key) &&
            deepRows(sg.rows, [group, sg], render, table, key)}
        </Fragment>
      );
    });
  }
  // Levels 3 to 5 below a subgroup. Moves keep addressing the first two
  // levels; new records take the values of every level.
  function deepRows(
    rows: Row[],
    path: DatabaseGroup[],
    render: (r: Row, key: string) => ReactNode,
    table: boolean,
    key: string,
  ): ReactNode {
    const field = deeperFields[path.length - 2];
    if (!field) return rows.map((r) => render(r, key));
    return databaseGroups(rows, field, related, members)
      .filter((g) => g.rows.length)
      .map((g) => {
        const keys = [...path.map((p) => p.key), g.key],
          closed = collapsed(pathCollapseKey(keys)),
          header = deepHeader([...path, g], closed);
        return (
          <Fragment key={JSON.stringify(keys)}>
            {table ? (
              <tr className="database-group-row database-subgroup-row">
                <th
                  colSpan={Math.max(
                    1,
                    visibleFields.length + (editable ? 2 : 0),
                  )}
                >
                  {header}
                </th>
              </tr>
            ) : (
              header
            )}
            {!closed && deepRows(g.rows, [...path, g], render, table, key)}
          </Fragment>
        );
      });
  }
  function deepCells(path: DatabaseGroup[]) {
    const levels = [groupField, subField, ...deeperFields];
    return Object.fromEntries(
      path.map((g, i) => [levels[i]!.id, groupCellValue(levels[i]!, g.value)]),
    );
  }
  function deepHeader(path: DatabaseGroup[], closed: boolean) {
    const g = path.at(-1)!,
      where = path
        .slice(0, -1)
        .map((p) => p.label)
        .join(" / ");
    const level = path.length;
    const canCreate =
      canSubEdit &&
      deeperFields
        .slice(0, level - 2)
        .every((f) => !computedTypes.includes(f.type));
    return (
      <div
        className={`database-group-header database-subgroup-header database-group-level-${level}`}
        role="group"
        aria-label={t(`Gruppe ${g.label} in ${where}`, `Group ${g.label} in ${where}`)}
      >
        <button
          className="group-toggle"
          aria-expanded={!closed}
          aria-label={t(`Gruppe ${g.label} in ${where} ${closed ? "ausklappen" : "einklappen"}`, `${closed ? "Expand" : "Collapse"} group ${g.label} in ${where}`)}
          disabled={schemaBusy}
          onClick={() =>
            void setGroupsCollapsed(
              [pathCollapseKey(path.map((p) => p.key))],
              !closed,
            )
          }
        >
          <CaretRight
            size={13}
            style={{ transform: closed ? undefined : "rotate(90deg)" }}
          />
          <span>{g.label}</span>
          <span className="muted">{g.rows.length}</span>
        </button>
        <span className="group-summary">{summaries(g.rows)}</span>
        {canCreate && (
          <button
            className="icon-button"
            title={t(`Eintrag in ${where} / ${g.label} hinzufügen`, `Add record in ${where} / ${g.label}`)}
            onClick={() => createRow(deepCells(path))}
          >
            <Plus size={16} />
          </button>
        )}
      </div>
    );
  }
  // Board swimlane cells: sections for levels 3 to 5.
  function deepCards(
    rows: Row[],
    path: DatabaseGroup[],
    key: string,
  ): ReactNode {
    const field = deeperFields[path.length - 2];
    if (!field) return rows.map((r) => card(r, key));
    return databaseGroups(rows, field, related, members)
      .filter((g) => g.rows.length)
      .map((g) => {
        const keys = [...path.map((p) => p.key), g.key],
          closed = collapsed(pathCollapseKey(keys));
        return (
          <section
            key={JSON.stringify(keys)}
            className={`board-card-section database-group-level-${keys.length}`}
            aria-label={t(`Abschnitt ${g.label}`, `Section ${g.label}`)}
          >
            <button
              className="group-toggle"
              aria-expanded={!closed}
              aria-label={t(`Abschnitt ${g.label} ${closed ? "ausklappen" : "einklappen"}`, `${closed ? "Expand" : "Collapse"} section ${g.label}`)}
              disabled={schemaBusy}
              onClick={() =>
                void setGroupsCollapsed([pathCollapseKey(keys)], !closed)
              }
            >
              <CaretRight
                size={12}
                style={{ transform: closed ? undefined : "rotate(90deg)" }}
              />
              <span>{g.label}</span>
              <span className="muted">{g.rows.length}</span>
            </button>
            {!closed && deepCards(g.rows, [...path, g], key)}
          </section>
        );
      });
  }
  function subgroupHeader(group: DatabaseGroup, sub: DatabaseGroup) {
    const closed = subCollapsed(group.key, sub.key),
      target = { ...sub, key: nestedKey(group.key, sub.key) };
    return (
      <div
        className="database-group-header database-subgroup-header"
        role="group"
        aria-label={t(`Untergruppe ${sub.label} in ${group.label}`, `Sub-group ${sub.label} in ${group.label}`)}
        onDragOver={(e) => {
          if (
            editable &&
            !orderBusy &&
            e.dataTransfer.types.includes(rowDragType)
          )
            e.preventDefault();
        }}
        onDrop={(e) => dropIntoGroup(e, target)}
      >
        <button
          className="group-toggle"
          aria-expanded={!closed}
          aria-label={t(`Untergruppe ${sub.label} in ${group.label} ${closed ? "ausklappen" : "einklappen"}`, `${closed ? "Expand" : "Collapse"} sub-group ${sub.label} in ${group.label}`)}
          disabled={schemaBusy}
          onClick={() =>
            void setGroupsCollapsed(
              [subgroupCollapseKey(group.key, sub.key)],
              !closed,
            )
          }
        >
          <CaretRight
            size={14}
            style={{ transform: closed ? undefined : "rotate(90deg)" }}
          />
          <span>{sub.label}</span>
          <span className="muted">{sub.rows.length}</span>
        </button>
        <span className="group-summary">{summaries(sub.rows)}</span>
        {canSubEdit && (
          <button
            className="icon-button"
            title={t(`Eintrag in ${group.label} / ${sub.label} hinzufügen`, `Add record in ${group.label} / ${sub.label}`)}
            onClick={() =>
              createRow({
                [groupField!.id]: groupCellValue(groupField!, group.value),
                [subField!.id]: groupCellValue(subField!, sub.value),
              })
            }
          >
            <Plus size={16} />
          </button>
        )}
      </div>
    );
  }
  function groupHeader(group: DatabaseGroup) {
    return (
      <div
        className="database-group-header"
        onDragOver={(e) => {
          if (
            editable &&
            !orderBusy &&
            e.dataTransfer.types.includes(rowDragType)
          )
            e.preventDefault();
        }}
        onDrop={(e) => dropIntoGroup(e, group)}
      >
        <button
          className="group-toggle"
          aria-expanded={!collapsed(group.key)}
          aria-label={t(`Gruppe ${group.label} ${collapsed(group.key) ? "ausklappen" : "einklappen"}`, `${collapsed(group.key) ? "Expand" : "Collapse"} group ${group.label}`)}
          disabled={schemaBusy}
          onClick={() =>
            void setGroupsCollapsed([group.key], !collapsed(group.key))
          }
        >
          <CaretRight
            size={16}
            style={{
              transform: collapsed(group.key) ? undefined : "rotate(90deg)",
            }}
          />
          <span>{group.label}</span>
          <span className="muted">{group.rows.length}</span>
        </button>
        {editable && view.type === "table" && (
          <input
            type="checkbox"
            aria-label={t(`Gruppe ${group.label} auswählen`, `Select group ${group.label}`)}
            disabled={bulkBusy || !group.rows.length}
            checked={
              group.rows.length > 0 &&
              group.rows.every((r) => selection.has(r.id))
            }
            onChange={(e) => {
              const checked = e.target.checked;
              setSelection((previous) => {
                const next = new Map(previous);
                for (const r of group.rows) {
                  if (checked) next.set(r.id, r.version);
                  else next.delete(r.id);
                }
                return next;
              });
            }}
          />
        )}
        <span className="group-summary">{summaries(group.rows)}</span>
        {groupMoveButtons(group)}
        {editable && canGroupEdit && (
          <button
            className="icon-button"
            title={t(`Eintrag in ${group.label} hinzufügen`, `Add record in ${group.label}`)}
            onClick={() =>
              createRow({
                [groupField!.id]: groupCellValue(groupField!, group.value),
              })
            }
          >
            <Plus size={16} />
          </button>
        )}
      </div>
    );
  }
  function tableRow(r: Row, groupKey?: string, tree?: { depth: number; children: number }) {
    return (
      <tr
        key={r.id}
        className={`${selection.has(r.id) ? "row-selected" : ""} ${dropClass(r, groupKey)}`}
        data-row-id={r.id}
        onDragOver={(e) => dragOver(e, r, groupKey)}
        onDrop={(e) => dragMove(e, r, groupKey)}
      >
        {editable && (
          <td className="selection-cell">
            <div className="row-selection-controls">
              {orderHandle(r, groupKey)}
              <input
                type="checkbox"
                aria-label={t(`${cellText(r.cells[fields[0].id]) || "Ohne Titel"} auswählen`, `Select ${cellText(r.cells[fields[0].id]) || "Untitled"}`)}
                disabled={bulkBusy}
                checked={selection.has(r.id)}
                onChange={(e) => selectRow(r, e.target.checked)}
              />
            </div>
          </td>
        )}
        {visibleFields.map((f, i) => (
          <td
            key={f.id}
            onClick={() => {
              if (
                !rowEditable(r) ||
                f.id === fields[0].id ||
                computedTypes.includes(f.type)
              )
                setRowId(r.id);
              else if (f.type === "checkbox")
                void updateCell(r, f, !r.cells[f.id]);
              else setEditingCell({ rowId: r.id, fieldId: f.id, groupKey });
            }}
          >
            {editingCell?.rowId === r.id &&
            editingCell?.fieldId === f.id &&
            editingCell?.groupKey === groupKey ? (
              <span
                className="inline-cell"
                onClick={(e) => e.stopPropagation()}
              >
                <CellInput
                  field={f}
                  value={r.cells[f.id]}
                  members={members}
                  related={related}
                  onChange={(v) => updateCell(r, f, v)}
                  upload={editable ? uploadFile : undefined}
                  files={data.files}
                />
              </span>
            ) : (
              <span
                className={f.id === fields[0].id ? "title-cell" : ""}
                style={tree && f.id === fields[0].id ? { paddingLeft: tree.depth * 18 } : undefined}
              >
                {tree && f.id === fields[0].id && (
                  <button
                    type="button"
                    className="tree-toggle"
                    aria-label={
                      treeCollapsed.has(r.id)
                        ? t(`${tree.children} Unteraufgaben zeigen`, `Show ${tree.children} subtasks`)
                        : t("Unteraufgaben ausblenden", "Hide subtasks")
                    }
                    aria-expanded={!treeCollapsed.has(r.id)}
                    style={{ visibility: tree.children ? "visible" : "hidden" }}
                    onClick={(e) => {
                      e.stopPropagation();
                      setTreeCollapsed((current) => {
                        const next = new Set(current);
                        if (next.has(r.id)) next.delete(r.id);
                        else next.add(r.id);
                        return next;
                      });
                    }}
                  >
                    <CaretRight size={12} />
                  </button>
                )}
                {f.id === fields[0].id && r.icon && (
                  <PageIcon name={r.icon} size={15} className="row-icon" />
                )}
                {display(r, f)}
                {f.id === fields[0].id && (
                  <ArrowSquareOut className="row-open" size={14} />
                )}
              </span>
            )}
          </td>
        ))}
        {editable && <td />}
      </tr>
    );
  }
  function listRow(r: Row, groupKey?: string) {
    return (
      <div
        key={r.id}
        className={`record-list-item ${dropClass(r, groupKey)}`}
        data-row-id={r.id}
        onDragOver={(e) => dragOver(e, r, groupKey)}
        onDrop={(e) => dragMove(e, r, groupKey)}
      >
        {editable && orderHandle(r, groupKey)}
        <button onClick={() => setRowId(r.id)}>
          <span>
            {r.icon && <PageIcon name={r.icon} size={16} />}
            {cellText(r.cells[fields[0].id]) || t("Ohne Titel", "Untitled")}
          </span>
          <span>
            {visibleFields.slice(1, 4).map((f) => (
              <span key={f.id}>{display(r, f)}</span>
            ))}
          </span>
        </button>
      </div>
    );
  }

  return (
    <div className="database" ref={boardRef}>
      <div className="database-tabs">
        {data.database.views.map((v) => {
          const Icon = viewIcons[v.type];
          return (
            <button
              className={v.id === view.id ? "selected" : ""}
              onClick={() => setViewId(v.id)}
              key={v.id}
            >
              <Icon size={17} />
              {v.name}
            </button>
          );
        })}
        {viewEditable && (
          <button
            className="icon-button"
            title={t("Ansicht hinzufügen", "Add view")}
            onClick={() => setNewView(true)}
          >
            <Plus />
          </button>
        )}
      </div>
      <div className="database-toolbar">
        <div className="toolbar-left">
          <button
            className={activeFilterCount ? "active" : ""}
            onClick={() => setFilterOpen(true)}
          >
            <Funnel size={16} />
            {t("Filtern", "Filter")}
            {activeFilterCount > 0 && (
              <span className="count">{activeFilterCount}</span>
            )}
          </button>
          <button onClick={() => setConfig(true)}>
            <SortAscending size={17} />
            {t("Sortieren", "Sort")}
          </button>
          <button
            title={t("Ansicht und Eigenschaften", "View and properties")}
            onClick={() => setConfig(true)}
          >
            <SlidersHorizontal size={17} />
          </button>
        </div>
        <div className="toolbar-right">
          <div className="table-search">
            <MagnifyingGlass size={16} />
            <input
              aria-label={t("Datenbank durchsuchen", "Search database")}
              placeholder={t("Suchen …", "Search …")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <button
            title="CSV exportieren"
            onClick={() =>
              download(
                `${page.title}.csv`,
                Papa.unparse({
                  fields: fields.map((f) => f.name),
                  data: shown.map((r) =>
                    fields.map((f) => cellText(r.cells[f.id])),
                  ),
                }),
                "text/csv",
              )
            }
          >
            <DownloadSimple size={17} />
          </button>
          {editable && (
            <>
              <button
                title="CSV importieren"
                onClick={() => importRef.current?.click()}
              >
                <UploadSimple size={17} />
              </button>
              <button
                className="button primary compact"
                onClick={() => createRow()}
              >
                <Plus size={16} />
                {t("Neu", "New")}
              </button>{" "}
              <DatabaseTools
                page={page}
                database={data.database}
                members={members}
                editable={editable}
                act={act}
                onTemplates={() => setManageTemplates(true)}
              />
            </>
          )}
        </div>
      </div>
      {editable && view.type === "table" && selectionRows.length > 0 && (
        <div
          className="bulk-toolbar"
          role="toolbar"
          aria-label={t("Ausgewählte Einträge", "Selected records")}
        >
          <strong>{selectionRows.length} {t("ausgewählt", "selected")}</strong>
          <button
            className="button compact"
            disabled={bulkBusy}
            onClick={() => {
              setBulkField(
                fields.find((f) => !computedTypes.includes(f.type))?.id || "",
              );
              setBulkValue(undefined);
              setBulk("update");
            }}
          >
            {t("Gemeinsam bearbeiten", "Edit together")}
          </button>
          <button
            className="button compact"
            disabled={bulkBusy}
            onClick={() => bulkAction("duplicate")}
          >
            {t("Duplizieren", "Duplicate")}
          </button>
          <button
            className="button compact danger"
            disabled={bulkBusy}
            onClick={() => setBulk("delete")}
          >
            {t("Löschen", "Delete")}
          </button>
          <button
            className="button compact"
            onClick={() => setSelection(new Map())}
          >
            {t("Auswahl aufheben", "Clear selection")}
          </button>
        </div>
      )}
      {grouped && (
        <div className="group-view-toolbar">
          <span>
            {groups.length} {t("Gruppen ·", "Groups ·")}{" "}{shown.length} {t("Einträge", "records")}
          </span>
          <button
            className="button compact"
            disabled={schemaBusy}
            onClick={() =>
              void setGroupsCollapsed(
                groups.map((g) => g.key),
                true,
              )
            }
          >
            {t("Alle einklappen", "Collapse all")}
          </button>
          <button
            className="button compact"
            disabled={schemaBusy}
            onClick={() =>
              void setGroupsCollapsed(
                groups.map((g) => g.key),
                false,
              )
            }
          >
            {t("Alle ausklappen", "Expand all")}
          </button>
        </div>
      )}
      {view.type === "table" && (
        <div className="data-table-scroll">
          <table
            className="data-table configurable-table"
            style={{
              width: visibleFields.reduce(
                (sum, f) => sum + columnWidth(f),
                editable ? 118 : 0,
              ),
            }}
          >
            <colgroup>
              {editable && <col style={{ width: 76 }} />}
              {visibleFields.map((f) => (
                <col key={f.id} style={{ width: columnWidth(f) }} />
              ))}
              {editable && <col style={{ width: 42 }} />}
            </colgroup>
            <thead>
              <tr>
                {editable && (
                  <th className="selection-cell">
                    <input
                      type="checkbox"
                      aria-label={t("Alle sichtbaren Einträge auswählen", "Select all visible records")}
                      disabled={bulkBusy}
                      checked={
                        selectableRows.length > 0 &&
                        selectableRows.every((r) => selection.has(r.id))
                      }
                      onChange={(e) =>
                        setSelection(
                          e.target.checked
                            ? new Map(
                                selectableRows.map((r) => [r.id, r.version]),
                              )
                            : new Map(),
                        )
                      }
                    />
                  </th>
                )}
                {visibleFields.map((f) => (
                  <th
                    key={f.id}
                    data-field-id={f.id}
                    draggable={viewEditable}
                    onDragStart={(e) =>
                      e.dataTransfer.setData(
                        "application/x-flowplan-field",
                        f.id,
                      )
                    }
                    onDragOver={(e) => {
                      if (
                        viewEditable &&
                        e.dataTransfer.types.includes(
                          "application/x-flowplan-field",
                        )
                      )
                        e.preventDefault();
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      const source = e.dataTransfer.getData(
                        "application/x-flowplan-field",
                      );
                      if (source && source !== f.id)
                        void moveColumn(source, f.id);
                    }}
                  >
                    <button
                      disabled={!allowFieldChanges}
                      className={
                        !allowFieldChanges ? "source-property-label" : undefined
                      }
                      title={
                        !allowFieldChanges
                          ? t("Eigenschaften in der Quelldatenbank bearbeiten", "Edit properties in the source database")
                          : undefined
                      }
                      onClick={() => {
                        setFieldDraft({
                          ...f,
                          ...(f.formula
                            ? {
                                formula: rewriteFormulaReferences(
                                  f.formula,
                                  fields,
                                  "display",
                                ),
                              }
                            : {}),
                        });
                        setFieldVersion(data.database.version);
                        setFieldError("");
                        setNewField(true);
                      }}
                    >
                      <span className="property-type">
                        {f.type === "number"
                          ? "#"
                          : f.type === "date"
                            ? "◷"
                            : f.type === "text"
                              ? "Aa"
                              : f.type === "formula"
                                ? "ƒ"
                                : "≡"}
                      </span>
                      {f.name}
                    </button>
                    {viewEditable && (
                      <span
                        className="column-resizer"
                        role="separator"
                        aria-orientation="vertical"
                        aria-label={`${f.name}: Spaltenbreite`}
                        aria-valuenow={columnWidth(f)}
                        aria-valuemin={80}
                        aria-valuemax={800}
                        tabIndex={0}
                        draggable={false}
                        onPointerDown={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          e.currentTarget.setPointerCapture(e.pointerId);
                          setResize({
                            id: f.id,
                            startX: e.clientX,
                            startWidth: columnWidth(f),
                            width: columnWidth(f),
                          });
                        }}
                        onPointerMove={(e) => {
                          if (resize?.id === f.id)
                            setResize({
                              ...resize,
                              width: Math.max(
                                80,
                                Math.min(
                                  800,
                                  Math.round(
                                    resize.startWidth +
                                      e.clientX -
                                      resize.startX,
                                  ),
                                ),
                              ),
                            });
                        }}
                        onPointerUp={(e) => {
                          if (resize?.id === f.id) {
                            void updateView({
                              columnWidths: {
                                ...view.columnWidths,
                                [f.id]: Math.max(
                                  80,
                                  Math.min(
                                    800,
                                    Math.round(
                                      resize.startWidth +
                                        e.clientX -
                                        resize.startX,
                                    ),
                                  ),
                                ),
                              },
                            });
                            setResize(null);
                          }
                        }}
                        onPointerCancel={() => setResize(null)}
                        onKeyDown={(e) => {
                          if (["ArrowLeft", "ArrowRight"].includes(e.key)) {
                            e.preventDefault();
                            void updateView({
                              columnWidths: {
                                ...view.columnWidths,
                                [f.id]: Math.max(
                                  80,
                                  Math.min(
                                    800,
                                    columnWidth(f) +
                                      (e.key === "ArrowRight" ? 20 : -20),
                                  ),
                                ),
                              },
                            });
                          }
                        }}
                      />
                    )}
                  </th>
                ))}
                {editable && (
                  <th className="add-property">
                    <button
                      aria-label={t("Eigenschaft hinzufügen", "Add property")}
                      disabled={!allowFieldChanges}
                      onClick={() => {
                        setFieldVersion(data.database.version);
                        setFieldError("");
                        setFieldDraft({
                          id: crypto.randomUUID(),
                          name: "",
                          type: "text",
                        });
                        setNewField(true);
                      }}
                    >
                      <Plus size={16} />
                    </button>
                  </th>
                )}
              </tr>
            </thead>
            {grouped ? (
              groups.map((g) => (
                <tbody key={g.key} aria-label={t(`Gruppe ${g.label}`, `Group ${g.label}`)}>
                  <tr className="database-group-row">
                    <th
                      colSpan={Math.max(
                        1,
                        visibleFields.length + (editable ? 2 : 0),
                      )}
                    >
                      {groupHeader(g)}
                    </th>
                  </tr>
                  {!collapsed(g.key) &&
                    nestedRows(g, (r, key) => tableRow(r, key), true)}
                </tbody>
              ))
            ) : (
              <tbody>
                {treeParent
                  ? treeOrder(shown, treeParent, treeCollapsed)
                      .slice(0, rowLimit)
                      .map((x) => tableRow(x.row, undefined, { depth: x.depth, children: x.children }))
                  : shown.slice(0, rowLimit).map((r) => tableRow(r))}
                {shown.length > rowLimit && (
                  <MoreRows
                    table
                    auto
                    colSpan={Math.max(1, visibleFields.length + (editable ? 2 : 0))}
                    remaining={shown.length - rowLimit}
                    onMore={() => setRowLimit((l) => l + ROW_STEP)}
                  />
                )}
              </tbody>
            )}

            <tfoot>
              <tr>
                <td colSpan={visibleFields.length + (editable ? 2 : 0)}>
                  {editable && (
                    <button className="new-record" onClick={() => createRow()}>
                      <Plus size={15} />
                      {t("Neue Zeile", "New row")}
                    </button>
                  )}
                  <span className="record-count">{shown.length} {t("Einträge", "records")}</span>
                </td>
              </tr>
              <tr className="table-count column-calculations">
                {editable && <td />}
                {visibleFields.map((f) => {
                  const summary = columnSummary(
                    f,
                    shown,
                    calculationFor(view.calculations, f.id),
                  );
                  return (
                    <td key={f.id}>
                      <button
                        className="column-calculation"
                        aria-label={t(`Berechnung für ${f.name}`, `Calculation for ${f.name}`)}
                        disabled={schemaBusy}
                        onClick={() =>
                          setCalculationEdit({
                            field: f,
                            viewId: view.id,
                            version: data.database.version,
                            choice: calculationFor(view.calculations, f.id),
                          })
                        }
                      >
                        {summary ? (
                          <>
                            <span>{f.name}: </span>
                            <strong>{summaryText(summary, f, t)}</strong>
                          </>
                        ) : (
                          <span>{t("Berechnen", "Calculate")}</span>
                        )}
                      </button>
                    </td>
                  );
                })}
                {editable && <td />}
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      {lanes && (
        <div className="board board-swimlanes">
          <div className="board-lane-head">
            {groups.map((g) => (
              <header
                key={g.key}
                className={`board-lane-column${collapsed(g.key) ? " collapsed" : ""}`}
                aria-label={t(`Spalte ${g.label}`, `Column ${g.label}`)}
              >
                <button
                  className="icon-button group-toggle"
                  aria-expanded={!collapsed(g.key)}
                  aria-label={t(`Gruppe ${g.label} ${collapsed(g.key) ? "ausklappen" : "einklappen"}`, `${collapsed(g.key) ? "Expand" : "Collapse"} group ${g.label}`)}
                  disabled={schemaBusy}
                  onClick={() =>
                    void setGroupsCollapsed([g.key], !collapsed(g.key))
                  }
                >
                  <CaretRight
                    size={14}
                    style={{
                      transform: collapsed(g.key) ? undefined : "rotate(90deg)",
                    }}
                  />
                </button>
                <span className={`tag tag-${tagColor(g.label)}`}>
                  {g.label}
                </span>
                <WipCount count={g.rows.length} limit={view.wip?.[g.key]} />

                {!collapsed(g.key) && groupMoveButtons(g, true)}
              </header>
            ))}
          </div>
          {lanes.map((lane) => {
            const laneKey = subgroupCollapseKey("lane", lane.key),
              closed = collapsed(laneKey);
            return (
              <section
                key={lane.key}
                className="board-lane"
                aria-label={t(`Swimlane ${lane.label}`, `Swimlane ${lane.label}`)}
              >
                <div className="board-lane-title">
                  <button
                    className="group-toggle"
                    aria-expanded={!closed}
                    aria-label={t(`Swimlane ${lane.label} ${closed ? "ausklappen" : "einklappen"}`, `${closed ? "Expand" : "Collapse"} swimlane ${lane.label}`)}
                    disabled={schemaBusy}
                    onClick={() => void setGroupsCollapsed([laneKey], !closed)}
                  >
                    <CaretRight
                      size={14}
                      style={{
                        transform: closed ? undefined : "rotate(90deg)",
                      }}
                    />
                    <span>{lane.label}</span>
                    <span className="muted">{lane.rows.length}</span>
                  </button>
                </div>
                {!closed && (
                  <div className="board-lane-cells">
                    {groups.map((g) => {
                      const key = nestedKey(g.key, lane.key),
                        cellRows =
                          subgroups
                            .get(g.key)
                            ?.find((sg) => sg.key === lane.key)?.rows || [],
                        target = { ...g, key, rows: cellRows };
                      return (
                        <div
                          key={g.key}
                          role="group"
                          aria-label={`${g.label} · ${lane.label}`}
                          className={`board-cell${collapsed(g.key) ? " collapsed" : ""}`}
                          onDragOver={(e) => {
                            if (
                              editable &&
                              !orderBusy &&
                              e.dataTransfer.types.includes(rowDragType)
                            )
                              e.preventDefault();
                          }}
                          onDrop={(e) => dropIntoGroup(e, target)}
                        >
                          {collapsed(g.key) ? (
                            <span className="muted">{cellRows.length}</span>
                          ) : (
                            <>
                              {deepCards(
                                cellRows,
                                [g, { ...lane, rows: cellRows }],
                                key,
                              )}
                              {canSubEdit && (
                                <button
                                  className="new-record"
                                  title={t(`Eintrag in ${g.label} / ${lane.label} hinzufügen`, `Add record in ${g.label} / ${lane.label}`)}
                                  onClick={() =>
                                    createRow({
                                      [groupField!.id]: groupCellValue(
                                        groupField!,
                                        g.value,
                                      ),
                                      [subField!.id]: groupCellValue(
                                        subField!,
                                        lane.value,
                                      ),
                                    })
                                  }
                                >
                                  <Plus size={16} />
                                  {t("Neu", "New")}
                                </button>
                              )}
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
      {view.type === "board" && !lanes && (
        <div className="board">
          {groups.map((g) => (
            <section
              className={`board-column${collapsed(g.key) ? " collapsed" : ""}${groupDrop === g.key ? " group-drop" : ""}`}
              key={g.key}
              data-group-key={g.key}
              aria-label={t(`Gruppe ${g.label}`, `Group ${g.label}`)}
              onDragOver={(e) => {
                if (
                  viewEditable &&
                  !schemaBusy &&
                  e.dataTransfer.types.includes(groupDragType)
                ) {
                  e.preventDefault();
                  setGroupDrop(g.key);
                  return;
                }
                if (
                  editable &&
                  !orderBusy &&
                  e.dataTransfer.types.includes(rowDragType)
                )
                  e.preventDefault();
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null))
                  setGroupDrop((k) => (k === g.key ? null : k));
              }}
              onDrop={(e) => {
                if (e.dataTransfer.types.includes(groupDragType)) {
                  dropGroup(e, g);
                  return;
                }
                let source: string | undefined;
                try {
                  source = JSON.parse(
                    e.dataTransfer.getData(rowDragType),
                  ).rowId;
                } catch {
                  return;
                }
                dragMove(
                  e,
                  g.rows.filter((r) => r.id !== source).at(-1),
                  g.key,
                  true,
                );
              }}
            >
              <header
                draggable={viewEditable && !schemaBusy}
                onDragStart={(e) => {
                  e.dataTransfer.setData(groupDragType, g.key);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragEnd={() => setGroupDrop(null)}
              >
                <button
                  className="icon-button group-toggle"
                  aria-expanded={!collapsed(g.key)}
                  aria-label={t(`Gruppe ${g.label} ${collapsed(g.key) ? "ausklappen" : "einklappen"}`, `${collapsed(g.key) ? "Expand" : "Collapse"} group ${g.label}`)}
                  disabled={schemaBusy}
                  onClick={() =>
                    void setGroupsCollapsed([g.key], !collapsed(g.key))
                  }
                >
                  <CaretRight
                    size={14}
                    style={{
                      transform: collapsed(g.key) ? undefined : "rotate(90deg)",
                    }}
                  />
                </button>
                <span className={`tag tag-${tagColor(g.label)}`}>
                  {g.label}
                </span>
                <WipCount count={g.rows.length} limit={view.wip?.[g.key]} />
                {viewEditable && (
                  <button
                    className="group-drag"
                    aria-label={t(`Gruppe ${g.label} ziehen`, `Drag group ${g.label}`)}
                    disabled={schemaBusy}
                    onPointerDown={(e) => {
                      e.preventDefault();
                      e.currentTarget.setPointerCapture(e.pointerId);
                      columnDrag.current = { key: g.key, pointer: e.pointerId };
                      columnScroll.start(e.currentTarget);
                    }}
                    onPointerMove={(e) => {
                      if (columnDrag.current?.pointer !== e.pointerId) return;
                      columnHover(e.clientX, e.clientY);
                      columnScroll.move(e.clientX, e.clientY);
                    }}
                    onPointerUp={(e) => {
                      const drag = columnDrag.current;
                      columnDrag.current = null;
                      columnScroll.stop();
                      setGroupDrop(null);
                      if (drag?.pointer !== e.pointerId) return;
                      const target = columnAt(e.clientX, e.clientY),
                        index = groups.findIndex((x) => x.key === target);
                      if (target !== drag.key && index >= 0)
                        void moveGroup(drag.key, index);
                    }}
                    onPointerCancel={() => {
                      columnDrag.current = null;
                      columnScroll.stop();
                      setGroupDrop(null);
                    }}
                  >
                    <DotsSixVertical size={14} />
                  </button>
                )}
                {!collapsed(g.key) && groupMoveButtons(g, true)}
                {editable && !collapsed(g.key) && (
                  <button
                    className="icon-button"
                    title={t(`Eintrag in ${g.label} hinzufügen`, `Add record in ${g.label}`)}
                    onClick={() =>
                      createRow(
                        groupField && canGroupEdit
                          ? {
                              [groupField.id]: groupCellValue(
                                groupField,
                                g.value,
                              ),
                            }
                          : {},
                      )
                    }
                  >
                    <Plus size={16} />
                  </button>
                )}
              </header>
              {!collapsed(g.key) &&
                g.rows.slice(0, groupLimits[g.key] ?? ROW_STEP).map((r) => card(r, g.key))}
              {!collapsed(g.key) && g.rows.length > (groupLimits[g.key] ?? ROW_STEP) && (
                <MoreRows
                  remaining={g.rows.length - (groupLimits[g.key] ?? ROW_STEP)}
                  onMore={() =>
                    setGroupLimits((current) => ({
                      ...current,
                      [g.key]: (current[g.key] ?? ROW_STEP) + ROW_STEP,
                    }))
                  }
                />
              )}
              {editable && !collapsed(g.key) && (
                <button
                  className="new-record"
                  onClick={() =>
                    createRow(
                      groupField && canGroupEdit
                        ? {
                            [groupField.id]: groupCellValue(
                              groupField,
                              g.value,
                            ),
                          }
                        : {},
                    )
                  }
                >
                  <Plus size={16} />
                  {t("Neue Aufgabe", "New task")}
                </button>
              )}
            </section>
          ))}
          {viewEditable &&
            groupField &&
            (groupField.type === "select" ||
              groupField.type === "multiselect") && (
              <AddBoardGroup
                disabled={schemaBusy}
                existing={groupField.options || []}
                onAdd={(name) =>
                  updateSchema(
                    fields.map((f) =>
                      f.id === groupField.id
                        ? { ...f, options: [...(f.options || []), name] }
                        : f,
                    ),
                  )
                }
              />
            )}
        </div>
      )}
      {view.type === "feed" && (
        <DatabaseFeed
          key={view.id}
          rows={shown}
          fields={fields}
          visibleFields={visibleFields}
          view={view}
          members={members}
          comments={data.comments}
          display={display}
          onOpen={setRowId}
          orderHandle={(r) => (editable ? orderHandle(r) : null)}
          query={query}
          rowEvents={(r) => ({
            className: dropClass(r),
            onDragOver: (e) => dragOver(e, r),
            onDrop: (e) => dragMove(e, r),
          })}
          editor={
            editable
              ? (r) => ({
                  property: (f) =>
                    computedTypes.includes(f.type) ? (
                      display(r, f)
                    ) : (
                      <CellInput
                        field={f}
                        value={r.cells[f.id]}
                        members={members}
                        related={related}
                        onChange={(v) => updateCell(r, f, v)}
                        upload={uploadFile}
                        files={data.files}
                      />
                    ),
                  document: (
                    <RowDocument
                      key={r.id}
                      pageId={page.id}
                      rowId={r.id}
                      userId={userId}
                      pages={pages}
                      members={members}
                      editable={editable}
                      onError={onError}
                      onChanged={onRefresh}
                    />
                  ),
                })
              : undefined
          }
          onComment={(r, body) =>
            act({ action: "comment.create", rowId: r.id, body })
          }
        />
      )}
      {view.type === "gallery" && (
        <div className={`gallery gallery-size-${galleryConfig.size}`}>
          {shown.slice(0, rowLimit).map((r) => card(r))}
          {shown.length > rowLimit && (
            <MoreRows auto remaining={shown.length - rowLimit} onMore={() => setRowLimit((l) => l + ROW_STEP)} />
          )}
        </div>
      )}
      {view.type === "list" && (
        <div className="record-list">
          {grouped
            ? groups.map((g) => (
                <section
                  key={g.key}
                  aria-label={t(`Gruppe ${g.label}`, `Group ${g.label}`)}
                  className="database-list-group"
                >
                  {groupHeader(g)}
                  {!collapsed(g.key) &&
                    nestedRows(g, (r, key) => listRow(r, key), false)}
                </section>
              ))
            : [
                ...shown.slice(0, rowLimit).map((r) => listRow(r)),
                shown.length > rowLimit && (
                  <MoreRows
                    key="more"
                    auto
                    remaining={shown.length - rowLimit}
                    onMore={() => setRowLimit((l) => l + ROW_STEP)}
                  />
                ),
              ]}
        </div>
      )}
      {view.type === "calendar" && (
        <DatabaseCalendar
          key={view.id}
          pageId={page.id}
          rows={shown}
          fields={fields}
          view={view}
          version={data.database.version}
          editable={editable}
          viewEditable={viewEditable}
          onOpen={(id, date) => setRowId(id, date)}
          onCreate={createRow}
          onView={updateView}
          onSchedule={(input) => mutate({ pageId: page.id, ...input })}
        />
      )}
      {view.type === "timeline" && (
        <DatabaseTimeline
          key={view.id}
          pageId={page.id}
          rows={shown}
          fields={fields}
          view={view}
          version={data.database.version}
          editable={editable}
          viewEditable={viewEditable}
          onOpen={setRowId}
          onView={updateView}
          onSchedule={(input) => mutate({ pageId: page.id, ...input })}
        />
      )}
      {view.type === "chart" && (
        <DatabaseChart
          key={view.id}
          view={view}
          version={data.database.version}
          fields={fields}
          rows={shown}
          related={related}
          members={members}
          editable={viewEditable}
          onOpenRow={setRowId}
          onSave={(chart, version) =>
            updateSchema(
              fields,
              data.database.views.map((v) =>
                v.id === view.id ? { ...v, chart } : v,
              ),
              undefined,
              version,
            )
          }
        />
      )}
      {view.type === "form" && (
        <DatabaseForm
          page={page}
          fields={fields}
          form={data.form}
          editable={editable}
          act={act}
          members={members}
          related={
            related as unknown as Record<
              string,
              { id: string; cells: { title: string } }[]
            >
          }
          upload={editable ? uploadFile : undefined}
        />
      )}
      {shown.length === 0 && view.type !== "form" && view.type !== "chart" && (
        <div className="empty-state">
          <Funnel size={30} />
          <h3>{t("Keine Einträge", "No records")}</h3>
          <p>
            {query || activeFilterCount
              ? t("Passe deine Suche oder Filter an.", "Adjust your search or filters.")
              : t("Füge deinen ersten Eintrag hinzu.", "Add your first record.")}
          </p>
        </div>
      )}
      <input
        type="file"
        accept=".csv"
        hidden
        ref={importRef}
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          const result = Papa.parse<Record<string, string>>(await f.text(), {
            header: true,
            skipEmptyLines: true,
          });
          if (result.errors.length) {
            onError(t("CSV konnte nicht gelesen werden.", "The CSV could not be read."));
            return;
          }
          const imported = result.data.map((row) =>
            Object.fromEntries(
              fields
                .filter((f) => !computedTypes.includes(f.type))
                .map((f) => [
                  f.id,
                  f.type === "number"
                    ? Number(row[f.name] || 0)
                    : f.type === "checkbox"
                      ? ["true", "1", "ja"].includes(
                          (row[f.name] || "").toLowerCase(),
                        )
                      : f.type === "multiselect"
                        ? (row[f.name] || "")
                            .split(",")
                            .map((s) => s.trim())
                            .filter(Boolean)
                        : row[f.name] || "",
                ]),
            ),
          );
          await act({ action: "rows.import", rows: imported });
          e.target.value = "";
        }}
      />
      {filterOpen && (
        <Modal
          open
          onClose={() => setFilterOpen(false)}
          title={t("Filter bearbeiten", "Edit filters")}
          wide
        >
          <DatabaseFilterEditor
            key={view.id}
            view={view}
            version={data.database.version}
            fields={fields}
            rows={data.rows}
            related={related}
            relatedSchemas={data.relatedSchemas}
            members={members}
            editable={viewEditable}
            onClose={() => setFilterOpen(false)}
            onSave={(filterGroup, version) =>
              updateSchema(
                fields,
                data.database.views.map((v) =>
                  v.id === view.id ? { ...v, filters: [], filterGroup } : v,
                ),
                undefined,
                version,
              )
            }
          />
        </Modal>
      )}
      <Modal
        open={config}
        onClose={() => setConfig(false)}
        title={t("Ansicht konfigurieren", "Configure view")}
      >
        <fieldset
          className="schema-settings"
          disabled={schemaBusy}
          aria-busy={schemaBusy}
        >
          <label>
            {t("Name", "Name")}
            <input
              defaultValue={view.name}
              disabled={!viewEditable}
              onBlur={(e) =>
                e.target.value &&
                e.target.value !== view.name &&
                updateView({ name: e.target.value })
              }
            />
          </label>
          {view.type === "feed" && (
            <div className="settings-section">
              <h3>{t("Feed-Darstellung", "Feed layout")}</h3>
              <label>
                {t("Dokumentinhalt", "Document content")}
                <Select
                  aria-label={t("Feed-Dokumentinhalt", "Feed document content")}
                  disabled={!viewEditable}
                  value={(view.feed || defaultFeed).content}
                  onChange={(e) =>
                    updateView({
                      feed: {
                        ...(view.feed || defaultFeed),
                        content: e.target.value as
                          "full" | "compact" | "hidden",
                      },
                    })
                  }
                >
                  <option value="full">{t("Vollständig anzeigen", "Show in full")}</option>
                  <option value="compact">{t("Kompakte Textvorschau", "Compact text preview")}</option>
                  <option value="hidden">{t("Ausblenden", "Hide")}</option>
                </Select>
              </label>
              {(
                [
                  ["showAuthor", t("Verfasser anzeigen", "Show author")],
                  ["showDate", t("Erstellungsdatum anzeigen", "Show creation date")],
                  ["showComments", t("Kommentaranzahl anzeigen", "Show comment count")],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="checkbox-label">
                  <input
                    type="checkbox"
                    disabled={!viewEditable}
                    checked={(view.feed || defaultFeed)[key]}
                    onChange={(e) =>
                      updateView({
                        feed: {
                          ...(view.feed || defaultFeed),
                          [key]: e.target.checked,
                        },
                      })
                    }
                  />
                  {label}
                </label>
              ))}
            </div>
          )}
          <div className="settings-section">
            <h3>{t("Filter", "Filters")}</h3>
            <p className="muted">
              {activeFilterCount
                ? t(`${activeFilterCount} Bedingungen aktiv`, `${activeFilterCount} conditions active`)
                : t("Keine Filter aktiv", "No filters active")}
            </p>
            <button
              className="button compact"
              onClick={() => {
                setConfig(false);
                setFilterOpen(true);
              }}
            >
              {t("Filter bearbeiten", "Edit filters")}
            </button>
          </div>
          <div className="settings-section">
            <h3>{t("Sortierung", "Sorting")}</h3>
            {view.sorts.map((s, i) => (
              <div className="filter-line" key={i}>
                <Select
                  value={s.field}
                  aria-label={t("Sortier-Eigenschaft", "Sort property")}
                  onChange={(e) =>
                    updateView({
                      sorts: view.sorts.map((x, j) =>
                        j === i ? { ...x, field: e.target.value } : x,
                      ),
                    })
                  }
                >
                  {fields.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </Select>
                <Select
                  value={s.direction}
                  aria-label={t("Sortierrichtung", "Sort direction")}
                  onChange={(e) =>
                    updateView({
                      sorts: view.sorts.map((x, j) =>
                        j === i
                          ? {
                              ...x,
                              direction: e.target.value as "asc" | "desc",
                            }
                          : x,
                      ),
                    })
                  }
                >
                  <option value="asc">{t("Aufsteigend", "Ascending")}</option>
                  <option value="desc">{t("Absteigend", "Descending")}</option>
                </Select>
                <button
                  className="icon-button"
                  aria-label={t("Sortierung entfernen", "Remove sorting")}
                  onClick={() =>
                    updateView({ sorts: view.sorts.filter((_, j) => i !== j) })
                  }
                >
                  <Trash />
                </button>
              </div>
            ))}
            <button
              className="button compact"
              onClick={() =>
                updateView({
                  sorts: [
                    ...view.sorts,
                    { field: fields[0].id, direction: "asc" },
                  ],
                })
              }
            >
              <Plus />
              {t("Sortierung hinzufügen", "Add sorting")}
            </button>
          </div>
          {view.type === "gallery" && (
            <fieldset
              disabled={!viewEditable || schemaBusy}
              className="gallery-settings"
            >
              <legend>{t("Galerie-Cover", "Gallery cover")}</legend>
              <label>
                {t("Bildquelle", "Image source")}
                <Select
                  aria-label={t("Galerie-Bildquelle", "Gallery image source")}
                  value={
                    galleryConfig.cover === "field"
                      ? `field:${galleryConfig.fieldId}`
                      : galleryConfig.cover
                  }
                  onChange={(event) =>
                    updateView({
                      gallery: {
                        ...galleryConfig,
                        cover: ["none", "document", "record"].includes(
                          event.target.value,
                        )
                          ? (event.target.value as
                              "none" | "document" | "record")
                          : "field",
                        fieldId: ["none", "document", "record"].includes(
                          event.target.value,
                        )
                          ? undefined
                          : event.target.value.slice(6),
                      },
                    })
                  }
                >
                  <option value="none">{t("Keine Bilder", "No images")}</option>
                  <option value="record">{t("Datensatz-Cover", "Record cover")}</option>
                  <option value="document">
                    {t("Erstes Bild im Eintragsinhalt", "First image in the record content")}
                  </option>
                  {fields
                    .filter((field) => field.type === "files")
                    .map((field) => (
                      <option key={field.id} value={`field:${field.id}`}>
                        {field.name}
                      </option>
                    ))}
                </Select>
              </label>
              <label>
                {t("Bilddarstellung", "Image display")}
                <Select
                  aria-label={t("Galerie-Bilddarstellung", "Gallery image display")}
                  value={galleryConfig.fit}
                  onChange={(event) =>
                    updateView({
                      gallery: {
                        ...galleryConfig,
                        fit: event.target.value as "cover" | "contain",
                      },
                    })
                  }
                >
                  <option value="cover">{t("Fläche ausfüllen", "Fill the area")}</option>
                  <option value="contain">{t("Ganzes Bild anzeigen", "Show the whole image")}</option>
                </Select>
              </label>
              <label>
                {t("Kartengröße", "Card size")}
                <Select
                  aria-label={t("Galerie-Kartengröße", "Gallery card size")}
                  value={galleryConfig.size}
                  onChange={(event) =>
                    updateView({
                      gallery: {
                        ...galleryConfig,
                        size: event.target.value as
                          "small" | "medium" | "large",
                      },
                    })
                  }
                >
                  <option value="small">{t("Klein", "Small")}</option>
                  <option value="medium">{t("Mittel", "Medium")}</option>
                  <option value="large">{t("Groß", "Large")}</option>
                </Select>
              </label>
            </fieldset>
          )}
          {view.type === "board" && groupField && (
            <BoardWipSettings
              key={`${view.id}-${groupField.id}`}
              columns={groups.map((g) => ({ key: g.key, label: g.label }))}
              wip={view.wip || {}}
              disabled={!viewEditable}
              onChange={(wip) => updateView({ wip })}
            />
          )}
          {view.type === "table" && subtaskParent && (
            <label className="checkbox-label">
              <input
                type="checkbox"
                disabled={!viewEditable}
                checked={!!view.tree}
                onChange={(e) => updateView({ tree: e.target.checked || undefined, ...(e.target.checked ? { groupBy: undefined, subGroupBy: undefined, groupLevels: undefined } : {}) })}
              />
              {t("Unteraufgaben als Baum zeigen", "Show subtasks as a tree")}
            </label>
          )}
          <label>
            {t("Gruppieren nach", "Group by")}
            <Select
              aria-label={t("Gruppieren nach", "Group by")}
              disabled={!viewEditable}
              value={view.groupBy || ""}
              onChange={(e) =>
                updateView({
                  groupBy: e.target.value,
                  ...(view.subGroupBy === e.target.value || !e.target.value
                    ? { subGroupBy: undefined, groupLevels: undefined }
                    : {}),
                  groupSettings: {
                    ...groupSettings,
                    collapsed: [],
                    order: [],
                  },
                })
              }
            >
              <option value="">
                {view.type === "board" ? t("Automatisch", "Automatic") : t("Keine Gruppierung", "No grouping")}
              </option>
              {fields.filter(canGroupField).map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </Select>
          </label>
          {groupField && ["table", "list", "board"].includes(view.type) && (
            <label>
              {view.type === "board" ? t("Swimlanes nach", "Swimlanes by") : t("Untergruppen nach", "Sub-groups by")}
              <Select
                aria-label={
                  view.type === "board" ? t("Swimlanes nach", "Swimlanes by") : t("Untergruppen nach", "Sub-groups by")
                }
                disabled={!viewEditable}
                value={subField?.id || ""}
                onChange={(e) =>
                  updateView({
                    subGroupBy: e.target.value || undefined,
                    ...(!e.target.value ||
                    view.groupLevels?.includes(e.target.value)
                      ? { groupLevels: undefined }
                      : {}),
                    groupSettings: {
                      ...groupSettings,
                      // Subgroup collapse keys are only meaningful per field.
                      collapsed: groupSettings.collapsed.filter(
                        (key) => !key.startsWith('["sub"'),
                      ),
                    },
                  })
                }
              >
                <option value="">
                  {view.type === "board"
                    ? t("Keine Swimlanes", "No swimlanes")
                    : t("Keine Untergruppen", "No sub-groups")}
                </option>
                {fields
                  .filter((f) => canGroupField(f) && f.id !== groupField!.id)
                  .map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
              </Select>
            </label>
          )}
          {subField &&
            ["table", "list", "board"].includes(view.type) &&
            Array.from(
              { length: Math.min(3, deeperFields.length + 1) },
              (_, i) => {
                const used = new Set([
                  groupField!.id,
                  subField.id,
                  ...deeperFields.slice(0, i).map((f) => f.id),
                ]);
                const label = t(`Gruppenebene ${i + 3}`, `Group level ${i + 3}`);
                return (
                  <label key={label}>
                    {view.type === "board"
                      ? t(`Abschnitte (Ebene ${i + 3})`, `Sections (level ${i + 3})`)
                      : label}
                    <Select
                      aria-label={label}
                      disabled={!viewEditable}
                      value={deeperFields[i]?.id || ""}
                      onChange={(e) =>
                        updateView({
                          groupLevels: [
                            ...deeperFields.slice(0, i).map((f) => f.id),
                            ...(e.target.value ? [e.target.value] : []),
                          ],
                          groupSettings: {
                            ...groupSettings,
                            // Keys below the subgroups belong to the old levels.
                            collapsed: groupSettings.collapsed.filter((key) => {
                              try {
                                const parts = JSON.parse(key);
                                return !(
                                  Array.isArray(parts) &&
                                  parts[0] === "sub" &&
                                  parts.length > 3 + i
                                );
                              } catch {
                                return true;
                              }
                            }),
                          },
                        })
                      }
                    >
                      <option value="">{t("Keine weitere Ebene", "No further level")}</option>
                      {fields
                        .filter((f) => canGroupField(f) && !used.has(f.id))
                        .map((f) => (
                          <option key={f.id} value={f.id}>
                            {f.name}
                          </option>
                        ))}
                    </Select>
                  </label>
                );
              },
            )}
          {groupField && ["table", "list", "board"].includes(view.type) && (
            <div className="settings-section">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  disabled={!viewEditable}
                  checked={groupSettings.hideEmpty}
                  onChange={(e) =>
                    updateView({
                      groupSettings: {
                        ...groupSettings,
                        hideEmpty: e.target.checked,
                      },
                    })
                  }
                />
                {t("Leere Gruppen ausblenden", "Hide empty groups")}
              </label>
              <label>
                {t("Gruppen sortieren", "Sort groups")}
                <Select
                  aria-label={t("Gruppen sortieren", "Sort groups")}
                  disabled={!viewEditable}
                  value={groupSettings.sort}
                  onChange={(e) =>
                    updateView({
                      groupSettings: {
                        ...groupSettings,
                        sort: e.target.value as "manual" | "asc" | "desc",
                      },
                    })
                  }
                >
                  <option value="manual">
                    {groupSettings.order?.length
                      ? t("Eigene Reihenfolge", "Custom order")
                      : t("Eigenschaftsreihenfolge", "Property order")}
                  </option>
                  <option value="asc">{t("Bezeichnung aufsteigend", "Label ascending")}</option>
                  <option value="desc">{t("Bezeichnung absteigend", "Label descending")}</option>
                </Select>
              </label>
              {!!groupSettings.order?.length && (
                <button
                  className="button compact"
                  disabled={!viewEditable || schemaBusy}
                  onClick={() =>
                    updateView({
                      groupSettings: { ...groupSettings, order: [] },
                    })
                  }
                >
                  {t("Gruppenreihenfolge zurücksetzen", "Reset group order")}
                </button>
              )}
            </div>
          )}
          <label>
            {t("Datumsfeld", "Date field")}
            <Select
              value={view.dateField || ""}
              onChange={(e) => updateView({ dateField: e.target.value })}
            >
              <option value="">{t("Automatisch", "Automatic")}</option>
              {fields
                .filter((f) => f.type === "date")
                .map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
            </Select>
          </label>
          <label>
            {t("Enddatum", "End date")}
            <Select
              value={view.endDateField || ""}
              onChange={(e) => updateView({ endDateField: e.target.value })}
            >
              <option value="">{t("Kein Enddatum", "No end date")}</option>
              {fields
                .filter((f) => f.type === "date")
                .map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
            </Select>
          </label>
          <div className="settings-section">
            <h3>{t("Eigenschaften und Spalten", "Properties and columns")}</h3>
            {orderedFields.map((f, index) => (
              <div className="property-order" key={f.id}>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    disabled={!viewEditable}
                    checked={!view.hiddenFields?.includes(f.id)}
                    onChange={(e) =>
                      updateView({
                        hiddenFields: e.target.checked
                          ? (view.hiddenFields || []).filter((x) => x !== f.id)
                          : [...(view.hiddenFields || []), f.id],
                      })
                    }
                  />
                  {f.name}
                </label>
                <button
                  className="icon-button"
                  aria-label={t(`${f.name} nach oben`, `${f.name} up`)}
                  disabled={!viewEditable || index === 0}
                  onClick={() => moveColumn(f.id, orderedFields[index - 1].id)}
                >
                  ↑
                </button>
                <button
                  className="icon-button"
                  aria-label={t(`${f.name} nach unten`, `${f.name} down`)}
                  disabled={!viewEditable || index === orderedFields.length - 1}
                  onClick={() => moveColumn(orderedFields[index + 1].id, f.id)}
                >
                  ↓
                </button>
                {view.type === "table" && (
                  <input
                    type="number"
                    className="column-width-input"
                    aria-label={t(`${f.name} Breite in Pixeln`, `${f.name} width in pixels`)}
                    min={80}
                    max={800}
                    disabled={!viewEditable}
                    key={`${f.id}-${view.columnWidths?.[f.id]}`}
                    defaultValue={columnWidth(f)}
                    onBlur={(e) => {
                      const width = Number(e.target.value);
                      if (
                        width >= 80 &&
                        width <= 800 &&
                        width !== columnWidth(f)
                      )
                        void updateView({
                          columnWidths: {
                            ...view.columnWidths,
                            [f.id]: Math.round(width),
                          },
                        });
                    }}
                  />
                )}
              </div>
            ))}
          </div>
          {viewEditable && data.database.views.length > 1 && (
            <button
              className="button danger"
              onClick={async () => {
                await updateSchema(
                  fields,
                  data.database.views.filter((v) => v.id !== view.id),
                );
                setConfig(false);
              }}
            >
              {t("Ansicht löschen", "Delete view")}
            </button>
          )}
        </fieldset>
      </Modal>
      <Modal
        open={bulk !== null}
        onClose={() => {
          if (!bulkBusy) setBulk(null);
        }}
        title={
          bulk === "delete"
            ? t("Einträge löschen", "Delete records")
            : t("Einträge gemeinsam bearbeiten", "Edit records together")
        }
      >
        <p>
          {selectionRows.length} {t("ausgewählte Einträge. Vor der Änderung wird eine Datenbankversion gesichert.", "selected records. A database version is saved before the change.")}
        </p>
        {bulk === "update" && (
          <>
            <label>
              {t("Eigenschaft", "Property")}
              <Select
                aria-label={t("Eigenschaft", "Property")}
                value={bulkField}
                onChange={(e) => {
                  setBulkField(e.target.value);
                  setBulkValue(undefined);
                }}
              >
                {fields
                  .filter((f) => !computedTypes.includes(f.type))
                  .map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
              </Select>
            </label>
            {fields.find((f) => f.id === bulkField) && (
              <label>
                {t("Neuer Wert", "New value")}
                <CellInput
                  key={bulkField}
                  field={fields.find((f) => f.id === bulkField)!}
                  value={bulkValue}
                  members={members}
                  related={related}
                  onChange={setBulkValue}
                  upload={editable ? uploadFile : undefined}
                  files={data.files}
                />
              </label>
            )}
          </>
        )}
        <button
          className={`button ${bulk === "delete" ? "danger" : "primary"}`}
          disabled={bulkBusy || (bulk === "update" && bulkValue === undefined)}
          onClick={(e) => {
            const invalid = e.currentTarget
              .closest('[role="dialog"]')
              ?.querySelector<HTMLInputElement>("input:invalid");
            if (invalid) {
              invalid.reportValidity();
              return;
            }
            void bulkAction(bulk === "delete" ? "delete" : "update");
          }}
        >
          {bulkBusy
            ? t("Wird gespeichert …", "Saving …")
            : bulk === "delete"
              ? t("Einträge löschen", "Delete records")
              : t("Änderung anwenden", "Apply change")}
        </button>
      </Modal>
      <p role="status" className="sr-only">
        {orderStatus}
      </p>
      <Modal
        open={!!moveDialog}
        onClose={() => setMoveDialog(null)}
        title={t("Eintrag verschieben", "Move record")}
      >
        <p>
          „
          {moveRow
            ? cellText(moveRow.cells[fields[0].id]) || t("Ohne Titel", "Untitled")
            : t("Eintrag", "Record")}
          {t("“ in Ansicht „", "” in view “")}{view.name}“ anordnen.
        </p>
        <p className="muted">
          {t("Die Reihenfolge gilt für diese Ansicht. Ausgeblendete Einträge behalten ihre relative Reihenfolge.", "The order applies to this view. Hidden records keep their relative order.")}
        </p>
        <div className="row-move-actions">
          <button
            className="button"
            disabled={orderBusy || !moveRow || moveIndex <= 0}
            onClick={() =>
              moveRow &&
              moveTo(
                moveRow,
                moveSiblings[0]?.id,
                "before",
                moveDialog?.groupKey,
              )
            }
          >
            {t("An den Anfang", "To the top")}
          </button>
          <button
            className="button"
            disabled={orderBusy || !moveRow || moveIndex <= 0}
            onClick={() =>
              moveRow &&
              moveTo(
                moveRow,
                moveSiblings[moveIndex - 1]?.id,
                "before",
                moveDialog?.groupKey,
              )
            }
          >
            {t("Nach oben", "Up")}
          </button>
          <button
            className="button"
            disabled={
              orderBusy ||
              !moveRow ||
              moveIndex < 0 ||
              moveIndex === moveSiblings.length - 1
            }
            onClick={() =>
              moveRow &&
              moveTo(
                moveRow,
                moveSiblings[moveIndex + 1]?.id,
                "after",
                moveDialog?.groupKey,
              )
            }
          >
            {t("Nach unten", "Down")}
          </button>
          <button
            className="button"
            disabled={
              orderBusy ||
              !moveRow ||
              moveIndex < 0 ||
              moveIndex === moveSiblings.length - 1
            }
            onClick={() =>
              moveRow &&
              moveTo(
                moveRow,
                moveSiblings.at(-1)?.id,
                "after",
                moveDialog?.groupKey,
              )
            }
          >
            {t("Ans Ende", "To the end")}
          </button>
        </div>
        <label>
          {t("Position", "Position")}
          <Select
            aria-label={t("Verschiebeposition", "Move position")}
            value={movePlacement}
            onChange={(e) =>
              setMovePlacement(e.target.value as "before" | "after")
            }
          >
            <option value="before">{t("Vor dem Eintrag", "Before the record")}</option>
            <option value="after">{t("Nach dem Eintrag", "After the record")}</option>
          </Select>
        </label>
        <label>
          {t("Bezugseintrag", "Reference record")}
          <Select
            aria-label={t("Bezugseintrag", "Reference record")}
            value={moveTarget}
            onChange={(e) => setMoveTarget(e.target.value)}
          >
            <option value="">{t("Eintrag auswählen …", "Choose record …")}</option>
            {moveSiblings
              .filter((r) => r.id !== moveRow?.id)
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {cellText(r.cells[fields[0].id]) || t("Ohne Titel", "Untitled")}
                </option>
              ))}
          </Select>
        </label>
        <div className="modal-actions">
          <button
            className="button primary"
            disabled={orderBusy || !moveRow || !moveTarget}
            onClick={() =>
              moveRow &&
              moveTo(moveRow, moveTarget, movePlacement, moveDialog?.groupKey)
            }
          >
            {t("Hierhin verschieben", "Move here")}
          </button>
        </div>
      </Modal>
      <Modal
        open={!!sortMove}
        onClose={() => setSortMove(null)}
        title={t("Sortierung aufheben?", "Remove sorting?")}
      >
        <p>
          {t("Diese Ansicht wird automatisch sortiert. Zum manuellen Verschieben werden ihre Sortierregeln aufgehoben. Die bisherige Sortierung wird als Ausgangsreihenfolge gespeichert.", "This view is sorted automatically. Moving by hand removes its sorting rules. The current sorting is saved as the starting order.")}
        </p>
        <div className="modal-actions">
          <button
            className="button"
            disabled={orderBusy}
            onClick={() => setSortMove(null)}
          >
            {t("Abbrechen", "Cancel")}
          </button>
          <button
            className="button primary"
            disabled={orderBusy}
            onClick={() => sortMove && submitMove(sortMove, true)}
          >
            {t("Sortierung aufheben und verschieben", "Remove sorting and move")}
          </button>
        </div>
      </Modal>
      <Modal
        open={newField}
        onClose={() => setNewField(false)}
        title={
          fields.some((f) => f.id === fieldDraft.id)
            ? t("Eigenschaft bearbeiten", "Edit property")
            : t("Eigenschaft hinzufügen", "Add property")
        }
      >
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (
              !editable ||
              !allowFieldChanges ||
              schemaBusy ||
              (relationChanged && !relationReady)
            )
              return;
            if (formulaProblem || formulaTooLong) {
              setFieldError(
                formulaProblem?.message ||
                  t("Die Formel enthält zu viele Eigenschaftsbezüge.", "The formula contains too many property references."),
              );
              return;
            }
            setFieldError("");
            const {
              bidirectional: _bidirectional,
              inverseName: _inverseName,
              ...draft
            } = fieldDraft;
            if (draft.type === "formula")
              draft.formula = rewriteFormulaReferences(
                draft.formula || "",
                formulaFields,
                "store",
              );
            const next = fields.some((f) => f.id === fieldDraft.id)
              ? fields.map((f) => (f.id === fieldDraft.id ? draft : f))
              : [...fields, draft];
            const r = await updateSchema(
              next,
              undefined,
              relationChanged
                ? {
                    fieldId: draft.id,
                    enabled: bidirectional,
                    name:
                      fieldDraft.inverseName?.trim() ||
                      page.title.slice(0, 100),
                    targetVersion: relationTarget?.version,
                  }
                : undefined,
              fieldVersion,
            );
            if (r) setNewField(false);
            else
              setFieldError(
                t("Die Eigenschaft konnte nicht gespeichert werden. Dein Entwurf bleibt erhalten.", "The property could not be saved. Your draft is kept."),
              );
          }}
        >
          <label>
            {t("Name", "Name")}
            <input
              required
              autoFocus
              aria-label={t("Eigenschaftsname", "Property name")}
              value={fieldDraft.name}
              disabled={!editable || !allowFieldChanges || schemaBusy}
              onChange={(e) =>
                setFieldDraft((f) => ({ ...f, name: e.target.value }))
              }
            />
          </label>
          <label>
            {t("Typ", "Type")}
            <Select
              aria-label={t("Eigenschaftstyp", "Property type")}
              value={fieldDraft.parent ? "@parent" : fieldDraft.type}
              disabled={
                !editable || !allowFieldChanges || schemaBusy || !!relationPair
              }
              onChange={(e) =>
                setFieldDraft((f) =>
                  e.target.value === "@parent"
                    ? { ...f, type: "relation", parent: true, relationPage: page.id }
                    : {
                        ...f,
                        type: e.target.value as FieldType,
                        parent: undefined,
                        ...(e.target.value === "id" && !f.prefix ? { prefix: suggestedPrefix(page.title) } : {}),
                      },
                )
              }
            >
              {Object.entries(fieldNames).map(([k, n]) => (
                <option key={k} value={k}>
                  {t(n[0], n[1])}
                </option>
              ))}
              <option value="@parent">{t("Übergeordneter Eintrag (Unteraufgaben)", "Parent record (subtasks)")}</option>
            </Select>
          </label>
          {fieldDraft.type === "id" && (
            <label>
              {t("Präfix", "Prefix")}
              <input
                required
                maxLength={10}
                pattern="[A-Z][A-Z0-9]{0,9}"
                aria-describedby="ticket-prefix-hint"
                value={fieldDraft.prefix || ""}
                onChange={(e) =>
                  setFieldDraft((f) => ({ ...f, prefix: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") }))
                }
              />
              <small id="ticket-prefix-hint" className="muted">
                {t(
                  `Jeder Eintrag bekommt automatisch eine Nummer wie ${fieldDraft.prefix || "WEB"}-123. Im Text wird sie zum Link, in Git-Commits zur Referenz.`,
                  `Every record automatically gets a number like ${fieldDraft.prefix || "WEB"}-123. In text it becomes a link, in Git commits a reference.`,
                )}
              </small>
            </label>
          )}
          {["select", "multiselect"].includes(fieldDraft.type) && (
            <label>
              {t("Optionen, durch Komma getrennt", "Options, separated by commas")}
              <input
                value={fieldDraft.options?.join(", ") || ""}
                onChange={(e) =>
                  setFieldDraft((f) => ({
                    ...f,
                    options: e.target.value.split(",").map((s) => s.trim()),
                  }))
                }
              />
            </label>
          )}
          {(fieldDraft.type === "number" || fieldDraft.type === "formula") && (
            <label>
              {t("Format", "Format")}
              <Select
                aria-label={t("Zahlenformat", "Number format")}
                value={fieldDraft.format || ""}
                onChange={(e) =>
                  setFieldDraft((f) => ({ ...f, format: e.target.value }))
                }
              >
                {Object.entries(numberFormats).map(([key, label]) => (
                  <option key={key} value={key}>
                    {t(label)}
                  </option>
                ))}
              </Select>
            </label>
          )}
          {fieldDraft.type === "number" && (
            <>
              <label>
                {t("Nachkommastellen", "Decimal places")}
                <Select
                  aria-label={t("Nachkommastellen", "Decimal places")}
                  value={fieldDraft.decimals ?? ""}
                  onChange={(e) =>
                    setFieldDraft((f) => ({
                      ...f,
                      decimals:
                        e.target.value === ""
                          ? undefined
                          : Number(e.target.value),
                    }))
                  }
                >
                  <option value="">{t("Automatisch", "Automatic")}</option>
                  {[0, 1, 2, 3, 4, 5, 6].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </Select>
              </label>
              <label>
                {t("Darstellung", "Display")}
                <Select
                  aria-label={t("Zahlendarstellung", "Number display")}
                  value={fieldDraft.rollupDisplay || "number"}
                  onChange={(e) =>
                    setFieldDraft((f) => {
                      const display = e.target.value as Field["rollupDisplay"];
                      // Stars start at five unless a small maximum exists.
                      return {
                        ...f,
                        rollupDisplay: display,
                        ...(display === "rating" && (f.rollupMax || 0) > 10
                          ? { rollupMax: 5 }
                          : {}),
                      };
                    })
                  }
                >
                  <option value="number">{t("Zahl", "Number")}</option>
                  <option value="bar">{t("Fortschrittsbalken", "Progress bar")}</option>
                  <option value="ring">{t("Fortschrittsring", "Progress ring")}</option>
                  <option value="rating">{t("Bewertung (Sterne)", "Rating (stars)")}</option>
                </Select>
              </label>
              {fieldDraft.rollupDisplay === "rating" && (
                <label>
                  {t("Anzahl Sterne", "Number of stars")}
                  <input
                    aria-label={t("Anzahl Sterne", "Number of stars")}
                    type="number"
                    min="1"
                    max="10"
                    step="1"
                    required
                    value={ratingMax(fieldDraft)}
                    onChange={(e) =>
                      setFieldDraft((f) => ({
                        ...f,
                        rollupMax: Math.min(
                          10,
                          Math.max(1, Math.round(Number(e.target.value) || 5)),
                        ),
                      }))
                    }
                  />
                </label>
              )}
              {fieldDraft.rollupDisplay &&
                fieldDraft.rollupDisplay !== "number" &&
                fieldDraft.rollupDisplay !== "rating" && (
                  <label>
                    {t("Zielwert", "Target value")}
                    <input
                      aria-label={t("Zielwert", "Target value")}
                      type="number"
                      min="0.000001"
                      step="any"
                      required
                      value={fieldDraft.rollupMax || 100}
                      onChange={(e) =>
                        setFieldDraft((f) => ({
                          ...f,
                          rollupMax: Number(e.target.value),
                        }))
                      }
                    />
                  </label>
                )}
            </>
          )}
          {fieldDraft.type === "date" && (
            <>
              <label>
                {t("Datumsformat", "Date format")}
                <Select
                  aria-label={t("Datumsformat", "Date format")}
                  value={fieldDraft.format || ""}
                  onChange={(e) =>
                    setFieldDraft((f) => ({ ...f, format: e.target.value }))
                  }
                >
                  {Object.entries(dateFormats).map(([key, label]) => (
                    <option key={key} value={key}>
                      {t(label)}
                    </option>
                  ))}
                </Select>
              </label>
              <label>
                {t("Zeitformat", "Time format")}
                <Select
                  aria-label={t("Zeitformat", "Time format")}
                  value={fieldDraft.timeFormat || "24"}
                  onChange={(e) =>
                    setFieldDraft((f) => ({
                      ...f,
                      timeFormat: e.target.value as "24" | "12",
                    }))
                  }
                >
                  {Object.entries(timeFormats).map(([key, label]) => (
                    <option key={key} value={key}>
                      {t(label)}
                    </option>
                  ))}
                </Select>
              </label>
            </>
          )}
          {fieldDraft.type === "formula" && (
            <FormulaEditor
              field={fieldDraft}
              fields={fields}
              rows={data.rows}
              related={related}
              schemas={data.relatedSchemas || {}}
              disabled={!editable || !allowFieldChanges || schemaBusy}
              onChange={(formula) => setFieldDraft((f) => ({ ...f, formula }))}
            />
          )}
          {fieldDraft.parent && (
            <p className="muted">
              {t(
                "Einträge können unter einem anderen Eintrag dieser Datenbank stehen – Epic, Story, Aufgabe. Tabellen zeigen sie als Baum, Boards als Swimlanes, der Fortschritt läuft nach oben.",
                "Records can sit below another record of this database – epic, story, task. Tables show them as a tree, boards as swimlanes, progress rolls up.",
              )}
            </p>
          )}
          {fieldDraft.type === "time" && (
            <label>
              {t("Schätzung aus (optional)", "Estimate from (optional)")}
              <Select
                aria-label={t("Eigenschaft mit der Schätzung in Stunden", "Property with the estimate in hours")}
                value={fieldDraft.estimateField || ""}
                onChange={(e) => setFieldDraft((f) => ({ ...f, estimateField: e.target.value || undefined }))}
              >
                <option value="">{t("Keine Schätzung", "No estimate")}</option>
                {fields
                  .filter((f) => f.type === "number")
                  .map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
              </Select>
              <small className="muted">
                {t("Start/Stopp und Nachtragen im Eintrag; Auswertung über das Menü „…“.", "Start/stop and adding time in the record; report in the “…” menu.")}
              </small>
            </label>
          )}
          {fieldDraft.type === "progress" && (
            <p className="muted">
              {fields.some((f) => f.parent)
                ? t("Zeigt, wie viel der Unteraufgaben erledigt ist (über alle Ebenen).", "Shows how much of the subtasks is done (across all levels).")
                : t("Lege zuerst eine Eigenschaft „Übergeordneter Eintrag“ an.", "First add a “Parent record” property.")}
            </p>
          )}
          {fieldDraft.type === "relation" && !fieldDraft.parent && (
            <>
              <label>
                {t("Verknüpfte Datenbank", "Linked database")}
                <Select
                  aria-label={t("Verknüpfte Datenbank", "Linked database")}
                  required
                  value={fieldDraft.relationPage || ""}
                  disabled={!editable || !allowFieldChanges || !!relationPair}
                  onChange={(e) =>
                    setFieldDraft((f) => ({
                      ...f,
                      relationPage: e.target.value,
                    }))
                  }
                >
                  <option value="">{t("Auswählen …", "Select …")}</option>
                  {pages
                    .filter((p) => p.kind === "database" && !p.deleted_at)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.title}
                      </option>
                    ))}
                </Select>
              </label>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={bidirectional}
                  disabled={
                    !editable || !allowFieldChanges || !fieldDraft.relationPage
                  }
                  onChange={(e) =>
                    setFieldDraft((f) => ({
                      ...f,
                      bidirectional: e.target.checked,
                    }))
                  }
                />
                {t("Bidirektional verknüpfen", "Link in both directions")}
              </label>
              {bidirectional && !relationPair && (
                <label>
                  {t("Name der Rückrelation", "Name of the reverse relation")}
                  <input
                    aria-label={t("Name der Rückrelation", "Name of the reverse relation")}
                    maxLength={100}
                    value={fieldDraft.inverseName ?? page.title.slice(0, 100)}
                    onChange={(e) =>
                      setFieldDraft((f) => ({
                        ...f,
                        inverseName: e.target.value,
                      }))
                    }
                  />
                  <small>
                    {t("Eine neue Eigenschaft in der Zieldatenbank zeigt die zugehörigen Einträge. Änderungen werden in beide Richtungen übernommen.", "A new property in the target database shows the related records. Changes apply in both directions.")}
                  </small>
                </label>
              )}
              {relationPair && (
                <p className="muted">
                  {t("Verknüpft mit „", "Linked with “")}{inverseName || t("Rückrelation", "Reverse relation")}{t("“. Beim Deaktivieren oder Löschen bleiben die andere Eigenschaft und ihre Werte erhalten. Zum Ändern des Typs oder Ziels zuerst deaktivieren und speichern.", "”. When disabling or deleting, the other property and its values stay. To change the type or target, disable and save first.")}
                </p>
              )}
              {relationChanged && (
                <p role="status" className="muted">
                  {serverMessage(relationTarget?.error) ||
                    (!relationReady
                      ? t("Berechtigungen werden geprüft …", "Checking permissions …")
                      : t("Bearbeitungsrechte für beide Datenbanken vorhanden.", "Edit rights for both databases are present."))}
                </p>
              )}
            </>
          )}
          {fieldDraft.type === "rollup" && (
            <>
              <label>
                Relation
                <Select
                  aria-label={t("Rollup-Relation", "Rollup relation")}
                  required
                  value={fieldDraft.relationField || ""}
                  onChange={(e) =>
                    setFieldDraft((f) => ({
                      ...f,
                      relationField: e.target.value,
                      rollupField: "",
                      aggregate: "count",
                    }))
                  }
                >
                  <option value="">{t("Auswählen …", "Select …")}</option>
                  {fields
                    .filter((f) => f.type === "relation")
                    .map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                </Select>
              </label>
              <label>
                {t("Eigenschaft", "Property")}
                <Select
                  aria-label={t("Rollup-Eigenschaft", "Rollup property")}
                  value={fieldDraft.rollupField || ""}
                  onChange={(e) =>
                    setFieldDraft((f) => ({
                      ...f,
                      rollupField: e.target.value,
                      aggregate: "count",
                    }))
                  }
                >
                  <option value="">{t("Nur verknüpfte Einträge zählen", "Only linked records count")}</option>
                  {rollupFields.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name} · {t(...fieldNames[f.type])}
                    </option>
                  ))}
                </Select>
                {rollupRelation && !rollupFields.length && (
                  <small>{t("Die verknüpfte Datenbank ist nicht zugänglich.", "The linked database is not accessible.")}</small>
                )}
              </label>
              <label>
                {t("Berechnung", "Calculation")}
                <Select
                  aria-label={t("Rollup-Berechnung", "Rollup calculation")}
                  value={fieldDraft.aggregate || "count"}
                  onChange={(e) =>
                    setFieldDraft((f) => ({
                      ...f,
                      aggregate: e.target.value as Field["aggregate"],
                      rollupDisplay: "number",
                    }))
                  }
                >
                  {allowedAggregates(rollupProperty).map((a) => (
                    <option key={a} value={a}>
                      {t(aggregateNames[a])}
                    </option>
                  ))}
                </Select>
              </label>
              {![
                "show_original",
                "show_unique",
                "earliest_date",
                "latest_date",
              ].includes(fieldDraft.aggregate || "count") && (
                <>
                  <label>
                    {t("Darstellung", "Display")}
                    <Select
                      aria-label={t("Rollup-Darstellung", "Rollup display")}
                      value={fieldDraft.rollupDisplay || "number"}
                      onChange={(e) =>
                        setFieldDraft((f) => ({
                          ...f,
                          rollupDisplay: e.target
                            .value as Field["rollupDisplay"],
                        }))
                      }
                    >
                      <option value="number">{t("Zahl", "Number")}</option>
                      <option value="bar">{t("Fortschrittsbalken", "Progress bar")}</option>
                      <option value="ring">{t("Fortschrittsring", "Progress ring")}</option>
                    </Select>
                  </label>
                  {fieldDraft.rollupDisplay &&
                    fieldDraft.rollupDisplay !== "number" &&
                    !percentAggregate(fieldDraft.aggregate) && (
                      <label>
                        {t("Zielwert", "Target value")}
                        <input
                          aria-label={t("Rollup-Zielwert", "Rollup target value")}
                          type="number"
                          min="0.000001"
                          step="any"
                          required
                          value={fieldDraft.rollupMax || 100}
                          onChange={(e) =>
                            setFieldDraft((f) => ({
                              ...f,
                              rollupMax: Number(e.target.value),
                            }))
                          }
                        />
                      </label>
                    )}
                </>
              )}
            </>
          )}
          {(fieldError || fieldVersion !== data.database.version) && (
            <p role="alert" className="error">
              {fieldVersion !== data.database.version
                ? t("Die Datenbank wurde zwischenzeitlich geändert. Dein Entwurf bleibt erhalten. Schließe den Dialog und öffne die Eigenschaft erneut, um den aktuellen Stand zu bearbeiten.", "The database was changed in the meantime. Your draft is kept. Close the dialog and open the property again to edit the current state.")
                : fieldError}
            </p>
          )}
          {editable && allowFieldChanges && (
            <div className="modal-actions">
              {fields.some((f) => f.id === fieldDraft.id) &&
                fields[0].id !== fieldDraft.id && (
                  <button
                    type="button"
                    className="button danger"
                    disabled={schemaBusy}
                    onClick={async () => {
                      const result = await updateSchema(
                        fields.filter((f) => f.id !== fieldDraft.id),
                        undefined,
                        undefined,
                        fieldVersion,
                      );
                      if (result) setNewField(false);
                      else
                        setFieldError(
                          t("Die Eigenschaft konnte nicht gelöscht werden. Dein Entwurf bleibt erhalten.", "The property could not be deleted. Your draft is kept."),
                        );
                    }}
                  >
                    {t("Löschen", "Delete")}
                  </button>
                )}
              <button
                className="button primary"
                disabled={
                  schemaBusy ||
                  (relationChanged && !relationReady) ||
                  !!formulaProblem ||
                  formulaTooLong
                }
              >
                {t("Speichern", "Save")}
              </button>
            </div>
          )}
        </form>
      </Modal>
      {calculationEdit && (
        <CalculationEditor
          field={calculationEdit.field}
          initial={calculationEdit.choice}
          rows={shown}
          version={calculationEdit.version}
          currentVersion={data.database.version}
          editable={viewEditable}
          onClose={() => setCalculationEdit(null)}
          onSave={async (choice) => {
            if (!viewEditable || schemaBusy) return null;
            const target = data.database.views.find(
              (v) => v.id === calculationEdit.viewId,
            );
            if (!target)
              throw new Error(t("Diese Ansicht ist nicht mehr verfügbar.", "This view is no longer available."));
            const calculations = {
              ...target.calculations,
              ...(choice === undefined
                ? {}
                : { [calculationEdit.field.id]: choice }),
            };
            if (choice === undefined)
              delete calculations[calculationEdit.field.id];
            return updateSchema(
              fields,
              data.database.views.map((v) =>
                v.id === target.id ? { ...v, calculations } : v,
              ),
              undefined,
              calculationEdit.version,
            );
          }}
        />
      )}
      <Modal
        open={newView}
        onClose={() => setNewView(false)}
        title={t("Ansicht hinzufügen", "Add view")}
      >
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const vid = crypto.randomUUID();
            const r = await updateSchema(fields, [
              ...data.database.views,
              {
                id: vid,
                name: viewName,
                type: viewType,
                filters: [],
                sorts: [],
              },
            ]);
            if (r) {
              setViewId(vid);
              setNewView(false);
            }
          }}
        >
          <label>
            {t("Name", "Name")}
            <input
              required
              autoFocus
              value={viewName}
              onChange={(e) => setViewName(e.target.value)}
            />
          </label>
          <label>
            {t("Darstellung", "Display")}
            <Select
              value={viewType}
              onChange={(e) => setViewType(e.target.value as View["type"])}
            >
              {Object.keys(viewIcons).map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </label>
          <button className="button primary">{t("Ansicht erstellen", "Create view")}</button>
        </form>
      </Modal>
      <Modal
        open={manageTemplates}
        onClose={() => setManageTemplates(false)}
        title={t("Datensatzvorlagen", "Record templates")}
      >
        <p className="muted">
          {t("Speichere einen Eintrag mit seinen Eigenschaften und Inhalten als Vorlage.", "Save a record with its properties and content as a template.")}
        </p>
        <button
          className="button"
          onClick={() => {
            setManageTemplates(false);
            void createRow({}, true, null);
          }}
        >
          {t("Leeren Eintrag erstellen", "Create empty record")}
        </button>
        {data.rowTemplates?.map((template) => (
          <div className="row-template-item" key={template.id}>
            <strong>{template.name}</strong>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={!!template.is_default}
                onChange={(e) =>
                  act({
                    action: "row.template.default",
                    templateId: template.id,
                    enabled: e.target.checked,
                  })
                }
              />
              {t("Standardvorlage", "Default template")}
            </label>
            <div>
              <button
                className="button compact"
                onClick={() => {
                  setManageTemplates(false);
                  void createRow({}, true, template.id);
                }}
              >
                {t("Verwenden", "Use")}
              </button>
              <button
                className="icon-button danger"
                title={t(`Vorlage ${template.name} löschen`, `Delete template ${template.name}`)}
                onClick={() =>
                  act({ action: "row.template.delete", templateId: template.id })
                }
              >
                <Trash />
              </button>
            </div>
          </div>
        ))}
      </Modal>
      <Modal
        open={!!selected}
        onClose={() => setRowId(null)}
        title={t("Eintrag", "Record")}
        wide
        actions={selected && recordActions(selected)}
        className={
          recordMode === "full"
            ? "modal-full"
            : recordMode === "side"
              ? "modal-side"
              : recordLayout.properties === "side"
                ? "modal-record-wide"
                : ""
        }
      >
        {selected && (
          <div className="row-detail">
            {occurrence?.rowId === selected.id &&
              parseRecurrence(selected.recurrence) && (
                <div className="occurrence-banner" role="status">
                  <span>
                    {t("Termin am", "Occurrence on")}{" "}
                    {new Date(`${occurrence.date}T00:00:00`).toLocaleDateString(
                      LOCALE_TAG,
                      {
                        weekday: "short",
                        day: "numeric",
                        month: "long",
                        year: "numeric",
                      },
                    )}{" "}
                    {t("aus einer Serie. Änderungen hier gelten für alle Termine.", "from a series. Changes here apply to all occurrences.")}
                  </span>
                  {selectedEditable && (
                    <span className="occurrence-actions">
                      {(
                        [
                          ["single", t("Nur diesen Termin bearbeiten", "Edit only this occurrence")],
                          ["following", t("Diesen und alle folgenden", "This and all following")],
                        ] as const
                      ).map(([mode, label]) => (
                        <button
                          key={mode}
                          className="button compact"
                          onClick={async () => {
                            const { start, end } = scheduleFields(fields, view);
                            const series =
                              start || fields.find((f) => f.type === "date");
                            if (!series) return;
                            const result = await act({
                              action: "row.detachOccurrence",
                              rowId: selected.id,
                              version: selected.version,
                              date: occurrence.date,
                              startField: series.id,
                              mode,
                              ...(start && end ? { endField: end.id } : {}),
                            });
                            const created = (result as { id?: string } | null)
                              ?.id;
                            if (created) setRowId(created);
                          }}
                        >
                          {label}
                        </button>
                      ))}
                    </span>
                  )}
                </div>
              )}
            {selected.cover && (
              <div
                className="row-cover"
                style={
                  /^#[0-9a-f]{6}$/i.test(selected.cover)
                    ? { background: selected.cover }
                    : undefined
                }
              >
                {!selected.cover.startsWith("#") && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={selected.cover} alt="" />
                )}
                {selectedEditable && (
                  <button
                    className="button compact cover-change"
                    onClick={() => setRowCoverPicker(true)}
                  >
                    {t("Cover ändern", "Change cover")}
                  </button>
                )}
              </div>
            )}
            {layoutOpen && editable && allowFieldChanges && (
              <RecordLayoutEditor
                layout={recordLayout}
                fields={fields}
                save={(layout) =>
                  act({ action: "database.recordLayout", layout })
                }
              />
            )}
            {selected.role === "viewer" && (
              <p className="row-access-note" role="note">
                {t("Dieser Eintrag ist für dich schreibgeschützt.", "This record is read-only for you.")}
              </p>
            )}
            {accessOpen && canManageAccess(selected) && (
                <RowAccess
                  key={`access-${selected.id}`}
                  row={selected}
                  members={members}
                  groups={data.groups || []}
                  act={act}
                />
              )}
            {selectedEditable && (
              <div className="row-title-tools">
                <button
                  className="text-button"
                  onClick={() => setRowIconPicker(true)}
                >
                  <Smiley size={15} />{" "}
                  {selected.icon ? t("Symbol ändern", "Change icon") : t("Symbol hinzufügen", "Add icon")}
                </button>
                {!selected.cover && (
                  <button
                    className="text-button"
                    onClick={() => setRowCoverPicker(true)}
                  >
                    <ImageIcon size={15} /> {t("Cover hinzufügen", "Add cover")}
                  </button>
                )}
              </div>
            )}
            <h2>
              {selected.icon && (
                <PageIcon
                  name={selected.icon}
                  size={30}
                  className="row-title-icon"
                />
              )}
              {selectedEditable ? (
                <RowTitle
                  key={selected.id}
                  value={cellText(selected.cells[fields[0].id])}
                  focus={freshRowId === selected.id}
                  onSave={(title) => updateCell(selected, fields[0], title)}
                />
              ) : (
                cellText(selected.cells[fields[0].id]) || t("Ohne Titel", "Untitled")
              )}
            </h2>
            <div
              className={`row-columns${recordLayout.properties === "side" ? " properties-side" : ""}`}
            >
              <div className="row-properties">
                {recordFields.map((f) => (
                  <Fragment key={`${selected.id}-${f.id}`}>
                    <PropertyRow group={f.type === "files"}>
                      <span>{f.name}</span>
                      {computedTypes.includes(f.type) ? (
                        <span>
                          {display(
                            {
                              ...selected,
                              cells: computedCells(
                                selected,
                                fields,
                                related,
                                data.relatedSchemas,
                              ),
                            },
                            f,
                          )}
                        </span>
                      ) : (
                        <CellInput
                          field={f}
                          value={selected.cells[f.id]}
                          members={members}
                          related={related}
                          disabled={!selectedEditable}
                          onChange={(v) => updateCell(selected, f, v)}
                          upload={selectedEditable ? uploadFile : undefined}
                          files={data.files}
                        />
                      )}
                    </PropertyRow>
                    {f.type === "date" && reminderControl(selected, f)}
                    {f.type === "date" &&
                      f.id === fields.find((x) => x.type === "date")?.id &&
                      recurrenceControl(selected)}
                  </Fragment>
                ))}
                {emptyHidden > 0 && (
                  <button
                    className="text-button"
                    aria-expanded={showEmpty}
                    onClick={() => setShowEmpty((v) => !v)}
                  >
                    {showEmpty
                      ? t("Leere Eigenschaften ausblenden", "Hide empty properties")
                      : `${emptyHidden} leere ${emptyHidden === 1 ? "Eigenschaft" : "Eigenschaften"} anzeigen`}
                  </button>
                )}
                <RelationBacklinks
                  key={`backlinks-${selected.id}-${selected.version}`}
                  pageId={page.id}
                  rowId={selected.id}
                />
              </div>
              <div className="row-main">
                <RowDocument
                  key={selected.id}
                  pageId={page.id}
                  rowId={selected.id}
                  userId={userId}
                  pages={pages}
                  members={members}
                  editable={selectedEditable}
                  onError={onError}
                  onChanged={onRefresh}
                />
                {fields
                  .filter((f) => f.type === "time")
                  .map((f) => (
                    <RecordTime
                      key={`time-${selected.id}-${f.id}`}
                      pageId={page.id}
                      row={selected}
                      field={f}
                      estimate={f.estimateField && Number.isFinite(Number(selected.cells[f.estimateField])) && selected.cells[f.estimateField] !== null && selected.cells[f.estimateField] !== "" ? Number(selected.cells[f.estimateField]) : null}
                      editable={selectedEditable}
                      onChanged={onRefresh}
                      onError={onError}
                    />
                  ))}
                {subtaskParent && (
                  <RecordSubtasks
                    pageId={page.id}
                    row={selected}
                    rows={data.rows}
                    database={data.database}
                    parent={subtaskParent}
                    editable={selectedEditable}
                    act={act}
                  />
                )}
                <TicketThread
                  key={`ticket-${selected.id}`}
                  pageId={page.id}
                  rowId={selected.id}
                  editable={selectedEditable}
                  onError={onError}
                />
                <div className="settings-section">
                  <h3>{t("Kommentare", "Comments")}</h3>
                  {data.comments
                    .filter((c) => c.row_id === selected.id)
                    .map((c) => (
                      <div className="comment" key={c.id}>
                        <Avatar name={c.name} small />
                        <div>
                          <strong>{c.name}</strong>
                          <p>{c.body}</p>
                          {c.author_id && (
                            <Reactions
                              reactions={c.reactions || []}
                              onToggle={(emoji, active) =>
                                act({
                                  action: "comment.react",
                                  commentId: c.id,
                                  emoji,
                                  active,
                                })
                              }
                            />
                          )}
                        </div>
                      </div>
                    ))}
                  <form
                    onSubmit={async (e) => {
                      e.preventDefault();
                      if (comment.trim()) {
                        await act({
                          action: "comment.create",
                          rowId: selected.id,
                          body: comment,
                        });
                        setComment("");
                      }
                    }}
                  >
                    <input
                      value={comment}
                      onChange={(e) => setComment(e.target.value)}
                      placeholder={t("Kommentar schreiben …", "Write a comment …")}
                    />
                    <button className="button compact">{t("Senden", "Send")}</button>
                  </form>
                </div>
              </div>
            </div>
            {selectedEditable && (
              <button
                className="button danger"
                onClick={async () => {
                  await act({ action: "row.delete", rowId: selected.id });
                  setRowId(null);
                }}
              >
                <Trash />
                {t("Eintrag löschen", "Delete record")}
              </button>
            )}
          </div>
        )}
      </Modal>
      {selected && rowIconPicker && (
        <Modal
          open
          title={t("Symbol des Eintrags", "Record icon")}
          onClose={() => setRowIconPicker(false)}
        >
          <div
            className="icon-tabs"
            role="tablist"
            aria-label={t("Art des Symbols", "Kind of icon")}
          >
            {(
              [
                ["emoji", t("Emoji", "Emoji")],
                ["image", t("Bild", "Image")],
              ] as const
            ).map(([tab, label]) => (
              <button
                key={tab}
                role="tab"
                aria-selected={rowIconTab === tab}
                className={`chip${rowIconTab === tab ? " active" : ""}`}
                onClick={() => setRowIconTab(tab)}
              >
                {label}
              </button>
            ))}
            {selected.icon && (
              <button
                className="text-button"
                onClick={async () => {
                  if (
                    await act({
                      action: "row.appearance",
                      rowId: selected.id,
                      version: selected.version,
                      icon: "",
                    })
                  )
                    setRowIconPicker(false);
                }}
              >
                {t("Symbol entfernen", "Remove icon")}
              </button>
            )}
          </div>
          {rowIconTab === "emoji" ? (
            <EmojiPicker
              selected={selected.icon}
              onSelect={async (icon) => {
                if (
                  await act({
                    action: "row.appearance",
                    rowId: selected.id,
                    version: selected.version,
                    icon,
                  })
                )
                  setRowIconPicker(false);
              }}
            />
          ) : (
            <IconImagePicker
              pageId={page.id}
              current={selected.icon || ""}
              images={data.images || []}
              onSelect={async (icon) => {
                if (
                  await act({
                    action: "row.appearance",
                    rowId: selected.id,
                    version: selected.version,
                    icon,
                  })
                )
                  setRowIconPicker(false);
              }}
            />
          )}
        </Modal>
      )}
      {selected && rowCoverPicker && (
        <CoverPicker
          page={{ ...page, cover: selected.cover || "", cover_position: 50 }}
          images={data.images || []}
          positioned={false}
          onClose={() => setRowCoverPicker(false)}
          onSave={async (appearance) =>
            !!(await act({
              action: "row.appearance",
              rowId: selected.id,
              version: selected.version,
              cover: appearance.cover,
            }))
          }
        />
      )}
    </div>
  );
}
// Rows drawn at once; more follow on scrolling or with the button, so a
// database with thousands of entries opens as fast as a small one.
const ROW_STEP = 100;
function MoreRows({
  remaining,
  onMore,
  table = false,
  colSpan = 1,
  auto = false,
}: {
  remaining: number;
  onMore: () => void;
  table?: boolean;
  colSpan?: number;
  auto?: boolean;
}) {
  const t = useT();
  const ref = useRef<HTMLButtonElement>(null);
  const more = useRef(onMore);
  more.current = onMore;
  useEffect(() => {
    const el = ref.current;
    if (!auto || !el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => entries.some((e) => e.isIntersecting) && more.current(),
      { rootMargin: "600px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [auto, remaining]);
  const button = (
    <button ref={ref} type="button" className="text-button more-rows" onClick={() => onMore()}>
      {t("Weitere", "More")}{" "}{Math.min(remaining, ROW_STEP)} {t("von", "of")}{" "}{remaining} anzeigen
    </button>
  );
  return table ? (
    <tr className="more-rows-row">
      <td colSpan={colSpan}>{button}</td>
    </tr>
  ) : (
    button
  );
}

function tagColor(s: string) {
  if (["Erledigt", "Niedrig", "Done", "Low"].includes(s)) return "green";
  if (["In Arbeit", "Design", "In progress"].includes(s)) return "blue";
  if (["Hoch", "High"].includes(s)) return "red";
  if (["Mittel", "Produkt", "Medium", "Product"].includes(s)) return "yellow";
  return "gray";
}
// Files cells contain several controls; a <label> would forward every click
// to the first one (the file chooser).
// Title of a record, edited in place. Enter or leaving the field saves;
// Escape restores the stored title.
function RowTitle({
  value,
  focus,
  onSave,
}: {
  value: string;
  focus: boolean;
  onSave: (title: string) => unknown;
}) {
  const t = useT();
  const [draft, setDraft] = useState(value);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    if (!focus) return;
    input.current?.focus();
    input.current?.select();
  }, [focus]);
  // One line that grows with long titles, also when the width changes
  // (the dialog opens with an animation, phones rotate).
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    const fit = () => {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [draft]);
  const save = () => {
    const title = draft.replace(/\s+/g, " ").trim();
    if (title !== value) void onSave(title);
  };
  return (
    <textarea
      ref={input}
      className="row-title-input"
      aria-label={t("Titel des Eintrags", "Record title")}
      placeholder={t("Ohne Titel", "Untitled")}
      rows={1}
      value={draft}
      onChange={(e) => setDraft(e.target.value.replace(/\n/g, ""))}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          e.stopPropagation();
          setDraft(value);
          requestAnimationFrame(() => input.current?.blur());
        }
      }}
    />
  );
}

function PropertyRow({
  group,
  children,
}: {
  group: boolean;
  children: ReactNode;
}) {
  return group ? (
    <div className="row-property">{children}</div>
  ) : (
    <label className="row-property">{children}</label>
  );
}
// Incoming relations of a record ("Verknüpft von").
function RelationBacklinks({
  pageId,
  rowId,
}: {
  pageId: string;
  rowId: string;
}) {
  const t = useT();
  const [links, setLinks] = useState<Backlink[] | null>(null);
  useEffect(() => {
    let active = true;
    api<Backlink[]>(`/api/pages/${pageId}/rows/${rowId}/backlinks`)
      .then((result) => active && setLinks(result))
      .catch(() => active && setLinks([]));
    return () => {
      active = false;
    };
  }, [pageId, rowId]);
  if (!links?.length) return null;
  return (
    <section className="row-backlinks" aria-label={t("Verknüpft von", "Linked from")}>
      <h3>{t("Verknüpft von", "Linked from")}</h3>
      <ul>
        {links.map((link) => (
          <li key={`${link.rowId}-${link.field}`}>
            <a
              href={pageLocationHash({
                pageId: link.pageId,
                rowId: link.rowId,
              })}
            >
              {link.title}
            </a>
            <small className="muted">
              {link.pageTitle} · {link.field}
            </small>
          </li>
        ))}
      </ul>
    </section>
  );
}

// A new status (option of the grouping property) straight from the board:
// it becomes its own column.
function AddBoardGroup({
  existing,
  disabled,
  onAdd,
}: {
  existing: string[];
  disabled: boolean;
  onAdd: (name: string) => Promise<unknown>;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const submit = async () => {
    const value = name.trim();
    if (!value) return setOpen(false);
    if (existing.some((o) => o.toLocaleLowerCase("de") === value.toLocaleLowerCase("de")))
      return setError(t("Diese Gruppe gibt es schon.", "This group already exists."));
    const result = await onAdd(value);
    if (result === null) return;
    setName("");
    setError("");
    setOpen(false);
  };
  return open ? (
    <form
      className="board-add-group open"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <input
        autoFocus
        aria-label={t("Name der neuen Gruppe", "Name of the new group")}
        placeholder={t("Name der Gruppe", "Name of the group")}
        value={name}
        maxLength={100}
        disabled={disabled}
        onChange={(e) => {
          setName(e.target.value);
          setError("");
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setOpen(false);
            setName("");
            setError("");
          }
        }}
      />
      {error && (
        <span className="error" role="alert">
          {error}
        </span>
      )}
      <div className="board-add-group-actions">
        <button type="submit" className="button primary compact" disabled={disabled || !name.trim()}>
          {t("Hinzufügen", "Add")}
        </button>
        <button
          type="button"
          className="button compact"
          onClick={() => {
            setOpen(false);
            setName("");
            setError("");
          }}
        >
          {t("Abbrechen", "Cancel")}
        </button>
      </div>
    </form>
  ) : (
    <button type="button" className="board-add-group" onClick={() => setOpen(true)}>
      <Plus size={16} />
      {t("Gruppe hinzufügen", "Add group")}
    </button>
  );
}
