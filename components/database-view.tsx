"use client";
import { Select } from "./select";
import { RowAccess } from "./row-access";
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
const fieldNames: Record<FieldType, string> = {
  text: "Text",
  number: "Zahl",
  date: "Datum",
  select: "Auswahl",
  multiselect: "Mehrfachauswahl",
  checkbox: "Checkbox",
  url: "URL",
  email: "E-Mail",
  phone: "Telefon",
  checklist: "Checkliste",
  person: "Person",
  relation: "Relation",
  rollup: "Rollup",
  formula: "Formel",
  created_at: "Erstellt am",
  updated_at: "Bearbeitet am",
  created_by: "Erstellt von",
  updated_by: "Bearbeitet von",
  files: "Dateien",
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
  const [viewId, setViewId] = useState(data.database.views[0].id),
    [query, setQuery] = useState(""),
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
    [layoutOpen, setLayoutOpen] = useState(false);
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
        `${selectionRows.length} Einträge ${operation === "update" ? "aktualisiert" : operation === "duplicate" ? "dupliziert" : "gelöscht"}. Vorheriger Stand im Versionsverlauf gesichert.`,
      );
    }
  }
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
        data.related,
        data.relatedSchemas,
        new Date(filterNow),
      ),
    [data, fields, view, query, filterNow],
  );
  const selected = data.rows.find((r) => r.id === rowId);
  const selectedEditable = editable && selected?.role !== "viewer";
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
      onError("Dieser Datensatz ist nicht mehr verfügbar.");
  }, [rowId, selected, onError]);
  const groupField = groupingField(fields, view);
  const dateField =
    fields.find((f) => f.id === view.dateField) ||
    fields.find((f) => f.type === "date");
  const allGroups = databaseGroups(shown, groupField, data.related, members);
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
      ? databaseGroups(shown, subField, data.related, members).filter(
          (lane) => lane.rows.length,
        )
      : null;
  // Plain boards (no swimlanes) drag cards with pointer events.
  const plainBoard = view.type === "board" && !lanes;
  const subgroups = new Map<string, DatabaseGroup[]>(
    subField
      ? groups.map((g) => [
          g.key,
          databaseSubgroups(g, subField, data.related, members),
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
                ? "Für Rückrelationen brauchst du Bearbeitungsrechte auf beide Datenbanken."
                : target.page.locked
                  ? "Die verknüpfte Datenbank ist gesperrt."
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
        setOrderStatus(`Reihenfolge in „${view.name}“ gespeichert.`);
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
        onError("Diese Gruppierung kann nicht bearbeitet werden.");
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
        onError("Diese Gruppierung kann nicht bearbeitet werden.");
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
        aria-label={`Eintrag verschieben: ${cellText(row.cells[fields[0].id]) || "Ohne Titel"}`}
        title="Ziehen oder Position wählen · Alt + Pfeil hoch/runter"
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
          : { [fields[0].id]: "Neue Aufgabe", ...cells },
      templateId,
    })) as { id: string } | null;
    if (r && open) {
      setFreshRowId(r.id);
      setRowId(r.id);
    }
  }
  async function uploadFile(file: File) {
    if (file.size > 10 * 1024 * 1024)
      throw new Error(`${file.name}: maximal 10 MB pro Datei.`);
    const body = new FormData();
    body.set("pageId", page.id);
    body.set("file", file);
    const response = await fetch("/api/upload", { method: "POST", body });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Upload fehlgeschlagen.");
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
            const target = data.related[f.relationPage || ""]?.find(
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
                {cellText(target.cells.title) || "Ohne Titel"}
              </a>
            ) : (
              <span key={rid} className="muted">
                Nicht verfügbar
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
            {cellText(r.cells[fields[0].id]) || "Ohne Titel"}
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
        <span>Wiederholung</span>
        <span className="recurrence-choice">
          <Select
            aria-label="Wiederholung"
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
            <option value="">Keine</option>
            {Object.entries(recurrenceLabels).map(([key, [label]]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </Select>
          {rule && (
            <>
              <label>
                Alle
                <input
                  type="number"
                  min={1}
                  max={99}
                  aria-label="Wiederholungsintervall"
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
                {recurrenceLabels[rule.freq][1]}
              </label>
              <label>
                Endet
                <input
                  type="date"
                  aria-label="Wiederholung endet am"
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
                Termin auslassen
                <input
                  type="date"
                  aria-label="Termin auslassen am"
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
        ? "Diese Erinnerung passt nicht zum aktuellen Datum und ist inaktiv."
        : target.epochMilliseconds < Date.now() - ARM_GRACE_MS
          ? "Der Erinnerungszeitpunkt liegt in der Vergangenheit."
          : `Erinnerung am ${new Date(target.epochMilliseconds).toLocaleString(
              "de-DE",
              {
                timeZone: reminder.timeZone,
                dateStyle: "medium",
                timeStyle: "short",
              },
            )}`;
    return (
      <label className="row-property reminder-property">
        <span>Erinnerung</span>
        <span className="reminder-choice">
          <Select
            aria-label={`Erinnerung für ${field.name}`}
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
            <option value="">Keine Erinnerung</option>
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
      onError("Maximal 1.000 eingeklappte Gruppen je Ansicht.");
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
    const before = horizontal ? "nach links" : "nach oben";
    const after = horizontal ? "nach rechts" : "nach unten";
    return (
      <span className="group-move">
        <button
          className="icon-button"
          aria-label={`Gruppe ${group.label} ${before} verschieben`}
          title={`Gruppe ${before} verschieben`}
          disabled={schemaBusy || index <= 0}
          onClick={() => void moveGroup(group.key, index - 1)}
        >
          <Before size={14} />
        </button>
        <button
          className="icon-button"
          aria-label={`Gruppe ${group.label} ${after} verschieben`}
          title={`Gruppe ${after} verschieben`}
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
            {f.name}: {summaryText(summary, f)}
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
    if (!list) return group.rows.map((r) => render(r, group.key));
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
    return databaseGroups(rows, field, data.related, members)
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
        aria-label={`Gruppe ${g.label} in ${where}`}
      >
        <button
          className="group-toggle"
          aria-expanded={!closed}
          aria-label={`Gruppe ${g.label} in ${where} ${closed ? "ausklappen" : "einklappen"}`}
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
            title={`Eintrag in ${where} / ${g.label} hinzufügen`}
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
    return databaseGroups(rows, field, data.related, members)
      .filter((g) => g.rows.length)
      .map((g) => {
        const keys = [...path.map((p) => p.key), g.key],
          closed = collapsed(pathCollapseKey(keys));
        return (
          <section
            key={JSON.stringify(keys)}
            className={`board-card-section database-group-level-${keys.length}`}
            aria-label={`Abschnitt ${g.label}`}
          >
            <button
              className="group-toggle"
              aria-expanded={!closed}
              aria-label={`Abschnitt ${g.label} ${closed ? "ausklappen" : "einklappen"}`}
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
        aria-label={`Untergruppe ${sub.label} in ${group.label}`}
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
          aria-label={`Untergruppe ${sub.label} in ${group.label} ${closed ? "ausklappen" : "einklappen"}`}
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
            title={`Eintrag in ${group.label} / ${sub.label} hinzufügen`}
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
          aria-label={`Gruppe ${group.label} ${collapsed(group.key) ? "ausklappen" : "einklappen"}`}
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
            aria-label={`Gruppe ${group.label} auswählen`}
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
            title={`Eintrag in ${group.label} hinzufügen`}
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
  function tableRow(r: Row, groupKey?: string) {
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
                aria-label={`${cellText(r.cells[fields[0].id]) || "Ohne Titel"} auswählen`}
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
                  related={data.related}
                  onChange={(v) => updateCell(r, f, v)}
                  upload={editable ? uploadFile : undefined}
                  files={data.files}
                />
              </span>
            ) : (
              <span className={f.id === fields[0].id ? "title-cell" : ""}>
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
            {cellText(r.cells[fields[0].id]) || "Ohne Titel"}
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
            title="Ansicht hinzufügen"
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
            Filtern
            {activeFilterCount > 0 && (
              <span className="count">{activeFilterCount}</span>
            )}
          </button>
          <button onClick={() => setConfig(true)}>
            <SortAscending size={17} />
            Sortieren
          </button>
          <button
            title="Ansicht und Eigenschaften"
            onClick={() => setConfig(true)}
          >
            <SlidersHorizontal size={17} />
          </button>
        </div>
        <div className="toolbar-right">
          <div className="table-search">
            <MagnifyingGlass size={16} />
            <input
              aria-label="Datenbank durchsuchen"
              placeholder="Suchen …"
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
                Neu
              </button>{" "}
              <button
                title="Datensatzvorlagen"
                onClick={() => setManageTemplates(true)}
              >
                <DotsThree size={20} />
              </button>
            </>
          )}
        </div>
      </div>
      {editable && view.type === "table" && selectionRows.length > 0 && (
        <div
          className="bulk-toolbar"
          role="toolbar"
          aria-label="Ausgewählte Einträge"
        >
          <strong>{selectionRows.length} ausgewählt</strong>
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
            Gemeinsam bearbeiten
          </button>
          <button
            className="button compact"
            disabled={bulkBusy}
            onClick={() => bulkAction("duplicate")}
          >
            Duplizieren
          </button>
          <button
            className="button compact danger"
            disabled={bulkBusy}
            onClick={() => setBulk("delete")}
          >
            Löschen
          </button>
          <button
            className="button compact"
            onClick={() => setSelection(new Map())}
          >
            Auswahl aufheben
          </button>
        </div>
      )}
      {grouped && (
        <div className="group-view-toolbar">
          <span>
            {groups.length} Gruppen · {shown.length} Einträge
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
            Alle einklappen
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
            Alle ausklappen
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
                      aria-label="Alle sichtbaren Einträge auswählen"
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
                          ? "Eigenschaften in der Quelldatenbank bearbeiten"
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
                      aria-label="Eigenschaft hinzufügen"
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
                <tbody key={g.key} aria-label={`Gruppe ${g.label}`}>
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
              <tbody>{shown.map((r) => tableRow(r))}</tbody>
            )}

            <tfoot>
              <tr>
                <td colSpan={visibleFields.length + (editable ? 2 : 0)}>
                  {editable && (
                    <button className="new-record" onClick={() => createRow()}>
                      <Plus size={15} />
                      Neue Zeile
                    </button>
                  )}
                  <span className="record-count">{shown.length} Einträge</span>
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
                        aria-label={`Berechnung für ${f.name}`}
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
                            <strong>{summaryText(summary, f)}</strong>
                          </>
                        ) : (
                          <span>Berechnen</span>
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
                aria-label={`Spalte ${g.label}`}
              >
                <button
                  className="icon-button group-toggle"
                  aria-expanded={!collapsed(g.key)}
                  aria-label={`Gruppe ${g.label} ${collapsed(g.key) ? "ausklappen" : "einklappen"}`}
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
                <span className="muted">{g.rows.length}</span>

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
                aria-label={`Swimlane ${lane.label}`}
              >
                <div className="board-lane-title">
                  <button
                    className="group-toggle"
                    aria-expanded={!closed}
                    aria-label={`Swimlane ${lane.label} ${closed ? "ausklappen" : "einklappen"}`}
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
                                  title={`Eintrag in ${g.label} / ${lane.label} hinzufügen`}
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
                                  Neu
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
              aria-label={`Gruppe ${g.label}`}
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
                  aria-label={`Gruppe ${g.label} ${collapsed(g.key) ? "ausklappen" : "einklappen"}`}
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
                <span className="muted">{g.rows.length}</span>
                {viewEditable && (
                  <button
                    className="group-drag"
                    aria-label={`Gruppe ${g.label} ziehen`}
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
                    title={`Eintrag in ${g.label} hinzufügen`}
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
              {!collapsed(g.key) && g.rows.map((r) => card(r, g.key))}
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
                  Neue Aufgabe
                </button>
              )}
            </section>
          ))}
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
                        related={data.related}
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
          {shown.map((r) => card(r))}
        </div>
      )}
      {view.type === "list" && (
        <div className="record-list">
          {grouped
            ? groups.map((g) => (
                <section
                  key={g.key}
                  aria-label={`Gruppe ${g.label}`}
                  className="database-list-group"
                >
                  {groupHeader(g)}
                  {!collapsed(g.key) &&
                    nestedRows(g, (r, key) => listRow(r, key), false)}
                </section>
              ))
            : shown.map((r) => listRow(r))}
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
          related={data.related}
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
            data.related as unknown as Record<
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
          <h3>Keine Einträge</h3>
          <p>
            {query || activeFilterCount
              ? "Passe deine Suche oder Filter an."
              : "Füge deinen ersten Eintrag hinzu."}
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
            onError("CSV konnte nicht gelesen werden.");
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
          title="Filter bearbeiten"
          wide
        >
          <DatabaseFilterEditor
            key={view.id}
            view={view}
            version={data.database.version}
            fields={fields}
            rows={data.rows}
            related={data.related}
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
        title="Ansicht konfigurieren"
      >
        <fieldset
          className="schema-settings"
          disabled={schemaBusy}
          aria-busy={schemaBusy}
        >
          <label>
            Name
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
              <h3>Feed-Darstellung</h3>
              <label>
                Dokumentinhalt
                <Select
                  aria-label="Feed-Dokumentinhalt"
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
                  <option value="full">Vollständig anzeigen</option>
                  <option value="compact">Kompakte Textvorschau</option>
                  <option value="hidden">Ausblenden</option>
                </Select>
              </label>
              {(
                [
                  ["showAuthor", "Verfasser anzeigen"],
                  ["showDate", "Erstellungsdatum anzeigen"],
                  ["showComments", "Kommentaranzahl anzeigen"],
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
            <h3>Filter</h3>
            <p className="muted">
              {activeFilterCount
                ? `${activeFilterCount} Bedingungen aktiv`
                : "Keine Filter aktiv"}
            </p>
            <button
              className="button compact"
              onClick={() => {
                setConfig(false);
                setFilterOpen(true);
              }}
            >
              Filter bearbeiten
            </button>
          </div>
          <div className="settings-section">
            <h3>Sortierung</h3>
            {view.sorts.map((s, i) => (
              <div className="filter-line" key={i}>
                <Select
                  value={s.field}
                  aria-label="Sortier-Eigenschaft"
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
                  aria-label="Sortierrichtung"
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
                  <option value="asc">Aufsteigend</option>
                  <option value="desc">Absteigend</option>
                </Select>
                <button
                  className="icon-button"
                  aria-label="Sortierung entfernen"
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
              Sortierung hinzufügen
            </button>
          </div>
          {view.type === "gallery" && (
            <fieldset
              disabled={!viewEditable || schemaBusy}
              className="gallery-settings"
            >
              <legend>Galerie-Cover</legend>
              <label>
                Bildquelle
                <Select
                  aria-label="Galerie-Bildquelle"
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
                  <option value="none">Keine Bilder</option>
                  <option value="record">Datensatz-Cover</option>
                  <option value="document">
                    Erstes Bild im Eintragsinhalt
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
                Bilddarstellung
                <Select
                  aria-label="Galerie-Bilddarstellung"
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
                  <option value="cover">Fläche ausfüllen</option>
                  <option value="contain">Ganzes Bild anzeigen</option>
                </Select>
              </label>
              <label>
                Kartengröße
                <Select
                  aria-label="Galerie-Kartengröße"
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
                  <option value="small">Klein</option>
                  <option value="medium">Mittel</option>
                  <option value="large">Groß</option>
                </Select>
              </label>
            </fieldset>
          )}
          <label>
            Gruppieren nach
            <Select
              aria-label="Gruppieren nach"
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
                {view.type === "board" ? "Automatisch" : "Keine Gruppierung"}
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
              {view.type === "board" ? "Swimlanes nach" : "Untergruppen nach"}
              <Select
                aria-label={
                  view.type === "board" ? "Swimlanes nach" : "Untergruppen nach"
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
                    ? "Keine Swimlanes"
                    : "Keine Untergruppen"}
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
                const label = `Gruppenebene ${i + 3}`;
                return (
                  <label key={label}>
                    {view.type === "board"
                      ? `Abschnitte (Ebene ${i + 3})`
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
                      <option value="">Keine weitere Ebene</option>
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
                Leere Gruppen ausblenden
              </label>
              <label>
                Gruppen sortieren
                <Select
                  aria-label="Gruppen sortieren"
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
                      ? "Eigene Reihenfolge"
                      : "Eigenschaftsreihenfolge"}
                  </option>
                  <option value="asc">Bezeichnung aufsteigend</option>
                  <option value="desc">Bezeichnung absteigend</option>
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
                  Gruppenreihenfolge zurücksetzen
                </button>
              )}
            </div>
          )}
          <label>
            Datumsfeld
            <Select
              value={view.dateField || ""}
              onChange={(e) => updateView({ dateField: e.target.value })}
            >
              <option value="">Automatisch</option>
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
            Enddatum
            <Select
              value={view.endDateField || ""}
              onChange={(e) => updateView({ endDateField: e.target.value })}
            >
              <option value="">Kein Enddatum</option>
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
            <h3>Eigenschaften und Spalten</h3>
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
                  aria-label={`${f.name} nach oben`}
                  disabled={!viewEditable || index === 0}
                  onClick={() => moveColumn(f.id, orderedFields[index - 1].id)}
                >
                  ↑
                </button>
                <button
                  className="icon-button"
                  aria-label={`${f.name} nach unten`}
                  disabled={!viewEditable || index === orderedFields.length - 1}
                  onClick={() => moveColumn(orderedFields[index + 1].id, f.id)}
                >
                  ↓
                </button>
                {view.type === "table" && (
                  <input
                    type="number"
                    className="column-width-input"
                    aria-label={`${f.name} Breite in Pixeln`}
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
              Ansicht löschen
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
            ? "Einträge löschen"
            : "Einträge gemeinsam bearbeiten"
        }
      >
        <p>
          {selectionRows.length} ausgewählte Einträge. Vor der Änderung wird
          eine Datenbankversion gesichert.
        </p>
        {bulk === "update" && (
          <>
            <label>
              Eigenschaft
              <Select
                aria-label="Eigenschaft"
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
                Neuer Wert
                <CellInput
                  key={bulkField}
                  field={fields.find((f) => f.id === bulkField)!}
                  value={bulkValue}
                  members={members}
                  related={data.related}
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
            ? "Wird gespeichert …"
            : bulk === "delete"
              ? "Einträge löschen"
              : "Änderung anwenden"}
        </button>
      </Modal>
      <p role="status" className="sr-only">
        {orderStatus}
      </p>
      <Modal
        open={!!moveDialog}
        onClose={() => setMoveDialog(null)}
        title="Eintrag verschieben"
      >
        <p>
          „
          {moveRow
            ? cellText(moveRow.cells[fields[0].id]) || "Ohne Titel"
            : "Eintrag"}
          “ in Ansicht „{view.name}“ anordnen.
        </p>
        <p className="muted">
          Die Reihenfolge gilt für diese Ansicht. Ausgeblendete Einträge
          behalten ihre relative Reihenfolge.
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
            An den Anfang
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
            Nach oben
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
            Nach unten
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
            Ans Ende
          </button>
        </div>
        <label>
          Position
          <Select
            aria-label="Verschiebeposition"
            value={movePlacement}
            onChange={(e) =>
              setMovePlacement(e.target.value as "before" | "after")
            }
          >
            <option value="before">Vor dem Eintrag</option>
            <option value="after">Nach dem Eintrag</option>
          </Select>
        </label>
        <label>
          Bezugseintrag
          <Select
            aria-label="Bezugseintrag"
            value={moveTarget}
            onChange={(e) => setMoveTarget(e.target.value)}
          >
            <option value="">Eintrag auswählen …</option>
            {moveSiblings
              .filter((r) => r.id !== moveRow?.id)
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {cellText(r.cells[fields[0].id]) || "Ohne Titel"}
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
            Hierhin verschieben
          </button>
        </div>
      </Modal>
      <Modal
        open={!!sortMove}
        onClose={() => setSortMove(null)}
        title="Sortierung aufheben?"
      >
        <p>
          Diese Ansicht wird automatisch sortiert. Zum manuellen Verschieben
          werden ihre Sortierregeln aufgehoben. Die bisherige Sortierung wird
          als Ausgangsreihenfolge gespeichert.
        </p>
        <div className="modal-actions">
          <button
            className="button"
            disabled={orderBusy}
            onClick={() => setSortMove(null)}
          >
            Abbrechen
          </button>
          <button
            className="button primary"
            disabled={orderBusy}
            onClick={() => sortMove && submitMove(sortMove, true)}
          >
            Sortierung aufheben und verschieben
          </button>
        </div>
      </Modal>
      <Modal
        open={newField}
        onClose={() => setNewField(false)}
        title={
          fields.some((f) => f.id === fieldDraft.id)
            ? "Eigenschaft bearbeiten"
            : "Eigenschaft hinzufügen"
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
                  "Die Formel enthält zu viele Eigenschaftsbezüge.",
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
                "Die Eigenschaft konnte nicht gespeichert werden. Dein Entwurf bleibt erhalten.",
              );
          }}
        >
          <label>
            Name
            <input
              required
              autoFocus
              aria-label="Eigenschaftsname"
              value={fieldDraft.name}
              disabled={!editable || !allowFieldChanges || schemaBusy}
              onChange={(e) =>
                setFieldDraft((f) => ({ ...f, name: e.target.value }))
              }
            />
          </label>
          <label>
            Typ
            <Select
              aria-label="Eigenschaftstyp"
              value={fieldDraft.type}
              disabled={
                !editable || !allowFieldChanges || schemaBusy || !!relationPair
              }
              onChange={(e) =>
                setFieldDraft((f) => ({
                  ...f,
                  type: e.target.value as FieldType,
                }))
              }
            >
              {Object.entries(fieldNames).map(([k, n]) => (
                <option key={k} value={k}>
                  {n}
                </option>
              ))}
            </Select>
          </label>
          {["select", "multiselect"].includes(fieldDraft.type) && (
            <label>
              Optionen, durch Komma getrennt
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
          {fieldDraft.type === "number" && (
            <label>
              Format
              <Select
                aria-label="Zahlenformat"
                value={fieldDraft.format || ""}
                onChange={(e) =>
                  setFieldDraft((f) => ({ ...f, format: e.target.value }))
                }
              >
                {Object.entries(numberFormats).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </Select>
            </label>
          )}
          {fieldDraft.type === "number" && (
            <>
              <label>
                Nachkommastellen
                <Select
                  aria-label="Nachkommastellen"
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
                  <option value="">Automatisch</option>
                  {[0, 1, 2, 3, 4, 5, 6].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </Select>
              </label>
              <label>
                Darstellung
                <Select
                  aria-label="Zahlendarstellung"
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
                  <option value="number">Zahl</option>
                  <option value="bar">Fortschrittsbalken</option>
                  <option value="ring">Fortschrittsring</option>
                  <option value="rating">Bewertung (Sterne)</option>
                </Select>
              </label>
              {fieldDraft.rollupDisplay === "rating" && (
                <label>
                  Anzahl Sterne
                  <input
                    aria-label="Anzahl Sterne"
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
                    Zielwert
                    <input
                      aria-label="Zielwert"
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
                Datumsformat
                <Select
                  aria-label="Datumsformat"
                  value={fieldDraft.format || ""}
                  onChange={(e) =>
                    setFieldDraft((f) => ({ ...f, format: e.target.value }))
                  }
                >
                  {Object.entries(dateFormats).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </Select>
              </label>
              <label>
                Zeitformat
                <Select
                  aria-label="Zeitformat"
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
                      {label}
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
              related={data.related}
              schemas={data.relatedSchemas || {}}
              disabled={!editable || !allowFieldChanges || schemaBusy}
              onChange={(formula) => setFieldDraft((f) => ({ ...f, formula }))}
            />
          )}
          {fieldDraft.type === "relation" && (
            <>
              <label>
                Verknüpfte Datenbank
                <Select
                  aria-label="Verknüpfte Datenbank"
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
                  <option value="">Auswählen …</option>
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
                Bidirektional verknüpfen
              </label>
              {bidirectional && !relationPair && (
                <label>
                  Name der Rückrelation
                  <input
                    aria-label="Name der Rückrelation"
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
                    Eine neue Eigenschaft in der Zieldatenbank zeigt die
                    zugehörigen Einträge. Änderungen werden in beide Richtungen
                    übernommen.
                  </small>
                </label>
              )}
              {relationPair && (
                <p className="muted">
                  Verknüpft mit „{inverseName || "Rückrelation"}“. Beim
                  Deaktivieren oder Löschen bleiben die andere Eigenschaft und
                  ihre Werte erhalten. Zum Ändern des Typs oder Ziels zuerst
                  deaktivieren und speichern.
                </p>
              )}
              {relationChanged && (
                <p role="status" className="muted">
                  {relationTarget?.error ||
                    (!relationReady
                      ? "Berechtigungen werden geprüft …"
                      : "Bearbeitungsrechte für beide Datenbanken vorhanden.")}
                </p>
              )}
            </>
          )}
          {fieldDraft.type === "rollup" && (
            <>
              <label>
                Relation
                <Select
                  aria-label="Rollup-Relation"
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
                  <option value="">Auswählen …</option>
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
                Eigenschaft
                <Select
                  aria-label="Rollup-Eigenschaft"
                  value={fieldDraft.rollupField || ""}
                  onChange={(e) =>
                    setFieldDraft((f) => ({
                      ...f,
                      rollupField: e.target.value,
                      aggregate: "count",
                    }))
                  }
                >
                  <option value="">Nur verknüpfte Einträge zählen</option>
                  {rollupFields.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name} · {fieldNames[f.type]}
                    </option>
                  ))}
                </Select>
                {rollupRelation && !rollupFields.length && (
                  <small>Die verknüpfte Datenbank ist nicht zugänglich.</small>
                )}
              </label>
              <label>
                Berechnung
                <Select
                  aria-label="Rollup-Berechnung"
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
                      {aggregateNames[a]}
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
                    Darstellung
                    <Select
                      aria-label="Rollup-Darstellung"
                      value={fieldDraft.rollupDisplay || "number"}
                      onChange={(e) =>
                        setFieldDraft((f) => ({
                          ...f,
                          rollupDisplay: e.target
                            .value as Field["rollupDisplay"],
                        }))
                      }
                    >
                      <option value="number">Zahl</option>
                      <option value="bar">Fortschrittsbalken</option>
                      <option value="ring">Fortschrittsring</option>
                    </Select>
                  </label>
                  {fieldDraft.rollupDisplay &&
                    fieldDraft.rollupDisplay !== "number" &&
                    !percentAggregate(fieldDraft.aggregate) && (
                      <label>
                        Zielwert
                        <input
                          aria-label="Rollup-Zielwert"
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
                ? "Die Datenbank wurde zwischenzeitlich geändert. Dein Entwurf bleibt erhalten. Schließe den Dialog und öffne die Eigenschaft erneut, um den aktuellen Stand zu bearbeiten."
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
                          "Die Eigenschaft konnte nicht gelöscht werden. Dein Entwurf bleibt erhalten.",
                        );
                    }}
                  >
                    Löschen
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
                Speichern
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
              throw new Error("Diese Ansicht ist nicht mehr verfügbar.");
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
        title="Ansicht hinzufügen"
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
            Name
            <input
              required
              autoFocus
              value={viewName}
              onChange={(e) => setViewName(e.target.value)}
            />
          </label>
          <label>
            Darstellung
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
          <button className="button primary">Ansicht erstellen</button>
        </form>
      </Modal>
      <Modal
        open={manageTemplates}
        onClose={() => setManageTemplates(false)}
        title="Datensatzvorlagen"
      >
        <p className="muted">
          Speichere einen Eintrag mit seinen Eigenschaften und Inhalten als
          Vorlage.
        </p>
        <button
          className="button"
          onClick={() => {
            setManageTemplates(false);
            void createRow({}, true, null);
          }}
        >
          Leeren Eintrag erstellen
        </button>
        {data.rowTemplates?.map((t) => (
          <div className="row-template-item" key={t.id}>
            <strong>{t.name}</strong>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={!!t.is_default}
                onChange={(e) =>
                  act({
                    action: "row.template.default",
                    templateId: t.id,
                    enabled: e.target.checked,
                  })
                }
              />
              Standardvorlage
            </label>
            <div>
              <button
                className="button compact"
                onClick={() => {
                  setManageTemplates(false);
                  void createRow({}, true, t.id);
                }}
              >
                Verwenden
              </button>
              <button
                className="icon-button danger"
                title={`Vorlage ${t.name} löschen`}
                onClick={() =>
                  act({ action: "row.template.delete", templateId: t.id })
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
        title="Eintrag"
        wide
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
                    Termin am{" "}
                    {new Date(`${occurrence.date}T00:00:00`).toLocaleDateString(
                      "de-DE",
                      {
                        weekday: "short",
                        day: "numeric",
                        month: "long",
                        year: "numeric",
                      },
                    )}{" "}
                    aus einer Serie. Änderungen hier gelten für alle Termine.
                  </span>
                  {selectedEditable && (
                    <span className="occurrence-actions">
                      {(
                        [
                          ["single", "Nur diesen Termin bearbeiten"],
                          ["following", "Diesen und alle folgenden"],
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
              </div>
            )}
            <div className="row-appearance-actions">
              <button
                className="text-button"
                aria-pressed={favoriteRows.some((f) => f.rowId === selected.id)}
                onClick={() =>
                  act({
                    action: "favorite.row",
                    rowId: selected.id,
                    value: !favoriteRows.some((f) => f.rowId === selected.id),
                  })
                }
              >
                {favoriteRows.some((f) => f.rowId === selected.id)
                  ? "Aus Favoriten entfernen"
                  : "Zu Favoriten"}
              </button>
              <label className="record-mode">
                <Select
                  aria-label="Eintrag öffnen als"
                  value={recordModeChoice}
                  onChange={(e) => {
                    const mode = e.target.value as RecordOpenMode | "";
                    setRecordModeChoice(mode);
                    try {
                      if (mode)
                        localStorage.setItem("flowplan-record-mode", mode);
                      else localStorage.removeItem("flowplan-record-mode");
                      localStorage.removeItem("flowplan-record-full");
                    } catch {}
                  }}
                >
                  <option value="">
                    Standard ({recordOpenLabels[recordLayout.open]})
                  </option>
                  {recordOpenModes.map((mode) => (
                    <option key={mode} value={mode}>
                      {recordOpenLabels[mode]}
                    </option>
                  ))}
                </Select>
              </label>
              {editable && allowFieldChanges && (
                <button
                  className="text-button"
                  aria-expanded={layoutOpen}
                  onClick={() => setLayoutOpen((v) => !v)}
                >
                  Layout anpassen
                </button>
              )}
              {selectedEditable && (
                <>
                  <button
                    className="text-button"
                    onClick={() => setRowIconPicker(true)}
                  >
                    {selected.icon ? "Symbol ändern" : "Symbol hinzufügen"}
                  </button>
                  <button
                    className="text-button"
                    onClick={() => setRowCoverPicker(true)}
                  >
                    {selected.cover ? "Cover ändern" : "Cover hinzufügen"}
                  </button>
                </>
              )}
            </div>
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
                Dieser Eintrag ist für dich schreibgeschützt.
              </p>
            )}
            {editable &&
              (data.role === "owner" || selected.created_by === userId) && (
                <RowAccess
                  key={`access-${selected.id}`}
                  row={selected}
                  members={members}
                  groups={data.groups || []}
                  act={act}
                />
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
                cellText(selected.cells[fields[0].id]) || "Ohne Titel"
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
                                data.related,
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
                          related={data.related}
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
                      ? "Leere Eigenschaften ausblenden"
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
                <div className="settings-section">
                  <h3>Kommentare</h3>
                  {data.comments
                    .filter((c) => c.row_id === selected.id)
                    .map((c) => (
                      <div className="comment" key={c.id}>
                        <Avatar name={c.name} small />
                        <div>
                          <strong>{c.name}</strong>
                          <p>{c.body}</p>
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
                      placeholder="Kommentar schreiben …"
                    />
                    <button className="button compact">Senden</button>
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
                Eintrag löschen
              </button>
            )}
          </div>
        )}
      </Modal>
      {selected && rowIconPicker && (
        <Modal
          open
          title="Symbol des Eintrags"
          onClose={() => setRowIconPicker(false)}
        >
          <div
            className="icon-tabs"
            role="tablist"
            aria-label="Art des Symbols"
          >
            {(
              [
                ["emoji", "Emoji"],
                ["image", "Bild"],
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
                Symbol entfernen
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
function tagColor(s: string) {
  if (["Erledigt", "Niedrig"].includes(s)) return "green";
  if (["In Arbeit", "Design"].includes(s)) return "blue";
  if (["Hoch"].includes(s)) return "red";
  if (["Mittel", "Produkt"].includes(s)) return "yellow";
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
      aria-label="Titel des Eintrags"
      placeholder="Ohne Titel"
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
    <section className="row-backlinks" aria-label="Verknüpft von">
      <h3>Verknüpft von</h3>
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
