"use client";
import { setCanCreatePages } from "./create-rights";
import { safeCollisionPadding } from "./safe-area";
import { applyTheme, setThemeChoice, themeChoice, watchTheme, type ThemeChoice } from "@/lib/theme";
import { readModeIds, toggleReadMode } from "@/lib/read-mode";
import { foldAllSections } from "@/lib/heading-folds";
import { findSection, parseSettingsHash, redirectedSettingsHash, settingsHash } from "@/lib/settings-sections";
import { connectDesktop, goBack, goForward, installHistory, installMouseButtons, rememberedTitle } from "@/lib/history-nav";
import { usePaneScroll } from "@/lib/pane-scroll";
import { HistoryButtons, type StepLook } from "./history-buttons";
import { addBackCloser, installAppBack } from "@/lib/app-back";
import { firstRun, installAppShortcuts } from "@/lib/app-shortcuts";
import { desktopApp, desktopPageLink, inDesktopApp, nativeApp, offerDesktopApp, openInWindow, openProfileSwitcher, useProfileSwitcherWay } from "@/lib/native-app";
import { currentOS } from "@/lib/device-os";
import { LOCALE_TAG, tr } from "@/lib/locale-tag";
import { useLocale, useT, writeLocaleCookie } from "./i18n";
import { OfflineStatus } from "./offline-status";
import { SaveStatusBadge, useSaveStatusStore } from "./save-status-badge";
import { BrandMark } from "./brand-mark";
import { CoverFrame } from "./cover-frame";
import { clearPlaceholders } from "./image-placeholder";
import { holdViewTransitions, transitionView, withoutViewTransition } from "@/lib/view-transition";
import { Select } from "./select";
import { CommentHub } from "./comment-hub";
import { WorkspaceIcon } from "./workspace-icon";
import {
  useOfflineQueue,
  isQueueable,
  OfflineConflicts,
} from "./offline-queue";
import { applyQueue } from "@/lib/offline-queue";
import { isOfflinePageKind, localPage as localPageOf, localPageChange, offlineTemplate, pageChange, withLocalPages, type LocalState } from "@/lib/offline-create";
import { isPendingPage, sendPendingNow } from "@/lib/offline-pending";
import { OfflineFailedUploads, OfflineMark, OfflinePageNotice } from "./offline-mark";
import { STUDY_PENDING, studyPendingFlag } from "@/lib/study-pending-flag";
import { draftKey, draftSent, keyed, newIdempotencyKey } from "@/lib/idempotency-key";
import {
  parsePageLocation,
  pageLocationHash,
  notificationUrl,
  type PageLocation,
} from "@/lib/page-location";
import { SpaceAppearance, SpaceIcon } from "./space-appearance";
import { SpaceExportDialog } from "./space-export";
import type { OnboardingStep } from "./onboarding";
import { FindInPage } from "./find-in-page";
import { InstanceBanners } from "./instance-banners";
import { LimitsNotice } from "./limits-notice";
import { UnconfirmedDeletionNotice } from "./unconfirmed-deletion-notice";
import { AppPromo } from "./app-promo";
import { actionLabel, KeyboardShortcuts } from "./keyboard-shortcuts";
import { SplitDivider, SplitPane, SplitUnsupported, clampSplit } from "./split-pane";
import { TabBar, TabEdgeDrop, frameOfElement, pageOfPlace, useFrameTabs, validPlaceIn, type PlaceLook } from "./frame-tabs";
import { setSubPageCreator, type SubPageCreator } from "./sub-page-create";
import { placeOf, tabOf } from "@/lib/frame-tabs";
import { openModeOf } from "@/lib/open-place";
import { SIDEBAR_WIDTH_KEY, SidebarResize } from "./sidebar-resize";
import { ActivityPing } from "./activity-ping";
import { useDrawerSwipe } from "./drawer-swipe";
import { OVERLAY_MAX, OVERLAY_MIN, readOverlayWidth, writeOverlayWidth } from "@/lib/edge-swipe";
import { useKeyboardHints } from "@/lib/keyboard-hints";
import { activeKeymap, matchAction, shortcutLetter, preferredCombo, setKeymapOverrides, shortcutHint, subscribeKeymap, type KeymapOverrides, type ShortcutAction } from "@/lib/keymap";
import { PageReview, openPageReview } from "./page-review";
import { PagePropertyBar } from "./page-properties";
import { TagView } from "./tag-view";
import { CollectionView } from "./collection-view";
import { BookNav, BookNext } from "./book-nav";
// Built on the device for pages made offline (#370): in the shell, since the
// connection is gone when such a page opens.
import { localPageData as buildLocalPage } from "./offline-local-data";
import { LIBRARY_HOME, libraryHash, overviewHash, parseLibraryHash } from "@/lib/library";
import { CollectionsNav } from "./collections-nav";
import type { CollectionDraft } from "./collection-editor";
import type { CollectionInfo } from "@/lib/collections";
import { TagOptionsContext } from "./tag-options-context";
import { DatabaseLabelsContext } from "./database-picker";
import { contextOf } from "@/lib/page-properties";
import { Tag as TagIcon, type Icon } from "@phosphor-icons/react";
import { SidebarMore, SidebarToolRow, type SidebarTool } from "./sidebar-tools";
import { PageTitleField } from "./page-title-field";
import { openPageAliases, AliasIcon } from "./page-aliases";
import type { AskRequest } from "./ai-ask";
import { useMedia } from "./use-media";
import { ASK_OVERLAY_MEDIA, writeAskPinned, writeAskWidth } from "@/lib/ask-panel";
import { dockState, evictDock, serverDockState, subscribeDock } from "@/lib/side-dock";
import { proposalPayload, type DatabaseProposal } from "./ai-database";
import { AiProvider, useAiRoute } from "./ai-context";
import type { AiSummaryTarget } from "./ai-summary";
import { aiUsable } from "@/lib/ai/client";
import type { AiCardsStart } from "./study/ai-cards";
import {
  imageFileId,
} from "@/lib/page-appearance";
import { CommandPalette, type CommandAction, type CommandPaletteProps, type PaletteDeck, type PaletteHandle, type PaletteOpenOptions } from "./command-palette";
import { IconImagePicker } from "./icon-image-picker";
import { IconLibraryPicker } from "./icon-library-picker";
import { iconPixels } from "@/lib/page-appearance";
import { VersionChanges } from "./version-changes";
import { LinkPreview } from "./link-preview";
import { Inbox } from "./inbox";
import { RECORD_DROP_EVENT, RECORD_OVER_EVENT, startPointerDrag, type RecordDropDetail, type RecordOverDetail } from "./pointer-drag";
import { MediaLibrary } from "./media-library";
import {
  checkOfflineOwner,
  offlineMarker,
  registerServiceWorker,
} from "./offline";
import { appCopyHolds } from "@/lib/offline-assets";
import { BUILD_META } from "@/lib/stale-copy";
import { useOfflineRefresh } from "./offline-refresh";
import { useOfflineKeep } from "./use-offline-keep";
import { joinRefusalText } from "./join-refusal";
import { useAppOfflineOffer } from "./app-offline-offer";
import { appCopyUnreachable, offlineStore } from "@/lib/offline-store";
import { pageUrl } from "@/lib/offline-plan";
import { needsServer } from "@/lib/offline-actions";
import {
  offlineEntryById,
  offlineEntryCommand,
  offlineEntryFor,
  offlineEntryHasText,
  offlineJournalKey,
  parseOfflineJournal,
  withOfflineEntry,
  withoutOfflineEntry,
  type OfflineJournalEntry,
} from "@/lib/journal-offline";
import { dayTitle as journalDayTitle } from "@/lib/journal-title";
import SavedTemplates from "./saved-templates";
import { TemplateDraftBar, type TemplateDraftInfo } from "./template-draft-bar";
import { MarketplaceLink, MarketplaceReceiver } from "./marketplace";
import { useState, useEffect, useCallback, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { Toaster, showToast, showUndo, toastSerial, undoShownSince } from "./toast";
import { commandOverlay } from "@/lib/optimistic-commands";
import { dropSpace, moveSpaceBy } from "@/lib/space-moves";
import { useSidebarFolds } from "./sidebar-folds-state";
import { setLinkTargetPages } from "./page-link-icons-store";
import { shownPageIcon } from "@/lib/page-link-icons";
import { indexById, structuralPath } from "@/lib/page-path";
import { e2eBuild } from "@/lib/e2e-build";
import { PageBreadcrumb } from "./page-breadcrumb";
import { ancestorIds, journalFoldKey, journalFolds, spaceFoldChanges } from "@/lib/sidebar-folds";
import { branchPath, branchUp, leavesBranch, readBranch, writeBranch } from "@/lib/sidebar-branch";
import type { UndoPlan } from "@/lib/undo";
import { appCache, bootKey, clearAppCache, pageCachePolicy, pageKey } from "@/lib/swr-cache";
import { clearAccountData } from "./sign-out";
import { workspaceCookie } from "@/lib/last-workspace";
import { deviceLayout, layoutCookie, layoutUpdate, writeSidebarCollapsed, writeStoredLayout, type StoredLayout } from "@/lib/layout-cookie";
import { configurePrefetch, installPrefetch, pendingPrefetch } from "./prefetch";
import { ListSkeleton, SettingsSkeleton, ViewSkeleton, viewShapeOf } from "./skeleton";
import { RoutePendingPlaceholder } from "./route-pending";
import { PageMissing } from "./page-missing";
import { classifyError } from "@/lib/error-kinds";
import { routePendingDone } from "@/lib/route-pending";
import { anyOf, byBlockId, byText, bySelector, jumpTo, snippetHit } from "@/lib/jump";
import { flipList, installTaskFeedback, sameRelativeOrder, type Point } from "@/lib/motion";
import { Collapse, useLeaving } from "./motion";
import dynamic from "next/dynamic";
import { PageCommentField } from "./page-comment-field";
import { ViewBoundary, loadView } from "@/components/view-fallback";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import * as PageMenu from "./page-menu";
import {
  Images,
  Cards,
  Stack,
  CaretDown,
  CaretUp,
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
  PaintBrush,
  PencilSimple,
  GearSix,
  SidebarSimple,
  DotsThree,
  ArrowSquareOut,
  ListNumbers,
  AppWindow,
  Desktop,
  ShareNetwork,
  ChatCircle,
  Check,
  X,
  ArrowRight,
  FileText,
  Table,
  Tray,
  PresentationChart,
  Gauge,
  FlowArrow,
  NotePencil,
  Notebook,
  Lock,
  LockOpen,
  Copy,
  DownloadSimple,
  ShieldCheck,
  SignOut,
  Scales,
  Sun,
  Moon,
  Link as LinkIcon,
  SquaresFour,
  Flag,
  ArrowUpRight,
  ImageSquare,
  TextAa,
  ArrowsInLineVertical,
  ArrowsOutLineVertical,
  ArrowsOutLineHorizontal,
  Image as ImageIcon,
  UserCheck,
  Printer,
  QrCode,
  ClockCounterClockwise,
  Graph,
  Sparkle,
  Gift,
  MarkdownLogo,
  Question,
  Info as InfoIcon,
  Keyboard,
  Presentation as PresentIcon,
  SquareSplitHorizontal,
  Browsers,
  SlidersHorizontal,
  CalendarBlank,
  CalendarCheck,
  CalendarDot,
  CalendarDots,
  FolderSimple,
  ArrowsInSimple,
  ArrowsOutSimple,
  ArrowLeft,
  Crosshair,
  ArrowsLeftRight,
  UploadSimple,
} from "@phosphor-icons/react";
import type {
  Bootstrap,
  Page,
  PageKind,
  Role,
  Space,
} from "@/lib/types";
import { PageExportDialog } from "./page-export";
import { queueNotebookImport } from "./notebook/pending-import";
import { MobileTabBar, guardChromeTouches, useShellDocument, useSoftKeyboard } from "./mobile-tab-bar";
import { HideKeyboardButton } from "./hide-keyboard-button";
import {
  Modal,
  PageIcon,
  SIDEBAR_EMOJI,
  Avatar,
  setAvatarDirectory,
  api,
  apiIfChanged,
  ApiError,
  isTransient,
  PageSkeleton,
  endedSession,
  heldBySession,
  reportError,
  setErrorToaster,
  SIGNED_OUT_EVENT,
  SHEET_MEDIA,
  deviceOffline,
  needsConnection,
  offlineNotice as offlineNoteText,
  showNotice,
  OfflineNotice,
} from "./ui";
import type { DatabaseData } from "./database-view";
import { MovePageDialog } from "./move-page-dialog";
import { MetaResolveDialog, moveIntro, ScopeChoice } from "./meta-scope";
import type { ForeignMeta, MetaPlan } from "@/lib/meta-scope";
import { JournalView, localDay, localZone, type JournalDay } from "./journal-view";
import { JournalDayNav, JournalTreeItem, monthLabel } from "./journal-nav";
import { RecordTreeItem } from "./record-tree-item";
import {
  allDaysKey,
  DEFAULT_SIDEBAR_MODE,
  isFolderKey,
  journalSidebar,
  shownTreeIds,
  todayKey,
  type SidebarEntry,
} from "@/lib/journal-nav";
import HomeScreen from "./home/home";
import { relativeTime } from "./home/format";
import TrashView from "./trash-view";
import { FocusBar } from "./focus-bar";
import { PageGraph } from "./page-graph";
import { QuickCapture } from "./quick-capture";
import { printPage } from "./print-page";
import { PrintDialogHost, requestPrint } from "./print-dialog";
import { PageToRecord } from "./page-to-record";
import {
  databaseChoicePayload,
  rememberDatabaseKind,
  rememberedDatabaseKind,
  type DatabaseChoice,
} from "./database-kind-picker";
import { UnlinkedMentions } from "./unlinked-mentions";
import { RelatedPages } from "./related-pages";
import { useDiscoveryPanelsShown } from "@/lib/discovery-panels-prefs";
import { NewPageDialog } from "./new-page-dialog";
import { FilePageUploadDialog, useFilePageUploads } from "./file-page-uploads";
import { carriesFiles } from "@/lib/file-page-uploads";
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
import { JournalCompleted } from "./journal-completed";
import type { ShareLink } from "@/lib/share-links";
import { catalogFor } from "@/lib/template-catalogs";
import { templateCategories } from "@/lib/template-categories";
import { E2eeSetupDialog, E2eeUnlockDialog, EncryptedPage, EncryptedSpaceMembers, EncryptedTitleInput, useDecryptedTitles } from "./e2ee";
import { createEncryptedSpace, encryptTitle, loadIdentity, openSpace, useE2ee } from "./e2ee-store";
import { ENCRYPTED_TITLE } from "@/lib/e2ee";
import { Books, CloudCheck, Compass, ListChecks, LockKey, Storefront } from "@phosphor-icons/react";
import { queueDrawioOpen, setDrawioEditor } from "@/lib/drawio-prefs";
import { PersonalFontStyle } from "./personal-font-style";
import { WorkspaceThemeStyle } from "./workspace-theme-style";
import { WorkspaceFavicon } from "./workspace-favicon";
import { setAutoLinkRules } from "@/lib/auto-link-active";
import { setTextMenuPrefLocal } from "@/lib/text-menu-pref-client";
import { setPageIconPrefLocal, usePageIconPref } from "@/lib/page-icon-pref-client";
import { setExternalLinkIconLocal, useExternalLinkIcon } from "@/lib/external-link-icon-pref-client";
import { setQuoteShortcutLocal } from "@/lib/quote-shortcut-pref-client";
import { setFormattingToolbarLocal } from "@/lib/toolbar-pref-client";
import { setToolbarLayoutFromServer } from "@/lib/toolbar-layout-client";
import { hiddenSidebarTools, primeHiddenSidebarTools, saveHiddenSidebarTools, setHiddenSidebarToolsFromServer, useHiddenSidebarTools } from "@/lib/sidebar-tools-pref-client";
import { isSidebarToolId, moreSheetOf, setSidebarToolShown, settingsInMenu, toolRowOf } from "@/lib/sidebar-tools-pref";
import { setSettingsLevelFromServer } from "@/lib/settings-level-client";
import { primeFeatureModules, setFeatureModulesFromServer, useFeatureModules } from "@/lib/feature-modules-client";
import { moduleShownIn, PAGE_KIND_MODULE, type FeatureModule } from "@/lib/feature-modules";
import { placeShownIn, type WorkspacePlace } from "@/lib/workspace-navigation";
import { setMotionPrefLocal, useMotionPref } from "@/lib/motion-pref-client";
import { motionAttribute, motionPrefOf } from "@/lib/motion-pref";
import { setFullWidthPagesLocal, useFullWidthPages } from "@/lib/page-width-pref-client";
import { setCommentMarginLocal } from "@/lib/comment-margin-pref-client";
import { setStrikeDoneTasksLocal, useStrikeDoneTasks } from "@/lib/done-strike-pref-client";
import { DONE_TASKS_PLAIN_CLASS } from "@/lib/done-strike-pref";
import { setWhiteboardCanvasLocal } from "@/lib/whiteboard-canvas-pref-client";
import { setNotificationSoundLocal } from "@/lib/notification-sound-client";
import { setStartScreenLocal } from "@/lib/start-screen-client";
import { fullWidthPagesOf, showsFullWidth } from "@/lib/page-width-pref";
import { HIDE_EXTERNAL_LINK_ICON_CLASS } from "@/lib/external-link-icon-pref";
import { openWhatsNew, setUpdateNotesLevelLocal } from "@/lib/update-notes-client";
import { visiblePoll } from "@/lib/visible-poll";
import { LIVE_REFRESH_MS, POLL_REFRESH_MS, PRESENCE_REFRESH_MS, useWorkspaceSignals } from "./use-workspace-signals";
import { useNotificationSoundAlerts } from "./use-notification-sound-alerts";
import { WhatsNew } from "./whats-new";
// Shown while the parts load (they use the reader's language).
function Loading({ what }: { what: "emoji" | "document" | "whiteboard" }) {
  const t = useT();
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
// The views a page made offline opens (#370), loaded through one function
// each: next/dynamic gives an import() written inside its call a loader of
// its own (with a wrapper chunk), so the code loaded ahead below
// (preloadOfflineViews) would not be the code the view then asks for.
const loadEditor = () => import("./editor");
const loadDatabaseView = () => import("./database-view");
const loadWhiteboard = () => import("./whiteboard/whiteboard");
const loadNotebookView = () => import("./notebook/notebook-view");
const DocumentEditor = dynamic(() => loadView(loadEditor), {
  ssr: false,
  loading: () => <Loading what="document" />,
});
// Databases with their views, toolbar, tools and records: loaded with the
// first database (started together with the page's data, below, and on
// hover by the prefetch), not with every page.
const DatabaseView = dynamic(() => loadView(loadDatabaseView), { ssr: false, loading: () => <ViewSkeleton /> });
// The collection editor with its filter builder (#86): loaded when opened.
const CollectionEditor = dynamic(() => loadView(() => import("./collection-editor")), { ssr: false });
// The page's QR code (#448): loaded when opened.
const ItemQrDialog = dynamic(() => loadView(() => import("./item-qr")), { ssr: false });
const DashboardView = dynamic(() => loadView(() => import("./dashboard-view")), { ssr: false });
// A space as a library (#329): loaded when a library opens.
const LibraryView = dynamic(() => loadView(() => import("./library-view")), { ssr: false, loading: () => <ListSkeleton rows={4} /> });
// The workspace's library with all shelves and its search (#library).
const LibraryHome = dynamic(() => loadView(() => import("./library-home")), { ssr: false, loading: () => <ListSkeleton rows={4} /> });
const StudyScreen = dynamic(() => loadView(() => import("./study/screen")), { ssr: false, loading: () => <ListSkeleton rows={4} /> });
// "Lernkarten mit KI erstellen" (lib/ai/flashcards.ts): loaded when opened.
const StudyAiCards = dynamic(() => import("./study/ai-cards"), { ssr: false });
// "Lernen: <Stapel>" of the command palette: a session started from there.
const StudyFocus = dynamic(() => import("./study/focus").then((m) => m.StudyFocus), { ssr: false });
// Notebooks bring the ink engine: loaded with the first notebook.
const NotebookView = dynamic(() => loadView(loadNotebookView), { ssr: false, loading: () => <PageSkeleton compact /> });
// Workflows bring the canvas (xyflow): loaded with the first workflow page.
const WorkflowView = dynamic(() => loadView(() => import("./workflow/workflow-view")), { ssr: false, loading: () => <PageSkeleton compact /> });
// The introduction (with its import and admin steps) and the checklist
// "Erste Schritte": loaded only for the people who see them.
const Onboarding = dynamic(() => import("./onboarding").then((m) => m.Onboarding), { ssr: false });
const GettingStarted = dynamic(() => import("./getting-started"), { ssr: false });
// Offline use offered once on a further device (#295, lib/offline-offer.ts).
const OfflineOfferPrompt = dynamic(() => import("./offline-offer"), { ssr: false });
const Whiteboard = dynamic(() => loadView(loadWhiteboard), {
  ssr: false,
  loading: () => <Loading what="whiteboard" />,
});
// The settings with the instance's sections (#532; each section loads with
// its page, components/settings/registry.tsx): loaded when opened.
const SettingsLoading = () => (
  <div className="settings-loading">
    <SettingsSkeleton />
  </div>
);
const Settings = dynamic(() => loadView(() => import("./settings")), { ssr: false, loading: SettingsLoading });
// "Aufgaben in Datenbank verschieben …" (#420), loaded when it opens.
const TasksToDatabase = dynamic(() => import("./tasks-to-database"), { ssr: false });
// Opened by an action: the presentation (KaTeX and the read-only document
// renderer), the Ask panel, the AI summary, the space manager.
const Presentation = dynamic(() => loadView(() => import("./presentation").then((m) => ({ default: m.Presentation }))), { ssr: false });
const AskPanel = dynamic(() => loadView(() => import("./ai-ask").then((m) => ({ default: m.AskPanel }))), { ssr: false });
// The cover dialog with its existing images (#396): loaded when opened.
const CoverPicker = dynamic(() => loadView(() => import("./cover-picker").then((m) => ({ default: m.CoverPicker }))), { ssr: false });
const AiSummaryPanel = dynamic(() => loadView(() => import("./ai-summary").then((m) => ({ default: m.AiSummaryPanel }))), { ssr: false });
const SpaceManager = dynamic(() => loadView(() => import("./space-manager").then((m) => ({ default: m.SpaceManager }))), { ssr: false });
// Mounted with its first opening and kept (closing animation).
const ShareDialog = dynamic(() => loadView(() => import("./share-dialog").then((m) => ({ default: m.ShareDialog }))), { ssr: false });
// "Meine Aufgaben" brings the task status commands (Yjs): loaded when opened.
const MyTasks = dynamic(() => loadView(() => import("./my-tasks").then((m) => ({ default: m.MyTasks }))), { ssr: false, loading: () => <ListSkeleton rows={6} /> });
type PageData = DatabaseData & {
  whiteboard?: { state: string; generation: string };
  workflow?: import("./workflow/model").WorkflowState;
  dashboard?: import("./dashboard-view").DashboardPayload;
  notebook?: import("@/lib/notebook").NotebookPayload;
  journal?: { days: JournalDay[]; settings?: JournalSettings };
  journalDay?: {
    journalId: string;
    date: string;
    trackers: JournalSettings["trackers"];
    options?: { place: boolean; events: boolean; completed?: boolean };
    entry: DayEntry;
  };
  // Behind a journal PIN that was not entered yet.
  locked?: { journalId: string; canReset?: boolean };
  // Today's journal day before it exists (lib/journal-days.ts): created by
  // the first change, until then nothing is stored.
  // `local`: written offline, kept on this device until the day exists
  // (#333, lib/journal-offline.ts).
  draft?: { journalId: string; date: string; local?: boolean };
  // A page made offline that the server does not have yet (#370,
  // lib/offline-create.ts): built on this device, its content kept here.
  offlineNew?: boolean;
  // A page of an end-to-end encrypted space (components/e2ee.tsx).
  encrypted?: { spaceId: string; keyVersion: number; encryptTitles: boolean };
  // Tags and property values (#70, lib/page-properties-server.ts).
  properties?: import("@/lib/page-properties").PageMeta;
  // A draft of a saved page template, for its creator (#461).
  templateDraft?: TemplateDraftInfo | null;
  // Whether this person collapsed that bar (#83; null: never chose).
  propertiesCollapsed?: boolean | null;
  sinceVisit?: SinceVisit | null;
  readers?: Reader[];
  following?: boolean;
  followers?: number;
  shareLinks?: ShareLink[];
  publication?: {
    includeChildren: boolean;
    autoChildren?: boolean;
    count: number;
    allowCopy?: boolean;
    externalLinkIcon?: boolean;
    publishedAt?: string | null;
    password?: boolean;
    expiresAt?: number | null;
  };
  page: Page;
  role: Role;
  html: string;
  state: string | null;
  generation: string;
  backlinks: { id: string; title: string; icon: string; kind?: string; rowId?: string; pageTitle?: string }[];
  snapshots: {
    id: string;
    title: string;
    created_at: string;
    kind?: "auto" | "manual";
  }[];
  present: { id: string; name: string }[];
};
// No record parents in the bootstrap: one empty list, so lookups over it
// stay cached (lib/page-path.ts).
const NO_RECORD_PARENTS: NonNullable<Bootstrap["recordParents"]> = [];
// Typing there: "?" is a character, not the shortcut overlay.
const isTyping = (el: EventTarget | null) =>
  el instanceof HTMLElement &&
  (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
type Screen =
  | "home"
  | "page"
  | "trash"
  | "inbox"
  | "tasks"
  | "graph"
  | "media"
  | "settings"
  // Pages by tag (#70, components/tag-view.tsx): #tags, #tags/<id>.
  | "tags"
  // A collection's results (#86, components/collection-view.tsx): #collection/<id>.
  | "collection"
  // A space as a library (#329, components/library-view.tsx):
  // #library/<space>, a book's contents #library/<space>/<book>; all
  // shelves with the library search (components/library-home.tsx): #library.
  | "library"
  // Flashcards of all decks (components/study/screen.tsx): #study.
  | "study";
export default function WorkspaceApp({
  initial,
  useTemplate,
  inviteResult,
  joinResult,
  layout,
}: {
  initial: Bootstrap;
  // The layout kept on this device (lib/layout-cookie.ts), read by the
  // server from the cookie; null on the first load without one.
  layout?: StoredLayout | null;
  // Public gallery: create a page from this template once signed in.
  useTemplate?: string;
  // Opened through an invitation link (?invite=…).
  inviteResult?: "accepted" | "invalid";
  // Opened through an invitation link for several people (?join=…, #320):
  // joined, a member already, or why the link did not open.
  joinResult?: string;
}) {
  const toggleReadingRef = useRef(() => {});
  // What a global shortcut does (set each render, see runShortcut).
  const shortcutRef = useRef((_action: ShortcutAction) => {});
  const printOpenPageRef = useRef(() => {});
  const printOpenPage = () => printOpenPageRef.current();
  const t = useT();
  // The browser specs' build only (lib/e2e-build.ts): how often the
  // workspace rendered, so tests/browser/search.spec.ts can assert that the
  // quick search opens and filters without it (#610).
  useEffect(() => {
    if (e2eBuild) (window as unknown as { __flowplanWorkspaceRenders?: number }).__flowplanWorkspaceRenders = ((window as unknown as { __flowplanWorkspaceRenders?: number }).__flowplanWorkspaceRenders ?? 0) + 1;
  });
  // The open page's save state: a store of its own, shown by
  // SaveStatusBadge only (components/save-status-badge.tsx).
  const saveStatus = useSaveStatusStore("Gespeichert");
  const setStatus = saveStatus.set;
  // Phones (≤ 767 px, app/globals.css): the page's top bar keeps the title;
  // follow, favourite, share and reading mode move into its ⋯ menu.
  const phone = useMedia("(max-width: 767.98px)");
  // A phone held in the hand (app/mobile-ux.css): "Mehr" is the last entry
  // of the drawer's list, with no bar of its own below it (#629). A narrow
  // window with a mouse keeps the bar.
  const touchPhone = useMedia("(pointer: coarse) and (max-width: 767.98px)");
  // Touch screens, tablets included: pages move by their handle alone, the
  // rows are not draggable (WebKit's own drag would compete, #637).
  const coarsePointer = useMedia("(pointer: coarse)");
  // Up to 600 px the page's ⋯ menu is a bottom sheet (components/page-menu.tsx).
  const sheetMenus = useMedia(SHEET_MEDIA);
  const locale = useLocale();
  // Related pages, backlinks and unlinked mentions below pages (#191).
  const discoveryPanels = useDiscoveryPanelsShown();
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
    // The placeholder drawn with the server's start page for a reload on
    // another place (lib/route-pending.ts): gone once the app shows the
    // place in the address.
    [routeSettled, setRouteSettled] = useState(false),
    [dataState, setData] = useState<PageData | null>(null),
    // A page that does not exist (any more) or is not shared with this
    // person (404/403): an empty state in its place instead of a toast.
    [missingPage, setMissingPage] = useState<{ id: string; status: number } | null>(null),
    [mobile, setMobile] = useState(false),
    // The keyboard shortcut overlay ("?", ⌘/, command, sidebar).
    [shortcuts, setShortcuts] = useState(false),
    // The AI flashcards dialog and where it was opened from (the study
    // view, a selection in the editor, the command palette).
    [aiCards, setAiCards] = useState<AiCardsStart | null>(null),
    // The study session started from "Lernen: <Stapel>" in the palette.
    [studyDeck, setStudyDeck] = useState<{ pageId: string; title: string } | null>(null),
    // The page that is the Tab stop of its space's tree (roving tabindex).
    [treeFocus, setTreeFocus] = useState<string | null>(null),
    // "KI fragen", the panel on the right (components/ai-ask.tsx): null while
    // closed, otherwise the last request to open it (with an optional first
    // question).
    [ask, setAsk] = useState<AskRequest | null>(null),
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
    [tasksToDatabase, setTasksToDatabase] = useState(false),
    [parent, setParent] = useState<string | null>(null),
    [parentRow, setParentRow] = useState<string | null>(null),
    [spaceId, setSpaceId] = useState(initial.spaces[0]?.id || ""),
    [templates, setTemplates] = useState(false),
    // Opened from the "New page" dialog (#112): where the page goes, and
    // back to the dialog when the gallery is closed.
    [templatesFor, setTemplatesFor] = useState<{ spaceId: string; parent: string | null } | null>(null),
    [share, setShare] = useState(false),
    [shareMounted, setShareMounted] = useState(false),
    [pageExport, setPageExport] = useState(false),
    [pageQr, setPageQr] = useState(false),
    // The page shown as Markdown ("Als Markdown bearbeiten").
    [sourcePage, setSourcePage] = useState<string | null>(null),
    [spaceExport, setSpaceExport] = useState<string | null>(null),
    [onboarding, setOnboarding] = useState(!!initial.onboarding),
    [onboardingStep, setOnboardingStep] = useState<OnboardingStep | undefined>(undefined),
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
    // "Alle Tage …" in the tree: the journal to show at its list of days.
    [revealJournalDays, setRevealJournalDays] = useState<string | null>(null),
    // Quick filter above the page tree.
    [treeFilter, setTreeFilter] = useState(""),
    [online, setOnline] = useState(true),
    [move, setMove] = useState(false),
    // Right click on a page in the sidebar: its actions at the pointer.
    // `today`: the menu of a journal's "Heute" favourite (#537).
    [pageMenu, setPageMenu] = useState<{ page: Page; x: number; y: number; today?: boolean } | null>(null),
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
  // Record changes and content made without a connection wait on this
  // device (components/offline-queue.tsx, lib/offline-create.ts); the views
  // show them meanwhile – pages made offline in the sidebar and lists.
  const refreshRef = useRef<() => Promise<unknown>>(async () => {});
  const queueSynced = useCallback(() => refreshRef.current(), []);
  const queueNote = useCallback((text: string, error?: boolean) => showToast({ text, tone: error ? "error" : "info" }), []);
  const offlineQueue = useOfflineQueue({
    userId: bootState.user.id,
    onSynced: queueSynced,
    notify: queueNote,
  });
  // A page made offline that the server does not have yet, from the lists
  // as they are now (also right after it was made, before React shows it).
  const peekQueue = offlineQueue.current;
  const localWaiting = useCallback((id: string) => localPageChange(peekQueue().queue, peekQueue().failed, id), [peekQueue]);
  const boot = useMemo(() => {
    const b = layers.reduce((b, layer) => (layer.boot ? safeLayer(layer.boot, b) : b), bootState);
    const pages = withLocalPages(b.pages, offlineQueue.queue, offlineQueue.failed, b.workspace.id, b.user.id);
    return pages === b.pages ? b : { ...b, pages };
  }, [bootState, layers, offlineQueue.queue, offlineQueue.failed]);
  // The workspace's automatic link rules (#202) for every editor; set while
  // rendering so editors created in this render already have them.
  setAutoLinkRules(boot.linkRules);
  // "Menü bei Textauswahl" (#200): the editors' text menus read it.
  useEffect(() => setTextMenuPrefLocal(boot.textMenu), [boot.textMenu]);
  // "Seitensymbol" (#214): the page header reads it.
  useEffect(() => setPageIconPrefLocal(boot.pageIcon), [boot.pageIcon]);
  // "Neuigkeiten nach Updates" (#223): the settings read it.
  useEffect(() => setUpdateNotesLevelLocal(boot.updateNotes?.level), [boot.updateNotes?.level]);
  const pageIconPlace = usePageIconPref();
  // "Symbol bei externen Links" (#217, lib/external-link-icon-pref.ts): off
  // puts a class on <html> that hides the arrow everywhere in the app;
  // gone again when the app is left (published pages keep the arrow).
  useEffect(() => setExternalLinkIconLocal(boot.externalLinkIcon), [boot.externalLinkIcon]);
  // "`>` erzeugt" (#230, lib/quote-shortcut-pref.ts): the editor's "> " rule.
  useEffect(() => setQuoteShortcutLocal(boot.quoteShortcut), [boot.quoteShortcut]);
  // "Formatierungsleiste" (#235): the editors read it.
  useEffect(() => setFormattingToolbarLocal(boot.formattingToolbar), [boot.formattingToolbar]);
  useEffect(() => setToolbarLayoutFromServer(boot.toolbarLayout, boot.toolbarLayoutDefault, boot.toolbarLayoutCustom), [boot.toolbarLayout, boot.toolbarLayoutDefault, boot.toolbarLayoutCustom]);
  // The settings level (#294): Settings shows what is up to it.
  useEffect(() => setSettingsLevelFromServer(boot.settingsLevel), [boot.settingsLevel]);
  // Switched-off features (#378, lib/feature-modules.ts): taken from the
  // first bootstrap before anything renders, later ones in the effect. The
  // entry points ask `featureShown`; with the AI off its status is left out of
  // the interface (the AI settings still see it in `boot`).
  primeFeatureModules(boot.modules);
  useEffect(() => setFeatureModulesFromServer(boot.modules), [boot.modules]);
  const { effective: hiddenModules, off: offModules } = useFeatureModules();
  const featureShown = (module: FeatureModule | undefined) => moduleShownIn(hiddenModules, module);
  // The symbols this person hid from the sidebar's bottom row (#589,
  // lib/sidebar-tools-pref.ts): from the first bootstrap before anything
  // renders, later ones in the effect.
  primeHiddenSidebarTools(boot.hiddenSidebarTools);
  useEffect(() => setHiddenSidebarToolsFromServer(boot.hiddenSidebarTools), [boot.hiddenSidebarTools]);
  const hiddenTools = useHiddenSidebarTools();
  // The sidebar's places the workspace does without (#564,
  // lib/workspace-navigation.ts): their entries go, their screens still
  // open from links.
  const placeShown = (place: WorkspacePlace | undefined) => placeShownIn(boot.navigation, place);
  const uiAi = featureShown("ai") ? boot.ai : undefined;
  // "Animationen" (#260, lib/motion-pref.ts): data-motion on <html>, which
  // menus and dialogs outside the app's root follow; the root carries it
  // too, so the server-rendered first paint has it. Gone when the app is left.
  useEffect(() => setMotionPrefLocal(boot.motion), [boot.motion]);
  useEffect(() => () => void delete document.documentElement.dataset.motion, []);
  const motion = useMotionPref(motionPrefOf(boot.motion));
  // "Seiten in voller Breite anzeigen" (#257, lib/page-width-pref.ts): every
  // page at full width for this person; from the bootstrap until the
  // browser's copy is set, so the first paint has the width.
  useEffect(() => setFullWidthPagesLocal(boot.fullWidthPages), [boot.fullWidthPages]);
  const allPagesWide = useFullWidthPages(fullWidthPagesOf(boot.fullWidthPages));
  // "Textkommentare: am Rand / unter dem Dokument" (#387, lib/comment-margin-pref.ts).
  useEffect(() => setCommentMarginLocal(boot.commentMargin), [boot.commentMargin]);
  useEffect(() => setStrikeDoneTasksLocal(boot.strikeDoneTasks), [boot.strikeDoneTasks]);
  // "Whiteboard-Fläche: folgt dem Farbschema / immer hell" (#399, lib/whiteboard-canvas-pref.ts).
  useEffect(() => setWhiteboardCanvasLocal(boot.whiteboardCanvas), [boot.whiteboardCanvas]);
  // "Ton bei neuen Benachrichtigungen" (#401, lib/notification-sound.ts).
  useEffect(() => setNotificationSoundLocal(boot.notificationSound), [boot.notificationSound]);
  // Inside the iPhone, iPad and Android app: the app's profiles from the
  // workspace menu and a long press on the own account row (lib/native-app.ts).
  const profileSwitcher = useProfileSwitcherWay();
  // "Beim Öffnen auf dem Handy" (lib/start-screen.ts): the settings show it.
  useEffect(() => setStartScreenLocal(boot.startScreen), [boot.startScreen]);
  // The share dialog loads with its first opening and stays mounted.
  useEffect(() => {
    if (share) setShareMounted(true);
  }, [share]);
  // A document known from the page tree, or a record in the address (its
  // own document): the editor (with TipTap) starts loading together with
  // the page's data instead of after it; so does a database's code.
  const openingKind = screen === "page" && pageId ? boot.pages.find((p) => p.id === pageId)?.kind : undefined;
  useEffect(() => {
    if (openingKind === "database") void loadDatabaseView().catch(() => {});
    if (openingKind === "document" || (openingKind === "database" && parsePageLocation(location.hash)?.rowId)) void loadEditor().catch(() => {});
  }, [openingKind, pageId]);
  const linkIcon = useExternalLinkIcon();
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle(HIDE_EXTERNAL_LINK_ICON_CLASS, !linkIcon);
    return () => root.classList.remove(HIDE_EXTERNAL_LINK_ICON_CLASS);
  }, [linkIcon]);
  // "Erledigte Aufgaben durchstreichen" off (#458): done tasks only ticked.
  const strikeDone = useStrikeDoneTasks();
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle(DONE_TASKS_PLAIN_CLASS, !strikeDone);
    return () => root.classList.remove(DONE_TASKS_PLAIN_CLASS);
  }, [strikeDone]);
  // The draw.io editor the documents' blocks open (lib/drawio-prefs.ts).
  setDrawioEditor(boot.instance?.drawio);
  const data = useMemo(
    () => (dataState ? layers.reduce((d, layer) => (layer.page ? safeLayer(layer.page, d) : d), dataState) : null),
    [dataState, layers],
  );
  // "Mit KI zusammenfassen" in the page menu: on the server, or in the apps
  // on Apple devices on the device – there also in encrypted spaces.
  const summaryRoute = useAiRoute("summarize", data?.page.id, { status: uiAi || null, encrypted: !!data?.encrypted });
  const [treeDrop, setTreeDrop] = useState<{
    id: string;
    // "records": records from a database dropped onto another database.
    placement: "before" | "after" | "inside" | "records";
  } | null>(null);
  // Profile pictures for every Avatar below, from the current member list.
  setAvatarDirectory([...boot.members, boot.user]);
  // The sidebar hidden on wide screens. It starts as the person left it on
  // this device (#331; the cookie below, so the server's first paint already
  // has it hidden), and the app collapses or reveals it for a moment on its
  // own (the pinned "KI fragen" panel on a narrow window, "Focus in
  // sidebar"). Only the person's own choice – the hide button, the button
  // that brings it back, the shortcut and the command palette, on a wide
  // window (phones have the drawer) – is kept: `collapsedChoice`.
  const [desktopCollapsed, setDesktopCollapsed] = useState(layout?.collapsed ?? false);
  const [collapsedChoice, setCollapsedChoice] = useState(layout?.collapsed ?? false);
  const desktopCollapsedRef = useRef(desktopCollapsed);
  desktopCollapsedRef.current = desktopCollapsed;
  const chooseCollapsed = (collapsed: boolean) => {
    setDesktopCollapsed(collapsed);
    if (matchMedia("(min-width: 768px)").matches) setCollapsedChoice(collapsed);
  };
  // In the phone layout (a narrow window too, e.g. half a screen at 150 %)
  // the sidebar is the drawer: its buttons, the shortcut and the command
  // palette open and close it and leave the docked sidebar as the person
  // chose it – collapsing there would change nothing visible and hide or
  // show the sidebar once the window gets wider again (#510).
  const phoneLayout = () => matchMedia("(max-width: 767.98px)").matches;
  const toggleCollapsed = () => {
    if (phoneLayout()) setMobile((open) => !open);
    else chooseCollapsed(!desktopCollapsedRef.current);
  };
  // The sidebar's width on wide screens, dragged at its right edge (null:
  // the default from the stylesheet), the width of the "KI fragen" panel the
  // same way (dragged at its left edge; the stylesheet keeps it within
  // 320 px and 45 % of the window), and whether that panel is pinned beside
  // the page on narrow windows – where it otherwise lies over the page
  // (lib/ask-panel.ts). Kept per device in localStorage and in a cookie the
  // server renders the first paint with (lib/layout-cookie.ts), so the
  // sidebar does not jump from the default width after a reload.
  const [sidebarWidth, setSidebarWidth] = useState<number | null>(layout?.sidebar ?? null);
  const [askWidth, setAskWidth] = useState<number | null>(layout?.ask ?? null);
  const [askPinned, setAskPinned] = useState(layout?.askPinned ?? false);
  const layoutRead = useRef(false);
  useEffect(() => {
    if (!layoutRead.current) {
      layoutRead.current = true;
      // The page was rendered with a layout other than the device's own:
      // the first load without the cookie (e.g. right after the update), or
      // – offline – an older copy of the page (the service worker's, or the
      // iOS app's stored copy), rendered before the sidebar was hidden or
      // resized (#641). The device's values (localStorage, else its cookie)
      // after the first render; the next run writes them back. Online the
      // two agree: nothing changes, no flash.
      const update = layoutUpdate(layout, deviceLayout(document.cookie));
      if (update) {
        setSidebarWidth(update.sidebar);
        setAskWidth(update.ask);
        setAskPinned(update.askPinned);
        setCollapsedChoice(update.collapsed);
        setDesktopCollapsed(update.collapsed);
        return;
      }
    }
    try {
      if (sidebarWidth === null) localStorage.removeItem(SIDEBAR_WIDTH_KEY);
      else localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
    } catch {}
    writeAskWidth(askWidth);
    writeAskPinned(askPinned);
    writeSidebarCollapsed(collapsedChoice);
    const current = { sidebar: sidebarWidth, ask: askWidth, askPinned, collapsed: collapsedChoice };
    writeStoredLayout(current);
    document.cookie = layoutCookie(current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sidebarWidth, askWidth, askPinned, collapsedChoice]);
  // The sidebar's width while it lies over the page (phones, and tablets
  // whose sidebar is collapsed; #285): its own, dragged at its right edge
  // and kept per device apart from the docked width (lib/edge-swipe.ts).
  // null: the stylesheet's default. Read after the first render – the
  // overlay is closed at first paint.
  const [overlayWidth, setOverlayWidth] = useState<number | null>(null);
  const overlayRead = useRef(false);
  useEffect(() => {
    if (!overlayRead.current) {
      overlayRead.current = true;
      setOverlayWidth(readOverlayWidth(localStorage));
      return;
    }
    writeOverlayWidth(localStorage, overlayWidth);
  }, [overlayWidth]);
  const askNarrowWindow = useMedia(ASK_OVERLAY_MEDIA);
  // Presentation mode of the open document (components/presentation.tsx).
  const [presenting, setPresenting] = useState<{ html: string; title: string } | null>(null);
  // Split view (components/split-pane.tsx): the right frame of the tabs
  // (components/frame-tabs.tsx, #279) – its active page is kept in the
  // address as ?split=<id>. The share of the width the left frame takes,
  // in percent (kept per device; only shown once the window is known to be
  // wide, after the first render).
  const [splitRatio, setSplitRatio] = useState(() => {
      try {
        const stored = Number(localStorage.getItem("flowplan-split-ratio"));
        return stored ? clampSplit(stored) : 50;
      } catch {
        return 50;
      }
    }),
    // Wider than 1024 px: split view is possible.
    [wide, setWide] = useState(false),
    // A page from the tree is being dragged: the drop zone at the right edge shows.
    [pageDrag, setPageDrag] = useState(false),
    [splitDropOver, setSplitDropOver] = useState(false);
  // Tabs and frames (#279): on tablets and computers, not on phones.
  const tabletUp = useMedia("(min-width: 768px)");
  const newTabSearch = useRef<(frame: number) => void>(() => {});
  // The frame a command picked for a new tab opens its screen in (runCommand).
  const commandTab = useRef<number | null>(null);
  // A screen or settings address for that new tab; false: open it here.
  const toPlace = (place: string) => {
    const frame = commandTab.current;
    if (frame === null) return false;
    commandTab.current = null;
    return tabs.openPlace(place, "tab", frame);
  };
  const tabs = useFrameTabs({
    onNewTab: (frame) => newTabSearch.current(frame),
    enabled: tabletUp,
    wide,
    userId: boot.user.id,
    workspaceId: boot.workspace.id,
    valid: validPlaceIn(boot.pages, !!boot.user.isAdmin),
  });
  const split = tabs.side ? pageOfPlace(placeOf(tabOf(tabs.side))) : null;
  const sidePlace = tabs.side ? placeOf(tabOf(tabs.side)) : null;
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
    [bulkBusy, setBulkBusy] = useState(false),
    // A move into another space that brings tags or properties of the
    // source space: the step that resolves them (#136).
    [metaMove, setMetaMove] = useState<{ items: ForeignMeta[]; target: string; run: (meta: MetaPlan) => Promise<unknown> } | null>(null);
  const lastSelected = useRef<string | null>(null),
    // Ends a page drag by the handle (startTreeHandleDrag) quietly.
    treeHandleEnd = useRef<(() => void) | null>(null),
    treeHandleDropRef = useRef((_source: string, _x: number, _y: number) => {}),
    // The row marked as the drop target of a page dragged by its handle:
    // marked on the element itself, so the drag re-renders nothing (#637).
    treeMark = useRef<{ row: HTMLElement; mark: string } | null>(null),
    // Whether the last press on a row of the tree was a finger.
    rowPressedByTouch = useRef(false);
  // A page drag by the handle ends with the workspace (no stray drop marks).
  useEffect(() => () => treeHandleEnd.current?.(), []);
  // … and with the phone's drawer (#637).
  useEffect(() => {
    if (!mobile) treeHandleEnd.current?.();
  }, [mobile]);
  const [privateTemplate, setPrivateTemplate] = useState(false);
  // The scope of a template being saved (#136): the page's space (null:
  // the whole workspace); `templateSpaceRefs` holds the server's answer when
  // the page uses tags of its space a workspace template may not carry.
  const [templateScope, setTemplateScope] = useState<"space" | "workspace">("space"),
    [templateSpaceRefs, setTemplateSpaceRefs] = useState("");
  const [starterTemplate, setStarterTemplate] = useState<string | null>(null);
  // A saved template chosen for the "New page" dialog; `meta` holds what
  // to do with its space's tags, decided for the space `metaSpace` (#136).
  const [savedTemplate, setSavedTemplate] = useState<{ id: string; name: string; meta?: MetaPlan; metaSpace?: string } | null>(null);
  // The name a chosen template put into the dialog's name field: replaced by
  // the next template's, unlike a name typed by hand (#213).
  const [suggestedTitle, setSuggestedTitle] = useState<string | null>(null);
  const [galleryCategory, setGalleryCategory] = useState("all");
  // Saved templates of this workspace (and personal ones): their own
  // category in the gallery, hidden while there are none (#132).
  const [savedTemplateCount, setSavedTemplateCount] = useState(0);
  const shownCategory = galleryCategory === "mine" && !savedTemplateCount ? "all" : galleryCategory;
  const [iconTab, setIconTab] = useState<"emoji" | "image" | "library">(
    "emoji",
  );
  const [versionChanges, setVersionChanges] = useState<{
    id: string;
    label: string;
  } | null>(null);
  // Collections (#86): the one shown and the editor's draft.
  const [collectionId, setCollectionId] = useState<string | null>(null),
    [collectionDraft, setCollectionDraft] = useState<CollectionDraft | null>(null);
  // The library shown (#329): its space and the book opened, if any; null
  // on the library's start (#library).
  const [libraryPlace, setLibraryPlace] = useState<ReturnType<typeof parseLibraryHash>>(null);
  const mainRef = useRef<HTMLElement>(null);
  // The quick search and command palette (components/command-palette.tsx):
  // its state is its own, so opening it and typing in it never re-render
  // the workspace (#610). Opened and closed through this handle.
  const palette = useRef<PaletteHandle>(null);
  const openSearch = useCallback((options?: PaletteOpenOptions) => palette.current?.open(options), []);
  const closeSearch = () => palette.current?.close();
  const searchOpen = () => !!palette.current?.isOpen();
  // A new tab (#444): the quick search; the page picked opens in a new tab
  // of that frame. Nothing is opened before, so Esc leaves the tabs alone.
  newTabSearch.current = (frame: number) => openSearch({ split: false, tab: frame });
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
  // Set by a workspace switch in the sidebar that changes the address: the
  // next navigation leaves the drawer on phones open (goStart).
  const keepNavOnce = useRef(false);
  // The tags for multi-selects with the workspace's tags as options (#79):
  // those of the open database's context – the workspace's and its space's
  // (#136).
  const openPageSpace = data?.page.space_id;
  const tagOptions = useMemo(
    () => ({ tags: contextOf(boot.taxonomy?.tags ?? [], openPageSpace), createTags: !!boot.taxonomy?.createTags }),
    [boot.taxonomy, openPageSpace],
  );
  // Reloads overlap (after each change, every 10 s, …) and their answers
  // may come in another order: one that started earlier and answers later
  // would put back the state from before a change – the record's old values
  // and version, refused on the next edit (#104). The newest one shown wins.
  const refreshCount = useRef(0),
    bootShown = useRef(0),
    dataShown = useRef(0);
  // `only`: what the workspace's live signal says changed (lib/workspace-live.ts)
  // – the bootstrap (tree, notifications) or the open page; by default both.
  const refresh = useCallback(async (only: { boot?: boolean; page?: boolean } = {}) => {
    if (navigationPending.current) return;
    const version = navigationVersion.current;
    const count = ++refreshCount.current;
    if (only.boot === false) {
      if (only.page === false || !currentId.current || screenRef.current !== "page" || dataRef.current?.page.id !== currentId.current) return;
      if (dataRef.current.draft?.local || dataRef.current.offlineNew) return;
      const pid = currentId.current;
      const p = await apiIfChanged<PageData>(`/api/pages/${pid}`);
      if (pid === currentId.current && version === navigationVersion.current && !navigationPending.current && count >= dataShown.current) {
        dataShown.current = count;
        setData(p);
      }
      return;
    }
    let result: Bootstrap;
    try {
      // Unchanged (304): the same object, setBoot changes nothing.
      result = await apiIfChanged<Bootstrap>(
        `/api/bootstrap?workspace=${currentWorkspace.current}`,
      );
    } catch (error) {
      if (version !== navigationVersion.current || navigationPending.current)
        return;
      // The workspace is gone – Flowplan said so. A 404 from a proxy while
      // the server restarts ("404 page not found", #284) is no reason to
      // leave the page: the editor keeps the text and sends it later.
      if (error instanceof ApiError && error.status === 404 && !error.transient) {
        setData(null);
        window.location.assign("/");
        return;
      }
      throw error;
    }
    if (navigationPending.current || version !== navigationVersion.current)
      return;
    if (count < bootShown.current) return;
    bootShown.current = count;
    setBoot(result);
    // A page link that led nowhere (404/403) keeps its empty state
    // (PageMissing): the refresh does not trade it for the start page – also
    // when the workspace it pointed into is no longer this person's and the
    // bootstrap answered with another one.
    if (screenRef.current === "page" && currentId.current && missingRef.current?.id === currentId.current) {
      currentWorkspace.current = result.workspace.id;
      return;
    }
    if (
      result.workspace.id !== currentWorkspace.current ||
      (screenRef.current === "page" &&
        !((dataRef.current?.draft || dataRef.current?.offlineNew) && dataRef.current.page.id === currentId.current) &&
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
    // Today's entry written offline exists only here (#333), and so does a
    // page made offline until the queue created it (#370).
    if (dataRef.current?.draft?.local && dataRef.current.page.id === currentId.current) return;
    if (dataRef.current?.offlineNew && dataRef.current.page.id === currentId.current && localWaiting(currentId.current)) return;
    if (only.page === false && dataRef.current?.page.id === currentId.current) return;
    if (currentId.current && screenRef.current === "page") {
      const pid = currentId.current;
      // A page shown for the first time (e.g. opened by its link) counts
      // as a visit; later reloads of the same page do not.
      const first = dataRef.current?.page.id !== pid;
      const p = first
        ? await api<PageData>(`/api/pages/${pid}`, undefined, { "X-Flowplan-Visit": "1" })
        : await apiIfChanged<PageData>(`/api/pages/${pid}`);
      if (
        pid === currentId.current &&
        version === navigationVersion.current &&
        !navigationPending.current &&
        count >= dataShown.current
      ) {
        dataShown.current = count;
        setData(p);
      }
    }
  }, []);
  refreshRef.current = refresh;
  // The open page, when it was made offline and is not on the server yet.
  const localOpen = data?.offlineNew ? localPageChange(offlineQueue.queue, offlineQueue.failed, data.page.id) : null;
  // Flashcard ratings made offline (components/study/sync.ts): sent once
  // the connection is back. The sending is loaded only while some wait on
  // this device and the device is online (lib/study-pending-flag.ts).
  useEffect(() => {
    const userId = boot.user.id;
    const run = () => {
      if (!studyPendingFlag() || deviceOffline()) return;
      void import("./study/sync").then((m) => m.syncStudyReviews(userId)).catch(() => undefined);
    };
    run();
    window.addEventListener(STUDY_PENDING, run);
    window.addEventListener("online", run);
    const timer = setInterval(run, 30_000);
    return () => {
      window.removeEventListener(STUDY_PENDING, run);
      window.removeEventListener("online", run);
      clearInterval(timer);
    };
  }, [boot.user.id]);
  const dataRef = useRef(data);
  dataRef.current = data;
  const missingRef = useRef(missingPage);
  missingRef.current = missingPage;
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
  // A reload, a new tab or the next visit opens this workspace again (#188,
  // lib/last-workspace.ts).
  useEffect(() => {
    const cookie = workspaceCookie(bootState.workspace.id);
    if (cookie) document.cookie = cookie;
  }, [bootState.workspace.id]);
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
        const load =
          kind === "whiteboard"
            ? loadWhiteboard
            : kind === "dashboard"
              ? () => import("./dashboard-view")
              : kind === "workflow"
                ? () => import("./workflow/workflow-view")
                : kind === "document"
                  ? loadEditor
                  : kind === "database"
                    ? loadDatabaseView
                    : null;
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
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      // Signed out: answered here, without knocking at the server again.
      if (heldBySession(url)) return new Response(JSON.stringify({ error: "Bitte melde dich an." }), { status: 401, headers: { "Content-Type": "application/json" } });
      const response = await original(input, init);
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
  useEffect(() => {
    if (!joinResult) return;
    notify(
      joinResult === "joined" || joinResult === "member"
        ? t(`Willkommen in „${boot.workspace.name}“.`, `Welcome to “${boot.workspace.name}”.`)
        : joinRefusalText(joinResult, t),
    );
    const url = new URL(location.href);
    url.searchParams.delete("join");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // "Back" in the apps (swipe from the edge, Android's back): closes what is
  // open, then goes up and to the place before (lib/app-back.ts).
  useEffect(() => (nativeApp() ? installAppBack() : undefined), []);
  // Back and forward (#125, lib/history-nav.ts): the arrows in the top bar
  // follow the tab's history; the desktop app's menu, swipe and mouse
  // buttons come through its bridge. Once per command, also when the key
  // event and the app's menu both report it (firstRun).
  useEffect(() => {
    const stop = installHistory();
    const run = (command: "back" | "forward") => {
      if (firstRun(command)) shortcutRef.current(command);
    };
    connectDesktop(desktopApp()?.history, run);
    const stopMouse = inDesktopApp() ? installMouseButtons(run) : () => {};
    return () => {
      stop();
      stopMouse();
    };
  }, []);
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
  // While it is open, and until it has slid out (0.18 s, app/globals.css),
  // screens and pages change without a view transition: on iOS one that
  // captured the page while the drawer slid out of it (Einstellungen in the
  // drawer) left WebKit with a stale picture of the drawer, and the next
  // "Navigation" dimmed the page with the drawer still off screen. The
  // drawer's own slide is the animation (lib/view-transition.ts).
  useEffect(() => {
    if (!mobile) return;
    const release = holdViewTransitions();
    return () => void window.setTimeout(release, 250);
  }, [mobile]);
  // It exists in the phone layout (≤ 767 px, app/globals.css) and over the
  // page on wider windows whose sidebar is collapsed (#285): when the window
  // gets wider while it is open (a foldable such as iPhone Duo opens, the
  // phone turns, a window grows) and the sidebar is docked there, the
  // sidebar takes over, and the drawer closes – instead of staying open
  // unseen, taking the next "back" and coming back when the window narrows
  // again. The same when the collapsed sidebar is docked again.
  useEffect(() => {
    if (!mobile) return;
    const wide = matchMedia("(min-width: 768px)");
    const close = () => {
      if (wide.matches && !desktopCollapsed) setMobile(false);
    };
    close();
    wide.addEventListener("change", close);
    return () => wide.removeEventListener("change", close);
  }, [mobile, desktopCollapsed]);
  // Open, the drawer is the place to be: focus moves into it (the page
  // beside it is inert, see .main below), and back to the page when it
  // closes with the focus still in it.
  useEffect(() => {
    if (!mobile) return;
    const sidebar = document.querySelector<HTMLElement>(".app-shell > .sidebar");
    if (sidebar && !sidebar.contains(document.activeElement)) sidebar.focus({ preventScroll: true });
    return () => {
      const active = document.activeElement;
      if (!active || active === document.body || sidebar?.contains(active)) mainRef.current?.focus({ preventScroll: true });
    };
  }, [mobile]);
  // Settings → Konto opens the introduction and the shortcut overlay again.
  useEffect(() => {
    const open = () => setOnboarding(true);
    const keys = () => setShortcuts(true);
    // "flowplan:flashcards-ai" (the study view, the editor's text menu, the
    // PDF viewer).
    const cards = (event: Event) => setAiCards((event as CustomEvent<AiCardsStart>).detail || {});
    window.addEventListener("flowplan:onboarding", open);
    window.addEventListener("flowplan:shortcuts", keys);
    window.addEventListener("flowplan:flashcards-ai", cards);
    return () => {
      window.removeEventListener("flowplan:onboarding", open);
      window.removeEventListener("flowplan:shortcuts", keys);
      window.removeEventListener("flowplan:flashcards-ai", cards);
    };
  }, []);
  // The PDF viewer (outside the workspace's tree) asks whether to offer
  // "Lernkarten erstellen": answered at once on the event's detail.
  const flashcardsUsable = aiUsable(uiAi, "flashcards") && !boot.workspace.guest;
  useEffect(() => {
    const probe = (event: Event) => {
      const detail = (event as CustomEvent<{ available?: boolean }>).detail;
      if (detail) detail.available = flashcardsUsable;
    };
    window.addEventListener("flowplan:flashcards-ai-probe", probe);
    return () => window.removeEventListener("flowplan:flashcards-ai-probe", probe);
  }, [flashcardsUsable]);
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
      // A page made offline that the server does not have yet (#370): a
      // new title or icon goes along with it, deleting it discards it,
      // records wait behind it in the queue; anything else needs it created.
      const localTarget = typeof b.pageId === "string" ? localWaiting(b.pageId) : null;
      if (localTarget && typeof b.pageId === "string") {
        const patch = (b.patch || {}) as Record<string, unknown>;
        if (b.action === "page.update" && Object.keys(patch).every((k) => k === "title" || k === "icon")) {
          offlineQueue.renamePage(b.pageId, patch);
          if (dataRef.current?.page.id === b.pageId)
            setData((d) => (d && d.page.id === b.pageId ? { ...d, page: { ...d.page, ...(typeof patch.title === "string" && patch.title.trim() ? { title: patch.title } : {}), ...(typeof patch.icon === "string" ? { icon: patch.icon } : {}) } } : d));
          return { ok: true };
        }
        if (b.action === "page.delete") {
          offlineQueue.discard(b.pageId);
          return { ok: true };
        }
        if (isQueueable(b)) return offlineQueue.enqueue(b, rows());
        throw new OfflineNotice();
      }
      if (isQueueable(b) && !navigator.onLine)
        return offlineQueue.enqueue(b, rows());
      // New pages, spaces, imports … need the server (#333): a calm note.
      if (needsServer(b) && deviceOffline()) throw new OfflineNotice();
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
        const plan = undoing.has(b) || !UNDOABLE.has(String(b.action)) ? null : (await import("@/lib/undo")).undoFor(b, before, openBefore, result);
        if (plan) showUndo(plan.message, () => undoRef.current(plan));
        await refresh();
        return result;
      } finally {
        if (layer) setLayers((list) => list.filter((x) => x !== layer));
      }
    },
    [refresh, offlineQueue],
  );
  // "Erste Schritte" (lib/getting-started.ts): the browser reports what the
  // server cannot see – the quick search opened, the app in use (installed
  // web app, desktop or phone app). Once each.
  const checklist = boot.gettingStarted;
  const checklistOpen = !!checklist && !checklist.hidden;
  const searchTicked = !!checklist?.items.some((i) => i.id === "search" && i.done);
  const appTicked = !!checklist?.items.some((i) => i.id === "app" && i.done);
  const ticking = useRef(new Set<string>());
  const tick = useCallback(
    (item: "search" | "app") => {
      if (ticking.current.has(item)) return;
      ticking.current.add(item);
      void mutate({ action: "gettingStarted.mark", workspaceId: boot.workspace.id, item, done: true }).catch(() => ticking.current.delete(item));
    },
    [mutate, boot.workspace.id],
  );
  // Called by the palette each time it opens.
  const onPaletteOpened = () => {
    if (checklistOpen && !searchTicked) tick("search");
  };
  useEffect(() => {
    if (!checklistOpen || appTicked) return;
    let standalone = false;
    try {
      standalone = matchMedia("(display-mode: standalone)").matches || !!nativeApp() || inDesktopApp();
    } catch {}
    if (standalone) tick("app");
  }, [checklistOpen, appTicked, tick]);
  // Journals get a page for the new day while one of their pages is open:
  // when it opens, comes back to the foreground and at local midnight (the
  // journal page rolls its own journal as well). Other pages do not ask.
  const openedPage = screen === "page" && pageId ? indexById(boot.pages).get(pageId) : undefined;
  // Once per change of the page list, not per render (#610): the palette's
  // "Ohne Journaltage" asks too.
  const workspaceHasJournal = useMemo(() => boot.pages.some((page) => page.kind === "journal" && !page.deleted_at), [boot.pages]);
  const hasJournal = !!openedPage && (openedPage.kind === "journal" || !!openedPage.journal_date) && workspaceHasJournal;
  const rollJournal = useCallback(
    async (pageId: string | null, date: string, recreate = false) => {
      const result = await api<{ changed?: boolean }>("/api/command", {
        action: "journal.roll",
        workspaceId: boot.workspace.id,
        ...(pageId ? { pageId } : {}),
        date,
        zone: localZone(),
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
          zone: localZone(),
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
  // Today's journal entry without a connection (#333, lib/journal-offline.ts):
  // a page on this device only, whose text is appended to the day once the
  // connection is back. The list lives in localStorage (per person).
  const offlineJournalStore = offlineJournalKey(boot.user.id);
  const readOfflineJournal = useCallback(() => {
    try {
      return parseOfflineJournal(localStorage.getItem(offlineJournalStore));
    } catch {
      return [];
    }
  }, [offlineJournalStore]);
  const writeOfflineJournal = useCallback(
    (list: OfflineJournalEntry[]) => {
      try {
        if (list.length) localStorage.setItem(offlineJournalStore, JSON.stringify(list));
        else localStorage.removeItem(offlineJournalStore);
      } catch {}
    },
    [offlineJournalStore],
  );
  const localeRef = useRef(locale);
  localeRef.current = locale;
  // The local page as the editor opens it: no stored state, the text kept
  // in IndexedDB (under its own id and generation) and in the list.
  const offlineDayData = useCallback((entry: OfflineJournalEntry): PageData => {
    const b = bootRef.current;
    const journal = b.pages.find((p) => p.id === entry.journalId);
    const page: Page = {
      id: entry.id,
      workspace_id: b.workspace.id,
      space_id: journal?.space_id || "",
      parent_id: entry.journalId,
      title: journalDayTitle(entry.date, localeRef.current, b.journalDayTitle?.[entry.journalId], b.journalDayTitleCustom?.[entry.journalId]),
      icon: "day",
      cover: "",
      kind: "document",
      position: -Number(entry.date.replaceAll("-", "")),
      deleted_at: null,
      created_by: b.user.id,
      updated_at: new Date(entry.at).toISOString(),
      locked: 0,
      public_token: null,
      full_width: journal?.full_width || 0,
      font: journal?.font || "sans",
      journal_date: entry.date,
      synced: 0,
    };
    return {
      page,
      role: "editor",
      comments: [],
      snapshots: [],
      present: [],
      backlinks: [],
      images: [],
      shareLinks: [],
      draft: { journalId: entry.journalId, date: entry.date, local: true },
      state: null,
      html: entry.html,
      generation: "offline",
    } as unknown as PageData;
  }, []);
  // The editor's text, kept with every change; new text gets a new key.
  const keepOfflineText = useCallback(
    (id: string, text: string) => {
      const list = readOfflineJournal();
      const entry = offlineEntryById(list, id);
      if (!entry || entry.html === text) return;
      writeOfflineJournal(withOfflineEntry(list, { ...entry, html: text, key: crypto.randomUUID(), at: Date.now() }));
    },
    [readOfflineJournal, writeOfflineJournal],
  );
  // Once online: the day is created (or found) and gets the text; an open
  // local page gives way to it. One attempt per entry at a time; a refusal
  // (not a missing connection) is shown once per visit, the text stays.
  const offlineFlushes = useRef(new Map<string, Promise<string | null>>());
  const offlineRefused = useRef(new Set<string>());
  const flushOfflineDay = useCallback(
    (id: string) => {
      const known = offlineFlushes.current.get(id);
      if (known) return known;
      // Refused in this visit: the text stays, the next visit asks again.
      if (offlineRefused.current.has(id)) return Promise.resolve(null);
      const promise = (async () => {
        const isOpen = () => currentId.current === id && dataRef.current?.page.id === id;
        // An open entry: its editor hands on the text at most once a second.
        if (isOpen()) await new Promise((done) => setTimeout(done, 1200));
        const open = isOpen();
        if (open) keepOfflineText(id, html.current);
        const entry = offlineEntryById(readOfflineJournal(), id);
        if (!entry) return null;
        if (!offlineEntryHasText(entry.html)) {
          // Nothing written: nothing to create (an open one stays for writing).
          if (!open) writeOfflineJournal(withoutOfflineEntry(readOfflineJournal(), id));
          return null;
        }
        let result: { dayId?: string; trashed?: boolean };
        try {
          result = await api<{ dayId?: string; trashed?: boolean }>(
            "/api/command",
            keyed({ workspaceId: bootRef.current.workspace.id, ...offlineEntryCommand(entry, localDay()), zone: localZone() }, entry.key),
          );
        } catch (error) {
          if (!deviceOffline() && !isTransient(error) && !offlineRefused.current.has(id)) {
            offlineRefused.current.add(id);
            reportError(error);
          }
          return null;
        }
        // Text typed while the request ran stays for the next attempt.
        const now = offlineEntryById(readOfflineJournal(), id);
        if (now && now.key === entry.key) writeOfflineJournal(withoutOfflineEntry(readOfflineJournal(), id));
        try {
          indexedDB.deleteDatabase(`flowplan:${bootRef.current.user.id}:${id}:page:offline`);
        } catch {}
        void refresh().catch(() => {});
        if (result.dayId && currentId.current === id && screenRef.current === "page") {
          notify(t("Dein offline geschriebener Text steht jetzt in der Seite des Tages.", "What you wrote offline is now on the day's page."));
          void openPageRef.current(result.dayId);
        }
        return result.dayId || null;
      })();
      offlineFlushes.current.set(id, promise);
      void promise.finally(() => offlineFlushes.current.delete(id));
      return promise;
    },
    [readOfflineJournal, writeOfflineJournal, keepOfflineText, refresh, notify, t],
  );
  const flushOfflineDayRef = useRef(flushOfflineDay);
  flushOfflineDayRef.current = flushOfflineDay;
  // Every entry written offline, as soon as there is a connection again.
  useEffect(() => {
    const flushAll = () => {
      if (deviceOffline()) return;
      for (const entry of readOfflineJournal()) void flushOfflineDay(entry.id);
    };
    flushAll();
    window.addEventListener("online", flushAll);
    return () => window.removeEventListener("online", flushAll);
  }, [readOfflineJournal, flushOfflineDay]);
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
  // Collections (#86): open, create, duplicate, delete (with undo), order.
  const openCollection = (id: string) => {
    location.hash = `collection/${id}`;
  };
  const newCollection = (query = "") => setCollectionDraft({ name: "", icon: "", query, shared: false });
  const duplicateCollection = async (c: CollectionInfo) => {
    const result = (await act({ action: "collection.duplicate", collectionId: c.id })) as { id: string } | null;
    if (result?.id) openCollection(result.id);
  };
  const deleteCollection = async (c: CollectionInfo) => {
    if (!(await act({ action: "collection.delete", collectionId: c.id }))) return;
    if (screenRef.current === "collection" && collectionId === c.id) go("home");
    showUndo(t(`Sammlung „${c.name}“ gelöscht.`, `Collection “${c.name}” deleted.`), () => act({ action: "collection.restore", collectionId: c.id }));
  };
  const reorderCollections = (order: string[]) => void act({ action: "collection.reorder", workspaceId: boot.workspace.id, order });
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
  // My tasks opened (#208): the badge of new tasks goes at once.
  const markTasksSeen = useCallback(() => setBoot((b) => (b.newTasks ? { ...b, newTasks: 0 } : b)), []);
  const focusTitleOf = useRef<string | null>(null);
  useEffect(() => {
    if (!shownPage || focusTitleOf.current !== shownPage) return;
    focusTitleOf.current = null;
    const title = document.querySelector<HTMLTextAreaElement>("textarea.page-title");
    title?.focus();
    // "Ohne Titel" (a page from "/Seite", #444): typing replaces it.
    if (title && title.value === t("Ohne Titel", "Untitled")) title.select();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  // A page made offline as the views open it (#370): what the server will
  // create – a document (a template's text), a database with its fields,
  // views and the template's records, an empty board, a notebook with its
  // first sheet and the handwriting kept here.
  const openedLocal = useRef(new Set<string>());
  const localPageData = useCallback(async (change: import("@/lib/offline-queue").OfflinePageChange, state: LocalState): Promise<PageData> => {
    const b = bootRef.current;
    const template = change.starterTemplate ? catalogFor(LOCALE_TAG === "de-DE" ? "de" : "en")[change.starterTemplate] : undefined;
    return buildLocalPage(change, { ...localPageOf(change, b.user.id, state) }, tr, template) as unknown as PageData;
  }, []);
  // For "Retry" on a page that failed to open.
  const openPageRef = useRef<(id: string, target?: PageLocation) => Promise<void>>(async () => {});
  const openPage = useCallback(
    async (id: string, target?: PageLocation, keepNav = false) => {
      // A book or chapter of a library opens as its overview (#329); its
      // own text in the editor with "&edit=1" or a link into it.
      const overview = !target || Object.keys(target).length === 1 ? overviewHash(bootRef.current.pages, bootRef.current.spaces, id) : null;
      if (overview) {
        // Come by its address: that entry gives way, Back skips it.
        if (location.hash === pageLocationHash({ pageId: id })) location.replace(`#${overview}`);
        else location.hash = overview;
        return;
      }
      const version = ++navigationVersion.current;
      navigationPending.current = true;
      screenRef.current = "page";
      currentId.current = id;
      // Today's journal entry written offline (#333): it exists only on this
      // device; online it gives way to the day it creates.
      const localEntry = offlineEntryById(readOfflineJournal(), id);
      if (localEntry) {
        const local = offlineDayData(localEntry);
        if (!keepNav) setMobile(false);
        setScreen("page");
        setPageId(id);
        setComments(false);
        setAiSummary(null);
        setData(local);
        html.current = local.html || "";
        setStatus("Gespeichert");
        setBusy(false);
        setRevalidating(false);
        navigationPending.current = false;
        const hash = pageLocationHash({ pageId: id });
        if (location.hash !== hash) location.hash = hash;
        if (!deviceOffline()) void flushOfflineDayRef.current(id);
        return;
      }
      // A page made offline (#370): built here until the queue created it.
      const localNew = localWaiting(id);
      if (localNew) {
        const local = await localPageData(localNew.change, localNew.state);
        openedLocal.current.add(id);
        if (!keepNav) setMobile(false);
        setScreen("page");
        setPageId(id);
        setComments(false);
        setAiSummary(null);
        setData(local);
        html.current = local.html || "";
        setStatus("Gespeichert");
        setBusy(false);
        setRevalidating(false);
        navigationPending.current = false;
        const hash = pageLocationHash(target || { pageId: id });
        if (location.hash !== hash) location.hash = hash;
        return;
      }
      // Stale-while-revalidate (lib/swr-cache.ts): a page opened recently
      // shows its kept copy at once while the fresh one loads; the editor's
      // sync and the reload below bring it up to date.
      // Whether the kept copy is showing: then the request below only
      // brings it up to date.
      let keptShown = false;
      const showKept = (kept: PageData | undefined) => {
        if (!kept || kept.page.workspace_id !== currentWorkspace.current) return false;
        if (version !== navigationVersion.current || currentId.current !== id) return false;
        keptShown = true;
        setData(kept);
        html.current = kept.html || "";
        setStatus("Gespeichert");
        setBusy(false);
        setRevalidating(true);
        return true;
      };
      // The new page comes in with a short cross-fade of the main pane
      // (lib/view-transition.ts); its title appears in its place (#260).
      const view = transitionView(
        () => {
          if (!keepNav) setMobile(false);
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
        { kind: "page" },
      );
      const hash = pageLocationHash(target || { pageId: id });
      if (location.hash !== hash) location.hash = hash;
      // Asked again: what the last answer said no longer counts.
      setMissingPage((missing) => (missing?.id === id ? null : missing));
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
        // Not there or not shared: the page area says so (PageMissing) – no
        // toast on top, and no retry that could not help.
        if (e instanceof ApiError && (e.status === 403 || e.status === 404) && !e.transient) {
          if (version === navigationVersion.current && currentId.current === id) setMissingPage({ id, status: e.status });
          return;
        }
        // The kept copy stays open offline (#332): that the fresh one could
        // not be fetched without a network is what the offline icon says –
        // no "Keine Verbindung" toast over the page one goes on editing.
        // Without a kept copy, or online, the failure is shown – with Retry
        // only where trying again can help (no network, a server error).
        const kind = classifyError(e).kind;
        if (version === navigationVersion.current)
          reportError(e, {
            retry: kind === "offline" || kind === "server" ? () => void openPageRef.current(id, target) : undefined,
            background: keptShown && currentId.current === id,
          });
        // Opened without a connection and without a kept copy (a journal is
        // never kept, lib/swr-cache.ts): the page area stays empty until the
        // connection is back, then the page loads by itself (#456) – unless
        // another place was opened meanwhile.
        if (kind === "offline" && !keptShown && deviceOffline() && version === navigationVersion.current) {
          const again = () => {
            if (version === navigationVersion.current && currentId.current === id && screenRef.current === "page" && !dataRef.current)
              void openPageRef.current(id, target);
          };
          window.addEventListener("online", again, { once: true });
        }
      } finally {
        if (version === navigationVersion.current) {
          navigationPending.current = false;
          setBusy(false);
          setRevalidating(false);
        }
      }
    },
    [notifyError, readOfflineJournal, offlineDayData, localWaiting, localPageData],
  );
  openPageRef.current = openPage;
  // A page in the other frame (the split view, #279): "In geteilter Ansicht
  // öffnen", the search for it, a page dropped at the right edge. Without
  // tabs (phones) it opens normally; between 768 and 1024 px in a new tab.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const openSplit = useCallback(
    (id: string, from?: number) => {
      if (!tabsRef.current.on) return void openPage(id);
      tabsRef.current.openPlace(`page=${id}`, "side", from);
    },
    [openPage],
  );
  // `keepNav`: the drawer on phones stays open – a workspace switched in
  // the sidebar shows its pages there to pick one (see switchWorkspace).
  function go(s: Screen, keepNav = false) {
    // A command picked after the "+" of the tab bar: the screen opens in
    // the new tab, not in the one in front.
    if (toPlace(s)) return;
    screenRef.current = s;
    transitionView(
      () => {
        setScreen(s);
        if (!keepNav) setMobile(false);
      },
      { kind: "page" },
    );
    if (keepNav && location.hash !== `#${s}`) keepNavOnce.current = true;
    location.hash = s;
  }
  // The library's start with all shelves (#library).
  function openLibraryHome() {
    setLibraryPlace(null);
    go("library");
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
      // The address changed by a workspace switch in the sidebar: the
      // drawer on phones stays open (go, goStart).
      const keepNav = keepNavOnce.current;
      keepNavOnce.current = false;
      if (fragment.startsWith("page=")) {
        const target = parsePageLocation(location.hash);
        if (!target) {
          notifyError(t("Dieser Seitenlink ist ungültig.", "This page link is invalid."));
          return;
        }
        if (currentId.current !== target.pageId || screenRef.current !== "page")
          void openPage(target.pageId, target, keepNav);
        // A block link (#88): scroll to the block, which flashes; the block
        // then leaves the address, so the same link works again.
        if (target.blockId) {
          const blockId = target.blockId;
          jumpTo(target, byBlockId(blockId), 8000, {
            onMissing: () =>
              showToast({
                text: t(
                  "Diesen Block gibt es nicht mehr – die Seite ist geöffnet.",
                  "This block no longer exists – the page is open.",
                ),
              }),
            onDone: () => {
              const here = parsePageLocation(location.hash);
              if (here?.blockId === blockId)
                window.history.replaceState(null, "", `${location.pathname}${location.search}${pageLocationHash({ ...here, blockId: undefined })}`);
            },
          });
        }
      } else if (fragment === LIBRARY_HOME || parseLibraryHash(fragment)) {
        setLibraryPlace(parseLibraryHash(fragment));
        if (screenRef.current !== "library") {
          screenRef.current = "library";
          transitionView(
            () => {
              setScreen("library");
              if (!keepNav) setMobile(false);
            },
            { kind: "page" },
          );
        } else if (!keepNav) setMobile(false);
      } else if (
        ["home", "inbox", "tasks", "graph", "trash", "media", "settings", "tags", "study"].includes(
          fragment,
        ) ||
        /^tags\/[0-9a-f-]{36}$/.test(fragment) ||
        /^collection\/[0-9a-f-]{36}$/.test(fragment) ||
        // A section of the settings or the administration: #settings/account
        // (components/settings/shell.tsx reads the rest).
        parseSettingsHash(fragment)
      ) {
        // The administration's old addresses (#admin/…, #532) are the
        // instance's part of the settings now: replaced, no new step.
        const moved = redirectedSettingsHash(fragment);
        if (moved && fragment.startsWith("admin")) window.history.replaceState(window.history.state, "", `${location.pathname}${location.search}${moved}`);
        const base = (parseSettingsHash(fragment) ? "settings" : fragment.split("/")[0]) as Screen;
        if (base === "collection") setCollectionId(fragment.split("/")[1]);
        if (screenRef.current !== base) {
          screenRef.current = base;
          transitionView(
            () => {
              setScreen(base);
              if (!keepNav) setMobile(false);
            },
            { kind: "page" },
          );
        } else if (!keepNav) setMobile(false);
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
        if (text !== null) openSearch({ query: text.slice(0, 200) });
      }
    };
    // What the app opens with comes without a transition.
    withoutViewTransition(navigate);
    // The address names no other place (or one that does not open): the
    // start page is the right one. Otherwise the layout effect below ends
    // the wait with the commit that draws the place.
    if (screenRef.current === "home") {
      routePendingDone();
      setRouteSettled(true);
    }
    window.addEventListener("hashchange", navigate);
    // The global shortcuts, as the keymap says (lib/keymap.ts; own
    // combinations in the shortcut overlay). Combinations without Ctrl, ⌘ or
    // Alt ("?") do not count while typing.
    const key = (e: KeyboardEvent) => {
      // The navigation drawer on small screens closes like a dialog – unless
      // the Escape closed a dialog or menu above it ("Mehr", #185), which
      // Radix marks handled.
      if (e.key === "Escape" && !e.defaultPrevented) setMobile(false);
      if (e.isComposing || presentingRef.current) return;
      // Ctrl/⌘+P on an open page: the print options first (#215), Enter
      // prints. Elsewhere (and with Shift or Alt) the browser's own.
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && shortcutLetter(e) === "p" && screenRef.current === "page" && dataRef.current && !dataRef.current.encrypted && document.querySelector(".page-content")) {
        e.preventDefault();
        if (!document.querySelector(".print-dialog")) printOpenPageRef.current();
        return;
      }
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
  useLayoutEffect(() => {
    if (screen === "home") return;
    routePendingDone();
    setRouteSettled(true);
  }, [screen]);
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
        // The "New page" dialog with the template chosen: the name first,
        // the template's as a start (#213).
        const sid = space?.id || boot.spaces[0]?.id || "";
        // A template that comes with Flowplan (public gallery).
        if (useTemplate.startsWith("starter:")) {
          const key = useTemplate.slice(8);
          const builtIn = catalogFor(LOCALE_TAG === "de-DE" ? "de" : "en")[key];
          if (!builtIn) throw new Error(t("Diese Vorlage ist nicht mehr verfügbar.", "This template is no longer available."));
          newPageFromTemplate({ starter: key, name: builtIn.name, kind: builtIn.kind }, sid, null, false);
          return;
        }
        const list = await api<{ id: string; name: string; kind: string }[]>(
          `/api/templates?workspace=${boot.workspace.id}`,
        );
        const template = list.find((t) => t.id === useTemplate);
        if (!template)
          throw new Error(t("Diese Vorlage ist nicht mehr verfügbar.", "This template is no longer available."));
        newPageFromTemplate({ saved: template.id, name: template.name, kind: template.kind }, sid, null, false);
      } catch (e) {
        notifyError(e);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useTemplate]);
  // The offline copy follows the workspace while the app is open.
  const offlineNotice = useOfflineRefresh(boot.user.id, online, !signedOut);
  // The iPhone, iPad and Android app offers offline use once and switches it
  // on through the page (lib/app-offline-offer.ts).
  const appOfflineNotice = useAppOfflineOffer(boot.user.id, boot.workspace.id, !!boot.workspace.guest, !!boot.user.demo);
  // "Offline behalten" in the space and page menus while offline use is on (#417).
  const offlineKeep = useOfflineKeep(boot.user.id);
  // Pages made offline (#370) open in the editor, a database, a board or a
  // notebook. While the device's copy of the app's files does not hold
  // this page's build completely (an update whose files are not stored yet,
  // a device short of room), their code loads ahead in the background once
  // the page is up: a page made offline later in this session opens all the
  // same instead of "Not available offline".
  useEffect(() => {
    if (!offlineKeep.enabled) return;
    let stopped = false;
    const timer = setTimeout(() => {
      void offlineMarker().then((marker) => {
        const build = document.querySelector<HTMLMetaElement>(`meta[name="${BUILD_META}"]`)?.content;
        if (stopped || !marker || deviceOffline() || appCopyHolds(marker.app, build)) return;
        for (const load of [loadEditor, loadDatabaseView, loadWhiteboard, loadNotebookView]) void load().catch(() => {});
      }).catch(() => {});
    }, 4000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [offlineKeep.enabled]);
  // The service worker serves offline copies once enabled in the settings.
  useEffect(() => {
    void registerServiceWorker()
      .then(() => checkOfflineOwner(boot.user.id))
      .catch(() => undefined);
  }, [boot.user.id]);
  // The workspace's live signal (#383, components/workspace-live.ts): what
  // changed is fetched when it changes; the timed refresh below is then
  // only a safety net.
  // "Ton bei neuen Benachrichtigungen" (#401): new notifications make a
  // short sound in one open tab.
  const notificationSoundCheck = useRef<() => void>(() => {});
  const live = useWorkspaceSignals(boot.user.id, boot.workspace.id, currentId, refresh, notificationSoundCheck, !signedOut);
  useNotificationSoundAlerts(boot.user.id, boot.notifications, live, notificationSoundCheck);
  useEffect(() => {
    let polling = false;
    // Paused while the tab is hidden, made up for when it is shown (#383).
    return visiblePoll(() => {
      if (polling) return;
      polling = true;
      void refresh()
        .catch(() => {})
        .finally(() => {
          polling = false;
        });
    }, live ? LIVE_REFRESH_MS : POLL_REFRESH_MS);
  }, [refresh, live]);
  // With the signal, the open page in between: the person stays present on it.
  useEffect(() => {
    if (!live) return;
    let polling = false;
    return visiblePoll(() => {
      if (polling) return;
      polling = true;
      void refresh({ boot: false })
        .catch(() => {})
        .finally(() => {
          polling = false;
        });
    }, PRESENCE_REFRESH_MS);
  }, [refresh, live]);
  // A page whose kind is switched off for the instance (#386,
  // lib/instance-modules.ts) opens read-only with a notice.
  const offModule = data ? (data.page.journal_date ? "journal" : PAGE_KIND_MODULE[data.page.kind]) : undefined,
    kindOff = !!offModule && offModules.includes(offModule);
  // May edit the open page – and does, unless it is open for reading.
  const mayEdit = !!data && ["editor", "owner"].includes(data.role) && !data.page.locked && !kindOff,
    canRead = mayEdit && data?.page.kind === "document",
    reading = canRead && readPages.includes(data!.page.id);
  useEffect(() => setReadPages(readModeIds()), []);
  const toggleReading = () => {
    if (!data || !canRead) return;
    setReadPages(toggleReadMode(data.page.id));
  };
  toggleReadingRef.current = toggleReading;
  // Open page comments (not those of database rows), counted on the comments
  // button that phones show only then.
  const openComments = data ? data.comments.filter((c) => !c.row_id && !c.resolved).length : 0;
  // The open document as slides (components/presentation.tsx).
  const startPresentation = () => {
    const d = dataRef.current;
    if (!d || screenRef.current !== "page" || d.page.kind !== "document" || d.locked) {
      notify(t("Präsentieren geht mit einem geöffneten Dokument.", "Presenting works with an open document."));
      return;
    }
    palette.current?.hide();
    setShortcuts(false);
    setPresenting({ html: readHtml(), title: d.page.title || t("Ohne Titel", "Untitled") });
  };
  const splitShown = !!tabs.side;
  // The tab bars: from two tabs on, or with two frames (#279). Only the
  // frames on screen count: a narrow window hides the right one, and its
  // tabs alone must not bring the bar back over a single tab (#291).
  const tabBars = tabs.on && !!tabs.layout && (splitShown || tabs.layout.frames[0].tabs.length > 1);
  const describeTab = (place: string): PlaceLook => {
    const look = describeStep(place);
    return { title: look.title, icon: look.icon };
  };
  // The quick search in split mode: the chosen page opens next to this one.
  const openSplitSearch = () => {
    if (!wideRef.current) {
      notify(t("Die geteilte Ansicht braucht ein Fenster breiter als 1024 Pixel.", "Split view needs a window wider than 1024 pixels."));
      return;
    }
    openSearch({ split: true });
  };
  // "KI fragen" (#59): a panel beside the page, not a dialog. Every entry
  // point (sidebar, command palette, search, shortcut) opens it this way.
  const askRef = useRef(ask);
  askRef.current = ask;
  const openAsk = (question: string) => {
    setMobile(false);
    setAsk({ question, n: Date.now() + Math.random() });
  };
  // The panel and the comments share the right edge: opening one closes
  // the other, so neither squeezes the page or covers the other.
  const askOpen = !!ask;
  const [askMounted, setAskMounted] = useState(false);
  useEffect(() => {
    if (!askOpen) return;
    setAskMounted(true);
    setComments(false);
    evictDock();
  }, [askOpen]);
  useEffect(() => {
    if (!comments) return;
    setAsk(null);
    evictDock();
  }, [comments]);
  // The docked side panel of a record or a PDF (#392, lib/side-dock.ts)
  // takes the same edge: opening it closes the other two.
  const dock = useSyncExternalStore(subscribeDock, dockState, serverDockState);
  useEffect(() => {
    if (!dock) return;
    setAsk(null);
    setComments(false);
    // Opened from a hit of the search (its menu): the search closes.
    if (searchOpen()) closeSearch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dock?.owner]);
  // Narrow wide screens (an iPad, a small window): the panel lies over the
  // page; pinned beside it, the sidebar makes room while the panel is open
  // and comes back when it closes or lies over the page again – unless the
  // person changed it in between.
  const askDockedNarrow = askOpen && askPinned && askNarrowWindow;
  const askCollapsed = useRef(false);
  useEffect(() => {
    if (askDockedNarrow) {
      if (!desktopCollapsed) {
        askCollapsed.current = true;
        setDesktopCollapsed(true);
      }
    } else if (askCollapsed.current) {
      askCollapsed.current = false;
      setDesktopCollapsed(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askDockedNarrow]);
  useEffect(() => {
    if (!desktopCollapsed) askCollapsed.current = false;
  }, [desktopCollapsed]);
  const runShortcut = (action: ShortcutAction) => {
    switch (action) {
      case "search":
        // Open: closes and keeps what was typed for the next time.
        if (searchOpen()) palette.current?.hide();
        else openSearch({ split: false });
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
        toggleCollapsed();
        break;
      case "focusMode":
        if (screenRef.current === "page" && dataRef.current) setFocusMode((v) => !v);
        break;
      case "comments":
        if (screenRef.current === "page" && dataRef.current) setComments((v) => !v);
        break;
      case "ask":
        // Closed: opens. Open: focus moves into it, or – from inside – it closes.
        if (!aiUsable(uiAi, "ask")) break;
        if (askRef.current && document.querySelector(".ask-panel")?.contains(document.activeElement)) setAsk(null);
        else openAsk("");
        break;
      case "theme":
        toggleTheme();
        break;
      case "splitView":
        if (splitShown) tabs.closeFrame(1);
        else openSplitSearch();
        break;
      case "present":
        startPresentation();
        break;
      case "journalToday":
        if (featureShown("journal") && placeShown("journal")) openLastJournalToday();
        break;
      case "foldAll":
      case "unfoldAll":
        foldAllSections(action === "foldAll");
        break;
      case "back":
        goBack();
        break;
      case "forward":
        goForward();
        break;
      case "study":
        if (featureShown("flashcards") && placeShown("study")) go("study");
        break;
    }
  };
  shortcutRef.current = runShortcut;
  // "Drucken / PDF" of the open page: the options dialog, then the copy.
  printOpenPageRef.current = () => requestPrint({ kind: "page", run: (options) => printPage(undefined, options) });
  // Hints in titles follow the own shortcuts ("Lesemodus (⌘ ⌥ E)").
  const hint = (action: ShortcutAction) => {
    const keys = keyHints.visible ? shortcutHint(action, mac) : "";
    return keys ? ` (${keys})` : "";
  };
  // How a place of the back and forward lists reads (components/history-
  // buttons.tsx): pages with their icon and current title, records with
  // their title (remembered while they were open) and their database,
  // screens and sections of the settings with their name.
  const describeStep = (hash: string): StepLook => {
    const kept = rememberedTitle(hash);
    const screenLook = (title: string, Icon: typeof House): StepLook => ({ title, icon: <Icon size={16} /> });
    if (hash.startsWith("page=")) {
      const target = parsePageLocation(hash);
      const page = target ? titledPages.find((p) => p.id === target.pageId) : undefined;
      const pageTitle = page ? page.title || t("Ohne Titel", "Untitled") : "";
      if (target?.rowId) {
        const open = document.querySelector<HTMLTextAreaElement>(":is(.modal.record-dialog, .record-page) .row-title-input");
        const now = parsePageLocation(location.hash);
        const title = (now?.rowId === target.rowId && open?.value.trim()) || "";
        return {
          title: title || kept?.title || t("Eintrag", "Record"),
          detail: pageTitle || undefined,
          icon: <PageIcon name={page ? shownPageIcon(page.icon, page.kind) : kept?.icon || ""} size={16} />,
          remember: title ? { title, icon: page?.icon } : undefined,
        };
      }
      const title = pageTitle || kept?.title || t("Seite", "Page");
      return { title, icon: <PageIcon name={page ? shownPageIcon(page.icon, page.kind) : kept?.icon || ""} size={16} />, remember: page ? { title, icon: page.icon } : undefined };
    }
    const settings = parseSettingsHash(hash);
    if (settings) {
      const area = settings.area === "admin" ? t("Einstellungen: Instanz", "Settings: instance") : t("Einstellungen", "Settings");
      const section = findSection(settings.area, settings.section);
      return {
        title: section ? t(section.title.de, section.title.en) : t("Einstellungen", "Settings"),
        detail: section ? area : undefined,
        icon: <GearSix size={16} />,
      };
    }
    const [base, id] = hash.split("/");
    if (hash === LIBRARY_HOME) return screenLook(t("Bibliothek", "Library"), Books);
    const library = parseLibraryHash(hash);
    if (library) {
      const space = boot.spaces.find((sp) => sp.id === library.spaceId);
      const book = library.bookId ? titledPages.find((p) => p.id === (library.chapterId || library.bookId)) : undefined;
      const name = book ? book.title || t("Ohne Titel", "Untitled") : space?.name;
      return { title: name || kept?.title || t("Bibliothek", "Library"), detail: book ? space?.name : undefined, icon: <Books size={16} />, remember: name ? { title: name } : undefined };
    }
    if (base === "collection") {
      const name = boot.collections?.find((c) => c.id === id)?.name;
      return { title: name || kept?.title || t("Sammlung", "Collection"), icon: <FolderSimple size={16} />, remember: name ? { title: name } : undefined };
    }
    if (base === "tags" && id) return { title: kept?.title || t("Tag", "Tag"), detail: t("Tags", "Tags"), icon: <TagIcon size={16} /> };
    switch (base) {
      case "inbox":
        return screenLook(t("Posteingang", "Inbox"), Bell);
      case "tasks":
        return screenLook(t("Meine Aufgaben", "My tasks"), CheckSquare);
      case "tags":
        return screenLook(t("Tags", "Tags"), TagIcon);
      case "graph":
        return screenLook(t("Graph", "Graph"), Graph);
      case "media":
        return screenLook(t("Medien", "Media"), ImageSquare);
      case "study":
        return screenLook(t("Lernen", "Study"), Cards);
      case "trash":
        return screenLook(t("Papierkorb", "Trash"), Trash);
      default:
        return screenLook(t("Startseite", "Home"), House);
    }
  };
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
  // Another page – or another place of the app – starts at its top (#224,
  // #262); back and forward bring a place back where it was left in that
  // step (lib/pane-scroll.ts). The pane keeps its position across renders:
  // a page whose kept copy (lib/swr-cache.ts) came in at full height at once
  // showed up as far down as the page before. A block or comment link
  // scrolls to its target after this (lib/jump.ts); the same page
  // re-rendered keeps its position; the right page of the split view
  // scrolls on its own.
  const mainScroll = useRef<HTMLDivElement>(null);
  // A page still loading is no place yet (null).
  const shownPlace =
    screen === "page"
      ? data
        ? `page:${data.page.id}`
        : null
      : screen === "library"
        ? `library:${libraryPlace?.spaceId ?? ""}:${libraryPlace?.bookId ?? ""}:${libraryPlace?.chapterId ?? ""}`
        : `${screen}:${collectionId ?? ""}`;
  usePaneScroll(mainScroll, shownPlace, tabs.on ? tabs.entryKey : undefined);
  // Encrypted titles are decrypted here, in the browser, once unlocked.
  const titledPages = useDecryptedTitles(boot.pages, boot.spaces);
  // The record open in the database page (components/database-view.tsx,
  // #231): the breadcrumb's last segment; "full": shown as a page of its
  // own, in place of the database's title and actions.
  const [recordView, setRecordView] = useState<{ rowId: string; title: string; icon: string; full: boolean } | null>(null);
  const recordFull = screen === "page" && data?.page.kind === "database" && !!recordView?.full;
  const e2eeState = useE2ee();
  // The library shown (#329) and the library the open page belongs to (its
  // book navigation): only spaces switched to "Als Bibliothek anzeigen".
  const librarySpace = screen === "library" && libraryPlace ? boot.spaces.find((sp) => sp.id === libraryPlace.spaceId && !sp.deleted_at) : undefined;
  // "Bibliothek" in the main navigation: once a space one sees is a library.
  const hasLibrary = boot.spaces.some((sp) => sp.library && !sp.deleted_at);
  // Shelves whose access the person may change ("Wer sieht dieses Regal?").
  const manageableSpaces = useMemo(() => new Set((boot.managedSpaces || []).map((sp) => sp.id)), [boot.managedSpaces]);
  const pageLibrary = screen === "page" && data && !data.journalDay ? boot.spaces.find((sp) => sp.id === data.page.space_id && sp.library) : undefined;
  // Drafts of saved templates (#461) are opened from the templates only:
  // not in the tree, the pickers or the lists.
  const activePages = useMemo(() => titledPages.filter((p) => !p.deleted_at && !p.template_draft), [titledPages]),
    // Database pickers group by space and name twins apart (#520).
    databaseLabels = useMemo(() => ({ spaces: boot.spaces.filter((sp) => !sp.deleted_at).map((sp) => ({ id: sp.id, name: sp.name })), pages: activePages }), [boot.spaces, activePages]),
    // The tree's levels in one pass: sub pages per parent, top-level pages
    // per space ("space:<id>") – no search through all pages per row.
    treeIndex = useMemo(() => {
      const ids = new Set(activePages.map((p) => p.id));
      // Pages below a record (#231) sit below the record ("row:<db>:<row>"),
      // when the record is readable; otherwise below the database.
      const records = new Set((boot.recordParents || []).map((r) => `${r.pageId}:${r.rowId}`));
      const index = new Map<string, Page[]>();
      for (const p of activePages) {
        const key =
          p.parent_id && ids.has(p.parent_id)
            ? p.parent_row_id && records.has(`${p.parent_id}:${p.parent_row_id}`)
              ? `row:${p.parent_id}:${p.parent_row_id}`
              : p.parent_id
            : `space:${p.space_id}`;
        const list = index.get(key);
        if (list) list.push(p);
        else index.set(key, [p]);
      }
      return index;
    }, [activePages, boot.recordParents]),
    // The records of a database that have sub-pages, by title.
    recordItems = useMemo(() => {
      const byDatabase = new Map<string, NonNullable<Bootstrap["recordParents"]>>();
      for (const r of boot.recordParents || []) {
        if (!treeIndex.has(`row:${r.pageId}:${r.rowId}`)) continue;
        byDatabase.set(r.pageId, [...(byDatabase.get(r.pageId) || []), r]);
      }
      for (const list of byDatabase.values()) list.sort((a, b) => (a.title || "").localeCompare(b.title || "", LOCALE_TAG));
      return byDatabase;
    }, [boot.recordParents, treeIndex]),
    editable = mayEdit && !reading,
    sourceOpen = !!data && data.page.kind === "document" && !data.locked && sourcePage === data.page.id,
    // The page's text is the document editor, with block handles while
    // editable: its head starts where the text starts, the handles' room
    // left of it (#603, .with-block-room in app/globals.css). The same
    // cases as the views below.
    blockRoom =
      !!data &&
      editable &&
      !data.locked &&
      !data.encrypted &&
      !(
        data.page.kind === "database" ||
        (data.page.kind === "journal" && !!data.journal) ||
        (data.page.kind === "notebook" && !!data.notebook) ||
        (data.page.kind === "dashboard" && !!data.dashboard) ||
        (data.page.kind === "workflow" && !!data.workflow) ||
        (data.page.kind === "whiteboard" && !!data.whiteboard)
      ),
    canCreate = boot.workspace.role !== "viewer" && !boot.workspace.guest,
    favorites = activePages.filter((p) => boot.favorites.includes(p.id)),
    // Journals whose "Heute" link is a favourite (#537), at the journal's
    // place among the favourites.
    todayFavorites = activePages.filter((p) => p.kind === "journal" && !!boot.todayFavorites?.includes(p.id)),
    // The journal whose "Heute" favourite the open page (the journal or one
    // of its days) can add or remove.
    todayJournal = data?.page.kind === "journal" ? data.page : data?.journalDay ? activePages.find((p) => p.id === data.journalDay!.journalId) : undefined,
    shareSpace = boot.spaces.find((s) => s.id === data?.page.space_id);
  // Links in documents show the icons of these pages (#96) and follow
  // their changes like titles do (components/page-link-icons.tsx).
  useEffect(() => setLinkTargetPages(activePages), [activePages]);
  // Editors deep below read whether pages may be created here (#118).
  useEffect(() => setCanCreatePages(canCreate), [canCreate]);
  // A page created from inside a document (a table turned into a database,
  // #118) shows in the sidebar at once instead of on the next poll.
  useEffect(() => {
    const changed = () => void refresh().catch(() => {});
    window.addEventListener("flowplan:pages-changed", changed);
    // The person picked another AI model (#538, components/ai-model-choice.tsx).
    window.addEventListener("flowplan:ai-changed", changed);
    return () => {
      window.removeEventListener("flowplan:pages-changed", changed);
      window.removeEventListener("flowplan:ai-changed", changed);
    };
  }, [refresh]);
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
    setBranchNote("");
    setSpaceMoveNote(
      t(`„${space.name}“ steht jetzt an Position ${at} von ${order.length}.`, `“${space.name}” is now at position ${at} of ${order.length}.`),
    );
  }
  // What is folded in the sidebar, stored in the account and the same on
  // every device (#97, components/sidebar-folds-state.ts): pages start
  // folded (p:<id> unfolds one), spaces and groups open (s:<id>, g:<name>
  // fold them), journal folders follow lib/journal-nav.ts (jo:/jc:).
  const folds = useSidebarFolds(boot.workspace.id, boot.sidebar);
  const navCompact = folds.has("g:nav");
  // Favoriten and Sammlungen: open on wider screens until folded (g:), on
  // phones folded until opened (go:, #616) – there the spaces come first.
  // Either choice is stored for every device, as before.
  const groupFolded = (group: "favorites" | "collections") =>
    folds.has(`g:${group}`) || (phone && !folds.has(`go:${group}`));
  const foldGroup = (group: "favorites" | "collections", fold: boolean) =>
    folds.change({ [`g:${group}`]: fold, [`go:${group}`]: !fold });
  // A library (#329) starts folded: its tree opens by hand (so:<space>).
  const foldSpace = (id: string, fold: boolean) =>
    folds.change(boot.spaces.find((sp) => sp.id === id)?.library ? { [`so:${id}`]: !fold } : { [`s:${id}`]: fold });
  const journalFolders = useMemo(() => journalFolds(folds.keys), [folds.keys]);
  // The way to the open page unfolds, for this visit only (not stored):
  // nothing else folds. Folding one of those pages by hand closes it.
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(() => new Set());
  // A record opened as a page with sub-pages (#231) is listed below its
  // database: the database unfolds like the parent of an open page.
  const recordInTree =
    recordFull && !!recordView && boot.pages.some((p) => p.parent_id === pageId && p.parent_row_id === recordView.rowId && !p.deleted_at);
  const openPath = screen === "page" && pageId ? [...(recordInTree ? [pageId] : []), ...ancestorIds(boot.pages, pageId)].join(",") : "";
  // Updated while rendering (not in an effect): the tree never shows the
  // open page folded away first.
  const [revealedPath, setRevealedPath] = useState("");
  if (revealedPath !== openPath) {
    setRevealedPath(openPath);
    const missing = openPath ? openPath.split(",").filter((id) => !revealed.has(id)) : [];
    if (missing.length) setRevealed(new Set([...revealed, ...missing]));
  }
  const pageOpen = (id: string) => folds.has(`p:${id}`) || revealed.has(id);
  // Records in the tree (#231, "<database>:<record>"): folded until
  // unfolded, for this visit; the way to the open page unfolds its record.
  const [recordFolds, setRecordFolds] = useState<{ open: ReadonlySet<string>; closed: ReadonlySet<string> }>(() => ({ open: new Set(), closed: new Set() })),
    [recordDrop, setRecordDrop] = useState<string | null>(null);
  const revealedRecords = useMemo(() => {
    const out = new Set<string>();
    if (screen !== "page" || !pageId) return out;
    const byId = new Map(boot.pages.map((p) => [p.id, p]));
    for (let at = byId.get(pageId), n = 0; at && n < 64; at = at.parent_id ? byId.get(at.parent_id) : undefined, n++)
      if (at.parent_row_id && at.parent_id) out.add(`${at.parent_id}:${at.parent_row_id}`);
    return out;
  }, [boot.pages, screen, pageId]);
  const recordOpen = (key: string) => recordFolds.open.has(key) || (revealedRecords.has(key) && !recordFolds.closed.has(key));
  const foldRecord = (key: string, fold: boolean) =>
    setRecordFolds((current) => {
      const open = new Set(current.open),
        closed = new Set(current.closed);
      if (fold) {
        open.delete(key);
        closed.add(key);
      } else {
        open.add(key);
        closed.delete(key);
      }
      return { open, closed };
    });
  const foldPage = (id: string, fold: boolean) => {
    if (fold)
      setRevealed((current) => {
        if (!current.has(id)) return current;
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    folds.change({ [`p:${id}`]: !fold });
  };
  // A branch of the tree focused in the sidebar (#318, lib/sidebar-branch.ts):
  // the tree shows that page as its root, with "←", the path and "×" above.
  // Per workspace on this device; a page opened outside the branch shows the
  // whole tree again (with a hint), so the open page is always in the tree.
  const [treeBranch, setTreeBranchState] = useState<string | null>(null),
    [branchNote, setBranchNote] = useState("");
  const branchPage = treeBranch ? activePages.find((p) => p.id === treeBranch) : undefined;
  const branchRef = useRef<string | null>(null);
  branchRef.current = branchPage ? branchPage.id : null;
  useEffect(() => {
    setTreeBranchState(readBranch(localStorage, boot.workspace.id, boot.pages));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boot.workspace.id]);
  // Its page deleted or gone: the whole tree, also after a reload.
  useEffect(() => {
    if (treeBranch && !branchPage) {
      setTreeBranchState(null);
      writeBranch(localStorage, boot.workspace.id, null);
    }
  }, [treeBranch, branchPage, boot.workspace.id]);
  const setTreeBranch = (id: string | null, { moveFocus = false } = {}) => {
    const before = branchRef.current;
    if (id === before) return;
    const page = id ? activePages.find((p) => p.id === id) : undefined;
    setTreeBranchState(page ? page.id : null);
    branchRef.current = page ? page.id : null;
    writeBranch(localStorage, boot.workspace.id, page ? page.id : null);
    const untitled = t("Ohne Titel", "Untitled");
    setSpaceMoveNote("");
    setBranchNote(
      page
        ? t(`Seitenbaum auf „${page.title || untitled}“ fokussiert`, `Page tree focused on “${page.title || untitled}”`)
        : t("Ganzer Seitenbaum", "Whole page tree"),
    );
    // Back in the whole tree: the way to the branch stays unfolded, so it
    // is found where it was.
    if (!page && before) {
      setRevealed((current) => new Set([...current, before, ...ancestorIds(boot.pages, before)]));
      const space = activePages.find((p) => p.id === before)?.space_id;
      if (space && folds.has(`s:${space}`)) foldSpace(space, false);
    }
    if (page || before) setTreeFocus(page ? page.id : before);
    // A header button that went away (a crumb, "×"): the focus goes to the
    // root of the tree shown now, or the page focused before.
    if (moveFocus)
      requestAnimationFrame(() => {
        const active = document.activeElement;
        if (active && active !== document.body && active.isConnected) return;
        treeRoot.current?.querySelector<HTMLElement>(`[role="tree"] [data-tree-id="${page ? page.id : before}"]`)?.focus();
      });
  };
  const hasSubPages = (id: string) => activePages.some((p) => p.parent_id === id);
  // Opening a page outside the branch leaves it. Not for the page the app
  // opens with (the address after a reload): only changes after that.
  const branchSeen = useRef<{ armed: boolean; page: string | null }>({ armed: false, page: null });
  useEffect(() => {
    const seen = branchSeen.current;
    if (screen === "page" && pageId) {
      const branch = branchRef.current;
      if (seen.armed && branch && leavesBranch(activePages, branch, seen.page, pageId)) {
        const from = activePages.find((p) => p.id === branch),
          to = activePages.find((p) => p.id === pageId);
        const untitled = t("Ohne Titel", "Untitled");
        setTreeBranch(null);
        showToast({
          text: t(
            `„${to?.title || untitled}“ liegt nicht unter „${from?.title || untitled}“ – der Seitenbaum zeigt wieder alles.`,
            `“${to?.title || untitled}” is not below “${from?.title || untitled}” – the page tree shows everything again.`,
          ),
          action: { label: t("Wieder fokussieren", "Focus again"), run: () => setTreeBranch(branch) },
        });
      }
      branchSeen.current = { armed: true, page: pageId };
    } else if (!location.hash.startsWith("#page=")) branchSeen.current = { armed: true, page: null };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, pageId]);
  // "Alle aufklappen" / "Alle zuklappen" in a space's menu.
  const foldAll = (spaceId: string, open: boolean) => {
    if (!open) {
      const inSpace = new Set(boot.pages.filter((p) => p.space_id === spaceId).map((p) => p.id));
      setRevealed((current) => new Set([...current].filter((id) => !inSpace.has(id))));
    }
    folds.change(spaceFoldChanges(boot.pages, spaceId, open));
    if (open) foldSpace(spaceId, false);
  };
  // Opening a page unfolds its space.
  const openSpaceId = screen === "page" && pageId ? boot.pages.find((p) => p.id === pageId)?.space_id : undefined;
  useEffect(() => {
    // Not a library (#329): its book navigation leads on, the tree stays folded.
    if (openSpaceId && !boot.spaces.find((sp) => sp.id === openSpaceId)?.library) foldSpace(openSpaceId, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSpaceId]);
  // The space one is in (#317) – where the template gallery looks and a page
  // made from a template goes: the open page's, else the one of the page
  // opened last in this visit, else the first space open in the sidebar,
  // else the first space.
  const [lastSpaceId, setLastSpaceId] = useState<string | null>(null);
  const shownSpaceId = openSpaceId ?? (screen === "page" ? data?.page.space_id : undefined);
  if (shownSpaceId && shownSpaceId !== lastSpaceId) setLastSpaceId(shownSpaceId);
  const liveSpaces = boot.spaces.filter((sp) => !sp.deleted_at);
  const currentSpaceId =
    [shownSpaceId, lastSpaceId].find((sid) => sid && liveSpaces.some((sp) => sp.id === sid)) ??
    liveSpaces.find((sp) => !folds.has(`s:${sp.id}`))?.id ??
    liveSpaces[0]?.id ??
    "";
  function addPage(
    kind: PageKind = "document",
    parentId: string | null = null,
    sid?: string,
    // Below this record of the parent database (#231).
    rowId: string | null = null,
  ) {
    // Offline the dialog opens too (#370): what can be made on the device
    // is made there; the rest says it needs the connection when chosen.
    if (rowId && needsConnection()) return;
    setParentRow(rowId);
    if (!boot.spaces.length) {
      setNewSpace(true);
      return;
    }
    setNewKind(kind);
    setDatabaseChoice(rememberedDatabaseKind());
    setStarterTemplate(null);
    setSavedTemplate(null);
    setSuggestedTitle(null);
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
  // Files uploaded straight into a space (#569, components/file-page-uploads.tsx):
  // each file a page of its own, at the top level of the space or below a
  // page – dropped on the tree, "Datei hochladen …" ("Neue Seite", a
  // space's menu) and the media view's upload. The pages are made on the
  // server with the file (page.create, as from "Neue Seite"), so they need
  // the connection; encrypted spaces encrypt files and titles in the
  // browser and keep the upload into a page.
  const filePages = useFilePageUploads({
    onCreated: (page) => {
      if (page.parentId) foldPage(page.parentId, false);
      else foldSpace(page.spaceId, false);
      window.dispatchEvent(new Event("flowplan:pages-changed"));
    },
    onOpen: (id) => void openPage(id),
  });
  // Where files from the computer are being dragged: "s:<space>" or "p:<page>".
  const [fileDrop, setFileDrop] = useState<string | null>(null);
  const [fileUploadDialog, setFileUploadDialog] = useState(false);
  useEffect(() => {
    // Dropped elsewhere or dragged out of the window: no highlight left.
    const end = (e: DragEvent) => {
      if (e.type !== "dragleave" || !e.relatedTarget) setFileDrop(null);
    };
    window.addEventListener("drop", end);
    window.addEventListener("dragend", end);
    document.addEventListener("dragleave", end);
    return () => {
      window.removeEventListener("drop", end);
      window.removeEventListener("dragend", end);
      document.removeEventListener("dragleave", end);
    };
  }, []);
  const filePagesAllowed = (sid: string, parentId: string | null) => {
    if (!canCreate) return false;
    const space = boot.spaces.find((s) => s.id === sid) as { encrypted?: number; encrypt_titles?: number } | undefined;
    if (!space) return false;
    if (space.encrypted || space.encrypt_titles) {
      showNotice(
        t(
          "In verschlüsselten Bereichen kannst du Dateien nur in eine Seite ziehen, nicht als eigene Seiten hochladen.",
          "In encrypted spaces you can only drop files into a page, not upload them as pages of their own.",
        ),
      );
      return false;
    }
    if (needsConnection()) return false;
    if (parentId && isPendingPage(parentId)) {
      showNotice(offlineNoteText());
      return false;
    }
    return true;
  };
  const uploadFilePages = (files: File[], sid: string, parentId: string | null) => {
    if (files.length && filePagesAllowed(sid, parentId)) filePages.upload(files, { spaceId: sid, parentId });
  };
  // The file picker, from a click.
  const pickFilePages = (sid: string, parentId: string | null) => {
    if (filePagesAllowed(sid, parentId)) filePages.pick({ spaceId: sid, parentId });
  };
  // A book, chapter or page from a library's own small dialog (#329,
  // components/library-view.tsx): a document with the given name; the
  // library then shows where it goes. Titles of an encrypted space are
  // encrypted here as in "Neue Seite"; offline it needs the connection.
  async function createLibraryPage(sid: string, parentId: string | null, title: string): Promise<string | null> {
    if (deviceOffline()) {
      showNotice(offlineNoteText());
      return null;
    }
    const encrypted = !!(boot.spaces.find((s) => s.id === sid) as { encrypt_titles?: number } | undefined)?.encrypt_titles;
    if (encrypted && !e2eeState.unlocked) {
      setE2eeDialog("unlock");
      return null;
    }
    const result = await act({ action: "page.create", workspaceId: boot.workspace.id, spaceId: sid, parentId, title: encrypted ? ENCRYPTED_TITLE : title, kind: "document" });
    const id = result?.id ? String(result.id) : null;
    if (id && encrypted)
      try {
        await openSpace(sid);
        await act({ action: "e2ee.title", pageId: id, cipher: await encryptTitle(sid, id, title) });
      } catch (error) {
        notifyError(error);
      }
    return id;
  }
  // "/Seite" in the editor (#444, components/sub-page-create.ts): an empty
  // sub-page of the page (of a record: below the record, #231) – offline
  // made on this device as from "Neue Seite" (#370; a record's sub-page
  // and pages of encrypted spaces need the connection), encrypted titles
  // as there – and opened where the editor is, its title focused.
  const subPageImpl = useRef<SubPageCreator | null>(null);
  subPageImpl.current = {
    create: async (hostId, rowId) => {
      // A page the list does not have yet (made elsewhere a moment ago): asked for.
      const host =
        activePages.find((p) => p.id === hostId) ??
        (deviceOffline() ? undefined : (await api<{ page: Page }>(`/api/pages/${hostId}`).catch(() => null))?.page);
      if (!host) throw new Error(t("Die Seite wurde nicht gefunden.", "The page was not found."));
      const title = t("Ohne Titel", "Untitled");
      const space = boot.spaces.find((s) => s.id === host.space_id) as { encrypted?: number; encrypt_titles?: number } | undefined;
      if (deviceOffline() || isPendingPage(host.id)) {
        if (rowId || space?.encrypted || space?.encrypt_titles) {
          showNotice(offlineNoteText());
          return null;
        }
        const id = crypto.randomUUID();
        offlineQueue.addPage(
          pageChange({
            id,
            workspaceId: host.workspace_id,
            spaceId: host.space_id,
            parentId: host.id,
            kind: "document",
            title,
            newId: () => crypto.randomUUID(),
            key: newIdempotencyKey(),
            at: Date.now(),
          }),
        );
        return { id, title };
      }
      const encrypted = !!space?.encrypt_titles;
      if (encrypted && !e2eeState.unlocked) {
        setE2eeDialog("unlock");
        return null;
      }
      const result = await act({
        action: "page.create",
        workspaceId: host.workspace_id,
        spaceId: host.space_id,
        parentId: host.id,
        ...(rowId ? { parentRowId: rowId } : {}),
        title: encrypted ? ENCRYPTED_TITLE : title,
        kind: "document",
      });
      const id = result?.id ? String(result.id) : null;
      if (!id) return null;
      if (encrypted)
        try {
          await openSpace(host.space_id);
          await act({ action: "e2ee.title", pageId: id, cipher: await encryptTitle(host.space_id, id, title) });
        } catch (error) {
          notifyError(error);
        }
      window.dispatchEvent(new Event("flowplan:pages-changed"));
      return { id, title };
    },
    open: (id, origin) => {
      // In the right frame it stays there.
      if (tabs.on && frameOfElement(origin) === 1 && tabs.openPlace(`page=${id}`, "here", 1)) return;
      focusTitleOf.current = id;
      location.hash = pageLocationHash({ pageId: id });
    },
  };
  useEffect(
    () =>
      setSubPageCreator({
        create: (hostId, rowId) => subPageImpl.current!.create(hostId, rowId),
        open: (id, origin) => subPageImpl.current!.open(id, origin),
      }),
    [],
  );
  // A template chosen for the "New page" dialog (#213): a name typed there
  // before stays; otherwise the template's name goes into the field,
  // selected, so typing replaces it and Enter creates the page. `typed`:
  // chosen from the dialog, whose name field may hold a name typed by hand.
  function newPageFromTemplate(
    template: { starter: string; name: string; kind: string } | { saved: string; name: string; kind: string; meta?: MetaPlan },
    sid: string,
    parentId: string | null,
    typed: boolean,
  ) {
    // Offline only built-in templates whose content comes with the app (#370).
    if ((!("starter" in template) || !offlineTemplate(template.starter, catalogFor(LOCALE_TAG === "de-DE" ? "de" : "en")[template.starter])) && needsConnection()) return;
    if (!typed || !newTitle.trim() || newTitle === suggestedTitle) {
      setNewTitle(template.name);
      setSuggestedTitle(template.name);
    }
    setStarterTemplate("starter" in template ? template.starter : null);
    setSavedTemplate("saved" in template ? { id: template.saved, name: template.name, meta: template.meta, metaSpace: sid } : null);
    setNewKind(template.kind as PageKind);
    setSpaceId(sid);
    setParent(parentId);
    setCreate(true);
  }
  // The shell stays inert until the other workspace has loaded, so settings,
  // exports and new pages cannot act on the one being left.
  const [switching, setSwitching] = useState(false);
  const latestSwitch = useRef(0);
  // The first place of a workspace switched to: its tabs' active one
  // (#279), else the start page.
  // The open page went to the trash (#553): on to its parent page – the
  // nearest one that is still there – or the start page, instead of the
  // trash. The undo note says where it went and takes it back.
  function leaveDeleted(id: string | null) {
    const pages = bootRef.current.pages;
    let parent = id ? pages.find((p) => p.id === id)?.parent_id : null;
    while (parent) {
      const page = pages.find((p) => p.id === parent);
      if (page && !page.deleted_at) {
        void openPage(page.id);
        return;
      }
      parent = page?.parent_id ?? null;
    }
    setPageId(null);
    go("home");
  }
  function goStart(b: Bootstrap, keepNav: boolean) {
    const place = tabsRef.current.switchTo(b.workspace.id, validPlaceIn(b.pages, !!b.user.isAdmin));
    if (!place || place === "home") return go("home", keepNav);
    if (location.hash !== `#${place}`) {
      if (keepNav) keepNavOnce.current = true;
      location.hash = place;
    }
  }
  // `fromSidebar`: switched in the sidebar's workspace menu (or a workspace
  // created there). On phones the drawer then stays open, showing the new
  // workspace's pages to pick one; a switch from elsewhere (a notification,
  // a link, Settings, a moved page) closes it as any navigation does.
  async function switchWorkspace(id: string, { fromSidebar = false } = {}) {
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
      goStart(kept, fromSidebar);
    }
    try {
      const b = await api<Bootstrap>(`/api/bootstrap?workspace=${id}`);
      if (version !== navigationVersion.current) return;
      currentWorkspace.current = b.workspace.id;
      setBoot(b);
      setPageId(null);
      currentId.current = null;
      setData(null);
      goStart(b, fromSidebar);
      setSpaceId(b.spaces[0]?.id || "");
    } catch (e) {
      if (kept && version === navigationVersion.current) setBoot(previous);
      if (version === navigationVersion.current) notifyError(e, () => void switchWorkspace(id, { fromSidebar }));
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
  const pagesLabel = (n: number) => (n === 1 ? t("1 Seite", "1 page") : t(`${n} Seiten`, `${n} pages`));
  // More actions for the selected pages (#275): in the selection bar's
  // "…" menu and in the context menu of a selected page. Locking is offered
  // like the single "Seite sperren" (members who may create pages); the
  // server skips the pages the person may not change.
  function selectionMenuItems() {
    const chosen = selectedPages
      .map((id) => activePages.find((p) => p.id === id))
      .filter((p): p is Page => !!p);
    const n = chosen.length;
    const toLock = chosen.filter((p) => !p.locked).length,
      toStar = chosen.filter((p) => !boot.favorites.includes(p.id)).length;
    const count = (k: number, all: string, some: string) => (k === n ? all : some);
    return (
      <>
        {canCreate && toLock > 0 && (
          <Dropdown.Item className="dropdown-item" disabled={bulkBusy} onSelect={() => void bulkPages("lock")}>
            <Lock />
            {count(toLock, t("Seiten sperren", "Lock pages"), t(`${pagesLabel(toLock)} sperren`, `Lock ${pagesLabel(toLock)}`))}
          </Dropdown.Item>
        )}
        {canCreate && toLock < n && (
          <Dropdown.Item className="dropdown-item" disabled={bulkBusy} onSelect={() => void bulkPages("unlock")}>
            <LockOpen />
            {count(n - toLock, t("Seiten entsperren", "Unlock pages"), t(`${pagesLabel(n - toLock)} entsperren`, `Unlock ${pagesLabel(n - toLock)}`))}
          </Dropdown.Item>
        )}
        {toStar > 0 && (
          <Dropdown.Item className="dropdown-item" disabled={bulkBusy} onSelect={() => void bulkPages("favorite")}>
            <Star />
            {count(toStar, t("Zu Favoriten", "Add to favourites"), t(`${pagesLabel(toStar)} zu Favoriten`, `Add ${pagesLabel(toStar)} to favourites`))}
          </Dropdown.Item>
        )}
        {toStar < n && (
          <Dropdown.Item className="dropdown-item" disabled={bulkBusy} onSelect={() => void bulkPages("unfavorite")}>
            <Star />
            {count(n - toStar, t("Aus Favoriten entfernen", "Remove from favourites"), t(`${pagesLabel(n - toStar)} aus Favoriten entfernen`, `Remove ${pagesLabel(n - toStar)} from favourites`))}
          </Dropdown.Item>
        )}
        <Dropdown.Item
          className="dropdown-item"
          disabled={!n}
          onSelect={async () => {
            // One link per line, in the order the pages were selected.
            const links = chosen.map((p) => `${location.origin}${location.pathname}${pageLocationHash({ pageId: p.id })}`);
            try {
              await navigator.clipboard.writeText(links.join("\n"));
              notify(t("Links kopiert", "Links copied"));
            } catch {
              notifyError(t("Links konnten nicht kopiert werden.", "The links could not be copied."));
            }
          }}
        >
          <LinkIcon />
          {t("Links kopieren", "Copy links")}
        </Dropdown.Item>
      </>
    );
  }
  // Moves by drag and drop and of several pages: into another space, the
  // tags and properties of the source space they use are resolved first
  // (page.moveCheck); `run` then moves with the choices.
  async function movingChecked(pageIds: string[], destination: { spaceId?: string; pageId?: string }, run: (meta?: MetaPlan) => Promise<unknown>): Promise<unknown> {
    const spaceOf = (id: string) => boot.pages.find((p) => p.id === id)?.space_id;
    const target = destination.spaceId ?? (destination.pageId ? spaceOf(destination.pageId) : undefined);
    const leaving = pageIds.filter((id) => spaceOf(id) && spaceOf(id) !== target);
    if (!target || !leaving.length) return run();
    const found = new Map<string, ForeignMeta>();
    for (const pageId of leaving) {
      const check = await api<{ foreign: ForeignMeta[] }>("/api/command", { action: "page.moveCheck", workspaceId: boot.workspace.id, pageId, spaceId: target }).catch(
        () => ({ foreign: [] as ForeignMeta[] }),
      );
      for (const item of check.foreign) {
        const key = `${item.kind}:${item.id}`;
        const seen = found.get(key);
        found.set(key, seen ? { ...seen, pages: seen.pages + item.pages, records: seen.records + item.records } : item);
      }
    }
    if (!found.size) return run();
    setMetaMove({ items: [...found.values()], target: boot.spaces.find((sp) => sp.id === target)?.name ?? "", run });
  }
  async function bulkPages(
    operation: "delete" | "duplicate" | "move" | "lock" | "unlock" | "favorite" | "unfavorite",
    destination?: string,
    meta?: MetaPlan,
  ): Promise<unknown> {
    if (operation === "move" && destination && meta === undefined) {
      const ids = selectedPages;
      return movingChecked(
        ids,
        destination.startsWith("page:")
          ? { pageId: destination.slice(5) }
          : destination.startsWith("record:")
            ? { pageId: destination.split(":")[1] }
            : { spaceId: destination.slice(6) },
        (plan) => bulkPages("move", destination, plan ?? ({} as MetaPlan)),
      );
    }
    setBulkBusy(true);
    const since = toastSerial();
    try {
      const result = await act({
        action: "pages.bulk",
        workspaceId: boot.workspace.id,
        operation,
        pageIds: selectedPages,
        ...(meta && Object.keys(meta).length ? { meta } : {}),
        ...(destination?.startsWith("page:")
          ? { parentId: destination.slice(5) }
          : destination?.startsWith("record:")
            ? { parentId: destination.split(":")[1], parentRowId: destination.split(":")[2] }
            : destination?.startsWith("space:")
            ? { spaceId: destination.slice(6) }
            : {}),
      });
      if (result && ["lock", "unlock", "favorite", "unfavorite"].includes(operation)) {
        // The selection stays: another action for the same pages may follow.
        const { count = 0, skipped = 0 } = result as { count?: number; skipped?: number };
        const done =
          operation === "lock"
            ? t(`${pagesLabel(count)} gesperrt.`, `${pagesLabel(count)} locked.`)
            : operation === "unlock"
              ? t(`${pagesLabel(count)} entsperrt.`, `${pagesLabel(count)} unlocked.`)
              : operation === "favorite"
                ? t(`${pagesLabel(count)} zu den Favoriten hinzugefügt.`, `${pagesLabel(count)} added to favourites.`)
                : t(`${pagesLabel(count)} aus den Favoriten entfernt.`, `${pagesLabel(count)} removed from favourites.`);
        notify(
          skipped
            ? `${done} ${t(`${pagesLabel(skipped)} ohne Bearbeitungsrechte übersprungen.`, `${pagesLabel(skipped)} without edit rights skipped.`)}`
            : done,
        );
      } else if (result) {
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
  // Touch devices drag pages with a handle; the drop target is found under
  // the finger. The top and bottom 35 % of a row reorder, the middle 30 %
  // nests (#637): a finger moving along the list mostly reorders.
  function touchTarget(x: number, y: number) {
    const row = document
      .elementFromPoint(x, y)
      ?.closest<HTMLElement>(".page-nav[data-page-id]");
    if (!row) return null;
    const rect = row.getBoundingClientRect(),
      ratio = (y - rect.top) / rect.height;
    return {
      row,
      id: row.dataset.pageId!,
      placement: (ratio < 0.35
        ? "before"
        : ratio > 0.65
          ? "after"
          : "inside") as "before" | "after" | "inside",
    };
  }
  // Marks one row (or none) as the drop target, on the element itself.
  function markTreeRow(row: HTMLElement | null, placement?: string) {
    const mark = row && placement ? `drop-${placement}` : "",
      was = treeMark.current;
    if (was?.row === row && was?.mark === mark) return;
    if (was) was.row.classList.remove(was.mark);
    treeMark.current = row && mark ? { row, mark } : null;
    if (row && mark) row.classList.add(mark);
  }
  // Moves a page dropped by the handle onto a row of the tree.
  treeHandleDropRef.current = (source, x, y) => {
    const target = touchTarget(x, y);
    if (!target || target.id === source) return;
    void movingChecked([source], { pageId: target.id }, (meta) => {
      markTreeMove();
      return act({ action: "page.move", pageId: source, targetId: target.id, placement: target.placement, ...(meta ? { meta } : {}) });
    });
  };
  // A page lifted by its handle (touch after the hold, pen and mouse once
  // they move) follows the finger as a light copy while its row fades in
  // place (components/pointer-drag.ts). The window follows the pointer, not
  // the handle (#618), the drop target is looked up once per frame and
  // marked on its row without a render (#637), and every end – let go,
  // cancelled by the browser, Esc, the window losing the focus, the drawer
  // closing, the tree going away – clears the mark.
  function startTreeHandleDrag(event: React.PointerEvent<HTMLElement>, source: string) {
    treeHandleEnd.current?.();
    const row = event.currentTarget.closest<HTMLElement>(".page-nav");
    const done = () => {
      if (treeHandleEnd.current === quit) treeHandleEnd.current = null;
      markTreeRow(null);
    };
    const stop = startPointerDrag(event, {
      touch: "hold",
      preview: row,
      source: row,
      perFrame: true,
      // The list scrolls with the finger anywhere below or above it (over
      // the phone's bottom bar too), as before.
      scrollReach: Infinity,
      onMove: (point) => {
        const target = touchTarget(point.x, point.y);
        if (target && target.id !== source) markTreeRow(target.row, target.placement);
        else markTreeRow(null);
      },
      onDrop: (point) => {
        done();
        treeHandleDropRef.current(source, point.x, point.y);
      },
      onCancel: done,
    });
    const quit = () => {
      stop?.();
      done();
    };
    treeHandleEnd.current = stop ? quit : null;
  }
  // A record dragged out of a database (components/database-view.tsx, with
  // pointer events since #100) onto another database in the sidebar moves
  // there; with Alt (⌥) held it is copied.
  const recordDropRef = useRef((_detail: RecordDropDetail) => {});
  recordDropRef.current = (from) => {
    const target = titledPages.find((p) => p.id === from.targetPageId);
    if (!target || target.kind !== "database" || !from.pageId || !from.rowId || from.pageId === target.id) return;
    const mode = from.copy ? "copy" : "move";
    void act({ action: "rows.transfer", pageId: from.pageId, rowIds: [from.rowId], targetPageId: target.id, mode }).then((result) => {
      if (result)
        notify(mode === "move" ? t(`Eintrag nach „${target.title}“ verschoben.`, `Record moved to “${target.title}”.`) : t(`Eintrag nach „${target.title}“ kopiert.`, `Record copied to “${target.title}”.`));
    });
  };
  useEffect(() => {
    const over = (e: Event) => {
      const id = (e as CustomEvent<RecordOverDetail>).detail.targetPageId;
      setTreeDrop((current) =>
        id ? { id, placement: "records" } : current?.placement === "records" ? null : current,
      );
    };
    const drop = (e: Event) => {
      setTreeDrop(null);
      recordDropRef.current((e as CustomEvent<RecordDropDetail>).detail);
    };
    window.addEventListener(RECORD_OVER_EVENT, over);
    window.addEventListener(RECORD_DROP_EVENT, drop);
    return () => {
      window.removeEventListener(RECORD_OVER_EVENT, over);
      window.removeEventListener(RECORD_DROP_EVENT, drop);
    };
  }, []);
  // Touch: holding a page for half a second opens its menu (phones have no
  // right click); moving the finger scrolls instead.
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number; opened: boolean } | null>(null);
  const pressMenu = (p: Page, today?: boolean) => ({
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
          setPageMenu({ page: p, x, y, today });
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
    // Nor may its mousedown move the focus to the entry: the menu would
    // close again (focus outside).
    onMouseDownCapture: (e: React.MouseEvent) => {
      if (press.current?.opened) e.preventDefault();
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
    folds.change({ [journalFoldKey(key, open)]: true, [journalFoldKey(key, !open)]: false });
  // Each space's tree has one Tab stop: the item focused last, else the open
  // page, else the first page – as long as it is shown (parents unfolded).
  // With a focused branch (#318) only its pages, the root always unfolded.
  function treeStop(sid: string, root?: string): string | null {
    const byId = new Map(activePages.map((p) => [p.id, p]));
    const shownPage = (page: Page | undefined): boolean => {
      if (!page || page.space_id !== sid || (filterMatches && !filterMatches.has(page.id))) return false;
      if (root && !branchPath(activePages, page.id).includes(root)) return false;
      for (let child = page, parent = page.parent_id ? byId.get(page.parent_id) : undefined; parent && child.id !== root; child = parent, parent = parent.parent_id ? byId.get(parent.parent_id) : undefined) {
        if (!filterMatches && parent.id !== root && !pageOpen(parent.id)) return false;
        // A day of a journal: only while the journal shows it.
        if (!filterMatches && parent.kind === "journal" && child.journal_date && !journalTree(parent).shown.has(child.id)) return false;
      }
      return true;
    };
    const shown = (id: string | null) => {
      if (id && isFolderKey(id)) {
        // A virtual item of a journal (today, a folder, "Alle Tage").
        const journal = byId.get(id.split(":")[1]);
        return !filterMatches && !!journal && shownPage(journal) && (journal.id === root || pageOpen(journal.id)) && journalTree(journal).shown.has(id);
      }
      return shownPage(id ? byId.get(id) : undefined);
    };
    if (shown(treeFocus)) return treeFocus;
    if (screen === "page" && shown(pageId)) return pageId;
    return root ?? treeLevel(null, sid)[0]?.id ?? null;
  }
  // Arrow keys in the tree (WAI-ARIA tree pattern): up and down move, right
  // unfolds or enters, left folds or goes to the parent, Enter opens.
  function treeKey(e: React.KeyboardEvent<HTMLDivElement>, p: Page, children: boolean, closed: boolean, parentTree = p.parent_id, root = false) {
    treeNavKey(e, {
      children,
      closed,
      parentTree,
      // The root of a focused branch stays unfolded.
      fold: (fold) => !root && foldPage(p.id, fold),
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
  // The records of a database shown in the tree (#231): those with
  // sub-pages in this space (while filtering, with a match below).
  const recordsShown = (databaseId: string, sid: string) =>
    (recordItems.get(databaseId) || []).filter((r) => treeLevel(`row:${databaseId}:${r.rowId}`, sid).length > 0);
  function recordRow(database: Page, r: NonNullable<Bootstrap["recordParents"]>[number], sid: string, level: number, stop: string | null): React.ReactNode {
    const key = `${database.id}:${r.rowId}`;
    const open = !!filterMatches || recordOpen(key);
    const moveHere = (source: string) =>
      void movingChecked([source], { pageId: database.id }, (meta) => {
        markTreeMove();
        return act({ action: "page.move", pageId: source, targetId: database.id, placement: "inside", parentRowId: r.rowId, ...(meta ? { meta } : {}) });
      });
    return (
      <RecordTreeItem
        key={`record:${key}`}
        id={`record:${key}`}
        parentTree={database.id}
        level={level}
        stop={stop}
        icon={shownPageIcon(r.icon, "document")}
        label={r.title}
        href={pageLocationHash({ pageId: database.id, rowId: r.rowId, full: true })}
        selected={recordFull && pageId === database.id && recordView?.rowId === r.rowId}
        open={open}
        dropping={recordDrop === key}
        onToggle={(next) => foldRecord(key, !next)}
        onOpen={() => setMobile(false)}
        onFocus={setTreeFocus}
        onKey={treeNavKey}
        onDragOver={(e) => {
          if (!canCreate || !e.dataTransfer.types.includes("application/x-flowplan-page")) return;
          e.preventDefault();
          setRecordDrop(key);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setRecordDrop(null);
        }}
        onDrop={(e) => {
          if (e.dataTransfer.types.includes("application/x-flowplan-space")) return;
          e.preventDefault();
          e.stopPropagation();
          setRecordDrop(null);
          const source = e.dataTransfer.getData("application/x-flowplan-page");
          if (source && source !== database.id) moveHere(source);
        }}
        onAdd={canCreate ? () => addPage("document", database.id, database.space_id, r.rowId) : undefined}
      >
        {treeLevel(`row:${database.id}:${r.rowId}`, sid).map((x) => treeRow(x, sid, level + 1, stop, { parentTree: `record:${key}` }))}
      </RecordTreeItem>
    );
  }
  function treeRow(
    p: Page,
    sid: string,
    level: number,
    stop: string | null,
    // root: the page of a focused branch (#318), always unfolded.
    place: { parentTree?: string; today?: boolean; root?: boolean } = {},
  ): React.ReactNode {
        const journal = p.kind === "journal" && !filterMatches ? journalTree(p) : null;
        const records = p.kind === "database" ? recordsShown(p.id, sid) : [];
        const children = journal
            ? journal.entries.length > 0 || journal.others.some((x) => x.space_id === sid)
            : records.length > 0 || (treeIndex.get(p.id) || []).some((x) => !filterMatches || filterMatches.has(x.id)),
          // While filtering, the way to every match stays open.
          closed = !place.root && !filterMatches && !pageOpen(p.id);
        // A record opened as a page whose row shows below its database
        // (#231): the record is the active entry, the database an ancestor.
        const recordActive = recordFull && pageId === p.id && !closed && records.some((r) => r.rowId === recordView?.rowId);
        const active = screen === "page" && pageId === p.id && !recordActive;
        return (
          <div key={p.id}>
            <div
              className={`page-nav ${active ? "selected" : ""} ${selectedPages.includes(p.id) ? "multi-selected" : ""} ${treeDrop?.id === p.id ? `drop-${treeDrop.placement}` : ""} ${fileDrop === `p:${p.id}` ? "file-drop" : ""}`}
              data-page-id={p.id}
              data-tree-id={p.id}
              data-prefetch-page={p.offline ? undefined : p.id}
              role="treeitem"
              aria-level={level + 1}
              aria-selected={active}
              aria-expanded={children ? !closed : undefined}
              aria-owns={children && !closed ? `tree-group-${p.id}` : undefined}
              tabIndex={stop === p.id ? 0 : -1}
              onFocus={() => setTreeFocus(p.id)}
              onKeyDown={(e) => treeKey(e, p, children, closed, place.parentTree, place.root)}
              onContextMenu={(e) => {
                e.preventDefault();
                setPageMenu({ page: p, x: e.clientX, y: e.clientY });
              }}
              {...pressMenu(p)}
              onPointerDownCapture={(e) => {
                rowPressedByTouch.current = e.pointerType === "touch";
              }}
              draggable={canCreate && !coarsePointer}
              onDragStart={(e) => {
                // On phones a held row opens its menu and pages move by the
                // handle alone: the browser's own drag of the row (iOS lifts
                // it after a long press) would mark rows it never unmarks
                // (#618).
                if ((e.target as HTMLElement).closest(".nav-drag") || (phone && rowPressedByTouch.current)) {
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
              // A record dragged from a database onto another database
              // (see recordDropRef).
              data-record-drop-page={p.kind === "database" ? p.id : undefined}
              onDragOver={(e) => {
                // Files from the computer (#569): pages below this one.
                if (carriesFiles(e.dataTransfer.types)) {
                  if (!canCreate) return;
                  e.preventDefault();
                  e.stopPropagation();
                  e.dataTransfer.dropEffect = "copy";
                  if (fileDrop !== `p:${p.id}`) setFileDrop(`p:${p.id}`);
                  return;
                }
                if (
                  !canCreate ||
                  !e.dataTransfer.types.includes("application/x-flowplan-page")
                )
                  return;
                e.preventDefault();
                const rect = e.currentTarget.getBoundingClientRect(),
                  ratio = (e.clientY - rect.top) / rect.height,
                  placement = ratio < 0.25 ? "before" : ratio > 0.75 ? "after" : "inside";
                // dragover comes many times a second: a render only when
                // the target or the placement changes (#637).
                setTreeDrop((current) =>
                  current?.id === p.id && current.placement === placement ? current : { id: p.id, placement },
                );
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                  setTreeDrop(null);
                  setFileDrop((d) => (d === `p:${p.id}` ? null : d));
                }
              }}
              onDrop={(e) => {
                if (carriesFiles(e.dataTransfer.types)) {
                  e.preventDefault();
                  e.stopPropagation();
                  setFileDrop(null);
                  uploadFilePages([...e.dataTransfer.files], p.space_id, p.id);
                  return;
                }
                // A space dropped onto one of its pages: its section handles it.
                if (e.dataTransfer.types.includes("application/x-flowplan-space")) return;
                e.preventDefault();
                e.stopPropagation();
                const source = e.dataTransfer.getData(
                  "application/x-flowplan-page",
                );
                if (source && source !== p.id) {
                  const placement = treeDrop?.placement || "inside";
                  void movingChecked([source], { pageId: p.id }, (meta) => {
                    markTreeMove();
                    return act({
                      action: "page.move",
                      pageId: source,
                      targetId: p.id,
                      placement,
                      ...(meta ? { meta } : {}),
                    });
                  });
                }
                setTreeDrop(null);
              }}
              style={{ paddingLeft: 12 + level * 14 }}
            >
              {children && !place.root ? (
                <button
                  className="tree-toggle"
                  tabIndex={-1}
                  aria-label={
                    closed ? t("Unterseiten öffnen", "Expand sub-pages") : t("Unterseiten schließen", "Collapse sub-pages")
                  }
                  onClick={() => foldPage(p.id, !closed)}
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
                data-open-place=""
                onClick={(e) => {
                  // Ctrl/⌘-click opens the page in a new tab, with Shift in
                  // the other frame (#279) – unless pages are being selected
                  // (Shift-click starts a selection; on phones Ctrl/⌘-click).
                  if ((e.metaKey || e.ctrlKey) && tabs.on && !selecting && !selectedPages.length) {
                    e.preventDefault();
                    tabs.openPlace(`page=${p.id}`, openModeOf(e));
                    return;
                  }
                  if (selecting || e.metaKey || e.ctrlKey || e.shiftKey) {
                    e.preventDefault();
                    toggleSelected(p.id, e.shiftKey);
                    return;
                  }
                  // In the frame worked in (the right one shows it there).
                  if (tabs.on && tabs.openPlace(`page=${p.id}`, "here")) return;
                  void openPage(p.id);
                }}
                onAuxClick={(e) => {
                  if (e.button !== 1 || !tabs.on) return;
                  e.preventDefault();
                  tabs.openPlace(`page=${p.id}`, openModeOf(e));
                }}
              >
                <PageIcon name={shownPageIcon(p.icon, p.kind)} size={17} emojiSize={SIDEBAR_EMOJI} />
                <span className="page-nav-label">{p.title}</span>
                {place.today && <span className="nav-badge">{t("Heute", "Today")}</span>}
                {p.locked === 1 && <Lock size={12} />}
                {p.offline && <OfflineMark state={p.offline} />}
              </button>
              {canCreate && (
                <button
                  className="nav-drag"
                  tabIndex={-1}
                  // Dragging a page sideways is not the swipe that closes
                  // the sidebar (components/drawer-swipe.ts).
                  data-no-edge-swipe=""
                  aria-label={t(`${p.title} ziehen`, `Drag ${p.title}`)}
                  onPointerDown={(e) => {
                    // No native drag of the row: the handle drives the
                    // gesture. By touch only once held: a swipe over the
                    // handles scrolls the tree and moves nothing (#166).
                    e.preventDefault();
                    startTreeHandleDrag(e, p.id);
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
                  // A journal's "+" offline opens today's entry (#333);
                  // other pages get a sub-page made on the device (#370).
                  onClick={() => (p.kind === "journal" && deviceOffline() ? void openJournalToday(p.id) : addPage("document", p.id, p.space_id))}
                >
                  <Plus size={14} />
                </button>
              )}
            </div>
            {/* Sub-pages unfold and fold instead of popping in and out. */}
            <Collapse open={children && !closed} className="nav-children">
              {children && !closed ? (
                <div role="group" id={`tree-group-${p.id}`}>
                  {journal ? (
                    journalBranch(p, sid, level + 1, stop)
                  ) : (
                    <>
                      {records.map((r) => recordRow(p, r, sid, level + 1, stop))}
                      {tree(p.id, sid, level + 1, stop)}
                    </>
                  )}
                </div>
              ) : null}
            </Collapse>
          </div>
        );
  }
  // The sidebar's tree while a branch is focused (#318): "←" to the level
  // above, the path (each step focuses that page, the space the whole
  // tree), "×"; below, the page as the root of the tree. Esc in the tree
  // shows the whole tree again.
  function treeBranchView(root: Page): React.ReactNode {
    const untitled = t("Ohne Titel", "Untitled");
    const space = boot.spaces.find((sp) => sp.id === root.space_id);
    const byId = new Map(activePages.map((p) => [p.id, p]));
    const above = branchPath(activePages, root.id)
      .slice(0, -1)
      .flatMap((id) => byId.get(id) || []);
    const up = branchUp(activePages, root.id);
    const upTitle = up ? byId.get(up)?.title || untitled : "";
    const upLabel = up ? t(`Zurück zu „${upTitle}“`, `Back to “${upTitle}”`) : t("Zurück zum ganzen Seitenbaum", "Back to the whole page tree");
    const endLabel = t("Fokus beenden – ganzen Seitenbaum zeigen", "End focus – show whole page tree");
    const shown = !filterMatches || filterMatches.has(root.id);
    return (
      <section className="nav-section tree-branch" aria-label={t(`Fokussiert: ${root.title || untitled}`, `Focused: ${root.title || untitled}`)}>
        <div className="tree-branch-bar">
          <button type="button" className="icon-button tree-branch-up" title={upLabel} aria-label={upLabel} onClick={() => setTreeBranch(up, { moveFocus: true })}>
            <ArrowLeft size={14} />
          </button>
          <nav className="tree-branch-path" aria-label={t("Pfad im Seitenbaum", "Path in the page tree")}>
            <ol>
              <li>
                <button type="button" title={t("Ganzen Seitenbaum zeigen", "Show whole page tree")} onClick={() => setTreeBranch(null, { moveFocus: true })}>
                  {space && <SpaceIcon icon={space.icon} color={space.icon_color} />}
                  <span>{space?.name || t("Bereich", "Space")}</span>
                </button>
              </li>
              {above.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    title={t(`Auf „${p.title || untitled}“ fokussieren`, `Focus on “${p.title || untitled}”`)}
                    onClick={() => setTreeBranch(p.id, { moveFocus: true })}
                  >
                    <span>{p.title || untitled}</span>
                  </button>
                </li>
              ))}
              <li aria-current="location">
                <span>{root.title || untitled}</span>
              </li>
            </ol>
          </nav>
          <button type="button" className="icon-button tree-branch-close" title={endLabel} aria-label={endLabel} onClick={() => setTreeBranch(null, { moveFocus: true })}>
            <X size={14} />
          </button>
        </div>
        <div
          role="tree"
          aria-label={t(`Seiten unter ${root.title || untitled}`, `Pages under ${root.title || untitled}`)}
          onKeyDown={(e) => {
            // Rows handle arrows and Enter; an Esc no row, menu or field
            // handled shows the whole tree, the focus on the same page.
            if (e.key !== "Escape" || e.defaultPrevented) return;
            e.preventDefault();
            setTreeBranch(null, { moveFocus: true });
          }}
        >
          {shown ? treeRow(root, root.space_id, 0, treeStop(root.space_id, root.id), { root: true }) : null}
        </div>
        {!shown && <p className="sidebar-empty tree-filter-empty">{t("Keine Seite heißt so.", "No page has that name.")}</p>}
      </section>
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
  // Offline (#333) the day's stored page when the offline copy has it, else
  // the entry written on this device (lib/journal-offline.ts).
  async function openJournalToday(journalId: string) {
    const today = localDay();
    const day = activePages.find((p) => p.parent_id === journalId && p.journal_date === today);
    const journal = activePages.find((p) => p.id === journalId);
    const writable = !!journal && canCreate && !journal.locked;
    if (day && (!writable || !deviceOffline() || (await keptOffline(day.id)))) return openPage(day.id);
    if (writable && deviceOffline()) return openOfflineDay(journalId, today);
    if (writable) {
      try {
        const result = (await rollJournal(journalId, today)) as { dayId?: string; trashed?: boolean } | null;
        if (result?.dayId && !result.trashed) return openPage(result.dayId);
      } catch (error) {
        // The connection went while asking.
        if (deviceOffline() || isTransient(error)) return openOfflineDay(journalId, today);
      }
    }
    return openPage(journalId);
  }
  // A journal's "Heute" favourite (#537): its name in the favourites, whether
  // today's day of the journal is the open page, and switching it.
  function todayFavoriteLabel(journal: Page) {
    const name = journal.title || t("Ohne Titel", "Untitled");
    return t(`${name} – Heute`, `${name} – Today`);
  }
  function todayOpen(journalId: string) {
    const today = localDay();
    return (data?.journalDay?.journalId === journalId && data.journalDay.date === today) || (data?.draft?.journalId === journalId && data.draft.date === today);
  }
  function toggleTodayFavorite(journalId: string) {
    return act({ action: "favorite.today", pageId: journalId, value: !boot.todayFavorites?.includes(journalId) });
  }
  // Whether the offline copy holds a page (the service worker's or the app's).
  async function keptOffline(id: string) {
    try {
      const store = offlineStore();
      return !!store && !!(await store.match(pageUrl(id)));
    } catch {
      return false;
    }
  }
  // The day's entry on this device: the one begun before, else a new one.
  function openOfflineDay(journalId: string, date: string) {
    const list = readOfflineJournal();
    let entry = offlineEntryFor(list, journalId, date);
    if (!entry) {
      entry = { id: crypto.randomUUID(), journalId, date, html: "", key: crypto.randomUUID(), at: Date.now() };
      writeOfflineJournal(withOfflineEntry(list, entry));
    }
    return openPage(entry.id);
  }
  // A past day chosen in the day picker (#288): its page, created without
  // carried tasks when the journal has none for that date yet.
  async function openJournalDate(journalId: string, date: string) {
    if (deviceOffline()) return openOfflineDay(journalId, date);
    const result = (await act({ action: "journal.roll", workspaceId: boot.workspace.id, pageId: journalId, date: localDay(), zone: localZone(), day: date })) as { dayId?: string } | null;
    if (result?.dayId) return openPage(result.dayId);
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
  // Commands for the quick search ("> …" or matching words): built only
  // while the palette is open and asks for them, not on every render of
  // the workspace (components/command-palette.tsx, #610).
  const canAsk = aiUsable(uiAi, "ask");
  const paletteCommands = (query: string, paletteDecks: readonly PaletteDeck[]): CommandAction[] => {
    const openPageData = screen === "page" && data ? data : null;
    const commandActions: CommandAction[] = [
      { label: t("Neue Seite", "New page"), keywords: t("dokument anlegen erstellen notiz", "dokument anlegen erstellen notiz document new create note page"), icon: FileText, run: () => addPage() },
      { label: t("Erfassen", "Capture"), keywords: t("eingang inbox notiz schnell erfassen", "eingang inbox notiz schnell erfassen inbox note quick capture"), icon: Tray, run: () => setCapture(true) },
      { label: t("Neue Datenbank", "New database"), keywords: t("tabelle projekt anlegen", "tabelle projekt anlegen table project create database"), icon: Table, run: () => addPage("database") },
      { label: t("Neues Whiteboard", "New whiteboard"), keywords: "board canvas zeichnen", icon: PresentationChart, run: () => addPage("whiteboard"), module: PAGE_KIND_MODULE.whiteboard },
      { label: t("Neues Journal", "New journal"), keywords: t("tagebuch tag", "tagebuch tag diary day journal"), icon: Notebook, run: () => addPage("journal"), module: PAGE_KIND_MODULE.journal },
      // "Journal: Heute" – with several journals one per journal, the last used first.
      ...journalsByUse().map((journal, _, list) => ({
        label: list.length > 1 ? t(`Journal: Heute – ${journal.title || t("Ohne Titel", "Untitled")}`, `Journal: Today – ${journal.title || t("Ohne Titel", "Untitled")}`) : t("Journal: Heute", "Journal: Today"),
        keywords: `${t("tagebuch tag heute eintrag", "tagebuch tag heute diary day today entry journal")} ${journal.title}`,
        icon: CalendarCheck,
        run: () => void openJournalToday(journal.id),
        module: "journal" as const,
        place: "journal" as const,
      })),
      { label: t("Neues Notizbuch", "New notebook"), keywords: t("handschrift stift zeichnen heft goodnotes pdf", "handschrift stift zeichnen heft goodnotes pdf handwriting pencil notebook sketch"), icon: NotePencil, run: () => addPage("notebook"), module: PAGE_KIND_MODULE.notebook },
      ...(boot.workspace.guest ? [] : [{ label: t("Neuer Workflow", "New workflow"), keywords: t("automation ablauf regel auslöser", "automation ablauf regel auslöser automation flow rule trigger workflow"), icon: FlowArrow, run: () => addPage("workflow"), module: PAGE_KIND_MODULE.workflow }]),
      { label: t("Neues Dashboard", "New dashboard"), keywords: t("übersicht kennzahlen kacheln", "übersicht kennzahlen kacheln overview metrics tiles dashboard"), icon: Gauge, run: () => addPage("dashboard"), module: PAGE_KIND_MODULE.dashboard },
      { label: t("Auf der Seite suchen", "Find on page"), keywords: t("finden text treffer strg f", "finden text treffer strg f find text match ctrl f"), icon: MagnifyingGlass, run: () => setFind((f) => ({ open: true, key: f.key + 1 })) },
      { label: t("Einführung ansehen", "Show introduction"), keywords: t("onboarding tour hilfe willkommen", "onboarding tour hilfe willkommen help welcome"), icon: Compass, run: () => { setOnboardingStep(undefined); setOnboarding(true); } },
      // The checklist after the introduction, hidden earlier (lib/getting-started.ts).
      ...(boot.gettingStarted?.hidden
        ? [{ label: t("Erste Schritte anzeigen", "Show getting started"), keywords: t("checkliste einstieg start", "checkliste einstieg start checklist onboarding getting started"), icon: CheckSquare, run: () => void mutate({ action: "gettingStarted.hide", workspaceId: boot.workspace.id, hidden: false }) }]
        : []),
      // Administrators: the introduction's traffic lights for the instance.
      ...(boot.user.isAdmin
        ? [{ label: t("Instanz einrichten", "Set up the instance"), keywords: t("admin status ampel mail sso sicherung backup ki https", "admin status ampel mail sso sicherung backup ki https traffic light setup backup ai"), icon: Compass, run: () => { setOnboardingStep("setup"); setOnboarding(true); } }]
        : []),
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
      { label: t("Meine Aufgaben", "My tasks"), keywords: t("tasks todo fällig", "tasks todo fällig due aufgaben"), icon: CheckSquare, run: () => go("tasks"), place: "tasks" },
      { label: t("Tags", "Tags"), keywords: t("tags schlagwörter eigenschaften", "tags labels properties schlagwörter"), icon: TagIcon, run: () => go("tags") },
      ...(hasLibrary ? [{ label: t("Bibliothek öffnen", "Open library"), keywords: t("bibliothek regale bücher wissen", "bibliothek regale bücher library shelves books knowledge"), icon: Books, run: openLibraryHome }] : []),
      { label: t("Medien", "Media"), keywords: t("bilder dateien", "bilder dateien images files media"), icon: ImageSquare, run: () => go("media") },
      { label: t("Lernen: fällige Karten", "Study: due cards"), keywords: t("lernkarten karteikarten wiederholen stapel vokabeln", "lernkarten karteikarten flashcards cards review decks spaced repetition study"), icon: Cards, run: () => go("study"), module: "flashcards", place: "study" },
      // Each deck with something left today (#study's counts, loaded when the
      // palette opens).
      ...paletteDecks.map((d) => ({ label: t(`Lernen: ${d.title || t("Ohne Titel", "Untitled")}`, `Study: ${d.title || t("Ohne Titel", "Untitled")}`), keywords: t(`lernkarten stapel fällig ${d.left}`, `lernkarten stapel flashcards deck due ${d.left}`), icon: Cards, run: () => setStudyDeck({ pageId: d.pageId, title: d.title }), module: "flashcards" as const, place: "study" as const })),
      // From the open page (a deck: into it), else from pasted text or a file.
      ...(aiUsable(uiAi, "flashcards") && !boot.workspace.guest && featureShown("flashcards")
        ? [
            {
              label: t("Lernkarten mit KI erstellen", "Create flashcards with AI"),
              keywords: t("ki karteikarten lernen generieren vorschlagen pdf", "ki karteikarten lernen generieren vorschlagen pdf ai flashcards generate cards quiz"),
              icon: Cards,
              run: () =>
                setAiCards(
                  openPageData && !openPageData.encrypted
                    ? openPageData.page.kind === "database"
                      ? { deckId: openPageData.page.id }
                      : { pageId: openPageData.page.id, pageTitle: openPageData.page.title }
                    : {},
                ),
            },
          ]
        : []),
      { label: t("Graph der Verlinkungen", "Graph of links"), keywords: "graph netz verbindungen links karte", icon: Graph, run: () => go("graph"), place: "graph" },
      { label: t("Papierkorb", "Trash"), keywords: t("trash gelöscht wiederherstellen", "trash gelöscht wiederherstellen papierkorb deleted restore"), icon: Trash, run: () => go("trash") },
      { label: t("Einstellungen", "Settings"), keywords: t("settings konto mitglieder profil sprache", "settings konto mitglieder preferences account members profile language"), icon: GearSix, run: () => go("settings") },
      { label: t("Tastenkürzel", "Keyboard shortcuts"), keywords: t("shortcuts tasten hilfe tastatur", "shortcuts tasten hilfe keyboard keys help hotkeys"), icon: Keyboard, run: () => setShortcuts(true) },
      { label: t("Über Flowplan", "About Flowplan"), keywords: t("über info version lizenz quellcode hilfe", "über info about version licence license source code help"), icon: InfoIcon, run: () => void (toPlace("settings/about") || (location.hash = "settings/about")) },
      { label: t("Was ist neu", "What’s new"), keywords: t("neu neuigkeiten update version änderungen changelog versionshinweise", "neu neuigkeiten new news update version changes changelog release notes"), icon: Gift, run: openWhatsNew },
      // The instance's part of the settings (#532; formerly "Administration").
      ...(boot.user.isAdmin
        ? [{ label: t("Einstellungen: Instanz", "Settings: instance"), keywords: t("admin administration instanz betrieb", "admin administration instanz betrieb instance operations"), icon: ShieldCheck, run: () => void (toPlace(settingsHash({ area: "admin" }).slice(1)) || (location.hash = settingsHash({ area: "admin" }))) }]
        : []),
      { label: dark ? t("Helles Design", "Light theme") : t("Dunkles Design", "Dark theme"), keywords: "theme dark light nacht farbe", icon: dark ? Sun : Moon, run: toggleTheme },
      { label: t("Seitenleiste ein- oder ausblenden", "Show or hide sidebar"), keywords: "sidebar navigation", icon: SidebarSimple, run: toggleCollapsed },
      ...(wide
        ? [
            splitShown
              ? { label: t("Geteilte Ansicht schließen", "Close split view"), keywords: t("split nebeneinander zwei seiten", "split nebeneinander zwei seiten side by side two pages"), icon: SquareSplitHorizontal, run: () => tabs.closeFrame(1) }
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
            ...(todayJournal
              ? [
                  {
                    label: boot.todayFavorites?.includes(todayJournal.id) ? t("Heute aus Favoriten entfernen", "Remove today from favourites") : t("Heute zu Favoriten", "Add today to favourites"),
                    keywords: t("favorit stern journal tag heute", "favorit stern journal tag heute favourite favorite star journal day today"),
                    icon: CalendarDot,
                    run: () => void toggleTodayFavorite(todayJournal.id),
                  },
                ]
              : []),
            {
              label: openPageData.following ? t("Seite nicht mehr folgen", "Unfollow page") : t("Seite folgen", "Follow page"),
              keywords: "benachrichtigen glocke follow",
              icon: Bell,
              run: () => void act({ action: "page.follow", pageId: openPageData.page.id, follow: !openPageData.following }),
            },
            { label: t("Kommentare öffnen", "Open comments"), keywords: "comments diskussion", icon: ChatCircle, run: () => setComments(true) },
            { label: t("Seite exportieren", "Export page"), keywords: "markdown html zip download export", icon: DownloadSimple, run: () => setPageExport(true) },
            { label: t("Drucken oder als PDF sichern", "Print or save as PDF"), keywords: "pdf print drucken", icon: Printer, run: () => printOpenPage() },
            { label: t("QR-Code der Seite", "Page QR code"), keywords: "qr code etikett label scan", icon: QrCode, run: () => setPageQr(true) },
            ...(openPageData.page.kind === "document" && !openPageData.locked
              ? [{ label: t("Präsentieren", "Present"), keywords: t("präsentation folien vortrag beamer", "präsentation folien vortrag beamer presentation slides talk slideshow"), icon: PresentIcon, run: startPresentation }]
              : []),
            // Folding headings (lib/heading-folds.ts): the page's text, or an open record's.
            ...(["document", "journal", "database"].includes(openPageData.page.kind)
              ? [
                  {
                    label: t("Alle Abschnitte einklappen", "Collapse all sections"),
                    keywords: t("überschriften zuklappen falten gliederung abschnitte", "überschriften zuklappen falten gliederung abschnitte headings fold collapse outline sections"),
                    icon: ArrowsInLineVertical,
                    run: () => foldAllSections(true),
                  },
                  {
                    label: t("Alle Abschnitte ausklappen", "Expand all sections"),
                    keywords: t("überschriften aufklappen entfalten gliederung abschnitte", "überschriften aufklappen entfalten gliederung abschnitte headings unfold expand outline sections"),
                    icon: ArrowsOutLineVertical,
                    run: () => foldAllSections(false),
                  },
                ]
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
    if (canAsk)
      commandActions.unshift({
        label: t("KI fragen …", "Ask AI …"),
        keywords: t("ki fragen frage antwort assistent chat", "ki fragen frage antwort assistent chat ai ask question answer assistant"),
        icon: Sparkle,
        // The text typed so far becomes the question.
        run: () => openAsk(query.replace(/^>\s*/, "").replace(/^(ki fragen|ask ai)\s*…?\s*/i, "").trim()),
      });
    return commandActions.filter((a) => featureShown(a.module) && placeShown(a.place));
  };
  // A command chosen in the palette (closed by then).
  const runPaletteCommand = (action: CommandAction, intoTab: number | null) => {
    // After the "+" of the tab bar (#444): a command that leads to a screen
    // (My tasks, Inbox, Settings …) opens it in a new tab of that frame;
    // dialogs and other commands run as usual.
    commandTab.current = intoTab !== null && tabs.on ? intoTab : null;
    try {
      action.run();
    } finally {
      commandTab.current = null;
    }
  };
  // A hit or recently viewed page chosen in the palette (closed by then).
  const openPaletteHit: CommandPaletteProps["onOpen"] = (item, mode, { split: intoSplit, tab: intoTab }) => {
    // Chosen for the split view: the page opens next to the open one.
    if (intoSplit) return openSplit(item.result.id);
    const p = item.result;
    // Chosen for a new tab (#444): there, in the frame it was asked for.
    if (intoTab !== null && tabs.on && tabs.openPlace(pageLocationHash({ pageId: p.id, rowId: p.rowId }).slice(1), "tab", intoTab)) return;
    // ⌘/Ctrl+Enter or -click: a new tab (with Shift the other frame); a
    // page chosen while the right frame is worked in opens there (#279).
    if (tabs.on && (mode !== "here" || !p.rowId) && tabs.openPlace(pageLocationHash({ pageId: p.id, rowId: p.rowId }).slice(1), mode)) return;
    if (item.kind === "recent") return void openPage(p.id, p.rowId ? { pageId: p.id, rowId: p.rowId } : undefined);
    // The block with the hit flashes once the page is open.
    const hit = item.result.kind === "comment" || item.result.kind === "file" ? "" : snippetHit(item.result.snippet);
    if (hit) jumpTo({ pageId: p.id, rowId: p.rowId }, byText(hit));
    void openPage(p.id, p.rowId ? { pageId: p.id, rowId: p.rowId } : undefined);
  };
  // The less used places at the sidebar's bottom: a row of symbols, on
  // phones behind "Mehr" (components/sidebar-tools.tsx).
  const sidebarTools: SidebarTool[] = [
    { id: "templates", label: t("Vorlagen", "Templates"), icon: SquaresFour, onSelect: () => setTemplates(true) },
    { id: "media", label: t("Medien", "Media"), icon: Images, selected: screen === "media", onSelect: () => go("media") },
    ...((featureShown("flashcards") && placeShown("study")) || screen === "study"
      ? [{ id: "study", label: t("Lernen", "Study"), title: t("Lernkarten: fällige Karten", "Flashcards: due cards") + hint("study"), icon: Cards, selected: screen === "study", onSelect: () => go("study") }]
      : []),
    { id: "tags", label: t("Tags", "Tags"), title: t("Seiten nach Tags", "Pages by tag"), icon: TagIcon, selected: screen === "tags", onSelect: () => go("tags") },
    ...(placeShown("graph") || screen === "graph"
      ? [{ id: "graph", label: t("Graph", "Graph"), title: t("Graph der Verlinkungen", "Graph of links"), icon: Graph, selected: screen === "graph", onSelect: () => go("graph") }]
      : []),
    { id: "trash", label: t("Papierkorb", "Trash"), icon: Trash, selected: screen === "trash", onSelect: () => go("trash") },
    { id: "settings", label: t("Einstellungen", "Settings"), icon: GearSix, selected: screen === "settings", onSelect: () => go("settings") },
    {
      id: "shortcuts",
      label: t("Tastenkürzel", "Keyboard shortcuts"),
      title: t("Tastenkürzel", "Keyboard shortcuts") + hint("shortcuts"),
      icon: Question,
      className: "sidebar-help",
      onSelect: () => setShortcuts(true),
    },
  ];
  // Each person's choice of symbols (#589, lib/sidebar-tools-pref.ts): the
  // row leaves the hidden ones out; the phone's "Mehr" sheet too, but keeps
  // Settings; the quick search still has them all.
  const saveSidebarTools = (next: ReturnType<typeof hiddenSidebarTools>) =>
    saveHiddenSidebarTools(next, (hidden) => mutate({ action: "profile.sidebarTools", hidden }));
  const hideSidebarTool = (id: string) => {
    if (!isSidebarToolId(id)) return;
    const label = sidebarTools.find((tool) => tool.id === id)?.label ?? id;
    saveSidebarTools(setSidebarToolShown(hiddenSidebarTools(), id, false)).then(
      () =>
        showUndo(t(`„${label}“ ist nicht mehr in der Leiste.`, `“${label}” is no longer in the toolbar.`), () =>
          saveSidebarTools(setSidebarToolShown(hiddenSidebarTools(), id, true)),
        ),
      (e) => notifyError(e),
    );
  };
  const customizeSidebarTools = () => {
    location.hash = settingsHash({ area: "settings", section: "appearance", anchor: "sidebar-tools" });
  };
  const signOut = async () => {
    await clearAccountData();
    const done = await fetch("/api/auth/logout", { method: "POST" })
      .then((r) => r.json() as Promise<{ redirect?: string }>)
      .catch(() => ({}) as { redirect?: string });
    // Signed in through a reverse proxy: its portal signs out as well.
    location.href = done.redirect || "/";
  };
  // The account's entries: in the workspace menu (#565) on every screen –
  // the phone's "Mehr" sheet holds the tools alone (#613); signing out
  // comes last, set apart.
  const legal = boot.instance?.legal;
  type AccountItem = { id: string; label: string; icon: Icon; href?: string; external?: boolean; onSelect?: () => void };
  const accountItems: AccountItem[] = [
    { id: "theme", label: dark ? t("Helles Design", "Light theme") : t("Dunkles Design", "Dark theme"), icon: dark ? Sun : Moon, onSelect: toggleTheme },
    { id: "about", label: t("Über Flowplan", "About Flowplan"), icon: InfoIcon, href: "#settings/about" },
    { id: "whats-new", label: t("Was ist neu", "What’s new"), icon: Gift, onSelect: openWhatsNew },
    ...(legal?.imprint ? [{ id: "imprint", label: t("Impressum", "Legal notice"), icon: Scales, href: legal.imprint, external: true }] : []),
    ...(legal?.privacy ? [{ id: "privacy", label: t("Datenschutz", "Privacy"), icon: ShieldCheck, href: legal.privacy, external: true }] : []),
  ];
  // Opens what a notification leads to (the inbox).
  const openNotification = (n: Bootstrap["notifications"][number]) => {
    if (!n.read_at)
      void act({
        action: "notification.mark",
        notificationId: n.id,
        read: true,
      });
    const url = notificationUrl(n);
    const target = parsePageLocation(url.slice(1));
    // Not a page: a place of the app (an incident of the instance).
    if (!target) {
      if (url !== "/#inbox") location.hash = url.slice(2);
      return;
    }
    // The commented passage or the mention flashes.
    jumpTo(
      target,
      target.threadId
        ? bySelector(`[data-comment-thread="${CSS.escape(target.threadId)}"]`)
        : bySelector(`[data-mention="${CSS.escape(boot.user.id)}"]`),
    );
    void openPage(target.pageId, target);
  };
  // Added to a workspace (#320): open it, or leave it with the
  // confirmation of Settings → Allgemein.
  const openAddedWorkspace = async (n: Bootstrap["notifications"][number], workspaceId: string, hash?: string) => {
    if (!n.read_at) void act({ action: "notification.mark", notificationId: n.id, read: true });
    if (workspaceId !== boot.workspace.id) await switchWorkspace(workspaceId);
    if (hash) location.hash = hash;
  };
  // Unread in all, also beyond the first page of the inbox (the badges).
  const unreadNotifications = boot.notificationsUnread ?? boot.notifications.filter((n) => !n.read_at).length;
  // "Erste Schritte" after the introduction (lib/getting-started.ts) and
  // "Mehr", the phone's sheet of the less used places: below the list, on a
  // phone in the hand its last entries (#629).
  const gettingStarted = boot.gettingStarted && !boot.gettingStarted.hidden ? (
    <GettingStarted
      state={boot.gettingStarted}
      sample={boot.sampleSpace && !boot.sampleSpace.trashed ? boot.sampleSpace : null}
      mutate={(b) => mutate({ workspaceId: boot.workspace.id, ...b })}
      onAction={(item) => {
        if (item === "page") {
          const first = boot.spaces.find((sp) => !sp.deleted_at);
          if (first) addPage("document", null, first.id);
        } else if (item === "task") go("tasks");
        else if (item === "search") openSearch();
        // The deck of the template "Flowplan-Tastenkürzel".
        else if (item === "shortcuts") {
          const first = boot.spaces.find((sp) => !sp.deleted_at);
          const name = catalogFor(LOCALE_TAG === "de-DE" ? "de" : "en").shortcuts?.name ?? "";
          if (first) newPageFromTemplate({ starter: "shortcuts", name, kind: "database" }, first.id, null, false);
        }
        else
          location.hash = settingsHash(
            item === "invite" ? { area: "settings", section: "members" } : item === "app" ? { area: "settings", section: "devices" } : { area: "settings", section: "data", anchor: "import" },
          );
      }}
    />
  ) : null;
  // Phones rarely have a keyboard: no "Tastenkürzel" in the sheet (#620;
  // iPad and wider windows keep it in the row). The sheet follows the row's
  // choice but always keeps Settings (#589).
  const sidebarMore = <SidebarMore tools={moreSheetOf(sidebarTools, hiddenTools).filter((tool) => tool.id !== "shortcuts")} />;
  return (
    <AiProvider status={uiAi || null} workspaceId={boot.workspace.id}>
    <TagOptionsContext.Provider value={tagOptions}>
    <DatabaseLabelsContext.Provider value={databaseLabels}>
    <div
      data-motion={motionAttribute(motion)}
      className={`app-shell ${mobile ? "nav-open" : ""} ${desktopCollapsed ? "desktop-collapsed" : ""}${focusMode && screen === "page" ? " focus-mode" : ""}${keyboardOpen ? " keyboard-open" : ""}${ask && canAsk && !(focusMode && screen === "page") ? (askNarrowWindow && !askPinned ? " ask-overlay" : " ask-open") : ""}${dock?.docked ? " side-dock-open" : ""}`}
      style={
        sidebarWidth || askWidth || overlayWidth || dock
          ? ({
              ...(dock ? { "--side-dock-width": `${dock.width}px` } : {}),
              ...(sidebarWidth ? { "--sidebar-width": `${sidebarWidth}px` } : {}),
              ...(askWidth ? { "--ask-width": `${askWidth}px` } : {}),
              ...(overlayWidth ? { "--overlay-width": `${overlayWidth}px` } : {}),
            } as React.CSSProperties)
          : undefined
      }
      inert={switching || !!presenting}
      aria-busy={switching}
    >
      {!signedOut && <ActivityPing userId={boot.user.id} workspaceId={boot.workspace.id} />}
      {/* The workspace's look (#196), unless this person chose Flowplan's own. */}
      <WorkspaceThemeStyle look={boot.plainLook ? null : boot.look} />
      <WorkspaceFavicon theme={boot.plainLook ? null : boot.look?.theme} />
      {/* This person's typeface (#512), over the look's interface font. */}
      <PersonalFontStyle font={boot.uiFont} />
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
      <aside className="sidebar" tabIndex={mobile ? -1 : undefined} aria-label={mobile ? t("Navigation", "Navigation") : undefined}>
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
              if (!phoneLayout()) chooseCollapsed(true);
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
            {/* One menu for the workspace and the account (#565): who is
                signed in, the workspaces, then the account's entries (on
                phones too: "Mehr" holds the tools alone, #613) and signing
                out last, apart. */}
            <Dropdown.Content collisionPadding={safeCollisionPadding()} className="dropdown workspace-menu" align="start" sideOffset={4}>
              <Dropdown.Label className="workspace-menu-person">
                <Avatar name={boot.user.name} userId={boot.user.id} small />
                <span className="workspace-menu-person-name">
                  {boot.user.name}
                  {boot.user.email && <small>{boot.user.email}</small>}
                </span>
              </Dropdown.Label>
              <Dropdown.Separator className="dropdown-separator" />
              {boot.workspaces.map((w) => (
                <Dropdown.Item
                  className="dropdown-item"
                  key={w.id}
                  onSelect={() => switchWorkspace(w.id, { fromSidebar: true })}
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
              {profileSwitcher && (
                <>
                  <Dropdown.Separator className="dropdown-separator" />
                  <Dropdown.Item className="dropdown-item" onSelect={() => void openProfileSwitcher()}>
                    <ArrowsLeftRight />
                    {t("Instanz wechseln …", "Switch instance…")}
                  </Dropdown.Item>
                </>
              )}
              <Dropdown.Separator className="dropdown-separator" />
              <Dropdown.Group aria-label={t("Konto", "Account")}>
                {/* Settings hidden from the row (#589): here instead, so the
                    choice can always be undone in one step. */}
                {settingsInMenu(hiddenTools) && (
                  <Dropdown.Item className="dropdown-item" onSelect={() => go("settings")}>
                    <GearSix />
                    {t("Einstellungen", "Settings")}
                  </Dropdown.Item>
                )}
                {accountItems.map(({ id, label, icon: ItemIcon, href, external, onSelect }) =>
                  href ? (
                    <Dropdown.Item key={id} className="dropdown-item" asChild>
                      <a href={href} {...(external ? { target: "_blank", rel: "noopener" } : {})}>
                        <ItemIcon />
                        {label}
                      </a>
                    </Dropdown.Item>
                  ) : (
                    <Dropdown.Item key={id} className="dropdown-item" onSelect={onSelect}>
                      <ItemIcon />
                      {label}
                    </Dropdown.Item>
                  ),
                )}
              </Dropdown.Group>
              <Dropdown.Separator className="dropdown-separator" />
              <Dropdown.Item className="dropdown-item workspace-menu-sign-out" onSelect={() => void signOut()}>
                <SignOut />
                {t("Abmelden", "Sign out")}
              </Dropdown.Item>
            </Dropdown.Content>
          </Dropdown.Portal>
        </Dropdown.Root>
        <div className="sidebar-scroll" ref={treeRoot}>
          {/* The navigation folds into one row of icons (#452): g:nav, stored
              like the other sidebar folds. */}
          <nav className={`main-nav${navCompact ? " compact" : ""}`} aria-label={t("Navigation", "Navigation")}>
            <button title={navCompact ? t("Suchen", "Search") : undefined} onClick={() => openSearch()}>
              <MagnifyingGlass size={19} />
              <span className="main-nav-label">{t("Suchen", "Search")}</span>
              {keyHints.visible && shortcutHint("search", mac) && <span className="keycap">{shortcutHint("search", mac)}</span>}
            </button>
            {canAsk && (
              <button title={navCompact ? t("KI fragen", "Ask AI") : undefined} onClick={() => openAsk("")}>
                <Sparkle size={19} />
                <span className="main-nav-label">{t("KI fragen", "Ask AI")}</span>
              </button>
            )}
            <button title={navCompact ? t("Startseite", "Home") : undefined}
              className={screen === "home" ? "selected" : ""}
              data-open-place=""
              onClick={(e) => !(tabs.on && openModeOf(e) !== "here" && tabs.openPlace("home", openModeOf(e))) && go("home")}
              onAuxClick={(e) => e.button === 1 && tabs.on && tabs.openPlace("home", openModeOf(e))}
            >
              <House size={19} />
              <span className="main-nav-label">{t("Startseite", "Home")}</span>
            </button>
            {/* The library (#329): only with a space shown as a library. */}
            {hasLibrary && (
              <button title={navCompact ? t("Bibliothek", "Library") : undefined}
                className={screen === "library" && !libraryPlace ? "selected" : ""}
                data-open-place=""
                aria-current={screen === "library" && !libraryPlace ? "page" : undefined}
                onClick={(e) => !(tabs.on && openModeOf(e) !== "here" && tabs.openPlace(LIBRARY_HOME, openModeOf(e))) && openLibraryHome()}
                onAuxClick={(e) => e.button === 1 && tabs.on && tabs.openPlace(LIBRARY_HOME, openModeOf(e))}
              >
                <Books size={19} />
                <span className="main-nav-label">{t("Bibliothek", "Library")}</span>
              </button>
            )}
            <button title={navCompact ? t("Posteingang", "Inbox") : undefined}
              className={screen === "inbox" ? "selected" : ""}
              data-open-place=""
              onClick={(e) => !(tabs.on && openModeOf(e) !== "here" && tabs.openPlace("inbox", openModeOf(e))) && go("inbox")}
              onAuxClick={(e) => e.button === 1 && tabs.on && tabs.openPlace("inbox", openModeOf(e))}
            >
              <Bell size={19} />
              <span className="main-nav-label">{t("Posteingang", "Inbox")}</span>
              {unreadNotifications > 0 && (
                <span className="notification-count">
                    {unreadNotifications}
                </span>
              )}
            </button>
            {/* Hidden by the workspace (#564) – while open, it stays. */}
            {(placeShown("tasks") || screen === "tasks") && (
            <button title={navCompact ? t("Meine Aufgaben", "My tasks") : undefined}
              className={screen === "tasks" ? "selected" : ""}
              data-open-place=""
              onClick={(e) => !(tabs.on && openModeOf(e) !== "here" && tabs.openPlace("tasks", openModeOf(e))) && go("tasks")}
              onAuxClick={(e) => e.button === 1 && tabs.on && tabs.openPlace("tasks", openModeOf(e))}
            >
              <CheckSquare size={19} />
              <span className="main-nav-label">{t("Meine Aufgaben", "My tasks")}</span>
              {/* Given to me by others since I last opened My tasks (#208). */}
              {!!boot.newTasks && screen !== "tasks" && (
                <span
                  className="notification-count new-tasks"
                  title={boot.newTasks === 1 ? t("1 neue Aufgabe für dich", "1 new task for you") : t(`${boot.newTasks} neue Aufgaben für dich`, `${boot.newTasks} new tasks for you`)}
                  aria-label={boot.newTasks === 1 ? t("1 neue Aufgabe für dich", "1 new task for you") : t(`${boot.newTasks} neue Aufgaben für dich`, `${boot.newTasks} new tasks for you`)}
                >
                  {boot.newTasks > 99 ? "99+" : boot.newTasks}
                </span>
              )}
              {!!boot.dueTasks && (
                <span className="notification-count" title={t("Heute fällig oder überfällig", "Due today or overdue")}>
                  {boot.dueTasks}
                </span>
              )}
            </button>
            )}
            <button
              className="main-nav-toggle"
              aria-expanded={!navCompact}
              aria-label={navCompact ? t("Navigation ausklappen", "Expand navigation") : t("Navigation einklappen", "Collapse navigation")}
              title={navCompact ? t("Navigation ausklappen", "Expand navigation") : t("Navigation einklappen", "Collapse navigation")}
              onClick={() => folds.change({ "g:nav": !navCompact })}
            >
              {navCompact ? <CaretDown size={14} aria-hidden="true" /> : <CaretUp size={14} aria-hidden="true" />}
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
          {filterMatches && !filterMatches.size && !branchPage && (
            <p className="sidebar-empty tree-filter-empty">{t("Keine Seite heißt so.", "No page has that name.")}</p>
          )}
          {/* A focused branch (#318) is the tree alone, as while filtering. */}
          {!filterMatches && !branchPage && (favorites.length > 0 || todayFavorites.length > 0 || !!boot.favoriteRows?.length) && (
            <section
              className={`nav-section favorites-section${groupFolded("favorites") ? " space-collapsed" : ""}`}
              aria-label={t("Favoriten", "Favourites")}
            >
              <div className="nav-section-title">
                <button
                  type="button"
                  className="space-toggle"
                  aria-expanded={!groupFolded("favorites")}
                  aria-controls="favorites-list"
                  onClick={() => foldGroup("favorites", !groupFolded("favorites"))}
                >
                  <CaretRight size={10} className="space-caret" aria-hidden="true" />
                  <span className="space-name">{t("Favoriten", "Favourites")}</span>
                  <Star size={13} aria-hidden="true" />
                </button>
              </div>
              <Collapse open={!groupFolded("favorites")} className="space-tree">
              {!groupFolded("favorites") ? (
              <div id="favorites-list">
              {/* Page favourites and journals' "Heute" links (#537) in the
                  order of the page tree; a journal's "Heute" right after
                  the journal itself. */}
              {activePages
                .filter((p) => favorites.includes(p) || todayFavorites.includes(p))
                .flatMap((p) => [
                  ...(favorites.includes(p) ? [{ p, today: false }] : []),
                  ...(todayFavorites.includes(p) ? [{ p, today: true }] : []),
                ])
                .map(({ p, today }) => today ? (
                <button
                  className={`favorite-nav today-favorite ${screen === "page" && todayOpen(p.id) ? "selected" : ""}`}
                  key={`today:${p.id}`}
                  data-today-favorite={p.id}
                  onClick={() => {
                    setMobile(false);
                    void openJournalToday(p.id);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setPageMenu({ page: p, x: e.clientX, y: e.clientY, today: true });
                  }}
                  {...pressMenu(p, true)}
                >
                  <CalendarDot size={16} aria-hidden="true" />
                  <span>{todayFavoriteLabel(p)}</span>
                </button>
              ) : (
                <button
                  className={`favorite-nav ${pageId === p.id && screen === "page" ? "selected" : ""}`}
                  key={p.id}
                  data-prefetch-page={p.id}
                  data-open-place=""
                  onClick={(e) => {
                    if (tabs.on && tabs.openPlace(`page=${p.id}`, openModeOf(e))) return;
                    void openPage(p.id);
                  }}
                  onAuxClick={(e) => {
                    if (e.button !== 1 || !tabs.on) return;
                    e.preventDefault();
                    tabs.openPlace(`page=${p.id}`, openModeOf(e));
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setPageMenu({ page: p, x: e.clientX, y: e.clientY });
                  }}
                  {...pressMenu(p)}
                >
                  <PageIcon name={shownPageIcon(p.icon, p.kind)} emojiSize={SIDEBAR_EMOJI} />
                  <span>{p.title}</span>
                </button>
              ))}
              {/* Favourite records open as pages of their own (#231), by
                  a real link: ⌘/Ctrl or the middle button open a new tab. */}
              {boot.favoriteRows?.map((f) => {
                const target = { pageId: f.pageId, rowId: f.rowId, full: true };
                return (
                  <a
                    className={`favorite-nav${recordView?.full && recordView.rowId === f.rowId && pageId === f.pageId && screen === "page" ? " selected" : ""}`}
                    key={f.rowId}
                    href={pageLocationHash(target)}
                    aria-label={t(`Eintrag ${f.title}`, `Record ${f.title}`)}
                    // The address opens it (the hash route); the drawer closes.
                    onClick={() => setMobile(false)}
                  >
                    <PageIcon name={shownPageIcon(f.icon, "document")} emojiSize={SIDEBAR_EMOJI} />
                    <span>{f.title}</span>
                  </a>
                );
              })}
              </div>
              ) : null}
              </Collapse>
            </section>
          )}
          {!filterMatches && !branchPage && (
            <CollectionsNav
              collections={boot.collections ?? []}
              current={screen === "collection" ? collectionId : null}
              onOpen={openCollection}
              onNew={() => newCollection()}
              onEdit={(c) => setCollectionDraft(c)}
              onDuplicate={(c) => void duplicateCollection(c)}
              onDelete={(c) => void deleteCollection(c)}
              onReorder={(order) => reorderCollections(order)}
              folded={groupFolded("collections")}
              onFold={(fold) => foldGroup("collections", fold)}
            />
          )}
          {(selecting || selectedPages.length > 0) && (
            <div
              className="page-selection-bar"
              role="toolbar"
              aria-label={t("Seitenauswahl", "Page selection")}
            >
              <span>{selectedPages.length} {t("ausgewählt", "selected")}</span>
              {/* Two lines: the count and "Fertig", the actions below – in the
                  narrow sidebar they wrapped into three uneven ones. */}
              <button className="text-button page-selection-done" onClick={clearSelection}>
                {t("Fertig", "Done")}
              </button>
              <div className="page-selection-actions">
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
                <Dropdown.Root modal={false}>
                  <Dropdown.Trigger asChild>
                    <button
                      className="text-button"
                      disabled={!selectedPages.length || bulkBusy}
                      aria-label={t("Weitere Aktionen für die Auswahl", "More actions for the selection")}
                      title={t("Weitere Aktionen", "More actions")}
                    >
                      <DotsThree size={16} />
                    </button>
                  </Dropdown.Trigger>
                  <Dropdown.Portal>
                    <Dropdown.Content
                      className="dropdown"
                      align="end"
                      sideOffset={4}
                      collisionPadding={safeCollisionPadding()}
                      aria-label={t("Weitere Aktionen für die Auswahl", "More actions for the selection")}
                    >
                      {selectionMenuItems()}
                    </Dropdown.Content>
                  </Dropdown.Portal>
                </Dropdown.Root>
              </div>
            </div>
          )}
          {branchPage && treeBranchView(branchPage)}
          {!branchPage && boot.spaces
            .filter(
              (space) =>
                !filterMatches ||
                activePages.some((p) => p.space_id === space.id && filterMatches.has(p.id)),
            )
            .map((space, spaceIndex, shownSpaces) => {
              // While filtering every space with a match stays open.
              // A library (#329) starts folded, with "Bibliothek öffnen" below its name.
              const library = !!space.library,
                folded = library ? !folds.has(`so:${space.id}`) : folds.has(`s:${space.id}`),
                spaceClosed = !filterMatches && folded,
                spaceOrder = boot.spaces.map((s) => s.id),
                reorderable = canReorderSpaces && !filterMatches;
              return (
            <section
              className={`nav-section${spaceDrop?.id === space.id ? ` space-drop-${spaceDrop.placement}` : ""}${spaceClosed ? " space-collapsed" : ""}${fileDrop === `s:${space.id}` ? " space-file-drop" : ""}`}
              key={space.id}
              data-space-id={space.id}
              onDragOver={(e) => {
                // Files from the computer (#569): pages at the top level.
                if (carriesFiles(e.dataTransfer.types)) {
                  if (!canCreate) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "copy";
                  if (fileDrop !== `s:${space.id}`) setFileDrop(`s:${space.id}`);
                  return;
                }
                if (!reorderable || !e.dataTransfer.types.includes("application/x-flowplan-space")) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                const rect = e.currentTarget.getBoundingClientRect();
                const placement = e.clientY - rect.top < rect.height / 2 ? "before" : "after";
                if (spaceDrop?.id !== space.id || spaceDrop.placement !== placement) setSpaceDrop({ id: space.id, placement });
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                  setSpaceDrop((d) => (d?.id === space.id ? null : d));
                  setFileDrop((d) => (d === `s:${space.id}` ? null : d));
                }
              }}
              onDrop={(e) => {
                if (carriesFiles(e.dataTransfer.types)) {
                  e.preventDefault();
                  e.stopPropagation();
                  setFileDrop(null);
                  uploadFilePages([...e.dataTransfer.files], space.id, null);
                  return;
                }
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
                  onClick={() => foldSpace(space.id, !folded)}
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
                    <Dropdown.Root>
                      <Dropdown.Trigger
                        className="icon-button"
                        aria-label={t(`Bereich ${space.name} verwalten`, `Manage space ${space.name}`)}
                      >
                        <DotsThree size={16} />
                      </Dropdown.Trigger>
                      <Dropdown.Portal>
                        <Dropdown.Content collisionPadding={safeCollisionPadding()} className="dropdown" align="end">
                          {(boot.workspace.role === "owner" || (canCreate && space.owner_id === boot.user.id)) && (
                            <>
                              <Dropdown.Item className="dropdown-item" onSelect={() => setSpaceManager({ space })}>
                                <GearSix />
                                {t("Bereich bearbeiten …", "Edit space …")}
                              </Dropdown.Item>
                              <Dropdown.Separator className="dropdown-separator" />
                            </>
                          )}
                          {/* Folding every page of the space (#97). */}
                          <Dropdown.Item className="dropdown-item" onSelect={() => foldAll(space.id, true)}>
                            <ArrowsOutSimple />
                            {t("Alle aufklappen", "Expand all")}
                          </Dropdown.Item>
                          <Dropdown.Item className="dropdown-item" onSelect={() => foldAll(space.id, false)}>
                            <ArrowsInSimple />
                            {t("Alle zuklappen", "Collapse all")}
                          </Dropdown.Item>
                          {/* Each file a page of its own (#569). */}
                          {canCreate && (
                            <>
                              <Dropdown.Separator className="dropdown-separator" />
                              <Dropdown.Item className="dropdown-item" onSelect={() => pickFilePages(space.id, null)}>
                                <UploadSimple />
                                {t("Datei hochladen …", "Upload file…")}
                              </Dropdown.Item>
                            </>
                          )}
                          {/* Its record contents and files on this device too (#417). */}
                          {offlineKeep.enabled && (
                            <>
                              <Dropdown.Separator className="dropdown-separator" />
                              {(space as { encrypted?: number }).encrypted ? (
                                <Dropdown.Item className="dropdown-item" disabled>
                                  <CloudCheck />
                                  {t("Offline behalten", "Keep offline")}
                                  <small className="dropdown-hint">{t("Verschlüsselte Bereiche bleiben nur online.", "Encrypted spaces stay online-only.")}</small>
                                </Dropdown.Item>
                              ) : (
                                <Dropdown.CheckboxItem
                                  className="dropdown-item"
                                  checked={offlineKeep.kept({ kind: "space", id: space.id })}
                                  onSelect={() => void offlineKeep.toggle({ kind: "space", id: space.id }, !offlineKeep.kept({ kind: "space", id: space.id }))}
                                >
                                  <CloudCheck />
                                  {t("Offline behalten", "Keep offline")}{" "}{offlineKeep.kept({ kind: "space", id: space.id }) ? "✓" : ""}
                                </Dropdown.CheckboxItem>
                              )}
                            </>
                          )}
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
              {library && !filterMatches && (
                <a
                  className={`favorite-nav library-nav${screen === "library" && libraryPlace?.spaceId === space.id ? " selected" : ""}`}
                  href={`#${libraryHash(space.id)}`}
                  aria-current={screen === "library" && libraryPlace?.spaceId === space.id && !libraryPlace.bookId ? "page" : undefined}
                  onClick={() => setMobile(false)}
                >
                  <Books size={16} aria-hidden />
                  <span>{t("Bibliothek öffnen", "Open library")}</span>
                </a>
              )}
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
          {/* One live region for the sidebar: a moved space or a focused branch. */}
          <p className="sr-only" role="status" aria-live="polite">
            {branchNote || spaceMoveNote}
          </p>
          {canCreate && !branchPage && (
            <button className="add-space" onClick={() => setNewSpace(true)}>
              <Plus size={15} />
              {t("Bereich hinzufügen", "Add space")}
            </button>
          )}
          {/* On a phone in the hand "Mehr" is an entry of the list, right
              below the spaces – no bar of its own above the tab bar (#629);
              "Erste Schritte" follows it. */}
          {touchPhone && sidebarMore}
          {touchPhone && gettingStarted}
        </div>
        {/* On a phone in the hand the drawer's list ends with "Mehr" and
            "Erste Schritte" (#629, above); elsewhere they stay below it. */}
        {!touchPhone && (
          <div className="sidebar-bottom">
            {gettingStarted}
            {/* Less used places as one row of symbols (in a narrow window
                behind "Mehr"): the page tree above keeps the height. Who is
                signed in and the account's entries are in the workspace menu
                at the top (#565), so there is no account row below it any
                more (#570). */}
            <SidebarToolRow tools={toolRowOf(sidebarTools, hiddenTools)} onHide={hideSidebarTool} onCustomize={customizeSidebarTools} />
            {sidebarMore}
          </div>
        )}
        {/* Over the page (open drawer) the sidebar has a width of its own –
            on tablets; on phones it is as wide as the screen and has no
            edge to drag (#621, #622). */}
        {mobile && phone ? null : mobile ? (
          <SidebarResize
            key="overlay"
            width={overlayWidth}
            onWidth={setOverlayWidth}
            min={OVERLAY_MIN}
            max={OVERLAY_MAX}
            fallback={360}
            label={t("Breite der Seitenleiste über der Seite", "Width of the sidebar over the page")}
            hint={t("Ziehen zum Ändern, Doppeltippen setzt zurück", "Drag to resize, double-tap to reset")}
          />
        ) : (
          <SidebarResize
            key="docked"
            width={sidebarWidth}
            onWidth={setSidebarWidth}
            label={t("Breite der Seitenleiste", "Sidebar width")}
            hint={t("Ziehen zum Ändern, Doppelklick setzt zurück", "Drag to resize, double-click to reset")}
          />
        )}
      </aside>
      <main className="main" id="main-content" tabIndex={-1} ref={mainRef} inert={mobile}>
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
                await clearAccountData();
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
        <InstanceBanners initial={boot.instance?.banners || []} />
        {/* Storage or the AI quota at 80 % / 100 % (Speicher & KI). */}
        <LimitsNotice boot={boot} />
        {/* Marked for deletion, address unconfirmed (#436). */}
        {boot.pendingDeletion && <UnconfirmedDeletionNotice due={boot.pendingDeletion.due} />}
        {offlineNotice}
        {appOfflineNotice}
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
                if (!phoneLayout()) chooseCollapsed(false);
              }}
            >
              <SidebarSimple size={21} />
            </button>
            <HistoryButtons
              backHint={keyHints.visible ? preferredCombo("back", mac) : ""}
              forwardHint={keyHints.visible ? preferredCombo("forward", mac) : ""}
              describe={describeStep}
            />
            <a className="breadcrumb-workspace" href="#home">{boot.workspace.name}</a>
            <span className="breadcrumb-divider">/</span>
            {screen === "page" && data ? (
              <PageBreadcrumb
                segments={structuralPath(
                  titledPages,
                  { ...data.page, title: titledPages.find((p) => p.id === data.page.id)?.title ?? data.page.title },
                  data.page.kind === "database" ? recordView : null,
                  boot.recordParents,
                )}
                room={phone ? 2 : 4}
              />
            ) : screen === "library" && librarySpace ? (
              <span className="library-crumbs">
                <a href={`#${LIBRARY_HOME}`}>{t("Bibliothek", "Library")}</a>
                <span className="breadcrumb-divider">/</span>
                {libraryPlace?.bookId ? (
                  <>
                    <a href={`#${libraryHash(librarySpace.id)}`}>{librarySpace.name}</a>
                    <span className="breadcrumb-divider">/</span>
                    {libraryPlace.chapterId ? (
                      <>
                        <a href={`#${libraryHash(librarySpace.id, libraryPlace.bookId)}`}>{titledPages.find((p) => p.id === libraryPlace.bookId)?.title || t("Buch", "Book")}</a>
                        <span className="breadcrumb-divider">/</span>
                        <span>{titledPages.find((p) => p.id === libraryPlace.chapterId)?.title || t("Kapitel", "Chapter")}</span>
                      </>
                    ) : (
                      <span>{titledPages.find((p) => p.id === libraryPlace.bookId)?.title || t("Buch", "Book")}</span>
                    )}
                  </>
                ) : (
                  <span>{librarySpace.name}</span>
                )}
              </span>
            ) : (
              <span className={screen === "home" ? "breadcrumb-home" : undefined}>
                {
                  {
                    home: t("Startseite", "Home"),
                    trash: t("Papierkorb", "Trash"),
                    inbox: t("Posteingang", "Inbox"),
                    tasks: t("Meine Aufgaben", "My tasks"),
                    tags: t("Tags", "Tags"),
                    collection: boot.collections?.find((c) => c.id === collectionId)?.name ?? t("Sammlung", "Collection"),
                    library: t("Bibliothek", "Library"),
                    graph: t("Graph", "Graph"),
                    media: t("Medien", "Media"),
                    study: t("Lernen", "Study"),
                    settings: t("Einstellungen", "Settings"),
                    page: missingPage && missingPage.id === pageId && !busy ? t("Seite nicht gefunden", "Page not found") : t("Seite", "Page"),
                  }[screen]
                }
              </span>
            )}
          </div>
          {/* Offline: a small icon instead of a banner over the page (#296). */}
          {!online && <OfflineStatus />}
          {screen === "page" && data?.offlineNew && localOpen ? (
            <span className="topbar-note journal-draft-note">
              <OfflineMark state={localOpen.state} />
              {localOpen.state === "failed"
                ? t("Nicht synchronisiert", "Not synced")
                : online && offlineQueue.syncing
                  ? t("Synchronisieren …", "Syncing …")
                  : t("Noch nicht synchronisiert", "Not yet synced")}
            </span>
          ) : screen === "page" && data?.draft ? (
            <span className="topbar-note journal-draft-note" role="status">
              <span className="subtle-dot" />
              {data.draft.local
                ? t("Offline-Entwurf – wird angelegt, sobald die Verbindung zurück ist", "Offline draft – created once the connection is back")
                : t("Entwurf – wird beim ersten Schreiben angelegt", "Draft – created when you start writing")}
            </span>
          ) : screen === "page" && data ? (
            <div className="page-top-actions">
              {/* Saving and offline states cross-fade instead of switching hard.
                  On phones the cloud shows only when there is something to
                  report – changes on their way, an error – not while all is
                  saved (nor while a page that just opened checks in). Offline
                  the icon before it is the one indicator (#332). */}
              <SaveStatusBadge store={saveStatus} online={online} />
              <PresenceAvatars users={data.present.filter((u) => u.id !== boot.user.id).slice(0, 3)} />
              {/* A record as a page (#231) has its own actions above it;
                  these belong to the database. */}
              {!recordFull && (<>
              {canRead && (
                <button
                  className={`icon-button read-mode-toggle topbar-phone-hidden${reading ? " active" : ""}`}
                  title={(reading ? t("Bearbeiten", "Edit") : t("Lesemodus", "Reading mode")) + hint("readMode")}
                  aria-label={reading ? t("Bearbeiten", "Edit") : t("Lesemodus", "Reading mode")}
                  aria-pressed={reading}
                  onClick={toggleReading}
                >
                  {reading ? <PencilSimple size={20} /> : <BookOpen size={20} />}
                </button>
              )}
              {/* On phones only with open comments (and their count);
                  otherwise in the ⋯ menu. */}
              {!data.encrypted && (
                <button
                  title={t("Kommentare", "Comments")}
                  aria-label={openComments ? t(`Kommentare (${openComments})`, `Comments (${openComments})`) : t("Kommentare", "Comments")}
                  className={`icon-button comments-button${comments ? " active" : ""}${openComments ? " has-count" : comments ? "" : " topbar-phone-hidden"}`}
                  onClick={() => setComments(!comments)}
                >
                  <ChatCircle size={20} />
                  {openComments > 0 && <small className="comments-count">{openComments}</small>}
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
                  className="topbar-phone-hidden"
                  following={data.following}
                  followers={data.followers || 0}
                  onToggle={(follow) =>
                    act({ action: "page.follow", pageId: data.page.id, follow })
                  }
                />
              )}
              <button
                className={`icon-button topbar-phone-hidden ${boot.favorites.includes(data.page.id) ? "starred" : ""}`}
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
                <button className="button compact share-button topbar-phone-hidden" onClick={() => setSpaceKeys(data.encrypted!.spaceId)}>
                  <LockKey size={15} />
                  {t("Mitglieder", "Members")}
                </button>
              ) : (
                <button
                  className="button compact share-button topbar-phone-hidden"
                  onClick={() => setShare(true)}
                >
                  <ShareNetwork size={15} />
                  {t("Teilen", "Share")}
                </button>
              )}
              <PageMenu.Root label={t("Seitenaktionen", "Page actions")} sheet={sheetMenus} icon={<DotsThree size={24} />}>
                    {phone && (
                      <>
                        {/* Phones: what the top bar leaves out. Menu items
                            (a menu takes no Tab stops), their state as
                            aria-checked; follow and favourite keep the menu
                            open so the change shows. */}
                        <PageMenu.Group className="page-menu-quick">
                          {data.following !== undefined && (
                            <PageMenu.CheckboxItem
                              className="page-menu-quick-item follow"
                              checked={data.following}
                              onSelect={(e) => {
                                e.preventDefault();
                                void act({ action: "page.follow", pageId: data.page.id, follow: !data.following });
                              }}
                            >
                              <Bell size={22} weight={data.following ? "fill" : "regular"} />
                              <span>{t("Folgen", "Follow")}</span>
                            </PageMenu.CheckboxItem>
                          )}
                          <PageMenu.CheckboxItem
                            className="page-menu-quick-item favourite"
                            checked={boot.favorites.includes(data.page.id)}
                            onSelect={(e) => {
                              e.preventDefault();
                              void act({ action: "favorite", pageId: data.page.id, value: !boot.favorites.includes(data.page.id) });
                            }}
                          >
                            <Star size={22} weight={boot.favorites.includes(data.page.id) ? "fill" : "regular"} />
                            <span>{t("Favorit", "Favourite")}</span>
                          </PageMenu.CheckboxItem>
                          {data.encrypted ? (
                            <PageMenu.Item className="page-menu-quick-item" onSelect={() => setSpaceKeys(data.encrypted!.spaceId)}>
                              <LockKey size={22} />
                              <span>{t("Mitglieder", "Members")}</span>
                            </PageMenu.Item>
                          ) : (
                            <PageMenu.Item className="page-menu-quick-item" onSelect={() => setShare(true)}>
                              <ShareNetwork size={22} />
                              <span>{t("Teilen", "Share")}</span>
                            </PageMenu.Item>
                          )}
                        </PageMenu.Group>
                        {!data.encrypted && !openComments && !comments && (
                          <PageMenu.Item className="dropdown-item" onSelect={() => setComments(true)}>
                            <ChatCircle />
                            {t("Kommentare", "Comments")}
                          </PageMenu.Item>
                        )}
                        {canRead && (
                          <PageMenu.Item className="dropdown-item" onSelect={toggleReading}>
                            {reading ? <PencilSimple /> : <BookOpen />}
                            {reading ? t("Bearbeiten", "Edit") : t("Lesemodus", "Reading mode")}
                          </PageMenu.Item>
                        )}
                      </>
                    )}
                    {/* A journal and its days: the journal's "Heute" link as a
                        favourite of its own (#537). */}
                    {todayJournal && (
                      <PageMenu.Item className="dropdown-item" onSelect={() => void toggleTodayFavorite(todayJournal.id)}>
                        <CalendarDot />
                        {boot.todayFavorites?.includes(todayJournal.id)
                          ? t("Heute aus Favoriten entfernen", "Remove today from favourites")
                          : t("Heute zu Favoriten", "Add today to favourites")}
                      </PageMenu.Item>
                    )}
                    {/* Grouped with labels (design review): appearance as a
                        submenu (a section of its own in the phone sheet), then
                        editing, sharing and export, the view, and managing. */}
                    <PageMenu.Sub label={t("Darstellung", "Appearance")} icon={<PaintBrush />}>
                      <PageMenu.Item
                        className="dropdown-item"
                        onSelect={() => {
                          setIconPicker(true);
                        }}
                      >
                        <Flag />
                        {t("Icon ändern", "Change icon")}
                      </PageMenu.Item>
                      {!data.encrypted && (
                        <PageMenu.Item
                          className="dropdown-item"
                          onSelect={() => setCoverPicker(true)}
                        >
                          <ImageIcon />
                          {t("Cover ändern", "Change cover")}
                        </PageMenu.Item>
                      )}
                      {/* With "Seiten in voller Breite anzeigen" on (#257) every
                          page is wide for this person: the page's own switch
                          shows as on and locked, and says why. It still
                          applies for everyone else. */}
                      <PageMenu.Item
                        className="dropdown-item"
                        disabled={allPagesWide}
                        title={
                          allPagesWide
                            ? t(
                                "Deine Einstellung „Seiten in voller Breite anzeigen“ zeigt alle Seiten in voller Breite (Einstellungen → Darstellung & Sprache).",
                                "Your setting “Show pages at full width” shows every page at full width (Settings → Appearance & language).",
                              )
                            : undefined
                        }
                        onSelect={() =>
                          act({
                            action: "page.update",
                            pageId,
                            patch: { full_width: !data.page.full_width },
                          })
                        }
                      >
                        <ArrowsOutLineHorizontal />
                        {t("Volle Breite", "Full width")}{" "}{showsFullWidth(data.page.full_width, allPagesWide) ? "✓" : ""}
                        {allPagesWide && <small className="dropdown-hint">{t("Deine Einstellung", "Your setting")}</small>}
                      </PageMenu.Item>
                      {data.page.kind === "document" && !data.encrypted && (
                        <PageMenu.Item
                          className="dropdown-item"
                          onSelect={() =>
                            act({
                              action: "page.update",
                              pageId,
                              patch: { caption_numbers: !data.page.caption_numbers },
                            })
                          }
                        >
                          <ListNumbers />
                          {t("Beschriftungen nummerieren", "Number captions")}{" "}{data.page.caption_numbers ? "✓" : ""}
                        </PageMenu.Item>
                      )}
                      <PageMenu.Item
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
                      </PageMenu.Item>
                    </PageMenu.Sub>
                    <PageMenu.Section label={t("Bearbeiten", "Edit")}>
                      {!data.encrypted && (
                        <PageMenu.Item
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
                        </PageMenu.Item>
                      )}
                      <PageMenu.Item
                        className="dropdown-item"
                        onSelect={() => setMove(true)}
                      >
                        <ArrowRight />
                        {t("Verschieben", "Move")}
                      </PageMenu.Item>
                      {/* The sidebar's tree shows this branch (#318); on phones the drawer opens to show it. */}
                      {hasSubPages(data.page.id) && branchRef.current !== data.page.id && (
                        <PageMenu.Item
                          className="dropdown-item"
                          onSelect={() => {
                            setTreeBranch(data.page.id);
                            if (phone) setMobile(true);
                            else setDesktopCollapsed(false);
                          }}
                        >
                          <Crosshair />
                          {t("Im Seitenbaum fokussieren", "Focus in sidebar")}
                        </PageMenu.Item>
                      )}
                      {data.page.kind === "document" && !data.encrypted && (
                        <PageMenu.Item
                          className="dropdown-item"
                          onSelect={() => setToRecord(true)}
                        >
                          <Table />
                          {t("In Datenbank verschieben …", "Move into database …")}
                        </PageMenu.Item>
                      )}
                      {data.page.kind === "document" && editable && !data.locked && !data.encrypted && !data.draft && !data.offlineNew && (
                        <TasksMenuItem readHtml={readHtml} onSelect={() => setTasksToDatabase(true)} />
                      )}
                      {!data.encrypted && (
                        <PageMenu.Item
                          className="dropdown-item"
                          onSelect={() => setTemplateName(true)}
                        >
                          <SquaresFour />
                          {t("Als Vorlage speichern", "Save as template")}
                        </PageMenu.Item>
                      )}
                      {data.page.kind === "document" && !data.locked && !data.encrypted && (
                        <PageMenu.Item
                          className="dropdown-item"
                          onSelect={() => setSourcePage(sourceOpen ? null : data.page.id)}
                        >
                          <MarkdownLogo />
                          {sourceOpen
                            ? t("Markdown-Ansicht schließen", "Close Markdown view")
                            : editable
                              ? t("Als Markdown bearbeiten", "Edit as Markdown")
                              : t("Als Markdown anzeigen", "View as Markdown")}
                        </PageMenu.Item>
                      )}
                      {!data.encrypted && (
                        <PageMenu.Item className="dropdown-item" onSelect={() => openPageAliases(data.page.id)}>
                          <AliasIcon />
                          {t("Aliasse …", "Aliases …")}
                        </PageMenu.Item>
                      )}
                      <PageMenu.Item
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
                      </PageMenu.Item>
                    </PageMenu.Section>
                    <PageMenu.Section label={t("Teilen & Export", "Share & export")}>
                      {!data.encrypted && (
                        <PageMenu.Item
                          className="dropdown-item"
                          onSelect={() => setPageExport(true)}
                        >
                          <DownloadSimple />
                          {t("Exportieren", "Export")}
                        </PageMenu.Item>
                      )}
                      {!data.encrypted && (
                        <PageMenu.Item
                          className="dropdown-item"
                          onSelect={() => printOpenPage()}
                        >
                          <FileText />
                          {t("Drucken / PDF", "Print / PDF")}
                        </PageMenu.Item>
                      )}
                      <PageMenu.Item className="dropdown-item" onSelect={() => setPageQr(true)}>
                        <QrCode />
                        {t("QR-Code", "QR code")}
                      </PageMenu.Item>
                      {data.page.kind === "document" && !data.locked && !data.encrypted && (
                        <PageMenu.Item className="dropdown-item" onSelect={startPresentation}>
                          <PresentIcon />
                          {t("Präsentieren", "Present")}
                        </PageMenu.Item>
                      )}
                      {/* The desktop app: from a browser on a computer, the page
                          opens there (flowplan://open); inside the app, in a
                          window of its own. */}
                      {offerDesktopApp(currentOS(), inDesktopApp() || !!desktopApp(), nativeApp()) ? (
                        <PageMenu.Item className="dropdown-item" onSelect={() => void (location.href = desktopPageLink(location.origin, data.page.id))}>
                          <Desktop />
                          {t("In Desktop-App öffnen", "Open in desktop app")}
                        </PageMenu.Item>
                      ) : openInWindow() ? (
                        <PageMenu.Item
                          className="dropdown-item"
                          onSelect={() => openInWindow()?.(`${location.origin}${location.pathname}${pageLocationHash({ pageId: data.page.id })}`)}
                        >
                          <AppWindow />
                          {t("In neuem Fenster öffnen", "Open in new window")}
                        </PageMenu.Item>
                      ) : null}
                    </PageMenu.Section>
                    <PageMenu.Section label={t("Ansicht", "View")}>
                      {wide && (
                        <PageMenu.Item className="dropdown-item" onSelect={openSplitSearch}>
                          <SquareSplitHorizontal />
                          {splitShown ? t("Andere Seite daneben öffnen …", "Open another page beside it …") : t("Seite daneben öffnen …", "Open a page beside it …")}
                        </PageMenu.Item>
                      )}
                      {data.page.kind === "document" && !sourceOpen && (
                      <PageMenu.Item className="dropdown-item" onSelect={() => foldAllSections(true)}>
                        <ArrowsInLineVertical />
                        {t("Alle Abschnitte einklappen", "Collapse all sections")}
                      </PageMenu.Item>
                      )}
                      {data.page.kind === "document" && !sourceOpen && (
                      <PageMenu.Item className="dropdown-item" onSelect={() => foldAllSections(false)}>
                        <ArrowsOutLineVertical />
                        {t("Alle Abschnitte ausklappen", "Expand all sections")}
                      </PageMenu.Item>
                      )}
                      {data.page.kind === "document" && !data.locked && summaryRoute.availability !== "hidden" && (
                        <PageMenu.Item
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
                        </PageMenu.Item>
                      )}
                    </PageMenu.Section>
                    <PageMenu.Section label={t("Verwaltung", "Manage")}>
                      <PageMenu.Item className="dropdown-item" onSelect={() => openPageReview(data.page.id)}>
                        <UserCheck />
                        {t("Besitzer und Prüfung …", "Owner and review …")}
                      </PageMenu.Item>
                      {!data.encrypted && (
                        <PageMenu.Item
                          className="dropdown-item"
                          onSelect={() => setHistory(true)}
                        >
                          <Clock />
                          {t("Versionsverlauf", "Version history")}
                        </PageMenu.Item>
                      )}
                      {data.page.kind === "document" && !data.encrypted && (
                        <PageMenu.Item
                          className="dropdown-item"
                          // The open editor shows or hides who wrote what.
                          onSelect={() =>
                            window.dispatchEvent(new CustomEvent("flowplan:authors", { detail: data.page.id }))
                          }
                        >
                          <UsersThree />
                          {t("Autoren anzeigen", "Show authors")}
                        </PageMenu.Item>
                      )}
                      {/* The page with every page below it – a database with its records – and their files on this device (#417). */}
                      {offlineKeep.enabled && !isPendingPage(data.page.id) &&
                        (data.encrypted ? (
                          <PageMenu.Item className="dropdown-item" disabled>
                            <CloudCheck />
                            {t("Offline behalten", "Keep offline")}
                            <small className="dropdown-hint">{t("Verschlüsselte Bereiche bleiben nur online.", "Encrypted spaces stay online-only.")}</small>
                          </PageMenu.Item>
                        ) : offlineKeep.kept({ kind: "space", id: data.page.space_id }) ? (
                          <PageMenu.CheckboxItem className="dropdown-item" checked disabled>
                            <CloudCheck />
                            {t("Offline behalten", "Keep offline")} ✓
                            <small className="dropdown-hint">{t("Der ganze Bereich wird offline behalten.", "The whole space is kept offline.")}</small>
                          </PageMenu.CheckboxItem>
                        ) : (
                          <PageMenu.CheckboxItem
                            className="dropdown-item"
                            checked={offlineKeep.kept({ kind: "page", id: data.page.id })}
                            onSelect={() => void offlineKeep.toggle({ kind: "page", id: data.page.id }, !offlineKeep.kept({ kind: "page", id: data.page.id }))}
                          >
                            <CloudCheck />
                            {t("Offline behalten", "Keep offline")}{" "}{offlineKeep.kept({ kind: "page", id: data.page.id }) ? "✓" : ""}
                          </PageMenu.CheckboxItem>
                        ))}
                    </PageMenu.Section>
                    <PageMenu.Separator className="dropdown-separator" />
                    <PageMenu.Item
                      className="dropdown-item danger"
                      onSelect={async () => {
                        // Gone at once; a refusal opens the page again.
                        const deleted = pageId;
                        const pending = act({ action: "page.delete", pageId: deleted });
                        leaveDeleted(deleted);
                        if (!(await pending) && deleted) void openPage(deleted);
                      }}
                    >
                      <Trash />
                      {t("In den Papierkorb", "Move to trash")}
                    </PageMenu.Item>
              </PageMenu.Root>
              </>)}
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
        {tabBars && tabs.layout && (
          <TabBar
            tabs={tabs}
            frame={tabs.layout.frames[0]}
            index={0}
            frames={splitShown ? 2 : 1}
            focused={tabs.focused === 0}
            wide={wide}
            describe={describeTab}
            panelId="frame-panel-0"
          />
        )}
        <div
          className="main-scroll"
          ref={mainScroll}
          id="frame-panel-0"
          role={tabBars ? "tabpanel" : undefined}
          aria-labelledby={tabBars && tabs.layout ? `tab-${tabs.layout.frames[0].active}` : undefined}
        >
          {screen === "home" && !routeSettled && <RoutePendingPlaceholder />}
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
            ) : missingPage && missingPage.id === pageId ? (
              <PageMissing
                status={missingPage.status}
                onHome={() => go("home")}
                // The place before, if this tab has one; otherwise the start page.
                onBack={() => {
                  if (!goBack()) go("home");
                }}
              />
            ) : (
              <div className="loading-content">{t("Seite nicht verfügbar.", "Page not available.")}</div>
            )
          ) : (
            screen === "page" &&
            data && (
              <div className={`page-layout ${comments && !recordFull ? "with-comments" : ""}`}>
                <article
                  data-revalidating={revalidating ? "true" : undefined}
                  className={`page-content ${data.page.kind === "database" ? "database-page" : ""} ${data.page.kind === "whiteboard" ? "whiteboard-page" : ""} ${data.page.kind === "notebook" ? "notebook-page" : ""} ${data.page.kind === "workflow" ? "workflow-page-content" : ""} ${showsFullWidth(data.page.full_width, allPagesWide) ? "full-width" : ""}${recordFull ? " record-full-page" : ""}${data.journalDay ? " journal-day-page" : ""}${blockRoom ? " with-block-room" : ""} font-${data.page.font}`}
                >
                  {/* A record as a page of its own (#231): only the record. */}
                  {!recordFull && (<>
                  {/* A draft of a saved page template (#461): save it into the template or discard it. */}
                  {data.templateDraft && (
                    <TemplateDraftBar
                      key={data.page.id}
                      draft={data.templateDraft}
                      placeholders={
                        data.page.kind === "document"
                          ? contextOf(boot.taxonomy?.properties ?? [], data.page.space_id).map((p) => ({ id: p.id, name: p.name, type: p.type, options: p.options }))
                          : undefined
                      }
                      pageId={data.page.id}
                      workspaceId={boot.workspace.id}
                      onError={notifyError}
                      onDone={(outcome) => {
                        appCache().delete(pageKey(data.page.id));
                        currentId.current = null;
                        go("home");
                        setPageId(null);
                        setData(null);
                        notify(outcome === "saved" ? t("Vorlage gespeichert", "Template saved") : t("Entwurf verworfen", "Draft discarded"));
                        void refresh().catch(() => {});
                      }}
                    />
                  )}
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
                  {/* A page of a library (#329): its book and the next page to read. */}
                  {pageLibrary && <BookNav space={pageLibrary} pages={activePages} pageId={data.page.id} />}
                  {data.journalDay && !data.locked && (
                    // A day page: previous and next entry, today, a month picker (#49).
                    <JournalDayNav
                      date={data.journalDay.date}
                      today={localDay()}
                      days={(treeIndex.get(data.journalDay.journalId) || []).filter((p) => p.journal_date)}
                      onOpen={(id) => void openPage(id)}
                      onToday={() => void openJournalToday(data.journalDay!.journalId)}
                      onCreate={editable && canCreate ? (date) => void openJournalDate(data.journalDay!.journalId, date) : undefined}
                    />
                  )}
                  {/* "Seitensymbol" (#214, app/page-icon-inline.css): the large
                      icon above the title, or small on the title's first line. */}
                  <div className={`document-header${pageIconPlace === "inline" ? " icon-inline" : ""}`}>
                    <button
                      className="large-page-icon"
                      title={t("Seiten-Icon ändern", "Change page icon")}
                      onClick={() => editable && !data.draft && setIconPicker(true)}
                    >
                      <PageIcon
                        name={shownPageIcon(data.page.icon, data.page.kind)}
                        size={iconPixels[data.page.icon_size || ""]}
                      />
                    </button>
                    {editable && !data.page.cover && !data.encrypted && !data.draft && !data.offlineNew && (
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
                    <PageTitleField
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
                    {kindOff && (
                      <div className="locked-notice" role="note">
                        <Lock size={14} />
                        {t("Auf dieser Instanz ausgeschaltet – die Seite bleibt erhalten und lässt sich nur lesen.", "Switched off on this instance – the page is kept and can only be read.")}
                      </div>
                    )}
                  </div>
                  {data.offlineNew ? (
                    localOpen && (
                      <OfflinePageNotice
                        state={localOpen.state}
                        reason={localOpen.reason}
                        syncing={offlineQueue.syncing}
                        online={online}
                        kind={data.page.kind}
                        html={readHtml}
                        onRetry={() => offlineQueue.retry(data.page.id)}
                        onDiscard={() => {
                          offlineQueue.discard(data.page.id);
                          go("home");
                          setPageId(null);
                        }}
                      />
                    )
                  ) : data.draft ? (
                    <p className="journal-draft-hint" role="note">
                      {data.draft.local
                        ? t(
                            "Du bist offline: Was du hier schreibst, bleibt auf diesem Gerät und kommt in die Seite des Tages, sobald die Verbindung zurück ist.",
                            "You're offline: what you write here stays on this device and goes into the day's page as soon as the connection is back.",
                          )
                        : t(
                            "Noch nicht gespeichert: Die Seite für heute wird angelegt, sobald du etwas schreibst, eine Aufgabe abhakst, einen Wert einträgst oder eine Datei hinzufügst.",
                            "Not saved yet: today's page is created as soon as you write something, tick a task, enter a value or add a file.",
                          )}
                    </p>
                  ) : (
                    <>
                      <PageReview page={data.page} members={boot.members} editable={editable} act={act} />
                      {/* Tags and properties (#70). */}
                      <PagePropertyBar page={data.page} taxonomy={boot.taxonomy} meta={data.properties} collapsedChoice={data.propertiesCollapsed} members={boot.members} editable={editable} act={act} spaces={boot.spaces} />
                    </>
                  )}
                  {since?.pageId === data.page.id && since.value && (
                    <SinceVisitBanner
                      since={since.value}
                      onDismiss={() =>
                        setSince({ pageId: data.page.id, value: null })
                      }
                    />
                  )}
                  </>)}
                  <OfflineFailedUploads
                    failed={offlineQueue.failed.filter((f) => f.change.kind === "upload" && f.change.pageId === data.page.id && !f.cause)}
                    onRetry={(fileId) => offlineQueue.retry(fileId)}
                    onDiscard={(fileId) => offlineQueue.discardFile(fileId)}
                  />
                  {/* A part that fails (offline, not in the copy) shows a
                      message instead of taking the app down (#47). */}
                  <ViewBoundary key={`view-${data.page.id}`}>
                  {data.page.kind === "database" ? (
                    <>
                      {!recordFull && offlineQueue.queue.some(
                        (c) => c.pageId === data.page.id && c.kind !== "page" && c.kind !== "upload",
                      ) && (
                        <p className="offline-pending" role="status">
                          {
                            offlineQueue.queue.filter(
                              (c) => c.pageId === data.page.id && c.kind !== "page" && c.kind !== "upload",
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
                            { fields: data.database.fields, creator: boot.user.id },
                          ),
                        }}
                        members={boot.members}
                        pages={activePages}
                        editable={editable}
                        ai={uiAi}
                        favoriteRows={boot.favoriteRows}
                        mutate={mutate}
                        onError={notifyError}
                        onRecordView={setRecordView}
                      />
                    </>
                  ) : data.locked ? (
                    <JournalLockScreen
                      journalId={data.locked.journalId}
                      canReset={!!data.locked.canReset}
                      onUnlocked={refresh}
                    />
                  ) : data.page.kind === "journal" && data.journal ? (
                    <JournalView
                      pageId={data.page.id}
                      workspaceId={data.page.workspace_id}
                      spaceId={data.page.space_id}
                      days={data.journal.days}
                      settings={data.journal.settings}
                      editable={editable}
                      onOpen={(id) => void openPage(id)}
                      onRoll={rollJournal}
                      onToday={() => void openJournalToday(data.page.id)}
                      revealDays={revealJournalDays === data.page.id}
                      onRevealed={() => setRevealJournalDays(null)}
                      onChanged={refresh}
                      onError={notifyError}
                    />
                  ) : data.page.kind === "notebook" && data.notebook ? (
                    <NotebookView key={data.page.id} pageId={data.page.id} userId={boot.user.id} title={data.page.title} notebook={data.notebook} editable={editable && !data.page.locked} onError={(message) => notifyError(message)} />
                  ) : data.page.kind === "dashboard" && data.dashboard ? (
                    <DashboardView key={data.page.id} pageId={data.page.id} dashboard={data.dashboard} editable={editable} userId={boot.user.id} members={boot.members} pages={activePages} onRefresh={refresh} onError={notifyError} />
                  ) : data.page.kind === "workflow" && data.workflow ? (
                    <WorkflowView
                      key={`${data.page.id}-${data.workflow.draft?.generation || ""}`}
                      pageId={data.page.id}
                      workspaceId={data.page.workspace_id}
                      workflow={data.workflow}
                      editable={editable && !data.page.locked}
                      pages={activePages.map((p) => ({ id: p.id, title: p.title, kind: p.kind, icon: p.icon, space_id: p.space_id, parent_id: p.parent_id }))}
                      spaces={boot.spaces.map((s) => ({ id: s.id, name: s.name }))}
                      members={[boot.user, ...boot.members.filter((m) => m.id !== boot.user.id)].map((m) => ({ id: m.id, name: m.name }))}
                      me={{ id: boot.user.id, name: boot.user.name }}
                      onReload={refresh}
                      onError={notifyError}
                    />
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
                        journal_date: p.journal_date,
                        aliases: p.aliases,
                      }))}
                      members={boot.members}
                      workspaceId={data.page.workspace_id}
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
                      draft={
                        openedLocal.current.has(data.page.id)
                          ? {
                              // Made offline (#370): created by the offline
                              // queue; until then the editor keeps the text
                              // here as for a server away.
                              ensure: async () => {
                                if (isPendingPage(data.page.id)) {
                                  sendPendingNow();
                                  throw new TypeError("Offline page not created yet");
                                }
                                return true;
                              },
                            }
                          : data.draft?.local
                          ? {
                              // The day opens in its place once created; until
                              // then the editor waits as for a server away.
                              ensure: async () => {
                                if (await flushOfflineDay(data.page.id)) return false;
                                throw new TypeError("Offline draft not created yet");
                              },
                              journal: true,
                            }
                          : data.draft
                            ? { ensure: () => ensureDraftDay(data), journal: true }
                            : undefined
                      }
                      generation={data.generation}
                      pageId={data.page.id}
                      userId={boot.user.id}
                      pages={activePages}
                      members={boot.members}
                      state={data.state}
                      captionNumbers={!!data.page.caption_numbers}
                      html={data.html}
                      editable={editable}
                      onStatus={setStatus}
                      onError={notifyError}
                      onHtml={
                        data.draft?.local
                          ? (value: string) => {
                              setHtml(value);
                              keepOfflineText(data.page.id, value);
                            }
                          : setHtml
                      }
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
                      readOnlyHint={
                        reading
                          ? t("Im Lesemodus nicht änderbar", "Cannot be changed in reading mode")
                          : data.page.locked
                            ? t("Die Seite ist gesperrt – nicht änderbar", "The page is locked – cannot be changed")
                            : undefined
                      }
                    />
                    )}
                    {data.journalDay && data.journalDay.options?.completed !== false && (
                      <JournalCompleted key={`completed-${data.page.id}`} pageId={data.page.id} journalId={data.journalDay.journalId} />
                    )}
                    </>
                  )}
                  </ViewBoundary>
                  {pageLibrary && !data.draft && !recordFull && <BookNext space={pageLibrary} pages={activePages} pageId={data.page.id} />}
                  {!data.draft && !recordFull && (<>
                  {/* While a record of this database is open its own panels show; the page's wait until it closes (no requests for what the dialog covers). */}
                  {discoveryPanels && !recordView && !data.offlineNew && !(data.page.kind === "database" && typeof location !== "undefined" && parsePageLocation(location.hash)?.rowId) && (
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
                            <PageIcon name={shownPageIcon(p.icon, p.kind || (p.rowId ? "record" : "document"))} />
                            {p.title}
                            {p.pageTitle && <small className="muted">{p.pageTitle}</small>}
                          </button>
                        ))}
                      </>
                    )}
                  </div>
                  )}
                  <div className="subpages">
                    {activePages
                      // Journal days are listed by the journal itself.
                      // Pages below a record show with the record (#231).
                      .filter(
                        (p) =>
                          p.parent_id === data.page.id &&
                          !p.journal_date &&
                          !(p.parent_row_id && boot.recordParents?.some((r) => r.pageId === data.page.id && r.rowId === p.parent_row_id)),
                      )
                      .map((p) => (
                        <button key={p.id} onClick={() => openPage(p.id)}>
                          <PageIcon name={p.icon} />
                          {p.title}
                          {p.offline && <OfflineMark state={p.offline} />}
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
                {comments && !recordFull && (
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
                      userId={boot.user.id}
                      act={act}
                      time={(value) => relativeTime(value, clock, locale)}
                    />
                    {/* Formatted, with attachments and page mentions (#450). */}
                    <PageCommentField pageId={data.page.id} act={act} placeholder={t("Schreibe einen Kommentar …", "Write a comment …")} />
                  </aside>
                )}
              </div>
            )
          )}
          {screen === "trash" && (
            <TrashView
              boot={boot}
              act={act}
              clock={clock}
              locale={locale}
              onOpenRecord={(pageId, rowId) => void openPage(pageId, { pageId, rowId })}
              onPurgeSpace={(space) => setSpaceManager({ space, purge: true })}
            />
          )}
          {screen === "study" && <StudyScreen workspaceId={boot.workspace.id} userId={boot.user.id} spaces={boot.spaces} onOpenPage={(id) => void openPage(id)} />}
          {studyDeck && <StudyFocus key={studyDeck.pageId} pageId={studyDeck.pageId} title={studyDeck.title || t("Lernen", "Study")} onClose={() => setStudyDeck(null)} />}
          {aiCards && (
            <StudyAiCards open onClose={() => setAiCards(null)} workspaceId={boot.workspace.id} spaces={boot.spaces} start={aiCards} onOpenPage={(id) => void openPage(id)} />
          )}
          {screen === "media" && (
            <MediaLibrary
              workspaceId={boot.workspace.id}
              act={act}
              onOpen={(id) => void openPage(id)}
              onOpenTrash={() => go("trash")}
              onUpload={canCreate ? () => setFileUploadDialog(true) : undefined}
            />
          )}
          {screen === "library" && !libraryPlace && (
            <LibraryHome
              spaces={boot.spaces}
              pages={activePages}
              userId={boot.user.id}
              workspaceId={boot.workspace.id}
              visits={boot.recentVisits || []}
              clock={clock}
              manageable={manageableSpaces}
              workspaceOwner={boot.workspace.role === "owner"}
              onManageShelf={(space) => setSpaceManager({ space })}
            />
          )}
          {screen === "library" &&
            libraryPlace &&
            (librarySpace ? (
              <LibraryView
                space={librarySpace}
                pages={activePages}
                bookId={libraryPlace?.bookId ?? null}
                chapterId={libraryPlace?.chapterId ?? null}
                workspaceId={boot.workspace.id}
                visits={boot.recentVisits || []}
                clock={clock}
                canEdit={canCreate}
                onCreate={(parentId, title) => createLibraryPage(librarySpace.id, parentId, title)}
                onRename={(pageId, title) => act({ action: "page.update", pageId, patch: { title } })}
                userId={boot.user.id}
                manage={manageableSpaces.has(librarySpace.id)}
                workspaceOwner={boot.workspace.role === "owner"}
                onManageShelf={() => setSpaceManager({ space: librarySpace })}
                onShareBook={(id) =>
                  void openPage(id, { pageId: id, edit: true }).then(() => setShare(true), () => {})
                }
              />
            ) : (
              <div className="loading-content">{t("Bibliothek nicht verfügbar.", "Library not available.")}</div>
            ))}
          {screen === "collection" && collectionId && (
            <CollectionView
              boot={boot}
              collectionId={collectionId}
              onOpen={(id) => void openPage(id)}
              onEdit={(c) => setCollectionDraft(c)}
              onDuplicate={(c) => void duplicateCollection(c)}
              onDelete={(c) => void deleteCollection(c)}
            />
          )}
          {screen === "tags" && (
            <TagView
              boot={boot}
              pages={activePages}
              onOpen={(id) => void openPage(id)}
              onError={notifyError}
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
              workspaces={boot.workspaces}
              onOpen={(pageId, rowId) => {
                location.hash = rowId ? `page=${pageId}&row=${rowId}` : `page=${pageId}`;
              }}
              onError={notifyError}
              onChanged={() => void refresh()}
              onSeen={markTasksSeen}
            />
          )}
          {screen === "inbox" && (
            <div className="utility-content inbox-screen">
              <Inbox
                notifications={boot.notifications}
                more={!!boot.notificationsMore}
                unread={unreadNotifications}
                members={boot.members}
                workspaces={boot.workspaces}
                clock={clock}
                locale={locale}
                act={act}
                onOpen={openNotification}
                onWorkspace={(n, id, hash) => void openAddedWorkspace(n, id, hash)}
              />
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
        </div>
          </div>
          {splitShown && tabs.side && (
            <>
              <SplitDivider value={splitRatio} onChange={setSplitRatio} container={() => splitRow.current} />
              {(() => {
                const bar = (
                  <TabBar
                    tabs={tabs}
                    frame={tabs.side}
                    index={1}
                    frames={2}
                    focused={tabs.focused === 1}
                    wide={wide}
                    describe={describeTab}
                    panelId="frame-panel-1"
                  />
                );
                // A screen of the app (start page, inbox, settings …) shows
                // in the left frame only.
                if (!split)
                  return (
                    <SplitUnsupported
                      tabBar={bar}
                      title={sidePlace ? describeTab(sidePlace).title : ""}
                      onOpenMain={() => tabs.move(1, tabs.side!.active, 0, Number.MAX_SAFE_INTEGER)}
                    />
                  );
                return (
                  <SplitPane
                    key={`${tabs.side.active}:${split}`}
                    pageId={split}
                    tabBar={bar}
                    userId={boot.user.id}
                    userName={boot.user.name}
                    demo={!!boot.user.demo}
                    pages={activePages}
                    members={boot.members}
                    ai={uiAi}
                    transcription={!!boot.instance?.transcription}
                    onOpenMain={() => tabs.move(1, tabs.side!.active, 0, Number.MAX_SAFE_INTEGER)}
                    onOpenPage={(id) => tabs.openPlace(`page=${id}`, "here", 1) || void openPage(id)}
                  />
                );
              })()}
            </>
          )}
          {tabs.drag && wide && tabs.layout?.frames.length === 1 && <TabEdgeDrop tabs={tabs} />}
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
                if (id) openSplit(id, 0);
              }}
            >
              <SquareSplitHorizontal size={24} aria-hidden="true" />
              <span>{t("Hier ablegen, um die Seite daneben zu öffnen", "Drop here to open the page beside it")}</span>
            </div>
          )}
        </div>
      </main>
      {/* The docked side panel's place (components/side-panel.tsx). */}
      <div id="side-dock-root" className="side-dock-root" />
      <AppPromo paused={onboarding} />
      {/* Offline use on a device the introduction did not run on (#295):
          for people who went through the introduction (it asks there), once
          per device, not while it is open. */}
      {!onboarding && boot.gettingStarted && (
        <OfflineOfferPrompt userId={boot.user.id} workspaceId={boot.workspace.id} guest={!!boot.workspace.guest} demo={!!boot.user.demo} />
      )}
      {/* #marketplace-import and "Vorlage aus Datei importieren" (components/marketplace.tsx). */}
      <MarketplaceReceiver
        config={boot.instance?.marketplace}
        boot={boot}
        onSwitchWorkspace={(id) => switchWorkspace(id)}
        onImported={async (result) => {
          await refresh().catch(() => {});
          if (result.pageId) void openPage(result.pageId);
        }}
      />
      {onboarding && (
        <Onboarding
          boot={boot}
          theme={theme}
          chooseTheme={chooseTheme}
          mutate={(b) => mutate({ workspaceId: boot.workspace.id, ...b })}
          refresh={refresh}
          initialStep={onboardingStep}
          onOpenPage={(pageId) => void openPage(pageId)}
          onOpenHash={(hash) => {
            location.hash = hash;
          }}
          onClose={() => {
            setOnboarding(false);
            setOnboardingStep(undefined);
          }}
        />
      )}
      {/* "Drucken / PDF" with options and presets (#215). */}
      <PrintDialogHost
        settings={boot.print}
        workspace={boot.printPresets}
        workspaceId={boot.workspace.id}
        owner={boot.workspace.role === "owner" && !boot.workspace.guest}
        command={(body) => api("/api/command", body)}
      />
      {/* "Neu in Flowplan" (#223): once after an update, and on request. */}
      <WhatsNew
        notes={boot.updateNotes}
        paused={onboarding}
        onSeen={() => api("/api/command", { action: "profile.updateNotes", seen: true })}
      />
      <FindInPage open={find.open} focusKey={find.key} onClose={() => setFind((f) => ({ ...f, open: false }))} />
      <KeyboardShortcuts
        open={shortcuts}
        onClose={() => setShortcuts(false)}
        ai={!!uiAi?.features.write.ok}
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
                    {t(`${sp.name} (oberste Ebene)`, `${sp.name} (top level)`)}
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
                    .flatMap(({ page, level }) => [
                      <option key={page.id} value={`page:${page.id}`}>
                        {"\u00a0\u00a0".repeat(level + 1)}
                        {page.title}
                      </option>,
                      // Its records with sub-pages (#231); any record via "Verschieben nach …" of one page.
                      ...(page.kind === "database"
                        ? (recordItems.get(page.id) || []).map((r) => (
                            <option key={`${page.id}:${r.rowId}`} value={`record:${page.id}:${r.rowId}`}>
                              {"\u00a0\u00a0".repeat(level + 2)}
                              {r.title || t("Ohne Titel", "Untitled")}
                            </option>
                          ))
                        : []),
                    ])}
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
      <CommandPalette
        handle={palette}
        workspaceId={boot.workspace.id}
        pages={activePages}
        spaces={boot.spaces}
        recordParents={boot.recordParents ?? NO_RECORD_PARENTS}
        taxonomy={boot.taxonomy}
        recentVisits={boot.recentVisits}
        hasJournal={workspaceHasJournal}
        phone={phone}
        canAsk={canAsk}
        clock={clock}
        commands={paletteCommands}
        onCommand={runPaletteCommand}
        onOpen={openPaletteHit}
        onAsk={openAsk}
        onSaveCollection={(query, name) => {
          newCollection(query);
          setCollectionDraft((d) => d && { ...d, name });
        }}
        onOpened={onPaletteOpened}
      />
      {/* Mounted with the first opening and kept: a closed panel keeps its
          conversation (and a running answer) for the next time. */}
      {canAsk && (askMounted || !!ask) && (
        <AskPanel
          open={!!ask}
          hidden={focusMode && screen === "page"}
          request={ask}
          onClose={() => setAsk(null)}
          width={askWidth}
          onWidth={setAskWidth}
          pinned={askPinned}
          onPinned={setAskPinned}
          workspaceId={boot.workspace.id}
          ai={uiAi}
          spaces={boot.spaces}
          userName={boot.user.name}
          pages={boot.pages}
          recentVisits={boot.recentVisits}
          currentPage={
            screen === "page" && data
              ? {
                  id: data.page.id,
                  title: data.page.title || t("Ohne Titel", "Untitled"),
                  kind: data.page.kind,
                  // Suggested changes need edit rights (checked again on the server).
                  editable: mayEdit && data.page.kind === "document",
                  encrypted: !!data.encrypted,
                  // "Was ist diese Woche fällig?" needs a date to look at.
                  hasDate: data.page.kind === "database" && !!data.database?.fields.some((f) => f.type === "date"),
                }
              : null
          }
          onOpenSource={(pid, rowId) => {
            // The panel stays open beside the page (#59).
            void openPage(pid, rowId ? { pageId: pid, rowId } : undefined);
          }}
        />
      )}
      <NewPageDialog
        open={create}
        onClose={() => setCreate(false)}
        boot={{ workspace: boot.workspace, spaces: boot.spaces, ai: uiAi }}
        title={newTitle}
        onTitle={setNewTitle}
        kind={newKind}
        onKind={(kind) => {
          setNewKind(kind);
          setStarterTemplate(null);
          setSavedTemplate(null);
          // The template's name goes with it, a name typed by hand stays.
          if (suggestedTitle !== null && newTitle === suggestedTitle) setNewTitle("");
          setSuggestedTitle(null);
        }}
        template={
          savedTemplate
            ? { name: savedTemplate.name }
            : starterTemplate
              ? { name: catalogFor(LOCALE_TAG === "de-DE" ? "de" : "en")[starterTemplate]?.name ?? "" }
              : null
        }
        titleFromTemplate={suggestedTitle !== null && newTitle === suggestedTitle}
        onTemplateTitle={(name) => {
          if (newTitle.trim() && newTitle !== suggestedTitle) return;
          setNewTitle(name);
          setSuggestedTitle(name);
        }}
        onTemplates={() => {
          setTemplatesFor({ spaceId, parent });
          setCreate(false);
          setTemplates(true);
        }}
        databaseChoice={databaseChoice}
        onDatabaseChoice={setDatabaseChoice}
        aiCreate={aiCreate}
        onAiCreate={setAiCreate}
        aiProposal={aiProposal}
        onAiProposal={setAiProposal}
        onNotebookPdf={setNotebookPdf}
        onUploadFiles={
          canCreate && !parentRow
            ? () => {
                setCreate(false);
                pickFilePages(spaceId, parent);
              }
            : undefined
        }
        spaceId={spaceId}
        onSpace={(id) => {
          setSpaceId(id);
          setParent(null);
          setParentRow(null);
        }}
        onOpenDuplicate={(id, rowId) => {
          setCreate(false);
          void openPage(id, rowId ? { pageId: id, rowId } : undefined);
        }}
        onError={notifyError}
        onSubmit={async (e) => {
          e.preventDefault();
          // Offline – or below a page made offline that the server does not
          // have yet – the page is made on this device and created once the
          // connection is back (#370). Not offline: journals, dashboards,
          // workflows, saved templates, AI databases, PDF notebooks, pages
          // of encrypted spaces: they need the server, the note says so.
          const space = boot.spaces.find((s) => s.id === spaceId) as { encrypted?: number } | undefined;
          if (deviceOffline() || (parent && isPendingPage(parent))) {
            const catalog = catalogFor(LOCALE_TAG === "de-DE" ? "de" : "en");
            const starter = starterTemplate ? catalog[starterTemplate] : undefined;
            const kind = starter?.kind ?? newKind;
            const local =
              isOfflinePageKind(kind) &&
              !savedTemplate &&
              !space?.encrypted &&
              !parentRow &&
              !(starterTemplate && !offlineTemplate(starterTemplate, starter)) &&
              !(kind === "notebook" && notebookPdf) &&
              !(kind === "database" && !starterTemplate && (aiCreate || databaseChoice.startsWith("template:")));
            if (!local) {
              showNotice(offlineNoteText());
              return;
            }
            const id = crypto.randomUUID();
            offlineQueue.addPage(
              pageChange({
                id,
                workspaceId: boot.workspace.id,
                spaceId,
                parentId: parent,
                kind,
                title: newTitle.trim() || starter?.name || t("Ohne Titel", "Untitled"),
                databaseKind: kind === "database" && !starterTemplate ? databaseChoice : undefined,
                starter: starterTemplate && starter ? { key: starterTemplate, template: starter } : undefined,
                newId: () => crypto.randomUUID(),
                key: newIdempotencyKey(),
                at: Date.now(),
              }),
            );
            if (kind === "database" && !starterTemplate) rememberDatabaseKind(databaseChoice);
            setNotebookPdf(null);
            setCreate(false);
            setAiCreate(false);
            setAiProposal(null);
            focusTitleOf.current = id;
            void openPage(id);
            return;
          }
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
            ...(parent && parentRow ? { parentRowId: parentRow } : {}),
            title: titleEncrypted ? ENCRYPTED_TITLE : newTitle.trim() || savedTemplate?.name || (starterTemplate && catalogFor(LOCALE_TAG === "de-DE" ? "de" : "en")[starterTemplate]?.name) || t("Ohne Titel", "Untitled"),
            kind: newKind,
            // A workflow's schedule and "today" in the creator's time zone,
            // as the {{Heute}} of a page template (#653).
            ...(newKind === "workflow" || savedTemplate ? { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" } : {}),
            ...(savedTemplate
              ? {
                  templateId: savedTemplate.id,
                  // Decided for the space the template was chosen for; in
                  // another one the server's default.
                  ...(savedTemplate.meta && savedTemplate.metaSpace === spaceId ? { meta: savedTemplate.meta } : {}),
                }
              : { starterTemplate }),
            ...(newKind === "database" && !starterTemplate && !savedTemplate
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
            if (newKind === "notebook" && notebookPdf && !savedTemplate) queueNotebookImport(String(result.id), notebookPdf);
            // "Diagramm-Seite": draw.io opens for the new page's diagram.
            if (starterTemplate && catalogFor(LOCALE_TAG === "de-DE" ? "de" : "en")[starterTemplate]?.openDiagram)
              queueDrawioOpen(String(result.id));
            setNotebookPdf(null);
            if (newKind === "database" && !starterTemplate && !savedTemplate && !aiCreate) rememberDatabaseKind(databaseChoice);
            setCreate(false);
            setAiCreate(false);
            setAiProposal(null);
            focusTitleOf.current = String(result.id);
            void openPage(String(result.id));
          }
        }}
      />
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
      {tasksToDatabase && pageId && (
        <TasksToDatabase
          pageId={pageId}
          act={act}
          onClose={() => setTasksToDatabase(false)}
          onError={notifyError}
          onDone={() => setTasksToDatabase(false)}
        />
      )}
      {capture && (
        <QuickCapture
          workspaceId={boot.workspace.id}
          online={online}
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
      {(share || shareMounted) && (
      <ShareDialog
        open={share}
        onClose={() => setShare(false)}
        page={data?.page ?? null}
        role={data?.role ?? "viewer"}
        // Reading mode is only a view: it doesn't stop sharing (#524).
        editable={mayEdit}
        blockedBy={
          !data || mayEdit ? null : kindOff ? "module" : data.page.locked && ["editor", "owner"].includes(data.role) ? "locked" : "rights"
        }
        shareLinks={data?.shareLinks}
        publication={data?.publication}
        workspaceId={boot.workspace.id}
        me={boot.user}
        members={boot.members.filter((m) => m.id !== boot.user.id)}
        space={shareSpace}
        spaceMembers={shareSpace?.visibility === "team" && !boot.workspace.guest ? boot.members.filter((m) => !m.guest).length : null}
        onManageSpace={
          shareSpace && (boot.workspace.role === "owner" || (canCreate && shareSpace.owner_id === boot.user.id))
            ? () => {
                setShare(false);
                setSpaceManager({ space: shareSpace });
              }
            : undefined
        }
        act={act}
        onChanged={() => void refresh().catch(() => {})}
        onError={notifyError}
      />
      )}
      <Modal
        open={history}
        onClose={() => setHistory(false)}
        title={t("Versionsverlauf", "Version history")}
        className="version-history"
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
            <div className="version-list">
              {data.snapshots.map((s) => (
                <div className="utility-row version-row" key={s.id}>
                  <Clock />
                  <span className="version-text">
                    <strong>{s.title}</strong>
                    <small>
                      {new Date(s.created_at + "Z").toLocaleString(LOCALE_TAG)}
                      {" · "}
                      {s.kind === "manual"
                        ? t("Manuell gesichert", "Saved manually")
                        : t("Automatisch", "Automatic")}
                    </small>
                  </span>
                  <span className="version-actions">
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
                  </span>
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
          removeImage={(fileId) => mutate({ action: "file.delete", fileIds: [fileId], unusedOnly: true })}
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
      {collectionDraft && (
        <CollectionEditor
          boot={boot}
          draft={collectionDraft}
          act={act}
          onClose={() => setCollectionDraft(null)}
          onSaved={(id) => {
            setCollectionDraft(null);
            openCollection(id);
          }}
        />
      )}
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
              await switchWorkspace(String(r.id), { fromSidebar: true });
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
          {/* Like the other dialogs: cancel and the main action, right-aligned. */}
          <div className="modal-actions">
            <button type="button" className="button" onClick={() => setNewWorkspace(false)}>
              {t("Abbrechen", "Cancel")}
            </button>
            <button className="button primary">{t("Erstellen", "Create")}</button>
          </div>
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
          <div className="modal-actions">
            <button type="button" className="button" onClick={() => setNewSpace(false)}>
              {t("Abbrechen", "Cancel")}
            </button>
            <button className="button primary">{t("Bereich erstellen", "Create space")}</button>
          </div>
        </form>
      </Modal>
      <Modal
        open={templates}
        onClose={() => {
          setTemplates(false);
          // Opened from the "New page" dialog: back to it.
          if (templatesFor) {
            setTemplatesFor(null);
            setCreate(true);
          }
        }}
        title={t("Vorlagen", "Templates")}
      >
        <p className="muted">
          {t("Starte mit einer Struktur oder verwende deine gespeicherten Vorlagen.", "Start with a structure or use your saved templates.")}
        </p>
        <nav className="template-categories" aria-label={t("Kategorien", "Categories")}>
          {[
            ["all", t("Alle", "All")],
            ...(savedTemplateCount ? [["mine", t("Eigene Vorlagen", "My templates")]] : []),
            ...Object.entries(templateCategories).map(([id, label]) => [id, t(label)]),
          ].map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={shownCategory === id ? "selected" : ""}
              aria-pressed={shownCategory === id}
              onClick={() => setGalleryCategory(id)}
            >
              {label}
            </button>
          ))}
        </nav>
        {shownCategory !== "mine" && (
          <div className="template-grid">
            {Object.entries(catalogFor(LOCALE_TAG === "de-DE" ? "de" : "en"))
              .filter(([, template]) => shownCategory === "all" || template.category === shownCategory)
              .map(([templateKey, template]) => (
                <button
                  key={templateKey}
                  // Offline: templates whose content comes with the app (#370).
                  disabled={!online && !offlineTemplate(templateKey, template)}
                  title={!online && !offlineTemplate(templateKey, template) ? offlineNoteText() : undefined}
                  onClick={() => {
                    setTemplates(false);
                    // From the "New page" dialog the page keeps its place
                    // and the name typed there (#213).
                    newPageFromTemplate({ starter: templateKey, name: template.name, kind: template.kind }, templatesFor?.spaceId ?? currentSpaceId, templatesFor?.parent ?? null, !!templatesFor);
                    setTemplatesFor(null);
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
        )}
        {/* The Flowplan Marketplace for more (components/marketplace.tsx); nothing when it is off. */}
        <MarketplaceLink config={boot.workspace.guest ? null : boot.instance?.marketplace} className="template-more">
          <Storefront aria-hidden /> {t("Mehr Vorlagen im Marketplace", "More templates in the marketplace")}
          <ArrowSquareOut aria-hidden />
        </MarketplaceLink>
        {!online ? (
          <p className="muted" role="note">
            {t("Gespeicherte Vorlagen und der Marketplace gehen nur mit Verbindung – du bist gerade offline.", "Saved templates and the marketplace need a connection – you're offline right now.")}
          </p>
        ) : (
        <SavedTemplates
          workspaceId={boot.workspace.id}
          canCreate={canCreate}
          isAdmin={!!boot.user.isAdmin}
          trashDays={boot.trashDays}
          onError={notifyError}
          onCount={setSavedTemplateCount}
          // The space a new page goes to – the "New page" dialog's, else the
          // current one (#317): its templates and the workspace's first;
          // others bring their space's tags along (#136).
          spaceId={templatesFor?.spaceId ?? (currentSpaceId || undefined)}
          spaces={liveSpaces}
          manageWorkspace={!!boot.taxonomy?.manage}
          marketplace={boot.workspace.guest ? null : boot.instance?.marketplace}
          // The "New page" dialog with the template chosen: the name first
          // (#213), then the page.
          onUse={async (t, meta) => {
            setTemplates(false);
            newPageFromTemplate({ saved: t.id, name: t.name, kind: t.kind, meta }, templatesFor?.spaceId ?? currentSpaceId, templatesFor?.parent ?? null, !!templatesFor);
            setTemplatesFor(null);
          }}
          // "Inhalt bearbeiten" (#461): the template's draft opens as a page.
          onOpenDraft={(id) => {
            setTemplates(false);
            setTemplatesFor(null);
            appCache().delete(pageKey(id));
            void openPage(id);
          }}
          // "Aus Seite ersetzen …" (#461): the pages to choose from.
          pages={activePages}
        />
        )}
      </Modal>
      <Modal
        open={templateName}
        onClose={() => setTemplateName(false)}
        title={t("Vorlage speichern", "Save template")}
      >
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const body = {
              action: "template.save",
              pageId,
              name: templateTitle || data?.page.title,
              private: privateTemplate,
              ...(templateScope === "workspace" ? { spaceId: null, ...(templateSpaceRefs ? { spaceMeta: "remove" } : {}) } : {}),
            };
            let r: unknown = null;
            try {
              r = await mutate(body);
            } catch (error) {
              // A workspace template with tags of this space: say which, and
              // offer to save it without them.
              const message = (error as Error).message;
              if (templateScope === "workspace" && !templateSpaceRefs && (error as { status?: number }).status === 409 && /spaceMeta/.test(message)) {
                setTemplateSpaceRefs(message);
                return;
              }
              notifyError(error);
            }
            if (r) {
              setTemplateName(false);
              setTemplateSpaceRefs("");
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
          {data?.page && (
            <ScopeChoice
              value={templateScope === "workspace" ? null : data.page.space_id}
              spaceId={data.page.space_id}
              spaceName={boot.spaces.find((sp) => sp.id === data.page.space_id)?.name}
              workspaceAllowed={privateTemplate || !!boot.taxonomy?.manage}
              onChange={(next) => {
                setTemplateScope(next ? "space" : "workspace");
                setTemplateSpaceRefs("");
              }}
            />
          )}
          {templateSpaceRefs && (
            <p className="callout" role="alert">
              {templateSpaceRefs}{" "}
              {t("„Speichern“ speichert die Vorlage ohne sie.", "“Save” saves the template without them.")}
            </p>
          )}
          <div className="modal-actions">
            <button type="button" className="button" onClick={() => setTemplateName(false)}>
              {t("Abbrechen", "Cancel")}
            </button>
            <button className="button primary">{t("Speichern", "Save")}</button>
          </div>
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
              aria-label={
                pageMenu.today
                  ? t(`Aktionen für ${todayFavoriteLabel(pageMenu.page)}`, `Actions for ${todayFavoriteLabel(pageMenu.page)}`)
                  : selectedPages.length > 1 && selectedPages.includes(pageMenu.page.id)
                  ? t(`Aktionen für ${pagesLabel(selectedPages.length)}`, `Actions for ${pagesLabel(selectedPages.length)}`)
                  : t(`Aktionen für ${pageMenu.page.title || t("Ohne Titel", "Untitled")}`, `Actions for ${pageMenu.page.title || t("Ohne Titel", "Untitled")}`)
              }
            >
              {(() => {
                const target = pageMenu.page;
                // A journal's "Heute" favourite (#537).
                if (pageMenu.today)
                  return (
                    <>
                      <Dropdown.Item className="dropdown-item" onSelect={() => void openJournalToday(target.id)}>
                        <CalendarDot />
                        {t("Heute öffnen", "Open today")}
                      </Dropdown.Item>
                      <Dropdown.Item className="dropdown-item" onSelect={() => void openPage(target.id)}>
                        <Notebook />
                        {t("Journal öffnen", "Open journal")}
                      </Dropdown.Item>
                      <Dropdown.Separator className="dropdown-separator" />
                      <Dropdown.Item className="dropdown-item" onSelect={() => void act({ action: "favorite.today", pageId: target.id, value: false })}>
                        <X />
                        {t("Heute aus Favoriten entfernen", "Remove today from favourites")}
                      </Dropdown.Item>
                    </>
                  );
                // A page of a selection of several (#275): the actions for
                // all selected pages, as in the selection bar.
                if (selectedPages.length > 1 && selectedPages.includes(target.id))
                  return (
                    <>
                      <Dropdown.Item
                        className="dropdown-item"
                        disabled={bulkBusy}
                        onSelect={() => {
                          setBulkTarget("");
                          setBulkDialog("move");
                        }}
                      >
                        <ArrowRight />
                        {t("Verschieben", "Move")}
                      </Dropdown.Item>
                      <Dropdown.Item className="dropdown-item" disabled={bulkBusy} onSelect={() => void bulkPages("duplicate")}>
                        <Copy />
                        {t("Duplizieren", "Duplicate")}
                      </Dropdown.Item>
                      {selectionMenuItems()}
                      <Dropdown.Separator className="dropdown-separator" />
                      <Dropdown.Item className="dropdown-item danger" disabled={bulkBusy} onSelect={() => setBulkDialog("delete")}>
                        <Trash />
                        {t("In den Papierkorb", "Move to trash")}
                      </Dropdown.Item>
                    </>
                  );
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
                        {tabs.on ? t("In neuem Browser-Tab öffnen", "Open in new browser tab") : t("In neuem Tab öffnen", "Open in new tab")}
                      </Dropdown.Item>
                    )}
                    {/* Tabs of the app (#279). */}
                    {tabs.on && (
                      <Dropdown.Item className="dropdown-item" onSelect={() => tabs.openPlace(`page=${target.id}`, "tab")}>
                        <Browsers />
                        {t("In neuem Tab öffnen", "Open in new tab")}
                      </Dropdown.Item>
                    )}
                    {wide && tabs.on && (
                      <Dropdown.Item className="dropdown-item" onSelect={() => openSplit(target.id)}>
                        <SquareSplitHorizontal />
                        {t("In geteilter Ansicht öffnen", "Open in split view")}
                      </Dropdown.Item>
                    )}
                    {/* Only pages with sub-pages: a branch of one row helps nobody (#318). */}
                    {branchRef.current === target.id ? (
                      <Dropdown.Item className="dropdown-item" onSelect={() => setTreeBranch(null, { moveFocus: true })}>
                        <X />
                        {t("Ganzen Seitenbaum zeigen", "Show whole page tree")}
                      </Dropdown.Item>
                    ) : (
                      hasSubPages(target.id) && (
                        <Dropdown.Item className="dropdown-item" onSelect={() => setTreeBranch(target.id, { moveFocus: true })}>
                          <Crosshair />
                          {t("Im Seitenbaum fokussieren", "Focus in sidebar")}
                        </Dropdown.Item>
                      )
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
                    {target.kind === "journal" && (
                      <Dropdown.Item className="dropdown-item" onSelect={() => void toggleTodayFavorite(target.id)}>
                        <CalendarDot />
                        {boot.todayFavorites?.includes(target.id)
                          ? t("Heute aus Favoriten entfernen", "Remove today from favourites")
                          : t("Heute zu Favoriten", "Add today to favourites")}
                      </Dropdown.Item>
                    )}
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
                            if (open) leaveDeleted(target.id);
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
      {metaMove && (
        <MetaResolveDialog
          open
          title={t("Tags und Eigenschaften mitnehmen", "Bring tags and properties along")}
          intro={moveIntro(t, metaMove.target)}
          items={metaMove.items}
          target={metaMove.target}
          confirm={t("Verschieben", "Move")}
          onClose={() => setMetaMove(null)}
          onConfirm={async (plan) => {
            const run = metaMove.run;
            setMetaMove(null);
            await run(plan);
          }}
        />
      )}
      <MovePageDialog
        open={move}
        onClose={() => setMove(false)}
        page={activePages.find((p) => p.id === pageId)}
        workspaces={boot.workspaces}
        currentWorkspace={boot.workspace.id}
        current={{ spaces: boot.spaces, pages: activePages }}
        onMove={async ({ spaceId: target, parentId, parentRowId, workspaceId, meta }) => {
          const moved = pageId;
          const r = await act({
            action: "page.move",
            workspaceId: boot.workspace.id,
            pageId: moved,
            parentId,
            ...(parentId && parentRowId ? { parentRowId } : {}),
            spaceId: target,
            // Tags and properties of the source space, as chosen (#136).
            ...(meta ? { meta } : {}),
          });
          if (!r) return false;
          // Follow the page into the other workspace. The move is done, so
          // the dialog closes now; switching and loading the page show their
          // own progress (and report their own errors) behind it.
          if (workspaceId !== boot.workspace.id && moved)
            void switchWorkspace(workspaceId).then(() => openPage(moved));
          return true;
        }}
      />
      {pageQr && data && (
        <ItemQrDialog pageId={data.page.id} title={data.page.title || t("Ohne Titel", "Untitled")} onClose={() => setPageQr(false)} />
      )}
      {pageExport && data && (
        <PageExportDialog
          page={data.page}
          onClose={() => setPageExport(false)}
          legacy={async () => {
            if (data.page.kind === "document") {
              const { exportDocumentHtml } = await import("@/lib/document-html");
              const body = exportDocumentHtml(html.current, { captionNumbers: !!data.page.caption_numbers });
              return {
                name: `${data.page.title}.html`,
                text: `<!doctype html><html lang="de"><meta charset="utf-8"><title>${data.page.title.replace(/[<>&]/g, "")}</title><body>${body}</body></html>`,
                mime: "text/html",
                html: body,
              };
            }
            return {
              name: `${data.page.title}.json`,
              text: JSON.stringify({ database: data.database, rows: data.rows }, null, 2),
              mime: "application/json",
            };
          }}
        />
      )}
      {/* "Hide keyboard" for text fields outside the editors, dialogs included. */}
      <HideKeyboardButton />
      <MobileTabBar
        active={mobile ? null : screen === "home" ? "home" : screen === "inbox" ? "inbox" : null}
        unread={unreadNotifications}
        newTasks={screen === "tasks" ? 0 : boot.newTasks || 0}
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
        onMenu={() => setMobile((open) => !open)}
      />
      <Toaster />
      {filePages.panel}
      <FilePageUploadDialog
        open={fileUploadDialog}
        onClose={() => setFileUploadDialog(false)}
        spaces={liveSpaces.filter((sp) => !(sp as { encrypted?: number }).encrypted && !(sp as { encrypt_titles?: number }).encrypt_titles)}
        pages={activePages}
        spaceId={currentSpaceId}
        onPick={(sid, parentId) => {
          setFileUploadDialog(false);
          pickFilePages(sid, parentId);
        }}
      />
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
    </DatabaseLabelsContext.Provider>
    </TagOptionsContext.Provider>
    </AiProvider>
  );
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
// The page menu's "Aufgaben in Datenbank verschieben …" (#420): only for a
// document with task items – read from its text when the menu opens.
function TasksMenuItem({ readHtml, onSelect }: { readHtml: () => string; onSelect: () => void }) {
  const t = useT();
  if (!readHtml().includes('data-type="taskItem"')) return null;
  return (
    <PageMenu.Item className="dropdown-item" onSelect={onSelect}>
      <ListChecks />
      {t("Aufgaben in Datenbank verschieben …", "Move tasks to a database …")}
    </PageMenu.Item>
  );
}
const UNDOABLE = new Set(["page.delete", "page.tasksToDatabase", "page.move", "pages.bulk", "row.delete", "rows.bulk", "row.update", "row.move", "database.update", "comment.resolve", "row.template.apply", "row.schedule", "timeline.cascade", "timeline.unlink"]);
