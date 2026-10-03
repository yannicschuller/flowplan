"use client";
import { serverMessage } from "@/lib/i18n-errors";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { useLocale, useStatusLabel, useT } from "./i18n";
import { BrandMark } from "./brand-mark";
import { Select } from "./select";
import { CommentHub } from "./comment-hub";
import { WorkspaceIcon } from "./workspace-icon";
import {
  useOfflineQueue,
  isQueueable,
  OfflineConflicts,
} from "./offline-queue";
import { applyQueue } from "@/lib/offline-queue";
import {
  parsePageLocation,
  pageLocationHash,
  notificationUrl,
  type PageLocation,
} from "@/lib/page-location";
import { SpaceAppearance, SpaceIcon } from "./space-appearance";
import { CoverPicker } from "./cover-picker";
import { SpaceManager } from "./space-manager";
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
import SavedTemplates from "./saved-templates";
import { useState, useEffect, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import {
  Images,
  BookmarkSimple,
  Stack,
  CaretDown,
  CaretRight,
  CheckSquare,
  DotsSixVertical,
  Plus,
  MagnifyingGlass,
  House,
  Bell,
  Star,
  Clock,
  Trash,
  BookOpen,
  GearSix,
  SidebarSimple,
  DotsThree,
  ArrowSquareOut,
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
  PresentationChart,
  Notebook,
  Lock,
  Copy,
  DownloadSimple,
  UploadSimple,
  ShieldCheck,
  SignOut,
  Sun,
  Moon,
  Users,
  ArrowCounterClockwise,
  Globe,
  Link as LinkIcon,
  SquaresFour,
  Flag,
  Folder,
  ArrowUpRight,
  Eye,
  ImageSquare,
  TextAa,
  Printer,
  ClockCounterClockwise,
  Graph,
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
} from "./ui";
import DatabaseView, { type DatabaseData } from "./database-view";
import Settings from "./settings";
import Admin from "./admin";
import { ShareLinks } from "./share-links";
import { MovePageDialog } from "./move-page-dialog";
import { JournalView, localDay, type JournalDay } from "./journal-view";
import { MyTasks } from "./my-tasks";
import { FocusBar } from "./focus-bar";
import { PageGraph } from "./page-graph";
import { UnlinkedMentions } from "./unlinked-mentions";
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
const EmojiPicker = dynamic(() => import("./emoji-picker"), {
  ssr: false,
  loading: () => <Loading what="emoji" />,
});
const DocumentEditor = dynamic(() => import("./editor"), {
  ssr: false,
  loading: () => <Loading what="document" />,
});
const Whiteboard = dynamic(() => import("./whiteboard/whiteboard"), {
  ssr: false,
  loading: () => <Loading what="whiteboard" />,
});
type PageData = DatabaseData & {
  whiteboard?: { state: string; generation: string };
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
  };
  page: Page;
  role: Role;
  html: string;
  state: string | null;
  generation: string;
  backlinks: { id: string; title: string; icon: string }[];
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
export default function WorkspaceApp({
  initial,
  useTemplate,
}: {
  initial: Bootstrap;
  // Public gallery: create a page from this template once signed in.
  useTemplate?: string;
}) {
  const t = useT();
  const statusLabel = useStatusLabel();
  const locale = useLocale();
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
  const [boot, setBoot] = useState(initial),
    [pageId, setPageId] = useState<string | null>(null),
    [screen, setScreen] = useState<Screen>("home"),
    [data, setData] = useState<PageData | null>(null),
    [mobile, setMobile] = useState(false),
    [search, setSearch] = useState(false),
    [query, setQuery] = useState(""),
    [create, setCreate] = useState(false),
    [newTitle, setNewTitle] = useState(""),
    [newKind, setNewKind] = useState<PageKind>("document"),
    [parent, setParent] = useState<string | null>(null),
    [spaceId, setSpaceId] = useState(initial.spaces[0]?.id || ""),
    [templates, setTemplates] = useState(false),
    [share, setShare] = useState(false),
    [pageExport, setPageExport] = useState(false),
    [spaceManager, setSpaceManager] = useState<{
      space: Space;
      purge?: boolean;
    } | null>(null),
    [history, setHistory] = useState(false),
    [comments, setComments] = useState(false),
    [focusMode, setFocusMode] = useState(false),
    [comment, setComment] = useState(""),
    [status, setStatus] = useState("Gespeichert"),
    [toast, setToast] = useState(""),
    [busy, setBusy] = useState(false),
    [dark, setDark] = useState(false),
    [iconPicker, setIconPicker] = useState(false),
    [coverPicker, setCoverPicker] = useState(false),
    [newWorkspace, setNewWorkspace] = useState(false),
    [workspaceName, setWorkspaceName] = useState(""),
    [newSpace, setNewSpace] = useState(false),
    [spaceName, setSpaceName] = useState(""),
    [spaceIcon, setSpaceIcon] = useState("folder"),
    [spaceColor, setSpaceColor] = useState("none"),
    [privateSpace, setPrivateSpace] = useState(false),
    [epoch, setEpoch] = useState(0),
    [collapsed, setCollapsed] = useState<Set<string>>(new Set()),
    // Quick filter above the page tree.
    [treeFilter, setTreeFilter] = useState(""),
    [online, setOnline] = useState(true),
    [move, setMove] = useState(false),
    // Right click on a page in the sidebar: its actions at the pointer.
    [pageMenu, setPageMenu] = useState<{ page: Page; x: number; y: number } | null>(null),
    [templateName, setTemplateName] = useState(false),
    [templateTitle, setTemplateTitle] = useState("");
  const [treeDrop, setTreeDrop] = useState<{
    id: string;
    placement: "before" | "after" | "inside";
  } | null>(null);
  // Profile pictures for every Avatar below, from the current member list.
  setAvatarDirectory([...boot.members, boot.user]);
  const [desktopCollapsed, setDesktopCollapsed] = useState(false);
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
  const [inboxFilter, setInboxFilter] = useState<"all" | "unread">("all");
  const [searchName, setSearchName] = useState<string | null>(null);
  useEffect(() => {
    if (!search) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(
        `/api/search?${new URLSearchParams({
          workspace: boot.workspace.id,
          q: query,
          kind: searchKind,
          ...(searchSpace ? { space: searchSpace } : {}),
        })}`,
        { signal: controller.signal },
      )
        .then((r) => (r.ok ? r.json() : []))
        .then(setSearchResults)
        .catch(() => {});
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, search, boot.workspace.id, searchKind, searchSpace]);
  const currentId = useRef(pageId),
    currentWorkspace = useRef(boot.workspace.id),
    screenRef = useRef(screen),
    html = useRef(""),
    toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  currentId.current = pageId;
  currentWorkspace.current = boot.workspace.id;
  screenRef.current = screen;
  const notify = useCallback((s: string) => {
    setToast(s);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 5000);
  }, []);
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
  const [pendingCells, setPendingCells] = useState<
    { pageId: string; rowId: string; cells: Record<string, unknown> }[]
  >([]);
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
      // Changed cells show at once; the reloaded page replaces them (or
      // the old values come back when the change fails).
      const shown =
        b.action === "row.update" &&
        typeof b.rowId === "string" &&
        b.cells &&
        typeof b.cells === "object"
          ? {
              pageId: String(b.pageId),
              rowId: b.rowId,
              cells: b.cells as Record<string, unknown>,
            }
          : null;
      if (shown) setPendingCells((list) => [...list, shown]);
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
        await refresh();
        return result;
      } finally {
        if (shown) setPendingCells((list) => list.filter((x) => x !== shown));
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
    async (b: Record<string, unknown>) => {
      try {
        return await mutate(b);
      } catch (e) {
        notify((e as Error).message);
        return null;
      }
    },
    [mutate, notify],
  );
  // "Zuletzt angesehen" on the start page follows along without a reload.
  const shownPage = data?.page.id;
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
  const openPage = useCallback(
    async (id: string, target?: PageLocation) => {
      const version = ++navigationVersion.current;
      navigationPending.current = true;
      setMobile(false);
      setScreen("page");
      screenRef.current = "page";
      setPageId(id);
      currentId.current = id;
      setData(null);
      setComments(false);
      setBusy(true);
      const hash = pageLocationHash(target || { pageId: id });
      if (location.hash !== hash) location.hash = hash;
      try {
        const p = await api<PageData>(`/api/pages/${id}`, undefined, {
          "X-Flowplan-Visit": "1",
        });
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
        if (currentId.current === id) {
          setData(p);
          html.current = p.html || "";
          setStatus("Gespeichert");
        }
      } catch (e) {
        if (version === navigationVersion.current) notify((e as Error).message);
      } finally {
        if (version === navigationVersion.current) {
          navigationPending.current = false;
          setBusy(false);
        }
      }
    },
    [notify],
  );
  function go(s: Screen) {
    setScreen(s);
    screenRef.current = s;
    setMobile(false);
    location.hash = s;
  }
  useEffect(() => {
    const saved = localStorage.getItem("flowplan-theme") === "dark";
    setDark(saved);
    document.documentElement.dataset.theme = saved ? "dark" : "light";
    const navigate = () => {
      const fragment = location.hash.slice(1);
      if (fragment.startsWith("page=")) {
        const target = parsePageLocation(location.hash);
        if (!target) {
          notify(t("Dieser Seitenlink ist ungültig.", "This page link is invalid."));
          return;
        }
        if (currentId.current !== target.pageId || screenRef.current !== "page")
          void openPage(target.pageId, target);
      } else if (
        ["home", "inbox", "tasks", "graph", "trash", "media", "settings", "admin"].includes(
          fragment,
        )
      ) {
        setScreen(fragment as Screen);
        screenRef.current = fragment as Screen;
        setMobile(false);
        // The start page shows recently opened and edited pages: current.
        if (fragment === "home") void refresh().catch(() => {});
      }
    };
    navigate();
    window.addEventListener("hashchange", navigate);
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearch((s) => !s);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "n") {
        e.preventDefault();
        setCreate(true);
      }
    };
    const network = () => setOnline(navigator.onLine);
    network();
    window.addEventListener("keydown", key);
    window.addEventListener("online", network);
    window.addEventListener("offline", network);
    return () => {
      window.removeEventListener("hashchange", navigate);
      window.removeEventListener("keydown", key);
      window.removeEventListener("online", network);
      window.removeEventListener("offline", network);
    };
  }, [initial.pages, openPage, notify]);
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
        notify((e as Error).message);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useTemplate]);
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
  const activePages = boot.pages.filter((p) => !p.deleted_at),
    editable =
      !!data && ["editor", "owner"].includes(data.role) && !data.page.locked,
    canCreate = boot.workspace.role !== "viewer" && !boot.workspace.guest,
    favorites = activePages.filter((p) => boot.favorites.includes(p.id));
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
      if (version === navigationVersion.current) notify((e as Error).message);
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
    return activePages
      .filter(
        (p) =>
          p.space_id === sid &&
          (parentId
            ? p.parent_id === parentId
            : !p.parent_id || !activePages.some((x) => x.id === p.parent_id)),
      )
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
  function tree(
    parentId: string | null,
    sid: string,
    level = 0,
  ): React.ReactNode {
    if (level > 20) return null;
    return activePages
      .filter(
        (p) =>
          p.space_id === sid &&
          (parentId
            ? p.parent_id === parentId
            : !p.parent_id || !activePages.some((x) => x.id === p.parent_id)) &&
          (!filterMatches || filterMatches.has(p.id)),
      )
      .map((p) => {
        const children = activePages.some(
            (x) => x.parent_id === p.id && (!filterMatches || filterMatches.has(x.id)),
          ),
          // While filtering, the way to every match stays open.
          closed = !filterMatches && collapsed.has(p.id);
        return (
          <div key={p.id}>
            <div
              className={`page-nav ${screen === "page" && pageId === p.id ? "selected" : ""} ${selectedPages.includes(p.id) ? "multi-selected" : ""} ${treeDrop?.id === p.id ? `drop-${treeDrop.placement}` : ""}`}
              data-page-id={p.id}
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
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragEnd={() => setTreeDrop(null)}
              onDragOver={(e) => {
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
                e.preventDefault();
                e.stopPropagation();
                const source = e.dataTransfer.getData(
                  "application/x-flowplan-page",
                );
                if (source && source !== p.id)
                  void act({
                    action: "page.move",
                    pageId: source,
                    targetId: p.id,
                    placement: treeDrop?.placement || "inside",
                  });
                setTreeDrop(null);
              }}
              style={{ paddingLeft: 12 + level * 14 }}
            >
              <button
                className="tree-toggle"
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
                {children ? (
                  <CaretRight
                    size={12}
                    className="nav-caret"
                    style={{ transform: closed ? undefined : "rotate(90deg)" }}
                  />
                ) : (
                  <span />
                )}
              </button>
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
                aria-pressed={
                  selecting || selectedPages.length
                    ? selectedPages.includes(p.id)
                    : undefined
                }
                onClick={(e) => {
                  if (selecting || e.metaKey || e.ctrlKey || e.shiftKey) {
                    e.preventDefault();
                    toggleSelected(p.id, e.shiftKey);
                    return;
                  }
                  void openPage(p.id);
                }}
              >
                <PageIcon
                  name={p.kind === "database" ? "table" : p.icon}
                  size={17}
                />
                <span>{p.title}</span>
                {p.locked === 1 && <Lock size={12} />}
              </button>
              {canCreate && (
                <button
                  className="nav-drag"
                  aria-label={`${p.title} ziehen`}
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
                  title={t("Unterseite hinzufügen", "Add sub-page")}
                  onClick={() => addPage("document", p.id, p.space_id)}
                >
                  <Plus size={14} />
                </button>
              )}
            </div>
            {children && !closed && tree(p.id, sid, level + 1)}
          </div>
        );
      });
  }
  function toggleTheme() {
    setDark(!dark);
    document.documentElement.dataset.theme = !dark ? "dark" : "light";
    localStorage.setItem("flowplan-theme", !dark ? "dark" : "light");
  }
  // Commands for the quick search ("> …" or matching words).
  const openPageData = screen === "page" && data ? data : null;
  const commandActions: CommandAction[] = [
    { label: t("Neue Seite", "New page"), keywords: t("dokument anlegen erstellen notiz", "dokument anlegen erstellen notiz document new create note page"), icon: FileText, run: () => addPage() },
    { label: t("Neue Datenbank", "New database"), keywords: t("tabelle projekt anlegen", "tabelle projekt anlegen table project create database"), icon: Table, run: () => addPage("database") },
    { label: t("Neues Whiteboard", "New whiteboard"), keywords: "board canvas zeichnen", icon: PresentationChart, run: () => addPage("whiteboard") },
    { label: t("Neues Journal", "New journal"), keywords: t("tagebuch tag", "tagebuch tag diary day journal"), icon: Notebook, run: () => addPage("journal") },
    { label: t("Vorlagen öffnen", "Open templates"), keywords: "template galerie", icon: SquaresFour, run: () => setTemplates(true) },
    { label: t("Zur Startseite", "Go to home"), keywords: "home start", icon: House, run: () => go("home") },
    { label: t("Posteingang öffnen", "Open inbox"), keywords: "inbox benachrichtigungen", icon: Bell, run: () => go("inbox") },
    { label: t("Meine Aufgaben", "My tasks"), keywords: t("tasks todo fällig", "tasks todo fällig due aufgaben"), icon: CheckSquare, run: () => go("tasks") },
    { label: t("Medien", "Media"), keywords: t("bilder dateien", "bilder dateien images files media"), icon: ImageSquare, run: () => go("media") },
    { label: t("Graph der Verlinkungen", "Graph of links"), keywords: "graph netz verbindungen links karte", icon: Graph, run: () => go("graph") },
    { label: t("Papierkorb", "Trash"), keywords: t("trash gelöscht wiederherstellen", "trash gelöscht wiederherstellen papierkorb deleted restore"), icon: Trash, run: () => go("trash") },
    { label: t("Einstellungen", "Settings"), keywords: "settings konto mitglieder", icon: GearSix, run: () => go("settings") },
    ...(boot.user.isAdmin
      ? [{ label: t("Administration", "Administration"), keywords: "admin instanz betrieb", icon: ShieldCheck, run: () => go("admin") }]
      : []),
    { label: dark ? t("Helles Design", "Light theme") : t("Dunkles Design", "Dark theme"), keywords: "theme dark light nacht farbe", icon: dark ? Sun : Moon, run: toggleTheme },
    { label: t("Seitenleiste ein- oder ausblenden", "Show or hide sidebar"), keywords: "sidebar navigation", icon: SidebarSimple, run: () => setDesktopCollapsed((v) => !v) },
    ...(openPageData
      ? [
          { label: t("Fokusmodus", "Focus mode"), keywords: "schreiben ablenkungsfrei zen wortziel", icon: TextAa, run: () => setFocusMode(true) },
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
          { label: t("Drucken oder als PDF sichern", "Print or save as PDF"), keywords: "pdf print drucken", icon: Printer, run: () => window.print() },
          { label: t("Versionsverlauf", "Version history"), keywords: "history versionen wiederherstellen", icon: ClockCounterClockwise, run: () => setHistory(true) },
          { label: t("Teilen", "Share"), keywords: "share link freigeben", icon: ShareNetwork, run: () => setShare(true) },
        ]
      : []),
  ];
  const commandQuery = normalizeCommand(query.replace(/^>\s*/, ""));
  const shownActions =
    query.startsWith(">") || commandQuery.length >= 2
      ? commandActions
          .filter((a) => !commandQuery || normalizeCommand(`${a.label} ${a.keywords}`).includes(commandQuery))
          .slice(0, query.startsWith(">") ? 20 : 4)
      : [];
  const runCommand = (action: CommandAction) => {
    setSearch(false);
    setQuery("");
    action.run();
  };
  return (
    <div
      className={`app-shell ${mobile ? "nav-open" : ""} ${desktopCollapsed ? "desktop-collapsed" : ""}${focusMode && screen === "page" ? " focus-mode" : ""}`}
      inert={switching}
      aria-busy={switching}
    >
      {focusMode && screen === "page" && data && (
        <FocusBar
          pageId={data.page.id}
          html={readHtml}
          onClose={() => setFocusMode(false)}
        />
      )}
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
            <Dropdown.Content className="dropdown" align="start" sideOffset={4}>
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
        <div className="sidebar-scroll">
          <nav className="main-nav">
            <button onClick={() => setSearch(true)}>
              <MagnifyingGlass size={19} />
              {t("Suchen", "Search")}<span className="keycap">⌘ K</span>
            </button>
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
                  onClick={() => openPage(p.id)}
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
            .map((space) => (
            <section className="nav-section" key={space.id}>
              <div className="nav-section-title">
                <span>
                  <SpaceIcon icon={space.icon} color={space.icon_color} />
                  {space.visibility === "private" && (
                    <Lock size={12} aria-label={t("Privater Bereich", "Private space")} />
                  )}{" "}
                  <span className="space-name" title={space.name}>
                    {space.name}
                  </span>
                </span>
                {(boot.workspace.role === "owner" ||
                  (canCreate && space.owner_id === boot.user.id)) && (
                  <button
                    className="icon-button"
                    aria-label={t(`Bereich ${space.name} verwalten`, `Manage space ${space.name}`)}
                    onClick={() => setSpaceManager({ space })}
                  >
                    <DotsThree size={16} />
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
              </div>
              {tree(null, space.id)}
              {!activePages.some((p) => p.space_id === space.id) && (
                <span className="sidebar-empty">{t("Noch keine Seiten", "No pages yet")}</span>
              )}
            </section>
          ))}
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
                <Dropdown.Content className="dropdown" align="end">
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
                      await fetch("/api/auth/logout", { method: "POST" });
                      location.href = "/";
                    }}
                  >
                    <SignOut />
                    {t("Abmelden", "Sign out")}
                  </Dropdown.Item>
                </Dropdown.Content>
              </Dropdown.Portal>
            </Dropdown.Root>
          </div>
        </div>
      </aside>
      <main className="main">
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
        <header className="topbar">
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
                <span>{data.page.title}</span>
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
          {screen === "page" && data ? (
            <div className="page-top-actions">
              <span className="save-status">
                {online ? <CloudCheck size={15} /> : <WifiSlash size={15} />}
                <span>{statusLabel(status)}</span>
              </span>
              <div className="presence">
                {data.present
                  .filter((u) => u.id !== boot.user.id)
                  .slice(0, 3)
                  .map((u) => (
                    <Avatar name={u.name} userId={u.id} small key={u.id} />
                  ))}
              </div>
              <button
                title={t("Kommentare", "Comments")}
                className={`icon-button ${comments ? "active" : ""}`}
                onClick={() => setComments(!comments)}
              >
                <ChatCircle size={20} />
              </button>
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
              <button
                className="button compact share-button"
                onClick={() => setShare(true)}
              >
                <ShareNetwork size={15} />
                {t("Teilen", "Share")}
              </button>
              <Dropdown.Root>
                <Dropdown.Trigger
                  className="icon-button"
                  aria-label={t("Seitenaktionen", "Page actions")}
                >
                  <DotsThree size={24} />
                </Dropdown.Trigger>
                <Dropdown.Portal>
                  <Dropdown.Content className="dropdown" align="end">
                    <Dropdown.Item
                      className="dropdown-item"
                      onSelect={() => {
                        setIconPicker(true);
                      }}
                    >
                      <Flag />
                      {t("Icon ändern", "Change icon")}
                    </Dropdown.Item>
                    <Dropdown.Item
                      className="dropdown-item"
                      onSelect={() => setCoverPicker(true)}
                    >
                      <SquaresFour />
                      {t("Cover ändern", "Change cover")}
                    </Dropdown.Item>
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
                    <Dropdown.Item
                      className="dropdown-item"
                      onSelect={() => setMove(true)}
                    >
                      <ArrowRight />
                      {t("Verschieben", "Move")}
                    </Dropdown.Item>
                    <Dropdown.Item
                      className="dropdown-item"
                      onSelect={() => setTemplateName(true)}
                    >
                      <SquaresFour />
                      {t("Als Vorlage speichern", "Save as template")}
                    </Dropdown.Item>
                    <Dropdown.Item
                      className="dropdown-item"
                      onSelect={() => setPageExport(true)}
                    >
                      <DownloadSimple />
                      {t("Exportieren", "Export")}
                    </Dropdown.Item>
                    <Dropdown.Item
                      className="dropdown-item"
                      onSelect={() => window.print()}
                    >
                      <FileText />
                      {t("Drucken / PDF", "Print / PDF")}
                    </Dropdown.Item>
                    <Dropdown.Item
                      className="dropdown-item"
                      onSelect={() => setHistory(true)}
                    >
                      <Clock />
                      {t("Versionsverlauf", "Version history")}
                    </Dropdown.Item>
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
                        const r = await act({ action: "page.delete", pageId });
                        if (r) {
                          go("trash");
                          setPageId(null);
                        }
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
        <div className="main-scroll">
          {screen === "home" && (
            <div className="home-content">
              <div className="home-greeting">
                <span className="eyebrow">{t("DEIN ARBEITSBEREICH", "YOUR WORKSPACE")}</span>
                <h1>
                  {greeting(clock, t)}, {boot.user.name.split(" ")[0]}
                  <span className="greeting-dot">.</span>
                </h1>
                <p>
                  {t("Gute Ideen beginnen hier. Mach dort weiter, wo du aufgehört hast.", "Good ideas start here. Pick up where you left off.")}
                </p>
              </div>
              <section className="recent-section">
                <div className="section-heading">
                  <h2>
                    <Clock size={19} />
                    {t("Zuletzt bearbeitet", "Recently edited")}
                  </h2>
                  <span>
                    {activePages.length} {t("Seiten in deinem Arbeitsbereich", "pages in your workspace")}
                  </span>
                </div>
                <div className="recent-grid">
                  {[...activePages]
                    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
                    .slice(0, 4)
                    .map((p, i) => (
                      <button
                        key={p.id}
                        className="recent-card"
                        onClick={() => openPage(p.id)}
                      >
                        <div
                          className={`recent-illustration illustration-${i}`}
                        >
                          <PageIcon
                            name={p.kind === "database" ? "table" : p.icon}
                            size={38}
                          />
                          {p.kind === "database" ? (
                            <div className="mini-board" aria-hidden>
                              <i />
                              <i />
                              <i />
                            </div>
                          ) : (
                            <div className="mini-document" aria-hidden>
                              <i />
                              <i />
                              <i />
                            </div>
                          )}
                        </div>
                        <div className="recent-card-title">
                          <PageIcon name={p.icon} />
                          <strong>{p.title}</strong>
                        </div>
                        <small>
                          {t("Bearbeitet", "Edited")}{" "}{relativeTime(p.updated_at, clock, locale)}
                        </small>
                      </button>
                    ))}
                </div>
              </section>
              {clock !== null &&
                (boot.recentVisits || []).some((v) =>
                activePages.some((p) => p.id === v.pageId),
              ) && (
                <section className="visited-section">
                  <h2>
                    <Eye size={17} />
                    {t("Zuletzt angesehen", "Recently viewed")}
                  </h2>
                  <div className="visited-list">
                    {(boot.recentVisits || []).flatMap((visit) => {
                      const p = activePages.find((x) => x.id === visit.pageId);
                      return p
                        ? [
                            <button
                              key={p.id}
                              type="button"
                              onClick={() => openPage(p.id)}
                            >
                              <PageIcon name={p.icon} size={16} />
                              <span>{p.title || t("Ohne Titel", "Untitled")}</span>
                              <small>{ago(visit.seenAt, clock ?? Date.now(), locale)}</small>
                            </button>,
                          ]
                        : [];
                    })}
                  </div>
                </section>
              )}
              <section className="quick-section">
                <h2>{t("Was hast du heute vor?", "What are you up to today?")}</h2>
                <div className="quick-actions">
                  <button
                    disabled={clock === null || !canCreate}
                    onClick={() => addPage()}
                  >
                    <span className="quick-icon blue">
                      <FileText size={25} />
                    </span>
                    <span>
                      <strong>{t("Eine Idee festhalten", "Capture an idea")}</strong>
                      <small>{t("Eine leere Seite voller Möglichkeiten", "A blank page full of possibilities")}</small>
                    </span>
                    <Plus size={20} />
                  </button>
                  <button
                    disabled={clock === null || !canCreate}
                    onClick={() => addPage("database")}
                  >
                    <span className="quick-icon orange">
                      <Table size={25} />
                    </span>
                    <span>
                      <strong>{t("Ein Projekt planen", "Plan a project")}</strong>
                      <small>{t("Aufgaben, Termine und Überblick", "Tasks, dates and an overview")}</small>
                    </span>
                    <Plus size={20} />
                  </button>
                </div>
              </section>
              <section className="workspace-pages">
                <div className="section-heading">
                  <h2>
                    <Folder size={19} />
                    {t("In deinem Arbeitsbereich", "In your workspace")}
                  </h2>
                  {canCreate && (
                    <button
                      className="text-button"
                      disabled={clock === null}
                      onClick={() => addPage()}
                    >
                      <Plus size={16} />
                      {t("Neue Seite", "New page")}
                    </button>
                  )}
                </div>
                {activePages
                  .filter((p) => !p.parent_id)
                  .map((p) => (
                    <button
                      key={p.id}
                      className="home-page-row"
                      onClick={() => openPage(p.id)}
                    >
                      <span className="page-row-icon">
                        <PageIcon name={p.icon} size={20} />
                      </span>
                      <strong>{p.title}</strong>
                      <span>
                        {p.kind === "database" ? t("Datenbank", "Database") : t("Dokument", "Document")}
                      </span>
                      <ArrowUpRight size={17} />
                    </button>
                  ))}
              </section>
              <div className="home-footnote">
                <Stack size={16} />
                <span>{t("Weniger suchen. Mehr bewegen.", "Search less. Get more done.")}</span>
                <span>{t("⌘ K zum schnellen Finden", "⌘ K to find things fast")}</span>
              </div>
            </div>
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
                  className={`page-content ${data.page.kind === "database" ? "database-page" : ""} ${data.page.kind === "whiteboard" ? "whiteboard-page" : ""} ${data.page.full_width ? "full-width" : ""} font-${data.page.font}`}
                >
                  {data.page.cover && (
                    <div
                      className="page-cover"
                      style={{
                        background: data.page.cover.startsWith("#")
                          ? data.page.cover
                          : undefined,
                      }}
                    >
                      {imageFileId(data.page.cover) && (
                        <img
                          src={data.page.cover}
                          alt={t("Seiten-Cover", "Page cover")}
                          style={{
                            objectPosition: `50% ${data.page.cover_position ?? 50}%`,
                          }}
                        />
                      )}
                      {editable && (
                        <button
                          className="button cover-change"
                          onClick={() => setCoverPicker(true)}
                        >
                          {t("Cover ändern", "Change cover")}
                        </button>
                      )}
                    </div>
                  )}
                  <div className="document-header">
                    <button
                      className="large-page-icon"
                      title={t("Seiten-Icon ändern", "Change page icon")}
                      onClick={() => editable && setIconPicker(true)}
                    >
                      <PageIcon
                        name={data.page.icon}
                        size={iconPixels[data.page.icon_size || ""]}
                      />
                    </button>
                    {editable && !data.page.cover && (
                      <button
                        className="add-cover text-button"
                        onClick={() => setCoverPicker(true)}
                      >
                        {t("Cover hinzufügen", "Add cover")}
                      </button>
                    )}
                    <input
                      key={`${data.page.id}-title`}
                      className="page-title"
                      aria-label={t("Seitentitel", "Page title")}
                      defaultValue={data.page.title}
                      readOnly={!editable}
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
                    {data.page.locked === 1 && (
                      <div className="locked-notice">
                        <Lock size={14} />
                        {t("Diese Seite ist gesperrt.", "This page is locked.")}
                      </div>
                    )}
                  </div>
                  {since?.pageId === data.page.id && since.value && (
                    <SinceVisitBanner
                      since={since.value}
                      onDismiss={() =>
                        setSince({ pageId: data.page.id, value: null })
                      }
                    />
                  )}
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
                          rows: withPendingCells(
                            applyQueue(
                              data.rows,
                              offlineQueue.queue,
                              data.page.id,
                            ),
                            pendingCells,
                            data.page.id,
                          ),
                        }}
                        members={boot.members}
                        pages={activePages}
                        editable={editable}
                        favoriteRows={boot.favoriteRows}
                        mutate={mutate}
                        onError={notify}
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
                      onChanged={refresh}
                      onError={notify}
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
                      }))}
                      onReload={refresh}
                      onError={notify}
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
                        trackers={data.journalDay.trackers}
                        entry={data.journalDay.entry}
                        options={data.journalDay.options}
                        editable={editable}
                        onError={notify}
                      />
                    )}
                    <DocumentEditor
                      key={`${data.page.id}-${data.generation}-${epoch}`}
                      generation={data.generation}
                      pageId={data.page.id}
                      userId={boot.user.id}
                      pages={activePages}
                      members={boot.members}
                      state={data.state}
                      html={data.html}
                      editable={editable}
                      onStatus={setStatus}
                      onError={notify}
                      onHtml={setHtml}
                      transcription={!!boot.instance?.transcription}
                    />
                    </>
                  )}
                  <div className="backlinks">
                    {!data.locked && (
                      <UnlinkedMentions
                        key={data.page.id}
                        pageId={data.page.id}
                        editable={editable}
                        onOpen={(id) => void openPage(id)}
                        onLinked={() => void refresh()}
                        onError={notify}
                      />
                    )}
                    {data.backlinks?.length > 0 && (
                      <>
                        <h3>{t("Verlinkt von", "Linked from")}</h3>
                        {data.backlinks.map((p) => (
                          <button key={p.id} onClick={() => openPage(p.id)}>
                            <PageIcon name={p.icon} />
                            {p.title}
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
                </article>
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
                        const r = await act({
                          action: "comment.create",
                          pageId,
                          body: comment,
                        });
                        if (r) setComment("");
                      }}
                    >
                      <textarea
                        required
                        value={comment}
                        onChange={(e) => setComment(e.target.value)}
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
              onOpen={(id) => void openPage(id)}
              onError={notify}
            />
          )}
          {screen === "tasks" && (
            <MyTasks
              workspaceId={boot.workspace.id}
              onOpen={(pageId, rowId) => {
                location.hash = rowId ? `page=${pageId}&row=${rowId}` : `page=${pageId}`;
              }}
              onError={notify}
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
                <button
                  className="button compact"
                  disabled={!boot.notifications.some((n) => !n.read_at)}
                  onClick={() => void act({ action: "notification.read" })}
                >
                  {t("Alle als gelesen markieren", "Mark all as read")}
                </button>
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
                        if (target) void openPage(target.pageId, target);
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
              onError={notify}
              dark={dark}
              setDark={(v) => {
                setDark(v);
                document.documentElement.dataset.theme = v ? "dark" : "light";
                localStorage.setItem("flowplan-theme", v ? "dark" : "light");
              }}
            />
          )}
          {screen === "admin" && boot.user.isAdmin && (
            <Admin mutate={mutate} onError={notify} />
          )}
        </div>
      </main>
      {spaceManager && (
        <SpaceManager
          space={spaceManager.space}
          purge={spaceManager.purge}
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
                  {flatPages(null, sp.id)
                    .filter(
                      ({ page }) =>
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
        onClose={() => {
          setSearch(false);
          setQuery("");
          setSearchName(null);
        }}
        title={t("Schnellsuche", "Quick search")}
      >
        <div className="command-search">
          <MagnifyingGlass size={22} />
          <input
            autoFocus
            aria-label={t("Suchen oder Befehl", "Search or command")}
            placeholder={t("Suchen … oder > für Befehle", "Search … or > for commands")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
              e.preventDefault();
              const first = searchResults[0];
              if (shownActions.length && (query.startsWith(">") || !first))
                runCommand(shownActions[0]);
              else if (first) {
                setSearch(false);
                void openPage(
                  first.id,
                  first.rowId ? { pageId: first.id, rowId: first.rowId } : undefined,
                );
              }
            }}
          />
          <kbd>esc</kbd>
        </div>
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
        {shownActions.length > 0 && (
          <div className="command-actions" aria-label={t("Aktionen", "Actions")}>
            <small>{t("Aktionen", "Actions")}</small>
            {shownActions.map((action, i) => (
              <button
                key={action.label}
                type="button"
                className={i === 0 && (query.startsWith(">") || !searchResults.length) ? "first" : ""}
                onClick={() => runCommand(action)}
              >
                <action.icon size={17} />
                <span>{action.label}</span>
                {i === 0 && (query.startsWith(">") || !searchResults.length) && <kbd>↵</kbd>}
              </button>
            ))}
          </div>
        )}
        {!query.startsWith(">") && (
        <div className="search-results">
          {searchResults.map((p) => (
            <button
              key={`${p.id}:${p.rowId || ""}`}
              onClick={() => {
                setSearch(false);
                void openPage(
                  p.id,
                  p.rowId ? { pageId: p.id, rowId: p.rowId } : undefined,
                );
              }}
            >
              <PageIcon name={p.icon} />
              <span>
                {p.title}
                {p.pageTitle && (
                  <small className="search-context">
                    {p.kind === "comment"
                      ? t(`Kommentar in ${p.pageTitle}`, `Comment in ${p.pageTitle}`)
                      : p.kind === "file"
                        ? t(`Datei in ${p.pageTitle}`, `File in ${p.pageTitle}`)
                        : t(`Eintrag in ${p.pageTitle}`, `Record in ${p.pageTitle}`)}
                  </small>
                )}
                <small>
                  {p.snippet ? (
                    <SearchSnippet text={p.snippet} />
                  ) : (
                    boot.spaces.find((s) => s.id === p.space_id)?.name
                  )}
                </small>
              </span>
              <ArrowSquareOut size={17} />
            </button>
          ))}
          {!searchResults.length && !shownActions.length && (
            <div className="empty-state small">{t("Nichts gefunden.", "Nothing found.")}</div>
          )}
        </div>
        )}
      </Modal>
      <Modal open={create} onClose={() => setCreate(false)} title={t("Neue Seite", "New page")}>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const result = await act({
              action: "page.create",
              workspaceId: boot.workspace.id,
              spaceId,
              parentId: parent,
              title: newTitle || t("Ohne Titel", "Untitled"),
              kind: newKind,
              starterTemplate,
            });
            if (result?.id) {
              setCreate(false);
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
          </div>
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
            <button className="button primary">{t("Seite erstellen", "Create page")}</button>
          </div>
        </form>
      </Modal>
      <OfflineConflicts
        conflicts={offlineQueue.conflicts}
        fields={(pid) =>
          data?.page.id === pid ? data.database?.fields || [] : []
        }
        resolve={offlineQueue.resolve}
      />
      <Modal open={share} onClose={() => setShare(false)} title={t("Seite teilen", "Share page")}>
        {data && (
          <>
            <div className="share-members">
              <h3>{t("Zugriff im Arbeitsbereich", "Access in the workspace")}</h3>
              <p className="muted">
                {t("Die Rechte des Bereichs und übergeordneter Seiten gelten auch hier.", "The permissions of the space and parent pages apply here too.")}
              </p>
              {boot.members.map((m) => (
                <div className="member-row" key={m.id}>
                  <Avatar name={m.name} userId={m.id} />
                  <span>
                    {m.name}
                    <small>{m.email}</small>
                  </span>
                  {boot.workspace.role === "owner" ? (
                    <Select
                      aria-label={t(`Seitenrechte für ${m.name}`, `Page permissions for ${m.name}`)}
                      defaultValue="remove"
                      onChange={(e) =>
                        act({
                          action: "grant.set",
                          resourceId: pageId,
                          userId: m.id,
                          role: e.target.value,
                        })
                      }
                    >
                      <option value="remove">{t("Geerbt", "Inherited")}</option>
                      <option value="editor">{t("Bearbeiten", "Edit")}</option>
                      <option value="viewer">{t("Ansehen", "View")}</option>
                    </Select>
                  ) : (
                    <small>{m.role}</small>
                  )}
                </div>
              ))}
            </div>
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
              {label}
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
                  {templateCategories[template.category]}
                </small>
              </button>
            ))}
        </div>
        <SavedTemplates
          workspaceId={boot.workspace.id}
          canCreate={canCreate}
          isAdmin={!!boot.user.isAdmin}
          onError={notify}
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
              collisionPadding={8}
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
                    <Dropdown.Item
                      className="dropdown-item"
                      onSelect={() => window.open(url(), "_blank", "noopener")}
                    >
                      <ArrowSquareOut />
                      {t("In neuem Tab öffnen", "Open in new tab")}
                    </Dropdown.Item>
                    <Dropdown.Item
                      className="dropdown-item"
                      onSelect={async () => {
                        try {
                          await navigator.clipboard.writeText(url());
                          notify(t("Link kopiert", "Link copied"));
                        } catch {
                          notify(t("Link konnte nicht kopiert werden.", "The link could not be copied."));
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
                            const r = await act({ action: "page.delete", pageId: target.id });
                            if (r && pageId === target.id) {
                              go("trash");
                              setPageId(null);
                            }
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
                `<!doctype html><html lang="de"><meta charset="utf-8"><title>${data.page.title.replace(/[<>&]/g, "")}</title><body>${html.current}</body></html>`,
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
      {toast && (
        <div className="toast" role="status">
          <InfoIcon />
          {toast}
          <button
            className="icon-button"
            aria-label={t("Meldung schließen", "Close message")}
            onClick={() => setToast("")}
          >
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
function greeting(clock: number | null, t: (de: string, en: string) => string) {
  if (clock === null) return t("Hallo", "Hello");
  const hour = new Date(clock).getHours();
  return hour < 11 ? t("Guten Morgen", "Good morning") : hour < 18 ? t("Hallo", "Hello") : t("Guten Abend", "Good evening");
}
function relativeTime(value: string, clock: number | null, locale: "de" | "en" = "de") {
  const t = (de: string, en: string) => (locale === "de" ? de : en);
  const date = new Date(
    /(?:Z|[+-]\d{2}:\d{2})$/.test(value)
      ? value
      : value.replace(" ", "T") + "Z",
  );
  if (!Number.isFinite(date.getTime())) return value;
  if (clock === null) return date.toISOString().slice(0, 10);
  const diff = clock - date.getTime();
  if (diff < 60000) return t("gerade eben", "just now");
  if (diff < 3600000) return t(`vor ${Math.floor(diff / 60000)} Min.`, `${Math.floor(diff / 60000)} min ago`);
  if (diff < 86400000) return t(`vor ${Math.floor(diff / 3600000)} Std.`, `${Math.floor(diff / 3600000)} h ago`);
  return date.toLocaleDateString(LOCALE_TAG, { day: "numeric", month: "short" });
}
function InfoIcon() {
  return <Check size={18} />;
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
function withPendingCells(
  rows: Row[],
  pending: { pageId: string; rowId: string; cells: Record<string, unknown> }[],
  pageId: string,
) {
  const mine = pending.filter((p) => p.pageId === pageId);
  if (!mine.length) return rows;
  return rows.map((r) => {
    const changes = mine.filter((p) => p.rowId === r.id);
    return changes.length
      ? { ...r, cells: Object.assign({}, r.cells, ...changes.map((c) => c.cells)) }
      : r;
  });
}
