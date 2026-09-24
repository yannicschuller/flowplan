"use client";
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
import { VersionChanges } from "./version-changes";
import { LinkPreview } from "./link-preview";
import SavedTemplates from "./saved-templates";
import { useState, useEffect, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import {
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
} from "@phosphor-icons/react";
import type { Bootstrap, Page, Comment, User, Role, Space } from "@/lib/types";
import { PageExportDialog } from "./page-export";
import { Modal, PageIcon, Avatar, api, download, ApiError } from "./ui";
import DatabaseView, { type DatabaseData } from "./database-view";
import Settings from "./settings";
import Admin from "./admin";
import { ShareLinks } from "./share-links";
import type { ShareLink } from "@/lib/share-links";
const EmojiPicker = dynamic(() => import("./emoji-picker"), {
  ssr: false,
  loading: () => <p>Emojis werden geladen …</p>,
});
const DocumentEditor = dynamic(() => import("./editor"), {
  ssr: false,
  loading: () => <div className="editor-loading">Dokument wird geöffnet …</div>,
});
type PageData = DatabaseData & {
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
type Screen = "home" | "page" | "trash" | "inbox" | "settings" | "admin";
export default function WorkspaceApp({ initial }: { initial: Bootstrap }) {
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
    [newKind, setNewKind] = useState<"document" | "database">("document"),
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
    [online, setOnline] = useState(true),
    [move, setMove] = useState(false),
    [moveTarget, setMoveTarget] = useState(""),
    [templateName, setTemplateName] = useState(false),
    [templateTitle, setTemplateTitle] = useState("");
  const [treeDrop, setTreeDrop] = useState<{
    id: string;
    placement: "before" | "after" | "inside";
  } | null>(null);
  const [desktopCollapsed, setDesktopCollapsed] = useState(false);
  // Sidebar multi-selection (Ctrl/⌘/Shift-click or selection mode on touch).
  const [selectedPages, setSelectedPages] = useState<string[]>([]),
    [selecting, setSelecting] = useState(false),
    [bulkDialog, setBulkDialog] = useState<"move" | "delete" | null>(null),
    [bulkTarget, setBulkTarget] = useState(""),
    [bulkBusy, setBulkBusy] = useState(false);
  const lastSelected = useRef<string | null>(null),
    touchDrag = useRef<{ source: string; pointer: number } | null>(null);
  const [privateTemplate, setPrivateTemplate] = useState(false);
  const [starterTemplate, setStarterTemplate] = useState<string | null>(null);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchKind, setSearchKind] = useState<SearchKind>("all");
  const [iconTab, setIconTab] = useState<"emoji" | "image">("emoji");
  const [versionChanges, setVersionChanges] = useState<{
    id: string;
    label: string;
  } | null>(null);
  const [searchSpace, setSearchSpace] = useState("");
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
      const p = await api<PageData>(`/api/pages/${pid}`);
      if (
        pid === currentId.current &&
        version === navigationVersion.current &&
        !navigationPending.current
      )
        setData(p);
    }
  }, []);
  const mutate = useCallback(
    async (b: Record<string, unknown>) => {
      const result = await api("/api/command", b);
      await refresh();
      return result;
    },
    [refresh],
  );
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
        const p = await api<PageData>(`/api/pages/${id}`);
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
    if (s === "inbox") void act({ action: "notification.read" });
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
          notify("Dieser Seitenlink ist ungültig.");
          return;
        }
        if (currentId.current !== target.pageId || screenRef.current !== "page")
          void openPage(target.pageId, target);
      } else if (
        ["home", "inbox", "trash", "settings", "admin"].includes(fragment)
      ) {
        setScreen(fragment as Screen);
        screenRef.current = fragment as Screen;
        setMobile(false);
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
    canCreate = boot.workspace.role !== "viewer",
    favorites = activePages.filter((p) => boot.favorites.includes(p.id));
  function addPage(
    kind: "document" | "database" = "document",
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
  async function switchWorkspace(id: string) {
    try {
      const b = await api<Bootstrap>(`/api/bootstrap?workspace=${id}`);
      setBoot(b);
      setPageId(null);
      setData(null);
      go("home");
      setSpaceId(b.spaces[0]?.id || "");
    } catch (e) {
      notify((e as Error).message);
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
            ? "Seiten in den Papierkorb verschoben."
            : operation === "duplicate"
              ? "Seiten dupliziert."
              : "Seiten verschoben.",
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
            : !p.parent_id || !activePages.some((x) => x.id === p.parent_id)),
      )
      .map((p) => {
        const children = activePages.some((x) => x.parent_id === p.id),
          closed = collapsed.has(p.id);
        return (
          <div key={p.id}>
            <div
              className={`page-nav ${screen === "page" && pageId === p.id ? "selected" : ""} ${selectedPages.includes(p.id) ? "multi-selected" : ""} ${treeDrop?.id === p.id ? `drop-${treeDrop.placement}` : ""}`}
              data-page-id={p.id}
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
                  closed ? "Unterseiten öffnen" : "Unterseiten schließen"
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
                  closed ? (
                    <CaretRight size={12} />
                  ) : (
                    <CaretDown size={12} />
                  )
                ) : (
                  <span />
                )}
              </button>
              {selecting && (
                <input
                  type="checkbox"
                  className="page-select"
                  aria-label={`${p.title} auswählen`}
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
                  }}
                  onPointerMove={(e) => {
                    if (touchDrag.current?.pointer !== e.pointerId) return;
                    const target = touchTarget(e.clientX, e.clientY);
                    setTreeDrop(
                      target && target.id !== touchDrag.current.source
                        ? target
                        : null,
                    );
                  }}
                  onPointerUp={(e) => {
                    const drag = touchDrag.current;
                    touchDrag.current = null;
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
                    setTreeDrop(null);
                  }}
                >
                  <DotsSixVertical size={14} />
                </button>
              )}
              {canCreate && (
                <button
                  className="nav-add"
                  title="Unterseite hinzufügen"
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
  return (
    <div
      className={`app-shell ${mobile ? "nav-open" : ""} ${desktopCollapsed ? "desktop-collapsed" : ""}`}
    >
      <button
        className="mobile-scrim"
        aria-label="Navigation schließen"
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
            <span className="logo">
              <Stack weight="bold" size={21} />
            </span>
            <span>flowplan</span>
          </a>
          <button
            className="icon-button sidebar-hide"
            title="Navigation schließen"
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
            <span className="workspace-letter">
              {boot.workspace.name.slice(0, 1)}
            </span>
            <span>
              {boot.workspace.name}
              <small>
                {boot.members.length}{" "}
                {boot.members.length === 1 ? "Mitglied" : "Mitglieder"}
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
                  <span className="workspace-letter small">{w.name[0]}</span>
                  {w.name}
                  {w.id === boot.workspace.id && <Check />}
                </Dropdown.Item>
              ))}
              <Dropdown.Separator className="dropdown-separator" />
              <Dropdown.Item
                className="dropdown-item"
                onSelect={() => setNewWorkspace(true)}
              >
                <Plus />
                Arbeitsbereich erstellen
              </Dropdown.Item>
            </Dropdown.Content>
          </Dropdown.Portal>
        </Dropdown.Root>
        <nav className="main-nav">
          <button onClick={() => setSearch(true)}>
            <MagnifyingGlass size={19} />
            Suchen<span className="keycap">⌘ K</span>
          </button>
          <button
            className={screen === "home" ? "selected" : ""}
            onClick={() => go("home")}
          >
            <House size={19} />
            Startseite
          </button>
          <button
            className={screen === "inbox" ? "selected" : ""}
            onClick={() => go("inbox")}
          >
            <Bell size={19} />
            Posteingang
            {boot.notifications.some((n) => !n.read_at) && (
              <span className="notification-count">
                {boot.notifications.filter((n) => !n.read_at).length}
              </span>
            )}
          </button>
        </nav>
        <div className="sidebar-scroll">
          {favorites.length > 0 && (
            <section className="nav-section">
              <div className="nav-section-title">
                Favoriten
                <Star size={13} />
              </div>
              {favorites.map((p) => (
                <button
                  className={`favorite-nav ${pageId === p.id && screen === "page" ? "selected" : ""}`}
                  key={p.id}
                  onClick={() => openPage(p.id)}
                >
                  <PageIcon name={p.icon} />
                  <span>{p.title}</span>
                </button>
              ))}
            </section>
          )}
          {(selecting || selectedPages.length > 0) && (
            <div
              className="page-selection-bar"
              role="toolbar"
              aria-label="Seitenauswahl"
            >
              <span>{selectedPages.length} ausgewählt</span>
              <button
                className="text-button"
                disabled={!selectedPages.length || bulkBusy}
                onClick={() => {
                  setBulkTarget("");
                  setBulkDialog("move");
                }}
              >
                Verschieben
              </button>
              <button
                className="text-button"
                disabled={!selectedPages.length || bulkBusy}
                onClick={() => void bulkPages("duplicate")}
              >
                Duplizieren
              </button>
              <button
                className="text-button danger"
                disabled={!selectedPages.length || bulkBusy}
                onClick={() => setBulkDialog("delete")}
              >
                Papierkorb
              </button>
              <button className="text-button" onClick={clearSelection}>
                Fertig
              </button>
            </div>
          )}
          {boot.spaces.map((space) => (
            <section className="nav-section" key={space.id}>
              <div className="nav-section-title">
                <span>
                  <SpaceIcon icon={space.icon} color={space.icon_color} />
                  {space.visibility === "private" && (
                    <Lock size={12} aria-label="Privater Bereich" />
                  )}{" "}
                  <span className="space-name" title={space.name}>
                    {space.name}
                  </span>
                </span>
                {(boot.workspace.role === "owner" ||
                  (canCreate && space.owner_id === boot.user.id)) && (
                  <button
                    className="icon-button"
                    aria-label={`Bereich ${space.name} verwalten`}
                    onClick={() => setSpaceManager({ space })}
                  >
                    <DotsThree size={16} />
                  </button>
                )}
                {canCreate && (
                  <button
                    className={`icon-button ${selecting ? "active" : ""}`}
                    title="Seiten auswählen"
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
                    title={`Seite in ${space.name} hinzufügen`}
                    onClick={() => addPage("document", null, space.id)}
                  >
                    <Plus size={14} />
                  </button>
                )}
              </div>
              {tree(null, space.id)}
              {!activePages.some((p) => p.space_id === space.id) && (
                <span className="sidebar-empty">Noch keine Seiten</span>
              )}
            </section>
          ))}
          {canCreate && (
            <button className="add-space" onClick={() => setNewSpace(true)}>
              <Plus size={15} />
              Bereich hinzufügen
            </button>
          )}
        </div>
        <div className="sidebar-bottom">
          <button onClick={() => setTemplates(true)}>
            <SquaresFour size={18} />
            Vorlagen
          </button>
          <button
            className={screen === "trash" ? "selected" : ""}
            onClick={() => go("trash")}
          >
            <Trash size={18} />
            Papierkorb
          </button>
          <button
            className={screen === "settings" ? "selected" : ""}
            onClick={() => go("settings")}
          >
            <GearSix size={18} />
            Einstellungen
          </button>
          {boot.user.isAdmin && (
            <button
              className={screen === "admin" ? "selected" : ""}
              onClick={() => go("admin")}
            >
              <ShieldCheck size={18} />
              Administration
            </button>
          )}
          <div className="profile">
            <Avatar name={boot.user.name} />
            <span>
              {boot.user.name}
              <small>{online ? "Arbeitsbereich verbunden" : "Offline"}</small>
            </span>
            <Dropdown.Root>
              <Dropdown.Trigger className="icon-button" aria-label="Kontomenü">
                <DotsThree size={22} />
              </Dropdown.Trigger>
              <Dropdown.Portal>
                <Dropdown.Content className="dropdown" align="end">
                  <Dropdown.Item
                    className="dropdown-item"
                    onSelect={() => {
                      setDark(!dark);
                      document.documentElement.dataset.theme = !dark
                        ? "dark"
                        : "light";
                      localStorage.setItem(
                        "flowplan-theme",
                        !dark ? "dark" : "light",
                      );
                    }}
                  >
                    {dark ? <Sun /> : <Moon />}
                    {dark ? "Helles Design" : "Dunkles Design"}
                  </Dropdown.Item>
                  <Dropdown.Item
                    className="dropdown-item"
                    onSelect={async () => {
                      await fetch("/api/auth/logout", { method: "POST" });
                      location.href = "/";
                    }}
                  >
                    <SignOut />
                    Abmelden
                  </Dropdown.Item>
                </Dropdown.Content>
              </Dropdown.Portal>
            </Dropdown.Root>
          </div>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              aria-label="Navigation öffnen"
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
                    home: "Startseite",
                    trash: "Papierkorb",
                    inbox: "Posteingang",
                    settings: "Einstellungen",
                    admin: "Administration",
                    page: "Seite",
                  }[screen]
                }
              </span>
            )}
          </div>
          {screen === "page" && data ? (
            <div className="page-top-actions">
              <span className="save-status">
                {online ? <CloudCheck size={15} /> : <WifiSlash size={15} />}
                <span>{status}</span>
              </span>
              <div className="presence">
                {data.present
                  .filter((u) => u.id !== boot.user.id)
                  .slice(0, 3)
                  .map((u) => (
                    <Avatar name={u.name} small key={u.id} />
                  ))}
              </div>
              <button
                title="Kommentare"
                className={`icon-button ${comments ? "active" : ""}`}
                onClick={() => setComments(!comments)}
              >
                <ChatCircle size={20} />
              </button>
              <button
                className={`icon-button ${boot.favorites.includes(data.page.id) ? "starred" : ""}`}
                title="Favorit"
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
                Teilen
              </button>
              <Dropdown.Root>
                <Dropdown.Trigger
                  className="icon-button"
                  aria-label="Seitenaktionen"
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
                      Icon ändern
                    </Dropdown.Item>
                    <Dropdown.Item
                      className="dropdown-item"
                      onSelect={() => setCoverPicker(true)}
                    >
                      <SquaresFour />
                      Cover ändern
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
                      Volle Breite {data.page.full_width ? "✓" : ""}
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
                      Schrift wechseln
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
                      Duplizieren
                    </Dropdown.Item>
                    <Dropdown.Item
                      className="dropdown-item"
                      onSelect={() => setMove(true)}
                    >
                      <ArrowRight />
                      Verschieben
                    </Dropdown.Item>
                    <Dropdown.Item
                      className="dropdown-item"
                      onSelect={() => setTemplateName(true)}
                    >
                      <SquaresFour />
                      Als Vorlage speichern
                    </Dropdown.Item>
                    <Dropdown.Item
                      className="dropdown-item"
                      onSelect={() => setPageExport(true)}
                    >
                      <DownloadSimple />
                      Exportieren
                    </Dropdown.Item>
                    <Dropdown.Item
                      className="dropdown-item"
                      onSelect={() => window.print()}
                    >
                      <FileText />
                      Drucken / PDF
                    </Dropdown.Item>
                    <Dropdown.Item
                      className="dropdown-item"
                      onSelect={() => setHistory(true)}
                    >
                      <Clock />
                      Versionsverlauf
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
                      {data.page.locked ? "Seite entsperren" : "Seite sperren"}
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
                      In den Papierkorb
                    </Dropdown.Item>
                  </Dropdown.Content>
                </Dropdown.Portal>
              </Dropdown.Root>
            </div>
          ) : (
            <span className="topbar-note">
              <span className="subtle-dot" />
              Dein Raum für Ideen
            </span>
          )}
        </header>
        <div className="main-scroll">
          {screen === "home" && (
            <div className="home-content">
              <div className="home-greeting">
                <span className="eyebrow">DEIN ARBEITSBEREICH</span>
                <h1>
                  {greeting(clock)}, {boot.user.name.split(" ")[0]}
                  <span className="greeting-dot">.</span>
                </h1>
                <p>
                  Gute Ideen beginnen hier. Mach dort weiter, wo du aufgehört
                  hast.
                </p>
              </div>
              <section className="recent-section">
                <div className="section-heading">
                  <h2>
                    <Clock size={19} />
                    Zuletzt bearbeitet
                  </h2>
                  <span>
                    {activePages.length} Seiten in deinem Arbeitsbereich
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
                          Bearbeitet {relativeTime(p.updated_at, clock)}
                        </small>
                      </button>
                    ))}
                </div>
              </section>
              <section className="quick-section">
                <h2>Was hast du heute vor?</h2>
                <div className="quick-actions">
                  <button
                    disabled={clock === null || !canCreate}
                    onClick={() => addPage()}
                  >
                    <span className="quick-icon blue">
                      <FileText size={25} />
                    </span>
                    <span>
                      <strong>Eine Idee festhalten</strong>
                      <small>Eine leere Seite voller Möglichkeiten</small>
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
                      <strong>Ein Projekt planen</strong>
                      <small>Aufgaben, Termine und Überblick</small>
                    </span>
                    <Plus size={20} />
                  </button>
                </div>
              </section>
              <section className="workspace-pages">
                <div className="section-heading">
                  <h2>
                    <Folder size={19} />
                    In deinem Arbeitsbereich
                  </h2>
                  {canCreate && (
                    <button
                      className="text-button"
                      disabled={clock === null}
                      onClick={() => addPage()}
                    >
                      <Plus size={16} />
                      Neue Seite
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
                        {p.kind === "database" ? "Datenbank" : "Dokument"}
                      </span>
                      <ArrowUpRight size={17} />
                    </button>
                  ))}
              </section>
              <div className="home-footnote">
                <Stack size={16} />
                <span>Weniger suchen. Mehr bewegen.</span>
                <span>⌘ K zum schnellen Finden</span>
              </div>
            </div>
          )}
          {screen === "page" && (busy || !data) ? (
            <div className="loading-content">
              {busy ? "Seite wird geöffnet …" : "Seite nicht verfügbar."}
            </div>
          ) : (
            screen === "page" &&
            data && (
              <div className={`page-layout ${comments ? "with-comments" : ""}`}>
                <article
                  className={`page-content ${data.page.kind === "database" ? "database-page" : ""} ${data.page.full_width ? "full-width" : ""} font-${data.page.font}`}
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
                          alt="Seiten-Cover"
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
                          Cover ändern
                        </button>
                      )}
                    </div>
                  )}
                  <div className="document-header">
                    <button
                      className="large-page-icon"
                      title="Seiten-Icon ändern"
                      onClick={() => editable && setIconPicker(true)}
                    >
                      <PageIcon name={data.page.icon} size={43} />
                    </button>
                    {editable && !data.page.cover && (
                      <button
                        className="add-cover text-button"
                        onClick={() => setCoverPicker(true)}
                      >
                        Cover hinzufügen
                      </button>
                    )}
                    <input
                      key={`${data.page.id}-title`}
                      className="page-title"
                      aria-label="Seitentitel"
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
                        Diese Seite ist gesperrt.
                      </div>
                    )}
                  </div>
                  {data.page.kind === "database" ? (
                    <DatabaseView
                      key={data.page.id}
                      routeNavigation
                      page={data.page}
                      userId={boot.user.id}
                      onRefresh={refresh}
                      data={data}
                      members={boot.members}
                      pages={activePages}
                      editable={editable}
                      mutate={mutate}
                      onError={notify}
                    />
                  ) : (
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
                    />
                  )}
                  <div className="backlinks">
                    {data.backlinks?.length > 0 && (
                      <>
                        <h3>Verlinkt von</h3>
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
                      .filter((p) => p.parent_id === data.page.id)
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
                        Unterseite hinzufügen
                      </button>
                    )}
                  </div>
                </article>
                {comments && (
                  <aside className="comments-panel">
                    <header>
                      <h3>Kommentare</h3>
                      <button
                        className="icon-button"
                        aria-label="Kommentare schließen"
                        onClick={() => setComments(false)}
                      >
                        <X />
                      </button>
                    </header>
                    {data.comments
                      .filter((c) => !c.row_id)
                      .map((c) => (
                        <div
                          className={`comment ${c.resolved ? "resolved" : ""}`}
                          key={c.id}
                        >
                          <Avatar name={c.name} small />
                          <div>
                            <strong>{c.name}</strong>
                            <small>{relativeTime(c.created_at, clock)}</small>
                            <p>{c.body}</p>
                            {data.role !== "viewer" && (
                              <button
                                className="text-button"
                                onClick={() =>
                                  act({
                                    action: "comment.resolve",
                                    pageId,
                                    commentId: c.id,
                                    resolved: !c.resolved,
                                  })
                                }
                              >
                                {c.resolved
                                  ? "Wieder öffnen"
                                  : "Als erledigt markieren"}
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    {!data.comments.filter((c) => !c.row_id).length && (
                      <div className="empty-state small">
                        <ChatCircle size={30} />
                        <p>
                          Ein guter Austausch beginnt
                          <br />
                          mit einem Kommentar.
                        </p>
                      </div>
                    )}
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
                        placeholder="Schreibe einen Kommentar …"
                      />
                      <button className="button primary compact">
                        Kommentieren
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
                <h1>Papierkorb</h1>
                <p>Gelöschte Seiten und Bereiche kannst du wiederherstellen.</p>
              </div>
              {(boot.trashedSpaces || []).map((space) => (
                <div className="utility-row trash-space" key={space.id}>
                  <SpaceIcon icon={space.icon} color={space.icon_color} />
                  <strong>
                    {space.name}
                    <small>Bereich mit Seiten</small>
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
                      Bereich wiederherstellen
                    </button>
                    <button
                      className="button danger compact"
                      onClick={() => setSpaceManager({ space, purge: true })}
                    >
                      Endgültig löschen
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
                    <span>{relativeTime(p.deleted_at!, clock)}</span>
                    <button
                      className="button compact"
                      onClick={() =>
                        act({ action: "page.restore", pageId: p.id })
                      }
                    >
                      <ArrowCounterClockwise />
                      Wiederherstellen
                    </button>
                  </div>
                ))}
              {!boot.pages.some((p) => p.deleted_at) &&
                !boot.trashedSpaces?.length && (
                  <div className="empty-state">
                    <Trash size={38} />
                    <h3>Alles aufgeräumt</h3>
                    <p>Dein Papierkorb ist leer.</p>
                  </div>
                )}
            </div>
          )}
          {screen === "inbox" && (
            <div className="utility-content">
              <div className="utility-title">
                <Bell size={30} />
                <h1>Posteingang</h1>
                <p>Neuigkeiten aus deinem Arbeitsbereich.</p>
              </div>
              {boot.notifications.map((n) => (
                <button
                  className="notification-row"
                  key={n.id}
                  onClick={() => {
                    const target = parsePageLocation(
                      notificationUrl(n).slice(1),
                    );
                    if (target) void openPage(target.pageId, target);
                  }}
                >
                  <ChatCircle size={22} />
                  <span>
                    {n.body}
                    <small>{relativeTime(n.created_at, clock)}</small>
                  </span>
                  <ArrowUpRight />
                </button>
              ))}
              {!boot.notifications.length && (
                <div className="empty-state">
                  <Bell size={38} />
                  <h3>Du bist auf dem Laufenden</h3>
                  <p>Neue Kommentare erscheinen hier.</p>
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
        title="Seiten verschieben"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (bulkTarget) void bulkPages("move", bulkTarget);
          }}
        >
          <label>
            Ziel
            <select
              aria-label="Ziel"
              value={bulkTarget}
              onChange={(e) => setBulkTarget(e.target.value)}
            >
              <option value="">Ziel wählen …</option>
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
            </select>
          </label>
          <p className="muted">
            {selectedPages.length} Seiten mit ihren Unterseiten verschieben.
          </p>
          <div className="modal-actions">
            <button
              type="button"
              className="button"
              onClick={() => setBulkDialog(null)}
            >
              Abbrechen
            </button>
            <button
              className="button primary"
              disabled={!bulkTarget || bulkBusy}
            >
              Verschieben
            </button>
          </div>
        </form>
      </Modal>
      <Modal
        open={bulkDialog === "delete"}
        onClose={() => setBulkDialog(null)}
        title="Seiten in den Papierkorb"
      >
        <p>
          {selectedPages.length} Seiten samt Unterseiten in den Papierkorb
          verschieben? Freigaben und Veröffentlichungen werden beendet.
        </p>
        <div className="modal-actions">
          <button className="button" onClick={() => setBulkDialog(null)}>
            Abbrechen
          </button>
          <button
            className="button danger"
            disabled={bulkBusy}
            onClick={() => void bulkPages("delete")}
          >
            In den Papierkorb
          </button>
        </div>
      </Modal>
      <Modal
        open={search}
        onClose={() => {
          setSearch(false);
          setQuery("");
        }}
        title="Schnellsuche"
      >
        <div className="command-search">
          <MagnifyingGlass size={22} />
          <input
            autoFocus
            placeholder="Seiten, Inhalte und Einträge finden …"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <kbd>esc</kbd>
        </div>
        <div className="search-filters">
          <div role="radiogroup" aria-label="Suchergebnisse filtern">
            {(
              [
                ["all", "Alles"],
                ["document", "Dokumente"],
                ["database", "Datenbanken"],
                ["row", "Einträge"],
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
          <select
            aria-label="Bereich"
            value={searchSpace}
            onChange={(e) => setSearchSpace(e.target.value)}
          >
            <option value="">Alle Bereiche</option>
            {boot.spaces.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
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
                {p.rowId && (
                  <small className="search-context">
                    Eintrag in {p.pageTitle}
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
          {!searchResults.length && (
            <div className="empty-state small">Nichts gefunden.</div>
          )}
        </div>
      </Modal>
      <Modal open={create} onClose={() => setCreate(false)} title="Neue Seite">
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const result = await act({
              action: "page.create",
              workspaceId: boot.workspace.id,
              spaceId,
              parentId: parent,
              title: newTitle || "Ohne Titel",
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
            Name
            <input
              autoFocus
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="Wie heißt deine Seite?"
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
              <strong>Dokument</strong>
              <small>Notizen, Wissen und Ideen</small>
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
              <strong>Datenbank</strong>
              <small>Aufgaben und strukturierte Daten</small>
            </button>
          </div>
          <label>
            Bereich
            <select
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
            </select>
          </label>
          <div className="modal-actions">
            <button
              type="button"
              className="button"
              onClick={() => setCreate(false)}
            >
              Abbrechen
            </button>
            <button className="button primary">Seite erstellen</button>
          </div>
        </form>
      </Modal>
      <Modal open={share} onClose={() => setShare(false)} title="Seite teilen">
        {data && (
          <>
            <div className="share-members">
              <h3>Zugriff im Arbeitsbereich</h3>
              <p className="muted">
                Die Rechte des Bereichs und übergeordneter Seiten gelten auch
                hier.
              </p>
              {boot.members.map((m) => (
                <div className="member-row" key={m.id}>
                  <Avatar name={m.name} />
                  <span>
                    {m.name}
                    <small>{m.email}</small>
                  </span>
                  {boot.workspace.role === "owner" ? (
                    <select
                      aria-label={`Seitenrechte für ${m.name}`}
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
                      <option value="remove">Geerbt</option>
                      <option value="editor">Bearbeiten</option>
                      <option value="viewer">Ansehen</option>
                    </select>
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
                Im Web veröffentlichen
              </h3>
              <p>Jeder mit dem Link kann den Inhalt dieser Seite lesen.</p>
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
                Öffentlichen Link aktivieren
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
                    Aktuell vorhandene Unterseiten mit veröffentlichen
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
                    Besucher dürfen eine Kopie in ihren Arbeitsbereich
                    übernehmen
                  </label>
                  <p className="muted">
                    Veröffentlichte Seiten: {data.publication?.count || 1}.
                    Dokumente, Datensatzinhalte und darin verlinkte Uploads sind
                    öffentlich. Kommentare und Mitgliederangaben bleiben privat.
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
                      Auswahl um neue Unterseiten ergänzen
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
                      notify("Link kopiert");
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
        title="Versionsverlauf"
      >
        {data && (
          <>
            <button
              className="button primary"
              onClick={() => act({ action: "page.snapshot", pageId })}
            >
              <Plus />
              Aktuelle Version sichern
            </button>
            <div className="history-list">
              {data.snapshots.map((s) => (
                <div className="utility-row" key={s.id}>
                  <Clock />
                  <span>
                    <strong>{s.title}</strong>
                    <small>
                      {new Date(s.created_at + "Z").toLocaleString("de-DE")}
                      {" · "}
                      {s.kind === "manual"
                        ? "Manuell gesichert"
                        : "Automatisch"}
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
                          "de-DE",
                        ),
                      });
                    }}
                  >
                    Änderungen
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
                        notify("Version wiederhergestellt");
                      }
                    }}
                  >
                    Wiederherstellen
                  </button>
                </div>
              ))}
              {!data.snapshots.length && (
                <p className="muted">Noch keine gesicherten Versionen.</p>
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
            label: new Date(s.created_at + "Z").toLocaleString("de-DE"),
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
        title="Seiten-Icon"
      >
        {iconPicker && data && (
          <>
            <div
              className="icon-tabs"
              role="tablist"
              aria-label="Art des Seitensymbols"
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
                  aria-selected={iconTab === tab}
                  className={`chip${iconTab === tab ? " active" : ""}`}
                  onClick={() => setIconTab(tab)}
                >
                  {label}
                </button>
              ))}
            </div>
            {iconTab === "emoji" ? (
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
        title="Arbeitsbereich erstellen"
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
            Name
            <input
              required
              autoFocus
              value={workspaceName}
              onChange={(e) => setWorkspaceName(e.target.value)}
              placeholder="z. B. Design-Team"
            />
          </label>
          <button className="button primary">Erstellen</button>
        </form>
      </Modal>
      <Modal
        open={newSpace}
        onClose={() => setNewSpace(false)}
        title="Bereich hinzufügen"
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
            Name
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
            Privater Bereich
          </label>
          <p className="muted">
            Private Bereiche sind nur für dich und ausdrücklich berechtigte
            Mitglieder sichtbar.
          </p>
          <button className="button primary">Bereich erstellen</button>
        </form>
      </Modal>
      <Modal
        open={templates}
        onClose={() => setTemplates(false)}
        title="Vorlagen"
      >
        <p className="muted">
          Starte mit einer Struktur oder verwende deine gespeicherten Vorlagen.
        </p>
        <div className="template-grid">
          {[
            ["Meeting-Notizen", "document", "meeting"],
            ["Projektplanung", "database", "project"],
            ["Team-Wiki", "document", "wiki"],
            ["Aufgabenliste", "database", "tasks"],
          ].map(([name, kind, templateKey]) => (
            <button
              key={name}
              onClick={() => {
                setTemplates(false);
                setNewTitle(name);
                setStarterTemplate(templateKey);
                setNewKind(kind as "document" | "database");
                setParent(null);
                setCreate(true);
              }}
            >
              <PageIcon
                name={kind === "database" ? "table" : "book"}
                size={28}
              />
              <strong>{name}</strong>
              <small>
                {kind === "database"
                  ? "Datenbank mit vorbereiteter Struktur"
                  : "Dokument"}
              </small>
            </button>
          ))}
        </div>
        <SavedTemplates
          workspaceId={boot.workspace.id}
          canCreate={canCreate}
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
        title="Vorlage speichern"
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
              notify("Vorlage gespeichert");
            }
          }}
        >
          <label>
            Name
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
            Nur für mich sichtbar
          </label>
          <button className="button primary">Speichern</button>
        </form>
      </Modal>
      <Modal
        open={move}
        onClose={() => setMove(false)}
        title="Seite verschieben"
      >
        <label>
          Übergeordnete Seite
          <select
            value={moveTarget}
            onChange={(e) => setMoveTarget(e.target.value)}
          >
            <option value="">Auf oberste Ebene</option>
            {activePages
              .filter((p) => p.id !== pageId)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
          </select>
        </label>
        <button
          className="button primary"
          onClick={async () => {
            const r = await act({
              action: "page.move",
              pageId,
              parentId: moveTarget || null,
            });
            if (r) setMove(false);
          }}
        >
          Verschieben
        </button>
      </Modal>
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
            aria-label="Meldung schließen"
            onClick={() => setToast("")}
          >
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
function greeting(clock: number | null) {
  if (clock === null) return "Hallo";
  const hour = new Date(clock).getHours();
  return hour < 11 ? "Guten Morgen" : hour < 18 ? "Hallo" : "Guten Abend";
}
function relativeTime(value: string, clock: number | null) {
  const date = new Date(
    /(?:Z|[+-]\d{2}:\d{2})$/.test(value)
      ? value
      : value.replace(" ", "T") + "Z",
  );
  if (!Number.isFinite(date.getTime())) return value;
  if (clock === null) return date.toISOString().slice(0, 10);
  const diff = clock - date.getTime();
  if (diff < 60000) return "gerade eben";
  if (diff < 3600000) return `vor ${Math.floor(diff / 60000)} Min.`;
  if (diff < 86400000) return `vor ${Math.floor(diff / 3600000)} Std.`;
  return date.toLocaleDateString("de-DE", { day: "numeric", month: "short" });
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
