"use client";
import { safeCollisionPadding } from "./safe-area";
import { applyTheme, setThemeChoice, themeChoice, watchTheme, type ThemeChoice } from "@/lib/theme";
import { readModeIds, toggleReadMode } from "@/lib/read-mode";
import { parseSettingsHash } from "@/lib/settings-sections";
import { addBackCloser, installAppBack } from "@/lib/app-back";
import { firstRun, installAppShortcuts } from "@/lib/app-shortcuts";
import { desktopApp, desktopPageLink, inDesktopApp, nativeApp, offerDesktopApp, openInWindow } from "@/lib/native-app";
import { currentOS } from "@/lib/device-os";
import { serverMessage } from "@/lib/i18n-errors";
import { LOCALE_TAG, tr } from "@/lib/locale-tag";
import { useLocale, useStatusLabel, useT, writeLocaleCookie } from "./i18n";
import { localeTag, translate, type Locale } from "@/lib/i18n";
import { BrandMark } from "./brand-mark";
import { CoverFrame } from "./cover-frame";
import { clearPlaceholders } from "./image-placeholder";
import { transitionView, withoutViewTransition, type Morph } from "@/lib/view-transition";
import { Select } from "./select";
import { CommentHub } from "./comment-hub";
import { WorkspaceIcon } from "./workspace-icon";
import {
  useOfflineQueue,
  isQueueable,
  OfflineConflicts,
} from "./offline-queue";
import { applyQueue } from "@/lib/offline-queue";
import { draftKey, draftSent, keyed } from "@/lib/idempotency-key";
import {
  parsePageLocation,
  pageLocationHash,
  notificationUrl,
  type PageLocation,
} from "@/lib/page-location";
import { SpaceAppearance, SpaceIcon } from "./space-appearance";
import { CoverPicker } from "./cover-picker";
import { SpaceManager } from "./space-manager";
import { SpaceExportDialog } from "./space-export";
import { Onboarding } from "./onboarding";
import { FindInPage } from "./find-in-page";
import { AppPromo } from "./app-promo";
import { actionLabel, KeyboardShortcuts } from "./keyboard-shortcuts";
import { Presentation } from "./presentation";
import { SplitDivider, SplitPane, clampSplit } from "./split-pane";
import { SIDEBAR_WIDTH_KEY, SidebarResize, clampSidebar } from "./sidebar-resize";
import { ActivityPing } from "./activity-ping";
import { useDrawerSwipe } from "./drawer-swipe";
import { useKeyboardHints } from "@/lib/keyboard-hints";
import { activeKeymap, matchAction, setKeymapOverrides, shortcutHint, subscribeKeymap, type KeymapOverrides, type ShortcutAction } from "@/lib/keymap";
import { PagePeople } from "./page-people";
import { PageReview, openPageReview } from "./page-review";
import { openPageAliases, AliasIcon } from "./page-aliases";
import { AiBlockToggle } from "./ai-settings";
import { AskPanel } from "./ai-ask";
import { AiDatabaseCreator, proposalPayload, type DatabaseProposal } from "./ai-database";
import { AiProvider, useAiRoute } from "./ai-context";
import { AiSummaryPanel, type AiSummaryTarget } from "./ai-summary";
import { aiUsable } from "@/lib/ai/client";
import {
  imageAccept,
  imageFileId,
  type PageImage,
} from "@/lib/page-appearance";
import type { SearchKind, SearchResult } from "@/lib/search-index";
import { IconImagePicker } from "./icon-image-picker";
import { IconLibraryPicker } from "./icon-library-picker";
import { iconPixels } from "@/lib/page-appearance";
import { VersionChanges } from "./version-changes";
import { LinkPreview } from "./link-preview";
import { edgeScroller } from "./edge-scroll";
import { MediaLibrary } from "./media-library";
import {
  checkOfflineOwner,
  disableOffline,
  registerServiceWorker,
} from "./offline";
import { useOfflineRefresh } from "./offline-refresh";
import { appCopyUnreachable } from "@/lib/offline-store";
import SavedTemplates from "./saved-templates";
import { useState, useEffect, useCallback, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { Toaster, showToast, showUndo, toastSerial, undoShownSince } from "./toast";
import { commandOverlay } from "@/lib/optimistic-commands";
import { dropSpace, moveSpaceBy, readCollapsedSpaces, writeCollapsedSpaces } from "@/lib/space-moves";
import type { UndoPlan } from "@/lib/undo";
import { appCache, bootKey, clearAppCache, pageCachePolicy, pageKey } from "@/lib/swr-cache";
import { configurePrefetch, installPrefetch, pendingPrefetch, prefetchPage, prefetchRecord, INTENT_DELAY } from "./prefetch";
import { ListSkeleton, viewShapeOf } from "./skeleton";
import { anyOf, byText, bySelector, jumpTo, snippetHit } from "@/lib/jump";
import { flipList, installTaskFeedback, sameRelativeOrder, type Point } from "@/lib/motion";
import { Collapse, CrossFade, useLeaving } from "./motion";
import dynamic from "next/dynamic";
import { ViewBoundary, loadView } from "@/components/view-fallback";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import {
  Images,
  BookmarkSimple,
  Stack,
  CaretDown,
  CaretRight,
  ArrowUp,
  ArrowDown,
  CheckSquare,
  DotsSixVertical,
  Plus,
  MagnifyingGlass,
  House,
  Bell,
  Star,
  Clock,
  UsersThree,
  Trash,
  BookOpen,
  PencilSimple,
  GearSix,
  SidebarSimple,
  DotsThree,
  ArrowSquareOut,
  AppWindow,
  Desktop,
  ShareNetwork,
  ChatCircle,
  Check,
  CloudCheck,
  WifiSlash,
  X,
  ArrowLeft,
  ArrowRight,
  FileText,
  Table,
  Tray,
  PresentationChart,
  Gauge,
  NotePencil,
  Notebook,
  Lock,
  Copy,
  DownloadSimple,
  UploadSimple,
  ShieldCheck,
  SignOut,
  Scales,
  Sun,
  Moon,
  Users,
  ArrowCounterClockwise,
  Globe,
  Link as LinkIcon,
  SquaresFour,
  Flag,
  ArrowUpRight,
  ImageSquare,
  TextAa,
  Printer,
  ClockCounterClockwise,
  Graph,
  Sparkle,
  MarkdownLogo,
  WarningCircle,
  Question,
  Keyboard,
  Presentation as PresentIcon,
  SquareSplitHorizontal,
  SlidersHorizontal,
  CalendarBlank,
  CalendarCheck,
  CalendarDots,
  FolderSimple,
} from "@phosphor-icons/react";
import type {
  Bootstrap,
  Page,
  PageKind,
  Comment,
  User,
  Role,
  Space,
  Row,
} from "@/lib/types";
import { PageExportDialog } from "./page-export";
import { queueNotebookImport } from "./notebook/pending-import";
import { MobileTabBar, guardChromeTouches, useShellDocument, useSoftKeyboard } from "./mobile-tab-bar";
import {
  Modal,
  PageIcon,
  Avatar,
  setAvatarDirectory,
  api,
  download,
  ApiError,
  isTransient,
  PageSkeleton,
  endedSession,
  reportError,
  setErrorToaster,
  SIGNED_OUT_EVENT,
} from "./ui";
import DatabaseView, { type DatabaseData } from "./database-view";
import Settings from "./settings";
import Admin from "./admin";
import { ShareLinks } from "./share-links";
import { PublicationDomain } from "./publication-domain";
import { LinkProtection, ProtectionChips } from "./link-protection";
import { MovePageDialog } from "./move-page-dialog";
import { JournalView, localDay, type JournalDay } from "./journal-view";
import { JournalDayNav, JournalTreeItem, monthLabel } from "./journal-nav";
import {
  allDaysKey,
  DEFAULT_SIDEBAR_MODE,
  isFolderKey,
  journalSidebar,
  shownTreeIds,
  todayKey,
  type SidebarEntry,
} from "@/lib/journal-nav";
import { MyTasks } from "./my-tasks";
import HomeScreen from "./home/home";
import { relativeTime } from "./home/format";
import { FocusBar } from "./focus-bar";
import { PageGraph } from "./page-graph";
import { QuickCapture } from "./quick-capture";
import { printPage } from "./print-page";
import { exportDocumentHtml } from "@/lib/document-html";
import { PageToRecord } from "./page-to-record";
import {
  DatabaseKindPicker,
  databaseChoicePayload,
  rememberDatabaseKind,
  rememberedDatabaseKind,
  type DatabaseChoice,
} from "./database-kind-picker";
import { UnlinkedMentions } from "./unlinked-mentions";
import { DuplicateHint, RelatedPages } from "./related-pages";
import {
  FollowButton,
  ReadersButton,
  ago,
  SinceVisitBanner,
  type Reader,
  type SinceVisit,
} from "./page-activity";
import {
  JournalDayBar,
  JournalLockScreen,
  type DayEntry,
  type JournalSettings,
} from "./journal-parts";
import type { ShareLink } from "@/lib/share-links";
import { catalogFor } from "@/lib/template-catalogs";
import { templateCategories } from "@/lib/template-categories";
import { E2eeSetupDialog, E2eeUnlockDialog, EncryptedPage, EncryptedSpaceMembers, EncryptedTitleInput, useDecryptedTitles } from "./e2ee";
import { createEncryptedSpace, encryptTitle, loadIdentity, openSpace, useE2ee } from "./e2ee-store";
import { ENCRYPTED_TITLE } from "@/lib/e2ee";
import { CalendarX, LockKey } from "@phosphor-icons/react";
// Shown while the parts load (they use the reader's language).
function Loading({ what }: { what: "emoji" | "document" | "whiteboard" }) {
  const t = useT();
  const locale = useLocale();
  if (what === "emoji") return <p>{t("Emojis werden geladen …", "Loading emojis …")}</p>;
  return (
    <PageSkeleton
      compact
      label={what === "document" ? t("Dokument wird geöffnet …", "Opening document …") : t("Whiteboard wird geöffnet …", "Opening whiteboard …")}
    />
  );
}
const EmojiPicker = dynamic(() => loadView(() => import("./emoji-picker")), {
  ssr: false,
  loading: () => <Loading what="emoji" />,
});
const DocumentEditor = dynamic(() => loadView(() => import("./editor")), {
  ssr: false,
  loading: () => <Loading what="document" />,
});
const DashboardView = dynamic(() => loadView(() => import("./dashboard-view")), { ssr: false });
// Notebooks bring the ink engine: loaded with the first notebook.
const NotebookView = dynamic(() => loadView(() => import("./notebook/notebook-view")), { ssr: false, loading: () => <PageSkeleton compact /> });
const Whiteboard = dynamic(() => loadView(() => import("./whiteboard/whiteboard")), {
  ssr: false,
  loading: () => <Loading what="whiteboard" />,
});
type PageData = DatabaseData & {
  whiteboard?: { state: string; generation: string };
  dashboard?: import("./dashboard-view").DashboardPayload;
  notebook?: import("@/lib/notebook").NotebookPayload;
  journal?: { days: JournalDay[]; settings?: JournalSettings };
  journalDay?: {
    journalId: string;
    date: string;
    trackers: JournalSettings["trackers"];
    options?: { place: boolean; events: boolean };
    entry: DayEntry;
  };
  // Behind a journal PIN that was not entered yet.
  locked?: { journalId: string };
  // Today's journal day before it exists (lib/journal-days.ts): created by
  // the first change, until then nothing is stored.
  draft?: { journalId: string; date: string };
  // A page of an end-to-end encrypted space (components/e2ee.tsx).
  encrypted?: { spaceId: string; keyVersion: number; encryptTitles: boolean };
  sinceVisit?: SinceVisit | null;
  readers?: Reader[];
  following?: boolean;
  followers?: number;
  shareLinks?: ShareLink[];
  publication?: {
    includeChildren: boolean;
    count: number;
    allowCopy?: boolean;
    publishedAt?: string | null;
    password?: boolean;
    expiresAt?: number | null;
  };
  page: Page;
  role: Role;
  html: string;
  state: string | null;
  generation: string;
  backlinks: { id: string; title: string; icon: string; rowId?: string; pageTitle?: string }[];
  snapshots: {
    id: string;
    title: string;
    created_at: string;
    kind?: "auto" | "manual";
  }[];
  present: { id: string; name: string }[];
};
type CommandAction = {
  label: string;
  keywords: string;
  icon: import("@phosphor-icons/react").Icon;
  run: () => void;
};
// One row of the command palette: a search hit, a recently viewed page or a
// command. The id names the option for aria-activedescendant.
type PaletteItem =
  | { kind: "result"; id: string; result: SearchResult }
  | { kind: "recent"; id: string; page: Page }
  | { kind: "command"; id: string; action: CommandAction };
// Typing there: "?" is a character, not the shortcut overlay.
const isTyping = (el: EventTarget | null) =>
  el instanceof HTMLElement &&
  (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
const normalizeCommand = (value: string) =>
  value
    .toLocaleLowerCase("de")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
type Screen =
  | "home"
  | "page"
  | "trash"
  | "inbox"
  | "tasks"
  | "graph"
  | "media"
  | "settings"
  | "admin";
// Page tree → page header: the icon and the title of the page opened fly
// to their place (lib/view-transition.ts). Without a header yet (the page
// is still loading) they simply fade.
function pageMorph(source: { icon: Element | null; title: Element | null } | null): Morph[] {
  if (!source) return [];
  const header = () => document.querySelector(".split-primary .document-header");
  return [
    { name: "fp-page-icon", from: source.icon, to: () => header()?.querySelector(".large-page-icon") },
    { name: "fp-page-title", from: source.title, to: () => header()?.querySelector(".page-title") },
  ];
}
export default function WorkspaceApp({
  initial,
  useTemplate,
  inviteResult,
}: {
  initial: Bootstrap;
  // Public gallery: create a page from this template once signed in.
  useTemplate?: string;
  // Opened through an invitation link (?invite=…).
  inviteResult?: "accepted" | "invalid";
}) {
  const toggleReadingRef = useRef(() => {});
  // What a global shortcut does (set each render, see runShortcut).
  const shortcutRef = useRef((_action: ShortcutAction) => {});
  const t = useT();
  const statusLabel = useStatusLabel();
  const locale = useLocale();
  // A language fixed in the profile: the server already renders it; the
  // cookie follows for the pages before signing in. No reload – a cookie the
  // browser keeps elsewhere must not lead to a loop.
  useEffect(() => {
    if (initial.language) writeLocaleCookie(initial.language);
  }, [initial.language]);
  const [clock, setClock] = useState<number | null>(null);
  useEffect(() => {
    // The server and initial browser render must not depend on different clocks.
    const update = () => setClock(Date.now());
    update();
    const timer = setInterval(update, 60000);
    document.addEventListener("visibilitychange", update);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  // What the server sent last; the shown `boot` and `data` add the changes
  // still on their way (optimistic layers, see `mutate` below).
  const [bootState, setBoot] = useState(initial),
    [pageId, setPageId] = useState<string | null>(null),
    [screen, setScreen] = useState<Screen>("home"),
    [dataState, setData] = useState<PageData | null>(null),
    [mobile, setMobile] = useState(false),
    [search, setSearch] = useState(false),
    // The keyboard shortcut overlay ("?", ⌘/, command, sidebar).
    [shortcuts, setShortcuts] = useState(false),
    // The highlighted row of the command palette (aria-activedescendant).
    [paletteActive, setPaletteActive] = useState(0),
    // The page that is the Tab stop of its space's tree (roving tabindex).
    [treeFocus, setTreeFocus] = useState<string | null>(null),
    // "KI fragen": open with an optional first question.
    [ask, setAsk] = useState<{ question: string } | null>(null),
    [query, setQuery] = useState(""),
    [create, setCreate] = useState(false),
    [newTitle, setNewTitle] = useState(""),
    [newKind, setNewKind] = useState<PageKind>("document"),
    // "New notebook from PDF": the file the new notebook imports.
    [notebookPdf, setNotebookPdf] = useState<File | null>(null),
    [databaseChoice, setDatabaseChoice] = useState<DatabaseChoice>("tasks"),
    // "Mit KI erstellen": the reviewed proposal (null: not yet proposed).
    [aiCreate, setAiCreate] = useState(false),
    [aiProposal, setAiProposal] = useState<DatabaseProposal | null>(null),
    [capture, setCapture] = useState(false),
    // Raised to open the start page's editor (command palette).
    [customizeHome, setCustomizeHome] = useState(0),
    [toRecord, setToRecord] = useState(false),
    [parent, setParent] = useState<string | null>(null),
    [spaceId, setSpaceId] = useState(initial.spaces[0]?.id || ""),
    [templates, setTemplates] = useState(false),
    [share, setShare] = useState(false),
    [pageExport, setPageExport] = useState(false),
    // The page shown as Markdown ("Als Markdown bearbeiten").
    [sourcePage, setSourcePage] = useState<string | null>(null),
    [spaceExport, setSpaceExport] = useState<string | null>(null),
    [onboarding, setOnboarding] = useState(!!initial.onboarding),
    [find, setFind] = useState({ open: false, key: 0 }),
    [spaceManager, setSpaceManager] = useState<{
      space: Space;
      purge?: boolean;
    } | null>(null),
    [history, setHistory] = useState(false),
    [comments, setComments] = useState(false),
    // "Mit KI zusammenfassen" of the open page (side panel).
    [aiSummary, setAiSummary] = useState<AiSummaryTarget | null>(null),
    [focusMode, setFocusMode] = useState(false),
    // Documents opened for reading on this device (no editing, no handles).
    [readPages, setReadPages] = useState<string[]>([]),
    [comment, setComment] = useState(""),
    [status, setStatus] = useState("Gespeichert"),
    // The session ended while the app was open: a banner until the reader signs in again.
    [signedOut, setSignedOut] = useState(false),
    [busy, setBusy] = useState(false),
    // A kept copy is shown while the fresh one loads (stale-while-revalidate).
    [revalidating, setRevalidating] = useState(false),
    [dark, setDark] = useState(false),
    [theme, setTheme] = useState<ThemeChoice>("system"),
    [iconPicker, setIconPicker] = useState(false),
    [coverPicker, setCoverPicker] = useState(false),
    [newWorkspace, setNewWorkspace] = useState(false),
    [workspaceName, setWorkspaceName] = useState(""),
    [newSpace, setNewSpace] = useState(false),
    [spaceName, setSpaceName] = useState(""),
    [spaceIcon, setSpaceIcon] = useState("folder"),
    [spaceColor, setSpaceColor] = useState("none"),
    [privateSpace, setPrivateSpace] = useState(false),
    // "Verschlüsselter Bereich": end-to-end encrypted, optionally with titles.
    [encryptedSpace, setEncryptedSpace] = useState(false),
    [encryptTitles, setEncryptTitles] = useState(false),
    [e2eeDialog, setE2eeDialog] = useState<"setup" | "unlock" | null>(null),
    [spaceKeys, setSpaceKeys] = useState<string | null>(null),
    [epoch, setEpoch] = useState(0),
    [collapsed, setCollapsed] = useState<Set<string>>(new Set()),
    // Year and month folders of journals opened or closed by hand (#49).
    [journalFolders, setJournalFolders] = useState<{ open: Set<string>; closed: Set<string> }>(() => ({ open: new Set(), closed: new Set() })),
    // "Alle Tage …" in the tree: the journal to show at its list of days.
    [revealJournalDays, setRevealJournalDays] = useState<string | null>(null),
    // Quick filter above the page tree.
    [treeFilter, setTreeFilter] = useState(""),
    [online, setOnline] = useState(true),
    [move, setMove] = useState(false),
    // Right click on a page in the sidebar: its actions at the pointer.
    [pageMenu, setPageMenu] = useState<{ page: Page; x: number; y: number } | null>(null),
    [templateName, setTemplateName] = useState(false),
    [templateTitle, setTemplateTitle] = useState("");
  // The tab's cache of recent pages belongs to this person (another one
  // empties it) – before the first page opens.
  useState(() => {
    if (typeof window !== "undefined") appCache().scope(initial.user.id);
  });
  // Changes shown before the server answered (lib/optimistic.ts): each
  // request's layer over the workspace and the open page, dropped once the
  // reloaded state is there – or when the server refused (the old state
  // comes back by itself, the error toast says why).
  const [layers, setLayers] = useState<Layer[]>([]);
  const boot = useMemo(() => layers.reduce((b, layer) => (layer.boot ? safeLayer(layer.boot, b) : b), bootState), [bootState, layers]);
  const data = useMemo(
    () => (dataState ? layers.reduce((d, layer) => (layer.page ? safeLayer(layer.page, d) : d), dataState) : null),
    [dataState, layers],
  );
  // "Mit KI zusammenfassen" in the page menu: on the server, or in the apps
  // on Apple devices on the device – there also in encrypted spaces.
  const summaryRoute = useAiRoute("summarize", data?.page.id, { status: boot.ai || null, encrypted: !!data?.encrypted });
  const [treeDrop, setTreeDrop] = useState<{
    id: string;
    // "records": records from a database dropped onto another database.
    placement: "before" | "after" | "inside" | "records";
  } | null>(null);
  // Profile pictures for every Avatar below, from the current member list.
  setAvatarDirectory([...boot.members, boot.user]);
  const [desktopCollapsed, setDesktopCollapsed] = useState(false);
  // The sidebar's width on wide screens, dragged at its right edge (kept per
  // device, read after the first render so it matches the server's; null:
  // the default from the stylesheet).
  const [sidebarWidth, setSidebarWidth] = useState<number | null>(null);
  const sidebarWidthRead = useRef(false);
  useEffect(() => {
    try {
      if (!sidebarWidthRead.current) {
        sidebarWidthRead.current = true;
        const stored = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
        if (stored) setSidebarWidth(clampSidebar(stored));
        return;
      }
      if (sidebarWidth === null) localStorage.removeItem(SIDEBAR_WIDTH_KEY);
      else localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
    } catch {}
  }, [sidebarWidth]);
  // Presentation mode of the open document (components/presentation.tsx).
  const [presenting, setPresenting] = useState<{ html: string; title: string } | null>(null);
  // Split view (components/split-pane.tsx): the page shown next to the open
  // one, kept in the address as ?split=<id> so a reload keeps it.
  const [split, setSplit] = useState<string | null>(() => {
      if (typeof location === "undefined") return null;
      const id = new URLSearchParams(location.search).get("split");
      return id && /^[0-9a-f-]{36}$/i.test(id) ? id : null;
    }),
    // The share of the width the open page takes, in percent (kept per
    // device; only shown once the window is known to be wide, after the
    // first render).
    [splitRatio, setSplitRatio] = useState(() => {
      try {
        const stored = Number(localStorage.getItem("flowplan-split-ratio"));
        return stored ? clampSplit(stored) : 50;
      } catch {
        return 50;
      }
    }),
    // Wider than 1024 px: split view is possible.
    [wide, setWide] = useState(false),
    // The quick search opens the chosen page in the split view.
    [paletteSplit, setPaletteSplit] = useState(false),
    // A page from the tree is being dragged: the drop zone at the right edge shows.
    [pageDrag, setPageDrag] = useState(false),
    [splitDropOver, setSplitDropOver] = useState(false);
  // The drag of a tree entry ended (its dragend), even before pageDrag was set.
  const pageDragEnded = useRef(true);
  // The tree entry's dragend does not arrive when the entry is re-rendered or
  // removed during the drag (moved in the tree, list refreshed): any end of
  // a drag on the page – or the pointer moving again without a button,
  // which only happens once no drag is running – hides the drop zone.
  useEffect(() => {
    if (!pageDrag) return;
    const end = () => {
      pageDragEnded.current = true;
      setPageDrag(false);
      setSplitDropOver(false);
    };
    const moved = (e: MouseEvent) => {
      if (e.buttons === 0) end();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && end();
    document.addEventListener("dragend", end, true);
    document.addEventListener("drop", end);
    document.addEventListener("mousemove", moved, true);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("dragend", end, true);
      document.removeEventListener("drop", end);
      document.removeEventListener("mousemove", moved, true);
      document.removeEventListener("keydown", key, true);
    };
  }, [pageDrag]);
  // Shortcut hints: only with a keyboard, written for this device's system
  // (⌘ on Apple devices, Ctrl elsewhere) – lib/keyboard-hints.ts.
  const keyHints = useKeyboardHints(),
    mac = keyHints.mac;
  const splitRow = useRef<HTMLDivElement>(null),
    wideRef = useRef(false),
    presentingRef = useRef(false);
  wideRef.current = wide;
  presentingRef.current = !!presenting;
  useEffect(() => {
    const media = matchMedia("(min-width: 1025px)");
    const update = () => setWide(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem("flowplan-split-ratio", String(splitRatio));
    } catch {}
  }, [splitRatio]);
  // The address follows the split page (the hash stays the main page's).
  useEffect(() => {
    const url = new URL(location.href);
    if ((url.searchParams.get("split") || null) === split) return;
    if (split) url.searchParams.set("split", split);
    else url.searchParams.delete("split");
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  }, [split]);
  // The own keyboard shortcuts (lib/keymap.ts) for every global handler.
  useEffect(() => setKeymapOverrides(boot.shortcuts), [boot.shortcuts]);
  useSyncExternalStore(subscribeKeymap, activeKeymap, activeKeymap);
  // Sidebar multi-selection (Ctrl/⌘/Shift-click or selection mode on touch).
  const [selectedPages, setSelectedPages] = useState<string[]>([]),
    [selecting, setSelecting] = useState(false),
    [bulkDialog, setBulkDialog] = useState<"move" | "delete" | null>(null),
    [bulkTarget, setBulkTarget] = useState(""),
    [bulkBusy, setBulkBusy] = useState(false);
  const lastSelected = useRef<string | null>(null),
    touchDrag = useRef<{ source: string; pointer: number } | null>(null),
    touchHoverRef = useRef((_x: number, _y: number) => {}),
    // Holding the tree handle near the edge of the page list scrolls it.
    [treeScroll] = useState(() =>
      edgeScroller((x, y) => touchHoverRef.current(x, y)),
    );
  const [privateTemplate, setPrivateTemplate] = useState(false);
  const [starterTemplate, setStarterTemplate] = useState<string | null>(null);
  const [galleryCategory, setGalleryCategory] = useState("all");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchKind, setSearchKind] = useState<SearchKind>("all");
  const [iconTab, setIconTab] = useState<"emoji" | "image" | "library">(
    "emoji",
  );
  const [versionChanges, setVersionChanges] = useState<{
    id: string;
    label: string;
  } | null>(null);
  const [searchSpace, setSearchSpace] = useState("");
  // "Ohne Journaltage": hits on journal days left out (remembered here).
  const [searchNoDays, setSearchNoDays] = useState(false);
  useEffect(() => {
    try {
      setSearchNoDays(localStorage.getItem("flowplan:search-no-days") === "1");
    } catch {}
  }, []);
  const toggleSearchNoDays = () =>
    setSearchNoDays((on) => {
      try {
        localStorage.setItem("flowplan:search-no-days", on ? "0" : "1");
      } catch {}
      return !on;
    });
  const [inboxFilter, setInboxFilter] = useState<"all" | "unread">("all");
  const [searchName, setSearchName] = useState<string | null>(null);
  // The element that opened the quick search gets the focus back when it
  // closes (the search button, a tree item or the editor).
  const searchOpener = useRef<HTMLElement | null>(null),
    searchOpen = useRef(false),
    mainRef = useRef<HTMLElement>(null);
  searchOpen.current = search;
  const openSearch = useCallback(() => {
    if (!searchOpen.current) searchOpener.current = document.activeElement as HTMLElement | null;
    setSearch(true);
  }, []);
  const closeSearch = () => {
    setSearch(false);
    setPaletteSplit(false);
    setQuery("");
    setSearchName(null);
  };
  // A search is on its way: placeholders instead of "Nothing found".
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    if (!search) return;
    const controller = new AbortController();
    setSearching(!!query.trim());
    const timer = setTimeout(() => {
      fetch(
        `/api/search?${new URLSearchParams({
          workspace: boot.workspace.id,
          q: query,
          kind: searchKind,
          ...(searchSpace ? { space: searchSpace } : {}),
          ...(searchNoDays ? { days: "0" } : {}),
        })}`,
        { signal: controller.signal },
      )
        .then((r) => (r.ok ? r.json() : []))
        .then((results) => {
          setSearchResults(results);
          setSearching(false);
        })
        .catch(() => {
          if (!controller.signal.aborted) setSearching(false);
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, search, boot.workspace.id, searchKind, searchSpace, searchNoDays]);
  const currentId = useRef(pageId),
    currentWorkspace = useRef(boot.workspace.id),
    screenRef = useRef(screen),
    html = useRef("");
  // The page and screen being opened run ahead of the state while a view
  // transition waits to show them (lib/view-transition.ts): the refs follow
  // the state when it changes, not on every render.
  const followed = useRef({ pageId, screen });
  if (followed.current.pageId !== pageId) currentId.current = pageId;
  if (followed.current.screen !== screen) screenRef.current = screen;
  followed.current = { pageId, screen };
  currentWorkspace.current = boot.workspace.id;
  // Confirmations, errors and undo offers: one toast (components/toast.tsx).
  const notify = useCallback((s: string, error = false) => {
    showToast({ text: s, tone: error ? "error" : "info" });
  }, []);
  // Every failure goes through showError()/reportError() in components/ui.tsx:
  // friendly copy per kind, inline in an open dialog, otherwise this toast.
  useEffect(
    () =>
      setErrorToaster((view) => {
        const retry = view.retry;
        showToast({
          text: view.title,
          detail: view.detail,
          tone: "error",
          // Errors stay a little longer; one with a retry until it is used.
          duration: retry ? 12000 : 8000,
          ...(retry ? { action: { label: tr("Erneut versuchen", "Retry"), run: retry } } : {}),
        });
      }),
    [],
  );
  // The onError handler handed to components (they pass error.message; the
  // kind is recovered from the request that failed).
  const notifyError = useCallback(
    (error: unknown, retry?: () => void) => reportError(error, { retry }),
    [],
  );
  const setHtml = useCallback((s: string) => {
    html.current = s;
  }, []);
  const readHtml = useCallback(
    () => html.current || dataRef.current?.html || "",
    [],
  );
  const navigationVersion = useRef(0);
  const navigationPending = useRef(false);
  const refresh = useCallback(async () => {
    if (navigationPending.current) return;
    const version = navigationVersion.current;
    let result: Bootstrap;
    try {
      result = await api<Bootstrap>(
        `/api/bootstrap?workspace=${currentWorkspace.current}`,
      );
    } catch (error) {
      if (version !== navigationVersion.current || navigationPending.current)
        return;
      if (error instanceof ApiError && error.status === 404) {
        setData(null);
        window.location.assign("/");
        return;
      }
      throw error;
    }
    if (navigationPending.current || version !== navigationVersion.current)
      return;
    setBoot(result);
    if (
      result.workspace.id !== currentWorkspace.current ||
      (screenRef.current === "page" &&
        !(dataRef.current?.draft && dataRef.current.page.id === currentId.current) &&
        !result.pages.some(
          (page) => page.id === currentId.current && !page.deleted_at,
        ))
    ) {
      setPageId(null);
      currentId.current = null;
      setData(null);
      setScreen("home");
      screenRef.current = "home";
      location.hash = "home";
      currentWorkspace.current = result.workspace.id;
      return;
    }
    if (currentId.current && screenRef.current === "page") {
      const pid = currentId.current;
      // A page shown for the first time (e.g. opened by its link) counts
      // as a visit; later reloads of the same page do not.
      const first = dataRef.current?.page.id !== pid;
      const p = await api<PageData>(
        `/api/pages/${pid}`,
        undefined,
        first ? { "X-Flowplan-Visit": "1" } : {},
      );
      if (
        pid === currentId.current &&
        version === navigationVersion.current &&
        !navigationPending.current
      )
        setData(p);
    }
  }, []);
  // Record changes without a connection wait on this device (see
  // components/offline-queue.tsx) and are shown in the views meanwhile.
  const offlineQueue = useOfflineQueue({
    userId: boot.user.id,
    onSynced: refresh,
    notify,
  });
  const dataRef = useRef(data);
  dataRef.current = data;
  const bootRef = useRef(boot);
  bootRef.current = boot;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  // How a page may be kept: never for journals (a PIN may guard them), only
  // in memory for end-to-end encrypted spaces (lib/swr-cache.ts).
  const cachePolicy = useCallback(
    (value: unknown) =>
      pageCachePolicy(
        value as PageData,
        bootRef.current.pages,
        bootRef.current.spaces.filter((s) => (s as { encrypted?: number }).encrypted).map((s) => s.id),
      ),
    [],
  );
  // Every state of the open page the server sent (opening, the reload after
  // a change, live refreshes) is the kept copy for the next visit.
  useEffect(() => {
    if (!dataState || dataState.page.id !== currentId.current) return;
    const cache = appCache();
    cache.set(pageKey(dataState.page.id), dataState, { version: dataState.page.updated_at, policy: cachePolicy(dataState) });
    // Records that are gone leave the cache too.
    if (dataState.page.kind === "database") {
      const rows = new Set(dataState.rows?.map((r) => r.id));
      cache.invalidate((key) => key.startsWith(`row:${dataState.page.id}:`) && !rows.has(key.split(":")[2]));
    }
  }, [dataState, cachePolicy]);
  // Pages that are gone (trash, permissions) leave the cache; the current
  // workspace's bootstrap is kept for switching back to it.
  useEffect(() => {
    const cache = appCache();
    const live = new Set(bootState.pages.filter((p) => !p.deleted_at).map((p) => p.id));
    cache.invalidate((key) => {
      const [kind, id] = key.split(":");
      return (kind === "page" || kind === "row") && !live.has(id);
    });
    cache.set(bootKey(bootState.workspace.id), bootState, { policy: "memory" });
  }, [bootState]);
  // Loading ahead on hover, touch and focus (components/prefetch.ts).
  useEffect(() => {
    configurePrefetch({
      policy: cachePolicy,
      page: (id) => {
        const page = bootRef.current.pages.find((p) => p.id === id && !p.deleted_at);
        return page ? { version: page.updated_at, kind: page.kind } : null;
      },
      // The code of the view loads ahead too (the chunks next/dynamic loads).
      preload: (kind) => {
        const load = kind === "whiteboard" ? () => import("./whiteboard/whiteboard") : kind === "dashboard" ? () => import("./dashboard-view") : kind === "document" ? () => import("./editor") : null;
        void load?.().catch(() => {});
      },
    });
    const stop = installPrefetch();
    return () => {
      stop();
      configurePrefetch(null);
    };
  }, [cachePolicy]);
  // Requests that do not go through api() (uploads, exports …) notice an
  // ended session too.
  useEffect(() => {
    const original = window.fetch;
    window.fetch = async (input, init) => {
      const response = await original(input, init);
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      endedSession(url, response.status);
      return response;
    };
    return () => {
      window.fetch = original;
    };
  }, []);
  // An invitation link: say what happened and drop it from the address.
  useEffect(() => {
    if (!inviteResult) return;
    notify(
      inviteResult === "accepted"
        ? t(`Einladung angenommen – willkommen in „${boot.workspace.name}“.`, `Invitation accepted – welcome to “${boot.workspace.name}”.`)
        : t("Dieser Einladungslink ist ungültig oder wurde schon verwendet.", "This invitation link is invalid or was already used."),
    );
    const url = new URL(location.href);
    url.searchParams.delete("invite");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // "Back" in the apps (swipe from the edge, Android's back): closes what is
  // open, then goes up and to the place before (lib/app-back.ts).
  useEffect(() => (nativeApp() ? installAppBack() : undefined), []);
  // The apps' hardware keyboard: the shortcuts as key commands, listed when
  // ⌘ is held on the iPad (lib/app-shortcuts.ts).
  useEffect(
    () =>
      installAppShortcuts(
        (action) => shortcutRef.current(action),
        (action) => (action === "shortcuts" ? t("Tastenkürzel", "Keyboard shortcuts") : actionLabel(action, t)),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  // The navigation drawer on phones closes on back like a dialog.
  useEffect(() => (mobile ? addBackCloser(() => setMobile(false)) : undefined), [mobile]);
  // It exists only in the phone layout (≤ 767 px, app/globals.css): when the
  // window gets wider while it is open (a foldable such as iPhone Duo opens,
  // the phone turns, a window grows) the sidebar takes over, and the drawer
  // closes – instead of staying open unseen, taking the next "back" and
  // coming back when the window narrows again.
  useEffect(() => {
    if (!mobile) return;
    const wide = matchMedia("(min-width: 768px)");
    const close = () => {
      if (wide.matches) setMobile(false);
    };
    close();
    wide.addEventListener("change", close);
    return () => wide.removeEventListener("change", close);
  }, [mobile]);
  // Settings → Konto opens the introduction and the shortcut overlay again.
  useEffect(() => {
    const open = () => setOnboarding(true);
    const keys = () => setShortcuts(true);
    window.addEventListener("flowplan:onboarding", open);
    window.addEventListener("flowplan:shortcuts", keys);
    return () => {
      window.removeEventListener("flowplan:onboarding", open);
      window.removeEventListener("flowplan:shortcuts", keys);
    };
  }, []);
  // Runs a command: its result shows at once where it is known in advance
  // (lib/optimistic-commands.ts) and stays until the reloaded state is
  // there; a refusal of the server takes it back and the error toast shows
  // the server's message. Destructive and bulk changes then offer
  // "Rückgängig" (lib/undo.ts), unless the command is itself an undo.
  const undoRef = useRef<(plan: UndoPlan) => Promise<void>>(async () => {});
  const mutate = useCallback(
    async (b: Record<string, unknown>) => {
      const rows = () =>
        applyQueue(
          dataRef.current?.rows || [],
          offlineQueue.queue,
          String(b.pageId),
        );
      if (isQueueable(b) && !navigator.onLine)
        return offlineQueue.enqueue(b, rows());
      // Taken before the first await: callers may leave the page right after.
      const before = { boot: bootRef.current, data: dataRef.current };
      const openBefore = screenRef.current === "page" ? currentId.current : null;
      const overlay = commandOverlay<PageData>(b, {
        userId: before.boot.user.id,
        userName: before.boot.user.name,
        data: before.data,
      });
      const layer: Layer | null = overlay ? { boot: overlay.boot, page: overlay.page } : null;
      if (layer) setLayers((list) => [...list, layer]);
      try {
        let result;
        try {
          result = await api("/api/command", b);
        } catch (e) {
          // A failed request without a response means the network is gone.
          if (isQueueable(b) && isTransient(e))
            return offlineQueue.enqueue(b, rows());
          throw e;
        }
        // lib/undo.ts loads with the first change (not with the app).
        const plan = undoing.has(b) || !UNDOABLE.has(String(b.action)) ? null : (await import("@/lib/undo")).undoFor(b, before, openBefore);
        if (plan) showUndo(plan.message, () => undoRef.current(plan));
        await refresh();
        return result;
      } finally {
        if (layer) setLayers((list) => list.filter((x) => x !== layer));
      }
    },
    [refresh, offlineQueue],
  );
  // Journals get a page for the new day: when the app opens, comes back to
  // the foreground and at local midnight.
  const hasJournal = boot.pages.some(
    (page) => page.kind === "journal" && !page.deleted_at,
  );
  const rollJournal = useCallback(
    async (pageId: string | null, date: string, recreate = false) => {
      const result = await api<{ changed?: boolean }>("/api/command", {
        action: "journal.roll",
        workspaceId: boot.workspace.id,
        ...(pageId ? { pageId } : {}),
        date,
        ...(recreate ? { recreate: true } : {}),
      });
      if (result?.changed) await refresh();
      return result;
    },
    [boot.workspace.id, refresh],
  );
  // The first change in a draft day creates it (journal.roll with write).
  // The same id and generation: the editor goes on as if nothing happened;
  // otherwise the day was created differently meanwhile (another device,
  // other carried tasks) and opens as it is stored.
  const draftCreations = useRef(new Map<string, Promise<boolean>>());
  const ensureDraftDay = useCallback(
    (draftData: PageData) => {
      const key = draftData.page.id;
      const known = draftCreations.current.get(key);
      if (known) return known;
      const promise = (async () => {
        const result = await api<{ dayId: string; generation?: string }>("/api/command", {
          action: "journal.roll",
          workspaceId: boot.workspace.id,
          pageId: draftData.draft!.journalId,
          date: draftData.draft!.date,
          write: true,
        });
        const same = result.dayId === draftData.page.id && result.generation === draftData.generation;
        if (!same) {
          notify(t("Die Seite für heute wurde inzwischen angelegt und wird geöffnet.", "Today's page was created meanwhile and opens now."));
          void openPageRef.current(result.dayId);
        } else void refresh();
        return same;
      })();
      draftCreations.current.set(key, promise);
      promise.catch(() => draftCreations.current.delete(key));
      return promise;
    },
    [boot.workspace.id, refresh, notify, t],
  );
  useEffect(() => {
    if (!hasJournal) return;
    let rolled = "";
    const check = () => {
      if (document.visibilityState === "hidden" || !navigator.onLine) return;
      const today = localDay();
      if (today === rolled) return;
      rolled = today;
      rollJournal(null, today).catch(() => {
        rolled = "";
      });
    };
    check();
    const timer = setInterval(check, 60_000);
    document.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("focus", check);
    };
  }, [hasJournal, rollJournal]);
  const act = useCallback(
    async (b: Record<string, unknown>, retry?: () => void) => {
      try {
        return await mutate(b);
      } catch (e) {
        notifyError(e, retry);
        return null;
      }
    },
    [mutate, notifyError],
  );
  // "Rückgängig" in the toast (or Mod+Z while it shows): the inverse
  // commands, built from the current state, one after the other.
  undoRef.current = async (plan: UndoPlan) => {
    try {
      for (const command of plan.commands({ boot: bootRef.current, data: dataRef.current })) {
        undoing.add(command);
        await mutate(command);
      }
      showToast({ text: tr("Rückgängig gemacht", "Undone") });
      if (plan.reopen) void openPageRef.current(plan.reopen);
    } catch (e) {
      notifyError(e);
    }
  };
  // "Zuletzt angesehen" on the start page follows along without a reload.
  const shownPage = data?.page.id;
  // A page just created from the dialog: the caret goes into its title.
  const focusTitleOf = useRef<string | null>(null);
  useEffect(() => {
    if (!shownPage || focusTitleOf.current !== shownPage) return;
    focusTitleOf.current = null;
    document.querySelector<HTMLInputElement>("input.page-title")?.focus();
  }, [shownPage]);
  useEffect(() => {
    if (!shownPage || screenRef.current !== "page") return;
    setBoot((b) => ({
      ...b,
      recentVisits: [
        { pageId: shownPage, seenAt: Date.now() },
        ...(b.recentVisits || []).filter((v) => v.pageId !== shownPage),
      ].slice(0, 8),
    }));
  }, [shownPage]);
  // What changed since the last visit: kept for the page while it stays open
  // (later loads of the same page count as a new visit).
  const [since, setSince] = useState<{
    pageId: string;
    value: SinceVisit | null;
  } | null>(null);
  useEffect(() => {
    if (!data) return;
    setSince((current) =>
      current?.pageId === data.page.id && !data.sinceVisit
        ? current
        : { pageId: data.page.id, value: data.sinceVisit || null },
    );
  }, [data]);
  // The page tree entry a page is opened from (its icon and title fly).
  const navigationSource = useRef<{ icon: Element | null; title: Element | null } | null>(null);
  // For "Retry" on a page that failed to open.
  const openPageRef = useRef<(id: string, target?: PageLocation) => Promise<void>>(async () => {});
  const openPage = useCallback(
    async (id: string, target?: PageLocation) => {
      const version = ++navigationVersion.current;
      navigationPending.current = true;
      screenRef.current = "page";
      currentId.current = id;
      // Stale-while-revalidate (lib/swr-cache.ts): a page opened recently
      // shows its kept copy at once while the fresh one loads; the editor's
      // sync and the reload below bring it up to date.
      const showKept = (kept: PageData | undefined) => {
        if (!kept || kept.page.workspace_id !== currentWorkspace.current) return false;
        if (version !== navigationVersion.current || currentId.current !== id) return false;
        setData(kept);
        html.current = kept.html || "";
        setStatus("Gespeichert");
        setBusy(false);
        setRevalidating(true);
        return true;
      };
      // The new page comes in with a view transition (lib/view-transition.ts);
      // opened from the page tree, its icon and title fly to their place.
      const source = navigationSource.current;
      navigationSource.current = null;
      const view = transitionView(
        () => {
          setMobile(false);
          setScreen("page");
          setPageId(id);
          setComments(false);
          setAiSummary(null);
          if (showKept(appCache().get<PageData>(pageKey(id))?.value)) return;
          setData(null);
          setBusy(true);
          // Loaded ahead a moment ago (hover, touch): shown as soon as it is there.
          void pendingPrefetch(pageKey(id))?.then(() => {
            if (busyRef.current) showKept(appCache().get<PageData>(pageKey(id))?.value);
          });
        },
        { kind: "page", morph: pageMorph(source) },
      );
      const hash = pageLocationHash(target || { pageId: id });
      if (location.hash !== hash) location.hash = hash;
      try {
        const p = await api<PageData>(`/api/pages/${id}`, undefined, {
          "X-Flowplan-Visit": "1",
        });
        view.flush();
        if (
          version !== navigationVersion.current ||
          screenRef.current !== "page"
        )
          return;
        if (p.page.workspace_id !== currentWorkspace.current) {
          const next = await api<Bootstrap>(
            `/api/bootstrap?workspace=${p.page.workspace_id}`,
          );
          if (
            version !== navigationVersion.current ||
            screenRef.current !== "page"
          )
            return;
          currentWorkspace.current = next.workspace.id;
          setBoot(next);
          setSpaceId(next.spaces[0]?.id || "");
        }
        // A draft day that exists by now answers with the day itself.
        if (currentId.current === id && p.page.id !== id) {
          void openPageRef.current(p.page.id, target);
          return;
        }
        if (currentId.current === id) {
          setData(p);
          html.current = p.html || "";
          setStatus("Gespeichert");
        }
      } catch (e) {
        view.flush();
        // Gone or no longer allowed: the kept copy goes too.
        if (e instanceof ApiError && [403, 404, 423].includes(e.status)) {
          appCache().delete(pageKey(id));
          if (version === navigationVersion.current && currentId.current === id) setData(null);
        }
        if (version === navigationVersion.current)
          notifyError(e, () => void openPageRef.current(id, target));
      } finally {
        if (version === navigationVersion.current) {
          navigationPending.current = false;
          setBusy(false);
          setRevalidating(false);
        }
      }
    },
    [notifyError],
  );
  openPageRef.current = openPage;
  // A second page next to the open one; on narrow screens it opens normally.
  const openSplit = useCallback(
    (id: string) => {
      if (!wideRef.current) return void openPage(id);
      if (screenRef.current === "page" && currentId.current === id) {
        notify(t("Diese Seite ist bereits geöffnet.", "This page is already open."));
        return;
      }
      setSplit(id);
    },
    [openPage, notify, t],
  );
  // Ctrl/⌘-click on a page link (components/link-preview.tsx).
  useEffect(() => {
    const open = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (!wideRef.current || typeof id !== "string") return;
      e.preventDefault();
      openSplit(id);
    };
    window.addEventListener("flowplan:open-split", open);
    return () => window.removeEventListener("flowplan:open-split", open);
  }, [openSplit]);
  function go(s: Screen) {
    screenRef.current = s;
    transitionView(
      () => {
        setScreen(s);
        setMobile(false);
      },
      { kind: "page" },
    );
    location.hash = s;
  }
  useEffect(() => {
    installTaskFeedback();
    const choice = themeChoice();
    setTheme(choice);
    setDark(applyTheme(choice));
    const stopTheme = watchTheme((isDark, choice) => {
      setDark(isDark);
      setTheme(choice);
    });
    const navigate = () => {
      const fragment = location.hash.slice(1);
      if (fragment.startsWith("page=")) {
        const target = parsePageLocation(location.hash);
        if (!target) {
          notifyError(t("Dieser Seitenlink ist ungültig.", "This page link is invalid."));
          return;
        }
        if (currentId.current !== target.pageId || screenRef.current !== "page")
          void openPage(target.pageId, target);
      } else if (
        ["home", "inbox", "tasks", "graph", "trash", "media", "settings", "admin"].includes(
          fragment,
        ) ||
        // A section of the settings or the administration: #settings/account
        // (components/settings/shell.tsx reads the rest).
        parseSettingsHash(fragment)
      ) {
        const base = fragment.split("/")[0] as Screen;
        if (screenRef.current !== base) {
          screenRef.current = base;
          transitionView(
            () => {
              setScreen(base);
              setMobile(false);
            },
            { kind: "page" },
          );
        } else setMobile(false);
        // The start page shows recently opened and edited pages: current.
        if (fragment === "home") void refresh().catch(() => {});
      } else if (fragment === "search" || fragment === "new" || fragment === "capture") {
        // Quick actions of the mobile app and the home screen icon (long press).
        if (fragment === "search") openSearch();
        else if (fragment === "capture") setCapture(true);
        else setCreate(true);
        const back =
          screenRef.current === "page" && currentId.current ? `page=${currentId.current}` : screenRef.current || "home";
        window.history.replaceState(null, "", `${location.pathname}#${back}`);
      } else if (fragment.startsWith("workspace=") || fragment.startsWith("search=")) {
        // From the mobile app (Focus filters, Siri "Search Flowplan"): the
        // workspace to switch to, or the search with its text.
        const params = new URLSearchParams(fragment);
        const workspace = params.get("workspace");
        const text = params.get("search");
        const back =
          screenRef.current === "page" && currentId.current ? `page=${currentId.current}` : screenRef.current || "home";
        window.history.replaceState(null, "", `${location.pathname}#${back}`);
        if (workspace && /^[0-9a-f-]{36}$/i.test(workspace) && workspace !== currentWorkspace.current)
          void switchWorkspace(workspace);
        if (text !== null) {
          openSearch();
          setQuery(text.slice(0, 200));
        }
      }
    };
    // What the app opens with comes without a transition.
    withoutViewTransition(navigate);
    window.addEventListener("hashchange", navigate);
    // The global shortcuts, as the keymap says (lib/keymap.ts; own
    // combinations in the shortcut overlay). Combinations without Ctrl, ⌘ or
    // Alt ("?") do not count while typing.
    const key = (e: KeyboardEvent) => {
      // The navigation drawer on small screens closes like a dialog.
      if (e.key === "Escape") setMobile(false);
      if (e.isComposing || presentingRef.current) return;
      const action = matchAction(e, isTyping(e.target));
      if (!action) return;
      // A whiteboard has its own search for ⌘F (it marks the event handled).
      if (action === "find" && e.defaultPrevented) return;
      e.preventDefault();
      // Once, also when the app reports the same key (lib/app-shortcuts.ts).
      if (firstRun(action)) shortcutRef.current(action);
    };
    // The app's stored copy of a server it cannot reach counts as offline.
    const network = () => setOnline(navigator.onLine && !appCopyUnreachable());
    network();
    // A 401 while working: the banner instead of a reload (components/ui.tsx).
    const signedOut = (e: Event) => {
      e.preventDefault();
      // Nothing of this person stays in the tab's cache.
      clearAppCache();
      clearPlaceholders();
      setSignedOut(true);
    };
    window.addEventListener("keydown", key);
    window.addEventListener("online", network);
    window.addEventListener("offline", network);
    window.addEventListener(SIGNED_OUT_EVENT, signedOut);
    return () => {
      stopTheme();
      window.removeEventListener("hashchange", navigate);
      window.removeEventListener("keydown", key);
      window.removeEventListener("online", network);
      window.removeEventListener("offline", network);
      window.removeEventListener(SIGNED_OUT_EVENT, signedOut);
    };
  }, [initial.pages, openPage, notify, openSearch]);
  const templateUsed = useRef(false);
  useEffect(() => {
    if (!useTemplate || templateUsed.current) return;
    templateUsed.current = true;
    window.history.replaceState(null, "", location.pathname + location.hash);
    void (async () => {
      try {
        const space = boot.spaces.find((s) =>
          ["owner", "editor"].includes((s as { role?: string }).role || "editor"),
        );
        // A template that comes with Flowplan (public gallery).
        if (useTemplate.startsWith("starter:")) {
          const key = useTemplate.slice(8);
          const builtIn = catalogFor(LOCALE_TAG === "de-DE" ? "de" : "en")[key];
          if (!builtIn) throw new Error(t("Diese Vorlage ist nicht mehr verfügbar.", "This template is no longer available."));
          const created = await mutate({
            action: "page.create",
            workspaceId: boot.workspace.id,
            spaceId: space?.id || boot.spaces[0]?.id,
            title: builtIn.name,
            kind: builtIn.kind,
            starterTemplate: key,
          });
          if (created?.id) void openPage(String(created.id));
          return;
        }
        const list = await api<{ id: string; name: string; kind: string }[]>(
          `/api/templates?workspace=${boot.workspace.id}`,
        );
        const template = list.find((t) => t.id === useTemplate);
        if (!template)
          throw new Error(t("Diese Vorlage ist nicht mehr verfügbar.", "This template is no longer available."));
        const created = await mutate({
          action: "page.create",
          workspaceId: boot.workspace.id,
          spaceId: space?.id || boot.spaces[0]?.id,
          title: template.name,
          kind: template.kind,
          templateId: template.id,
        });
        if (created?.id) void openPage(String(created.id));
      } catch (e) {
        notifyError(e);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useTemplate]);
  // The offline copy follows the workspace while the app is open.
  const offlineNotice = useOfflineRefresh(boot.user.id, online, !signedOut);
  // The service worker serves offline copies once enabled in the settings.
  useEffect(() => {
    void registerServiceWorker()
      .then(() => checkOfflineOwner(boot.user.id))
      .catch(() => undefined);
  }, [boot.user.id]);
  useEffect(() => {
    let polling = false;
    const timer = setInterval(() => {
      if (!navigator.onLine || polling) return;
      polling = true;
      void refresh()
        .catch(() => {})
        .finally(() => {
          polling = false;
        });
    }, 10000);
    return () => clearInterval(timer);
  }, [refresh]);
  // May edit the open page – and does, unless it is open for reading.
  const mayEdit = !!data && ["editor", "owner"].includes(data.role) && !data.page.locked,
    canRead = mayEdit && data?.page.kind === "document",
    reading = canRead && readPages.includes(data!.page.id);
  useEffect(() => setReadPages(readModeIds()), []);
  const toggleReading = () => {
    if (!data || !canRead) return;
    setReadPages(toggleReadMode(data.page.id));
  };
  toggleReadingRef.current = toggleReading;
  // The open document as slides (components/presentation.tsx).
  const startPresentation = () => {
    const d = dataRef.current;
    if (!d || screenRef.current !== "page" || d.page.kind !== "document" || d.locked) {
      notify(t("Präsentieren geht mit einem geöffneten Dokument.", "Presenting works with an open document."));
      return;
    }
    setSearch(false);
    setShortcuts(false);
    setPresenting({ html: readHtml(), title: d.page.title || t("Ohne Titel", "Untitled") });
  };
  const splitShown = !!split && wide;
  // The quick search in split mode: the chosen page opens next to this one.
  const openSplitSearch = () => {
    if (!wideRef.current) {
      notify(t("Die geteilte Ansicht braucht ein Fenster breiter als 1024 Pixel.", "Split view needs a window wider than 1024 pixels."));
      return;
    }
    setPaletteSplit(true);
    openSearch();
  };
  const runShortcut = (action: ShortcutAction) => {
    switch (action) {
      case "search":
        if (searchOpen.current) setSearch(false);
        else {
          setPaletteSplit(false);
          openSearch();
        }
        break;
      case "find":
        setFind((f) => ({ open: true, key: f.key + 1 }));
        break;
      case "newPage":
        setCreate(true);
        break;
      case "capture":
        setCapture(true);
        break;
      case "shortcuts":
        setShortcuts(true);
        break;
      case "readMode":
        toggleReadingRef.current();
        break;
      case "sidebar":
        setDesktopCollapsed((v) => !v);
        break;
      case "focusMode":
        if (screenRef.current === "page" && dataRef.current) setFocusMode((v) => !v);
        break;
      case "comments":
        if (screenRef.current === "page" && dataRef.current) setComments((v) => !v);
        break;
      case "theme":
        toggleTheme();
        break;
      case "splitView":
        if (splitShown) setSplit(null);
        else openSplitSearch();
        break;
      case "present":
        startPresentation();
        break;
      case "journalToday":
        openLastJournalToday();
        break;
    }
  };
  shortcutRef.current = runShortcut;
  // Hints in titles follow the own shortcuts ("Lesemodus (⌘ ⌥ E)").
  const hint = (action: ShortcutAction) => {
    const keys = keyHints.visible ? shortcutHint(action, mac) : "";
    return keys ? ` (${keys})` : "";
  };
  // The open page shows in the split view too: the split closes.
  useEffect(() => {
    if (split && screen === "page" && pageId === split) setSplit(null);
  }, [split, screen, pageId]);
  // The journal used last ("Journal: Heute", its shortcut).
  const usedJournal = data?.page.kind === "journal" ? data.page.id : data?.journalDay?.journalId || null;
  useEffect(() => {
    if (!usedJournal) return;
    try {
      localStorage.setItem(LAST_JOURNAL, usedJournal);
    } catch {}
  }, [usedJournal]);
  // Phones: the bottom bar steps aside while the keyboard is open.
  const keyboardOpen = useSoftKeyboard();
  // Phones: swipe from the left edge to pull the sidebar in, and back out.
  useDrawerSwipe(mobile, setMobile);
  // Only the panes scroll, never the document (no rubber band under the bars).
  useShellDocument();
  // Encrypted titles are decrypted here, in the browser, once unlocked.
  const titledPages = useDecryptedTitles(boot.pages, boot.spaces);
  const e2eeState = useE2ee();
  const activePages = useMemo(() => titledPages.filter((p) => !p.deleted_at), [titledPages]),
    // The tree's levels in one pass: sub pages per parent, top-level pages
    // per space ("space:<id>") – no search through all pages per row.
    treeIndex = useMemo(() => {
      const ids = new Set(activePages.map((p) => p.id));
      const index = new Map<string, Page[]>();
      for (const p of activePages) {
        const key = p.parent_id && ids.has(p.parent_id) ? p.parent_id : `space:${p.space_id}`;
        const list = index.get(key);
        if (list) list.push(p);
        else index.set(key, [p]);
      }
      return index;
    }, [activePages]),
    editable = mayEdit && !reading,
    sourceOpen = !!data && data.page.kind === "document" && !data.locked && sourcePage === data.page.id,
    canCreate = boot.workspace.role !== "viewer" && !boot.workspace.guest,
    favorites = activePages.filter((p) => boot.favorites.includes(p.id));
  // The order of the spaces (issue #48, lib/space-order.ts): workspace
  // owners drag a space by its header or use "Nach oben"/"Nach unten" in its
  // "…" menu. Only the spaces shown here are sent; the others keep their place.
  const canReorderSpaces = boot.workspace.role === "owner" && !boot.workspace.guest && boot.spaces.length > 1,
    [spaceDrop, setSpaceDrop] = useState<{ id: string; placement: "before" | "after" } | null>(null),
    [spaceMoveNote, setSpaceMoveNote] = useState("");
  async function reorderSpaces(order: string[] | null, moved: string) {
    if (!order) return;
    const space = boot.spaces.find((s) => s.id === moved);
    const result = await act({ action: "space.reorder", workspaceId: boot.workspace.id, order });
    if (!result || !space) return;
    // Screen readers hear where the space went (the menu closes on select).
    const at = order.indexOf(moved) + 1;
    setSpaceMoveNote(
      t(`„${space.name}“ steht jetzt an Position ${at} von ${order.length}.`, `“${space.name}” is now at position ${at} of ${order.length}.`),
    );
  }
  // Folded spaces, remembered per device (lib/space-moves.ts); read after
  // the first render, so the server's HTML and the first client render match.
  const [collapsedSpaces, setCollapsedSpaces] = useState<Set<string>>(new Set());
  useEffect(() => setCollapsedSpaces(readCollapsedSpaces()), []);
  const foldSpace = (id: string, fold: boolean) =>
    setCollapsedSpaces((current) => {
      if (current.has(id) === fold) return current;
      const next = new Set(current);
      if (fold) next.add(id);
      else next.delete(id);
      writeCollapsedSpaces(next);
      return next;
    });
  // Opening a page unfolds its space.
  const openSpaceId = screen === "page" && pageId ? boot.pages.find((p) => p.id === pageId)?.space_id : undefined;
  useEffect(() => {
    if (openSpaceId) foldSpace(openSpaceId, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSpaceId]);
  function addPage(
    kind: PageKind = "document",
    parentId: string | null = null,
    sid?: string,
  ) {
    if (!boot.spaces.length) {
      setNewSpace(true);
      return;
    }
    setNewKind(kind);
    setDatabaseChoice(rememberedDatabaseKind());
    setStarterTemplate(null);
    setParent(parentId);
    setSpaceId(
      sid ||
        boot.spaces.find((s) => s.visibility === "team")?.id ||
        boot.spaces[0]?.id ||
        "",
    );
    setNewTitle("");
    setCreate(true);
  }
  // The shell stays inert until the other workspace has loaded, so settings,
  // exports and new pages cannot act on the one being left.
  const [switching, setSwitching] = useState(false);
  const latestSwitch = useRef(0);
  async function switchWorkspace(id: string) {
    const version = ++navigationVersion.current;
    latestSwitch.current = version;
    navigationPending.current = true;
    setSwitching(true);
    // Been there in this tab: its sidebar and start page show at once (the
    // shell stays inert until the fresh state is there).
    const previous = bootRef.current;
    const kept = appCache().get<Bootstrap>(bootKey(id))?.value;
    if (kept && kept.user.id === previous.user.id) {
      setBoot(kept);
      setPageId(null);
      currentId.current = null;
      setData(null);
      go("home");
    }
    try {
      const b = await api<Bootstrap>(`/api/bootstrap?workspace=${id}`);
      if (version !== navigationVersion.current) return;
      currentWorkspace.current = b.workspace.id;
      setBoot(b);
      setPageId(null);
      currentId.current = null;
      setData(null);
      go("home");
      setSpaceId(b.spaces[0]?.id || "");
    } catch (e) {
      if (kept && version === navigationVersion.current) setBoot(previous);
      if (version === navigationVersion.current) notifyError(e, () => void switchWorkspace(id));
    } finally {
      if (version === navigationVersion.current)
        navigationPending.current = false;
      if (version === latestSwitch.current) setSwitching(false);
    }
  }
  // Pages in sidebar order, e.g. for range selection and move targets.
  function flatPages(
    parentId: string | null,
    sid: string,
    level = 0,
  ): { page: Page; level: number }[] {
    if (level > 20) return [];
    return (treeIndex.get(parentId ?? `space:${sid}`) || [])
      .filter((p) => p.space_id === sid)
      .flatMap((p) => [{ page: p, level }, ...flatPages(p.id, sid, level + 1)]);
  }
  function ancestorsOf(pid: string) {
    const result: string[] = [];
    let current = activePages.find((p) => p.id === pid);
    while (current?.parent_id && result.length < 50) {
      result.push(current.parent_id);
      current = activePages.find((p) => p.id === current!.parent_id);
    }
    return result;
  }
  function toggleSelected(pid: string, range: boolean) {
    setSelectedPages((previous) => {
      if (range && lastSelected.current) {
        const order = boot.spaces.flatMap((sp) =>
          flatPages(null, sp.id).map((x) => x.page.id),
        );
        const a = order.indexOf(lastSelected.current),
          b = order.indexOf(pid);
        if (a >= 0 && b >= 0)
          return [
            ...new Set([
              ...previous,
              ...order.slice(Math.min(a, b), Math.max(a, b) + 1),
            ]),
          ];
      }
      lastSelected.current = pid;
      return previous.includes(pid)
        ? previous.filter((x) => x !== pid)
        : [...previous, pid];
    });
  }
  function clearSelection() {
    setSelectedPages([]);
    setSelecting(false);
    lastSelected.current = null;
  }
  async function bulkPages(
    operation: "delete" | "duplicate" | "move",
    destination?: string,
  ) {
    setBulkBusy(true);
    const since = toastSerial();
    try {
      const result = await act({
        action: "pages.bulk",
        workspaceId: boot.workspace.id,
        operation,
        pageIds: selectedPages,
        ...(destination?.startsWith("page:")
          ? { parentId: destination.slice(5) }
          : destination?.startsWith("space:")
            ? { spaceId: destination.slice(6) }
            : {}),
      });
      if (result) {
        setBulkDialog(null);
        clearSelection();
        // Deleting and moving offer "Rückgängig" instead (lib/undo.ts).
        if (!undoShownSince(since))
          notify(
          operation === "delete"
            ? t("Seiten in den Papierkorb verschoben.", "Pages moved to the trash.")
            : operation === "duplicate"
              ? t("Seiten dupliziert.", "Pages duplicated.")
              : t("Seiten verschoben.", "Pages moved."),
        );
      }
    } finally {
      setBulkBusy(false);
    }
  }
  // Touch devices drag pages with a handle; the drop target is found under the finger.
  function touchTarget(x: number, y: number) {
    const row = document
      .elementFromPoint(x, y)
      ?.closest<HTMLElement>(".page-nav[data-page-id]");
    if (!row) return null;
    const rect = row.getBoundingClientRect(),
      ratio = (y - rect.top) / rect.height;
    return {
      id: row.dataset.pageId!,
      placement: (ratio < 0.25
        ? "before"
        : ratio > 0.75
          ? "after"
          : "inside") as "before" | "after" | "inside",
    };
  }
  function touchHover(x: number, y: number) {
    const drag = touchDrag.current;
    if (!drag) return;
    const target = touchTarget(x, y);
    setTreeDrop(target && target.id !== drag.source ? target : null);
  }
  touchHoverRef.current = touchHover;
  // Touch: holding a page for half a second opens its menu (phones have no
  // right click); moving the finger scrolls instead.
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number; opened: boolean } | null>(null);
  const pressMenu = (p: Page) => ({
    onPointerDown: (e: React.PointerEvent) => {
      if (e.pointerType !== "touch" || (e.target as HTMLElement).closest(".nav-drag, .nav-add, .tree-toggle")) return;
      const { clientX: x, clientY: y } = e;
      clearTimeout(press.current?.timer);
      press.current = {
        x,
        y,
        opened: false,
        timer: setTimeout(() => {
          if (!press.current) return;
          press.current.opened = true;
          navigator.vibrate?.(10);
          setPageMenu({ page: p, x, y });
        }, 480),
      };
    },
    onPointerMove: (e: React.PointerEvent) => {
      const state = press.current;
      if (state && !state.opened && Math.hypot(e.clientX - state.x, e.clientY - state.y) > 8) {
        clearTimeout(state.timer);
        press.current = null;
      }
    },
    onPointerUp: () => {
      if (press.current && !press.current.opened) {
        clearTimeout(press.current.timer);
        press.current = null;
      }
    },
    onPointerCancel: () => {
      clearTimeout(press.current?.timer);
      press.current = null;
    },
    // The tap that ends a long press must not also open the page.
    onClickCapture: (e: React.MouseEvent) => {
      if (press.current?.opened) {
        e.preventDefault();
        e.stopPropagation();
        press.current = null;
      }
    },
  });
  // Pages whose title matches the filter, plus all their parent pages.
  const filterMatches = (() => {
    const query = treeFilter.trim().toLocaleLowerCase("de");
    if (!query) return null;
    const byId = new Map(activePages.map((p) => [p.id, p]));
    const shown = new Set<string>();
    for (const p of activePages)
      if ((p.title || t("Ohne Titel", "Untitled")).toLocaleLowerCase("de").includes(query))
        for (
          let at: Page | undefined = p;
          at && !shown.has(at.id);
          at = at.parent_id ? byId.get(at.parent_id) : undefined
        )
          shown.add(at.id);
    return shown;
  })();
  // After a page is dropped elsewhere in the tree, the other pages move up
  // or down to make room smoothly instead of jumping (FLIP from the
  // positions measured at the drop).
  const treeRoot = useRef<HTMLDivElement>(null),
    treeMove = useRef<{ at: Map<string, Point>; order: string[]; time: number } | null>(null);
  const treeItems = () =>
    [...(treeRoot.current?.querySelectorAll<HTMLElement>(".page-nav[data-page-id]") || [])];
  function markTreeMove() {
    const root = treeRoot.current;
    if (!root) return;
    const items = treeItems();
    treeMove.current = {
      at: flipList(root, items, (el) => (el as HTMLElement).dataset.pageId, null),
      order: items.map((el) => el.dataset.pageId!),
      time: Date.now(),
    };
  }
  useLayoutEffect(() => {
    const move = treeMove.current,
      root = treeRoot.current;
    if (!move || !root) return;
    if (Date.now() - move.time > 4000) {
      treeMove.current = null;
      return;
    }
    const items = treeItems(),
      order = items.map((el) => el.dataset.pageId!);
    if (sameRelativeOrder(move.order, order) && order.length === move.order.length) return;
    treeMove.current = null;
    flipList(root, items, (el) => (el as HTMLElement).dataset.pageId, move.at, { duration: 220 });
  });
  // The pages of a level of the tree, in order.
  const treeLevel = (parentId: string | null, sid: string) =>
    (treeIndex.get(parentId ?? `space:${sid}`) || []).filter(
      (p) => p.space_id === sid && (!filterMatches || filterMatches.has(p.id)),
    );
  // Below a journal the days do not all show (#49): today, the last days and
  // folders per year and month, as the journal's setting says
  // (lib/journal-nav.ts). Computed once per journal and render; hidden days
  // are never rendered. While filtering, matching days show as they are.
  const journalTrees = new Map<string, { entries: SidebarEntry<Page>[]; others: Page[]; shown: Set<string> }>();
  const journalTree = (journal: Page) => {
    let found = journalTrees.get(journal.id);
    if (!found) {
      const kids = treeIndex.get(journal.id) || [];
      const entries = journalSidebar(
        kids.filter((x) => x.journal_date),
        {
          journalId: journal.id,
          mode: boot.journalSidebar?.[journal.id] || DEFAULT_SIDEBAR_MODE,
          today: localDay(),
          openId: screen === "page" ? pageId : null,
          expanded: journalFolders.open,
          collapsed: journalFolders.closed,
        },
      );
      found = { entries, others: kids.filter((x) => !x.journal_date), shown: shownTreeIds(entries, journal.id) };
      journalTrees.set(journal.id, found);
    }
    return found;
  };
  const toggleJournalFolder = (key: string, open: boolean) =>
    setJournalFolders((f) => {
      const next = { open: new Set(f.open), closed: new Set(f.closed) };
      if (open) {
        next.open.add(key);
        next.closed.delete(key);
      } else {
        next.open.delete(key);
        next.closed.add(key);
      }
      return next;
    });
  // Each space's tree has one Tab stop: the item focused last, else the open
  // page, else the first page – as long as it is shown (parents unfolded).
  function treeStop(sid: string): string | null {
    const byId = new Map(activePages.map((p) => [p.id, p]));
    const shownPage = (page: Page | undefined): boolean => {
      if (!page || page.space_id !== sid || (filterMatches && !filterMatches.has(page.id))) return false;
      for (let child = page, parent = page.parent_id ? byId.get(page.parent_id) : undefined; parent; child = parent, parent = parent.parent_id ? byId.get(parent.parent_id) : undefined) {
        if (!filterMatches && collapsed.has(parent.id)) return false;
        // A day of a journal: only while the journal shows it.
        if (!filterMatches && parent.kind === "journal" && child.journal_date && !journalTree(parent).shown.has(child.id)) return false;
      }
      return true;
    };
    const shown = (id: string | null) => {
      if (id && isFolderKey(id)) {
        // A virtual item of a journal (today, a folder, "Alle Tage").
        const journal = byId.get(id.split(":")[1]);
        return !filterMatches && !!journal && shownPage(journal) && !collapsed.has(journal.id) && journalTree(journal).shown.has(id);
      }
      return shownPage(id ? byId.get(id) : undefined);
    };
    if (shown(treeFocus)) return treeFocus;
    if (screen === "page" && shown(pageId)) return pageId;
    return treeLevel(null, sid)[0]?.id ?? null;
  }
  // Arrow keys in the tree (WAI-ARIA tree pattern): up and down move, right
  // unfolds or enters, left folds or goes to the parent, Enter opens.
  function treeKey(e: React.KeyboardEvent<HTMLDivElement>, p: Page, children: boolean, closed: boolean, parentTree = p.parent_id) {
    treeNavKey(e, {
      children,
      closed,
      parentTree,
      fold: (fold) =>
        setCollapsed((s) => {
          const n = new Set(s);
          fold ? n.add(p.id) : n.delete(p.id);
          return n;
        }),
      activate: () => void openPage(p.id),
    });
  }
  function treeNavKey(
    e: React.KeyboardEvent<HTMLDivElement>,
    item: { children: boolean; closed: boolean; parentTree?: string | null; fold: (fold: boolean) => void; activate: () => void },
  ) {
    const row = e.currentTarget,
      items = [...(row.closest('[role="tree"]')?.querySelectorAll<HTMLElement>('[role="treeitem"]') || [])],
      at = items.indexOf(row);
    const focusItem = (el?: HTMLElement) => el?.focus();
    switch (e.key) {
      case "ArrowDown":
        focusItem(items[at + 1]);
        break;
      case "ArrowUp":
        focusItem(items[at - 1]);
        break;
      case "Home":
        focusItem(items[0]);
        break;
      case "End":
        focusItem(items[items.length - 1]);
        break;
      case "ArrowRight":
        if (!item.children) return;
        if (item.closed) item.fold(false);
        else focusItem(items[at + 1]);
        break;
      case "ArrowLeft":
        if (item.children && !item.closed) item.fold(true);
        else focusItem(items.find((el) => el.dataset.treeId === item.parentTree));
        break;
      case "Enter":
        // A button inside the row (title, chevron, +) handles its own Enter.
        if (e.target !== row) return;
        item.activate();
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  }
  function tree(
    parentId: string | null,
    sid: string,
    level = 0,
    stop: string | null = null,
  ): React.ReactNode {
    if (level > 20) return null;
    return treeLevel(parentId, sid).map((p) => treeRow(p, sid, level, stop));
  }
  // The entries below a journal: its days as page rows (dragging, menus and
  // keys as everywhere) and virtual items – "Heute" while today has no page,
  // folders per year and month, "Alle Tage …" – then its other sub pages.
  function journalBranch(journal: Page, sid: string, level: number, stop: string | null): React.ReactNode {
    if (level > 20) return null;
    const { entries, others } = journalTree(journal);
    const dayRow = (day: Page, at: number, parentTree: string, today = false) => treeRow(day, sid, at, stop, { parentTree, today });
    return (
      <>
        {entries.map((entry) => {
          if (entry.kind === "today")
            return entry.day ? (
              dayRow(entry.day, level, journal.id, true)
            ) : (
              <JournalTreeItem
                key={todayKey(journal.id)}
                id={todayKey(journal.id)}
                parentTree={journal.id}
                level={level}
                stop={stop}
                icon={<CalendarCheck size={17} />}
                label={t("Heute", "Today")}
                onFocus={setTreeFocus}
                onKey={treeNavKey}
                onActivate={() => void openJournalToday(journal.id)}
              />
            );
          if (entry.kind === "day") return dayRow(entry.day, level, journal.id);
          if (entry.kind === "all")
            return (
              <JournalTreeItem
                key={allDaysKey(journal.id)}
                id={allDaysKey(journal.id)}
                parentTree={journal.id}
                level={level}
                stop={stop}
                icon={<CalendarDots size={17} />}
                label={t("Alle Tage …", "All days …")}
                count={entry.count}
                muted
                onFocus={setTreeFocus}
                onKey={treeNavKey}
                onActivate={() => {
                  setRevealJournalDays(journal.id);
                  void openPage(journal.id);
                }}
              />
            );
          return (
            <JournalTreeItem
              key={entry.key}
              id={entry.key}
              parentTree={journal.id}
              level={level}
              stop={stop}
              icon={<FolderSimple size={17} />}
              label={entry.year}
              count={entry.count}
              open={entry.open}
              onToggle={(open) => toggleJournalFolder(entry.key, open)}
              onFocus={setTreeFocus}
              onKey={treeNavKey}
            >
              {entry.months.map((month) => (
                <JournalTreeItem
                  key={month.key}
                  id={month.key}
                  parentTree={entry.key}
                  level={level + 1}
                  stop={stop}
                  icon={<CalendarBlank size={17} />}
                  label={monthLabel.format(new Date(`${month.month}-01T00:00:00Z`))}
                  count={month.count}
                  open={month.open}
                  onToggle={(open) => toggleJournalFolder(month.key, open)}
                  onFocus={setTreeFocus}
                  onKey={treeNavKey}
                >
                  {month.days.map((day) => dayRow(day, level + 2, month.key))}
                </JournalTreeItem>
              ))}
            </JournalTreeItem>
          );
        })}
        {others.filter((x) => x.space_id === sid).map((p) => treeRow(p, sid, level, stop))}
      </>
    );
  }
  function treeRow(
    p: Page,
    sid: string,
    level: number,
    stop: string | null,
    place: { parentTree?: string; today?: boolean } = {},
  ): React.ReactNode {
        const journal = p.kind === "journal" && !filterMatches ? journalTree(p) : null;
        const children = journal
            ? journal.entries.length > 0 || journal.others.some((x) => x.space_id === sid)
            : (treeIndex.get(p.id) || []).some((x) => !filterMatches || filterMatches.has(x.id)),
          // While filtering, the way to every match stays open.
          closed = !filterMatches && collapsed.has(p.id);
        return (
          <div key={p.id}>
            <div
              className={`page-nav ${screen === "page" && pageId === p.id ? "selected" : ""} ${selectedPages.includes(p.id) ? "multi-selected" : ""} ${treeDrop?.id === p.id ? `drop-${treeDrop.placement}` : ""}`}
              data-page-id={p.id}
              data-tree-id={p.id}
              data-prefetch-page={p.id}
              role="treeitem"
              aria-level={level + 1}
              aria-selected={screen === "page" && pageId === p.id}
              aria-expanded={children ? !closed : undefined}
              aria-owns={children && !closed ? `tree-group-${p.id}` : undefined}
              tabIndex={stop === p.id ? 0 : -1}
              onFocus={() => setTreeFocus(p.id)}
              onKeyDown={(e) => treeKey(e, p, children, closed, place.parentTree)}
              onContextMenu={(e) => {
                e.preventDefault();
                setPageMenu({ page: p, x: e.clientX, y: e.clientY });
              }}
              {...pressMenu(p)}
              draggable={canCreate}
              onDragStart={(e) => {
                if ((e.target as HTMLElement).closest(".nav-drag")) {
                  e.preventDefault();
                  return;
                }
                e.dataTransfer.setData("application/x-flowplan-page", p.id);
                // Dropped into a document: a link to the page.
                const href = `/${pageLocationHash({ pageId: p.id })}`;
                const title = (p.title || t("Ohne Titel", "Untitled")).replace(/&/g, "&amp;").replace(/</g, "&lt;");
                e.dataTransfer.setData("text/html", `<a href="${href}">${title}</a>`);
                e.dataTransfer.setData("text/uri-list", `${location.origin}${href}`);
                e.dataTransfer.effectAllowed = "copyMove";
                // After the drag has begun: changing the page during
                // dragstart can cancel it – and not when a short drag has
                // already ended by then.
                pageDragEnded.current = false;
                setTimeout(() => {
                  if (!pageDragEnded.current) setPageDrag(true);
                });
              }}
              onDragEnd={() => {
                pageDragEnded.current = true;
                setTreeDrop(null);
                setPageDrag(false);
              }}
              onDragOver={(e) => {
                // A record dragged from a database onto another database.
                if (p.kind === "database" && e.dataTransfer.types.includes("application/x-flowplan-row-order")) {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = e.altKey ? "copy" : "move";
                  setTreeDrop({ id: p.id, placement: "records" });
                  return;
                }
                if (
                  !canCreate ||
                  !e.dataTransfer.types.includes("application/x-flowplan-page")
                )
                  return;
                e.preventDefault();
                const rect = e.currentTarget.getBoundingClientRect(),
                  ratio = (e.clientY - rect.top) / rect.height;
                setTreeDrop({
                  id: p.id,
                  placement:
                    ratio < 0.25 ? "before" : ratio > 0.75 ? "after" : "inside",
                });
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node))
                  setTreeDrop(null);
              }}
              onDrop={(e) => {
                // A space dropped onto one of its pages: its section handles it.
                if (e.dataTransfer.types.includes("application/x-flowplan-space")) return;
                e.preventDefault();
                e.stopPropagation();
                const record = e.dataTransfer.getData("application/x-flowplan-row-order");
                if (record && p.kind === "database") {
                  setTreeDrop(null);
                  let from: { pageId?: string; rowId?: string } = {};
                  try {
                    from = JSON.parse(record);
                  } catch {}
                  if (!from.pageId || !from.rowId || from.pageId === p.id) return;
                  // Moves; with Alt (⌥) held it copies.
                  const mode = e.altKey ? "copy" : "move";
                  void act({ action: "rows.transfer", pageId: from.pageId, rowIds: [from.rowId], targetPageId: p.id, mode }).then((result) => {
                    if (result)
                      notify(mode === "move" ? t(`Eintrag nach „${p.title}“ verschoben.`, `Record moved to “${p.title}”.`) : t(`Eintrag nach „${p.title}“ kopiert.`, `Record copied to “${p.title}”.`));
                  });
                  return;
                }
                const source = e.dataTransfer.getData(
                  "application/x-flowplan-page",
                );
                if (source && source !== p.id) {
                  markTreeMove();
                  void act({
                    action: "page.move",
                    pageId: source,
                    targetId: p.id,
                    placement: treeDrop?.placement || "inside",
                  });
                }
                setTreeDrop(null);
              }}
              style={{ paddingLeft: 12 + level * 14 }}
            >
              {children ? (
                <button
                  className="tree-toggle"
                  tabIndex={-1}
                  aria-label={
                    closed ? t("Unterseiten öffnen", "Expand sub-pages") : t("Unterseiten schließen", "Collapse sub-pages")
                  }
                  onClick={() =>
                    setCollapsed((s) => {
                      const n = new Set(s);
                      n.has(p.id) ? n.delete(p.id) : n.add(p.id);
                      return n;
                    })
                  }
                >
                  <CaretRight
                    size={12}
                    className="nav-caret"
                    style={{ transform: closed ? undefined : "rotate(90deg)" }}
                  />
                </button>
              ) : (
                // Keeps the indent of pages without sub-pages.
                <span className="tree-toggle" aria-hidden="true" />
              )}
              {selecting && (
                <input
                  type="checkbox"
                  className="page-select"
                  aria-label={t(`${p.title} auswählen`, `Select ${p.title}`)}
                  checked={selectedPages.includes(p.id)}
                  onChange={() => toggleSelected(p.id, false)}
                />
              )}
              <button
                className="page-nav-title"
                tabIndex={-1}
                aria-pressed={
                  selecting || selectedPages.length
                    ? selectedPages.includes(p.id)
                    : undefined
                }
                onClick={(e) => {
                  // Ctrl/⌘-click opens the page in the split view – unless
                  // pages are being selected (Shift-click starts a selection).
                  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && wide && !selecting && !selectedPages.length) {
                    e.preventDefault();
                    openSplit(p.id);
                    return;
                  }
                  if (selecting || e.metaKey || e.ctrlKey || e.shiftKey) {
                    e.preventDefault();
                    toggleSelected(p.id, e.shiftKey);
                    return;
                  }
                  const entry = e.currentTarget;
                  navigationSource.current = { icon: entry.firstElementChild, title: entry.querySelector(".page-nav-label") };
                  void openPage(p.id);
                }}
              >
                <PageIcon
                  name={p.kind === "database" ? "table" : p.icon}
                  size={17}
                />
                <span className="page-nav-label">{p.title}</span>
                {place.today && <span className="nav-badge">{t("Heute", "Today")}</span>}
                {p.locked === 1 && <Lock size={12} />}
              </button>
              {canCreate && (
                <button
                  className="nav-drag"
                  tabIndex={-1}
                  aria-label={t(`${p.title} ziehen`, `Drag ${p.title}`)}
                  onPointerDown={(e) => {
                    // No native drag of the row: the handle drives the gesture.
                    e.preventDefault();
                    e.currentTarget.setPointerCapture(e.pointerId);
                    touchDrag.current = { source: p.id, pointer: e.pointerId };
                    treeScroll.start(e.currentTarget);
                  }}
                  onPointerMove={(e) => {
                    if (touchDrag.current?.pointer !== e.pointerId) return;
                    touchHover(e.clientX, e.clientY);
                    treeScroll.move(e.clientX, e.clientY);
                  }}
                  onPointerUp={(e) => {
                    const drag = touchDrag.current;
                    touchDrag.current = null;
                    treeScroll.stop();
                    if (drag?.pointer !== e.pointerId) return;
                    const target = touchTarget(e.clientX, e.clientY);
                    setTreeDrop(null);
                    if (target && target.id !== drag.source) markTreeMove();
                    if (target && target.id !== drag.source)
                      void act({
                        action: "page.move",
                        pageId: drag.source,
                        targetId: target.id,
                        placement: target.placement,
                      });
                  }}
                  onPointerCancel={() => {
                    touchDrag.current = null;
                    treeScroll.stop();
                    setTreeDrop(null);
                  }}
                >
                  <DotsSixVertical size={14} />
                </button>
              )}
              {canCreate && (
                <button
                  className="nav-add"
                  tabIndex={-1}
                  title={t("Unterseite hinzufügen", "Add sub-page")}
                  aria-label={t(`Unterseite in ${p.title} hinzufügen`, `Add sub-page in ${p.title}`)}
                  onClick={() => addPage("document", p.id, p.space_id)}
                >
                  <Plus size={14} />
                </button>
              )}
            </div>
            {/* Sub-pages unfold and fold instead of popping in and out. */}
            <Collapse open={children && !closed} className="nav-children">
              {children && !closed ? (
                <div role="group" id={`tree-group-${p.id}`}>
                  {journal ? journalBranch(p, sid, level + 1, stop) : tree(p.id, sid, level + 1, stop)}
                </div>
              ) : null}
            </Collapse>
          </div>
        );
  }
  // Journals by the last one used (opened or one of its days), for "Journal:
  // Heute" in the command palette and its shortcut.
  const journalsByUse = () => {
    let last: string | null = null;
    try {
      last = localStorage.getItem(LAST_JOURNAL);
    } catch {}
    const journals = activePages.filter((p) => p.kind === "journal");
    return [...journals.filter((p) => p.id === last), ...journals.filter((p) => p.id !== last)];
  };
  // Today's day of a journal, through the journal's own way of making the
  // day (journal.roll, as the journal page does): opens the day when there is
  // one, else the journal itself (no page yet, read-only, today in the trash).
  async function openJournalToday(journalId: string) {
    const today = localDay();
    const day = activePages.find((p) => p.parent_id === journalId && p.journal_date === today);
    if (day) return openPage(day.id);
    const journal = activePages.find((p) => p.id === journalId);
    if (journal && canCreate && !journal.locked) {
      try {
        const result = (await rollJournal(journalId, today)) as { dayId?: string; trashed?: boolean } | null;
        if (result?.dayId && !result.trashed) return openPage(result.dayId);
      } catch {}
    }
    return openPage(journalId);
  }
  function openLastJournalToday() {
    const journal = journalsByUse()[0];
    if (journal) void openJournalToday(journal.id);
    else notify(t("Es gibt noch kein Journal.", "There is no journal yet."));
  }
  // The command switches to the other look and keeps it.
  function toggleTheme() {
    chooseTheme(dark ? "light" : "dark");
  }
  function chooseTheme(choice: ThemeChoice) {
    setTheme(choice);
    setDark(setThemeChoice(choice));
  }
  // Commands for the quick search ("> …" or matching words).
  const openPageData = screen === "page" && data ? data : null;
  const commandActions: CommandAction[] = [
    { label: t("Neue Seite", "New page"), keywords: t("dokument anlegen erstellen notiz", "dokument anlegen erstellen notiz document new create note page"), icon: FileText, run: () => addPage() },
    { label: t("Erfassen", "Capture"), keywords: t("eingang inbox notiz schnell erfassen", "eingang inbox notiz schnell erfassen inbox note quick capture"), icon: Tray, run: () => setCapture(true) },
    { label: t("Neue Datenbank", "New database"), keywords: t("tabelle projekt anlegen", "tabelle projekt anlegen table project create database"), icon: Table, run: () => addPage("database") },
    { label: t("Neues Whiteboard", "New whiteboard"), keywords: "board canvas zeichnen", icon: PresentationChart, run: () => addPage("whiteboard") },
    { label: t("Neues Journal", "New journal"), keywords: t("tagebuch tag", "tagebuch tag diary day journal"), icon: Notebook, run: () => addPage("journal") },
    // "Journal: Heute" – with several journals one per journal, the last used first.
    ...journalsByUse().map((journal, _, list) => ({
      label: list.length > 1 ? t(`Journal: Heute – ${journal.title || "Ohne Titel"}`, `Journal: Today – ${journal.title || "Untitled"}`) : t("Journal: Heute", "Journal: Today"),
      keywords: `${t("tagebuch tag heute eintrag", "tagebuch tag heute diary day today entry journal")} ${journal.title}`,
      icon: CalendarCheck,
      run: () => void openJournalToday(journal.id),
    })),
    { label: t("Neues Notizbuch", "New notebook"), keywords: t("handschrift stift zeichnen heft goodnotes pdf", "handschrift stift zeichnen heft goodnotes pdf handwriting pencil notebook sketch"), icon: NotePencil, run: () => addPage("notebook") },
    { label: t("Neues Dashboard", "New dashboard"), keywords: t("übersicht kennzahlen kacheln", "übersicht kennzahlen kacheln overview metrics tiles dashboard"), icon: Gauge, run: () => addPage("dashboard") },
    { label: t("Auf der Seite suchen", "Find on page"), keywords: t("finden text treffer strg f", "finden text treffer strg f find text match ctrl f"), icon: MagnifyingGlass, run: () => setFind((f) => ({ open: true, key: f.key + 1 })) },
    { label: t("Einführung ansehen", "Show introduction"), keywords: t("onboarding tour hilfe willkommen", "onboarding tour hilfe willkommen help welcome"), icon: Sparkle, run: () => setOnboarding(true) },
    { label: t("Vorlagen öffnen", "Open templates"), keywords: "template galerie", icon: SquaresFour, run: () => setTemplates(true) },
    { label: t("Zur Startseite", "Go to home"), keywords: "home start", icon: House, run: () => go("home") },
    {
      label: t("Startseite anpassen", "Customize home page"),
      keywords: t("widgets anordnen personalisieren dashboard", "widgets anordnen personalisieren dashboard arrange personalize customize home"),
      icon: SlidersHorizontal,
      run: () => {
        go("home");
        setCustomizeHome((n) => n + 1);
      },
    },
    { label: t("Posteingang öffnen", "Open inbox"), keywords: "inbox benachrichtigungen", icon: Bell, run: () => go("inbox") },
    { label: t("Meine Aufgaben", "My tasks"), keywords: t("tasks todo fällig", "tasks todo fällig due aufgaben"), icon: CheckSquare, run: () => go("tasks") },
    { label: t("Medien", "Media"), keywords: t("bilder dateien", "bilder dateien images files media"), icon: ImageSquare, run: () => go("media") },
    { label: t("Graph der Verlinkungen", "Graph of links"), keywords: "graph netz verbindungen links karte", icon: Graph, run: () => go("graph") },
    { label: t("Papierkorb", "Trash"), keywords: t("trash gelöscht wiederherstellen", "trash gelöscht wiederherstellen papierkorb deleted restore"), icon: Trash, run: () => go("trash") },
    { label: t("Einstellungen", "Settings"), keywords: t("settings konto mitglieder profil sprache", "settings konto mitglieder preferences account members profile language"), icon: GearSix, run: () => go("settings") },
    { label: t("Tastenkürzel", "Keyboard shortcuts"), keywords: t("shortcuts tasten hilfe tastatur", "shortcuts tasten hilfe keyboard keys help hotkeys"), icon: Keyboard, run: () => setShortcuts(true) },
    ...(boot.user.isAdmin
      ? [{ label: t("Administration", "Administration"), keywords: "admin instanz betrieb", icon: ShieldCheck, run: () => go("admin") }]
      : []),
    { label: dark ? t("Helles Design", "Light theme") : t("Dunkles Design", "Dark theme"), keywords: "theme dark light nacht farbe", icon: dark ? Sun : Moon, run: toggleTheme },
    { label: t("Seitenleiste ein- oder ausblenden", "Show or hide sidebar"), keywords: "sidebar navigation", icon: SidebarSimple, run: () => setDesktopCollapsed((v) => !v) },
    ...(wide
      ? [
          splitShown
            ? { label: t("Geteilte Ansicht schließen", "Close split view"), keywords: t("split nebeneinander zwei seiten", "split nebeneinander zwei seiten side by side two pages"), icon: SquareSplitHorizontal, run: () => setSplit(null) }
            : { label: t("Seite daneben öffnen …", "Open a page beside it …"), keywords: t("split geteilte ansicht nebeneinander zwei seiten", "split geteilte ansicht nebeneinander zwei seiten view side by side two pages"), icon: SquareSplitHorizontal, run: () => setTimeout(openSplitSearch) },
        ]
      : []),
    ...(openPageData
      ? [
          { label: t("Fokusmodus", "Focus mode"), keywords: "schreiben ablenkungsfrei zen wortziel", icon: TextAa, run: () => setFocusMode(true) },
          ...(canRead
            ? [
                reading
                  ? { label: t("Bearbeiten", "Edit"), keywords: "lesemodus bearbeiten schreiben edit read", icon: PencilSimple, run: toggleReading }
                  : { label: t("Lesemodus", "Reading mode"), keywords: "lesemodus lesen nur lesen read view", icon: BookOpen, run: toggleReading },
              ]
            : []),
          {
            label: boot.favorites.includes(openPageData.page.id) ? t("Aus Favoriten entfernen", "Remove from favourites") : t("Zu Favoriten", "Add to favourites"),
            keywords: "favorit stern",
            icon: Star,
            run: () =>
              void act({ action: "favorite", pageId: openPageData.page.id, value: !boot.favorites.includes(openPageData.page.id) }),
          },
          {
            label: openPageData.following ? t("Seite nicht mehr folgen", "Unfollow page") : t("Seite folgen", "Follow page"),
            keywords: "benachrichtigen glocke follow",
            icon: Bell,
            run: () => void act({ action: "page.follow", pageId: openPageData.page.id, follow: !openPageData.following }),
          },
          { label: t("Kommentare öffnen", "Open comments"), keywords: "comments diskussion", icon: ChatCircle, run: () => setComments(true) },
          { label: t("Seite exportieren", "Export page"), keywords: "markdown html zip download export", icon: DownloadSimple, run: () => setPageExport(true) },
          { label: t("Drucken oder als PDF sichern", "Print or save as PDF"), keywords: "pdf print drucken", icon: Printer, run: printPage },
          ...(openPageData.page.kind === "document" && !openPageData.locked
            ? [{ label: t("Präsentieren", "Present"), keywords: t("präsentation folien vortrag beamer", "präsentation folien vortrag beamer presentation slides talk slideshow"), icon: PresentIcon, run: startPresentation }]
            : []),
          ...(openPageData.page.kind === "document"
            ? [
                {
                  label: t("Als Markdown bearbeiten", "Edit as Markdown"),
                  keywords: "markdown quelltext source text md",
                  icon: MarkdownLogo,
                  run: () => setSourcePage(openPageData.page.id),
                },
              ]
            : []),
          { label: t("Versionsverlauf", "Version history"), keywords: "history versionen wiederherstellen", icon: ClockCounterClockwise, run: () => setHistory(true) },
          { label: t("Teilen", "Share"), keywords: "share link freigeben", icon: ShareNetwork, run: () => setShare(true) },
        ]
      : []),
  ];
  const canAsk = aiUsable(boot.ai, "ask");
  if (canAsk)
    commandActions.unshift({
      label: t("KI fragen …", "Ask AI …"),
      keywords: t("ki fragen frage antwort assistent chat", "ki fragen frage antwort assistent chat ai ask question answer assistant"),
      icon: Sparkle,
      // The text typed so far becomes the question.
      run: () => setAsk({ question: query.replace(/^>\s*/, "").replace(/^(ki fragen|ask ai)\s*…?\s*/i, "").trim() }),
    });
  const commandQuery = normalizeCommand(query.replace(/^>\s*/, ""));
  const shownActions =
    query.startsWith(">") || commandQuery.length >= 2
      ? commandActions
          .filter((a) => !commandQuery || normalizeCommand(`${a.label} ${a.keywords}`).includes(commandQuery))
          .slice(0, query.startsWith(">") ? 20 : 4)
      : [];
  const runCommand = (action: CommandAction) => {
    closeSearch();
    action.run();
  };
  // The rows of the palette in order: hits, recently viewed pages (while
  // nothing is typed), then the commands – ">" shows commands only.
  const commandsOnly = query.startsWith(">");
  const recentPages: Page[] = commandsOnly || query.trim()
    ? []
    : (boot.recentVisits || [])
        .flatMap((visit) => {
          const page = activePages.find((p) => p.id === visit.pageId);
          return page ? [page] : [];
        })
        .slice(0, 6);
  const paletteResults = commandsOnly
    ? []
    : searchResults.filter((r) => !recentPages.some((p) => p.id === r.id && !r.rowId));
  const paletteItems: PaletteItem[] = [
    ...recentPages.map((page): PaletteItem => ({ kind: "recent", id: `recent-${page.id}`, page })),
    ...paletteResults.map((result): PaletteItem => ({ kind: "result", id: `result-${result.kind}-${result.id}-${result.rowId || ""}`, result })),
    ...shownActions.map((action, i): PaletteItem => ({ kind: "command", id: `command-${i}`, action })),
  ];
  const activeIndex = Math.min(paletteActive, Math.max(0, paletteItems.length - 1)),
    activeItem = paletteItems[activeIndex];
  // The highlight starts at the top whenever the rows change.
  useEffect(() => {
    setPaletteActive(0);
  }, [query, searchResults, searchKind, searchSpace, searchNoDays]);
  useEffect(() => {
    if (search && activeItem) document.getElementById(`palette-${activeItem.id}`)?.scrollIntoView({ block: "nearest" });
  }, [search, activeItem]);
  const runItem = (item: PaletteItem) => {
    if (item.kind === "command") return runCommand(item.action);
    const intoSplit = paletteSplit;
    closeSearch();
    // Chosen for the split view: the page opens next to the open one.
    if (intoSplit) return openSplit(item.kind === "recent" ? item.page.id : item.result.id);
    if (item.kind === "recent") return void openPage(item.page.id);
    const p = item.result;
    // The block with the hit flashes once the page is open.
    const hit = p.kind === "comment" || p.kind === "file" ? "" : snippetHit(p.snippet);
    if (hit) jumpTo({ pageId: p.id, rowId: p.rowId }, byText(hit));
    void openPage(p.id, p.rowId ? { pageId: p.id, rowId: p.rowId } : undefined);
  };
  // Hovering or highlighting a hit loads its page ahead (components/prefetch.ts).
  const prefetchOf = (item: PaletteItem) =>
    item.kind === "recent"
      ? { "data-prefetch-page": item.page.id }
      : item.kind === "result"
        ? { "data-prefetch-page": item.result.id, ...(item.result.rowId ? { "data-prefetch-row": item.result.rowId } : {}) }
        : {};
  useEffect(() => {
    if (!search || !activeItem || activeItem.kind === "command") return;
    const timer = setTimeout(() => {
      const target = activeItem.kind === "recent" ? { id: activeItem.page.id } : { id: activeItem.result.id, row: activeItem.result.rowId };
      if (target.row) prefetchRecord(target.id, target.row);
      else prefetchPage(target.id);
    }, INTENT_DELAY);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, activeItem?.id]);
  const paletteOption = (item: PaletteItem, index: number, content: React.ReactNode) => (
    <div
      key={item.id}
      {...prefetchOf(item)}
      id={`palette-${item.id}`}
      role="option"
      aria-selected={index === activeIndex}
      className={`palette-option${index === activeIndex ? " active" : ""}`}
      onClick={() => runItem(item)}
      onMouseMove={() => index !== paletteActive && setPaletteActive(index)}
    >
      {content}
      {index === activeIndex && <kbd aria-hidden="true">↵</kbd>}
    </div>
  );
  return (
    <AiProvider status={boot.ai || null} workspaceId={boot.workspace.id}>
    <div
      className={`app-shell ${mobile ? "nav-open" : ""} ${desktopCollapsed ? "desktop-collapsed" : ""}${focusMode && screen === "page" ? " focus-mode" : ""}${keyboardOpen ? " keyboard-open" : ""}`}
      style={sidebarWidth ? ({ "--sidebar-width": `${sidebarWidth}px` } as React.CSSProperties) : undefined}
      inert={switching || !!presenting}
      aria-busy={switching}
    >
      <ActivityPing />
      {focusMode && screen === "page" && data && (
        <FocusBar
          pageId={data.page.id}
          html={readHtml}
          onClose={() => setFocusMode(false)}
        />
      )}
      {/* The first Tab stop jumps over the sidebar; no hash change, so the
          router stays out of it. */}
      <a
        className="skip-link"
        href="#main-content"
        onClick={(e) => {
          e.preventDefault();
          mainRef.current?.focus();
        }}
      >
        {t("Zum Inhalt", "Skip to content")}
      </a>
      <button
        className="mobile-scrim"
        aria-label={t("Navigation schließen", "Close navigation")}
        onClick={() => setMobile(false)}
      />
      <aside className="sidebar">
        <div className="sidebar-top">
          <a
            href="#home"
            className="brand"
            onClick={(e) => {
              e.preventDefault();
              go("home");
            }}
          >
            <BrandMark size={28} />
            <span>flowplan</span>
            {boot.instance?.name && (
              <small className="instance-name">{boot.instance.name}</small>
            )}
          </a>
          <button
            className="icon-button sidebar-hide"
            title={t("Navigation schließen", "Close navigation")}
            onClick={() => {
              setMobile(false);
              setDesktopCollapsed(true);
            }}
          >
            <SidebarSimple size={19} />
          </button>
        </div>
        <Dropdown.Root>
          <Dropdown.Trigger className="workspace-switch">
            <WorkspaceIcon
              name={boot.workspace.name}
              icon={boot.workspace.icon}
            />
            <span>
              {boot.workspace.name}
              <small>
                {boot.members.length}{" "}
                {boot.members.length === 1 ? t("Mitglied", "member") : t("Mitglieder", "members")}
              </small>
            </span>
            <CaretDown size={14} />
          </Dropdown.Trigger>
          <Dropdown.Portal>
            <Dropdown.Content collisionPadding={safeCollisionPadding()} className="dropdown" align="start" sideOffset={4}>
              {boot.workspaces.map((w) => (
                <Dropdown.Item
                  className="dropdown-item"
                  key={w.id}
                  onSelect={() => switchWorkspace(w.id)}
                >
                  <WorkspaceIcon name={w.name} icon={w.icon} small />
                  {w.name}
                  {w.id === boot.workspace.id && <Check />}
                </Dropdown.Item>
              ))}
              {boot.instance?.allowWorkspaceCreation !== false && (
                <>
                  <Dropdown.Separator className="dropdown-separator" />
                  <Dropdown.Item
                    className="dropdown-item"
                    onSelect={() => setNewWorkspace(true)}
                  >
                    <Plus />
                    {t("Arbeitsbereich erstellen", "Create workspace")}
                  </Dropdown.Item>
                </>
              )}
            </Dropdown.Content>
          </Dropdown.Portal>
        </Dropdown.Root>
        <div className="sidebar-scroll" ref={treeRoot}>
          <nav className="main-nav">
            <button onClick={openSearch}>
              <MagnifyingGlass size={19} />
              {t("Suchen", "Search")}
              {keyHints.visible && shortcutHint("search", mac) && <span className="keycap">{shortcutHint("search", mac)}</span>}
            </button>
            {canAsk && (
              <button onClick={() => setAsk({ question: "" })}>
                <Sparkle size={19} />
                {t("KI fragen", "Ask AI")}
              </button>
            )}
            <button
              className={screen === "home" ? "selected" : ""}
              onClick={() => go("home")}
            >
              <House size={19} />
              {t("Startseite", "Home")}
            </button>
            <button
              className={screen === "inbox" ? "selected" : ""}
              onClick={() => go("inbox")}
            >
              <Bell size={19} />
              {t("Posteingang", "Inbox")}
              {boot.notifications.some((n) => !n.read_at) && (
                <span className="notification-count">
                    {boot.notifications.filter((n) => !n.read_at).length}
                </span>
              )}
            </button>
            <button
              className={screen === "tasks" ? "selected" : ""}
              onClick={() => go("tasks")}
            >
              <CheckSquare size={19} />
              {t("Meine Aufgaben", "My tasks")}
              {!!boot.dueTasks && (
                <span className="notification-count" title={t("Heute fällig oder überfällig", "Due today or overdue")}>
                  {boot.dueTasks}
                </span>
              )}
            </button>
          </nav>
          <div className="tree-filter">
            <MagnifyingGlass size={14} aria-hidden="true" />
            <input
              type="search"
              value={treeFilter}
              onChange={(e) => setTreeFilter(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setTreeFilter("")}
              placeholder={t("Seiten filtern", "Filter pages")}
              aria-label={t("Seiten filtern", "Filter pages")}
            />
          </div>
          {filterMatches && !filterMatches.size && (
            <p className="sidebar-empty tree-filter-empty">{t("Keine Seite heißt so.", "No page has that name.")}</p>
          )}
          {!filterMatches && (favorites.length > 0 || !!boot.favoriteRows?.length) && (
            <section className="nav-section">
              <div className="nav-section-title">
                {t("Favoriten", "Favourites")}
                <Star size={13} />
              </div>
              {favorites.map((p) => (
                <button
                  className={`favorite-nav ${pageId === p.id && screen === "page" ? "selected" : ""}`}
                  key={p.id}
                  data-prefetch-page={p.id}
                  onClick={(e) => ((e.metaKey || e.ctrlKey) && wide ? openSplit(p.id) : void openPage(p.id))}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setPageMenu({ page: p, x: e.clientX, y: e.clientY });
                  }}
                  {...pressMenu(p)}
                >
                  <PageIcon name={p.icon} />
                  <span>{p.title}</span>
                </button>
              ))}
              {boot.favoriteRows?.map((f) => (
                <button
                  className="favorite-nav"
                  key={f.rowId}
                  aria-label={t(`Eintrag ${f.title}`, `Record ${f.title}`)}
                  onClick={() =>
                    openPage(f.pageId, { pageId: f.pageId, rowId: f.rowId })
                  }
                >
                  <PageIcon name="file" />
                  <span>{f.title}</span>
                </button>
              ))}
            </section>
          )}
          {(selecting || selectedPages.length > 0) && (
            <div
              className="page-selection-bar"
              role="toolbar"
              aria-label={t("Seitenauswahl", "Page selection")}
            >
              <span>{selectedPages.length} {t("ausgewählt", "selected")}</span>
              <button
                className="text-button"
                disabled={!selectedPages.length || bulkBusy}
                onClick={() => {
                  setBulkTarget("");
                  setBulkDialog("move");
                }}
              >
                {t("Verschieben", "Move")}
              </button>
              <button
                className="text-button"
                disabled={!selectedPages.length || bulkBusy}
                onClick={() => void bulkPages("duplicate")}
              >
                {t("Duplizieren", "Duplicate")}
              </button>
              <button
                className="text-button danger"
                disabled={!selectedPages.length || bulkBusy}
                onClick={() => setBulkDialog("delete")}
              >
                {t("Papierkorb", "Trash")}
              </button>
              <button className="text-button" onClick={clearSelection}>
                {t("Fertig", "Done")}
              </button>
            </div>
          )}
          {boot.spaces
            .filter(
              (space) =>
                !filterMatches ||
                activePages.some((p) => p.space_id === space.id && filterMatches.has(p.id)),
            )
            .map((space, spaceIndex, shownSpaces) => {
              // While filtering every space with a match stays open.
              const spaceClosed = !filterMatches && collapsedSpaces.has(space.id),
                spaceOrder = boot.spaces.map((s) => s.id),
                reorderable = canReorderSpaces && !filterMatches;
              return (
            <section
              className={`nav-section${spaceDrop?.id === space.id ? ` space-drop-${spaceDrop.placement}` : ""}${spaceClosed ? " space-collapsed" : ""}`}
              key={space.id}
              data-space-id={space.id}
              onDragOver={(e) => {
                if (!reorderable || !e.dataTransfer.types.includes("application/x-flowplan-space")) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                const rect = e.currentTarget.getBoundingClientRect();
                const placement = e.clientY - rect.top < rect.height / 2 ? "before" : "after";
                if (spaceDrop?.id !== space.id || spaceDrop.placement !== placement) setSpaceDrop({ id: space.id, placement });
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setSpaceDrop((d) => (d?.id === space.id ? null : d));
              }}
              onDrop={(e) => {
                const source = e.dataTransfer.getData("application/x-flowplan-space");
                if (!source) return;
                e.preventDefault();
                e.stopPropagation();
                const placement = spaceDrop?.id === space.id ? spaceDrop.placement : "before";
                setSpaceDrop(null);
                void reorderSpaces(dropSpace(spaceOrder, source, space.id, placement), source);
              }}
            >
              <div
                className="nav-section-title"
                draggable={reorderable}
                onDragStart={(e) => {
                  if (!reorderable || (e.target as HTMLElement).closest(".nav-section-tools")) {
                    e.preventDefault();
                    return;
                  }
                  e.dataTransfer.setData("application/x-flowplan-space", space.id);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragEnd={() => setSpaceDrop(null)}
              >
                <button
                  type="button"
                  className="space-toggle"
                  aria-expanded={!spaceClosed}
                  aria-controls={`space-tree-${space.id}`}
                  title={spaceClosed ? t(`${space.name} aufklappen`, `Expand ${space.name}`) : t(`${space.name} zuklappen`, `Collapse ${space.name}`)}
                  onClick={() => foldSpace(space.id, !collapsedSpaces.has(space.id))}
                >
                  <CaretRight size={10} className="space-caret" aria-hidden="true" />
                  <SpaceIcon icon={space.icon} color={space.icon_color} />
                  {(space as { encrypted?: number }).encrypted ? (
                    <LockKey size={12} weight="fill" className="e2ee-space-icon" aria-label={t("Verschlüsselter Bereich", "Encrypted space")} />
                  ) : space.visibility === "private" && (
                    <Lock size={12} aria-label={t("Privater Bereich", "Private space")} />
                  )}{" "}
                  <span className="space-name" title={space.name}>
                    {space.name}
                  </span>
                </button>
                {/* The tools wrap under a long name instead of squeezing it. */}
                <span className="nav-section-tools">
                  {(boot.workspace.role === "owner" ||
                    (canCreate && space.owner_id === boot.user.id)) && (
                    <Dropdown.Root>
                      <Dropdown.Trigger
                        className="icon-button"
                        aria-label={t(`Bereich ${space.name} verwalten`, `Manage space ${space.name}`)}
                      >
                        <DotsThree size={16} />
                      </Dropdown.Trigger>
                      <Dropdown.Portal>
                        <Dropdown.Content collisionPadding={safeCollisionPadding()} className="dropdown" align="end">
                          <Dropdown.Item className="dropdown-item" onSelect={() => setSpaceManager({ space })}>
                            <GearSix />
                            {t("Bereich bearbeiten …", "Edit space …")}
                          </Dropdown.Item>
                          {reorderable && (
                            <>
                              <Dropdown.Separator className="dropdown-separator" />
                              <Dropdown.Item
                                className="dropdown-item"
                                disabled={spaceIndex === 0}
                                onSelect={() => void reorderSpaces(moveSpaceBy(spaceOrder, space.id, -1), space.id)}
                              >
                                <ArrowUp />
                                {t("Nach oben", "Move up")}
                              </Dropdown.Item>
                              <Dropdown.Item
                                className="dropdown-item"
                                disabled={spaceIndex === shownSpaces.length - 1}
                                onSelect={() => void reorderSpaces(moveSpaceBy(spaceOrder, space.id, 1), space.id)}
                              >
                                <ArrowDown />
                                {t("Nach unten", "Move down")}
                              </Dropdown.Item>
                            </>
                          )}
                        </Dropdown.Content>
                      </Dropdown.Portal>
                    </Dropdown.Root>
                  )}
                  {(space as { encrypted?: number }).encrypted ? (
                    <button
                      className="icon-button"
                      title={t(`Mitglieder und Schlüssel von ${space.name}`, `Members and keys of ${space.name}`)}
                      aria-label={t(`Mitglieder und Schlüssel von ${space.name}`, `Members and keys of ${space.name}`)}
                      onClick={() => setSpaceKeys(space.id)}
                    >
                      <LockKey size={14} />
                    </button>
                  ) : (
                    <button
                      className="icon-button"
                      title={t(`${space.name} als Markdown exportieren`, `Export ${space.name} as Markdown`)}
                      aria-label={t(`${space.name} als Markdown exportieren`, `Export ${space.name} as Markdown`)}
                      onClick={() => setSpaceExport(space.id)}
                    >
                      <DownloadSimple size={14} />
                    </button>
                  )}
                  {canCreate && (
                    <button
                      className={`icon-button ${selecting ? "active" : ""}`}
                      title={t("Seiten auswählen", "Select pages")}
                      aria-pressed={selecting}
                      onClick={() =>
                        selecting ? clearSelection() : setSelecting(true)
                      }
                    >
                      <CheckSquare size={14} />
                    </button>
                  )}
                  {canCreate && (
                    <button
                      className="icon-button"
                      title={t(`Seite in ${space.name} hinzufügen`, `Add page in ${space.name}`)}
                      onClick={() => addPage("document", null, space.id)}
                    >
                      <Plus size={14} />
                    </button>
                  )}
                </span>
              </div>
              {/* Folding keeps the tree mounted only while open. */}
              <Collapse open={!spaceClosed} className="space-tree">
                {!spaceClosed ? (
                  <div id={`space-tree-${space.id}`}>
                    <div role="tree" aria-label={t(`Seiten in ${space.name}`, `Pages in ${space.name}`)}>
                      {tree(null, space.id, 0, treeStop(space.id))}
                    </div>
                    {!activePages.some((p) => p.space_id === space.id) && (
                      <span className="sidebar-empty">{t("Noch keine Seiten", "No pages yet")}</span>
                    )}
                  </div>
                ) : null}
              </Collapse>
            </section>
              );
            })}
          <p className="sr-only" role="status" aria-live="polite">
            {spaceMoveNote}
          </p>
          {canCreate && (
            <button className="add-space" onClick={() => setNewSpace(true)}>
              <Plus size={15} />
              {t("Bereich hinzufügen", "Add space")}
            </button>
          )}
        </div>
        <div className="sidebar-bottom">
          {/* Less used places as one row of symbols: the page tree above
              keeps the height. */}
          <div className="sidebar-tools">
            <button
              aria-label={t("Vorlagen", "Templates")}
              title={t("Vorlagen", "Templates")}
              onClick={() => setTemplates(true)}
            >
              <SquaresFour size={18} />
            </button>
            <button
              aria-label={t("Medien", "Media")}
              title={t("Medien", "Media")}
              className={screen === "media" ? "selected" : ""}
              onClick={() => go("media")}
            >
              <Images size={18} />
            </button>
            <button
              aria-label={t("Graph", "Graph")}
              title={t("Graph der Verlinkungen", "Graph of links")}
              className={screen === "graph" ? "selected" : ""}
              onClick={() => go("graph")}
            >
              <Graph size={18} />
            </button>
            <button
              aria-label={t("Papierkorb", "Trash")}
              title={t("Papierkorb", "Trash")}
              className={screen === "trash" ? "selected" : ""}
              onClick={() => go("trash")}
            >
              <Trash size={18} />
            </button>
            <button
              aria-label={t("Einstellungen", "Settings")}
              title={t("Einstellungen", "Settings")}
              className={screen === "settings" ? "selected" : ""}
              onClick={() => go("settings")}
            >
              <GearSix size={18} />
            </button>
            <button
              aria-label={t("Tastenkürzel", "Keyboard shortcuts")}
              title={t("Tastenkürzel", "Keyboard shortcuts") + hint("shortcuts")}
              className="sidebar-help"
              onClick={() => setShortcuts(true)}
            >
              <Question size={18} />
            </button>
            {boot.user.isAdmin && (
              <button
                aria-label={t("Administration", "Administration")}
                title={t("Administration", "Administration")}
                className={screen === "admin" ? "selected" : ""}
                onClick={() => go("admin")}
              >
                <ShieldCheck size={18} />
              </button>
            )}
          </div>
          <div className="profile">
            <Avatar name={boot.user.name} userId={boot.user.id} />
            <span>
              {boot.user.name}
              <small>{online ? t("Arbeitsbereich verbunden", "Workspace connected") : t("Offline", "Offline")}</small>
            </span>
            <Dropdown.Root>
              <Dropdown.Trigger className="icon-button" aria-label={t("Kontomenü", "Account menu")}>
                <DotsThree size={22} />
              </Dropdown.Trigger>
              <Dropdown.Portal>
                <Dropdown.Content collisionPadding={safeCollisionPadding()} className="dropdown" align="end">
                  <Dropdown.Item
                    className="dropdown-item"
                    onSelect={() => {
                      toggleTheme();
                    }}
                  >
                    {dark ? <Sun /> : <Moon />}
                    {dark ? t("Helles Design", "Light theme") : t("Dunkles Design", "Dark theme")}
                  </Dropdown.Item>
                  <Dropdown.Item
                    className="dropdown-item"
                    onSelect={async () => {
                      await disableOffline().catch(() => undefined);
                      clearAppCache();
                      await fetch("/api/auth/logout", { method: "POST" });
                      location.href = "/";
                    }}
                  >
                    <SignOut />
                    {t("Abmelden", "Sign out")}
                  </Dropdown.Item>
                  {(boot.instance?.legal?.imprint || boot.instance?.legal?.privacy) && <Dropdown.Separator className="dropdown-separator" />}
                  {boot.instance?.legal?.imprint && (
                    <Dropdown.Item className="dropdown-item" asChild>
                      <a href={boot.instance.legal.imprint} target="_blank" rel="noopener">
                        <Scales />
                        {t("Impressum", "Legal notice")}
                      </a>
                    </Dropdown.Item>
                  )}
                  {boot.instance?.legal?.privacy && (
                    <Dropdown.Item className="dropdown-item" asChild>
                      <a href={boot.instance.legal.privacy} target="_blank" rel="noopener">
                        <ShieldCheck />
                        {t("Datenschutz", "Privacy")}
                      </a>
                    </Dropdown.Item>
                  )}
                </Dropdown.Content>
              </Dropdown.Portal>
            </Dropdown.Root>
          </div>
        </div>
        <SidebarResize
          width={sidebarWidth}
          onWidth={setSidebarWidth}
          label={t("Breite der Seitenleiste", "Sidebar width")}
          hint={t("Ziehen zum Ändern, Doppelklick setzt zurück", "Drag to resize, double-click to reset")}
        />
      </aside>
      <main className="main" id="main-content" tabIndex={-1} ref={mainRef}>
        {boot.user.demo && (
          <div className="demo-banner" role="note">
            <span>
              <strong>{t("Demo", "Demo")}</strong> {t("– probier alles aus. Dein Arbeitsbereich wird gelöscht, sobald du die Demo beendest oder 45 Minuten nichts tust.", "– try everything. Your workspace is deleted as soon as you end the demo or do nothing for 45 minutes.")}
            </span>
            <a className="button primary" href="/api/auth/login?register=1">
              {t("Registrieren", "Sign up")}
            </a>
            <button
              type="button"
              className="button"
              onClick={async () => {
                await fetch("/api/auth/trial-end", { method: "POST" });
                location.assign("/");
              }}
            >
              {t("Demo beenden", "End demo")}
            </button>
          </div>
        )}
        {boot.instance?.announcement && (
          <div className="instance-announcement" role="note">
            {boot.instance.announcement}
          </div>
        )}
        {!online && (
          <div className="offline-banner" role="status">
            {t("Offline – du siehst den zuletzt gespeicherten Stand. Textänderungen werden später abgeglichen.", "Offline – you see the last saved state. Text changes are synced later.")}
          </div>
        )}
        {offlineNotice}
        {signedOut && (
          <div className="offline-banner signed-out-banner" role="alert">
            {t("Du wurdest abgemeldet – melde dich erneut an, um deine Änderungen zu behalten.", "You were signed out – sign in again to keep your changes.")}{" "}
            {/* The same address again: "/" shows the sign-in page and returns here. */}
            <a
              href="/"
              onClick={(e) => {
                e.preventDefault();
                location.reload();
              }}
            >
              {t("Anmelden", "Sign in")}
            </a>
          </div>
        )}
        <header className="topbar" ref={guardChromeTouches}>
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              aria-label={t("Navigation öffnen", "Open navigation")}
              onClick={() => {
                setMobile(true);
                setDesktopCollapsed(false);
              }}
            >
              <SidebarSimple size={21} />
            </button>
            <span className="breadcrumb-workspace">{boot.workspace.name}</span>
            <span className="breadcrumb-divider">/</span>
            {screen === "page" && data ? (
              <>
                <PageIcon name={data.page.icon} size={16} />
                <span>{titledPages.find((p) => p.id === data.page.id)?.title ?? data.page.title}</span>
              </>
            ) : (
              <span>
                {
                  {
                    home: t("Startseite", "Home"),
                    trash: t("Papierkorb", "Trash"),
                    inbox: t("Posteingang", "Inbox"),
                    tasks: t("Meine Aufgaben", "My tasks"),
                    graph: t("Graph", "Graph"),
                    media: t("Medien", "Media"),
                    settings: t("Einstellungen", "Settings"),
                    admin: t("Administration", "Administration"),
                    page: t("Seite", "Page"),
                  }[screen]
                }
              </span>
            )}
          </div>
          {screen === "page" && data?.draft ? (
            <span className="topbar-note journal-draft-note" role="status">
              <span className="subtle-dot" />
              {t("Entwurf – wird beim ersten Schreiben angelegt", "Draft – created when you start writing")}
            </span>
          ) : screen === "page" && data ? (
            <div className="page-top-actions">
              {/* Saving and offline states cross-fade instead of switching hard. */}
              <CrossFade className="save-status" value={`${online}:${statusLabel(status)}`}>
                {online ? <CloudCheck size={15} /> : <WifiSlash size={15} />}
                <span>{statusLabel(status)}</span>
              </CrossFade>
              <PresenceAvatars users={data.present.filter((u) => u.id !== boot.user.id).slice(0, 3)} />
              {canRead && (
                <button
                  className={`icon-button read-mode-toggle${reading ? " active" : ""}`}
                  title={(reading ? t("Bearbeiten", "Edit") : t("Lesemodus", "Reading mode")) + hint("readMode")}
                  aria-label={reading ? t("Bearbeiten", "Edit") : t("Lesemodus", "Reading mode")}
                  aria-pressed={reading}
                  onClick={toggleReading}
                >
                  {reading ? <PencilSimple size={20} /> : <BookOpen size={20} />}
                </button>
              )}
              {!data.encrypted && (
                <button
                  title={t("Kommentare", "Comments")}
                  className={`icon-button ${comments ? "active" : ""}`}
                  onClick={() => setComments(!comments)}
                >
                  <ChatCircle size={20} />
                </button>
              )}
              {data.encrypted && (
                <span className="e2ee-page-lock" title={t("Ende-zu-Ende-verschlüsselt", "End-to-end encrypted")} aria-label={t("Ende-zu-Ende-verschlüsselt", "End-to-end encrypted")}>
                  <LockKey size={18} weight="fill" />
                </span>
              )}
              <ReadersButton readers={data.readers || []} />
              {data.following !== undefined && (
                <FollowButton
                  following={data.following}
                  followers={data.followers || 0}
                  onToggle={(follow) =>
                    act({ action: "page.follow", pageId: data.page.id, follow })
                  }
                />
              )}
              <button
                className={`icon-button ${boot.favorites.includes(data.page.id) ? "starred" : ""}`}
                title={t("Favorit", "Favourite")}
                onClick={() =>
                  act({
                    action: "favorite",
                    pageId: data.page.id,
                    value: !boot.favorites.includes(data.page.id),
                  })
                }
              >
                <Star
                  size={20}
                  weight={
                    boot.favorites.includes(data.page.id) ? "fill" : "regular"
                  }
                />
              </button>
              {data.encrypted ? (
                <button className="button compact share-button" onClick={() => setSpaceKeys(data.encrypted!.spaceId)}>
                  <LockKey size={15} />
                  {t("Mitglieder", "Members")}
                </button>
              ) : (
                <button
                  className="button compact share-button"
                  onClick={() => setShare(true)}
                >
                  <ShareNetwork size={15} />
                  {t("Teilen", "Share")}
                </button>
              )}
              <Dropdown.Root>
                <Dropdown.Trigger
                  className="icon-button"
                  aria-label={t("Seitenaktionen", "Page actions")}
                >
                  <DotsThree size={24} />
                </Dropdown.Trigger>
                <Dropdown.Portal>
                  <Dropdown.Content collisionPadding={safeCollisionPadding()} className="dropdown" align="end">
                    {/* The desktop app: from a browser on a computer, the page
                        opens there (flowplan://open); inside the app, in a
                        window of its own. */}
                    {offerDesktopApp(currentOS(), inDesktopApp() || !!desktopApp(), nativeApp()) ? (
                      <Dropdown.Item className="dropdown-item" onSelect={() => void (location.href = desktopPageLink(location.origin, data.page.id))}>
                        <Desktop />
                        {t("In Desktop-App öffnen", "Open in desktop app")}
                      </Dropdown.Item>
                    ) : openInWindow() ? (
                      <Dropdown.Item
                        className="dropdown-item"
                        onSelect={() => openInWindow()?.(`${location.origin}${location.pathname}${pageLocationHash({ pageId: data.page.id })}`)}
                      >
                        <AppWindow />
                        {t("In neuem Fenster öffnen", "Open in new window")}
                      </Dropdown.Item>
                    ) : null}
                    <Dropdown.Item
                      className="dropdown-item"
                      onSelect={() => {
                        setIconPicker(true);
                      }}
                    >
                      <Flag />
                      {t("Icon ändern", "Change icon")}
                    </Dropdown.Item>
                    {!data.encrypted && (
                      <Dropdown.Item
                        className="dropdown-item"
                        onSelect={() => setCoverPicker(true)}
                      >
                        <SquaresFour />
                        {t("Cover ändern", "Change cover")}
                      </Dropdown.Item>
                    )}
                    <Dropdown.Item
                      className="dropdown-item"
                      onSelect={() =>
                        act({
                          action: "page.update",
                          pageId,
                          patch: { full_width: !data.page.full_width },
                        })
                      }
                    >
                      <ArrowSquareOut />
                      {t("Volle Breite", "Full width")}{" "}{data.page.full_width ? "✓" : ""}
                    </Dropdown.Item>
                    <Dropdown.Item
                      className="dropdown-item"
                      onSelect={() =>
                        act({
                          action: "page.update",
                          pageId,
                          patch: {
                            font: data.page.font === "serif" ? "sans" : "serif",
                          },
                        })
                      }
                    >
                      <FileText />
                      {t("Schrift wechseln", "Change font")}
                    </Dropdown.Item>
                    <Dropdown.Separator className="dropdown-separator" />
                    {!data.encrypted && (
                      <Dropdown.Item
                        className="dropdown-item"
                        onSelect={async () => {
                          const r = await act({
                            action: "page.duplicate",
                            pageId,
                          });
                          if (r?.id) void openPage(String(r.id));
                        }}
                      >
                        <Copy />
                        {t("Duplizieren", "Duplicate")}
                      </Dropdown.Item>
                    )}
                    <Dropdown.Item
                      className="dropdown-item"
                      onSelect={() => setMove(true)}
                    >
                      <ArrowRight />
                      {t("Verschieben", "Move")}
                    </Dropdown.Item>
                    {data.page.kind === "document" && !data.encrypted && (
                      <Dropdown.Item
                        className="dropdown-item"
                        onSelect={() => setToRecord(true)}
                      >
                        <Table />
                        {t("In Datenbank verschieben …", "Move into database …")}
                      </Dropdown.Item>
                    )}
                    {!data.encrypted && (
                      <Dropdown.Item
                        className="dropdown-item"
                        onSelect={() => setTemplateName(true)}
                      >
                        <SquaresFour />
                        {t("Als Vorlage speichern", "Save as template")}
                      </Dropdown.Item>
                    )}
                    {!data.encrypted && (
                      <Dropdown.Item
                        className="dropdown-item"
                        onSelect={() => setPageExport(true)}
                      >
                        <DownloadSimple />
                        {t("Exportieren", "Export")}
                      </Dropdown.Item>
                    )}
                    {data.page.kind === "document" && !data.locked && summaryRoute.availability !== "hidden" && (
                      <Dropdown.Item
                        className="dropdown-item"
                        disabled={summaryRoute.availability === "blocked"}
                        title={summaryRoute.availability === "blocked" ? t("KI hat keinen Zugriff auf diese Seite", "The AI has no access to this page") : undefined}
                        onSelect={() => {
                          setComments(false);
                          setAiSummary({ pageId: data.page.id, title: data.page.title, kind: "page", encrypted: !!data.encrypted });
                        }}
                      >
                        <Sparkle />
                        {t("Mit KI zusammenfassen", "Summarise with AI")}
                        {summaryRoute.availability === "blocked" && (
                          <small className="dropdown-hint">{t("KI hat keinen Zugriff auf diese Seite", "The AI has no access to this page")}</small>
                        )}
                      </Dropdown.Item>
                    )}
                    {!data.encrypted && (
                      <Dropdown.Item
                        className="dropdown-item"
                        onSelect={() => printPage()}
                      >
                        <FileText />
                        {t("Drucken / PDF", "Print / PDF")}
                      </Dropdown.Item>
                    )}
                    {data.page.kind === "document" && !data.locked && !data.encrypted && (
                      <Dropdown.Item className="dropdown-item" onSelect={startPresentation}>
                        <PresentIcon />
                        {t("Präsentieren", "Present")}
                      </Dropdown.Item>
                    )}
                    {wide && (
                      <Dropdown.Item className="dropdown-item" onSelect={openSplitSearch}>
                        <SquareSplitHorizontal />
                        {splitShown ? t("Andere Seite daneben öffnen …", "Open another page beside it …") : t("Seite daneben öffnen …", "Open a page beside it …")}
                      </Dropdown.Item>
                    )}
                    {data.page.kind === "document" && !data.locked && !data.encrypted && (
                      <Dropdown.Item
                        className="dropdown-item"
                        onSelect={() => setSourcePage(sourceOpen ? null : data.page.id)}
                      >
                        <MarkdownLogo />
                        {sourceOpen
                          ? t("Markdown-Ansicht schließen", "Close Markdown view")
                          : editable
                            ? t("Als Markdown bearbeiten", "Edit as Markdown")
                            : t("Als Markdown anzeigen", "View as Markdown")}
                      </Dropdown.Item>
                    )}
                    <Dropdown.Item className="dropdown-item" onSelect={() => openPageReview(data.page.id)}>
                      <UsersThree />
                      {t("Besitzer und Prüfung …", "Owner and review …")}
                    </Dropdown.Item>
                    {!data.encrypted && (
                      <Dropdown.Item className="dropdown-item" onSelect={() => openPageAliases(data.page.id)}>
                        <AliasIcon />
                        {t("Aliasse …", "Aliases …")}
                      </Dropdown.Item>
                    )}
                    {!data.encrypted && (
                      <Dropdown.Item
                        className="dropdown-item"
                        onSelect={() => setHistory(true)}
                      >
                        <Clock />
                        {t("Versionsverlauf", "Version history")}
                      </Dropdown.Item>
                    )}
                    {data.page.kind === "document" && !data.encrypted && (
                      <Dropdown.Item
                        className="dropdown-item"
                        // The open editor shows or hides who wrote what.
                        onSelect={() =>
                          window.dispatchEvent(new CustomEvent("flowplan:authors", { detail: data.page.id }))
                        }
                      >
                        <UsersThree />
                        {t("Autoren anzeigen", "Show authors")}
                      </Dropdown.Item>
                    )}
                    <Dropdown.Item
                      className="dropdown-item"
                      onSelect={() =>
                        act({
                          action: "page.update",
                          pageId,
                          patch: { locked: !data.page.locked },
                        })
                      }
                    >
                      <Lock />
                      {data.page.locked ? t("Seite entsperren", "Unlock page") : t("Seite sperren", "Lock page")}
                    </Dropdown.Item>
                    <Dropdown.Separator className="dropdown-separator" />
                    <Dropdown.Item
                      className="dropdown-item danger"
                      onSelect={async () => {
                        // Gone at once; a refusal opens the page again.
                        const deleted = pageId;
                        const pending = act({ action: "page.delete", pageId: deleted });
                        go("trash");
                        setPageId(null);
                        if (!(await pending) && deleted) void openPage(deleted);
                      }}
                    >
                      <Trash />
                      {t("In den Papierkorb", "Move to trash")}
                    </Dropdown.Item>
                  </Dropdown.Content>
                </Dropdown.Portal>
              </Dropdown.Root>
            </div>
          ) : (
            <span className="topbar-note">
              <span className="subtle-dot" />
              {t("Dein Raum für Ideen", "Your room for ideas")}
            </span>
          )}
        </header>
        {/* Split view: the open page (left) and a second one (right). */}
        <div
          className={`split-row${splitShown ? " split-active" : ""}`}
          ref={splitRow}
          style={splitShown ? ({ "--split": `${splitRatio}%` } as React.CSSProperties) : undefined}
        >
          <div className="split-primary">
        {splitShown && split && (
          <div className="split-primary-bar">
            <span>
              {screen === "page" && data ? (
                <>
                  <PageIcon name={data.page.kind === "database" ? "table" : data.page.icon} size={15} />
                  {data.page.title || t("Ohne Titel", "Untitled")}
                </>
              ) : (
                t("Hauptansicht", "Main view")
              )}
            </span>
            <button
              type="button"
              className="icon-button"
              title={t("Diese Seite schließen – die rechte bleibt offen", "Close this page – the right one stays open")}
              aria-label={t("Linke Seite schließen", "Close the left page")}
              onClick={() => void openPage(split)}
            >
              <X size={15} />
            </button>
          </div>
        )}
        <div className="main-scroll">
          {screen === "home" && (
            <HomeScreen
              boot={boot}
              pages={activePages}
              clock={clock}
              canCreate={canCreate}
              customize={customizeHome}
              openPage={(id, target) => void openPage(id, target)}
              addPage={(kind) => addPage(kind)}
              openCapture={() => setCapture(true)}
              go={go}
              mutate={mutate}
              notify={notify}
              notifyError={notifyError}
              onHome={(home) => setBoot((b) => ({ ...b, home }))}
              footnote={
                <div className="home-footnote">
                  <Stack size={16} />
                  <span>{t("Weniger suchen. Mehr bewegen.", "Search less. Get more done.")}</span>
                  {keyHints.visible && shortcutHint("search", mac) && (
                    <span className="kbd-hint">{t(`${shortcutHint("search", mac)} zum schnellen Finden`, `${shortcutHint("search", mac)} to find things fast`)}</span>
                  )}
                </div>
              }
            />
          )}
          {screen === "page" && (busy || !data) ? (
            busy ? (
              <div className="page-content">
                <PageSkeleton
                  kind={
                    boot.pages.find((p) => p.id === pageId)?.kind === "database"
                      ? "database"
                      : "document"
                  }
                  view={viewShapeOf(pageId)}
                />
              </div>
            ) : (
              <div className="loading-content">{t("Seite nicht verfügbar.", "Page not available.")}</div>
            )
          ) : (
            screen === "page" &&
            data && (
              <div className={`page-layout ${comments ? "with-comments" : ""}`}>
                <article
                  data-revalidating={revalidating ? "true" : undefined}
                  className={`page-content ${data.page.kind === "database" ? "database-page" : ""} ${data.page.kind === "whiteboard" ? "whiteboard-page" : ""} ${data.page.kind === "notebook" ? "notebook-page" : ""} ${data.page.full_width ? "full-width" : ""} font-${data.page.font}`}
                >
                  {data.page.cover && (
                    <CoverFrame
                      className="page-cover"
                      cover={data.page.cover}
                      image={!!imageFileId(data.page.cover)}
                      alt={t("Seiten-Cover", "Page cover")}
                      position={`50% ${data.page.cover_position ?? 50}%`}
                    >
                      {editable && (
                        <button
                          className="button cover-change"
                          onClick={() => setCoverPicker(true)}
                        >
                          {t("Cover ändern", "Change cover")}
                        </button>
                      )}
                    </CoverFrame>
                  )}
                  {data.journalDay && !data.locked && (
                    // A day page: previous and next entry, today, a month picker (#49).
                    <JournalDayNav
                      date={data.journalDay.date}
                      today={localDay()}
                      days={(treeIndex.get(data.journalDay.journalId) || []).filter((p) => p.journal_date)}
                      onOpen={(id) => void openPage(id)}
                      onToday={() => void openJournalToday(data.journalDay!.journalId)}
                    />
                  )}
                  <div className="document-header">
                    <button
                      className="large-page-icon"
                      title={t("Seiten-Icon ändern", "Change page icon")}
                      onClick={() => editable && !data.draft && setIconPicker(true)}
                    >
                      <PageIcon
                        name={data.page.icon}
                        size={iconPixels[data.page.icon_size || ""]}
                      />
                    </button>
                    {editable && !data.page.cover && !data.encrypted && !data.draft && (
                      <button
                        className="add-cover text-button"
                        onClick={() => setCoverPicker(true)}
                      >
                        {t("Cover hinzufügen", "Add cover")}
                      </button>
                    )}
                    {data.encrypted?.encryptTitles ? (
                      <EncryptedTitleInput
                        page={data.page}
                        title={titledPages.find((p) => p.id === data.page.id)?.title ?? ""}
                        editable={editable}
                        onSave={(cipher) => act({ action: "e2ee.title", pageId: data.page.id, cipher })}
                        onError={(message) => notifyError(new Error(message))}
                      />
                    ) : (
                    <input
                      key={`${data.page.id}-title`}
                      className="page-title"
                      aria-label={t("Seitentitel", "Page title")}
                      defaultValue={data.page.title}
                      readOnly={!editable || !!data.draft}
                      onBlur={(e) => {
                        if (
                          e.target.value.trim() &&
                          e.target.value !== data.page.title
                        )
                          void act({
                            action: "page.update",
                            pageId,
                            patch: { title: e.target.value },
                          });
                      }}
                    />
                    )}
                    {data.page.locked === 1 && (
                      <div className="locked-notice">
                        <Lock size={14} />
                        {t("Diese Seite ist gesperrt.", "This page is locked.")}
                      </div>
                    )}
                  </div>
                  {data.draft ? (
                    <p className="journal-draft-hint" role="note">
                      {t(
                        "Noch nicht gespeichert: Die Seite für heute wird angelegt, sobald du etwas schreibst, eine Aufgabe abhakst, einen Wert einträgst oder eine Datei hinzufügst.",
                        "Not saved yet: today's page is created as soon as you write something, tick a task, enter a value or add a file.",
                      )}
                    </p>
                  ) : (
                    <PageReview page={data.page} members={boot.members} editable={editable} act={act} />
                  )}
                  {since?.pageId === data.page.id && since.value && (
                    <SinceVisitBanner
                      since={since.value}
                      onDismiss={() =>
                        setSince({ pageId: data.page.id, value: null })
                      }
                    />
                  )}
                  {/* A part that fails (offline, not in the copy) shows a
                      message instead of taking the app down (#47). */}
                  <ViewBoundary key={`view-${data.page.id}`}>
                  {data.page.kind === "database" ? (
                    <>
                      {offlineQueue.queue.some(
                        (c) => c.pageId === data.page.id,
                      ) && (
                        <p className="offline-pending" role="status">
                          {
                            offlineQueue.queue.filter(
                              (c) => c.pageId === data.page.id,
                            ).length
                          }{" "}
                          {t("Offline-Änderungen warten auf die Verbindung", "Offline changes are waiting for the connection")}
                          {offlineQueue.syncing
                            ? t(" · werden übertragen …", " · being sent …")
                            : "."}
                        </p>
                      )}
                      <DatabaseView
                        key={data.page.id}
                        routeNavigation
                        page={data.page}
                        userId={boot.user.id}
                        onRefresh={refresh}
                        data={{
                          ...data,
                          rows: applyQueue(
                            data.rows,
                            offlineQueue.queue,
                            data.page.id,
                          ),
                        }}
                        members={boot.members}
                        pages={activePages}
                        editable={editable}
                        ai={boot.ai}
                        favoriteRows={boot.favoriteRows}
                        mutate={mutate}
                        onError={notifyError}
                      />
                    </>
                  ) : data.locked ? (
                    <JournalLockScreen
                      journalId={data.locked.journalId}
                      onUnlocked={refresh}
                    />
                  ) : data.page.kind === "journal" && data.journal ? (
                    <JournalView
                      pageId={data.page.id}
                      days={data.journal.days}
                      settings={data.journal.settings}
                      editable={editable}
                      onOpen={(id) => void openPage(id)}
                      onRoll={rollJournal}
                      revealDays={revealJournalDays === data.page.id}
                      onRevealed={() => setRevealJournalDays(null)}
                      onChanged={refresh}
                      onError={notifyError}
                    />
                  ) : data.page.kind === "notebook" && data.notebook ? (
                    <NotebookView key={data.page.id} pageId={data.page.id} title={data.page.title} notebook={data.notebook} editable={editable && !data.page.locked} onError={(message) => notifyError(message)} />
                  ) : data.page.kind === "dashboard" && data.dashboard ? (
                    <DashboardView key={data.page.id} pageId={data.page.id} dashboard={data.dashboard} editable={editable} userId={boot.user.id} members={boot.members} pages={activePages} onRefresh={refresh} onError={notifyError} />
                  ) : data.page.kind === "whiteboard" && data.whiteboard ? (
                    <Whiteboard
                      key={`${data.page.id}-${data.whiteboard.generation}`}
                      pageId={data.page.id}
                      state={data.whiteboard.state}
                      generation={data.whiteboard.generation}
                      editable={editable}
                      pages={activePages.map((p) => ({
                        id: p.id,
                        title: p.title,
                        icon: p.icon,
                        kind: p.kind,
                      }))}
                      onReload={refresh}
                      onError={notifyError}
                      onOpenPage={(id) => void openPage(id)}
                      userId={boot.user.id}
                      userName={boot.user.name}
                      demo={!!boot.user.demo}
                    />
                  ) : (
                    <>
                    {data.journalDay && (
                      <JournalDayBar
                        key={data.page.id}
                        pageId={data.page.id}
                        ensure={data.draft ? () => ensureDraftDay(data) : undefined}
                        trackers={data.journalDay.trackers}
                        entry={data.journalDay.entry}
                        options={data.journalDay.options}
                        editable={editable}
                        onError={notifyError}
                      />
                    )}
                    {data.encrypted ? (
                      <EncryptedPage
                        key={data.page.id}
                        userId={boot.user.id}
                        page={data.page}
                        spaceId={data.encrypted.spaceId}
                        title={titledPages.find((p) => p.id === data.page.id)?.title ?? data.page.title}
                        editable={editable}
                        onStatus={setStatus}
                        onError={(message) => notifyError(new Error(message))}
                      />
                    ) : (
                    <DocumentEditor
                      key={`${data.page.id}-${data.generation}-${epoch}`}
                      draft={data.draft ? { ensure: () => ensureDraftDay(data) } : undefined}
                      generation={data.generation}
                      pageId={data.page.id}
                      userId={boot.user.id}
                      pages={activePages}
                      members={boot.members}
                      state={data.state}
                      html={data.html}
                      editable={editable}
                      onStatus={setStatus}
                      onError={notifyError}
                      onHtml={setHtml}
                      transcription={!!boot.instance?.transcription}
                      source={sourceOpen}
                      sourceNotice={
                        data.page.locked
                          ? t("Die Seite ist gesperrt. Zum Bearbeiten zuerst entsperren.", "The page is locked. Unlock it first to edit.")
                          : reading
                            ? t("Im Lesemodus lässt sich der Text nur ansehen.", "In reading mode the text can only be viewed.")
                            : undefined
                      }
                      onSourceClose={() => setSourcePage(null)}
                    />
                    )}
                    </>
                  )}
                  </ViewBoundary>
                  {!data.draft && (<>
                  <div className="backlinks">
                    {!data.locked && !data.encrypted && <RelatedPages key={`related-${data.page.id}`} pageId={data.page.id} />}
                    {!data.locked && !data.encrypted && (
                      <UnlinkedMentions
                        key={data.page.id}
                        pageId={data.page.id}
                        editable={editable}
                        onOpen={(id, rowId) => {
                          // Where the title is mentioned flashes on arrival.
                          jumpTo({ pageId: id, rowId }, byText(data.page.title));
                          if (rowId) location.hash = pageLocationHash({ pageId: id, rowId });
                          else void openPage(id);
                        }}
                        onLinked={() => void refresh()}
                        onError={notifyError}
                      />
                    )}
                    {data.backlinks?.length > 0 && (
                      <>
                        <h3>{t("Verlinkt von", "Linked from")}</h3>
                        {data.backlinks.map((p) => (
                          <button
                            key={`${p.id}-${p.rowId || ""}`}
                            onClick={() => {
                              // The block linking here flashes on arrival.
                              jumpTo(
                                { pageId: p.id, rowId: p.rowId },
                                anyOf(
                                  bySelector(`a[href*="page=${CSS.escape(data.page.id)}"]`),
                                  bySelector(`[data-link-card*="page=${CSS.escape(data.page.id)}"]`),
                                ),
                              );
                              if (p.rowId) location.hash = pageLocationHash({ pageId: p.id, rowId: p.rowId });
                              else void openPage(p.id);
                            }}
                          >
                            <PageIcon name={p.icon} />
                            {p.title}
                            {p.pageTitle && <small className="muted">{p.pageTitle}</small>}
                          </button>
                        ))}
                      </>
                    )}
                  </div>
                  <div className="subpages">
                    {activePages
                      // Journal days are listed by the journal itself.
                      .filter(
                        (p) => p.parent_id === data.page.id && !p.journal_date,
                      )
                      .map((p) => (
                        <button key={p.id} onClick={() => openPage(p.id)}>
                          <PageIcon name={p.icon} />
                          {p.title}
                          <ArrowUpRight />
                        </button>
                      ))}
                    {editable && (
                      <button
                        className="text-button"
                        onClick={() =>
                          addPage("document", data.page.id, data.page.space_id)
                        }
                      >
                        <Plus size={16} />
                        {t("Unterseite hinzufügen", "Add sub-page")}
                      </button>
                    )}
                  </div>
                  </>)}
                </article>
                {aiSummary?.pageId === data.page.id && !comments && (
                  <AiSummaryPanel target={aiSummary} onClose={() => setAiSummary(null)} />
                )}
                {comments && (
                  <aside className="comments-panel">
                    <header>
                      <h3>{t("Kommentare", "Comments")}</h3>
                      <button
                        className="icon-button"
                        aria-label={t("Kommentare schließen", "Close comments")}
                        onClick={() => setComments(false)}
                      >
                        <X />
                      </button>
                    </header>
                    <CommentHub
                      key={data.page.id}
                      pageId={data.page.id}
                      comments={data.comments}
                      textComments={data.page.kind === "document"}
                      canResolve={data.role !== "viewer"}
                      act={act}
                      time={(value) => relativeTime(value, clock, locale)}
                    />
                    <form
                      onSubmit={async (e) => {
                        e.preventDefault();
                        // The comment shows at once and the field empties; a
                        // refusal brings the text back into the field. A
                        // double submit of the same draft posts it once.
                        const body = comment;
                        const draft = `comment:${pageId}`;
                        setComment("");
                        const r = await act(keyed({ action: "comment.create", pageId, body }, draftKey(draft, body)));
                        if (r) draftSent(draft);
                        else setComment((now) => now || body);
                      }}
                    >
                      <textarea
                        required
                        value={comment}
                        onChange={(e) => setComment(e.target.value)}
                        onKeyDown={(e) => {
                          if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !e.nativeEvent.isComposing) {
                            e.preventDefault();
                            e.currentTarget.form?.requestSubmit();
                          }
                        }}
                        placeholder={t("Schreibe einen Kommentar …", "Write a comment …")}
                      />
                      <button className="button primary compact">
                        {t("Kommentieren", "Comment")}
                      </button>
                    </form>
                  </aside>
                )}
              </div>
            )
          )}
          {screen === "trash" && (
            <div className="utility-content">
              <div className="utility-title">
                <Trash size={30} />
                <h1>{t("Papierkorb", "Trash")}</h1>
                <p>{t("Gelöschte Seiten und Bereiche kannst du wiederherstellen.", "You can restore deleted pages and spaces.")}</p>
              </div>
              {(boot.trashedSpaces || []).map((space) => (
                <div className="utility-row trash-space" key={space.id}>
                  <SpaceIcon icon={space.icon} color={space.icon_color} />
                  <strong>
                    {space.name}
                    <small>{t("Bereich mit Seiten", "Space with pages")}</small>
                  </strong>
                  <div className="lifecycle-buttons">
                    <button
                      className="button compact"
                      onClick={() =>
                        act({
                          action: "space.restore",
                          spaceId: space.id,
                          version: space.version,
                        })
                      }
                    >
                      {t("Bereich wiederherstellen", "Restore space")}
                    </button>
                    <button
                      className="button danger compact"
                      onClick={() => setSpaceManager({ space, purge: true })}
                    >
                      {t("Endgültig löschen", "Delete permanently")}
                    </button>
                  </div>
                </div>
              ))}
              {boot.pages
                .filter((p) => p.deleted_at)
                .map((p) => (
                  <div className="utility-row" key={p.id}>
                    <PageIcon name={p.icon} />
                    <strong>{p.title}</strong>
                    <span>{relativeTime(p.deleted_at!, clock, locale)}</span>
                    <button
                      className="button compact"
                      onClick={() =>
                        act({ action: "page.restore", pageId: p.id })
                      }
                    >
                      <ArrowCounterClockwise />
                      {t("Wiederherstellen", "Restore")}
                    </button>
                  </div>
                ))}
              <RowTrash
                workspaceId={boot.workspace.id}
                act={act}
                onOpen={(pageId, rowId) =>
                  void openPage(pageId, { pageId, rowId })
                }
              />
              {!boot.pages.some((p) => p.deleted_at) &&
                !boot.trashedSpaces?.length && (
                  <div className="empty-state">
                    <Trash size={38} />
                    <h3>{t("Alles aufgeräumt", "All tidy")}</h3>
                    <p>{t("Dein Papierkorb ist leer.", "Your trash is empty.")}</p>
                  </div>
                )}
            </div>
          )}
          {screen === "media" && (
            <MediaLibrary
              workspaceId={boot.workspace.id}
              onOpen={(id) => void openPage(id)}
            />
          )}
          {screen === "graph" && (
            <PageGraph
              workspaceId={boot.workspace.id}
              currentId={pageId}
              onOpen={(id, rowId) => (rowId ? (location.hash = pageLocationHash({ pageId: id, rowId })) : void openPage(id))}
              onError={notifyError}
            />
          )}
          {screen === "tasks" && (
            <MyTasks
              workspaceId={boot.workspace.id}
              onOpen={(pageId, rowId) => {
                location.hash = rowId ? `page=${pageId}&row=${rowId}` : `page=${pageId}`;
              }}
              onError={notifyError}
              onChanged={() => void refresh()}
            />
          )}
          {screen === "inbox" && (
            <div className="utility-content">
              <div className="utility-title">
                <Bell size={30} />
                <h1>{t("Posteingang", "Inbox")}</h1>
                <p>{t("Neuigkeiten aus deinem Arbeitsbereich.", "News from your workspace.")}</p>
              </div>
              <div className="inbox-toolbar">
                <div role="radiogroup" aria-label={t("Benachrichtigungen filtern", "Filter notifications")}>
                  {(
                    [
                      ["all", t("Alle", "All")],
                      ["unread", t("Ungelesen", "Unread")],
                    ] as const
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      role="radio"
                      aria-checked={inboxFilter === id}
                      className={`chip${inboxFilter === id ? " active" : ""}`}
                      onClick={() => setInboxFilter(id)}
                    >
                      {label}
                      {id === "unread" &&
                        ` (${boot.notifications.filter((n) => !n.read_at).length})`}
                    </button>
                  ))}
                </div>
                {/* Only while there is something to mark. */}
                {boot.notifications.some((n) => !n.read_at) && (
                  <button
                    className="button compact"
                    onClick={() => void act({ action: "notification.read" })}
                  >
                    {t("Alle als gelesen markieren", "Mark all as read")}
                  </button>
                )}
              </div>
              {boot.notifications
                .filter((n) => inboxFilter === "all" || !n.read_at)
                .map((n) => (
                  <div
                    className={`notification-item${n.read_at ? "" : " unread"}`}
                    key={n.id}
                  >
                    <button
                      className="notification-row"
                      onClick={() => {
                        if (!n.read_at)
                          void act({
                            action: "notification.mark",
                            notificationId: n.id,
                            read: true,
                          });
                        const target = parsePageLocation(
                          notificationUrl(n).slice(1),
                        );
                        if (!target) return;
                        // The commented passage or the mention flashes.
                        jumpTo(
                          target,
                          target.threadId
                            ? bySelector(`[data-comment-thread="${CSS.escape(target.threadId)}"]`)
                            : bySelector(`[data-mention="${CSS.escape(boot.user.id)}"]`),
                        );
                        void openPage(target.pageId, target);
                      }}
                    >
                      <ChatCircle size={22} />
                      <span>
                        {!n.read_at && (
                          <span className="unread-dot" aria-label={t("Ungelesen", "Unread")} />
                        )}
                        {serverMessage(n.body)}
                        <small>{relativeTime(n.created_at, clock, locale)}</small>
                      </span>
                      <ArrowUpRight />
                    </button>
                    <div className="notification-actions">
                      <button
                        className="text-button"
                        onClick={() =>
                          void act({
                            action: "notification.mark",
                            notificationId: n.id,
                            read: !n.read_at,
                          })
                        }
                      >
                        {n.read_at
                          ? t("Als ungelesen markieren", "Mark as unread")
                          : t("Als gelesen markieren", "Mark as read")}
                      </button>
                      <button
                        className="text-button"
                        aria-label={t(`Benachrichtigung entfernen: ${n.body}`, `Remove notification: ${serverMessage(n.body)}`)}
                        onClick={() =>
                          void act({
                            action: "notification.delete",
                            notificationId: n.id,
                          })
                        }
                      >
                        {t("Entfernen", "Remove")}
                      </button>
                    </div>
                  </div>
                ))}
              {inboxFilter === "unread" &&
                !!boot.notifications.length &&
                !boot.notifications.some((n) => !n.read_at) && (
                  <p className="muted">{t("Keine ungelesenen Benachrichtigungen.", "No unread notifications.")}</p>
                )}
              {!boot.notifications.length && (
                <div className="empty-state">
                  <Bell size={38} />
                  <h3>{t("Du bist auf dem Laufenden", "You are all caught up")}</h3>
                  <p>{t("Neue Kommentare erscheinen hier.", "New comments appear here.")}</p>
                </div>
              )}
            </div>
          )}
          {screen === "settings" && (
            <Settings
              key={boot.workspace.id}
              onWorkspaceExit={(id) => {
                if (id) return switchWorkspace(id);
                window.location.assign("/");
              }}
              onRefresh={refresh}
              boot={boot}
              mutate={mutate}
              onError={notifyError}
              theme={theme}
              setTheme={chooseTheme}
            />
          )}
          {screen === "admin" && boot.user.isAdmin && (
            <Admin mutate={mutate} onError={notifyError} />
          )}
        </div>
          </div>
          {splitShown && split && (
            <>
              <SplitDivider value={splitRatio} onChange={setSplitRatio} container={() => splitRow.current} />
              <SplitPane
                key={split}
                pageId={split}
                userId={boot.user.id}
                userName={boot.user.name}
                demo={!!boot.user.demo}
                pages={activePages}
                members={boot.members}
                ai={boot.ai}
                transcription={!!boot.instance?.transcription}
                onClose={() => setSplit(null)}
                onOpenMain={(id) => void openPage(id)}
                onOpenPage={(id) => void openPage(id)}
              />
            </>
          )}
          {pageDrag && wide && (
            <div
              className={`split-dropzone${splitDropOver ? " over" : ""}`}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes("application/x-flowplan-page")) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "copy";
                setSplitDropOver(true);
              }}
              onDragLeave={() => setSplitDropOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                const id = e.dataTransfer.getData("application/x-flowplan-page");
                setSplitDropOver(false);
                setPageDrag(false);
                if (id) openSplit(id);
              }}
            >
              <SquareSplitHorizontal size={24} aria-hidden="true" />
              <span>{t("Hier ablegen, um die Seite daneben zu öffnen", "Drop here to open the page beside it")}</span>
            </div>
          )}
        </div>
      </main>
      <AppPromo paused={onboarding} />
      {onboarding && (
        <Onboarding
          boot={boot}
          theme={theme}
          chooseTheme={chooseTheme}
          mutate={(b) => mutate({ workspaceId: boot.workspace.id, ...b })}
          onOpenPage={(pageId) => void openPage(pageId)}
          onClose={() => setOnboarding(false)}
        />
      )}
      <FindInPage open={find.open} focusKey={find.key} onClose={() => setFind((f) => ({ ...f, open: false }))} />
      <KeyboardShortcuts
        open={shortcuts}
        onClose={() => setShortcuts(false)}
        ai={!!boot.ai?.features.write.ok}
        overrides={boot.shortcuts || {}}
        onSave={async (bindings: KeymapOverrides) => {
          const result = await api<{ bindings: KeymapOverrides }>("/api/command", { action: "shortcuts.save", bindings });
          setBoot((b) => ({ ...b, shortcuts: result.bindings }));
          setKeymapOverrides(result.bindings);
        }}
      />
      {spaceExport && (
        <SpaceExportDialog spaces={boot.spaces} initial={spaceExport} onClose={() => setSpaceExport(null)} />
      )}
      {spaceManager && (
        <SpaceManager
          space={spaceManager.space}
          purge={spaceManager.purge}
          counts={boot.pageCounts?.spaces[spaceManager.space.id] || (boot.pageCounts ? { pages: 0, days: 0 } : undefined)}
          onClose={() => setSpaceManager(null)}
          onDone={refresh}
        />
      )}
      <Modal
        open={bulkDialog === "move"}
        onClose={() => setBulkDialog(null)}
        title={t("Seiten verschieben", "Move pages")}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (bulkTarget) void bulkPages("move", bulkTarget);
          }}
        >
          <label>
            {t("Ziel", "Destination")}
            <Select
              aria-label={t("Ziel", "Destination")}
              value={bulkTarget}
              onChange={(e) => setBulkTarget(e.target.value)}
            >
              <option value="">{t("Ziel wählen …", "Choose destination …")}</option>
              {boot.spaces.map((sp) => (
                <optgroup key={sp.id} label={sp.name}>
                  <option value={`space:${sp.id}`}>
                    {sp.name} (oberste Ebene)
                  </option>
                  {/* Built only while the dialog is open: thousands of
                      journal days would cost every render (#49). Days are
                      no destinations (as in the move dialog). */}
                  {bulkDialog === "move" && flatPages(null, sp.id)
                    .filter(
                      ({ page }) =>
                        !page.journal_date &&
                        !selectedPages.some(
                          (sel) =>
                            sel === page.id ||
                            ancestorsOf(page.id).includes(sel),
                        ),
                    )
                    .map(({ page, level }) => (
                      <option key={page.id} value={`page:${page.id}`}>
                        {"\u00a0\u00a0".repeat(level + 1)}
                        {page.title}
                      </option>
                    ))}
                </optgroup>
              ))}
            </Select>
          </label>
          <p className="muted">
            {selectedPages.length} {t("Seiten mit ihren Unterseiten verschieben.", "Move pages with their sub-pages.")}
          </p>
          <div className="modal-actions">
            <button
              type="button"
              className="button"
              onClick={() => setBulkDialog(null)}
            >
              {t("Abbrechen", "Cancel")}
            </button>
            <button
              className="button primary"
              disabled={!bulkTarget || bulkBusy}
            >
              {t("Verschieben", "Move")}
            </button>
          </div>
        </form>
      </Modal>
      <Modal
        open={bulkDialog === "delete"}
        onClose={() => setBulkDialog(null)}
        title={t("Seiten in den Papierkorb", "Move pages to trash")}
      >
        <p>
          {selectedPages.length} {t("Seiten samt Unterseiten in den Papierkorb verschieben? Freigaben und Veröffentlichungen werden beendet.", "Move the pages and their sub-pages to the trash? Shares and publications end.")}
        </p>
        <div className="modal-actions">
          <button className="button" onClick={() => setBulkDialog(null)}>
            {t("Abbrechen", "Cancel")}
          </button>
          <button
            className="button danger"
            disabled={bulkBusy}
            onClick={() => void bulkPages("delete")}
          >
            {t("In den Papierkorb", "Move to trash")}
          </button>
        </div>
      </Modal>
      <Modal
        open={search}
        onClose={closeSearch}
        title={t("Schnellsuche", "Quick search")}
        className="command-palette"
        onCloseAutoFocus={(e) => {
          // Back to where the search was opened from, not to <body>.
          e.preventDefault();
          const opener = searchOpener.current;
          if (opener && document.contains(opener)) opener.focus();
        }}
      >
        <div className="command-search">
          <MagnifyingGlass size={22} />
          <input
            autoFocus
            role="combobox"
            aria-label={t("Suchen oder Befehl", "Search or command")}
            aria-expanded="true"
            aria-controls="palette-list"
            aria-autocomplete="list"
            aria-activedescendant={activeItem ? `palette-${activeItem.id}` : undefined}
            placeholder={
              paletteSplit
                ? t("Seite für die geteilte Ansicht suchen …", "Find a page for the split view …")
                : t("Suchen … oder > für Befehle", "Search … or > for commands")
            }
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              // The arrows move over the rows while the focus stays here;
              // Tab reaches the filters as before.
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const count = paletteItems.length;
                if (count) setPaletteActive((activeIndex + (e.key === "ArrowDown" ? 1 : count - 1)) % count);
              } else if (e.key === "Enter") {
                e.preventDefault();
                if (activeItem) runItem(activeItem);
              }
            }}
          />
          <kbd>esc</kbd>
        </div>
        {paletteSplit && (
          <p className="palette-split-hint" role="note">
            <SquareSplitHorizontal size={15} aria-hidden="true" />
            {t("Die gewählte Seite öffnet sich in der geteilten Ansicht rechts.", "The chosen page opens in the split view on the right.")}
          </p>
        )}
        <div className="search-filters">
          <div role="radiogroup" aria-label={t("Suchergebnisse filtern", "Filter search results")}>
            {(
              [
                ["all", t("Alles", "Everything")],
                ["document", t("Dokumente", "Documents")],
                ["database", t("Datenbanken", "Databases")],
                ["whiteboard", t("Whiteboards", "Whiteboards")],
                ["row", t("Einträge", "Records")],
                ["comment", t("Kommentare", "Comments")],
                ["file", t("Dateien", "Files")],
              ] as const
            ).map(([kind, label]) => (
              <button
                key={kind}
                role="radio"
                aria-checked={searchKind === kind}
                className={`chip${searchKind === kind ? " active" : ""}`}
                onClick={() => setSearchKind(kind)}
              >
                {label}
              </button>
            ))}
          </div>
          {boot.pages.some((p) => p.kind === "journal" && !p.deleted_at) && (
            <button
              type="button"
              className={`chip${searchNoDays ? " active" : ""}`}
              aria-pressed={searchNoDays}
              onClick={toggleSearchNoDays}
            >
              <CalendarX size={13} /> {t("Ohne Journaltage", "Without journal days")}
            </button>
          )}
          <Select
            aria-label={t("Bereich", "Space")}
            value={searchSpace}
            onChange={(e) => setSearchSpace(e.target.value)}
          >
            <option value="">{t("Alle Bereiche", "All spaces")}</option>
            {boot.spaces.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
          {canAsk && query.trim() && !query.startsWith(">") && (
            <button
              className="button compact"
              onClick={() => {
                setAsk({ question: query.trim() });
                setSearch(false);
                setQuery("");
              }}
            >
              <Sparkle size={15} /> {t("KI fragen", "Ask AI")}
            </button>
          )}
          {query.trim() && searchName === null && (
            <button
              className="button compact"
              onClick={() => setSearchName(query.trim().slice(0, 120))}
            >
              <BookmarkSimple size={15} /> {t("Suche speichern", "Save search")}
            </button>
          )}
        </div>
        {searchName !== null && (
          <form
            className="saved-search-form"
            onSubmit={async (e) => {
              e.preventDefault();
              const saved = await act({
                action: "search.save",
                workspaceId: boot.workspace.id,
                name: searchName,
                query,
                kind: searchKind,
                spaceId: searchSpace || null,
              });
              if (saved) setSearchName(null);
            }}
          >
            <input
              aria-label={t("Name der gespeicherten Suche", "Name of the saved search")}
              value={searchName}
              maxLength={120}
              autoFocus
              onChange={(e) => setSearchName(e.target.value)}
            />
            <button
              className="button compact primary"
              disabled={!searchName.trim()}
            >
              {t("Speichern", "Save")}
            </button>
            <button
              type="button"
              className="button compact"
              onClick={() => setSearchName(null)}
            >
              {t("Abbrechen", "Cancel")}
            </button>
          </form>
        )}
        {!!boot.savedSearches?.length && (
          <div
            className="saved-searches"
            role="list"
            aria-label={t("Gespeicherte Suchen", "Saved searches")}
          >
            {boot.savedSearches.map((s) => (
              <span className="chip saved-search" role="listitem" key={s.id}>
                <button
                  onClick={() => {
                    setQuery(s.query);
                    setSearchKind(s.kind);
                    setSearchSpace(
                      s.spaceId && boot.spaces.some((x) => x.id === s.spaceId)
                        ? s.spaceId
                        : "",
                    );
                  }}
                >
                  <BookmarkSimple size={13} /> {s.name}
                </button>
                <button
                  aria-label={t(`Gespeicherte Suche ${s.name} löschen`, `Delete saved search ${s.name}`)}
                  onClick={() =>
                    void act({ action: "search.delete", searchId: s.id })
                  }
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
        {/* One list for hits, recent pages and commands: the input keeps the
            focus and names the highlighted row (aria-activedescendant). */}
        <div
          className="palette-list"
          id="palette-list"
          role="listbox"
          aria-label={t("Ergebnisse und Befehle", "Results and commands")}
        >
          {recentPages.length > 0 && (
            <div className="search-results palette-group" role="group" aria-labelledby="palette-recent-title">
              <small className="palette-group-title" id="palette-recent-title">
                {t("Zuletzt angesehen", "Recently viewed")}
              </small>
              {recentPages.map((page, i) =>
                paletteOption(
                  paletteItems[i],
                  i,
                  <>
                    <PageIcon name={page.kind === "database" ? "table" : page.icon} />
                    <span>
                      {page.title || t("Ohne Titel", "Untitled")}
                      <small>{boot.spaces.find((s) => s.id === page.space_id)?.name}</small>
                    </span>
                  </>,
                ),
              )}
            </div>
          )}
          {paletteResults.length > 0 && (
            <div className="search-results palette-group" role="group" aria-label={t("Treffer", "Hits")}>
              {paletteResults.map((p, i) =>
                paletteOption(
                  paletteItems[recentPages.length + i],
                  recentPages.length + i,
                  <>
                    <PageIcon name={p.icon} />
                    <span>
                      {p.kind === "comment" ? commentHitTitle(p.title, t) : p.title}
                      {p.alias && <span className="alias-hit"> · {p.alias}</span>}
                      {p.pageTitle && (
                        <small className="search-context">
                          {p.kind === "comment"
                            ? t(`Kommentar in ${p.pageTitle}`, `Comment in ${p.pageTitle}`)
                            : p.kind === "file"
                              ? t(`Datei in ${p.pageTitle}`, `File in ${p.pageTitle}`)
                              : t(`Eintrag in ${p.pageTitle}`, `Record in ${p.pageTitle}`)}
                        </small>
                      )}
                      <small className={p.snippet ? "search-snippet" : undefined}>
                        {p.snippet ? (
                          <SearchSnippet text={p.snippet} />
                        ) : (
                          boot.spaces.find((s) => s.id === p.space_id)?.name
                        )}
                      </small>
                    </span>
                    <ArrowSquareOut size={17} />
                  </>,
                ),
              )}
            </div>
          )}
          {shownActions.length > 0 && (
            <div className="command-actions palette-group" role="group" aria-labelledby="palette-actions-title">
              <small className="palette-group-title" id="palette-actions-title">
                {t("Aktionen", "Actions")}
              </small>
              {shownActions.map((action, i) =>
                paletteOption(
                  paletteItems[recentPages.length + paletteResults.length + i],
                  recentPages.length + paletteResults.length + i,
                  <>
                    <action.icon size={17} />
                    <span>{action.label}</span>
                  </>,
                ),
              )}
            </div>
          )}
          {searching && !paletteResults.length && !commandsOnly && (
            <ListSkeleton rows={4} label={t("Suche läuft …", "Searching …")} />
          )}
          {!paletteItems.length && !searching && (
            <div className="empty-state small">
              {query.trim()
                ? t("Nichts gefunden.", "Nothing found.")
                : t("Suche nach Seiten, Einträgen, Kommentaren und Dateien – oder tippe > für Befehle.", "Search for pages, records, comments and files – or type > for commands.")}
            </div>
          )}
        </div>
      </Modal>
      {canAsk && (
        <AskPanel
          open={!!ask}
          onClose={() => setAsk(null)}
          workspaceId={boot.workspace.id}
          ai={boot.ai}
          spaces={boot.spaces}
          currentPage={screen === "page" && data ? { id: data.page.id, title: data.page.title || t("Ohne Titel", "Untitled") } : null}
          initialQuestion={ask?.question}
          onOpenSource={(pid, rowId) => {
            setAsk(null);
            void openPage(pid, rowId ? { pageId: pid, rowId } : undefined);
          }}
        />
      )}
      <Modal open={create} sheet onClose={() => setCreate(false)} title={t("Neue Seite", "New page")}>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            // A failure shows inside this dialog, with "Retry" submitting again.
            const form = e.currentTarget;
            // Encrypted titles: the page starts with the placeholder, then
            // gets its title encrypted in the browser.
            const titleEncrypted = !!(boot.spaces.find((s) => s.id === spaceId) as { encrypt_titles?: number } | undefined)?.encrypt_titles;
            if (titleEncrypted && !e2eeState.unlocked) return setE2eeDialog("unlock");
            const result = await act({
              action: "page.create",
              workspaceId: boot.workspace.id,
              spaceId,
              parentId: parent,
              title: titleEncrypted ? ENCRYPTED_TITLE : newTitle || t("Ohne Titel", "Untitled"),
              kind: newKind,
              starterTemplate,
              ...(newKind === "database" && !starterTemplate
                ? aiCreate && aiProposal
                  ? { aiDatabase: proposalPayload(aiProposal) }
                  : databaseChoicePayload(databaseChoice)
                : {}),
            }, () => form.requestSubmit());
            if (result?.id && titleEncrypted && newTitle.trim())
              try {
                await openSpace(spaceId);
                await act({ action: "e2ee.title", pageId: String(result.id), cipher: await encryptTitle(spaceId, String(result.id), newTitle.trim()) });
              } catch (error) {
                notifyError(error);
              }
            if (result?.id) {
              if (newKind === "notebook" && notebookPdf) queueNotebookImport(String(result.id), notebookPdf);
              setNotebookPdf(null);
              if (newKind === "database" && !starterTemplate && !aiCreate) rememberDatabaseKind(databaseChoice);
              setCreate(false);
              setAiCreate(false);
              setAiProposal(null);
              focusTitleOf.current = String(result.id);
              void openPage(String(result.id));
            }
          }}
        >
          <label>
            {t("Name", "Name")}
            <input
              autoFocus
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder={t("Wie heißt deine Seite?", "What is your page called?")}
            />
          </label>
          <DuplicateHint workspaceId={boot.workspace.id} title={newTitle} onOpen={(id, rowId) => { setCreate(false); void openPage(id, rowId ? { pageId: id, rowId } : undefined); }} />
          <div className="type-picker">
            <button
              type="button"
              className={newKind === "document" ? "chosen" : ""}
              onClick={() => {
                setNewKind("document");
                setStarterTemplate(null);
              }}
            >
              <FileText size={26} />
              <strong>{t("Dokument", "Document")}</strong>
              <small>{t("Notizen, Wissen und Ideen", "Notes, knowledge and ideas")}</small>
            </button>
            <button
              type="button"
              className={newKind === "database" ? "chosen" : ""}
              onClick={() => {
                if (newKind !== "database") setDatabaseChoice(rememberedDatabaseKind());
                setNewKind("database");
                setStarterTemplate(null);
              }}
            >
              <Table size={26} />
              <strong>{t("Datenbank", "Database")}</strong>
              <small>{t("Aufgaben und strukturierte Daten", "Tasks and structured data")}</small>
            </button>
            <button
              type="button"
              className={newKind === "whiteboard" ? "chosen" : ""}
              onClick={() => {
                setNewKind("whiteboard");
                setStarterTemplate(null);
              }}
            >
              <PresentationChart size={26} />
              <strong>{t("Whiteboard", "Whiteboard")}</strong>
              <small>{t("Ideen, Diagramme und Workshops", "Ideas, diagrams and workshops")}</small>
            </button>
            <button
              type="button"
              className={newKind === "journal" ? "chosen" : ""}
              onClick={() => {
                setNewKind("journal");
                setStarterTemplate(null);
              }}
            >
              <Notebook size={26} />
              <strong>{t("Journal", "Journal")}</strong>
              <small>{t("Jeden Tag eine Seite, offene Aufgaben wandern mit", "A page every day, open tasks move along")}</small>
            </button>
            <button type="button" className={newKind === "dashboard" ? "chosen" : ""} onClick={() => { setNewKind("dashboard"); setStarterTemplate(null); }}>
              <Gauge size={26} />
              <strong>{t("Dashboard", "Dashboard")}</strong>
              <small>{t("Kennzahlen, Diagramme und Aufgaben auf einen Blick", "Metrics, charts and tasks at a glance")}</small>
            </button>
            <button type="button" className={newKind === "notebook" ? "chosen" : ""} onClick={() => { setNewKind("notebook"); setStarterTemplate(null); }}>
              <NotePencil size={26} />
              <strong>{t("Notizbuch", "Notebook")}</strong>
              <small>{t("Handschrift auf Papier oder PDFs, mit Stift", "Handwriting on paper or PDFs, with a pen")}</small>
            </button>
          </div>
          {newKind === "notebook" && (
            <label className="new-notebook-pdf">
              {t("PDF als Notizbuch öffnen (optional)", "Open a PDF as the notebook (optional)")}
              <input type="file" accept="application/pdf,.pdf" onChange={(e) => {
                const file = e.target.files?.[0] || null;
                setNotebookPdf(file);
                if (file && !newTitle) setNewTitle(file.name.replace(/\.pdf$/i, ""));
              }} />
            </label>
          )}
          {newKind === "database" && !starterTemplate && aiUsable(boot.ai, "database") && (
            <div className="ai-create-switch" role="radiogroup" aria-label={t("Wie anlegen?", "How to create?")}>
              <button type="button" role="radio" aria-checked={!aiCreate} className={`chip${!aiCreate ? " active" : ""}`} onClick={() => setAiCreate(false)}>
                {t("Vorlage wählen", "Choose a template")}
              </button>
              <button type="button" role="radio" aria-checked={aiCreate} className={`chip${aiCreate ? " active" : ""}`} onClick={() => setAiCreate(true)}>
                <Sparkle size={13} /> {t("Mit KI erstellen", "Create with AI")}
              </button>
            </div>
          )}
          {newKind === "database" && !starterTemplate && aiCreate && aiUsable(boot.ai, "database") && (
            <AiDatabaseCreator
              workspaceId={boot.workspace.id}
              ai={boot.ai}
              proposal={aiProposal}
              onProposal={setAiProposal}
              onTitle={(title) => {
                if (!newTitle) setNewTitle(title);
              }}
              onError={notifyError}
            />
          )}
          {newKind === "database" && !starterTemplate && !(aiCreate && aiUsable(boot.ai, "database")) && (
            <DatabaseKindPicker
              workspaceId={boot.workspace.id}
              value={databaseChoice}
              onChange={(choice, template) => {
                setDatabaseChoice(choice);
                if (template && !newTitle) setNewTitle(template.name);
              }}
            />
          )}
          <label>
            {t("Bereich", "Space")}
            <Select
              value={spaceId}
              onChange={(e) => {
                setSpaceId(e.target.value);
                setParent(null);
              }}
            >
              {boot.spaces.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </label>
          <div className="modal-actions">
            <button
              type="button"
              className="button"
              onClick={() => setCreate(false)}
            >
              {t("Abbrechen", "Cancel")}
            </button>
            <button
              className="button primary"
              disabled={newKind === "database" && !starterTemplate && aiCreate && aiUsable(boot.ai, "database") && (!aiProposal || aiProposal.fields.some((f) => !f.name.trim()))}
            >
              {t("Seite erstellen", "Create page")}
            </button>
          </div>
        </form>
      </Modal>
      {toRecord && pageId && (
        <PageToRecord
          pageId={pageId}
          onClose={() => setToRecord(false)}
          onError={notifyError}
          onMoved={(db, rowId) => {
            setToRecord(false);
            notify(t("Als Eintrag in die Datenbank verschoben.", "Moved into the database as a record."));
            void refresh().catch(() => {});
            location.hash = pageLocationHash({ pageId: db, rowId });
          }}
        />
      )}
      {capture && (
        <QuickCapture
          workspaceId={boot.workspace.id}
          onClose={() => setCapture(false)}
          mutate={mutate}
          notify={notify}
          onSaved={(pid, rowId, offline) => {
            setCapture(false);
            if (offline) notify(t("Gespeichert auf diesem Gerät – wird erfasst, sobald die Verbindung zurück ist.", "Saved on this device – captured once the connection is back."));
            else {
              notify(t("Erfasst.", "Captured."));
              if (pageId === pid) void refresh().catch(() => {});
            }
            void rowId;
          }}
        />
      )}
      <OfflineConflicts
        conflicts={offlineQueue.conflicts}
        fields={(pid) =>
          data?.page.id === pid ? data.database?.fields || [] : []
        }
        resolve={offlineQueue.resolve}
      />
      <Modal open={share} sheet onClose={() => setShare(false)} title={t("Seite teilen", "Share page")}>
        {data && (
          <>
            <PagePeople
              pageId={data.page.id}
              workspaceId={boot.workspace.id}
              members={boot.members.filter((m) => m.id !== boot.user.id)}
              onChanged={() => void refresh().catch(() => {})}
              onError={notifyError}
            />
            <AiBlockToggle targetId={data.page.id} kind="page" onError={notifyError} />
            {data.role !== "viewer" && (
              <ShareLinks
                pageId={data.page.id}
                links={data.shareLinks || []}
                act={act}
              />
            )}
            <div className="settings-section">
              <h3>
                <Globe size={18} />
                {t("Im Web veröffentlichen", "Publish on the web")}
              </h3>
              <p>{t("Jeder mit dem Link kann den Inhalt dieser Seite lesen.", "Anyone with the link can read this page's content.")}</p>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  disabled={!editable}
                  checked={!!data.page.public_token}
                  onChange={(e) =>
                    act({
                      action: "page.publish",
                      pageId,
                      enabled: e.target.checked,
                    })
                  }
                />
                {t("Öffentlichen Link aktivieren", "Enable public link")}
              </label>
              {data.page.public_token && (
                <div className="publication-options">
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      disabled={!editable}
                      checked={!!data.publication?.includeChildren}
                      onChange={(e) =>
                        act({
                          action: "page.publish",
                          pageId,
                          enabled: true,
                          includeChildren: e.target.checked,
                          allowCopy: data.publication?.allowCopy !== false,
                        })
                      }
                    />
                    {t("Aktuell vorhandene Unterseiten mit veröffentlichen", "Also publish the current sub-pages")}
                  </label>
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      disabled={!editable}
                      checked={data.publication?.allowCopy !== false}
                      onChange={(e) =>
                        act({
                          action: "page.publish",
                          pageId,
                          enabled: true,
                          includeChildren: !!data.publication?.includeChildren,
                          allowCopy: e.target.checked,
                        })
                      }
                    />
                    {t("Besucher dürfen eine Kopie in ihren Arbeitsbereich übernehmen", "Visitors may copy it into their workspace")}
                  </label>
                  <ProtectionChips password={!!data.publication?.password} expiresAt={data.publication?.expiresAt ?? null} />
                  {editable && (
                    <LinkProtection
                      label={t("öffentlichen Link", "public link")}
                      password={!!data.publication?.password}
                      expiresAt={data.publication?.expiresAt ?? null}
                      onSave={(patch) => act({ action: "publication.protect", pageId, ...patch })}
                    />
                  )}
                  {data.publication?.password && (
                    <p className="muted">{t("Mit Passwort kann die Veröffentlichung nicht kopiert werden.", "With a password the publication cannot be copied.")}</p>
                  )}
                  <p className="muted">
                    {t("Veröffentlichte Seiten:", "Published pages:")}{" "}{data.publication?.count || 1}{t(". Dokumente, Datensatzinhalte und darin verlinkte Uploads sind öffentlich. Kommentare und Mitgliederangaben bleiben privat.", ". Documents, record contents and uploads linked in them are public. Comments and member details stay private.")}
                  </p>
                  {data.publication?.includeChildren && editable && (
                    <button
                      className="button"
                      onClick={() =>
                        act({
                          action: "page.publish",
                          pageId,
                          enabled: true,
                          includeChildren: true,
                          allowCopy: data.publication?.allowCopy !== false,
                        })
                      }
                    >
                      {t("Auswahl um neue Unterseiten ergänzen", "Add new sub-pages to the selection")}
                    </button>
                  )}
                  <PublicationDomain
                    pageId={data.page.id}
                    editable={editable}
                    password={!!data.publication?.password}
                    onError={notifyError}
                  />
                </div>
              )}
              {data.page.public_token && (
                <div className="copy-link">
                  <input
                    readOnly
                    value={`${location.origin}/share/${data.page.public_token}`}
                  />
                  <button
                    className="button"
                    onClick={() => {
                      void navigator.clipboard.writeText(
                        `${location.origin}/share/${data.page.public_token}`,
                      );
                      notify(t("Link kopiert", "Link copied"));
                    }}
                  >
                    <Copy />
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      </Modal>
      <Modal
        open={history}
        onClose={() => setHistory(false)}
        title={t("Versionsverlauf", "Version history")}
      >
        {data && (
          <>
            <button
              className="button primary"
              onClick={() => act({ action: "page.snapshot", pageId })}
            >
              <Plus />
              {t("Aktuelle Version sichern", "Save current version")}
            </button>
            <div className="history-list">
              {data.snapshots.map((s) => (
                <div className="utility-row" key={s.id}>
                  <Clock />
                  <span>
                    <strong>{s.title}</strong>
                    <small>
                      {new Date(s.created_at + "Z").toLocaleString(LOCALE_TAG)}
                      {" · "}
                      {s.kind === "manual"
                        ? t("Manuell gesichert", "Saved manually")
                        : t("Automatisch", "Automatic")}
                    </small>
                  </span>
                  <button
                    className="button compact"
                    onClick={() => {
                      // Replace the history dialog; closing returns to it.
                      setHistory(false);
                      setVersionChanges({
                        id: s.id,
                        label: new Date(s.created_at + "Z").toLocaleString(
                          LOCALE_TAG,
                        ),
                      });
                    }}
                  >
                    {t("Änderungen", "Changes")}
                  </button>
                  <button
                    className="button compact"
                    disabled={!editable}
                    onClick={async () => {
                      const r = await act({
                        action: "snapshot.restore",
                        pageId,
                        snapshotId: s.id,
                      });
                      if (r) {
                        setEpoch((x) => x + 1);
                        setHistory(false);
                        notify(t("Version wiederhergestellt", "Version restored"));
                      }
                    }}
                  >
                    {t("Wiederherstellen", "Restore")}
                  </button>
                </div>
              ))}
              {!data.snapshots.length && (
                <p className="muted">{t("Noch keine gesicherten Versionen.", "No saved versions yet.")}</p>
              )}
            </div>
          </>
        )}
      </Modal>
      <LinkPreview members={boot.members} />
      {versionChanges && data && (
        <VersionChanges
          pageId={data.page.id}
          editable={editable && data.page.kind === "document"}
          snapshotId={versionChanges.id}
          label={versionChanges.label}
          versions={data.snapshots.map((s) => ({
            id: s.id,
            label: new Date(s.created_at + "Z").toLocaleString(LOCALE_TAG),
          }))}
          onClose={() => {
            setVersionChanges(null);
            setHistory(true);
          }}
        />
      )}
      <Modal
        open={iconPicker}
        sheet
        onClose={() => setIconPicker(false)}
        title={t("Seiten-Icon", "Page icon")}
      >
        {iconPicker && data && (
          <>
            <div
              className="icon-tabs"
              role="tablist"
              aria-label={t("Art des Seitensymbols", "Kind of page icon")}
            >
              {(
                [
                  ["emoji", t("Emoji", "Emoji")],
                  ["image", t("Bild", "Image")],
                  ["library", t("Symbole", "Icons")],
                ] as const
              ).map(([tab, label]) => (
                <button
                  key={tab}
                  role="tab"
                  aria-selected={iconTab === tab}
                  className={`chip${iconTab === tab ? " active" : ""}`}
                  onClick={() => setIconTab(tab)}
                >
                  {label}
                </button>
              ))}
            </div>
            <label className="icon-size">
              {t("Größe", "Size")}
              <Select
                aria-label={t("Symbolgröße", "Icon size")}
                value={data.page.icon_size || ""}
                onChange={(e) =>
                  void act({
                    action: "page.update",
                    pageId: data.page.id,
                    patch: { icon_size: e.target.value },
                  })
                }
              >
                <option value="">{t("Standard", "Default")}</option>
                <option value="small">{t("Klein", "Small")}</option>
                <option value="large">{t("Groß", "Large")}</option>
              </Select>
            </label>
            {iconTab === "library" ? (
              <IconLibraryPicker
                current={data.page.icon}
                onSelect={async (icon) => {
                  const result = await act({
                    action: "page.update",
                    pageId: data.page.id,
                    patch: { icon },
                  });
                  if (result) setIconPicker(false);
                }}
              />
            ) : iconTab === "emoji" ? (
              <EmojiPicker
                selected={data.page.icon}
                onSelect={async (icon) => {
                  const result = await act({
                    action: "page.update",
                    pageId,
                    patch: { icon },
                  });
                  if (result) setIconPicker(false);
                }}
              />
            ) : (
              <IconImagePicker
                pageId={data.page.id}
                current={data.page.icon}
                images={data.images || []}
                onSelect={async (icon) => {
                  const result = await act({
                    action: "page.update",
                    pageId: data.page.id,
                    patch: { icon },
                  });
                  if (result) setIconPicker(false);
                }}
              />
            )}
          </>
        )}
      </Modal>
      {coverPicker && data && (
        <CoverPicker
          key={data.page.id}
          page={data.page}
          images={data.images || []}
          onClose={() => setCoverPicker(false)}
          onSave={async (appearance, base) =>
            !!(await mutate({
              action: "page.update",
              pageId: data.page.id,
              coverBase: base,
              patch: {
                cover: appearance.cover,
                cover_position: appearance.coverPosition,
              },
            }))
          }
        />
      )}
      <E2eeSetupDialog open={e2eeDialog === "setup"} onClose={() => setE2eeDialog(null)} />
      <E2eeUnlockDialog open={e2eeDialog === "unlock"} onClose={() => setE2eeDialog(null)} />
      {spaceKeys && (
        <EncryptedSpaceMembers spaceId={spaceKeys} userId={boot.user.id} open onClose={() => setSpaceKeys(null)} onChanged={() => void refresh()} />
      )}
      <Modal
        open={newWorkspace}
        onClose={() => setNewWorkspace(false)}
        title={t("Arbeitsbereich erstellen", "Create workspace")}
      >
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await act({
              action: "workspace.create",
              name: workspaceName,
            });
            if (r?.id) {
              await switchWorkspace(String(r.id));
              setNewWorkspace(false);
            }
          }}
        >
          <label>
            {t("Name", "Name")}
            <input
              required
              autoFocus
              value={workspaceName}
              onChange={(e) => setWorkspaceName(e.target.value)}
              placeholder="z. B. Design-Team"
            />
          </label>
          <button className="button primary">{t("Erstellen", "Create")}</button>
        </form>
      </Modal>
      <Modal
        open={newSpace}
        onClose={() => setNewSpace(false)}
        title={t("Bereich hinzufügen", "Add space")}
      >
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (encryptedSpace) {
              // Keys first: set up or unlock, then the space key is made here.
              const identity = await loadIdentity(boot.user.id).catch(() => undefined);
              if (identity === undefined) return;
              if (!identity) return setE2eeDialog("setup");
              if (!e2eeState.unlocked) return setE2eeDialog("unlock");
              try {
                const id = await createEncryptedSpace({
                  workspaceId: boot.workspace.id,
                  name: spaceName,
                  icon: spaceIcon,
                  iconColor: spaceColor,
                  encryptTitles,
                });
                setNewSpace(false);
                setEncryptedSpace(false);
                await refresh();
                void openSpace(id).catch(() => null);
              } catch (error) {
                notifyError(error);
              }
              return;
            }
            const r = await act({
              action: "space.create",
              workspaceId: boot.workspace.id,
              name: spaceName,
              private: privateSpace,
              icon: spaceIcon,
              iconColor: spaceColor,
            });
            if (r) setNewSpace(false);
          }}
        >
          <label>
            {t("Name", "Name")}
            <input
              autoFocus
              required
              value={spaceName}
              onChange={(e) => setSpaceName(e.target.value)}
            />
          </label>
          <SpaceAppearance
            icon={spaceIcon}
            color={spaceColor}
            onChange={(icon, color) => {
              setSpaceIcon(icon);
              setSpaceColor(color);
            }}
          />
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={privateSpace}
              onChange={(e) => setPrivateSpace(e.target.checked)}
            />
            {t("Privater Bereich", "Private space")}
          </label>
          <p className="muted">
            {t("Private Bereiche sind nur für dich und ausdrücklich berechtigte Mitglieder sichtbar.", "Private spaces are only visible to you and members with explicit access.")}
          </p>
          <label className="checkbox-label">
            <input
              type="checkbox"
              name="encrypted-space"
              checked={encryptedSpace}
              onChange={(e) => setEncryptedSpace(e.target.checked)}
            />
            <LockKey size={14} /> {t("Verschlüsselter Bereich", "Encrypted space")}
          </label>
          {encryptedSpace && (
            <div className="e2ee-create-note">
              <label className="checkbox-label">
                <input type="checkbox" checked={encryptTitles} onChange={(e) => setEncryptTitles(e.target.checked)} />
                {t("Titel verschlüsseln", "Encrypt titles")}
              </label>
              <p className="muted">
                {t(
                  "Ende-zu-Ende-verschlüsselt: Inhalte, Dateien und auf Wunsch Titel werden im Browser verschlüsselt; der Server und Sicherungen enthalten nur Chiffretext. Sichtbar bleiben Seitenstruktur, Größen, Zeitpunkte und Mitglieder. Nur Dokumente – keine Datenbanken, Kommentare, Suche, KI, Freigabelinks oder Veröffentlichung.",
                  "End-to-end encrypted: content, files and optionally titles are encrypted in the browser; the server and backups hold only ciphertext. Page structure, sizes, times and members stay visible. Documents only – no databases, comments, search, AI, share links or publishing.",
                )}
              </p>
              <p className="e2ee-warning">
                {t(
                  "Wer Passphrase und Wiederherstellungsschlüssel verliert, verliert den Zugang zu den Daten. Niemand kann sie wiederherstellen.",
                  "Whoever loses passphrase and recovery key loses access to the data. Nobody can restore it.",
                )}
              </p>
            </div>
          )}
          <button className="button primary">{t("Bereich erstellen", "Create space")}</button>
        </form>
      </Modal>
      <Modal
        open={templates}
        onClose={() => setTemplates(false)}
        title={t("Vorlagen", "Templates")}
      >
        <p className="muted">
          {t("Starte mit einer Struktur oder verwende deine gespeicherten Vorlagen.", "Start with a structure or use your saved templates.")}
        </p>
        <nav className="template-categories" aria-label={t("Kategorien", "Categories")}>
          {[["all", t("Alle", "All")], ...Object.entries(templateCategories)].map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={galleryCategory === id ? "selected" : ""}
              aria-pressed={galleryCategory === id}
              onClick={() => setGalleryCategory(id)}
            >
              {id === "all" ? label : t(label)}
            </button>
          ))}
        </nav>
        <div className="template-grid">
          {Object.entries(catalogFor(LOCALE_TAG === "de-DE" ? "de" : "en"))
            .filter(([, template]) => galleryCategory === "all" || template.category === galleryCategory)
            .map(([templateKey, template]) => (
              <button
                key={templateKey}
                onClick={() => {
                  setTemplates(false);
                  setNewTitle(template.name);
                  setStarterTemplate(templateKey);
                  setNewKind(template.kind as PageKind);
                  setParent(null);
                  setCreate(true);
                }}
              >
                <span className="template-emoji" aria-hidden="true">
                  {template.icon}
                </span>
                <strong>{template.name}</strong>
                <small>{template.description}</small>
                <small className="template-meta">
                  {template.kind === "database" ? t("Datenbank", "Database") : t("Dokument", "Document")} ·{" "}
                  {t(templateCategories[template.category])}
                </small>
              </button>
            ))}
        </div>
        <SavedTemplates
          workspaceId={boot.workspace.id}
          canCreate={canCreate}
          isAdmin={!!boot.user.isAdmin}
          onError={notifyError}
          onUse={async (t) => {
            const r = await act({
              action: "page.create",
              workspaceId: boot.workspace.id,
              spaceId: boot.spaces[0].id,
              title: t.name,
              kind: t.kind,
              templateId: t.id,
            });
            if (r?.id) {
              setTemplates(false);
              void openPage(String(r.id));
            }
          }}
        />
      </Modal>
      <Modal
        open={templateName}
        onClose={() => setTemplateName(false)}
        title={t("Vorlage speichern", "Save template")}
      >
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await act({
              action: "template.save",
              pageId,
              name: templateTitle || data?.page.title,
              private: privateTemplate,
            });
            if (r) {
              setTemplateName(false);
              notify(t("Vorlage gespeichert", "Template saved"));
            }
          }}
        >
          <label>
            {t("Name", "Name")}
            <input
              autoFocus
              value={templateTitle}
              onChange={(e) => setTemplateTitle(e.target.value)}
              placeholder={data?.page.title}
            />
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={privateTemplate}
              onChange={(e) => setPrivateTemplate(e.target.checked)}
            />
            {t("Nur für mich sichtbar", "Only visible to me")}
          </label>
          <button className="button primary">{t("Speichern", "Save")}</button>
        </form>
      </Modal>
      {pageMenu && (
        <Dropdown.Root
          open
          modal={false}
          onOpenChange={(open) => !open && setPageMenu(null)}
        >
          <Dropdown.Trigger asChild>
            <span
              className="context-anchor"
              style={{ left: pageMenu.x, top: pageMenu.y }}
              aria-hidden="true"
            />
          </Dropdown.Trigger>
          <Dropdown.Portal>
            <Dropdown.Content
              className="dropdown"
              align="start"
              sideOffset={2}
              collisionPadding={safeCollisionPadding()}
              aria-label={t(`Aktionen für ${pageMenu.page.title || "Ohne Titel"}`, `Actions for ${pageMenu.page.title || "Untitled"}`)}
            >
              {(() => {
                const target = pageMenu.page;
                // Dialogs of the page menu work on the open page: open it
                // first, then show the dialog.
                const openThen = async (show: () => void) => {
                  if (pageId !== target.id || screen !== "page")
                    await openPage(target.id);
                  show();
                };
                const url = () =>
                  `${location.origin}${location.pathname}${pageLocationHash({ pageId: target.id })}`;
                const starred = boot.favorites.includes(target.id);
                return (
                  <>
                    {/* The iPad app and the desktop app open the page in a window of its own. */}
                    {openInWindow() ? (
                      <Dropdown.Item className="dropdown-item" onSelect={() => openInWindow()?.(url())}>
                        <ArrowSquareOut />
                        {t("In neuem Fenster öffnen", "Open in new window")}
                      </Dropdown.Item>
                    ) : (
                      <Dropdown.Item
                        className="dropdown-item"
                        onSelect={() => window.open(url(), "_blank", "noopener")}
                      >
                        <ArrowSquareOut />
                        {t("In neuem Tab öffnen", "Open in new tab")}
                      </Dropdown.Item>
                    )}
                    {wide && !(screen === "page" && pageId === target.id) && (
                      <Dropdown.Item className="dropdown-item" onSelect={() => openSplit(target.id)}>
                        <SquareSplitHorizontal />
                        {t("In geteilter Ansicht öffnen", "Open in split view")}
                      </Dropdown.Item>
                    )}
                    <Dropdown.Item
                      className="dropdown-item"
                      onSelect={async () => {
                        try {
                          await navigator.clipboard.writeText(url());
                          notify(t("Link kopiert", "Link copied"));
                        } catch {
                          notifyError(t("Link konnte nicht kopiert werden.", "The link could not be copied."));
                        }
                      }}
                    >
                      <LinkIcon />
                      {t("Link kopieren", "Copy link")}
                    </Dropdown.Item>
                    <Dropdown.Item
                      className="dropdown-item"
                      onSelect={() =>
                        act({ action: "favorite", pageId: target.id, value: !starred })
                      }
                    >
                      <Star />
                      {starred ? t("Aus Favoriten entfernen", "Remove from favourites") : t("Zu Favoriten", "Add to favourites")}
                    </Dropdown.Item>
                    <Dropdown.Item
                      className="dropdown-item"
                      onSelect={() => openThen(() => setShare(true))}
                    >
                      <ShareNetwork />
                      {t("Teilen", "Share")}
                    </Dropdown.Item>
                    {canCreate && (
                      <>
                        <Dropdown.Separator className="dropdown-separator" />
                        <Dropdown.Item
                          className="dropdown-item"
                          onSelect={() => addPage("document", target.id, target.space_id)}
                        >
                          <Plus />
                          {t("Unterseite hinzufügen", "Add sub-page")}
                        </Dropdown.Item>
                        <Dropdown.Item
                          className="dropdown-item"
                          onSelect={() => openThen(() => setIconPicker(true))}
                        >
                          <Flag />
                          {t("Icon ändern", "Change icon")}
                        </Dropdown.Item>
                        <Dropdown.Item
                          className="dropdown-item"
                          onSelect={async () => {
                            const r = await act({ action: "page.duplicate", pageId: target.id });
                            if (r?.id) void openPage(String(r.id));
                          }}
                        >
                          <Copy />
                          {t("Duplizieren", "Duplicate")}
                        </Dropdown.Item>
                        <Dropdown.Item
                          className="dropdown-item"
                          onSelect={() => openThen(() => setMove(true))}
                        >
                          <ArrowRight />
                          {t("Verschieben", "Move")}
                        </Dropdown.Item>
                        <Dropdown.Item
                          className="dropdown-item"
                          onSelect={() => openThen(() => setPageExport(true))}
                        >
                          <DownloadSimple />
                          {t("Exportieren", "Export")}
                        </Dropdown.Item>
                        <Dropdown.Item
                          className="dropdown-item"
                          onSelect={() =>
                            act({
                              action: "page.update",
                              pageId: target.id,
                              patch: { locked: !target.locked },
                            })
                          }
                        >
                          <Lock />
                          {target.locked ? t("Seite entsperren", "Unlock page") : t("Seite sperren", "Lock page")}
                        </Dropdown.Item>
                        <Dropdown.Separator className="dropdown-separator" />
                        <Dropdown.Item
                          className="dropdown-item danger"
                          onSelect={async () => {
                            const open = screen === "page" && pageId === target.id;
                            const pending = act({ action: "page.delete", pageId: target.id });
                            if (open) {
                              go("trash");
                              setPageId(null);
                            }
                            if (!(await pending) && open) void openPage(target.id);
                          }}
                        >
                          <Trash />
                          {t("In den Papierkorb", "Move to trash")}
                        </Dropdown.Item>
                      </>
                    )}
                  </>
                );
              })()}
            </Dropdown.Content>
          </Dropdown.Portal>
        </Dropdown.Root>
      )}
      <MovePageDialog
        open={move}
        onClose={() => setMove(false)}
        page={activePages.find((p) => p.id === pageId)}
        workspaces={boot.workspaces}
        currentWorkspace={boot.workspace.id}
        current={{ spaces: boot.spaces, pages: activePages }}
        onMove={async ({ spaceId: target, parentId, workspaceId }) => {
          const moved = pageId;
          const r = await act({
            action: "page.move",
            workspaceId: boot.workspace.id,
            pageId: moved,
            parentId,
            spaceId: target,
          });
          if (!r) return false;
          // Follow the page into the other workspace.
          if (workspaceId !== boot.workspace.id && moved) {
            await switchWorkspace(workspaceId);
            await openPage(moved);
          }
          return true;
        }}
      />
      {pageExport && data && (
        <PageExportDialog
          page={data.page}
          onClose={() => setPageExport(false)}
          onLegacy={() => {
            if (data.page.kind === "document")
              download(
                `${data.page.title}.html`,
                `<!doctype html><html lang="de"><meta charset="utf-8"><title>${data.page.title.replace(/[<>&]/g, "")}</title><body>${exportDocumentHtml(html.current)}</body></html>`,
                "text/html",
              );
            else
              download(
                `${data.page.title}.json`,
                JSON.stringify(
                  { database: data.database, rows: data.rows },
                  null,
                  2,
                ),
                "application/json",
              );
          }}
        />
      )}
      <MobileTabBar
        active={mobile ? null : screen === "home" ? "home" : screen === "inbox" ? "inbox" : null}
        unread={boot.notifications.filter((n) => !n.read_at).length}
        menuOpen={mobile}
        hidden={keyboardOpen || (focusMode && screen === "page")}
        onHome={() => go("home")}
        onSearch={() => {
          setMobile(false);
          openSearch();
        }}
        onNew={
          canCreate
            ? () => {
                setMobile(false);
                // In the space of the open page when the reader may edit
                // there, otherwise where "New page" puts it by default.
                addPage(
                  "document",
                  null,
                  screen === "page" && data && ["editor", "owner"].includes(data.role)
                    ? data.page.space_id
                    : undefined,
                );
              }
            : undefined
        }
        onInbox={() => go("inbox")}
        onMenu={() => {
          setDesktopCollapsed(false);
          setMobile((open) => !open);
        }}
      />
      <Toaster />
    </div>
    {presenting && (
      <Presentation
        html={presenting.html}
        title={presenting.title}
        onClose={() => {
          setPresenting(null);
          // Back to the document the presentation came from.
          setTimeout(() => mainRef.current?.focus({ preventScroll: true }));
        }}
      />
    )}
    </AiProvider>
  );
}
// Comment hits are indexed with a German title (lib/search-index.ts).
function commentHitTitle(title: string, t: (de: string, en: string) => string) {
  const comment = title.match(/^Kommentar von (.+)$/);
  if (comment) return t(`Kommentar von ${comment[1]}`, `Comment by ${comment[1]}`);
  const inline = title.match(/^Textkommentar von (.+)$/);
  if (inline) return t(`Textkommentar von ${inline[1]}`, `Text comment by ${inline[1]}`);
  return title;
}
// Who else has the page open: avatars pop in when someone arrives and
// shrink away when they leave.
function PresenceAvatars({ users }: { users: { id: string; name: string }[] }) {
  const shown = useLeaving(users, (u) => u.id);
  return (
    <div className="presence">
      {shown.map(({ item: u, leaving }) => (
        <span key={u.id} className={`presence-item${leaving ? " leaving" : ""}`} aria-hidden={leaving || undefined}>
          <Avatar name={u.name} userId={u.id} small />
        </span>
      ))}
    </div>
  );
}
function SearchSnippet({ text }: { text: string }) {
  // Server marks hits with \u0002…\u0003; everything is rendered as text.
  return (
    <>
      {text.split("\u0002").map((part, i) => {
        if (!i) return <span key={i}>{part}</span>;
        const [hit, rest = ""] = part.split("\u0003");
        return (
          <span key={i}>
            <mark>{hit}</mark>
            {rest}
          </span>
        );
      })}
    </>
  );
}
// Deleted records of the workspace with restore and purge actions.
function RowTrash({
  workspaceId,
  act,
  onOpen,
}: {
  workspaceId: string;
  act: (b: Record<string, unknown>) => Promise<unknown>;
  onOpen: (pageId: string, rowId: string) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const [entries, setEntries] = useState<
    {
      id: string;
      title: string;
      pageId: string;
      pageTitle: string;
      deletedAt: string;
    }[]
  >([]);
  const load = useCallback(() => {
    api<typeof entries>(`/api/trash/rows?workspace=${workspaceId}`)
      .then(setEntries)
      .catch(() => setEntries([]));
  }, [workspaceId]);
  useEffect(load, [load]);
  if (!entries.length) return null;
  return (
    <section className="row-trash" aria-label={t("Gelöschte Einträge", "Deleted records")}>
      <h2>{t("Gelöschte Einträge", "Deleted records")}</h2>
      <p className="muted">
        {t("Einträge bleiben 30 Tage im Papierkorb und werden danach endgültig gelöscht.", "Records stay in the trash for 30 days and are then deleted permanently.")}
      </p>
      {entries.map((e) => (
        <div className="utility-row" key={e.id}>
          <PageIcon name="file" />
          <strong>
            {e.title}
            <small>{t("aus", "from")}{" "}{e.pageTitle}</small>
          </strong>
          <div className="lifecycle-buttons">
            <button
              className="button compact"
              onClick={async () => {
                if (await act({ action: "row.trash.restore", trashId: e.id })) {
                  load();
                  onOpen(e.pageId, e.id);
                }
              }}
            >
              <ArrowCounterClockwise />
              {t("Wiederherstellen", "Restore")}
            </button>
            <button
              className="button danger compact"
              onClick={async () => {
                if (await act({ action: "row.trash.purge", trashId: e.id }))
                  load();
              }}
            >
              {t("Endgültig löschen", "Delete permanently")}
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}

// Cell changes on their way to the server, shown in the views meanwhile.
// One optimistic layer (see `mutate`).
type Layer = {
  boot?: (boot: Bootstrap) => Bootstrap;
  page?: (data: PageData) => PageData;
};
// A layer that no longer fits (the record is gone) shows nothing instead of
// breaking the app.
function safeLayer<T>(apply: (value: T) => T, value: T): T {
  try {
    return apply(value);
  } catch {
    return value;
  }
}
// Commands sent by "Rückgängig": they offer no undo of their own.
const undoing = new WeakSet<object>();
// The commands lib/undo.ts may offer to take back.
// The journal used last on this device ("Journal: Heute").
const LAST_JOURNAL = "flowplan:last-journal";
const UNDOABLE = new Set(["page.delete", "page.move", "pages.bulk", "row.delete", "rows.bulk", "row.update", "row.move", "database.update", "comment.resolve"]);
