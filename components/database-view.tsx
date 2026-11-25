"use client";
import { useFullWidthPages } from "@/lib/page-width-pref-client";
import { rowChanges } from "@/lib/row-queue";
import { patchBase } from "@/lib/row-patch";
import { useKeyboardHints } from "@/lib/keyboard-hints";
import { safeCollisionPadding } from "./safe-area";
import { serverMessage } from "@/lib/server-message";
import { readModeIds, toggleReadMode } from "@/lib/read-mode";
import { pinnedColumnLeft, pinnedColumnWidth, SELECTION_COLUMN, tableWidth } from "@/lib/pinned-column";
import { defaultColumnWidth } from "@/lib/column-widths";
import { isLinkField, type LinkFieldType } from "@/lib/cell-links";
import { isEmptyValue } from "@/lib/empty-value";
import { RecordPropertyValue } from "./record-property-value";
import { LinkCellDisplay, LinkValue } from "./link-cell";
import { type CsvContext, csvImporter, databaseCsv, parseCsvFile, viewCsvFields } from "@/lib/database-csv";
import { recordsClipboard, type ClipboardContext } from "@/lib/database-clipboard";
import { suggestedPrefix } from "@/lib/ticket-ids";
import { parentField, treeOrder } from "@/lib/subtasks";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { useT } from "./i18n";
import { Select } from "./select";
import { RowAccess, rowAccessSummary } from "./row-access";
import TicketThread from "./ticket-thread";
import { RecordRepeat } from "./record-repeat";
import { DatabaseTools } from "./database-tools";
import { RecordSubtasks } from "./record-subtasks";
import { BoardWipSettings, WipCount } from "./board-wip";
import { RecordTime } from "./record-time";
import { RecordGit } from "./record-git";
import { IssueSyncChip } from "./issue-sync-database";
import { RecordMenu, TransferDialog } from "./record-transfer";
import { ApplyTemplateDialog } from "./apply-template";
import { flushOpenDocuments } from "@/lib/document-flush";
import { appCache, rowKey } from "@/lib/swr-cache";
import { ContextMenu } from "./context-menu";
import { formatDuration } from "@/lib/durations";
import { tagByName, useTagOptions } from "./tag-options-context";
import { isTagField } from "@/lib/page-properties";
import { cleanOptions, hasOwnSettings, mergesOf, optionRenames, type OptionRename } from "@/lib/option-renames";
import { OPTION_COLORS, carryColors, choiceChipClass, colorOptions, hasOwnOptions, legacyOptionColor, optionColor, type OptionColor } from "@/lib/option-colors";
import { foldOption } from "@/lib/option-search";
import { SprintContext } from "./sprint-context";
import { RecordLayoutEditor } from "./record-layout-editor";
import { RecordPropertyList } from "./record-property-order";
import { RecordPropertiesFold, useRecordDevice } from "./record-properties-fold";
import { recordDateExtras, summaryFields, SUMMARY_VALUES, SUMMARY_VALUES_NARROW } from "@/lib/record-properties";
import { doneRule } from "@/lib/database-settings-schema";
import type { RecordPropertiesChoice } from "@/lib/page-view-prefs";
import {
  defaultRecordLayout,
  emptyCell,
  orderRecordFields,
  recordOpenLabels,
  recordOpenModes,
  type RecordOpenMode,
} from "@/lib/record-layout";
import { visibleViewTabs, viewRecordOpenMode } from "@/lib/view-toolbar";
import { DatabaseToolbarChips } from "./database-toolbar";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { parsePageLocation, pageLocationHash } from "@/lib/page-location";
import { plainClick, relationClick } from "@/lib/related-record";
import { RelatedRecord, useRelatedRecord } from "./related-record";
import { shownPageIcon } from "@/lib/page-link-icons";
import { leaveTo } from "@/lib/history-nav";
import { NEW_TIMELINE, scheduleFields } from "@/lib/database-timeline";
import { RECORD_DROP_EVENT, RECORD_OVER_EVENT, usePointerDrag, type DragPoint, type RecordDropDetail } from "./pointer-drag";
import { keyboardStep, nearestIndex, placementIn, slotFor, type KeyPosition } from "@/lib/pointer-drag";
import { startBoardCardDrag, type BoardCardDrag } from "./board-card-drag";
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
  isTimed,
  validDateValue,
} from "@/lib/date-values";
import { defaultGallery, galleryImage } from "@/lib/database-gallery";
import { cardFields } from "@/lib/card-fields";
import { GalleryCover } from "./gallery-cover";
import { DOCKABLE_VIEWS as dockableViews, neighbourRecord, recordDocks } from "@/lib/side-panel";
import { useRecordDock } from "./record-dock";
// The docked side panel (#392) loads with its first record.
const SidePanel = lazy(() => import("./side-panel"));
import { CoverFrame } from "./cover-frame";
import { primePlaceholder } from "./image-placeholder";
import { ScrollFade } from "./scroll-fade";
import { useStickyTableHead } from "./sticky-table-head";
import type { PageImage } from "@/lib/page-appearance";
import {
  Fragment,
  lazy,
  Suspense,
  type ReactNode,
  useMemo,
  useState,
  useLayoutEffect,
  useRef,
  useEffect,
  useId,
  startTransition,
  ViewTransition,
} from "react";
import {
  appear,
  FLIP_LIMIT,
  flash,
  glide,
  layoutPosition,
  pointerHeld,
  prefersReducedMotion,
  typedRecently,
} from "@/lib/motion";
import { defaultFeed } from "@/lib/database-feed";
import { useFilterClock } from "./use-filter-clock";
import DatabaseFilterEditor from "./database-filter-editor";
import {
  effectiveFilterGroup,
  filterCount,
  hasRelativeFilters,
} from "@/lib/database-filters";
import RowDocument from "./row-document";
import { useAi, useAiAvailability, useAiBlockedHint } from "./ai-context";
import { moduleShownIn, VIEW_MODULE } from "@/lib/feature-modules";
import { moduleOffHere, useHiddenModules } from "@/lib/feature-modules-client";
import type { AiSummaryTarget } from "./ai-summary";
import { UnlinkedMentions } from "./unlinked-mentions";
import { DuplicateHint, RelatedPages } from "./related-pages";
import { useDiscoveryPanelsShown } from "@/lib/discovery-panels-prefs";
import { MarkdownRecordsImport } from "./markdown-records-import";
import { DatabaseExportMenu, RecordExportMenu } from "./record-export";
import { ContactCard, ContactsMenu, LdapMarker, contactLocked, type ContactsData } from "./contacts";
import { RecordToPage } from "./record-to-page";
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
import { CellInput, FieldLabel } from "./cell-input";
import { isMultiPerson, personIds, recordsWithSeveralPeople } from "@/lib/person-values";
import { FieldAccessEditor, FieldLock } from "./field-access-editor";
import { FieldDefaultEditor } from "./field-default-editor";
import { FieldRequiredEditor, RequiredMark, RequiredMissing } from "./field-required";
import { isMissing, isRequired } from "@/lib/field-required";
import { renameDefault } from "@/lib/field-defaults";
import { describeRule } from "@/lib/field-access-rules";
export { CellInput } from "./cell-input";
import { AI_OUTPUT_TYPES, AiCellControl, AiFieldEditor, AiFillAll, AiFillDialog, unknownReferences, useAiDatabaseStatus } from "./ai-database";
import { aiPageReadable, aiUsable, type AiStatus } from "@/lib/ai/client";
import type { FormConfig } from "@/lib/form-settings";
import {
  Plus,
  Sparkle,
  ArrowSquareOut,
  Trash,
  CalendarBlank,
  CaretLeft,
  CaretRight,
  Check,
  UploadSimple,
  SlidersHorizontal,
  Link as LinkIcon,
  DotsSixVertical,
  CaretUp,
  CaretDown,
  Star,
  Funnel,
  ArrowsIn,
  ArrowsOut,
  LockSimple,
  LockSimpleOpen,
  UsersThree,
  Smiley,
  Image as ImageIcon,
  PencilSimple,
  ArrowsOutLineHorizontal,
  BookOpen,
  Copy,
  CopySimple,
  ArrowLeft,
  ArrowRight,
  ShareNetwork,
  QrCode,
  Bell as BellIcon,
  ArrowsClockwise as RecurrenceIcon,
} from "@phosphor-icons/react";
import { RecordShareDialog } from "./record-share-dialog";
import { RecordSubPages } from "./record-sub-pages";
import { isFormattedText } from "@/lib/inline-markdown";
import { studyViewSchema } from "@/lib/study-schema";
import { InlineText } from "./inline-text";
import { Modal, viewIcons, download, Avatar, api, ApiError, PageIcon, requireConnection } from "./ui";
import { CoverPicker } from "./cover-picker";
import { fileLabel, fileUrls } from "@/lib/file-cells";
import type { Backlink } from "@/lib/relation-backlinks";
import {
  parseRecurrence,
  parseRepeat,
  recurrenceLabels,
  recurrenceText,
  type Recurrence,
} from "@/lib/recurrence";
import {
  dateFormats,
  formatFieldDate,
  formatTimestamp,
  isTimestampType,
  fieldUnit,
  formatFieldNumber,
  numberFormats,
  ratingMax,
  timeFormats,
  UNIT_MAX,
  unitFormat,
} from "@/lib/field-format";
import { IconImagePicker } from "./icon-image-picker";
import { DraftInput } from "./draft-input";
import dynamic from "next/dynamic";
import { PageCommentField } from "./page-comment-field";
import { PageComment } from "./page-comment";
import { loadView } from "@/components/view-fallback";
import { rememberViewShape, ViewSkeleton } from "./skeleton";
import { showToast, showUndo, toastSerial, undoShownSince } from "./toast";
import { colorLabel } from "./color-label";
import { OptionColorList } from "./option-color-list";
import { FieldTypeIcon } from "./field-type-icon";
const EmojiPicker = dynamic(() => loadView(() => import("./emoji-picker")), { ssr: false });
// The views besides table, board, gallery and list load when a database
// shows one; their placeholder has the view's shape.
const DatabaseSprints = dynamic(() => loadView(() => import("./database-sprints").then((m) => ({ default: m.DatabaseSprints }))), {
  ssr: false,
  loading: () => <ViewSkeleton type="sprint" />,
});
const DatabaseStudy = dynamic(() => loadView(() => import("./database-study")), { ssr: false, loading: () => <ViewSkeleton type="study" /> });
const DatabaseFeed = dynamic(() => loadView(() => import("./database-feed")), { ssr: false, loading: () => <ViewSkeleton type="feed" /> });
const DatabaseCalendar = dynamic(() => loadView(() => import("./database-calendar")), { ssr: false, loading: () => <ViewSkeleton type="calendar" /> });
const DatabaseTimeline = dynamic(() => loadView(() => import("./database-timeline")), { ssr: false, loading: () => <ViewSkeleton type="timeline" /> });
const DatabaseChart = dynamic(() => loadView(() => import("./database-chart")), { ssr: false, loading: () => <ViewSkeleton type="chart" /> });
// The AI summary dialog (Markdown and code highlighting): loaded with its
// first opening and kept mounted from then on.
const AiSummaryDialog = dynamic(() => loadView(() => import("./ai-summary").then((m) => ({ default: m.AiSummaryDialog }))), { ssr: false });
const DatabaseForm = dynamic(() => loadView(() => import("./database-form")), { ssr: false, loading: () => <ViewSkeleton type="form" /> });
// A record's QR code and the QR label sheets (#448): loaded on first use.
const ItemQrDialog = dynamic(() => loadView(() => import("./item-qr")), { ssr: false });
const QrLabelsDialog = dynamic(() => loadView(() => import("./qr-labels")), { ssr: false });
import { cellText, computedCells, queryRows } from "@/lib/database";
import { parseTitleInput, titleDisplayText, titleEditText, titleMode, titlePlaceholder } from "@/lib/title-input";
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
import { draftKey, draftSent, idempotencyHeaders, idempotencyKeyOf, keyed } from "@/lib/idempotency-key";
import {
  ARM_GRACE_MS,
  reminderLabel,
  reminderOffsets,
  reminderTarget,
  type DateReminder,
} from "@/lib/date-reminder-options";
import { recordPart } from "@/lib/record-context-client";
import { DatabaseOptions, useDatabaseGroups } from "./database-picker";
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
  // Visible properties this person may not change (lib/field-access.ts).
  readOnlyFields?: string[];
  // Contacts databases: records the LDAP directory keeps (lib/contacts.ts).
  contacts?: ContactsData;
  // Whether this person folds the records' properties, on phones and on
  // larger screens (#186; null: the default applies).
  recordPropertiesCollapsed?: RecordPropertiesChoice;
};
// i18n-table: 1 – [German, English] pairs
const fieldNames: Record<FieldType, [string, string]> = {
  text: ["Text", "Text"],
  number: ["Zahl", "Number"],
  date: ["Datum", "Date"],
  select: ["Auswahl", "Select||property type"],
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
  sprint: ["Sprint", "Sprint"],
  aliases: ["Aliasse (andere Namen)", "Aliases (other names)"],
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
// Where a dragged record would land in the view.
type RowDrop = {
  targetId?: string;
  placement: "before" | "after" | "end";
  groupKey?: string;
  // A group's header or cell: after its last record.
  zone?: string;
};
// A record lifted with the keyboard (Space on its handle).
type KeyLift = {
  rowId: string;
  groupKey?: string;
  lists: { key?: string; label?: string; ids: string[] }[];
  from: KeyPosition;
  at: KeyPosition;
  across: boolean;
};
// i18n-table: 1 – [German, English] pairs
const viewTypeNames: Record<View["type"], [string, string]> = {
  table: ["Tabelle", "Table"],
  board: ["Board", "Board"],
  calendar: ["Kalender", "Calendar"],
  gallery: ["Galerie", "Gallery"],
  list: ["Liste", "List"],
  timeline: ["Zeitleiste", "Timeline"],
  form: ["Formular", "Form"],
  chart: ["Diagramm", "Chart"],
  feed: ["Feed", "Feed"],
  sprint: ["Sprints", "Sprints"],
  study: ["Lernen", "Study"],
};
// i18n-table: 1 – [German, English] pairs
const viewTypeHints: Record<View["type"], [string, string]> = {
  table: ["Zeilen und Spalten", "Rows and columns"],
  board: ["Karten in Spalten, z. B. nach Status", "Cards in columns, e.g. by status"],
  calendar: ["Einträge an ihrem Datum", "Records on their date"],
  gallery: ["Karten mit Bildern", "Cards with pictures"],
  list: ["Kompakte Liste", "Compact list"],
  timeline: ["Balken über die Zeit", "Bars over time"],
  form: ["Fragen, die Einträge anlegen", "Questions that create records"],
  chart: ["Balken, Linien, Torten", "Bars, lines, pies"],
  feed: ["Einträge mit Inhalt untereinander", "Records with their content"],
  sprint: ["Backlog und Sprintplanung", "Backlog and sprint planning"],
  study: ["Karten mit Wiederholung in Abständen lernen", "Learn cards with spaced repetition"],
};
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
  ai,
  record,
  onRecordView,
}: {
  // The open record as the workspace shows it (#231): the breadcrumb's last
  // segment and, as a page of its own ("full"), in place of the database's
  // title and actions. null once no record is open. Only with routeNavigation.
  onRecordView?: (view: { rowId: string; title: string; icon: string; full: boolean } | null) => void;
  // AI features of the person (bootstrap); without it no AI controls.
  ai?: AiStatus;
  // Only this record's dialog, on top of another view: a related record
  // opened from a relation cell (#192, components/related-record.tsx).
  // Closing the dialog calls onClose; the views are not shown.
  record?: { id: string; onClose: () => void; onOpenInDatabase: (full?: boolean) => void };
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
  // Failures only; confirmations go to showToast().
  onError: (s: string) => void;
}) {
  const t = useT();
  const tagOptions = useTagOptions();
  const keyHints = useKeyboardHints();
  const stickyHead = useStickyTableHead();
  // "Mit KI zusammenfassen" for the view's records or one record.
  const aiSummarize = useAiAvailability("summarize", page.id);
  const aiBlockedHint = useAiBlockedHint();
  // Record backlinks, unlinked mentions and related pages (#191).
  const discoveryPanels = useDiscoveryPanelsShown();
  // View types of switched-off features are not offered (#378); views that
  // exist keep showing.
  const hiddenModules = useHiddenModules();
  const [aiSummary, setAiSummary] = useState<AiSummaryTarget | null>(null);
  const [aiSummaryUsed, setAiSummaryUsed] = useState(false);
  useEffect(() => {
    if (aiSummary) setAiSummaryUsed(true);
  }, [aiSummary]);
  // The server sends this database's rows once (as rows); relations to
  // itself and rollups read them from here.
  const related = useMemo(
    () => ({ ...data.related, [page.id]: data.rows }),
    [data.related, data.rows, page.id],
  );
  // The databases a relation can link, grouped by space (#520).
  const linkableDatabases = useMemo(() => pages.filter((p) => p.kind === "database" && !p.deleted_at), [pages]);
  const linkableGroups = useDatabaseGroups(linkableDatabases, { pages });
  const [viewId, setViewId] = useState((data.database.views.find((v) => v.default) || data.database.views[0]).id),
    [query, setQuery] = useState(""),
    // Large databases: rows are drawn in steps (see MoreRows).
    [rowLimit, setRowLimit] = useState(ROW_STEP),
    [groupLimits, setGroupLimits] = useState<Record<string, number>>({}),
    [config, setConfig] = useState(false),
    [filterOpen, setFilterOpen] = useState(false),
    [newField, setNewField] = useState(false),
    [newView, setNewView] = useState(false),
    [rowId, setLocalRowId] = useState<string | null>(record?.id ?? null),
    [fieldDraft, setFieldDraft] = useState<
      Field & { bidirectional?: boolean; inverseName?: string }
    >({
      id: "",
      name: "",
      type: "text",
    }),
    // The options field as typed while it has the focus (#304): rebuilt
    // from the trimmed options on every key, a space after a word vanished
    // before the next word came.
    [optionsText, setOptionsText] = useState<string | null>(null),
    [viewName, setViewName] = useState(""),
    [viewType, setViewType] = useState<View["type"]>("table"),
    // Occurrence of a repeating record opened from the calendar.
    [occurrence, setOccurrence] = useState<{
      rowId: string;
      date: string;
      // The calendar's zone, which the date is a day in.
      zone?: string;
    } | null>(null);
  // Everything in the view is dragged with pointer events
  // (components/pointer-drag.ts, #100): rows, cards, columns, view tabs. A
  // click or tap without movement still opens the record or the position
  // dialog. Board cards also open a gap where they land (board-card-drag.ts).
  const startDrag = usePointerDrag();
  const cardDrag = useRef<BoardCardDrag | null>(null),
    // A dropped card waits in its gap until the re-render with the move.
    cardLanding = useRef<{ drag: BoardCardDrag; rows: unknown } | null>(null);
  // The group headers and cells a record can be dropped on (after their
  // last record), filled while rendering.
  const rowZones = useRef(new Map<string, DatabaseGroup>());
  rowZones.current = new Map();
  // Whether a save is running, as of now: a drag is refused when it starts
  // (after the threshold), not when the button went down.
  const busyNow = useRef({ order: false, schema: false });
  const [zoneHint, setZoneHint] = useState<string | null>(null),
    [fieldDrop, setFieldDrop] = useState<string | null>(null),
    [keyLift, setKeyLift] = useState<KeyLift | null>(null);
  // A record just created opens with its title ready for typing.
  const [freshRowId, setFreshRowId] = useState<string | null>(null);
  // The record last opened: its row or card takes the focus back after closing.
  const lastOpened = useRef<string | null>(null);
  function setRowId(id: string | null, occurrence?: string, zone?: string) {
    if (id) lastOpened.current = id;
    // A record opened from a record shown as a page stays a page (#231).
    const full = !!id && routeNavigation && !record && (openMode === "full" || pageRecord);
    setOccurrence(id && occurrence ? { rowId: id, date: occurrence, zone } : null);
    setLocalRowId(id);
    setFullFromUrl(full);
    if (routeNavigation) {
      const hash = pageLocationHash({
        pageId: page.id,
        rowId: id || undefined,
        full,
      });
      ownHash.current = hash;
      // Closing goes back to the database it was opened from – no step of
      // its own in the history; opened by a link from elsewhere, the
      // database is a new step (lib/history-nav.ts).
      if (id) location.hash = hash;
      else leaveTo(hash);
    }
  }
  // Board and gallery cards open their record as a dialog, which fades and
  // scales in like every dialog (#260: nothing flies from the card).
  function closeRecord() {
    setRowId(null);
  }
  // Another field (or a new one) starts from its saved options.
  useEffect(() => setOptionsText(null), [fieldDraft.id, newField]);
  const ownHash = useRef("");
  // A link to a view (#340, "&view=<id>", with "&study=1" its focus mode):
  // the view opens, a study view starts its session (DatabaseStudy). The
  // view then leaves the address, so a reload does not start it again.
  const viewsRef = useRef(data.database.views);
  viewsRef.current = data.database.views;
  const [studyRequest, setStudyRequest] = useState<string | null>(null);
  useEffect(() => {
    if (!routeNavigation) return;
    const navigate = () => {
      const target = parsePageLocation(location.hash);
      if (target?.pageId === page.id && target.viewId) {
        const views = viewsRef.current;
        const wanted = views.find((v) => v.id === target.viewId);
        const shown = wanted || (target.study ? views.find((v) => v.type === "study") : undefined);
        if (shown) setViewId(shown.id);
        if (wanted?.type === "study" && target.study) setStudyRequest(wanted.id);
        if (!wanted)
          showToast({ text: t("Diese Ansicht gibt es nicht mehr – die Datenbank ist geöffnet.", "This view no longer exists – the database is open.") });
        window.history.replaceState(null, "", `${location.pathname}${location.search}${pageLocationHash({ pageId: page.id })}`);
      }
      const rowId = target?.pageId === page.id ? target.rowId || null : null;
      setLocalRowId(rowId);
      setFullFromUrl(!!rowId && !!target?.full);
      // Arriving by a link to a record: its card or row in the view flashes
      // briefly where it is visible, for orientation behind the record.
      if (rowId && location.hash !== ownHash.current)
        requestAnimationFrame(() => {
          const el = boardRef.current?.querySelector(`[data-row-id="${CSS.escape(rowId)}"]`);
          const box = el?.getBoundingClientRect();
          if (box && box.bottom > 0 && box.top < window.innerHeight) flash(el);
        });
      ownHash.current = "";
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
  // A click opened the cell being edited: further clicks of the same
  // double-click land on its editor and are ignored (see tableRow).
  const cellOpenedByClick = useRef(false);
  const [selection, setSelection] = useState<Map<string, number>>(new Map());
  // Right-click on records, and copying or moving them elsewhere.
  const [recordMenu, setRecordMenu] = useState<{ x: number; y: number; rowIds: string[] } | null>(null);
  // View tabs: right-click menu, renaming in place, reordering by dragging.
  const [viewMenu, setViewMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  // The menu of an option's chip (right-click): its colour (#242).
  const [optionMenu, setOptionMenu] = useState<{ x: number; y: number; field: string; option: string } | null>(null);
  const [renamingView, setRenamingView] = useState<string | null>(null);
  const [draggedView, setDraggedView] = useState<string | null>(null);
  const [viewDrop, setViewDrop] = useState<{ id: string; after: boolean } | null>(null);
  const [transfer, setTransfer] = useState<{ rowIds: string[]; mode: "copy" | "move" } | null>(null);
  // "Turn into page": the record whose dialog is open.
  const [toPage, setToPage] = useState<string | null>(null);
  // A record's QR code, and the label sheet: the given records (a
  // selection), or the view's when none are given (#448).
  const [recordQr, setRecordQr] = useState<{ id: string; title: string } | null>(null);
  const [qrLabels, setQrLabels] = useState<{ rowIds: string[] | null } | null>(null);
  // "Vorlage anwenden" on an existing record (components/apply-template.tsx);
  // a template opened for editing (its draft record and the template).
  const [applyTo, setApplyTo] = useState<string | null>(null);
  const [templateDraft, setTemplateDraft] = useState<{ rowId: string; templateId: string } | null>(null);
  const [documentRevision, setDocumentRevision] = useState(0);
  const [bulk, setBulk] = useState<"update" | "delete" | null>(null),
    [bulkField, setBulkField] = useState(""),
    [bulkValue, setBulkValue] = useState<unknown>(undefined),
    [bulkBusy, setBulkBusy] = useState(false);
  // AI in this database: may the person use it here, the queue, fresh cells.
  // From the props or, e.g. for linked databases, from the workspace's AI context.
  const contextAi = useAi().status;
  ai = ai ?? contextAi ?? undefined;
  const canAi = aiUsable(ai, "database") && aiPageReadable(ai, page.id);
  const hasAiFields = data.database.fields.some((f) => f.ai);
  const [aiFill, setAiFill] = useState(false),
    [aiWatch, setAiWatch] = useState(false);
  const aiStatus = useAiDatabaseStatus(page.id, hasAiFields || aiWatch, onRefresh);
  const aiQueued = (queued: number, skipped = 0) => {
    setAiWatch(true);
    aiStatus.watch();
    showToast({
      text: skipped
        ? t(`${queued} Werte werden von der KI berechnet, ${skipped} übersprungen (schon ausgefüllt, schreibgeschützt oder für die KI gesperrt).`, `${queued} values are being computed by the AI, ${skipped} skipped (already filled, read-only or closed to the AI).`)
        : t(`${queued} Werte werden von der KI berechnet.`, `${queued} values are being computed by the AI.`),
    });
  };
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
  // Renamed or merged options waiting for "take the records along?".
  const [optionConfirm, setOptionConfirm] = useState<OptionRename[] | null>(null);
  useEffect(() => {
    if (!newField) setOptionConfirm(null);
  }, [newField]);
  const fieldForm = useRef<HTMLFormElement>(null),
    carryRenames = useRef<boolean | undefined>(undefined);
  // Saves the property again with the panel's answer.
  function answerRenames(carry: boolean) {
    carryRenames.current = carry;
    fieldForm.current?.requestSubmit();
  }
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
  // Record pages open as the view says (else as the database layout says);
  // "Als Seite öffnen" widens the open record to a page until it closes.
  const recordLayout = data.database.recordLayout || defaultRecordLayout;
  // What a new record is called: a task in a task list (lib/seed.ts), a
  // document where records open as a page (notes), otherwise an entry.
  const newRecordTitle = recordLayout.card === "contact"
    ? t("Neuer Kontakt", "New contact")
    : data.database.fields.some((f) => f.id === "status")
    ? t("Neue Aufgabe", "New task")
    : recordLayout.open === "full"
      ? t("Neues Dokument", "New document")
      : t("Neuer Eintrag", "New entry");
  // The address asks for the record as a page of its own (#231, "&full=1").
  const [fullFromUrl, setFullFromUrl] = useState(false);
  const [showEmpty, setShowEmpty] = useState(false),
    [layoutOpen, setLayoutOpen] = useState(false),
    [accessOpen, setAccessOpen] = useState(false);
  // The record's Share menu (#231): links and publishing of this record only.
  const [shareRecord, setShareRecord] = useState<{ id: string; title: string } | null>(null);
  // Records opened for reading on this device (same list as pages, by record
  // id) and records as full pages across the whole width (issue #25).
  const [readRows, setReadRows] = useState<string[]>([]),
    [recordWide, setRecordWide] = useState(false),
    [markdownFiles, setMarkdownFiles] = useState<File[] | null>(null);
  useEffect(() => {
    setReadRows(readModeIds());
    try {
      setRecordWide(localStorage.getItem("flowplan-record-wide") === "1");
    } catch {}
  }, []);
  const toggleRecordReading = (rowId: string) => setReadRows(toggleReadMode(rowId));
  const toggleRecordWide = () =>
    setRecordWide((wide) => {
      try {
        if (wide) localStorage.removeItem("flowplan-record-wide");
        else localStorage.setItem("flowplan-record-wide", "1");
      } catch {}
      return !wide;
    });
  // "Seiten in voller Breite anzeigen" (#257): every record as a page at
  // full width for this person; the switch then shows as on and locked.
  const allWide = useFullWidthPages();
  const recordFullWidth = recordWide || allWide;
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
    cardWidth = useRef(0),
    cardView = useRef(""),
    lastMove = useRef(0),
    lastMovedId = useRef<string | null>(null);
  const [orderStatus, setOrderStatus] = useState("");
  const importRef = useRef<HTMLInputElement>(null);
  // The database as it is now, for "Undo" after it changed (#242).
  const databaseRef = useRef(data.database);
  databaseRef.current = data.database;
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
  const viewRecordMode = viewRecordOpenMode(view, recordLayout);
  // "Seitenleiste" beside the view (#392): the view narrows, the panel
  // takes the right column. Too narrow for that: a page of its own (a
  // dialog across the window where the database is not the page itself).
  const docking = viewRecordMode === "side" && recordDocks(view.type, view.sidePanel);
  const dockRoom = useRecordDock();
  const openMode: RecordOpenMode = docking && !dockRoom ? "full" : viewRecordMode;
  // The open record as a page of its own in the main area (#231): asked
  // for by the address or by the view's setting "Ganze Seite" – only for
  // the database opened as the page itself. Elsewhere (a linked database,
  // a related record on top) "Ganze Seite" stays a dialog across the window.
  const pageRecord = routeNavigation && !record && !!rowId && (fullFromUrl || openMode === "full") && data.rows.some((r) => r.id === rowId);
  const recordMode: RecordOpenMode = pageRecord ? "full" : openMode;
  const docked = docking && dockRoom && !record && !pageRecord && !!rowId;
  // The first column (and the selection cell before it) stays in place while
  // the table scrolls sideways.
  // Next to the selection column (wider on touch screens: --selection-column);
  // on phones the selection column scrolls away and the pinned column is at
  // most about 40 % of the table wide (lib/pinned-column.ts, #98).
  const stickyOffset = pinnedColumnLeft(editable);
  const stickyCell = (field: Field, index: number) =>
    index === 0
      ? { className: "sticky-col sticky-col-end", style: { left: stickyOffset } }
      : { className: "", style: undefined };
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
  // The next placeholder of this database has the shape of this view.
  useEffect(() => rememberViewShape(page.id, view.type), [page.id, view.type]);
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
          // A date column as wide as its format needs (#523).
          defaultColumnWidth(field, field.id === fields[0].id);
  }
  async function moveColumn(source: string, target: string) {
    const order = orderedFields.map((f) => f.id).filter((id) => id !== source);
    order.splice(order.indexOf(target), 0, source);
    await updateView({ fieldOrder: order });
  }
  // Duplicate or delete the records of the right-click menu.
  async function recordsAction(rowIds: string[], operation: "duplicate" | "delete") {
    const list = data.rows.filter((r) => rowIds.includes(r.id));
    if (operation === "delete" && list.length > 1 && !window.confirm(t(`${list.length} Einträge löschen?`, `Delete ${list.length} records?`))) return;
    const since = toastSerial();
    if (operation === "delete") setSelection(new Map());
    const result = await act({ action: "rows.bulk", operation, rows: list.map((r) => ({ id: r.id, version: r.version })) });
    if (result) {
      setSelection(new Map());
      // The workspace offers "Rückgängig" for the deletion itself.
      if ((list.length > 1 || operation === "delete") && !undoShownSince(since))
        showToast({
          text:
            operation === "delete"
              ? list.length === 1
                ? t("1 Eintrag in den Papierkorb gelegt.", "1 record moved to the trash.")
                : t(`${list.length} Einträge in den Papierkorb gelegt.`, `${list.length} records moved to the trash.`)
              : t(`${list.length} Einträge dupliziert.`, `${list.length} records duplicated.`),
        });
    }
  }
  async function bulkAction(operation: "update" | "duplicate" | "delete") {
    setBulkBusy(true);
    const since = toastSerial();
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
      if (!undoShownSince(since))
        showToast({
          text:
            operation === "update"
              ? t(`${selectionRows.length} Einträge aktualisiert. Vorheriger Stand im Versionsverlauf gesichert.`, `${selectionRows.length} records updated. The previous state was saved in the version history.`)
              : operation === "duplicate"
                ? t(`${selectionRows.length} Einträge dupliziert. Vorheriger Stand im Versionsverlauf gesichert.`, `${selectionRows.length} records duplicated. The previous state was saved in the version history.`)
                : t(`${selectionRows.length} Einträge gelöscht. Vorheriger Stand im Versionsverlauf gesichert.`, `${selectionRows.length} records deleted. The previous state was saved in the version history.`),
        });
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
        { members, sprints: data.database.settings?.sprints },
      ),
    [data, fields, view, query, filterNow, members],
  );
  const selected = data.rows.find((r) => r.id === rowId);
  // While a record is docked: ↑/↓ open the one before or after it in the
  // view's order (as shown), and its row, card or bar is marked.
  const dockedId = docked && selected ? selected.id : null;
  const openRow = useRef(setRowId);
  openRow.current = setRowId;
  useEffect(() => {
    if (!dockedId) return;
    const key = (e: KeyboardEvent) => {
      if ((e.key !== "ArrowDown" && e.key !== "ArrowUp") || e.defaultPrevented || e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
      const target = e.target as Element | null;
      if (target?.closest?.("input, textarea, select, [contenteditable=true], [role=listbox], [role=menu], .modal") || document.querySelector('[aria-modal="true"]')) return;
      const root = boardRef.current;
      const ids = [...(root?.querySelectorAll<HTMLElement>("[data-row-id]") || [])].map((el) => el.dataset.rowId || "");
      const next = neighbourRecord(ids, dockedId, e.key === "ArrowDown" ? 1 : -1);
      if (!next) return;
      e.preventDefault();
      openRow.current(next);
      root?.querySelector(`[data-row-id="${CSS.escape(next)}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [dockedId]);
  useEffect(() => {
    const root = boardRef.current;
    if (!root) return;
    for (const el of root.querySelectorAll<HTMLElement>("[data-docked]")) if (el.dataset.rowId !== dockedId) delete el.dataset.docked;
    if (dockedId) for (const el of root.querySelectorAll<HTMLElement>(`[data-row-id="${CSS.escape(dockedId)}"]`)) el.dataset.docked = "";
  });
  // A related record on top of another view (#192): it closes with its
  // dialog (or once it is gone: deleted, moved, turned into a page).
  const recordGone = !!record && !selected;
  const recordRef = useRef(record);
  recordRef.current = record;
  useEffect(() => {
    if (recordGone) recordRef.current?.onClose();
  }, [recordGone]);
  // Records of other databases from relation cells open on top (#192).
  const relatedRecord = useRelatedRecord();
  const selectedEditable = editable && selected?.role !== "viewer";
  // Open for reading: the text without editing, handles or block menus.
  const readingRecord = !!selected && selectedEditable && readRows.includes(selected.id);
  const toggleReadingRef = useRef<() => void>(() => {});
  toggleReadingRef.current = () => {
    if (selected && selectedEditable) toggleRecordReading(selected.id);
  };
  useEffect(() => {
    if (!selected) return;
    // ⌘⌥E as for pages; caught before the page's own shortcut.
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.altKey && !e.shiftKey && e.code === "KeyE") {
        e.preventDefault();
        e.stopImmediatePropagation();
        toggleReadingRef.current();
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [selected]);
  // The open record for the workspace (#231): its breadcrumb and, as a
  // page, the page around it. Before painting, so the database's title
  // never flashes above a record page.
  // The title as text, formatted like the table's first column (#529): a
  // date title "23.11.2026", a number with its unit, a formula's result.
  function computedTitleText(row: Row) {
    return titleDisplayText(fields[0], computedCells(row, fields, related, data.relatedSchemas)[fields[0].id], { members });
  }
  function recordTitleText(row: Row) {
    const mode = titleMode(fields[0]);
    if (mode === "readonly") return computedTitleText(row);
    const v = row.cells[fields[0]?.id || "title"];
    return mode === "text" ? cellText(v) : titleDisplayText(fields[0], v, { members });
  }
  // A title of another type than text (#529) reads as in the table.
  const recordTitle = selected ? recordTitleText(selected) || t("Ohne Titel", "Untitled") : "";
  const reportRecord = useRef(onRecordView);
  reportRecord.current = onRecordView;
  useLayoutEffect(() => {
    reportRecord.current?.(selected && !record ? { rowId: selected.id, title: recordTitle, icon: selected.icon || "", full: pageRecord } : null);
  }, [selected?.id, selected?.icon, recordTitle, pageRecord, record]);
  useLayoutEffect(() => () => reportRecord.current?.(null), []);
  // A record page starts at its top; back on the database, the view is
  // where it was.
  const viewScroll = useRef(0);
  useLayoutEffect(() => {
    const scroller = boardRef.current?.closest<HTMLElement>(".main-scroll");
    if (!scroller) return;
    if (pageRecord) {
      scroller.scrollTop = 0;
      return;
    }
    const top = viewScroll.current;
    if (top) scroller.scrollTop = top;
    const keep = () => void (viewScroll.current = scroller.scrollTop);
    scroller.addEventListener("scroll", keep, { passive: true });
    return () => scroller.removeEventListener("scroll", keep);
  }, [pageRecord, selected?.id]);
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
  // The record's header: open as a page, favorite, permissions, layout.
  const recordActions = (row: Row) => {
    const starred = favoriteRows.some((f) => f.rowId === row.id);
    const access = row.access || "inherit";
    const AccessIcon =
      access === "inherit" ? UsersThree : access === "private" ? LockSimple : LockSimpleOpen;
    const backLabel = t(`Zurück zur Ansicht „${t(recordOpenLabels[viewRecordMode])}“`, `Back to “${t(recordOpenLabels[viewRecordMode])}”`);
    // The record as a page of its own (#231): a real link, so it also
    // opens in a new tab or window.
    const pageHash = pageLocationHash({ pageId: page.id, rowId: row.id, full: true });
    return (
      <>
        {pageRecord ? (
          openMode !== "full" && (
            <button
              type="button"
              className="icon-button record-page-toggle active"
              aria-pressed
              aria-label={backLabel}
              title={backLabel}
              // Back to the dialog it came from, or to a new one.
              onClick={() => leaveTo(pageLocationHash({ pageId: page.id, rowId: row.id }))}
            >
              <ArrowsIn size={17} />
            </button>
          )
        ) : (
          <a
            className="icon-button record-page-toggle"
            href={pageHash}
            aria-label={t("Als Seite öffnen", "Open as page")}
            title={t("Als Seite öffnen", "Open as page")}
            onClick={(e) => {
              if (!plainClick(e)) return;
              e.preventDefault();
              if (record) return record.onOpenInDatabase(true);
              if (!routeNavigation) setLocalRowId(null);
              location.hash = pageHash;
            }}
          >
            <ArrowsOut size={17} />
          </a>
        )}
        {recordMode === "full" && (
          <button
            type="button"
            className={`icon-button${recordFullWidth ? " active" : ""}`}
            aria-pressed={recordFullWidth}
            aria-label={t("Volle Breite", "Full width")}
            title={
              allWide
                ? t("Volle Breite – deine Einstellung „Seiten in voller Breite anzeigen“ ist an", "Full width – your setting “Show pages at full width” is on")
                : t("Volle Breite", "Full width")
            }
            disabled={allWide}
            onClick={toggleRecordWide}
          >
            <ArrowsOutLineHorizontal size={17} />
          </button>
        )}
        <span className="modal-heading-divider" aria-hidden="true" />
        {editable && row.role !== "viewer" && (
          <button
            type="button"
            className={`icon-button read-mode-toggle${readRows.includes(row.id) ? " active" : ""}`}
            aria-pressed={readRows.includes(row.id)}
            aria-label={readRows.includes(row.id) ? t("Bearbeiten", "Edit") : t("Lesemodus", "Reading mode")}
            title={(readRows.includes(row.id) ? t("Bearbeiten", "Edit") : t("Lesemodus", "Reading mode")) + keyHints.suffix("Mod+Alt+E")}
            onClick={() => toggleRecordReading(row.id)}
          >
            {readRows.includes(row.id) ? <PencilSimple size={17} /> : <BookOpen size={17} />}
          </button>
        )}
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
        <button
          type="button"
          className="icon-button"
          aria-label={t("Link kopieren", "Copy link")}
          title={t("Link kopieren", "Copy link")}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(
                `${location.origin}${location.pathname}${pageLocationHash({ pageId: page.id, rowId: row.id, full: pageRecord })}`,
              );
              showToast({ text: t("Link kopiert", "Link copied") });
            } catch {
              onError(t("Link konnte nicht kopiert werden.", "The link could not be copied."));
            }
          }}
        >
          <LinkIcon size={17} />
        </button>
        {editable && row.role !== "viewer" && (
          // Share this record alone (#231); the database's Share stays with the database.
          <button
            type="button"
            className={pageRecord ? "button compact share-button record-share-button" : "icon-button record-share-button"}
            aria-label={t("Eintrag teilen", "Share record")}
            title={t("Eintrag teilen", "Share record")}
            onClick={() => setShareRecord({ id: row.id, title: cellText(row.cells[fields[0]?.id || "title"]) || t("Ohne Titel", "Untitled") })}
          >
            <ShareNetwork size={pageRecord ? 15 : 17} />
            {pageRecord && t("Teilen", "Share")}
          </button>
        )}
        {aiSummarize !== "hidden" && (
          <button
            type="button"
            className="icon-button"
            aria-disabled={aiSummarize === "blocked" || undefined}
            aria-label={t("Mit KI zusammenfassen", "Summarise with AI")}
            title={aiSummarize === "blocked" ? aiBlockedHint : t("Mit KI zusammenfassen", "Summarise with AI")}
            onClick={() => {
              if (aiSummarize !== "ok") return;
              setAiSummary({ pageId: page.id, rowId: row.id, title: cellText(row.cells[fields[0]?.id || "title"]) || t("Eintrag", "Record"), kind: "record" });
            }}
          >
            <Sparkle size={17} />
          </button>
        )}
        <RecordExportMenu
          pageId={page.id}
          rowId={row.id}
          title={cellText(row.cells[fields[0]?.id || "title"]) || t("Eintrag", "Record")}
          printRoot={() => document.querySelector<HTMLElement>(pageRecord ? ".record-page .row-detail" : ".modal .row-detail")}
          onError={onError}
          onToPage={editable && row.role !== "viewer" ? () => setToPage(row.id) : undefined}
          onApplyTemplate={editable && row.role !== "viewer" && data.rowTemplates?.length ? () => setApplyTo(row.id) : undefined}
          onQr={() => setRecordQr({ id: row.id, title: cellText(row.cells[fields[0]?.id || "title"]) || t("Ohne Titel", "Untitled") })}
        />
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
  // Properties shown on the record page (layout: their order, hidden and
  // empty ones).
  const layoutFields = orderRecordFields(fields, recordLayout.order).filter(
    (f, i) => i === 0 || !recordLayout.hidden.includes(f.id),
  );
  const emptyFields = new Set(
    recordLayout.hideEmpty && selected
      ? layoutFields
          .filter(
            (f, i) =>
              i > 0 &&
              !computedTypes.includes(f.type) &&
              // A required property without a value stays in sight (#443).
              !isRequired(f) &&
              emptyCell(selected.cells[f.id], f.type),
          )
          .map((f) => f.id)
      : [],
  );
  // The title is edited in the heading, not again among the properties.
  const recordFields = (
    showEmpty ? layoutFields : layoutFields.filter((f) => !emptyFields.has(f.id))
  ).filter((f) => f.id !== fields[0]?.id);
  // The recurrence and repeating task below the first date (#521): only
  // where they apply, hidden like empty properties while nothing is set.
  const firstDateId = fields.find((f) => f.type === "date")?.id;
  const dateExtras =
    selected && firstDateId && layoutFields.some((f) => f.id === firstDateId)
      ? recordDateExtras({
          hideEmpty: recordLayout.hideEmpty,
          showEmpty,
          hasRecurrence: !!parseRecurrence(selected.recurrence),
          hasRepeat: !!parseRepeat(selected.repeat),
          canRepeat: !!doneRule(fields, data.database.settings),
        })
      : null;
  const emptyHidden = emptyFields.size + (dateExtras?.hiddenEmpty ?? 0);
  // The folded properties (#186): a few values as chips, most telling first.
  const recordDevice = useRecordDevice();
  const recordSummary = selected
    ? summaryFields(
        recordFields.filter((f) => !computedTypes.includes(f.type) && !isFormattedText(f, fields)),
        selected.cells,
        recordDevice === "phone" ? SUMMARY_VALUES_NARROW : SUMMARY_VALUES,
        doneRule(fields, data.database.settings)?.field.id,
      )
    : null;
  // A link to a record this tab has not loaded yet (just made in another
  // tab, by a rule or through the API): the live signal brings it, but the
  // open page is fetched at most every few seconds
  // (components/use-workspace-signals.ts). Ask once at once; only a record
  // still missing then is gone.
  const [rowAskedFor, setRowAskedFor] = useState<string | null>(null);
  const rowAsking = useRef<string | null>(null);
  useEffect(() => {
    if (!rowId || selected) return;
    if (rowAsking.current !== rowId) {
      rowAsking.current = rowId;
      void onRefresh()
        .catch(() => {})
        .finally(() => setRowAskedFor(rowId));
      return;
    }
    if (rowAskedFor === rowId)
      onError(t("Dieser Datensatz ist nicht mehr verfügbar.", "This record is no longer available."));
  }, [rowId, selected, rowAskedFor, onError, onRefresh]);
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
  // The selected records as the clipboard gets them (issue #119): the
  // visible properties in view order, the records in the order the table
  // shows them (groups, subtask tree), with their computed values.
  // The records in the order the view shows them (groups, subtask tree),
  // each once; with `only`, just those.
  function viewOrder(only?: { has: (id: string) => boolean }) {
    const order = grouped
      ? groups.flatMap((g) =>
          subgroups.has(g.key)
            ? subgroups.get(g.key)!.flatMap((sg) => sg.rows)
            : g.rows,
        )
      : treeParent
        ? treeOrder(shown, treeParent).map((x) => x.row)
        : shown;
    const seen = new Set<string>();
    return [...order, ...shown].filter(
      (r) => (!only || only.has(r.id)) && !seen.has(r.id) && !!seen.add(r.id),
    );
  }
  function selectionClipboard() {
    const rows = viewOrder(selection);
    if (!rows.length) return null;
    return {
      count: rows.length,
      ...recordsClipboard(visibleFields, rows, clipboardContext()),
    };
  }
  // Cells as people read them (names, formatted numbers and dates): the
  // clipboard and the QR labels (#448).
  function clipboardContext(): ClipboardContext {
    return {
      members,
      related,
      files: data.files,
      sprints: data.database.settings?.sprints,
      yes: t("Ja", "Yes"),
      no: t("Nein", "No"),
      untitled: t("Ohne Titel", "Untitled"),
      unavailable: t("Nicht verfügbar", "Not available"),
    };
  }
  // Names for the ids in cells, for the CSV export and import.
  const csvContext = (): CsvContext => ({
    members,
    related,
    // Relations to this database itself find its titles here.
    relatedSchemas: { ...data.relatedSchemas, [page.id]: fields },
    files: data.files,
    sprints: data.database.settings?.sprints,
    untitled: t("Ohne Titel", "Untitled"),
    unavailable: t("Nicht verfügbar", "Not available"),
  });
  const copiedMessage = (count: number) =>
    count === 1 ? t("1 Eintrag kopiert", "1 record copied") : t(`${count} Einträge kopiert`, `${count} records copied`);
  async function copySelection() {
    const copy = selectionClipboard();
    if (!copy) return;
    try {
      if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write)
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/plain": new Blob([copy.text], { type: "text/plain" }),
            "text/html": new Blob([copy.html], { type: "text/html" }),
          }),
        ]);
      else await navigator.clipboard.writeText(copy.text);
      showToast({ text: copiedMessage(copy.count) });
    } catch {
      onError(t("Die Zwischenablage ist nicht verfügbar.", "The clipboard is not available."));
    }
  }
  // ⌘C / Ctrl+C (and Edit › Copy) with selected records and nothing else to
  // copy: no text selected, the focus not in a field or editable cell.
  const selectionCopy = useRef(selectionClipboard);
  selectionCopy.current = selectionClipboard;
  const copiedText = useRef(copiedMessage);
  copiedText.current = copiedMessage;
  const copyEnabled = editable && view.type === "table" && selection.size > 0;
  useEffect(() => {
    if (!copyEnabled) return;
    const copy = (e: ClipboardEvent) => {
      if (e.defaultPrevented || !e.clipboardData) return;
      const active = document.activeElement as HTMLElement | null;
      // A ticked checkbox keeps the focus: that still copies the records.
      const textInput =
        active instanceof HTMLInputElement &&
        !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"].includes(active.type);
      if (
        textInput ||
        active?.closest("textarea, select, [contenteditable]:not([contenteditable='false']), [role='dialog']") ||
        (window.getSelection()?.toString() || "") !== ""
      )
        return;
      const result = selectionCopy.current();
      if (!result) return;
      e.preventDefault();
      e.clipboardData.setData("text/plain", result.text);
      e.clipboardData.setData("text/html", result.html);
      showToast({ text: copiedText.current(result.count) });
    };
    document.addEventListener("copy", copy);
    return () => document.removeEventListener("copy", copy);
  }, [copyEnabled]);
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
  // Properties only some people change (field-level permissions).
  const lockedFields = new Set(data.readOnlyFields || []);
  const lockedTitle = (f: Field, r?: Row) =>
    lockedFields.has(f.id)
      ? describeRule(f.access?.write, "write", data.groups || [], t)
      : r && contactLocked(data.contacts, r.id, f.id)
        ? t("Kommt aus dem LDAP-Verzeichnis und wird dort gepflegt.", "Comes from the LDAP directory and is kept there.")
        : undefined;
  // Also properties of contacts the LDAP directory keeps (lib/contacts.ts).
  const fieldLocked = (r: Row, f: Field) => lockedFields.has(f.id) || contactLocked(data.contacts, r.id, f.id);
  // Changes of one record go through one path (lib/row-queue.ts): one after
  // the other, each with the newest version known – the server's answer to
  // the previous change, not only the reloaded data, which may arrive later
  // (#104). A change of properties also says which values it was made on,
  // so a newer version that changed only other properties does not refuse it.
  const rowsNow = useRef(data.rows);
  rowsNow.current = data.rows;
  // The database's version as last loaded: a drag ends in a later render
  // than it began (its own previous move may have been saved meanwhile).
  const versionNow = useRef(data.database.version);
  versionNow.current = data.database.version;
  // The database's version once this person's last change of the schema
  // is saved (see updateSchema).
  const expectedVersion = useRef(0);
  const rowChange = <T,>(b: Record<string, unknown>, send: (body: Record<string, unknown>) => Promise<T>) => {
    const rowId = typeof b.rowId === "string" ? b.rowId : null;
    const shown = () => rowsNow.current.find((r) => r.id === rowId)?.version;
    const withBase =
      b.action === "row.update" && rowId && b.cells && typeof b.cells === "object" && b.base === undefined
        ? { ...b, base: patchBase(rowsNow.current.find((r) => r.id === rowId)?.cells, b.cells as Record<string, unknown>) }
        : b;
    return rowChanges.run(withBase, shown, send);
  };
  const act = async (b: Record<string, unknown>) => {
    try {
      return await rowChange(b, (sent) => {
        // The action's Idempotency-Key stays with it (lib/idempotency-key.ts).
        const key = idempotencyKeyOf(sent);
        const body = { pageId: page.id, ...sent };
        return mutate(key ? keyed(body, key) : body);
      });
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
    optionRenames?: OptionRename[],
  ) {
    setSchemaBusy(true);
    // Sent: the views shown carry it at once (lib/optimistic-commands.ts),
    // the server counts one version on when it takes it (a relation may
    // change more); a refused change leaves the version to the data.
    if (!relation) expectedVersion.current = Math.max(expectedVersion.current, version + 1);
    try {
      const result = await act({
        action: "database.update",
        version,
        fields: nextFields,
        views: nextViews,
        relation,
        ...(optionRenames?.length ? { optionRenames } : {}),
      });
      if (!result) expectedVersion.current = 0;
      return result;
    } finally {
      setSchemaBusy(false);
    }
  }
  const views = data.database.views;
  const viewTabs = visibleViewTabs(views, view.id);
  function renameView(id: string, name: string) {
    return updateSchema(fields, views.map((v) => (v.id === id ? { ...v, name } : v)));
  }
  function reorderView(id: string, beside: string, after: boolean) {
    const moving = views.find((v) => v.id === id);
    if (!moving || id === beside) return;
    const rest = views.filter((v) => v.id !== id);
    const at = rest.findIndex((v) => v.id === beside) + (after ? 1 : 0);
    return updateSchema(fields, [...rest.slice(0, at), moving, ...rest.slice(at)]);
  }
  async function duplicateView(id: string) {
    const source = views.find((v) => v.id === id);
    if (!source) return;
    const copy: View = { ...structuredClone(source), id: crypto.randomUUID(), default: undefined, name: t(`${source.name} (Kopie)`, `${source.name} (copy)`).slice(0, 80) };
    const at = views.indexOf(source) + 1;
    if (await updateSchema(fields, [...views.slice(0, at), copy, ...views.slice(at)])) setViewId(copy.id);
  }
  // One view per database opens first; choosing it again goes back to the first tab.
  function setDefaultView(id: string) {
    const on = !views.find((v) => v.id === id)?.default;
    return updateSchema(fields, views.map((v) => ({ ...v, default: on && v.id === id ? true : undefined })));
  }
  async function deleteView(id: string) {
    if (views.length < 2) return;
    const gone = views.find((v) => v.id === id);
    if (!gone || !window.confirm(t(`Ansicht „${gone.name}“ löschen? Die Einträge bleiben erhalten.`, `Delete the view “${gone.name}”? The records are kept.`))) return;
    const rest = views.filter((v) => v.id !== id);
    if (await updateSchema(fields, rest)) if (viewId === id) setViewId(rest[Math.max(0, views.indexOf(gone) - 1)].id);
  }
  async function updateView(patch: Partial<View>) {
    return updateSchema(
      fields,
      data.database.views.map((v) =>
        v.id === view.id ? { ...v, ...patch } : v,
      ),
      undefined,
      // Two settings in a row: the views shown already carry the first
      // while its reload, and with it the database's new version, may still
      // be on its way.
      Math.max(data.database.version, expectedVersion.current),
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
  // A move is an intent – this record into that group, at that place. When
  // the server refuses it only because the versions it carried are out of
  // date (someone else's change not shown yet, e.g. without live updates
  // behind a proxy, #445), it goes once more with the current ones. The
  // server still refuses it when the record left its group or the target
  // moved meanwhile, so nobody's concurrent change is overwritten.
  async function sendMove(b: Record<string, unknown> & RowMove) {
    const send = (body: Record<string, unknown>) =>
      rowChange(body, (sent) => mutate({ pageId: page.id, ...sent }));
    try {
      return await send(b);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 409 || b.clearSorts || !(await caughtUp(b))) {
        onError((e as Error).message);
        return null;
      }
    }
    try {
      const row = rowsNow.current.find((r) => r.id === b.rowId);
      if (!row) return null;
      return await send({ ...b, version: versionNow.current, rowVersion: row.version });
    } catch (e) {
      onError((e as Error).message);
      return null;
    }
  }
  // Reloads the data; true once it shows a newer version of the database
  // or of the record than the move was sent with.
  async function caughtUp(b: RowMove) {
    const newer = () =>
      versionNow.current !== b.version ||
      (rowsNow.current.find((r) => r.id === b.rowId)?.version ?? b.rowVersion) !== b.rowVersion;
    try {
      await onRefresh();
    } catch {
      return false;
    }
    // The reloaded data reaches the refs with the next render.
    for (let i = 0; i < 20 && !newer(); i++) await new Promise((done) => setTimeout(done, 25));
    return newer() && rowsNow.current.some((r) => r.id === b.rowId);
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
      const result = await sendMove({ action: "row.move", ...move, clearSorts });
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
  // A record dropped at `drop`: the same move (and group change) as the
  // position dialog. The drop is placed on the layout when it ends, so it
  // goes with the database's version then – not the one when the drag
  // began, which the save of a move just before may have replaced.
  function commitRowDrop(
    row: Row,
    from: string | undefined,
    drop: RowDrop,
    version = versionNow.current,
  ) {
    if (drop.targetId === row.id) return;
    const change =
      drop.groupKey !== undefined && from !== undefined
        ? groupChange(from, drop.groupKey)
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
    return submitMove({
      viewId: view.id,
      version,
      rowId: row.id,
      rowVersion: row.version,
      targetId: drop.targetId,
      placement: drop.targetId ? drop.placement : "end",
      ...(change && canGroupEdit ? change : {}),
    });
  }
  // What is under the pointer while a record is dragged: another record
  // (before or after it, by the half), a group's header or cell (after its
  // last record), a database in the sidebar, or nothing.
  function rowDropAt(
    point: DragPoint,
    row: Row,
  ): RowDrop | { page: string } | null {
    const el = point.target;
    if (!el) return null;
    const target = pageAt(point);
    if (target) return { page: target };
    const root = boardRef.current;
    if (!root?.contains(el)) return null;
    const at = (item: HTMLElement): RowDrop | null =>
      item.dataset.rowId === row.id
        ? null
        : {
            targetId: item.dataset.rowId,
            groupKey: item.dataset.rowGroup,
            placement: placementIn(item.getBoundingClientRect(), point.x, point.y),
          };
    const item = el.closest<HTMLElement>("[data-row-id]");
    if (item && root.contains(item)) return at(item);
    const zone = el.closest<HTMLElement>("[data-row-zone]");
    const group = zone && rowZones.current.get(zone.dataset.rowZone!);
    if (group) {
      const last = group.rows.filter((r) => r.id !== row.id).at(-1);
      return {
        targetId: last?.id,
        placement: last ? "after" : "end",
        groupKey: group.key,
        zone: group.key,
      };
    }
    // In the gap between two cards or rows: the nearest one.
    const items = [...root.querySelectorAll<HTMLElement>("[data-row-id]")];
    const near = nearestIndex(
      items.map((i) => i.getBoundingClientRect()),
      point.x,
      point.y,
      24,
    );
    return near >= 0 ? at(items[near]) : null;
  }
  busyNow.current = { order: orderBusy, schema: schemaBusy };
  const pageAt = (point: DragPoint) =>
    point.target?.closest<HTMLElement>("[data-record-drop-page]")?.dataset.recordDropPage ?? null;
  function dropOnPage(row: Row, targetPageId: string, copy: boolean) {
    window.dispatchEvent(
      new CustomEvent<RecordDropDetail>(RECORD_DROP_EVENT, {
        detail: { pageId: page.id, rowId: row.id, targetPageId, copy },
      }),
    );
  }
  function recordOver(targetPageId: string | null) {
    window.dispatchEvent(
      new CustomEvent(RECORD_OVER_EVENT, { detail: { targetPageId } }),
    );
  }
  // Rows, list and feed entries and cards (except on a plain board, see
  // beginCardDrag) by their handle or, with the mouse, the card itself.
  function beginRowDrag(
    e: React.PointerEvent<HTMLElement>,
    row: Row,
    groupKey: string | undefined,
    touch: "hold" | "none",
  ) {
    if (!editable || !viewEditable) return;
    const item = e.currentTarget.closest<HTMLElement>("[data-row-id]");
    if (!item) return;
    let over: string | null = null;
    const clear = () => {
      setDropHint(null);
      setZoneHint(null);
      if (over) recordOver((over = null));
    };
    startDrag(e, {
      touch,
      // A card's face, without the wrapper around it.
      preview: item.querySelector<HTMLElement>(":scope > .record-card") || item,
      source: item,
      onStart: () => {
        if (busyNow.current.order) return false;
        setKeyLift(null);
      },
      onMove: (point) => {
        const drop = rowDropAt(point, row);
        const page = drop && "page" in drop ? drop.page : null;
        if (page !== over) recordOver((over = page));
        if (!drop || "page" in drop) {
          setDropHint(null);
          setZoneHint(null);
          return;
        }
        setZoneHint(drop.zone ?? null);
        setDropHint(
          drop.targetId && drop.placement !== "end"
            ? { id: drop.targetId, groupKey: drop.groupKey, placement: drop.placement }
            : null,
        );
      },
      onDrop: (point) => {
        const drop = rowDropAt(point, row);
        clear();
        if (!drop) return;
        if ("page" in drop) return dropOnPage(row, drop.page, point.altKey);
        void commitRowDrop(row, groupKey, drop);
      },
      onCancel: clear,
    });
  }
  function dropClass(row: Row, groupKey?: string) {
    return `${
      dropHint?.id === row.id && dropHint.groupKey === groupKey
        ? `order-drop-${dropHint.placement}`
        : ""
    }${keyLift?.rowId === row.id && keyLift.groupKey === groupKey ? " row-lifted" : ""}`;
  }
  // Group headers and cells take a dropped record after their last one.
  function rowZone(group: DatabaseGroup) {
    rowZones.current.set(group.key, group);
    return {
      "data-row-zone": group.key,
      "data-zone-hint": zoneHint === group.key ? "" : undefined,
    };
  }
  // Records glide to their new places (FLIP) instead of jumping: after a
  // move, a sort or filter change, a move between columns and live changes
  // from others. Positions are relative to the view's content, so scrolling
  // does not count as movement. Nothing glides on the first render, for
  // changes made by typing (search field) or while a pointer is held
  // (resizing, dragging), in large views or with reduced motion.
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
    if (items.length > 500) {
      cardPositions.current = new Map();
      return;
    }
    const origin = root.getBoundingClientRect();
    const own = Date.now() - lastMove.current < 3000,
      width = root.offsetWidth,
      resized = width !== cardWidth.current;
    cardWidth.current = width;
    const animate =
      items.length <= FLIP_LIMIT &&
      !resized &&
      !prefersReducedMotion() &&
      (own || (!typedRecently() && !pointerHeld()));
    const seen = new Map<string, number>(),
      next = new Map<string, { x: number; y: number }>(),
      previous = cardView.current === view.id ? cardPositions.current : new Map<string, { x: number; y: number }>();
    cardView.current = view.id;
    const fresh: HTMLElement[] = [];
    for (const el of items) {
      const id = el.dataset.rowId!,
        n = seen.get(id) || 0;
      seen.set(id, n + 1);
      const key = `${view.id}:${id}:${n}`,
        at = layoutPosition(el, root, origin),
        seed = n === 0 ? seeds?.get(id) : undefined;
      let before = previous.get(key);
      if (seed) {
        const rect = el.getBoundingClientRect();
        before = { x: at.x + seed.left - rect.left, y: at.y + seed.top - rect.top };
      }
      next.set(key, at);
      if (!animate) continue;
      if (!before) {
        if (previous.size) fresh.push(el);
        continue;
      }
      const dx = before.x - at.x,
        dy = before.y - at.y;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      const moved = own && id === lastMovedId.current;
      if (moved) el.classList.add("row-sliding");
      const glided = glide(el, { x: dx, y: dy }, { duration: moved ? 320 : 220 });
      if (moved) {
        const done = () => el.classList.remove("row-sliding");
        if (glided) glided.finished.then(done, done);
        else done();
      }
    }
    // Records that came in (a filter loosened, someone else added one)
    // fade in; not a whole page of them.
    if (fresh.length <= 20) for (const el of fresh) appear(el);
    cardPositions.current = next;
  });
  const latestRows = useRef(data.rows);
  latestRows.current = data.rows;
  // A card on a plain board: the board opens a gap where it would land
  // (board-card-drag.ts). With the mouse on the card, by touch on its handle
  // once held (a swipe over the handle scrolls the board, #166).
  function beginCardDrag(
    e: React.PointerEvent<HTMLElement>,
    row: Row,
    groupKey: string,
  ) {
    if (!editable || !viewEditable || cardDrag.current) return;
    const wrap = e.currentTarget.closest<HTMLElement>(".record-card-wrap"),
      board = e.currentTarget.closest<HTMLElement>(".board");
    if (!wrap || !board) return;
    const x0 = e.clientX,
      y0 = e.clientY;
    let drag: BoardCardDrag | null = null;
    let over: string | null = null;
    startDrag(e, {
      touch: "hold",
      source: null,
      onStart: () => {
        if (busyNow.current.order || cardDrag.current) return false;
        setKeyLift(null);
        drag = startBoardCardDrag({
          board,
          wrap,
          rowId: row.id,
          groupKey,
          x: x0,
          y: y0,
          onHint: setDropHint,
        });
        if (!drag) return false;
        cardDrag.current = drag;
      },
      onMove: (point) => {
        drag?.move(point.x, point.y);
        const page = pageAt(point);
        if (page !== over) recordOver((over = page));
      },
      onCancel: () => {
        cardDrag.current = null;
        setDropHint(null);
        if (over) recordOver((over = null));
        drag?.cancel();
      },
      onDrop: (point) => {
        cardDrag.current = null;
        setDropHint(null);
        if (over) recordOver((over = null));
        if (!drag) return;
        // Onto a database in the sidebar: the card goes back, the record
        // moves there.
        const target = pageAt(point);
        if (target) {
          drag.cancel();
          return dropOnPage(row, target, point.altKey);
        }
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
          version: versionNow.current,
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
      },
    });
  }
  // Keyboard: Space on a handle lifts the record, the arrows move it (on a
  // board left and right to the next column), Space or Enter drops it and
  // Escape puts it back. Each step is announced.
  function liftLists(row: Row, groupKey?: string): Pick<KeyLift, "lists" | "across"> {
    if (plainBoard && groupKey !== undefined)
      return {
        lists: groups.map((g) => ({ key: g.key, label: g.label, ids: g.rows.map((r) => r.id) })),
        across: true,
      };
    const siblings =
      groupKey !== undefined
        ? allGroups.find((g) => g.key === groupKey)?.rows || rowZones.current.get(groupKey)?.rows || []
        : shown;
    return { lists: [{ key: groupKey, ids: siblings.map((r) => r.id) }], across: false };
  }
  function liftSizes(lift: Pick<KeyLift, "lists" | "rowId">) {
    return lift.lists.map((l) => l.ids.filter((id) => id !== lift.rowId).length + 1);
  }
  function liftSlot(lift: KeyLift, at = lift.at) {
    const list = lift.lists[at.list];
    const others = list.ids.filter((id) => id !== lift.rowId);
    return { list, ...slotFor(others, at.index) };
  }
  function announceLift(lift: KeyLift, title: string) {
    const size = liftSizes(lift)[lift.at.list],
      label = lift.lists[lift.at.list].label,
      position = lift.at.index + 1;
    setOrderStatus(
      label
        ? t(`${title}: Position ${position} von ${size} in „${label}“.`, `${title}: position ${position} of ${size} in “${label}”.`)
        : t(`${title}: Position ${position} von ${size}.`, `${title}: position ${position} of ${size}.`),
    );
  }
  function handleKey(e: React.KeyboardEvent<HTMLElement>, row: Row, groupKey?: string) {
    const title = cellText(row.cells[fields[0].id]) || t("Ohne Titel", "Untitled");
    const lift = keyLift?.rowId === row.id && keyLift.groupKey === groupKey ? keyLift : null;
    if (!lift) {
      if (e.key !== " " || e.altKey || e.ctrlKey || e.metaKey || !editable || orderBusy) return false;
      e.preventDefault();
      e.stopPropagation();
      const { lists, across } = liftLists(row, groupKey);
      const list = Math.max(0, lists.findIndex((l) => l.key === groupKey));
      const index = Math.max(0, lists[list].ids.indexOf(row.id));
      const next: KeyLift = { rowId: row.id, groupKey, lists, across, from: { list, index }, at: { list, index } };
      setKeyLift(next);
      setOrderStatus(
        t(
          `${title} angehoben. Position ${index + 1} von ${liftSizes(next)[list]}. Pfeiltasten verschieben, Leertaste oder Eingabe legt ab, Escape bricht ab.`,
          `${title} lifted. Position ${index + 1} of ${liftSizes(next)[list]}. Arrow keys move, Space or Enter drops, Escape cancels.`,
        ),
      );
      return true;
    }
    if (e.key === "Tab") {
      setKeyLift(null);
      setDropHint(null);
      return false;
    }
    const step = keyboardStep(lift.at, e.key, liftSizes(lift), lift.across);
    if (step.command === "none") return false;
    e.preventDefault();
    e.stopPropagation();
    if (step.command === "move") {
      const next = { ...lift, at: step.position };
      setKeyLift(next);
      const same = next.at.list === next.from.list && next.at.index === next.from.index;
      const slot = liftSlot(next);
      setDropHint(
        !same && slot.targetId
          ? { id: slot.targetId, groupKey: slot.list.key, placement: slot.placement }
          : null,
      );
      announceLift(next, title);
      return true;
    }
    setKeyLift(null);
    setDropHint(null);
    if (step.command === "cancel" || (lift.at.list === lift.from.list && lift.at.index === lift.from.index)) {
      setOrderStatus(
        step.command === "cancel"
          ? t(`Verschieben von ${title} abgebrochen.`, `Moving ${title} cancelled.`)
          : t(`${title} bleibt an seiner Position.`, `${title} stays where it was.`),
      );
      return true;
    }
    const slot = liftSlot(lift);
    void commitRowDrop(row, groupKey, {
      targetId: slot.targetId,
      placement: slot.placement,
      groupKey: slot.list.key,
    })?.then(() => {
      // The handle was disabled while saving: the focus comes back to it.
      setTimeout(() => {
        boardRef.current
          ?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(row.id)}"] .row-order-handle`)
          ?.focus();
      });
    });
    return true;
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
        aria-label={t(`Eintrag verschieben: ${cellText(row.cells[fields[0].id]) || t("Ohne Titel", "Untitled")}`, `Move record: ${cellText(row.cells[fields[0].id]) || t("Ohne Titel", "Untitled")}`)}
        title={t("Ziehen (auf Touchscreens kurz halten) oder Position wählen · Leertaste hebt an, Pfeiltasten verschieben · Alt + Pfeil hoch/runter", "Drag (on touch screens hold briefly) or choose a position · Space lifts, arrow keys move · Alt + arrow up/down")}
        aria-keyshortcuts="Space Alt+ArrowUp Alt+ArrowDown"
        aria-pressed={keyLift?.rowId === row.id && keyLift.groupKey === groupKey ? true : undefined}
        disabled={orderBusy}
        // Held to lift it: the drawer's edge swipe leaves it alone.
        data-no-edge-swipe=""
        onPointerDown={(e) => {
          e.stopPropagation();
          if (plainBoard && groupKey !== undefined) beginCardDrag(e, row, groupKey);
          else beginRowDrag(e, row, groupKey, "hold");
        }}
        onClick={(e) => {
          e.stopPropagation();
          openMove(row, groupKey);
        }}
        onBlur={() => {
          if (keyLift?.rowId === row.id) {
            setKeyLift(null);
            setDropHint(null);
          }
        }}
        onKeyUp={(e) => {
          // Space lifts; it does not also open the position dialog.
          if (e.key === " ") e.preventDefault();
        }}
        onKeyDown={(e) => {
          if (handleKey(e, row, groupKey)) return;
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
        <DotsSixVertical size={17} aria-hidden="true" />
      </button>
    );
  }
  // `keepOpen`: the cell's editor stays (a multi-select's search, #423).
  async function updateCell(row: Row, field: Field, value: unknown, keepOpen = false) {
    if (JSON.stringify(row.cells[field.id]) === JSON.stringify(value)) return;
    // The cell's edit this change came from (the same cell opened again
    // meanwhile is a new one and stays open).
    const session = editingCell;
    const result = await act({
      action: "row.update",
      rowId: row.id,
      version: row.version,
      cells: { [field.id]: value },
    });
    // Only the cell that was saved closes: on a slow connection another one
    // (the next cell, after the record's title) may be open by now.
    if (result && !keepOpen) setEditingCell((open) => (open && open === session && open.rowId === row.id && open.fieldId === field.id ? null : open));
    return result;
  }
  async function createRow(
    cells: Record<string, unknown> = {},
    open = true,
    templateId?: string | null,
    // Editing a template: its placeholders stay (as the current names).
    rawTemplate = false,
  ) {
    const withTemplate = templateId || (templateId !== null && data.rowTemplates?.some((t) => t.is_default));
    const r = (await act({
      action: "row.create",
      // Only a text title is called "Neue Aufgabe" (a date or number title
      // starts empty and the record opens with it focused, #529); a
      // computed one takes no value.
      cells: withTemplate || titleMode(fields[0]) !== "text" ? cells : { [fields[0].id]: newRecordTitle, ...cells },
      templateId,
      // Dates of placeholders ({{Heute}}) and of "Heute" defaults (#411)
      // in the person's time zone.
      timeZone: browserZone(),
      ...(rawTemplate ? { rawTemplate: true } : {}),
    })) as { id: string } | null;
    if (r && open) {
      setFreshRowId(r.id);
      setRowId(r.id);
    }
    return r;
  }
  // A record template on an existing record; the previous text becomes a
  // version that "Undo" restores (lib/undo.ts).
  async function applyTemplate(rowId: string, templateId: string, mode: "empty" | "append") {
    await flushOpenDocuments();
    const result = (await act({
      action: "row.template.apply",
      rowId,
      templateId,
      mode,
      timeZone: browserZone(),
      snapshotId: crypto.randomUUID(),
    })) as { document: string } | null;
    if (!result) return false;
    // The record's text has a new version: load it fresh, not the kept copy.
    appCache().delete(rowKey(page.id, rowId));
    setDocumentRevision((n) => n + 1);
    return true;
  }
  async function uploadFile(file: File) {
    if (file.size > 10 * 1024 * 1024)
      throw new Error(t(`${file.name}: maximal 10 MB pro Datei.`, `${file.name}: at most 10 MB per file.`));
    requireConnection();
    const body = new FormData();
    body.set("pageId", page.id);
    body.set("file", file);
    const response = await fetch("/api/upload", { method: "POST", body, headers: idempotencyHeaders() });
    const result = await response.json();
    if (!response.ok) throw new Error(serverMessage(result.error) || t("Upload fehlgeschlagen.", "Upload failed."));
    primePlaceholder(result.url, result.placeholder);
    return result.url as string;
  }
  // Chips of options; the workspace's tags with their colours (#79).
  // Own options with their colours (#242), others as before.
  function chipClass(f: Field | undefined, value: string) {
    return choiceChipClass(f, value, (name) => tagByName(tagOptions.tags, name).color);
  }
  // A chip whose colour its menu changes (right-click, #242).
  const optionsEditable = editable && allowFieldChanges;
  function optionData(f: Field | undefined, value: string) {
    return optionsEditable && hasOwnOptions(f) && f!.options?.includes(value) ? { "data-option-field": f!.id, "data-option": value } : {};
  }
  // An option typed into a select or multi-select that is not there yet
  // (#423): added to the property as from the column header or a new board
  // column, so colours, versions and the server's checks work as there.
  async function createOption(fieldId: string, name: string) {
    const current = databaseRef.current;
    const f = current.fields.find((x) => x.id === fieldId);
    if (!f || !hasOwnOptions(f) || f.options?.some((o) => foldOption(o) === foldOption(name))) return false;
    const saved = await updateSchema(
      current.fields.map((x) => (x.id === fieldId ? { ...x, options: [...(x.options || []), name] } : x)),
      current.views,
      undefined,
      Math.max(current.version, expectedVersion.current),
    );
    return !!saved;
  }
  // The search of select and multi-select values; creating only for people
  // who may change the properties.
  const optionPicker = (f: Field) => ({
    create: optionsEditable && hasOwnOptions(f) ? (name: string) => createOption(f.id, name) : undefined,
  });
  function openFieldSettings(f: Field) {
    setFieldDraft({
      ...f,
      ...(f.formula ? { formula: rewriteFormulaReferences(f.formula, fields, "display") } : {}),
    });
    setFieldVersion(data.database.version);
    setFieldError("");
    setNewField(true);
  }
  // One option's colour, saved at once; "Undo" puts the previous one back.
  async function setOptionColor(fieldId: string, option: string, color: OptionColor) {
    const f = fields.find((x) => x.id === fieldId);
    if (!f || optionColor(f, option) === color) return;
    const previous = { ...(f.optionColors || {}) };
    const withColors = (colors: Record<string, OptionColor>) => (list: Field[]) =>
      list.map((x) => (x.id === fieldId ? { ...x, optionColors: colors } : x));
    const saved = await updateSchema(withColors({ ...previous, [option]: color })(fields));
    if (saved)
      showUndo(t(`„${option}“ ist jetzt ${colorLabel(color, t)}.`, `“${option}” is now ${colorLabel(color, t).toLowerCase()}.`), () =>
        updateSchema(withColors(previous)(databaseRef.current.fields), databaseRef.current.views, undefined, databaseRef.current.version),
      );
  }
  // A value of the folded record properties (#186): a small chip, named
  // for screen readers.
  function summaryChip(r: Row, f: Field) {
    const v = r.cells[f.id];
    let text = "";
    let className = "record-properties-chip";
    if (f.type === "select" || f.type === "multiselect") {
      const values = (Array.isArray(v) ? v : [v]).filter((x) => x !== null && x !== undefined && String(x).trim());
      text = values.length > 1 ? `${values[0]} +${values.length - 1}` : String(values[0] ?? "");
      className = `${chipClass(f, String(values[0] ?? ""))} page-tag-small record-properties-chip`;
    } else if (f.type === "date") text = typeof v === "string" ? formatFieldDate(v, f) : "";
    else if (f.type === "person") {
      const ids = Array.isArray(v) ? v : [v];
      text = ids.map((uid) => members.find((m) => m.id === uid)?.name).filter(Boolean).join(", ");
    } else if (f.type === "sprint") text = data.database.settings?.sprints?.find((x) => x.id === v)?.name || "";
    if (!text) return null;
    return (
      <span key={f.id} className={className} title={`${f.name}: ${text}`}>
        <span className="sr-only">{f.name}: </span>
        {text}
      </span>
    );
  }
  // `place`: a table cell (links open, line breaks as spaces), a card or
  // list entry (a button: no links inside, line breaks as spaces) or a
  // block (the feed: line breaks shown).
  function display(r: Row, f: Field, place: "cell" | "button" | "block" = "cell") {
    const v = r.cells[f.id];
    // Formatted text (#126).
    if (isFormattedText(f, fields))
      return cellText(v).trim() ? <InlineText value={cellText(v)} links={place !== "button"} oneLine={place !== "block"} /> : <span className="muted">—</span>;
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
    // Web, mail and phone links open (issue #67).
    if (isLinkField(f.type))
      return cellText(v).trim() ? <LinkValue type={f.type} value={cellText(v)} /> : <span className="muted">—</span>;
    if (f.type === "sprint") {
      const sprint = data.database.settings?.sprints?.find((s) => s.id === v);
      return sprint ? <span className={`sprint-chip sprint-${sprint.state}`}>{sprint.name}</span> : null;
    }
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
      // One person or several ("Mehrere Personen", #535): each with the avatar.
      const people = personIds(v)
        .map((id) => members.find((m) => m.id === id))
        .filter((u): u is User => !!u);
      if (!people.length) return <span className="muted">—</span>;
      if (people.length === 1)
        return (
          <span className="person-cell">
            <Avatar name={people[0].name} userId={people[0].id} small />
            {people[0].name}
          </span>
        );
      return (
        <span className="person-cells">
          {people.map((u) => (
            <span key={u.id} className="person-cell">
              <Avatar name={u.name} userId={u.id} small />
              {u.name}
            </span>
          ))}
        </span>
      );
    }
    if (f.type === "select" || f.type === "multiselect") {
      const values = Array.isArray(v) ? v : v ? [v] : [];
      return (
        <span className="tags">
          {values.map((s, i) => (
            <span
              key={String(s) + i}
              className={chipClass(f, String(s))}
              {...optionData(f, String(s))}
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
                // The record's own icon in front of its title (#190).
                className={target.icon ? "relation-with-icon" : undefined}
                onClick={(e) => {
                  e.stopPropagation();
                  // A plain click stays in this view (#192): a record of
                  // another database opens on top of it; Ctrl/⌘- and
                  // middle clicks keep the link.
                  const how = relationClick(e, f.relationPage!, page.id);
                  if (how === "native") return;
                  e.preventDefault();
                  if (how === "here") setRowId(rid);
                  else relatedRecord.open({ pageId: f.relationPage!, rowId: rid }, e.currentTarget);
                }}
              >
                {target.icon && <PageIcon name={target.icon} size={15} className="relation-icon" />}
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
          <span className="date-cell-text">{formatFieldDate(v, f)}</span>
        </span>
      );
    }
    // Created and edited time in the viewer's time zone, like a date with time.
    if (isTimestampType(f.type) && v) {
      return (
        <span className="date-cell">
          <CalendarBlank size={14} />
          <span className="date-cell-text">{formatTimestamp(v, f)}</span>
        </span>
      );
    }
    if (f.type === "number" && v !== undefined) {
      if (v === null || v === "") return <span className="muted">—</span>;
      if (f.rollupDisplay && f.rollupDisplay !== "number")
        return <RollupValue field={f} value={Number(v)} />;
      return formatFieldNumber(Number(v), f);
    }
    // Formulas with a number result take the chosen number format and unit.
    if (f.type === "formula" && typeof v === "number" && (f.format || fieldUnit(f)))
      return formatFieldNumber(v, f);
    return cellText(v) || <span className="muted">—</span>;
  }
  // A record's property, compact (#519): the value as text or chips on a
  // button that opens today's editor (components/record-property-value.tsx);
  // checkboxes, stars and checklists stay one-tap controls. Values that may
  // not be changed are only shown – with their links.
  function recordValueText(r: Row, f: Field): string {
    const v = r.cells[f.id];
    if (isEmptyValue(v, f.type)) return "";
    const list = (Array.isArray(v) ? v : [v]).filter((x) => !isEmptyValue(x));
    let text: string;
    if (f.type === "person") text = list.map((id) => members.find((m) => m.id === id)?.name || "").filter(Boolean).join(", ");
    else if (f.type === "relation")
      text = list
        .map((id) => {
          const target = related[f.relationPage || ""]?.find((x) => x.id === id);
          return target ? cellText(target.cells.title) || t("Ohne Titel", "Untitled") : t("Nicht verfügbar", "Not available");
        })
        .join(", ");
    else if (f.type === "date") text = typeof v === "string" ? formatFieldDate(v, f) : "";
    else if (f.type === "number") text = typeof v === "number" ? formatFieldNumber(v, f) : cellText(v);
    else if (f.type === "sprint") text = data.database.settings?.sprints?.find((s) => s.id === v)?.name || "";
    else if (f.type === "files") {
      const names = new Map((data.files || []).map((x) => [x.url, x.name]));
      text = fileUrls(v).map((url) => fileLabel(url, names)).join(", ");
    } else text = list.map((x) => cellText(x)).join(", ");
    text = text.replace(/\s+/g, " ").trim();
    return text.length > 80 ? `${text.slice(0, 79)}…` : text;
  }
  function recordFileLinks(v: unknown) {
    const names = new Map((data.files || []).map((x) => [x.url, x.name]));
    return (
      <span className="record-value-links">
        {fileUrls(v).map((url) => (
          <a key={url} className="file-chip" href={url} target="_blank" rel="noreferrer noopener">
            {data.files?.find((x) => x.url === url)?.mime.startsWith("image/") && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={url} alt="" />
            )}
            {fileLabel(url, names)}
          </a>
        ))}
      </span>
    );
  }
  function recordValueDisplay(r: Row, f: Field) {
    const v = r.cells[f.id];
    if (isFormattedText(f, fields)) return <span className="record-value-text"><InlineText value={cellText(v)} links={false} /></span>;
    if (f.type === "date") return typeof v === "string" ? formatFieldDate(v, f) : null;
    if (f.type === "relation")
      return (
        <span className="tags">
          {(Array.isArray(v) ? (v as string[]) : []).map((rid) => {
            const target = related[f.relationPage || ""]?.find((x) => x.id === rid);
            return target ? (
              <span key={rid} className="relation-chip">
                {target.icon && <PageIcon name={target.icon} size={14} className="relation-icon" />}
                {cellText(target.cells.title) || t("Ohne Titel", "Untitled")}
              </span>
            ) : (
              <span key={rid} className="relation-chip muted">
                {t("Nicht verfügbar", "Not available")}
              </span>
            );
          })}
        </span>
      );
    if (f.type === "text" || f.type === "aliases") return <span className="record-value-text">{cellText(v)}</span>;
    return display(r, f, "button");
  }
  function recordPropertyValue(r: Row, f: Field) {
    const v = r.cells[f.id];
    const locked = !rowEditable(r) || fieldLocked(r, f);
    // One tap changes these.
    if (f.type === "checkbox" || f.type === "checklist" || (f.type === "number" && f.rollupDisplay === "rating"))
      return (
        <span className={`record-value-direct record-value-${f.type}`}>
          <CellInput field={f} value={v} members={members} related={related} disabled={locked} onChange={(next) => updateCell(r, f, next)} keepRequired />
        </span>
      );
    if (locked)
      return (
        <span className="record-value readonly">
          {isEmptyValue(v, f.type) ? (
            <span className="record-value-empty">{t("Leer", "Empty")}</span>
          ) : f.type === "files" ? (
            recordFileLinks(v)
          ) : isFormattedText(f, fields) ? (
            <span className="record-value-text"><InlineText value={cellText(v)} /></span>
          ) : f.type === "text" || f.type === "aliases" ? (
            <span className="record-value-text">{cellText(v)}</span>
          ) : (
            display(r, f, "cell")
          )}
        </span>
      );
    // Values of one choice or one line: the panel closes once it is saved.
    const closes =
      ["sprint", "number", "aliases", "url", "email", "phone"].includes(f.type) ||
      // One person; several (#535) stay open for more.
      (f.type === "person" && !isMultiPerson(f)) ||
      (f.type === "text" && !isFormattedText(f, fields)) ||
      (f.type === "relation" && !!f.parent);
    return (
      <RecordPropertyValue
        name={f.name}
        text={recordValueText(r, f)}
        display={recordValueDisplay(r, f)}
        links={isLinkField(f.type) ? <LinkValue type={f.type as LinkFieldType} value={cellText(v)} /> : f.type === "files" ? recordFileLinks(v) : undefined}
        wide={f.type === "relation" || f.type === "files" || isFormattedText(f, fields)}
        editor={(done) => (
          <CellInput
            field={f}
            value={v}
            members={members}
            related={related}
            links
            editing
            onCancel={done}
            formatted={isFormattedText(f, fields)}
            multiline
            optionPicker={optionPicker(f)}
            onChange={(next) => {
              const result = updateCell(r, f, next);
              if (closes) done();
              return result;
            }}
            keepRequired
            upload={uploadFile}
            files={data.files}
          />
        )}
      />
    );
  }
  const galleryConfig = view.gallery || defaultGallery;
  const galleryImages = new Set((data.images || []).map((image) => image.url));
  // No cover boxes while no record has an image (or a colour) to show.
  const galleryCovers =
    view.type === "gallery" &&
    galleryConfig.cover !== "none" &&
    (galleryConfig.cover === "record" || shown.some((r) => galleryImage(r, galleryConfig, fields, galleryImages)));
  function card(r: Row, groupKey?: string) {
    return (
      <div
        key={r.id}
        className={`record-card-wrap ${dropClass(r, groupKey)}`}
        data-row-id={r.id}
        data-row-group={groupKey}
      >
        <button
          className="record-card"
          // The mouse drags the whole card; fingers scroll over it and use
          // the handle.
          onPointerDown={(e) => {
            if (e.pointerType === "touch") return;
            if (plainBoard && groupKey !== undefined) beginCardDrag(e, r, groupKey);
            else beginRowDrag(e, r, groupKey, "none");
          }}
          onClick={() => setRowId(r.id)}
        >
          {galleryCovers && (
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
            {r.icon && <PageIcon name={r.icon} size={16} className="row-icon" />}
            {cellText(r.cells[fields[0].id]) || t("Ohne Titel", "Untitled")}
          </strong>
          <div className="card-properties">
            {/* Every visible property with a value; the card's date sits
                in the footer, not twice (#130). */}
            {cardFields(visibleFields, r.cells, [fields[0].id, dateField?.id])
              .map((f) => (
                <span key={f.id}>{display(r, f, "button")}</span>
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
        <span className="row-property-name">
          <RecurrenceIcon size={13} aria-hidden />
          <span className="row-property-label">{t("Wiederholung", "Recurrence")}</span>
        </span>
        {rowEditable(row) ? (
          // Compact like the properties (#519, #521): the rule as text,
          // its controls on click.
          <span className="row-property-value">
            <RecordPropertyValue
              name={t("Wiederholung", "Recurrence")}
              text={rule ? recurrenceText(rule, t) : ""}
              emptyText={t("Keine", "None")}
              display={rule ? recurrenceText(rule, t) : null}
              editor={() => (
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
                              aria-label={t(`${date} wieder einplanen`, `Schedule ${date} again`)}
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
                      <small className="muted">{recurrenceText(rule, t)}</small>
                    </>
                  )}
                </span>
              )}
            />
          </span>
        ) : (
          <span className="record-value readonly">
            {rule ? recurrenceText(rule, t) : <span className="record-value-empty">{t("Keine", "None")}</span>}
          </span>
        )}
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
            )}`, `Reminder on ${new Date(target.epochMilliseconds).toLocaleString(LOCALE_TAG, { timeZone: reminder.timeZone, dateStyle: "medium", timeStyle: "short" })}`);
    return (
      <label className="row-property reminder-property">
        <span className="row-property-name">
          <BellIcon size={13} aria-hidden />
          <span className="row-property-label">{t("Erinnerung", "Reminder")}</span>
        </span>
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
  // View tabs move sideways: before or after the tab under the pointer.
  // Fingers keep scrolling the tabs; a long press opens the view menu with
  // "Move left/right".
  function beginViewDrag(e: React.PointerEvent<HTMLElement>, id: string) {
    if (!viewEditable) return;
    const tab = e.currentTarget;
    const dropAt = (point: DragPoint) => {
      const over = point.target?.closest<HTMLElement>(".database-tabs [data-view-id]");
      const beside = over?.dataset.viewId;
      if (!over || !beside || beside === id) return null;
      return { id: beside, after: placementIn(over.getBoundingClientRect(), point.x, point.y, "x") === "after" };
    };
    startDrag(e, {
      touch: "none",
      preview: tab,
      source: tab,
      onStart: () => {
        setDraggedView(id);
      },
      onMove: (point) => setViewDrop(dropAt(point)),
      onDrop: (point) => {
        const drop = dropAt(point);
        setViewDrop(null);
        setDraggedView(null);
        if (drop) void reorderView(id, drop.id, drop.after);
      },
      onCancel: () => {
        setViewDrop(null);
        setDraggedView(null);
      },
    });
  }
  // Table columns: dropped on another column, before it (as before).
  function beginFieldDrag(e: React.PointerEvent<HTMLElement>, id: string) {
    if (!viewEditable) return;
    const header = e.currentTarget;
    const dropAt = (point: DragPoint) => {
      const target = point.target?.closest<HTMLElement>("th[data-field-id]")?.dataset.fieldId;
      return target && target !== id ? target : null;
    };
    startDrag(e, {
      preview: header,
      source: header,
      onMove: (point) => setFieldDrop(dropAt(point)),
      onDrop: (point) => {
        const target = dropAt(point);
        setFieldDrop(null);
        if (target) void moveColumn(id, target);
      },
      onCancel: () => setFieldDrop(null),
    });
  }
  const columnAt = (x: number, y: number) =>
    document
      .elementFromPoint(x, y)
      ?.closest<HTMLElement>(".board-column[data-group-key]")?.dataset.groupKey;
  // A board column by its header (mouse) or its handle (touch, once held);
  // the board scrolls sideways at its edges.
  function beginColumnDrag(e: React.PointerEvent<HTMLElement>, group: DatabaseGroup) {
    if (!viewEditable) return;
    const column = e.currentTarget.closest<HTMLElement>(".board-column");
    startDrag(e, {
      touch: e.currentTarget.classList.contains("group-drag") ? "hold" : "none",
      preview: column?.querySelector<HTMLElement>(":scope > header") || column,
      source: column,
      onStart: () => !busyNow.current.schema,
      onMove: (point) => {
        const target = columnAt(point.x, point.y);
        setGroupDrop(target && target !== group.key ? target : null);
      },
      onDrop: (point) => {
        setGroupDrop(null);
        const target = columnAt(point.x, point.y),
          index = groups.findIndex((x) => x.key === target);
        if (target !== group.key && index >= 0) void moveGroup(group.key, index);
      },
      onCancel: () => setGroupDrop(null),
    });
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
          aria-label={closed ? t(`Gruppe ${g.label} in ${where} ausklappen`, `Expand group ${g.label} in ${where}`) : t(`Gruppe ${g.label} in ${where} einklappen`, `Collapse group ${g.label} in ${where}`)}
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
          <span className={g.missing ? "group-missing" : undefined}>{g.label}</span>
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
              aria-label={closed ? t(`Abschnitt ${g.label} ausklappen`, `Expand section ${g.label}`) : t(`Abschnitt ${g.label} einklappen`, `Collapse section ${g.label}`)}
              disabled={schemaBusy}
              onClick={() =>
                void setGroupsCollapsed([pathCollapseKey(keys)], !closed)
              }
            >
              <CaretRight
                size={12}
                style={{ transform: closed ? undefined : "rotate(90deg)" }}
              />
              <span className={g.missing ? "group-missing" : undefined}>{g.label}</span>
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
        {...rowZone(target)}
      >
        <button
          className="group-toggle"
          aria-expanded={!closed}
          aria-label={closed ? t(`Untergruppe ${sub.label} in ${group.label} ausklappen`, `Expand sub-group ${sub.label} in ${group.label}`) : t(`Untergruppe ${sub.label} in ${group.label} einklappen`, `Collapse sub-group ${sub.label} in ${group.label}`)}
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
          <span className={sub.missing ? "group-missing" : undefined}>{sub.label}</span>
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
        {...rowZone(group)}
      >
        <button
          className="group-toggle"
          aria-expanded={!collapsed(group.key)}
          aria-label={collapsed(group.key) ? t(`Gruppe ${group.label} ausklappen`, `Expand group ${group.label}`) : t(`Gruppe ${group.label} einklappen`, `Collapse group ${group.label}`)}
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
          <span className={group.missing ? "group-missing" : undefined}>{group.label}</span>
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
  // Arrow up/down move between rows, Enter opens the focused row. Typing in
  // a cell editor is left alone.
  function rowKeyDown(e: React.KeyboardEvent<HTMLTableRowElement>, r: Row) {
    const target = e.target as HTMLElement;
    if (target.closest("input, textarea, select, [contenteditable=true], .inline-cell")) return;
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !e.altKey) {
      const rows = [...(boardRef.current?.querySelectorAll<HTMLElement>("tr[data-row-id]") || [])];
      const next = rows[rows.indexOf(e.currentTarget) + (e.key === "ArrowDown" ? 1 : -1)];
      if (!next) return;
      e.preventDefault();
      (next.querySelector<HTMLElement>(".row-title-link") || next).focus();
      if (docked && next.dataset.rowId) setRowId(next.dataset.rowId);
    } else if (e.key === "Enter" && target === e.currentTarget) {
      e.preventDefault();
      setRowId(r.id);
    }
  }
  function tableRow(r: Row, groupKey?: string, tree?: { depth: number; children: number }) {
    const title = cellText(r.cells[fields[0].id]) || t("Ohne Titel", "Untitled");
    return (
      <tr
        key={r.id}
        role="row"
        tabIndex={-1}
        className={`${selection.has(r.id) ? "row-selected" : ""} ${dropClass(r, groupKey)}`}
        data-row-id={r.id}
        data-row-group={groupKey}
        onKeyDown={(e) => rowKeyDown(e, r)}
      >
        {editable && (
          <td role="gridcell" className="selection-cell sticky-col" style={{ left: 0 }}>
            <div className="row-selection-controls">
              {orderHandle(r, groupKey)}
              {/* The label is the checkbox's larger touch area (app/mobile-ux.css). */}
              <label className="hit-check">
                <input
                  type="checkbox"
                  aria-label={t(`${title} auswählen`, `Select ${title}`)}
                  disabled={bulkBusy}
                  checked={selection.has(r.id)}
                  onChange={(e) => selectRow(r, e.target.checked)}
                />
              </label>
            </div>
          </td>
        )}
        {visibleFields.map((f, i) => (
          <td
            key={f.id}
            role="gridcell"
            className={`${stickyCell(f, i).className}${aiStatus.fresh.has(`${r.id}:${f.id}`) ? " ai-filled" : ""}`.trim() || undefined}
            style={stickyCell(f, i).style}
            title={lockedTitle(f, r)}
            onClick={() => {
              if (
                !rowEditable(r) ||
                f.id === fields[0].id ||
                computedTypes.includes(f.type) ||
                fieldLocked(r, f)
              )
                setRowId(r.id);
              else if (f.type === "checkbox")
                void updateCell(r, f, !r.cells[f.id]);
              else {
                cellOpenedByClick.current = true;
                setEditingCell({ rowId: r.id, fieldId: f.id, groupKey });
              }
            }}
          >
            {editingCell?.rowId === r.id &&
            editingCell?.fieldId === f.id &&
            editingCell?.groupKey === groupKey ? (
              <span
                className="inline-cell"
                // The first click of a double-click opens the cell; the
                // second one lands on the editor that is now under the
                // pointer (an option of a multi-select) and must not pick it.
                onClickCapture={(e) => {
                  if (cellOpenedByClick.current && e.detail > 1) {
                    e.preventDefault();
                    e.stopPropagation();
                  } else cellOpenedByClick.current = false;
                }}
                onClick={(e) => e.stopPropagation()}
              >
                <CellInput
                  field={f}
                  value={r.cells[f.id]}
                  members={members}
                  related={related}
                  // A multi-select's search stays open for more (#423), several people too (#535).
                  onChange={(v) => updateCell(r, f, v, (f.type === "multiselect" && !f.tagOptions) || isMultiPerson(f))}
                  keepRequired
                  upload={editable ? uploadFile : undefined}
                  files={data.files}
                  links
                  editing
                  formatted={isFormattedText(f, fields)}
                  optionPicker={optionPicker(f)}
                  onCancel={() => setEditingCell(null)}
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
                {f.id === fields[0].id ? (
                  // The title opens the record: a real button, so Enter and
                  // Space work and the dialog can hand the focus back here.
                  <button
                    type="button"
                    className="row-title-link"
                    aria-label={t(`Eintrag öffnen: ${title}`, `Open record: ${title}`)}
                    onClick={(e) => {
                      e.stopPropagation();
                      setRowId(r.id);
                    }}
                  >
                    {r.icon && <PageIcon name={r.icon} size={15} className="row-icon" />}
                    <span className="row-title-text">{display(r, f)}</span>
                    <ArrowSquareOut size={14} className="row-open-mark" aria-hidden="true" />
                  </button>
                ) : isLinkField(f.type) && rowEditable(r) && !fieldLocked(r, f) ? (
                  <LinkCellDisplay
                    type={f.type}
                    name={f.name}
                    value={cellText(r.cells[f.id])}
                    onEdit={() => setEditingCell({ rowId: r.id, fieldId: f.id, groupKey })}
                  />
                ) : isMissing(f, r.cells) ? (
                  // A required property without a value (#443).
                  <RequiredMissing />
                ) : (
                  display(r, f)
                )}
              </span>
            )}
          </td>
        ))}
        {editable && <td role="gridcell" />}
      </tr>
    );
  }
  function listRow(r: Row, groupKey?: string) {
    return (
      <div
        key={r.id}
        className={`record-list-item ${dropClass(r, groupKey)}`}
        data-row-id={r.id}
        data-row-group={groupKey}
      >
        {editable && orderHandle(r, groupKey)}
        <button onClick={() => setRowId(r.id)}>
          <span>
            {r.icon && <PageIcon name={r.icon} size={16} className="row-icon" />}
            {cellText(r.cells[fields[0].id]) || t("Ohne Titel", "Untitled")}
          </span>
          <span>
            {/* Compact: up to three properties with a value (#130). */}
            {cardFields(visibleFields, r.cells, [fields[0].id], 3).map((f) => (
              <span key={f.id}>{display(r, f, "button")}</span>
            ))}
          </span>
        </button>
      </div>
    );
  }

  return (
    <SprintContext.Provider value={data.database.settings?.sprints || []}>
    <div
      className={view.type === "study" ? "database study-view" : "database"}
      ref={boardRef}
      hidden={!!record}
      data-database-page={page.id}
      onContextMenu={(e) => {
        // Records (rows, cards, list items) get their own menu; fields
        // being edited keep the browser's.
        const target = e.target as HTMLElement;
        if (target.closest("input, textarea, select, [contenteditable=true], .modal, .side-panel, .ProseMirror")) return;
        // An option's chip: its colour (#242).
        const chip = target.closest<HTMLElement>("[data-option-field]");
        if (chip && optionsEditable) {
          e.preventDefault();
          setOptionMenu({ x: e.clientX, y: e.clientY, field: chip.dataset.optionField!, option: chip.dataset.option! });
          return;
        }
        const record = target.closest<HTMLElement>("[data-row-id]");
        const rowId = record?.dataset.rowId;
        if (!rowId || !data.rows.some((r) => r.id === rowId)) return;
        e.preventDefault();
        const rowIds = selection.has(rowId) && selection.size > 1 ? [...selection.keys()] : [rowId];
        setRecordMenu({ x: e.clientX, y: e.clientY, rowIds });
      }}
    >
      {/* A related record on top of another view: its dialog only (#192);
          a record as a page of its own (#231): only the record. */}
      {!record && !pageRecord && (<>
      <ScrollFade className="database-tabs" role="group" aria-label={t("Ansichten", "Views")}>
        {viewTabs.shown.map((v) => {
          const Icon = viewIcons[v.type];
          if (renamingView === v.id)
            return (
              <span key={v.id} className="view-tab-rename">
                <Icon size={17} />
                <input
                  autoFocus
                  aria-label={t("Name der Ansicht", "View name")}
                  defaultValue={v.name}
                  maxLength={80}
                  onFocus={(e) => e.currentTarget.select()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                    if (e.key === "Escape") {
                      e.currentTarget.value = v.name;
                      e.currentTarget.blur();
                    }
                  }}
                  onBlur={(e) => {
                    const name = e.currentTarget.value.trim();
                    setRenamingView(null);
                    if (name && name !== v.name) void renameView(v.id, name);
                  }}
                />
              </span>
            );
          return (
            <button
              key={v.id}
              aria-current={v.id === view.id ? "true" : undefined}
              className={`${v.id === view.id ? "selected" : ""}${viewDrop?.id === v.id ? (viewDrop.after ? " view-drop-after" : " view-drop-before") : ""}${draggedView === v.id ? " dragging" : ""}`}
              onClick={() => {
                if (v.id === view.id) return;
                // A transition lets <ViewTransition> cross-fade the views.
                if (prefersReducedMotion()) setViewId(v.id);
                else startTransition(() => setViewId(v.id));
              }}
              onDoubleClick={() => viewEditable && setRenamingView(v.id)}
              onContextMenu={(e) => {
                if (!viewEditable) return;
                e.preventDefault();
                e.stopPropagation();
                setViewMenu({ x: e.clientX, y: e.clientY, id: v.id });
              }}
              data-view-id={v.id}
              onPointerDown={(e) => beginViewDrag(e, v.id)}
            >
              <Icon size={17} />
              {v.name}
              {v.default && views.length > 1 && (
                <Star className="view-default-mark" size={11} weight="fill" aria-hidden />
              )}
            </button>
          );
        })}
        {viewTabs.more.length > 0 && (
          <Dropdown.Root>
            <Dropdown.Trigger asChild>
              <button
                className="view-tab-more"
                aria-label={t(`Weitere Ansichten (${viewTabs.more.length})`, `More views (${viewTabs.more.length})`)}
              >
                {t(`Weitere (${viewTabs.more.length})`, `More (${viewTabs.more.length})`)}
                <CaretDown size={12} aria-hidden="true" />
              </button>
            </Dropdown.Trigger>
            <Dropdown.Portal>
              <Dropdown.Content collisionPadding={safeCollisionPadding()} className="dropdown" align="start" sideOffset={4}>
                {viewTabs.more.map((v) => {
                  const Icon = viewIcons[v.type];
                  return (
                    <Dropdown.Item
                      key={v.id}
                      className="dropdown-item"
                      onSelect={() => {
                        if (prefersReducedMotion()) setViewId(v.id);
                        else startTransition(() => setViewId(v.id));
                      }}
                    >
                      <Icon />
                      <span>{v.name}</span>
                      {v.default && <Star className="view-default-mark" size={11} weight="fill" aria-hidden />}
                    </Dropdown.Item>
                  );
                })}
              </Dropdown.Content>
            </Dropdown.Portal>
          </Dropdown.Root>
        )}
        {viewEditable && (
          <button
            className="icon-button"
            title={t("Ansicht hinzufügen", "Add view")}
            onClick={() => {
              // A type switched off meanwhile (#378): back to the table.
              const type = moduleShownIn(hiddenModules, VIEW_MODULE[viewType]) ? viewType : "table";
              setViewType(type);
              setViewName(t(...viewTypeNames[type]));
              setNewView(true);
            }}
          >
            <Plus />
          </button>
        )}
      </ScrollFade>
      <div className="database-toolbar">
        <div className="toolbar-left toolbar-chips">
          <DatabaseToolbarChips
            key={view.id}
            view={view}
            fields={fields}
            rows={data.rows}
            related={related}
            relatedSchemas={data.relatedSchemas}
            members={members}
            editable={viewEditable}
            groupSettings={groupSettings}
            updateView={updateView}
            saveFilters={(filterGroup) => updateView({ filters: [], filterGroup })}
            onAdvancedFilters={() => setFilterOpen(true)}
            onConfigure={() => setConfig(true)}
            query={query}
            onQuery={setQuery}
          />
        </div>
        <div className="toolbar-right">
          {aiSummarize !== "hidden" && (
            <button
              aria-disabled={aiSummarize === "blocked" || undefined}
              aria-label={t("Mit KI zusammenfassen", "Summarise with AI")}
              title={
                aiSummarize === "blocked"
                  ? aiBlockedHint
                  : t(`Mit KI zusammenfassen – die ${shown.length} Einträge dieser Ansicht (mit Filtern)`, `Summarise with AI – the ${shown.length} records of this view (with filters)`)
              }
              onClick={() => {
                if (aiSummarize !== "ok") return;
                setAiSummary({ pageId: page.id, rowIds: shown.map((r) => r.id), title: `${page.title} · ${view.name}`, kind: "database" });
              }}
            >
              <Sparkle size={17} />
            </button>
          )}
          <DatabaseExportMenu
            pageId={page.id}
            title={page.title}
            onError={onError}
            onQrLabels={() => setQrLabels({ rowIds: selection.size ? [...selection.keys()] : null })}
            onCsv={() =>
              download(
                `${page.title}.csv`,
                // The view's columns, people and records by name (lib/database-csv.ts).
                databaseCsv(viewCsvFields(view, fields, visibleFields), fields, shown, csvContext()),
                "text/csv",
              )
            }
          />
          {recordLayout.card === "contact" && (
            <ContactsMenu
              pageId={page.id}
              title={page.title}
              editable={editable}
              selected={[...selection.keys()]}
              onChanged={onRefresh}
              onError={onError}
            />
          )}
          {editable && (
            <>
              <button
                title={t("CSV oder Markdown importieren", "Import CSV or Markdown")}
                aria-label={t("CSV oder Markdown importieren", "Import CSV or Markdown")}
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
                templates={data.rowTemplates}
                databases={pages.filter((p) => p.kind === "database" && !p.deleted_at && p.workspace_id === page.workspace_id).map((p) => ({ id: p.id, title: p.title, space_id: p.space_id, parent_id: p.parent_id }))}
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
            className="button compact"
            title={t("In die Zwischenablage kopieren – zum Einfügen in Excel, Numbers oder ein Dokument · ⌘C / Strg+C", "Copy to the clipboard – to paste into Excel, Numbers or a document · ⌘C / Ctrl+C")}
            onClick={() => void copySelection()}
          >
            <Copy size={14} /> {t("Kopieren", "Copy")}
          </button>
          {canAi && (
            <button className="button compact" disabled={bulkBusy} onClick={() => setAiFill(true)}>
              <Sparkle size={14} /> {t("Mit KI ausfüllen", "Fill in with AI")}
            </button>
          )}
          <button className="button compact" disabled={bulkBusy} onClick={() => setTransfer({ rowIds: [...selection.keys()], mode: "move" })}>
            {t("Verschieben / kopieren nach …", "Move / copy to …")}
          </button>
          <button className="button compact" onClick={() => setQrLabels({ rowIds: [...selection.keys()] })}>
            <QrCode size={14} /> {t("QR-Etiketten drucken", "Print QR labels")}
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
      {!!aiStatus.status?.pending && (
        <div className="ai-pending" role="status">
          <Sparkle size={14} /> {t(`KI berechnet ${aiStatus.status.pending} Werte …`, `AI is computing ${aiStatus.status.pending} values …`)}
        </div>
      )}
      <AiFillDialog
        open={aiFill}
        pageId={page.id}
        fields={fields}
        rowIds={selectionRows.map((r) => r.id)}
        ai={ai}
        onClose={() => setAiFill(false)}
        onQueued={(queued, skipped) => {
          setSelection(new Map());
          aiQueued(queued, skipped);
        }}
        onError={onError}
      />
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
      {/* Switching views cross-fades (React view transitions, started by the
          tabs; browsers without the API switch instantly): only the old
          view takes part and fades out over the new one. While a
          transition runs the browser hit-tests past every element taking
          part in it – a new view taking part would lose the clicks and
          taps of its first 100–200 ms to the .database around it (#338). */}
      <ViewTransition key={view.id} enter="none" exit="db-view-out" default="none">
      <>
      {view.type === "table" && (
        <ScrollFade
          className="data-table-scroll pinned-table-scroll"
          onScroll={(e) => {
            // Scrolled sideways: the pinned first column casts a shadow.
            const el = e.currentTarget;
            el.classList.toggle("scrolled-x", el.scrollLeft > 0);
          }}
        >
          <table
            ref={stickyHead}
            role="grid"
            aria-label={t(`${view.name} – Tabelle`, `${view.name} – table`)}
            className="data-table configurable-table"
            style={{
              // The selection column is wider on touch screens
              // (--selection-column, app/mobile-ux.css); the pinned first
              // column narrower on phones (lib/pinned-column.ts).
              width: tableWidth(visibleFields.map(columnWidth), editable),
            }}
          >
            <colgroup>
              {editable && <col style={{ width: SELECTION_COLUMN }} />}
              {visibleFields.map((f, index) => (
                <col
                  key={f.id}
                  style={{
                    width: index === 0 ? pinnedColumnWidth(columnWidth(f)) : columnWidth(f),
                  }}
                />
              ))}
              {/* The "+" column: 44 px, a whole touch target (app/mobile-ux.css). */}
              {editable && <col style={{ width: 44 }} />}
            </colgroup>
            <thead>
              <tr>
                {editable && (
                  <th className="selection-cell sticky-col" style={{ left: 0 }}>
                    <label className="hit-check">
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
                    </label>
                  </th>
                )}
                {visibleFields.map((f, index) => (
                  <th
                    key={f.id}
                    data-field-id={f.id}
                    className={stickyCell(f, index).className || undefined}
                    style={stickyCell(f, index).style}
                    data-field-drop={fieldDrop === f.id ? "" : undefined}
                    onPointerDown={(e) => beginFieldDrag(e, f.id)}
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
                      onClick={() => openFieldSettings(f)}
                    >
                      <span className="property-type">
                        <FieldTypeIcon field={f} />
                      </span>
                      {f.name}
                      <FieldLock field={f} groups={data.groups || []} />
                    </button>
                    {viewEditable && (
                      <span
                        className="column-resizer"
                        role="separator"
                        aria-orientation="vertical"
                        aria-label={t(`${f.name}: Spaltenbreite`, `${f.name}: column width`)}
                        aria-valuenow={columnWidth(f)}
                        aria-valuemin={80}
                        aria-valuemax={800}
                        tabIndex={0}
                        draggable={false}
                        onPointerDown={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          e.currentTarget.setPointerCapture(e.pointerId);
                          // From the width it has on screen: the pinned
                          // column may be cut short on phones.
                          const shown = Math.round(
                            e.currentTarget.closest("th")?.getBoundingClientRect().width || 0,
                          );
                          const startWidth =
                            index === 0 && shown >= 80
                              ? Math.min(columnWidth(f), shown)
                              : columnWidth(f);
                          setResize({
                            id: f.id,
                            startX: e.clientX,
                            startWidth,
                            width: startWidth,
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
                          // The name says which column: "Status: Berechnen"
                          // – it contains the visible text (WCAG 2.5.3).
                          <>
                            <span className="sr-only">{f.name}: </span>
                            <span>{t("Berechnen", "Calculate")}</span>
                          </>
                        )}
                      </button>
                    </td>
                  );
                })}
                {editable && <td />}
              </tr>
            </tfoot>
          </table>
        </ScrollFade>
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
                  aria-label={collapsed(g.key) ? t(`Gruppe ${g.label} ausklappen`, `Expand group ${g.label}`) : t(`Gruppe ${g.label} einklappen`, `Collapse group ${g.label}`)}
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
                <span className={g.missing ? "tag tag-choice group-missing" : g.value === null ? `tag tag-choice tag-${legacyOptionColor(g.label)}` : chipClass(groupField, g.label)} {...(g.value === null ? {} : optionData(groupField, g.label))}>
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
                    aria-label={closed ? t(`Swimlane ${lane.label} ausklappen`, `Expand swimlane ${lane.label}`) : t(`Swimlane ${lane.label} einklappen`, `Collapse swimlane ${lane.label}`)}
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
                          {...rowZone(target)}
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
        <ScrollFade className="board">
          {groups.map((g) => (
            <section
              className={`board-column${collapsed(g.key) ? " collapsed" : ""}${groupDrop === g.key ? " group-drop" : ""}`}
              key={g.key}
              data-group-key={g.key}
              aria-label={t(`Gruppe ${g.label}`, `Group ${g.label}`)}
            >
              <header
                className={viewEditable && !schemaBusy ? "column-draggable" : undefined}
                onPointerDown={(e) => {
                  // The mouse drags the column by its header; fingers use
                  // the handle.
                  if (e.pointerType !== "touch") beginColumnDrag(e, g);
                }}
              >
                <button
                  className="icon-button group-toggle"
                  aria-expanded={!collapsed(g.key)}
                  aria-label={collapsed(g.key) ? t(`Gruppe ${g.label} ausklappen`, `Expand group ${g.label}`) : t(`Gruppe ${g.label} einklappen`, `Collapse group ${g.label}`)}
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
                <span className={g.missing ? "tag tag-choice group-missing" : g.value === null ? `tag tag-choice tag-${legacyOptionColor(g.label)}` : chipClass(groupField, g.label)} {...(g.value === null ? {} : optionData(groupField, g.label))}>
                  {g.label}
                </span>
                <WipCount count={g.rows.length} limit={view.wip?.[g.key]} />
                {viewEditable && (
                  <button
                    className="group-drag"
                    aria-label={t(`Gruppe ${g.label} ziehen`, `Drag group ${g.label}`)}
                    disabled={schemaBusy}
                    data-no-edge-swipe=""
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      beginColumnDrag(e, g);
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
                  {newRecordTitle}
                </button>
              )}
            </section>
          ))}
          {viewEditable &&
            groupField &&
            (groupField.type === "select" ||
              groupField.type === "multiselect") &&
            (!isTagField(groupField) || tagOptions.createTags) && (
              <AddBoardGroup
                disabled={schemaBusy}
                existing={groupField.options || []}
                onAdd={(name) =>
                  // A new column of the workspace's tags is a new tag (#79).
                  isTagField(groupField)
                    ? act({ action: "tag.save", workspaceId: page.workspace_id, name }).then(() => onRefresh?.())
                    : updateSchema(
                    fields.map((f) =>
                      f.id === groupField.id
                        ? { ...f, options: [...(f.options || []), name] }
                        : f,
                    ),
                  )
                }
              />
            )}
        </ScrollFade>
      )}
      {/* Flashcards or forms switched off for the instance (#386): the view
          stays, without its content. */}
      {(view.type === "study" || view.type === "form") && moduleOffHere(VIEW_MODULE[view.type]) && (
        <p className="muted empty-state" role="note">
          {view.type === "study" ? t("Lernkarten sind auf dieser Instanz ausgeschaltet. Die Karten und dein Lernstand bleiben erhalten.", "Flashcards are switched off on this instance. The cards and your progress are kept.") : t("Formulare sind auf dieser Instanz ausgeschaltet. Das Formular und seine Antworten bleiben erhalten.", "Forms are switched off on this instance. The form and its answers are kept.")}
        </p>
      )}
      {view.type === "study" && !moduleOffHere("flashcards") && (
        <DatabaseStudy
          key={view.id}
          page={page}
          database={data.database}
          view={view}
          rows={data.rows}
          editable={editable}
          act={act}
          onOpenRow={setRowId}
          startSession={studyRequest === view.id}
          onSessionStarted={() => setStudyRequest(null)}
        />
      )}
      {view.type === "sprint" && (
        <DatabaseSprints
          pageId={page.id}
          database={data.database}
          rows={shown}
          members={members}
          editable={editable}
          act={act}
          onOpen={setRowId}
        />
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
          display={(row, field) => display(row, field, "block")}
          onOpen={setRowId}
          orderHandle={(r) => (editable ? orderHandle(r) : null)}
          query={query}
          rowEvents={(r) => ({ className: dropClass(r) })}
          editor={
            editable
              ? (r) => ({
                  property: (f) =>
                    computedTypes.includes(f.type) || fieldLocked(r, f) ? (
                      <span title={lockedTitle(f, r)}>{display(r, f, "block")}</span>
                    ) : (
                      <CellInput
                        field={f}
                        value={r.cells[f.id]}
                        members={members}
                        related={related}
                        onChange={(v) => updateCell(r, f, v)}
                        keepRequired
                        upload={uploadFile}
                        files={data.files}
                        links
                        formatted={isFormattedText(f, fields)}
                        multiline
                        optionPicker={optionPicker(f)}
                      />
                    ),
                  document: (
                    <RowDocument
                      key={`${r.id}-${documentRevision}`}
                      pageId={page.id}
                      rowId={r.id}
                      userId={userId}
                      pages={pages}
                      members={members}
                      editable={editable}
                      fields={fields}
                      templates={editable ? data.rowTemplates : undefined}
                      draftOf={templateDraft?.rowId === r.id ? templateDraft.templateId : undefined}
                      onError={onError}
                      onChanged={onRefresh}
                    />
                  ),
                })
              : undefined
          }
          onComment={async (r, body) => {
            // A double submit of the same draft posts it once.
            const draft = `comment:${r.id}`;
            const result = await act(keyed({ action: "comment.create", rowId: r.id, body }, draftKey(draft, body)));
            if (result) draftSent(draft);
            return result;
          }}
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
          onOpen={(id, date, zone) => setRowId(id, date, zone)}
          onCreate={createRow}
          onView={updateView}
          onSchedule={(input) => rowChange(input, (sent) => mutate({ pageId: page.id, ...sent }))}
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
          selectedId={dockedId}
          onOpen={setRowId}
          onView={updateView}
          onSchedule={(input) => rowChange(input, (sent) => mutate({ pageId: page.id, ...sent }))}
          onSchema={
            allowFieldChanges
              ? (nextFields, patch) =>
                  updateSchema(
                    nextFields,
                    views.map((v) => (v.id === view.id ? { ...v, ...patch } : v)),
                  )
              : undefined
          }
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
      {view.type === "form" && !moduleOffHere("forms") && (
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
          rows={data.rows}
          version={data.database.version}
        />
      )}
      {shown.length === 0 && view.type !== "form" && view.type !== "chart" && view.type !== "study" && (
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
      </>
      </ViewTransition>
      </>)}
      <input
        type="file"
        accept=".csv,.md,.markdown,.zip"
        multiple
        hidden
        ref={importRef}
        onChange={async (e) => {
          const picked = [...(e.target.files || [])];
          const f = picked[0];
          if (!f) return;
          // Markdown files (or a ZIP of them) become records with their frontmatter.
          if (!/\.csv$/i.test(f.name)) {
            setMarkdownFiles(picked);
            e.target.value = "";
            return;
          }
          const result = parseCsvFile(await f.text());
          if (result.unreadable) {
            onError(t("CSV konnte nicht gelesen werden.", "The CSV could not be read."));
            return;
          }
          // Properties with a column in the file; names become ids again.
          const columns = new Set(result.columns);
          const imported = result.rows.map(
            csvImporter(
              fields.filter((f) => !computedTypes.includes(f.type) && columns.has(f.name)),
              fields,
              csvContext(),
            ),
          );
          const done = (await act({ action: "rows.import", rows: imported, timeZone: browserZone() })) as
            | { newOptions?: { name: string; options: string[] }[] }
            | null;
          e.target.value = "";
          // Values that were not options yet were added as options: say where.
          const added = done?.newOptions || [];
          if (added.length)
            showToast({
              text: added
                .map((f) =>
                  f.options.length === 1
                    ? t(`Neue Option „${f.options[0]}“ in „${f.name}“ angelegt.`, `New option “${f.options[0]}” added to “${f.name}”.`)
                    : t(`${f.options.length} neue Optionen in „${f.name}“ angelegt.`, `${f.options.length} new options added to “${f.name}”.`),
                )
                .join(" "),
            });
        }}
      />
      {markdownFiles && (
        <MarkdownRecordsImport
          pageId={page.id}
          files={markdownFiles}
          onClose={() => setMarkdownFiles(null)}
          onError={onError}
          onDone={async (created, updated) => {
            setMarkdownFiles(null);
            await onRefresh();
            showToast({
              text: updated
                ? t(`${created} Einträge importiert, ${updated} aktualisiert.`, `${created} records imported, ${updated} updated.`)
                : created === 1
                  ? t("1 Eintrag importiert.", "1 record imported.")
                  : t(`${created} Einträge importiert.`, `${created} records imported.`),
            });
          }}
        />
      )}
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
            {/* Saved on Enter, on leaving the field and when the panel
                closes while it has focus (like the WIP limits, #131). */}
            <DraftInput
              key={view.id}
              value={view.name}
              disabled={!viewEditable}
              onCommit={(name) => {
                const next = name.trim();
                if (next && next !== view.name) void updateView({ name: next });
              }}
            />
          </label>
          <p className="muted view-type-line">
            {(() => {
              const Icon = viewIcons[view.type];
              return <Icon size={15} aria-hidden="true" />;
            })()}
            {t(...viewTypeNames[view.type])} · {t(...viewTypeHints[view.type])}
          </p>
          <p className="muted">
            {t("Filter, Sortierung, Gruppierung und sichtbare Eigenschaften stellst du über die Leiste oberhalb der Ansicht ein.", "Filters, sorting, grouping and visible properties are set from the bar above the view.")}
          </p>
          <label>
            {t("Einträge öffnen als", "Open records as")}
            <Select
              aria-label={t("Einträge öffnen als", "Open records as")}
              disabled={!viewEditable}
              value={view.recordOpen || ""}
              onChange={(e) =>
                updateView({
                  recordOpen: (e.target.value || undefined) as RecordOpenMode | undefined,
                })
              }
            >
              <option value="">
                {t(`Wie die Datenbank (${t(recordOpenLabels[recordLayout.open])})`, `Like the database (${t(recordOpenLabels[recordLayout.open])})`)}
              </option>
              {recordOpenModes.map((mode) => (
                <option key={mode} value={mode}>
                  {t(recordOpenLabels[mode])}
                </option>
              ))}
            </Select>
          </label>
          {viewRecordMode === "side" && (dockableViews as readonly string[]).includes(view.type) && (
            <label>
              {t("Seitenleiste", "Side peek")}
              <Select
                aria-label={t("Seitenleiste", "Side peek")}
                disabled={!viewEditable}
                value={recordDocks(view.type, view.sidePanel) ? "beside" : "over"}
                onChange={(e) => updateView({ sidePanel: e.target.value as "beside" | "over" })}
              >
                <option value="beside">{t("Daneben – die Ansicht wird schmaler", "Beside – the view narrows")}</option>
                <option value="over">{t("Darüber – über der Ansicht", "Over – on top of the view")}</option>
              </Select>
            </label>
          )}
          {view.type === "study" && (
            <div className="settings-section">
              <h3>{t("Lernen", "Study")}</h3>
              <label>
                {t("Neue Karten", "New cards")}
                <Select
                  aria-label={t("Neue Karten", "New cards")}
                  disabled={!viewEditable}
                  value={view.study?.mixNew || "mixed"}
                  onChange={(e) => updateView({ study: { ...studyViewSchema.parse(view.study || {}), mixNew: e.target.value as "mixed" | "after" | "before" } })}
                >
                  <option value="mixed">{t("Zwischen den Wiederholungen", "Between the reviews")}</option>
                  <option value="before">{t("Vor den Wiederholungen", "Before the reviews")}</option>
                  <option value="after">{t("Nach den Wiederholungen", "After the reviews")}</option>
                </Select>
              </label>
              <label>
                {t("Reihenfolge neuer Karten", "Order of new cards")}
                <Select
                  aria-label={t("Reihenfolge neuer Karten", "Order of new cards")}
                  disabled={!viewEditable}
                  value={view.study?.newOrder || "added"}
                  onChange={(e) => updateView({ study: { ...studyViewSchema.parse(view.study || {}), newOrder: e.target.value as "added" | "random" } })}
                >
                  <option value="added">{t("Wie hinzugefügt", "As added")}</option>
                  <option value="random">{t("Zufällig", "Random")}</option>
                </Select>
              </label>
              <p className="muted">
                {t("Die Filter dieser Ansicht wählen, welche Karten des Stapels sie lernt. Was auf die Karten kommt, gilt für die ganze Datenbank.", "The filters of this view choose which cards of the deck it studies. What goes on the cards applies to the whole database.")}
              </p>
            </div>
          )}
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
          {subField && ["table", "list", "board"].includes(view.type) && (
            <h3 className="settings-heading">{t("Weitere Gruppenebenen", "Further group levels")}</h3>
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
                  <DraftInput
                    type="number"
                    className="column-width-input"
                    aria-label={t(`${f.name} Breite in Pixeln`, `${f.name} width in pixels`)}
                    min={80}
                    max={800}
                    disabled={!viewEditable}
                    key={`${view.id}-${f.id}-${view.columnWidths?.[f.id]}`}
                    value={columnWidth(f)}
                    onCommit={(text) => {
                      const width = Number(text);
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
            <label className="checkbox-label">
              <input type="checkbox" checked={!!view.default} onChange={() => void setDefaultView(view.id)} />
              {t("Standardansicht – öffnet sich zuerst", "Default view – opens first")}
            </label>
          )}
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
                  .filter((f) => !computedTypes.includes(f.type) && !lockedFields.has(f.id))
                  .map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
              </Select>
            </label>
            {fields.find((f) => f.id === bulkField) && (
              <FieldLabel field={fields.find((f) => f.id === bulkField)!}>
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
                  formatted={isFormattedText(fields.find((f) => f.id === bulkField), fields)}
                  commit="change"
                />
              </FieldLabel>
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
          ref={fieldForm}
          onSubmit={async (e) => {
            e.preventDefault();
            // The answer of the "Update existing records?" panel, if any.
            const carry = carryRenames.current;
            carryRenames.current = undefined;
            if (
              !editable ||
              !allowFieldChanges ||
              schemaBusy ||
              (relationChanged && !relationReady)
            )
              return;
            if (fieldDraft.ai && unknownReferences(fieldDraft.ai.prompt, fields, fieldDraft.id).length) {
              setFieldError(t("Der KI-Auftrag verweist auf unbekannte Eigenschaften.", "The AI instruction refers to unknown properties."));
              return;
            }
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
            // Options edited as text: a renamed option takes its records
            // along, an existing name written in its place merges it. That
            // changes records, so it is confirmed first (`carry`); declining
            // saves the options alone and the records keep the old names.
            const stored = fields.find((f) => f.id === fieldDraft.id);
            let renames: OptionRename[] = [];
            if (["select", "multiselect"].includes(draft.type) && !draft.tagOptions && draft.options) {
              if (stored && ["select", "multiselect"].includes(stored.type) && !stored.tagOptions)
                renames = optionRenames(stored.options || [], draft.options).map((r) => ({ field: draft.id, ...r }));
              // A renamed option takes the default along (#411), also with
              // "Nur Optionen speichern".
              if (draft.defaultValue && renames.length) draft.defaultValue = renameDefault(draft.defaultValue, renames) as typeof draft.defaultValue;
              draft.options = cleanOptions(draft.options);
              // Colours of the options left (#242); `{}` clears them.
              if (draft.optionColors)
                draft.optionColors = Object.fromEntries(Object.entries(draft.optionColors).filter(([o]) => draft.options!.includes(o)));
            }
            if (renames.length && carry === undefined) {
              setOptionConfirm(renames);
              return;
            }
            // "Mehrere Personen" off (#535): records with several people
            // keep the first one – said before it happens.
            if (stored && isMultiPerson(stored) && draft.type === "person" && !isMultiPerson(draft)) {
              const several = recordsWithSeveralPeople(data.rows, stored.id);
              if (
                several > 0 &&
                !window.confirm(
                  several === 1
                    ? t(
                        "„Mehrere Personen“ ausschalten? 1 Eintrag hat mehr als eine Person – er behält nur die erste.",
                        "Turn off “Several people”? 1 record has more than one person – it keeps only the first.",
                      )
                    : t(
                        `„Mehrere Personen“ ausschalten? ${several} Einträge haben mehr als eine Person – sie behalten nur die erste.`,
                        `Turn off “Several people”? ${several} records have more than one person – they keep only the first.`,
                      ),
                )
              )
                return;
            }
            setOptionConfirm(null);
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
              carry ? renames : undefined,
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
              value={fieldDraft.ai ? "@ai" : fieldDraft.parent ? "@parent" : fieldDraft.type}
              disabled={
                !editable || !allowFieldChanges || schemaBusy || !!relationPair
              }
              onChange={(e) =>
                setFieldDraft((f) =>
                  e.target.value === "@ai"
                    ? { ...f, type: AI_OUTPUT_TYPES.includes(f.type) ? f.type : "text", parent: undefined, ai: { prompt: f.ai?.prompt || "" } }
                    : e.target.value === "@parent"
                    ? { ...f, type: "relation", parent: true, relationPage: page.id, ai: undefined }
                    : {
                        ...f,
                        type: e.target.value as FieldType,
                        parent: undefined,
                        ai: undefined,
                        // Another type starts without a default (#411).
                        defaultValue: e.target.value === f.type ? f.defaultValue : undefined,
                        ...(e.target.value === "id" && !f.prefix ? { prefix: suggestedPrefix(page.title) } : {}),
                      },
                )
              }
            >
              {Object.entries(fieldNames).map(([k, n]) => (
                <option
                  key={k}
                  value={k}
                  // One aliases property per database; the title stays a
                  // property one can type or derive, not an ID (#463).
                  disabled={
                    (k === "aliases" && fields.some((f) => f.type === "aliases" && f.id !== fieldDraft.id)) ||
                    (computedTypes.includes(k) && k !== "formula" && k !== "rollup" && k !== fields[0]?.type && (fields[0]?.id === fieldDraft.id || !fields.length))
                  }
                >
                  {t(n[0], n[1])}
                </option>
              ))}
              <option value="@parent">{t("Übergeordneter Eintrag (Unteraufgaben)", "Parent record (subtasks)")}</option>
              {(canAi || fieldDraft.ai) && <option value="@ai">{t("KI-Eigenschaft", "AI property")}</option>}
            </Select>
          </label>
          {fieldDraft.ai && (
            <AiFieldEditor
              draft={fieldDraft}
              fields={fields}
              disabled={!editable || !allowFieldChanges || schemaBusy || !canAi}
              onChange={(patch) => setFieldDraft((f) => ({ ...f, ...patch }))}
            />
          )}
          {fieldDraft.ai && canAi && editable && fields.some((f) => f.id === fieldDraft.id && f.ai?.prompt === fieldDraft.ai?.prompt && f.type === fieldDraft.type) && (
            <div className="ai-field-run">
              <AiFillAll pageId={page.id} field={fieldDraft} onError={onError} onQueued={(n) => aiQueued(n)} />
              <small className="muted">{t("Berechnet die Werte aller Einträge neu (im Hintergrund).", "Recomputes the values of all records (in the background).")}</small>
            </div>
          )}
          {fieldDraft.type === "id" && (
            <label>
              {t("Präfix (optional)", "Prefix (optional)")}
              <input
                maxLength={10}
                pattern="[A-Z][A-Z0-9]{0,9}"
                aria-describedby="ticket-prefix-hint"
                value={fieldDraft.prefix || ""}
                onChange={(e) =>
                  // Cleared: no prefix at all, the ID is the plain number (#313).
                  setFieldDraft((f) => ({ ...f, prefix: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") || undefined }))
                }
              />
              <small id="ticket-prefix-hint" className="muted">
                {fieldDraft.prefix
                  ? t(
                      `Jeder Eintrag bekommt automatisch eine Nummer wie ${fieldDraft.prefix}-123. Im Text wird sie zum Link, in Git-Commits zur Referenz.`,
                      `Every record automatically gets a number like ${fieldDraft.prefix}-123. In text it becomes a link, in Git commits a reference.`,
                    )
                  : t(
                      "Ohne Präfix zählt die ID einfach hoch (1, 2, 3 …). Verweise wie WEB-123 in Texten und Git-Commits gibt es nur mit Präfix.",
                      "Without a prefix the ID simply counts up (1, 2, 3 …). References like WEB-123 in text and Git commits only work with a prefix.",
                    )}
              </small>
            </label>
          )}
          {fieldDraft.type === "multiselect" && (
            <label>
              {t("Optionen", "Options")}
              <Select
                aria-label={t("Herkunft der Optionen", "Source of the options")}
                aria-describedby="tag-options-hint"
                value={fieldDraft.tagOptions ? "tags" : "own"}
                onChange={(e) =>
                  setFieldDraft((f) => ({ ...f, tagOptions: e.target.value === "tags" ? true : undefined }))
                }
              >
                <option value="own">{t("Eigene Liste", "Own list")}</option>
                <option value="tags">{t("Tags des Arbeitsbereichs", "Workspace tags")}</option>
              </Select>
              <small id="tag-options-hint" className="muted">
                {fieldDraft.tagOptions
                  ? t(
                      "Die Tags des Arbeitsbereichs mit ihren Farben. Einträge erscheinen in der Tag-Ansicht und unter #Tag in der Suche; ein neuer Wert legt einen Tag an.",
                      "The workspace's tags with their colours. Records appear in the tag view and under #tag in the search; a new value creates a tag.",
                    )
                  : t(
                      "Mit den Tags des Arbeitsbereichs werden die bisherigen Optionen zu Tags.",
                      "With the workspace's tags, the current options become tags.",
                    )}
              </small>
            </label>
          )}
          {["select", "multiselect"].includes(fieldDraft.type) && !(fieldDraft.type === "multiselect" && fieldDraft.tagOptions) && (
            <label>
              {t("Optionen, durch Komma getrennt", "Options, separated by commas")}
              <input
                aria-describedby="option-rename-hint"
                value={optionsText ?? (fieldDraft.options?.join(", ") || "")}
                onBlur={() => setOptionsText(null)}
                onChange={(e) => {
                  setOptionsText(e.target.value);
                  setOptionConfirm(null);
                  setFieldDraft((f) => {
                    const options = e.target.value.split(",").map((s) => s.trim());
                    // A renamed option keeps its colour while typing (#242).
                    return { ...f, options, optionColors: carryColors(f.optionColors, optionRenames(f.options || [], options)) };
                  });
                }}
              />
              <small id="option-rename-hint" className="muted">
                {t(
                  "Eine umbenannte Option nimmt ihre Einträge mit. Der Name einer anderen Option an ihrer Stelle führt beide zusammen.",
                  "A renamed option takes its records along. Writing another option's name in its place merges the two.",
                )}
              </small>
            </label>
          )}
          {hasOwnOptions(fieldDraft) && (() => {
            const options = cleanOptions(fieldDraft.options || []);
            // The colours as saving stores them: new options with the
            // colour they will get.
            const stored = fields.find((f) => f.id === fieldDraft.id);
            const preview = colorOptions([{ ...fieldDraft, options, optionColors: fieldDraft.optionColors ?? stored?.optionColors ?? {} }], stored ? [stored] : [])[0].optionColors;
            return (
              <OptionColorList
                options={options}
                colors={preview}
                onChange={(option, color) => setFieldDraft((f) => ({ ...f, optionColors: { ...preview, ...f.optionColors, [option]: color } }))}
                onReplace={(colors) => setFieldDraft((f) => ({ ...f, optionColors: colors }))}
              />
            );
          })()}
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
          {(fieldDraft.type === "number" || fieldDraft.type === "formula") &&
            unitFormat(fieldDraft.format) && (
              // Own unit (#522); currencies and percent carry their own sign.
              <label>
                {t("Einheit", "Unit")}
                <input
                  maxLength={UNIT_MAX}
                  placeholder={t("z. B. kg, m, h", "e.g. kg, m, h")}
                  value={fieldDraft.unit || ""}
                  onChange={(e) => setFieldDraft((f) => ({ ...f, unit: e.target.value || undefined }))}
                />
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
              {/* #327: off, the date fields offer no time; values that
                  have one keep it (and can lose it). */}
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={!fieldDraft.noTime}
                  disabled={!editable || !allowFieldChanges}
                  onChange={(e) =>
                    setFieldDraft((f) => ({
                      ...f,
                      noTime: e.target.checked ? undefined : true,
                    }))
                  }
                />
                {t("Mit Uhrzeit", "With time")}
              </label>
              {fieldDraft.noTime && (() => {
                const timed = data.rows.filter((r) => isTimed(r.cells[fieldDraft.id])).length;
                return (
                  <p className="muted">
                    {t(
                      "Neue Werte haben nur ein Datum. Vorhandene Uhrzeiten bleiben erhalten und lassen sich entfernen.",
                      "New values have a date only. Existing times are kept and can be removed.",
                    )}
                    {timed > 0 && " "}
                    {timed === 1
                      ? t("1 Eintrag hat noch eine Uhrzeit.", "1 record still has a time.")
                      : timed > 1
                        ? t(`${timed} Einträge haben noch eine Uhrzeit.`, `${timed} records still have a time.`)
                        : null}
                  </p>
                );
              })()}
            </>
          )}
          {/* #535: several people per record; off keeps the first one
              (confirmed on saving). */}
          {fieldDraft.type === "person" && (
            <>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={!!fieldDraft.multiPerson}
                  disabled={!editable || !allowFieldChanges}
                  onChange={(e) =>
                    setFieldDraft((f) => ({
                      ...f,
                      multiPerson: e.target.checked ? true : undefined,
                    }))
                  }
                />
                {t("Mehrere Personen", "Several people")}
              </label>
              <p className="muted">
                {fieldDraft.multiPerson
                  ? t(
                      "Ein Eintrag kann mehrere Mitglieder haben. Wer neu eingetragen wird, bekommt die Benachrichtigung.",
                      "A record can have several members. Whoever is newly added gets the notification.",
                    )
                  : t("Ein Eintrag hat höchstens ein Mitglied.", "A record has at most one member.")}
              </p>
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
                  <DatabaseOptions groups={linkableGroups} selected={fieldDraft.relationPage} />
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
          <FieldDefaultEditor
            draft={fieldDraft}
            disabled={!editable || !allowFieldChanges || schemaBusy}
            onChange={(value) =>
              setFieldDraft((f) => {
                const { defaultValue: _old, ...rest } = f;
                return value ? { ...rest, defaultValue: value } : rest;
              })
            }
          />
          <FieldRequiredEditor
            draft={fieldDraft}
            rows={data.rows}
            disabled={!editable || !allowFieldChanges || schemaBusy}
            onChange={(required) =>
              setFieldDraft((f) => {
                const { required: _old, ...rest } = f;
                return required ? { ...rest, required: true } : rest;
              })
            }
          />
          <FieldAccessEditor
            draft={fieldDraft}
            groups={data.groups || []}
            owner={data.role === "owner"}
            isTitle={fields[0]?.id === fieldDraft.id || (!fields.length)}
            disabled={!editable || !allowFieldChanges || schemaBusy}
            onChange={(access) =>
              setFieldDraft((f) => {
                const { access: _old, ...rest } = f;
                return access ? { ...rest, access } : rest;
              })
            }
          />
          {(fieldError || fieldVersion !== data.database.version) && (
            <p role="alert" className="error">
              {fieldVersion !== data.database.version
                ? t("Die Datenbank wurde zwischenzeitlich geändert. Dein Entwurf bleibt erhalten. Schließe den Dialog und öffne die Eigenschaft erneut, um den aktuellen Stand zu bearbeiten.", "The database was changed in the meantime. Your draft is kept. Close the dialog and open the property again to edit the current state.")
                : fieldError}
            </p>
          )}
          {optionConfirm && editable && allowFieldChanges && (
            // Renamed or merged options change existing records: asked
            // here, in place of the dialog's buttons, before saving.
            <div className="option-rename-confirm" role="group" aria-labelledby="option-rename-confirm-title">
              <h3 id="option-rename-confirm-title" className="settings-heading">
                {t("Vorhandene Einträge anpassen?", "Update existing records?")}
              </h3>
              <p>{t("Beim Speichern dieser Optionen ändern sich auch Einträge, Filter und Datenbankregeln:", "Saving these options also changes records, filters and database rules:")}</p>
              <ul>
                {(() => {
                  const merges = new Set(mergesOf(optionConfirm, (id) => fields.find((f) => f.id === id)?.options || []));
                  return optionConfirm.map((r) => {
                    const n = data.rows.filter((row) => {
                      const v = row.cells[r.field];
                      return v === r.from || (Array.isArray(v) && v.includes(r.from));
                    }).length;
                    const { from, to } = r;
                    return (
                      <li key={`${r.field}:${from}`}>
                        {merges.has(r)
                          ? n === 1
                            ? t(`„${from}“ mit „${to}“ zusammenführen (1 Eintrag).`, `Merge “${from}” into “${to}” in 1 record.`)
                            : t(`„${from}“ mit „${to}“ zusammenführen (${n} Einträge).`, `Merge “${from}” into “${to}” in ${n} records.`)
                          : n === 1
                            ? t(`„${from}“ in „${to}“ umbenennen (1 Eintrag).`, `Rename “${from}” to “${to}” in 1 record.`)
                            : t(`„${from}“ in „${to}“ umbenennen (${n} Einträge).`, `Rename “${from}” to “${to}” in ${n} records.`)}
                        {merges.has(r) &&
                          hasOwnSettings(data.database.settings, r.field, from) &&
                          ` ${t(`„${from}“ verliert seine eigenen Einstellungen unter „Statusregeln und Erledigt“.`, `“${from}” loses its own settings under “Status rules and done”.`)}`}
                      </li>
                    );
                  });
                })()}
              </ul>
              <p className="muted">
                {t("„Nur Optionen speichern“ lässt Einträge, Filter und Regeln bei den alten Namen.", "“Save options only” leaves records, filters and rules on the old names.")}
              </p>
              <div className="modal-actions">
                <button type="button" className="button" disabled={schemaBusy} onClick={() => setOptionConfirm(null)}>
                  {t("Abbrechen", "Cancel")}
                </button>
                <button type="button" className="button" disabled={schemaBusy} onClick={() => answerRenames(false)}>
                  {t("Nur Optionen speichern", "Save options only")}
                </button>
                <button type="button" className="button primary" autoFocus disabled={schemaBusy} onClick={() => answerRenames(true)}>
                  {t("Einträge anpassen", "Update records")}
                </button>
              </div>
            </div>
          )}
          {editable && allowFieldChanges && !optionConfirm && (
            <div className="modal-actions">
              {fields.some((f) => f.id === fieldDraft.id) &&
                fields[0].id !== fieldDraft.id && (
                  <button
                    type="button"
                    className="button danger"
                    disabled={schemaBusy}
                    onClick={async () => {
                      // Closes at once; a refusal opens the draft again.
                      setNewField(false);
                      const result = await updateSchema(
                        fields.filter((f) => f.id !== fieldDraft.id),
                        undefined,
                        undefined,
                        fieldVersion,
                      );
                      if (!result) {
                        setNewField(true);
                        setFieldError(
                          t("Die Eigenschaft konnte nicht gelöscht werden. Dein Entwurf bleibt erhalten.", "The property could not be deleted. Your draft is kept."),
                        );
                      }
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
        wide
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
                // New timelines draw calm arrows (#395).
                ...(viewType === "timeline" ? { timeline: NEW_TIMELINE } : {}),
              },
            ]);
            if (r) {
              setViewId(vid);
              setNewView(false);
            }
          }}
        >
          <fieldset className="view-type-picker">
            <legend>{t("Darstellung", "Display")}</legend>
            <div role="radiogroup" aria-label={t("Darstellung", "Display")} className="view-type-grid">
              {(Object.keys(viewIcons) as View["type"][]).filter((type) => moduleShownIn(hiddenModules, VIEW_MODULE[type])).map((type) => {
                const Icon = viewIcons[type];
                return (
                  <label key={type} className="view-type-card" data-active={viewType === type}>
                    <input
                      type="radio"
                      name="view-type"
                      value={type}
                      checked={viewType === type}
                      onChange={() => {
                        // The name follows the type until it is typed in.
                        if (!viewName || Object.values(viewTypeNames).some(([de, en]) => viewName === t(de, en))) setViewName(t(...viewTypeNames[type]));
                        setViewType(type);
                      }}
                    />
                    <Icon size={20} aria-hidden />
                    <strong>{t(...viewTypeNames[type])}</strong>
                    <small>{t(...viewTypeHints[type])}</small>
                  </label>
                );
              })}
            </div>
          </fieldset>
          <label>
            {t("Name", "Name")}
            <input required value={viewName} placeholder={t(...viewTypeNames[viewType])} onChange={(e) => setViewName(e.target.value)} />
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
          {t("Speichere einen Eintrag mit seinen Eigenschaften und Inhalten als Vorlage. Platzhalter wie {{Firma}} oder {{Heute}} werden beim Anwenden durch die Werte des Eintrags ersetzt.", "Save a record with its properties and content as a template. Placeholders like {{Company}} or {{Today}} are replaced with the record's values when the template is applied.")}
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
                className="button compact"
                title={t("Als Entwurf öffnen, ändern und mit „Als Vorlage speichern“ ersetzen", "Open as a draft, change it and replace it with “Save as template”")}
                onClick={async () => {
                  setManageTemplates(false);
                  const created = await createRow({}, true, template.id, true);
                  if (created) setTemplateDraft({ rowId: created.id, templateId: template.id });
                }}
              >
                {t("Bearbeiten", "Edit")}
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
      {(aiSummary || aiSummaryUsed) && <AiSummaryDialog target={aiSummary} onClose={() => setAiSummary(null)} />}
      {shareRecord && (
        <RecordShareDialog
          open
          onClose={() => setShareRecord(null)}
          pageId={page.id}
          rowId={shareRecord.id}
          title={shareRecord.title}
          mutate={(input) => mutate(input)}
          onError={onError}
        />
      )}
      {(() => {
        // The record's content, in its dialog or as a page of its own (#231).
        const detail = selected && (
          <div className="row-detail" ref={watchRecordWidth}>
            {record && (
              // Opened from a relation in another view (#192): where the
              // record lives, and the way there.
              <p className="related-record-origin">
                <PageIcon name={shownPageIcon(page.icon, "database")} size={15} />
                <span>{pages.find((p) => p.id === page.id)?.title || page.title}</span>
                <a
                  href={pageLocationHash({ pageId: page.id, rowId: selected.id })}
                  onClick={(e) => {
                    if (!plainClick(e)) return;
                    e.preventDefault();
                    record.onOpenInDatabase();
                  }}
                >
                  <ArrowSquareOut size={14} aria-hidden />
                  {t("In Datenbank öffnen", "Open in database")}
                </a>
              </p>
            )}
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
                              timeZone: occurrence.zone || view.calendar?.timeZone || browserZone(),
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
              <CoverFrame className="row-cover" cover={selected.cover} image={!selected.cover.startsWith("#")}>
                {selectedEditable && (
                  <button
                    className="button compact cover-change"
                    onClick={() => setRowCoverPicker(true)}
                  >
                    {t("Cover ändern", "Change cover")}
                  </button>
                )}
              </CoverFrame>
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
              {selected.icon && !(recordLayout.card === "contact" && selected.icon.startsWith("/api/")) && (
                <PageIcon
                  name={selected.icon}
                  size={30}
                  className="row-title-icon"
                />
              )}
              {titleMode(fields[0]) === "readonly" ? (
                // A formula or rollup title (or an ID made the title before
                // #463) is shown, formatted as in the table, not typed: the
                // server refuses changes of it.
                <span className="row-title-value">
                  {computedTitleText(selected) || t("Ohne Titel", "Untitled")}
                </span>
              ) : selectedEditable && titleMode(fields[0]) === "text" ? (
                <RowTitle
                  key={selected.id}
                  value={cellText(selected.cells[fields[0].id])}
                  focus={freshRowId === selected.id}
                  onSave={(title) => updateCell(selected, fields[0], title)}
                />
              ) : selectedEditable && !fieldLocked(selected, fields[0]) && titleMode(fields[0]) === "typed" ? (
                // A date, number, select or person title (#529): typed in
                // the writings the table reads, saved as the property's value.
                <TypedTitle
                  key={selected.id}
                  field={fields[0]}
                  value={selected.cells[fields[0].id]}
                  members={members}
                  focus={freshRowId === selected.id}
                  onSave={(v) => updateCell(selected, fields[0], v)}
                />
              ) : selectedEditable && !fieldLocked(selected, fields[0]) && titleMode(fields[0]) === "editor" ? (
                // Other types (a checkbox, relation, files …): the property's
                // own editor, as in the table.
                <span className="row-title-editor">
                  <CellInput
                    field={fields[0]}
                    value={selected.cells[fields[0].id]}
                    members={members}
                    related={related}
                    links
                    optionPicker={optionPicker(fields[0])}
                    onChange={(v) => updateCell(selected, fields[0], v)}
                    keepRequired
                    upload={uploadFile}
                    files={data.files}
                  />
                </span>
              ) : (
                <span className="row-title-value">
                  {titleMode(fields[0]) === "text"
                    ? cellText(selected.cells[fields[0].id]) || t("Ohne Titel", "Untitled")
                    : titleDisplayText(fields[0], selected.cells[fields[0].id], { members }) || t("Ohne Titel", "Untitled")}
                </span>
              )}
            </h2>
            {freshRowId === selected.id && <DuplicateHint workspaceId={page.workspace_id} title={cellText(selected.cells[fields[0].id])} databaseId={page.id} excludeRowId={selected.id} />}
            {recordLayout.card === "contact" && (
              <ContactCard row={selected} fields={fields} pageId={page.id} contacts={data.contacts} onError={onError} />
            )}
            <div
              className={`row-columns${recordLayout.properties === "side" ? " properties-side" : ""}`}
            >
              <div className="row-properties">
                <RecordPropertiesFold
                  databaseId={page.id}
                  rowId={selected.id}
                  count={recordFields.length}
                  choice={data.recordPropertiesCollapsed}
                  device={recordDevice}
                  fresh={freshRowId === selected.id}
                  summary={(recordSummary?.shown || []).map((f) => summaryChip(selected, f)).filter((x) => x !== null)}
                >
                  <RecordPropertyList
                    key={selected.id}
                    fields={recordFields}
                    allFields={fields}
                    order={recordLayout.order}
                    arrange={!!editable && allowFieldChanges}
                    save={(order) => act({ action: "database.recordLayout", layout: { ...recordLayout, order } })}
                    render={(f) => (
                    <Fragment key={`${selected.id}-${f.id}`}>
                      <PropertyRow>
                        <span className="row-property-name">
                          <FieldTypeIcon field={f} />
                          <span className="row-property-label">{f.name}</span>
                          {isRequired(f) && <RequiredMark />}
                          {contactLocked(data.contacts, selected.id, f.id) && <LdapMarker />}
                          {isMissing(f, selected.cells) && <RequiredMissing label />}
                        </span>
                        {computedTypes.includes(f.type) ? (
                          // Computed: shown, never edited.
                          <span className="record-value readonly">
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
                          <span className="row-property-value" title={lockedTitle(f, selected)}>
                            {recordPropertyValue(selected, f)}
                          </span>
                        )}
                      </PropertyRow>
                      {f.ai && (
                        <AiCellControl
                          pageId={page.id}
                          field={f}
                          rowId={selected.id}
                          meta={aiStatus.status?.meta[selected.id]?.[f.id]}
                          editable={canAi && !!selectedEditable && aiPageReadable(ai, page.id)}
                          onDone={() => {
                            void onRefresh().catch(() => {});
                            void aiStatus.reload();
                          }}
                          onError={onError}
                        />
                      )}
                      {f.type === "date" && reminderControl(selected, f)}
                      {f.id === firstDateId && dateExtras?.recurrence && recurrenceControl(selected)}
                      {f.id === firstDateId && dateExtras?.repeat && (
                        <RecordRepeat row={selected} fields={fields} editable={!!rowEditable(selected)} act={act} />
                      )}
                    </Fragment>
                    )}
                  />
                  {emptyHidden > 0 && (
                    <button
                      className="text-button"
                      aria-expanded={showEmpty}
                      onClick={() => setShowEmpty((v) => !v)}
                    >
                      {showEmpty
                        ? t("Leere Eigenschaften ausblenden", "Hide empty properties")
                        : emptyHidden === 1
                          ? t("1 leere Eigenschaft anzeigen", "Show 1 empty property")
                          : t(`${emptyHidden} leere Eigenschaften anzeigen`, `Show ${emptyHidden} empty properties`)}
                    </button>
                  )}
                </RecordPropertiesFold>
                {discoveryPanels && (<>
                <RelationBacklinks
                  key={`backlinks-${selected.id}-${selected.version}`}
                  pageId={page.id}
                  rowId={selected.id}
                />
                <UnlinkedMentions
                  key={`unlinked-${selected.id}`}
                  pageId={page.id}
                  rowId={selected.id}
                  editable={selectedEditable}
                  onOpen={(id, rowId) => {
                    location.hash = pageLocationHash({ pageId: id, rowId });
                  }}
                  onLinked={onRefresh}
                  onError={onError}
                />
                <RelatedPages key={`related-${selected.id}`} pageId={page.id} rowId={selected.id} />
                </>)}
              </div>
              <div className="row-main">
                {/* Pages below the record (#231) above its document (#449). */}
                {!record && recordLayout.subpages === "top" && (
                  <RecordSubPages
                    key={`subpages-${selected.id}`}
                    database={page}
                    rowId={selected.id}
                    pages={pages}
                    editable={selectedEditable && !readingRecord && !page.locked}
                    mutate={mutate}
                    onError={onError}
                    place="top"
                  />
                )}
                <RowDocument
                  key={`${selected.id}-${documentRevision}`}
                  pageId={page.id}
                  rowId={selected.id}
                  userId={userId}
                  pages={pages}
                  members={members}
                  editable={selectedEditable && !readingRecord}
                  readOnlyHint={readingRecord ? t("Im Lesemodus nicht änderbar", "Cannot be changed in reading mode") : undefined}
                  fields={fields}
                  templates={editable ? data.rowTemplates : undefined}
                  draftOf={templateDraft?.rowId === selected.id ? templateDraft.templateId : undefined}
                  onError={onError}
                  onChanged={onRefresh}
                />
                {/* Pages below the record (#231), like a page's sub-pages. */}
                {!record && recordLayout.subpages !== "top" && (
                  <RecordSubPages
                    key={`subpages-${selected.id}`}
                    database={page}
                    rowId={selected.id}
                    pages={pages}
                    editable={selectedEditable && !readingRecord && !page.locked}
                    mutate={mutate}
                    onError={onError}
                  />
                )}
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
                <IssueSyncChip key={`issue-${selected.id}`} pageId={page.id} rowId={selected.id} />
                {data.database.settings?.git && <RecordGit key={`git-${selected.id}`} pageId={page.id} rowId={selected.id} />}
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
                      <PageComment key={c.id} comment={c} pageId={page.id} userId={userId} act={act} />
                    ))}
                  {/* Formatted, with attachments and page mentions (#450). */}
                  <PageCommentField
                    key={`comment-${selected.id}`}
                    placeholder={t("Kommentar schreiben …", "Write a comment …")}
                    pageId={page.id}
                    rowId={selected.id}
                    act={act}
                    submitLabel={t("Senden", "Send")}
                  />
                </div>
              </div>
            </div>
            {selectedEditable && (
              <button
                className="button danger"
                onClick={() => {
                  // Gone at once; "Rückgängig" in the toast brings it back.
                  const id = selected.id;
                  setRowId(null);
                  void act({ action: "row.delete", rowId: id });
                }}
              >
                <Trash />
                {t("Eintrag löschen", "Delete record")}
              </button>
            )}
          </div>
        );
        if (docked && selected)
          return (
            <Suspense fallback={null}>
              <SidePanel
                kind="record"
                owner={`record:${page.id}`}
                label={t(`Eintrag „${recordTitle}“`, `Record “${recordTitle}”`)}
                title={recordTitle}
                actions={recordActions(selected)}
                onClose={closeRecord}
                className="record-dock"
                // A new record keeps the focus in its title.
                autoFocus={freshRowId !== selected.id}
              >
                {detail}
              </SidePanel>
            </Suspense>
          );
        if (pageRecord && selected)
          return (
            <section className={`record-page${recordFullWidth ? " record-page-wide" : ""}`} aria-label={t("Eintrag", "Record")}>
              <div className="record-page-bar">
                <div className="modal-heading-actions">{recordActions(selected)}</div>
              </div>
              {detail}
            </section>
          );
        return (
      <Modal
        open={!!selected && !pageRecord}
        onClose={closeRecord}
        // Back to the record's row or card, so the keyboard stays in the view.
        onCloseAutoFocus={(event) => {
          const row = lastOpened.current && boardRef.current?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(lastOpened.current)}"]`);
          const opener = row && (row.querySelector<HTMLElement>(".row-title-link, .row-open") || row.querySelector<HTMLElement>("button"));
          if (!opener) return;
          event.preventDefault();
          opener.focus();
        }}
        title={t("Eintrag", "Record")}
        wide
        // Centred records are bottom sheets on phones.
        sheet={recordMode !== "full" && recordMode !== "side"}
        actions={selected && recordActions(selected)}
        className={`record-dialog ${
          recordMode === "full"
            ? `modal-full${recordFullWidth ? " modal-full-wide" : ""}`
            : recordMode === "side"
              ? "modal-side"
              : recordLayout.properties === "side"
                ? "modal-record-wide"
                : ""
        }`}
      >
  {detail}
      </Modal>
        );
      })()}
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
          removeImage={(fileId) => mutate({ action: "file.delete", fileIds: [fileId], unusedOnly: true })}
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
      {viewMenu &&
        (() => {
          const index = views.findIndex((v) => v.id === viewMenu.id);
          const v = views[index];
          if (!v) return null;
          return (
            <ContextMenu
              x={viewMenu.x}
              y={viewMenu.y}
              label={t("Ansicht", "View")}
              onClose={() => setViewMenu(null)}
              items={[
                { icon: <PencilSimple />, label: t("Umbenennen", "Rename"), run: () => setRenamingView(v.id) },
                { icon: <CopySimple />, label: t("Duplizieren", "Duplicate"), run: () => void duplicateView(v.id) },
                { icon: <SlidersHorizontal />, label: t("Einstellungen …", "Settings …"), run: () => (setViewId(v.id), setConfig(true)) },
                {
                  icon: <Star weight={v.default ? "fill" : "regular"} />,
                  label: v.default ? t("Nicht mehr Standardansicht", "No longer the default view") : t("Als Standardansicht festlegen", "Set as default view"),
                  run: () => void setDefaultView(v.id),
                },
                "separator",
                { icon: <ArrowLeft />, label: t("Nach links", "Move left"), disabled: index === 0, run: () => void reorderView(v.id, views[index - 1].id, false) },
                { icon: <ArrowRight />, label: t("Nach rechts", "Move right"), disabled: index === views.length - 1, run: () => void reorderView(v.id, views[index + 1].id, true) },
                "separator",
                { icon: <Trash />, label: t("Ansicht löschen", "Delete view"), danger: true, disabled: views.length < 2, run: () => void deleteView(v.id) },
              ]}
            />
          );
        })()}
      {optionMenu &&
        (() => {
          const f = fields.find((x) => x.id === optionMenu.field);
          if (!f) return null;
          const current = optionColor(f, optionMenu.option);
          return (
            <ContextMenu
              x={optionMenu.x}
              y={optionMenu.y}
              label={t(`Option ${optionMenu.option}`, `Option ${optionMenu.option}`)}
              onClose={() => setOptionMenu(null)}
              items={[
                ...OPTION_COLORS.map((color) => ({
                  icon: <span className={`option-swatch opt-${color}`} aria-hidden />,
                  label: colorLabel(color, t),
                  checked: current === color,
                  run: () => void setOptionColor(f.id, optionMenu.option, color),
                })),
                "separator" as const,
                { icon: <SlidersHorizontal />, label: t("Optionen bearbeiten …", "Edit options …"), run: () => openFieldSettings(f) },
              ]}
            />
          );
        })()}
      {recordMenu && (
        <RecordMenu
          x={recordMenu.x}
          y={recordMenu.y}
          count={recordMenu.rowIds.length}
          editable={editable}
          onOpen={() => setRowId(recordMenu.rowIds[0])}
          onDuplicate={() => void recordsAction(recordMenu.rowIds, "duplicate")}
          onDelete={() => void recordsAction(recordMenu.rowIds, "delete")}
          onTransfer={(mode) => setTransfer({ rowIds: recordMenu.rowIds, mode })}
          onToPage={
            editable && data.rows.find((r) => r.id === recordMenu.rowIds[0])?.role !== "viewer"
              ? () => setToPage(recordMenu.rowIds[0])
              : undefined
          }
          onApplyTemplate={
            editable && data.rowTemplates?.length && data.rows.find((r) => r.id === recordMenu.rowIds[0])?.role !== "viewer"
              ? () => setApplyTo(recordMenu.rowIds[0])
              : undefined
          }
          onQr={() => {
            const row = data.rows.find((r) => r.id === recordMenu.rowIds[0]);
            if (row) setRecordQr({ id: row.id, title: cellText(row.cells[fields[0]?.id || "title"]) || t("Ohne Titel", "Untitled") });
          }}
          onQrLabels={() => setQrLabels({ rowIds: recordMenu.rowIds })}
          onClose={() => setRecordMenu(null)}
        />
      )}
      {recordQr && (
        <ItemQrDialog
          pageId={page.id}
          rowId={recordQr.id}
          title={recordQr.title}
          onClose={() => setRecordQr(null)}
        />
      )}
      {qrLabels && (
        <QrLabelsDialog
          pageId={page.id}
          rows={viewOrder(qrLabels.rowIds ? new Set(qrLabels.rowIds) : undefined)}
          fields={fields}
          context={clipboardContext()}
          selection={!!qrLabels.rowIds}
          viewName={view.name}
          onClose={() => setQrLabels(null)}
        />
      )}
      {applyTo && data.rowTemplates?.length > 0 && (
        <ApplyTemplateDialog
          templates={data.rowTemplates}
          hasContent={data.rows.find((r) => r.id === applyTo)?.preview?.hasContent}
          onApply={(templateId, mode) => applyTemplate(applyTo, templateId, mode)}
          onClose={() => setApplyTo(null)}
        />
      )}
      {toPage && (
        <RecordToPage
          pageId={page.id}
          rowId={toPage}
          onClose={() => setToPage(null)}
          onError={onError}
          onMoved={(created) => {
            setToPage(null);
            if (rowId === toPage) setLocalRowId(null);
            showToast({ text: t("In eine Seite umgewandelt.", "Turned into a page.") });
            void onRefresh().catch(() => {});
            location.hash = pageLocationHash({ pageId: created });
          }}
        />
      )}
      {transfer && (
        <TransferDialog
          pageId={page.id}
          rowIds={transfer.rowIds}
          initialMode={transfer.mode}
          canMove={editable}
          act={act}
          onClose={() => setTransfer(null)}
          onDone={(message) => {
            setTransfer(null);
            setSelection(new Map());
            if (transfer.rowIds.includes(rowId || "")) setRowId(null);
            showToast({ text: message });
          }}
        />
      )}
    </div>
    {relatedRecord.target && (
      <RelatedRecord
        target={relatedRecord.target}
        onClose={relatedRecord.close}
        onOpenInDatabase={relatedRecord.openInDatabase}
        onChanged={onRefresh}
        onError={onError}
        userId={userId}
        members={members}
        pages={pages}
        ai={ai}
        favoriteRows={favoriteRows}
      />
    )}
    </SprintContext.Provider>
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

// Files cells contain several controls; a <label> would forward every click
// to the first one (the file chooser).
// Title of a record, edited in place. Enter, leaving the field and closing
// the record save. Escape closes the record (the dialog hears it before the
// field) and unmounts the field without a blur, so what was typed is saved
// when the field goes – like the record's text.
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
  // Typed and not saved yet.
  const typed = useRef<string | null>(null);
  const latest = useRef({ value, onSave });
  useEffect(() => {
    latest.current = { value, onSave };
  });
  const save = useRef(() => {
    if (typed.current === null) return;
    const title = typed.current.replace(/\s+/g, " ").trim();
    typed.current = null;
    if (title !== latest.current.value) void latest.current.onSave(title);
  }).current;
  useEffect(() => () => save(), [save]);
  useEffect(() => {
    setDraft(value);
    typed.current = null;
  }, [value]);
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
  return (
    <textarea
      ref={input}
      className="row-title-input"
      aria-label={t("Titel des Eintrags", "Record title")}
      placeholder={t("Ohne Titel", "Untitled")}
      rows={1}
      value={draft}
      onChange={(e) => {
        typed.current = e.target.value.replace(/\n/g, "");
        setDraft(typed.current);
      }}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        } else if (e.key === "Escape") e.stopPropagation();
      }}
    />
  );
}

// A title of another type than text (#529) – a date, number, select or
// person: shown as the table shows it ("23. Nov. 2026", "12,5 kg"), typed
// as text on focus ("23.11.2026") and read into the stored value
// (lib/title-input.ts). What cannot be read stays in the field with a hint
// below it; nothing is saved then.
function TypedTitle({
  field,
  value,
  members,
  focus,
  onSave,
}: {
  field: Field;
  value: unknown;
  members: User[];
  focus: boolean;
  onSave: (value: unknown) => unknown;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => titleEditText(field, value, { members }));
  const [error, setError] = useState("");
  const errorId = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  // Typed and not saved yet.
  const typed = useRef<string | null>(null);
  const latest = useRef({ field, value, members, onSave, t });
  useEffect(() => {
    latest.current = { field, value, members, onSave, t };
  });
  // Reads what was typed; true when it was saved or nothing changed.
  const save = useRef(() => {
    if (typed.current === null) return true;
    const { field, value, members, onSave, t } = latest.current;
    const result = parseTitleInput(field, typed.current, { t, members, current: value });
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    typed.current = null;
    setError("");
    if (JSON.stringify(result.value ?? null) !== JSON.stringify(value ?? null)) void onSave(result.value);
    return true;
  }).current;
  useEffect(() => () => void save(), [save]);
  useEffect(() => {
    if (typed.current !== null) return;
    setDraft(titleEditText(field, value, { members }));
    setError("");
  }, [field, value, members]);
  useEffect(() => {
    if (!focus) return;
    input.current?.focus();
    input.current?.select();
  }, [focus]);
  const shown = editing || error ? draft : titleDisplayText(field, value, { members });
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
  }, [shown]);
  return (
    <span className="row-title-typed">
      <textarea
        ref={input}
        className="row-title-input"
        aria-label={t(`Titel des Eintrags (${field.name})`, `Record title (${field.name})`)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        placeholder={titlePlaceholder(field, t)}
        rows={1}
        value={shown}
        onFocus={() => setEditing(true)}
        onChange={(e) => {
          typed.current = e.target.value.replace(/\n/g, "");
          setDraft(typed.current);
          setError("");
        }}
        onBlur={() => {
          save();
          setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            // A value that cannot be read keeps the focus with its hint.
            if (save()) e.currentTarget.blur();
          } else if (e.key === "Escape") e.stopPropagation();
        }}
      />
      {error && (
        <span id={errorId} className="row-title-error" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}

// Marks a narrow record (up to 640 px) with data-narrow: its side
// properties move above the text (app/globals.css, "A narrow record"). A
// container query would make the record the containing block of the fixed
// menus in its text (#75). The first measurement lands before the first
// paint.
function watchRecordWidth(el: HTMLDivElement | null) {
  if (!el || typeof ResizeObserver === "undefined") return;
  const observer = new ResizeObserver(([entry]) => {
    const width = entry.contentBoxSize?.[0]?.inlineSize ?? entry.contentRect.width;
    el.toggleAttribute("data-narrow", width <= 640);
  });
  observer.observe(el);
  return () => observer.disconnect();
}
// One property of an opened record: its name (with the type's icon) and
// its value (#519). No <label>: the value is a button or a one-tap control
// named on its own.
function PropertyRow({ children }: { children: ReactNode }) {
  return <div className="row-property">{children}</div>;
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
    recordPart(pageId, rowId, "backlinks", () => api<Backlink[]>(`/api/pages/${pageId}/rows/${rowId}/backlinks`))
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
          <li key={`${link.pageId}-${link.rowId || ""}-${link.field}`}>
            <a
              href={pageLocationHash({
                pageId: link.pageId,
                rowId: link.rowId,
              })}
            >
              {link.title}
            </a>
            <small className="muted">
              {[link.pageTitle, link.field || t("im Text verlinkt", "linked in the text")]
                .filter(Boolean)
                .join(" · ")}
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
