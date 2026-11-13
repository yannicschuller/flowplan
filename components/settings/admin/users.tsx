"use client";
// Administration → Benutzer: the accounts of the instance as a dense,
// sortable and paged table (a card list on phones) with their state, their
// workspaces, storage and activity; actions for several at once, a menu of
// quick actions per row, and one account's details and every action in a
// side panel (a bottom sheet on phones). Registration is set under
// Anmeldung & SSO.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import {
  ArrowDown,
  ArrowsLeftRight,
  ArrowsMerge,
  ArrowUp,
  CaretDown,
  CaretLeft,
  CaretRight,
  CaretUp,
  CaretUpDown,
  DotsThree,
  IdentificationCard,
  Key,
  LockOpen,
  MagnifyingGlass,
  Prohibit,
  SignOut,
  Stack,
  Trash,
  Users,
} from "@phosphor-icons/react";
import type { MergePreview } from "@/lib/account-merge";
import type { User } from "@/lib/types";
import { useT } from "../../i18n";
import { Avatar, Modal, showNotice } from "../../ui";
import { Select } from "../../select";
import { EmptyState, NumberField, SaveState, StatusBadge, useSaveState, type Tone } from "../../settings-ui";
import { AiUserSwitch } from "../../ai-settings";
import { useAdminData, type AdminData } from "../admin-context";
import { AdminLoading } from "../shell";
import { AdminStatus, FixLink, type StatusItem } from "./parts";
import { ago, duration, mbText } from "./format";
import { activityState, type UserActivity } from "@/lib/user-activity-state";
import { LOCALE_TAG } from "@/lib/locale-tag";

type Local = {
  admin: boolean;
  verified: boolean;
  passkeys: number;
  totp?: boolean;
  password?: boolean;
};
type Usage = NonNullable<AdminData["userUsage"]>[number];
type Activity = Pick<UserActivity, "openAt" | "activeAt">;
type Filter = "all" | "here" | "active" | "inactive" | "disabled" | "admins";
type SortKey = "name" | "status" | "workspaces" | "storage" | "last" | "created";
type Sort = { key: SortKey; dir: "asc" | "desc" };
// The direction a column starts with: names A–Z, the rest largest or newest first.
const FIRST_DIR: Record<SortKey, Sort["dir"]> = { name: "asc", status: "asc", workspaces: "desc", storage: "desc", last: "desc", created: "desc" };
const PAGE_SIZES = [25, 50, 100];
// No sign-in for this long counts as inactive (the instance may disable such
// accounts automatically after its own number of days).
const INACTIVE_DAYS = 30;
const DAY = 86_400_000;
type State = { key: "active" | "inactive" | "disabled"; days: number };

const createdAt = (u: User) => Date.parse(u.created_at.includes("T") ? u.created_at : `${u.created_at.replace(" ", "T")}Z`);
// The state of one account, as a badge.
function stateOf(u: User, now: number): State {
  const last = u.last_login_at ?? createdAt(u);
  const days = Number.isFinite(last) ? Math.floor((now - last) / DAY) : 0;
  if (u.disabled) return { key: "disabled", days };
  return { key: days >= INACTIVE_DAYS ? "inactive" : "active", days };
}
const dateText = (ms: number) => (Number.isFinite(ms) ? new Date(ms).toLocaleDateString(LOCALE_TAG, { day: "2-digit", month: "2-digit", year: "numeric" }) : "–");
// Bytes as KB, MB or GB; a limit in MB likewise.
const sizeText = (bytes: number) =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toLocaleString(LOCALE_TAG, { maximumFractionDigits: 1 })} GB`
    : bytes > 0 && bytes < 1024 * 1024
      ? `${Math.max(1, Math.round(bytes / 1024)).toLocaleString(LOCALE_TAG)} KB`
      : bytes === 0
        ? "0 KB"
        : mbText(bytes);
const limitText = (mb: number) => (mb ? sizeText(mb * 1024 * 1024) : "∞");
// The page buttons: all up to seven pages, else the first, the last and
// the ones around the current page, gaps as null.
function pageList(page: number, pages: number): (number | null)[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const around = [page - 1, page, page + 1].filter((p) => p > 1 && p < pages);
  if (page <= 3) around.push(2, 3, 4);
  if (page >= pages - 2) around.push(pages - 3, pages - 2, pages - 1);
  const list = [...new Set([1, ...around, pages])].sort((a, b) => a - b);
  return list.flatMap((p, i) => (i && p - list[i - 1] > 1 ? [null, p] : [p]));
}

export default function UsersSection() {
  const t = useT();
  const { data, mutate, load, act, onError } = useAdminData();
  const [query, setQuery] = useState(""),
    [filter, setFilter] = useState<Filter>("all"),
    [sort, setSort] = useState<Sort>({ key: "last", dir: "desc" }),
    [page, setPage] = useState(1),
    [perPage, setPerPage] = useState(25),
    [selected, setSelected] = useState<Set<string>>(new Set()),
    [open, setOpen] = useState<string | null>(null),
    [bulk, setBulk] = useState(false);
  const now = useMemo(() => Date.now(), [data]);
  const live = useLiveActivity();
  const scroll = useEdgeShadows();
  if (!data) return <AdminLoading />;
  // The live times (every 30 s) over the ones the page was loaded with.
  const activityOf = (u: User): Activity => live.users.get(u.id) ?? { openAt: u.last_open_at ?? null, activeAt: u.last_active_at ?? null };
  const liveNow = live.now || now;
  const local = data.localAccounts || {};
  const admins = new Set(data.adminIds || []);
  const isAdmin = (id: string) => admins.has(id) || !!local[id]?.admin;
  const states = new Map(data.users.map((u) => [u.id, stateOf(u, now)]));
  const usages = new Map((data.userUsage || []).map((x) => [x.id, x]));
  const count = (f: Filter) => data.users.filter((u) => matches(u, f)).length;
  function matches(u: User, f: Filter) {
    const s = states.get(u.id)!.key;
    if (f === "here") return ["active", "idle"].includes(activityState(activityOf(u), liveNow));
    return f === "all" || (f === "admins" ? isAdmin(u.id) : s === f);
  }
  // What a column sorts by; ties by name.
  const statusRank = (u: User) => (u.disabled ? 3 : u.deletion_due_at ? 2 : states.get(u.id)!.key === "inactive" ? 1 : 0);
  const sortValue: Record<SortKey, (u: User) => number | string> = {
    name: (u) => u.name.toLocaleLowerCase(LOCALE_TAG),
    status: statusRank,
    workspaces: (u) => usages.get(u.id)?.memberOf?.length ?? 0,
    storage: (u) => usages.get(u.id)?.bytes ?? 0,
    last: (u) => activityOf(u).activeAt ?? activityOf(u).openAt ?? 0,
    created: (u) => createdAt(u) || 0,
  };
  const needle = query.trim().toLocaleLowerCase();
  const shown = data.users
    .filter((u) => matches(u, filter) && (!needle || `${u.name} ${u.email}`.toLocaleLowerCase().includes(needle)))
    .map((u) => ({ u, v: sortValue[sort.key](u) }))
    .sort((a, b) => {
      const d = typeof a.v === "string" ? a.v.localeCompare(b.v as string, LOCALE_TAG) : a.v - (b.v as number);
      return (sort.dir === "asc" ? d : -d) || a.u.name.localeCompare(b.u.name, LOCALE_TAG);
    })
    .map((x) => x.u);
  const pages = Math.max(1, Math.ceil(shown.length / perPage));
  const current = Math.min(page, pages);
  const first = (current - 1) * perPage;
  const rows = shown.slice(first, first + perPage);
  // A new search, filter, order or page size starts on the first page.
  const changeQuery = (q: string) => (setQuery(q), setPage(1));
  const changeFilter = (f: Filter) => (setFilter(f), setPage(1));
  const changeSort = (next: Sort) => (setSort(next), setPage(1));
  const sortBy = (key: SortKey) => changeSort(sort.key === key ? { key, dir: sort.dir === "asc" ? "desc" : "asc" } : { key, dir: FIRST_DIR[key] });
  const chosen = data.users.filter((u) => selected.has(u.id));
  const allRows = rows.length > 0 && rows.every((u) => selected.has(u.id));
  const someRows = !allRows && rows.some((u) => selected.has(u.id));
  const toggle = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  // One command per selected account, then one reload.
  const runBulk = async (body: (u: User) => Record<string, unknown> | null) => {
    setBulk(true);
    try {
      for (const u of chosen) {
        const b = body(u);
        if (b) await mutate(b);
      }
      setSelected(new Set());
    } catch (e) {
      onError((e as Error).message);
    } finally {
      await load();
      setBulk(false);
    }
  };
  const block = (u: User) => {
    if (confirm(t(`${u.name} sperren? Alle Sitzungen enden; die Person kann sich nicht mehr anmelden.`, `Block ${u.name}? All sessions end; the person can no longer sign in.`)))
      void act({ action: "admin.user", userId: u.id, disabled: true });
  };
  const signOut = async (u: User) => {
    if ((await act({ action: "admin.revoke", userId: u.id })) !== undefined) showNotice(t(`${u.name} ist auf allen Geräten abgemeldet.`, `${u.name} is signed out on every device.`));
  };
  const inactive = count("inactive"),
    disabled = count("disabled"),
    here = count("here");
  const items: StatusItem[] = [
    {
      tone: "ok",
      label: data.users.length === 1 ? t("1 Konto", "1 account") : t(`${data.users.length} Konten`, `${data.users.length} accounts`),
    },
  ];
  items.push({
    tone: here ? "ok" : "off",
    label: here === 1 ? t("1 gerade da", "1 here now") : t(`${here} gerade da`, `${here} here now`),
  });
  if (inactive)
    items.push({
      tone: "warn",
      label: t(`${inactive} inaktiv`, `${inactive} inactive`),
    });
  if (disabled)
    items.push({
      tone: "error",
      label: t(`${disabled} deaktiviert`, `${disabled} disabled`),
    });
  if (data.localLogin)
    items.push(
      data.settings.allowSignup
        ? { tone: "info", label: t("Registrierung offen", "Sign-up open") }
        : {
            tone: "off",
            label: t("Registrierung geschlossen", "Sign-up closed"),
          },
    );
  const person = data.users.find((u) => u.id === open) || null;
  const columns: [SortKey, string, string?][] = [
    ["name", t("Person", "Person"), "who"],
    ["status", t("Status", "Status"), "state"],
    ["workspaces", t("Arbeitsbereiche", "Workspaces"), "end"],
    ["storage", t("Speicher", "Storage")],
    ["last", t("Zuletzt aktiv", "Last active")],
    ["created", t("Erstellt", "Created")],
  ];
  return (
    <>
      <AdminStatus items={items} action={data.localLogin ? <FixLink href="#admin/signin/registration">{t("Registrierung einstellen", "Set up sign-up")}</FixLink> : undefined}>
        {data.sessions === 1 ? t("1 aktive Sitzung.", "1 active session.") : t(`${data.sessions} aktive Sitzungen.`, `${data.sessions} active sessions.`)}{" "}
        {t(`Inaktiv heißt: ${INACTIVE_DAYS} Tage oder länger ohne Anmeldung.`, `Inactive means: ${INACTIVE_DAYS} days or more without signing in.`)}
      </AdminStatus>
      <section className="admin-users" aria-labelledby="admin-users-title">
        <header className="admin-users-head">
          <h2 id="admin-users-title">
            {t("Benutzer", "Users")} <span className="muted">· {data.users.length}</span>
          </h2>
          <div className="admin-users-tools">
            <span className="admin-search">
              <MagnifyingGlass size={16} aria-hidden />
              <input
                type="search"
                aria-label={t("Benutzer suchen", "Search users")}
                placeholder={t("Name oder E-Mail suchen …", "Search name or email …")}
                value={query}
                onChange={(e) => changeQuery(e.target.value)}
              />
            </span>
          </div>
          {/* Buttons, not a select: one tap on phones, and the system picker
              of some phones did not pass the choice on. */}
          <div className="admin-user-filters" role="group" aria-label={t("Nach Status filtern", "Filter by status")}>
            {(
              [
                ["all", t("Alle", "All"), data.users.length],
                ["here", t("Gerade da", "Here now"), here],
                ["active", t("Aktiv", "Active"), count("active")],
                ["inactive", t("Inaktiv", "Inactive"), inactive],
                ["disabled", t("Deaktiviert", "Disabled"), disabled],
                ["admins", t("Admins", "Admins"), count("admins")],
              ] as [Filter, string, number][]
            ).map(([key, label, n]) => (
              <button key={key} type="button" className={`admin-user-filter${filter === key ? " on" : ""}`} aria-pressed={filter === key} onClick={() => changeFilter(key)}>
                {key === "here" && <i className="presence-dot" aria-hidden="true" />}
                {label}
                <span>{n}</span>
              </button>
            ))}
          </div>
          {/* Phones have no column headers: the order is chosen here. */}
          <div className="ux-sort-bar">
            <label className="ux-sort-label" htmlFor="admin-users-sort">
              {t("Sortieren nach", "Sort by")}
            </label>
            <Select id="admin-users-sort" value={sort.key} onChange={(e) => changeSort({ key: e.target.value as SortKey, dir: FIRST_DIR[e.target.value as SortKey] })}>
              {columns.map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </Select>
            <button
              type="button"
              className="icon-button"
              aria-label={sort.dir === "asc" ? t("Aufsteigend – absteigend sortieren", "Ascending – sort descending") : t("Absteigend – aufsteigend sortieren", "Descending – sort ascending")}
              title={sort.dir === "asc" ? t("Aufsteigend", "Ascending") : t("Absteigend", "Descending")}
              onClick={() => changeSort({ key: sort.key, dir: sort.dir === "asc" ? "desc" : "asc" })}
            >
              {sort.dir === "asc" ? <ArrowUp size={16} aria-hidden /> : <ArrowDown size={16} aria-hidden />}
            </button>
          </div>
        </header>
        {chosen.length > 0 && (
          <div className="admin-bulk" role="region" aria-label={t("Aktionen für die Auswahl", "Actions for the selection")}>
            <strong>{chosen.length === 1 ? t("1 ausgewählt", "1 selected") : t(`${chosen.length} ausgewählt`, `${chosen.length} selected`)}</strong>
            <button type="button" className="button" disabled={bulk} onClick={() => void runBulk((u) => ({ action: "admin.revoke", userId: u.id }))}>
              {t("Sitzungen beenden", "End sessions")}
            </button>
            {chosen.some((u) => u.disabled) && (
              <button type="button" className="button" disabled={bulk} onClick={() => void runBulk((u) => (u.disabled ? { action: "admin.user", userId: u.id, disabled: false } : null))}>
                {t("Entsperren", "Unblock")}
              </button>
            )}
            {chosen.some((u) => !u.disabled) && (
              <button
                type="button"
                className="button danger"
                disabled={bulk}
                onClick={() => {
                  const n = chosen.filter((u) => !u.disabled).length;
                  if (confirm(t(`${n} Konten sperren? Ihre Sitzungen enden, sie können sich nicht mehr anmelden.`, `Block ${n} accounts? Their sessions end and they can no longer sign in.`)))
                    void runBulk((u) =>
                      u.disabled
                        ? null
                        : {
                            action: "admin.user",
                            userId: u.id,
                            disabled: true,
                          },
                    );
                }}
              >
                {t("Sperren", "Block||account")}
              </button>
            )}
            <button type="button" className="button" disabled={bulk} onClick={() => setSelected(new Set())}>
              {t("Auswahl aufheben", "Clear selection")}
            </button>
          </div>
        )}
        {shown.length === 0 ? (
          <EmptyState icon={<Users size={18} />} title={t("Keine Konten gefunden", "No accounts found")}>
            {t("Ändere die Suche oder den Status-Filter.", "Change the search or the status filter.")}
          </EmptyState>
        ) : (
          <>
            <div className="ux-scroll" ref={scroll.ref} data-start={scroll.start || undefined} data-end={scroll.end || undefined}>
              <table className="admin-user-table ux-table" aria-label={t("Benutzer", "Users")} aria-rowcount={shown.length + 1}>
                <thead>
                  <tr>
                    <th scope="col" className="check">
                      <input
                        type="checkbox"
                        aria-label={t("Alle angezeigten auswählen", "Select all shown")}
                        checked={allRows}
                        ref={(el) => {
                          if (el) el.indeterminate = someRows;
                        }}
                        onChange={(e) => setSelected(e.target.checked ? new Set([...selected, ...rows.map((u) => u.id)]) : new Set([...selected].filter((id) => !rows.some((u) => u.id === id))))}
                      />
                    </th>
                    {columns.map(([key, label, cls]) => {
                      const on = sort.key === key;
                      const Icon = !on ? CaretUpDown : sort.dir === "asc" ? CaretUp : CaretDown;
                      return (
                        <th key={key} scope="col" className={`${cls || key}${on ? " sorted" : ""}`} aria-sort={on ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}>
                          <button type="button" className="ux-sort" onClick={() => sortBy(key)}>
                            {label}
                            <Icon size={11} weight="bold" aria-hidden className="ux-sort-ind" />
                          </button>
                        </th>
                      );
                    })}
                    <th scope="col" className="ux-menu">
                      <span className="sr-only">{t("Aktionen", "Actions")}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((u, i) => (
                    <UserRow
                      key={u.id}
                      index={first + i + 2}
                      user={u}
                      local={local[u.id]}
                      admin={isAdmin(u.id)}
                      usage={usages.get(u.id)}
                      state={states.get(u.id)!}
                      activity={activityOf(u)}
                      now={liveNow}
                      selected={selected.has(u.id)}
                      opened={open === u.id}
                      onSelect={(on) => toggle(u.id, on)}
                      onOpen={() => setOpen(u.id)}
                      onSignOut={() => void signOut(u)}
                      onBlock={() => (u.disabled ? void act({ action: "admin.user", userId: u.id, disabled: false }) : block(u))}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            <Pager total={shown.length} first={first} shown={rows.length} page={current} pages={pages} perPage={perPage} onPage={setPage} onPerPage={(n) => (setPerPage(n), setPage(1))} />
          </>
        )}
      </section>
      {person && <UserDrawer key={person.id} user={person} data={data} state={states.get(person.id)!} activity={activityOf(person)} now={liveNow} onClose={() => setOpen(null)} />}
    </>
  );
}

// "1–25 von 112", the pages and the page size.
function Pager({ total, first, shown, page, pages, perPage, onPage, onPerPage }: { total: number; first: number; shown: number; page: number; pages: number; perPage: number; onPage: (p: number) => void; onPerPage: (n: number) => void }) {
  const t = useT();
  const from = (first + 1).toLocaleString(LOCALE_TAG),
    to = (first + shown).toLocaleString(LOCALE_TAG),
    all = total.toLocaleString(LOCALE_TAG);
  return (
    <footer className="ux-pager">
      <span className="ux-pager-count muted" aria-live="polite">
        {t(`${from}–${to} von ${all}`, `${from}–${to} of ${all}`)}
      </span>
      {pages > 1 && (
        <nav className="ux-pages" aria-label={t("Seiten", "Pages")}>
          <button type="button" className="icon-button" aria-label={t("Vorherige Seite", "Previous page")} disabled={page <= 1} onClick={() => onPage(page - 1)}>
            <CaretLeft size={14} aria-hidden className="ux-flip" />
          </button>
          {pageList(page, pages).map((p, i) =>
            p === null ? (
              <span key={`gap${i}`} className="ux-page-gap" aria-hidden>
                …
              </span>
            ) : (
              <button
                key={p}
                type="button"
                className={`ux-page${p === page ? " on" : ""}`}
                aria-current={p === page ? "page" : undefined}
                aria-label={t(`Seite ${p}`, `Page ${p}`)}
                onClick={() => onPage(p)}
              >
                {p}
              </button>
            ),
          )}
          <button type="button" className="icon-button" aria-label={t("Nächste Seite", "Next page")} disabled={page >= pages} onClick={() => onPage(page + 1)}>
            <CaretRight size={14} aria-hidden className="ux-flip" />
          </button>
        </nav>
      )}
      <Select className="ux-per-page" aria-label={t("Einträge pro Seite", "Rows per page")} value={String(perPage)} onChange={(e) => onPerPage(Number(e.target.value))}>
        {PAGE_SIZES.map((n) => (
          <option key={n} value={n}>
            {t(`${n} pro Seite`, `${n} per page`)}
          </option>
        ))}
      </Select>
    </footer>
  );
}

// The table scrolls sideways; a shadow shows on the side with more columns
// (data-start: scrolled away from the start, data-end: more at the end).
function useEdgeShadows() {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [edges, setEdges] = useState({ start: false, end: false });
  useEffect(() => {
    if (!el) return;
    const measure = () => {
      // Negative in right-to-left layouts.
      const left = Math.abs(el.scrollLeft);
      const next = { start: left > 1, end: left + el.clientWidth < el.scrollWidth - 1 };
      setEdges((prev) => (prev.start === next.start && prev.end === next.end ? prev : next));
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    const table = el.firstElementChild;
    if (table) ro?.observe(table);
    return () => {
      el.removeEventListener("scroll", measure);
      ro?.disconnect();
    };
  }, [el]);
  return { ref: setEl, ...edges };
}

// Who is here, refreshed every 30 seconds while the list is open.
function useLiveActivity() {
  const [live, setLive] = useState<{ now: number; users: Map<string, UserActivity> }>({ now: 0, users: new Map() });
  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const res = await fetch("/api/admin/activity", { cache: "no-store" });
        if (!res.ok || stop) return;
        const body = (await res.json()) as { now: number; users: UserActivity[] };
        // The server's clock, moved to this moment.
        const skew = Date.now() - body.now;
        setLive({
          now: Date.now(),
          users: new Map(body.users.map((a) => [a.id, { ...a, openAt: a.openAt && a.openAt + skew, activeAt: a.activeAt && a.activeAt + skew }])),
        });
      } catch {}
    };
    // The first time shortly after opening, so this tab's own ping is in.
    const first = window.setTimeout(load, 1500);
    const timer = window.setInterval(load, 30_000);
    return () => {
      stop = true;
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, []);
  return live;
}

// Here and in use, open but idle (and for how long), or when last here.
// Short (in the table): an idle account shows when it was last in use.
function Presence({ activity, now, long }: { activity: Activity; now: number; long?: boolean }) {
  const t = useT();
  const state = activityState(activity, now);
  const idle = activity.activeAt ? duration(Math.max(60, (now - activity.activeAt) / 1000), t) : null;
  const idleText = idle ? t(`Geöffnet · inaktiv seit ${idle}`, `Open · idle for ${idle}`) : t("Geöffnet · inaktiv", "Open · idle");
  const text =
    state === "active"
      ? t("Jetzt aktiv", "Active now")
      : state === "idle"
        ? long || !activity.activeAt
          ? idleText
          : ago(activity.activeAt, t, now)
        : state === "offline"
          ? activity.activeAt
            ? long
              ? t(`Zuletzt aktiv ${ago(activity.activeAt, t, now)}`, `Last active ${ago(activity.activeAt, t, now)}`)
              : ago(activity.activeAt, t, now)
            : t("offline", "offline")
          : t("noch nie da", "never here");
  return (
    <span className={`presence presence-${state}`} title={state === "idle" && !long ? idleText : undefined}>
      <i aria-hidden="true" />
      {text}
    </span>
  );
}

// Inactive for too long: deleted on this day unless the person comes back
// (or an admin enables a blocked account). Short in the table.
function DeletionBadge({ due, short }: { due?: number | null; short?: boolean }) {
  const t = useT();
  if (!due) return null;
  const date = new Date(due).toLocaleDateString(LOCALE_TAG, { day: "numeric", month: "short" });
  const long = t(`Wird am ${date} gelöscht`, `Deleted on ${date}`);
  return (
    <StatusBadge tone={short ? "warn" : "error"} title={short ? long : undefined}>
      {short ? t(`Löschung ${date}`, `Deletion ${date}`) : long}
    </StatusBadge>
  );
}

function StateBadge({ state }: { state: State }) {
  const t = useT();
  const tone: Tone = state.key === "disabled" ? "error" : state.key === "inactive" ? "off" : "ok";
  return (
    <StatusBadge tone={tone}>
      {state.key === "disabled" ? t("Deaktiviert", "Disabled") : state.key === "inactive" ? t(`Inaktiv · ${state.days} T.`, `Inactive · ${state.days} d`) : t("Aktiv", "Active")}
    </StatusBadge>
  );
}

// How the account signs in: e-mail and password (with passkeys and a second
// factor), or through the identity provider / directory.
function signIn(local: Local | undefined, t: (de: string, en: string) => string, sso = 0, ldap = false) {
  // SSO identities (#101): a local account may be connected to SSO too.
  const ssoText = sso ? (sso === 1 ? "SSO" : `SSO × ${sso}`) : null;
  if (!local) return [ssoText, ldap ? "LDAP" : null].filter(Boolean).join(" · ") || t("SSO / Verzeichnis", "SSO / directory");
  return [
    local.password === false ? null : t("E-Mail + Passwort", "E-mail + password"),
    ssoText,
    ldap ? "LDAP" : null,
    local.passkeys ? (local.passkeys === 1 ? "Passkey" : `${local.passkeys} Passkeys`) : null,
    local.totp ? "2FA" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

// Used storage against the limit: a thin bar, amber from 75 %, red from 90 %.
function StorageBar({ usage, wide }: { usage: Usage; wide?: boolean }) {
  const limit = usage.effective.storageMb * 1024 * 1024;
  const share = limit ? Math.min(1, usage.bytes / limit) : 0;
  const tone = share >= 0.9 ? " high" : share >= 0.75 ? " mid" : "";
  return (
    <span className={`ux-bar${wide ? " wide" : ""}${tone}`} aria-hidden>
      <b style={{ width: `${limit ? Math.max(share * 100, usage.bytes ? 2 : 0) : usage.bytes ? 2 : 0}%` }} />
    </span>
  );
}

function UserRow({
  index,
  user: u,
  local,
  admin,
  usage,
  state,
  activity,
  now,
  selected,
  opened,
  onSelect,
  onOpen,
  onSignOut,
  onBlock,
}: {
  index: number;
  user: User;
  local?: Local;
  admin: boolean;
  usage?: Usage;
  state: State;
  activity: Activity;
  now: number;
  selected: boolean;
  opened: boolean;
  onSelect: (on: boolean) => void;
  onOpen: () => void;
  onSignOut: () => void;
  onBlock: () => void;
}) {
  const t = useT();
  const all = usage?.memberOf?.length ?? 0,
    own = usage?.workspaces ?? 0;
  const wsTitle =
    (all === 1 ? t("1 Arbeitsbereich", "1 workspace") : t(`${all} Arbeitsbereiche`, `${all} workspaces`)) +
    (own ? ` · ${own === 1 ? t("1 eigener", "1 own") : t(`${own} eigene`, `${own} own`)}` : "");
  return (
    <tr
      className={`user-row ux-row${u.disabled ? " is-disabled" : ""}${selected ? " is-selected" : ""}${opened ? " is-open" : ""}`}
      aria-rowindex={index}
      onClick={(e) => {
        // The whole row opens the panel, except its own controls.
        if ((e.target as HTMLElement).closest("input, button, a, label, [role='menuitem']")) return;
        if (window.getSelection()?.toString()) return;
        onOpen();
      }}
    >
      <td className="check">
        <input type="checkbox" aria-label={t(`${u.name} auswählen`, `Select ${u.name}`)} checked={selected} onChange={(e) => onSelect(e.target.checked)} />
      </td>
      <td className="who">
        <div className="admin-who">
          <Avatar name={u.name} userId={u.id} />
          <span>
            <strong>
              <button type="button" className="ux-name" aria-haspopup="dialog" onClick={onOpen} title={u.name}>
                <span>{u.name}</span>
              </button>
              {admin && <StatusBadge tone="info">{t("Admin", "Admin")}</StatusBadge>}
              {local && !local.verified && <StatusBadge tone="warn">{t("E-Mail unbestätigt", "E-mail unconfirmed")}</StatusBadge>}
            </strong>
            <small title={u.email}>{u.email}</small>
          </span>
        </div>
      </td>
      <td className="state">{u.deletion_due_at && !u.disabled ? <DeletionBadge due={u.deletion_due_at} short /> : <StateBadge state={state} />}</td>
      <td className="end ux-num" title={wsTitle}>
        <Stack size={14} aria-hidden className="ux-card-icon" />
        {all}
        <span className="ux-card-label">{all === 1 ? t("Arbeitsbereich", "workspace") : t("Arbeitsbereiche", "workspaces")}</span>
      </td>
      <td className="ux-storage">
        {usage ? (
          <>
            <StorageBar usage={usage} />
            <span className="ux-storage-text">
              {sizeText(usage.bytes)} <span className="muted">/ {limitText(usage.effective.storageMb)}</span>
            </span>
          </>
        ) : (
          "–"
        )}
      </td>
      <td className="last">
        <Presence activity={activity} now={now} />
      </td>
      <td className="ux-created">{dateText(createdAt(u))}</td>
      <td className="ux-menu">
        <Dropdown.Root modal={false}>
          <Dropdown.Trigger className="icon-button" aria-label={t(`Aktionen für ${u.name}`, `Actions for ${u.name}`)}>
            <DotsThree size={18} weight="bold" />
          </Dropdown.Trigger>
          <Dropdown.Portal>
            <Dropdown.Content className="dropdown" align="end">
              <Dropdown.Item className="dropdown-item" onSelect={onOpen}>
                {t("Details und Einstellungen", "Details and settings")}
              </Dropdown.Item>
              <Dropdown.Item className="dropdown-item" onSelect={onSignOut}>
                <SignOut size={16} aria-hidden /> {t("Überall abmelden", "Sign out everywhere")}
              </Dropdown.Item>
              <Dropdown.Separator className="dropdown-separator" />
              <Dropdown.Item className={`dropdown-item${u.disabled ? "" : " danger"}`} onSelect={onBlock}>
                {u.disabled ? <LockOpen size={16} aria-hidden /> : <Prohibit size={16} aria-hidden />} {u.disabled ? t("Entsperren", "Unblock") : t("Sperren …", "Block …")}
              </Dropdown.Item>
            </Dropdown.Content>
          </Dropdown.Portal>
        </Dropdown.Root>
      </td>
    </tr>
  );
}

// One row of the panel: what it is (with a hint) and its control.
function PanelRow({ label, hint, children, htmlFor }: { label: string; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="ux-row-item">
      <span className="ux-row-text">
        {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <strong>{label}</strong>}
        {hint && <small>{hint}</small>}
      </span>
      <span className="ux-row-control">{children}</span>
    </div>
  );
}

// One account in a side panel (a bottom sheet on phones): facts, storage,
// role, limits, sessions and password; further settings folded; blocking
// and deleting at the end.
function UserDrawer({ user: u, data, state, activity, now, onClose }: { user: User; data: AdminData; state: State; activity: Activity; now: number; onClose: () => void }) {
  const t = useT();
  const { act, mutate, load } = useAdminData();
  const local = data.localAccounts?.[u.id];
  const identities = (data.identities || []).filter((i) => i.user_id === u.id);
  const ldap = !!data.ldapAccounts?.includes(u.id);
  const [merging, setMerging] = useState(false);
  const admin = !!local?.admin || !!data.adminIds?.includes(u.id);
  const usage = data.userUsage?.find((x) => x.id === u.id);
  const ai = data.aiPolicy?.enabled && data.aiPolicy.access === "selected" ? { allowed: data.aiPolicy.allowed.includes(u.id) } : null;
  const sessions = data.userSessions?.[u.id] ?? 0;
  const names = new Map(data.workspaces.map((w) => [w.id, w.name]));
  const memberOf = (usage?.memberOf || []).map((id) => names.get(id)).filter((n): n is string => !!n);
  const [resetLink, setResetLink] = useState("");
  const [note, setNote] = useState("");
  const [plan, setPlan] = useState<{
    removed: { name: string }[];
    handedOver: { name: string; to: string }[];
    kept: { name: string; disabled: number }[];
    privateSpaces: number;
  } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [limits, setLimits] = useState(usage?.limits || {});
  const [saveStatus, save] = useSaveState();
  const clean = (l: object) =>
    JSON.stringify(
      Object.entries(l)
        .filter(([, v]) => v !== null && v !== undefined)
        .sort(),
    );
  const limitsChanged = clean(limits) !== clean(usage?.limits || {});
  const defaults = {
    storage: data.settings.defaultUserStorageMb ? `${data.settings.defaultUserStorageMb} MB` : t("unbegrenzt", "unlimited"),
    workspaces: data.settings.defaultUserWorkspaces ? String(data.settings.defaultUserWorkspaces) : t("unbegrenzt", "unlimited"),
    upload: `${data.settings.maxUploadMb} MB`,
    ai: data.settings.defaultUserAi === false ? t("aus", "off") : t("an", "on"),
    aiTokens: data.settings.defaultUserAiTokensPerMonth ? data.settings.defaultUserAiTokensPerMonth.toLocaleString(LOCALE_TAG) : t("unbegrenzt", "unlimited"),
  };
  const run = async (body: Record<string, unknown>, done?: string) => {
    setNote("");
    const result = await act(body);
    if (result !== undefined && done) setNote(done);
    return result;
  };
  const more = [t("Grenzen", "limits"), ai ? t("KI-Zugang", "AI access") : null, local?.totp ? "2FA" : null, t("Anmeldemethoden", "sign-in methods"), t("Zusammenführen", "merging")].filter(Boolean).join(", ");
  const storageMb = usage?.effective.storageMb ?? 0;
  return (
    <Modal open onClose={onClose} title={u.name} className="modal-side ux-drawer" sheet>
      <header className="ux-drawer-head">
        <Avatar name={u.name} userId={u.id} />
        <span className="ux-drawer-who">
          <strong aria-hidden>{u.name}</strong>
          <small>{u.email}</small>
          <span className="admin-user-badges">
            <StateBadge state={state} />
            {admin && <StatusBadge tone="info">{t("Admin", "Admin")}</StatusBadge>}
            {local && !local.verified && <StatusBadge tone="warn">{t("E-Mail unbestätigt", "E-mail unconfirmed")}</StatusBadge>}
            <DeletionBadge due={u.deletion_due_at} />
            <Presence activity={activity} now={now} long />
          </span>
        </span>
      </header>
      {note && (
        <p className="admin-user-note" role="status">
          {note}
        </p>
      )}
      <dl className="ux-facts">
        <div>
          <dt>{t("Arbeitsbereiche", "Workspaces")}</dt>
          <dd>
            {memberOf.length || usage?.memberOf?.length || 0}
            {memberOf.length > 0 && <span className="muted"> · {memberOf.join(", ")}</span>}
            {!!usage?.workspaces && <small className="ux-fact-note">{usage.workspaces === 1 ? t("davon 1 eigener", "1 of them own") : t(`davon ${usage.workspaces} eigene`, `${usage.workspaces} of them own`)}</small>}
          </dd>
        </div>
        <div>
          <dt>{t("Zuletzt aktiv", "Last active")}</dt>
          <dd>
            {activity.activeAt ? ago(activity.activeAt, t, now) : t("noch nie", "never")}
            {u.last_login_at ? <small className="ux-fact-note">{t(`angemeldet ${ago(u.last_login_at, t, now)}`, `signed in ${ago(u.last_login_at, t, now)}`)}</small> : null}
          </dd>
        </div>
        <div>
          <dt>{t("Erstellt", "Created")}</dt>
          <dd>{dateText(createdAt(u))}</dd>
        </div>
        <div>
          <dt>{t("Anmeldung", "Sign-in")}</dt>
          <dd>{signIn(local, t, identities.length, ldap)}</dd>
        </div>
      </dl>
      {usage && (
        <section className="ux-block" aria-label={t("Speicher", "Storage")}>
          <div className="ux-usage">
            <span>{t("Speicher", "Storage")}</span>
            <strong>
              {sizeText(usage.bytes)} <span className="muted">/ {storageMb ? limitText(storageMb) : t("unbegrenzt", "unlimited")}</span>
            </strong>
          </div>
          <StorageBar usage={usage} wide />
        </section>
      )}
      <form
        className="ux-block ux-rows"
        aria-label={t(`Einstellungen für ${u.name}`, `Settings for ${u.name}`)}
        onSubmit={(e) => {
          e.preventDefault();
          void save(async () => {
            await mutate({ action: "admin.userLimits", userId: u.id, limits });
            await load();
          });
        }}
      >
        <PanelRow
          label={t("Rolle", "Role")}
          htmlFor={local ? `role-${u.id}` : undefined}
          hint={local ? t("Admins verwalten die ganze Instanz.", "Admins manage the whole instance.") : t(`Vergeben über die Gruppe „${data.adminGroup}“ der Anmeldung.`, `Given by the sign-in group “${data.adminGroup}”.`)}
        >
          {local ? (
            <Select id={`role-${u.id}`} className="ux-select" value={local.admin ? "admin" : "member"} onChange={(e) => void run({ action: "admin.localAdmin", userId: u.id, admin: e.target.value === "admin" })}>
              <option value="member">{t("Mitglied", "Member")}</option>
              <option value="admin">{t("Admin", "Admin")}</option>
            </Select>
          ) : (
            <StatusBadge tone={admin ? "info" : "off"}>{admin ? t("Admin", "Admin") : t("Mitglied", "Member")}</StatusBadge>
          )}
        </PanelRow>
        <PanelRow label={t("Speicherlimit", "Storage limit")} htmlFor={`limit-storage-${u.id}`} hint={t(`Standard der Instanz: ${defaults.storage}`, `Instance default: ${defaults.storage}`)}>
          <NumberField id={`limit-storage-${u.id}`} label={t(`Speicher für ${u.name}`, `Storage for ${u.name}`)} value={limits.storageMb} unit="MB" placeholder={defaults.storage} onChange={(storageMb) => setLimits({ ...limits, storageMb })} />
        </PanelRow>
        <PanelRow
          label={t("Sitzungen", "Sessions")}
          hint={sessions === 0 ? t("Nirgends angemeldet", "Not signed in anywhere") : sessions === 1 ? t("1 Gerät angemeldet", "Signed in on 1 device") : t(`${sessions} Geräte angemeldet`, `Signed in on ${sessions} devices`)}
        >
          <button type="button" className="button compact" onClick={() => void run({ action: "admin.revoke", userId: u.id }, t("Alle Sitzungen beendet.", "All sessions ended."))}>
            <SignOut size={15} aria-hidden /> {t("Abmelden", "Sign out")}
          </button>
        </PanelRow>
        {local && (
          <div className={`ux-row-item${resetLink ? " wide" : ""}`}>
            <span className="ux-row-text">
              <strong>{t("Passwort", "Password")}</strong>
              <small>{t("Link zum Zurücksetzen, 2 Std. gültig – zum Weitergeben.", "Reset link, valid for 2 h – to hand over.")}</small>
            </span>
            {resetLink ? (
              <input className="ux-reset-link" readOnly aria-label={t(`Link zum Zurücksetzen für ${u.name}`, `Reset link for ${u.name}`)} value={resetLink} onFocus={(e) => e.currentTarget.select()} />
            ) : (
              <button
                type="button"
                className="button compact"
                onClick={async () => {
                  const result = (await act({ action: "admin.resetLink", userId: u.id })) as { url?: string } | undefined;
                  if (result?.url) setResetLink(result.url);
                }}
              >
                <Key size={15} aria-hidden /> {t("Link erstellen", "Create link")}
              </button>
            )}
          </div>
        )}
        {local && !local.verified && (
          <PanelRow label={t("E-Mail-Adresse", "E-mail address")} hint={t("Die Person hat den Link aus der Bestätigungs-E-Mail noch nicht geöffnet.", "The person has not opened the link from the confirmation e-mail yet.")}>
            <button type="button" className="button compact" onClick={() => void run({ action: "admin.confirmEmail", userId: u.id })}>
              {t("Als bestätigt markieren", "Mark as confirmed")}
            </button>
          </PanelRow>
        )}
        <details className="ux-more">
          <summary>
            <CaretRight size={12} aria-hidden className="ux-more-caret ux-flip" />
            {t(`Weitere: ${more}`, `More: ${more}`)}
          </summary>
          <PanelRow label={t("Eigene Arbeitsbereiche", "Own workspaces")} htmlFor={`limit-workspaces-${u.id}`} hint={t(`Standard: ${defaults.workspaces}`, `Default: ${defaults.workspaces}`)}>
            <NumberField
              id={`limit-workspaces-${u.id}`}
              label={t(`Eigene Arbeitsbereiche für ${u.name}`, `Own workspaces for ${u.name}`)}
              value={limits.workspaces}
              max={10000}
              placeholder={defaults.workspaces}
              onChange={(workspaces) => setLimits({ ...limits, workspaces })}
            />
          </PanelRow>
          <PanelRow label={t("Größte Datei", "Largest file")} htmlFor={`limit-upload-${u.id}`} hint={t(`Standard: ${defaults.upload}`, `Default: ${defaults.upload}`)}>
            <NumberField
              id={`limit-upload-${u.id}`}
              label={t(`Größte Datei für ${u.name}`, `Largest file for ${u.name}`)}
              value={limits.uploadMb}
              min={1}
              max={1024}
              unit="MB"
              placeholder={defaults.upload}
              onChange={(uploadMb) => setLimits({ ...limits, uploadMb })}
            />
          </PanelRow>
          <PanelRow label={t("KI", "AI")} htmlFor={`limit-ai-${u.id}`} hint={t(`Standard: ${defaults.ai}`, `Default: ${defaults.ai}`)}>
            <Select
              id={`limit-ai-${u.id}`}
              className="ux-select"
              value={limits.ai === true ? "on" : limits.ai === false ? "off" : ""}
              onChange={(e) => setLimits({ ...limits, ai: e.target.value === "" ? null : e.target.value === "on" })}
            >
              <option value="">{t(`Standard (${defaults.ai})`, `Default (${defaults.ai})`)}</option>
              <option value="on">{t("an", "on")}</option>
              <option value="off">{t("aus", "off")}</option>
            </Select>
          </PanelRow>
          <PanelRow
            label={t("KI-Tokens je Monat", "AI tokens per month")}
            htmlFor={`limit-ai-tokens-${u.id}`}
            hint={t(`Standard: ${defaults.aiTokens} · diesen Monat ${(usage?.aiTokens ?? 0).toLocaleString(LOCALE_TAG)}`, `Default: ${defaults.aiTokens} · this month ${(usage?.aiTokens ?? 0).toLocaleString(LOCALE_TAG)}`)}
          >
            <NumberField
              id={`limit-ai-tokens-${u.id}`}
              label={t(`KI-Tokens je Monat für ${u.name}`, `AI tokens per month for ${u.name}`)}
              value={limits.aiTokensPerMonth}
              max={1_000_000_000}
              placeholder={defaults.aiTokens}
              onChange={(aiTokensPerMonth) => setLimits({ ...limits, aiTokensPerMonth })}
            />
          </PanelRow>
          <p className="ux-more-note muted">{t("Leer = Standard der Instanz, 0 = unbegrenzt. Für Admins gelten keine Grenzen.", "Empty = instance default, 0 = unlimited. Admins are not limited.")}</p>
          {ai && (
            <PanelRow label={t("KI-Funktionen", "AI features")} hint={t("Nur ausgewählte Personen dürfen KI nutzen (Administration → KI).", "Only selected people may use AI (Administration → AI).")}>
              <AiUserSwitch userId={u.id} name={u.name} allowed={ai.allowed} onChange={() => void load()} />
            </PanelRow>
          )}
          {local?.totp && (
            <PanelRow label={t("Zwei-Faktor-Anmeldung", "Two-factor sign-in")} hint={t("Etwa bei verlorenem Telefon. Die Person wird per E-Mail informiert.", "E.g. for a lost phone. The person is told by e-mail.")}>
              <button
                type="button"
                className="button compact"
                onClick={() => {
                  if (
                    confirm(
                      t(
                        `Authenticator-App für ${u.name} ausschalten? Danach meldet sich ${u.name} nur mit Passwort (oder Passkey) an und kann sie neu einrichten.`,
                        `Turn off the authenticator app for ${u.name}? ${u.name} then signs in with the password (or a passkey) and can set it up again.`,
                      ),
                    )
                  )
                    void run({ action: "admin.twoFactorReset", userId: u.id }, t("Zwei-Faktor zurückgesetzt.", "Two-factor reset."));
                }}
              >
                {t("Zurücksetzen", "Reset")}
              </button>
            </PanelRow>
          )}
          <PanelRow
            label={t("Anmeldemethoden", "Sign-in methods")}
            hint={t("Verbinden und trennen kann die Person SSO-Konten selbst unter Einstellungen → Konto.", "The person connects and disconnects SSO identities under Settings → Account.")}
          >
            <span className="admin-user-badges">
              <StatusBadge tone={local && local.password !== false ? "ok" : "off"}>{local ? (local.password === false ? t("Passwort entfernt", "Password removed") : t("Passwort", "Password")) : t("Kein Passwort", "No password")}</StatusBadge>
              {ldap && <StatusBadge tone="ok">LDAP</StatusBadge>}
              <StatusBadge tone={identities.length ? "ok" : "off"}>{identities.length ? `SSO × ${identities.length}` : t("Kein SSO", "No SSO")}</StatusBadge>
            </span>
          </PanelRow>
          {identities.length > 0 && (
            <ul className="passkey-list identity-list ux-identities" aria-label={t(`SSO-Konten von ${u.name}`, `SSO identities of ${u.name}`)}>
              {identities.map((i) => (
                <li key={i.id}>
                  <IdentificationCard size={18} aria-hidden />
                  <span>
                    {i.email || hostOf(i.issuer)}
                    <small>
                      {i.issuer} · {t("verbunden", "connected")} {ago(i.created_at, t)}
                      {i.last_used_at ? ` · ${t("zuletzt benutzt", "last used")} ${ago(i.last_used_at, t)}` : ""}
                    </small>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <PanelRow
            label={t("Konten zusammenführen", "Merge accounts")}
            hint={t("Zwei Konten derselben Person werden eines. Vorher siehst du, was übernommen wird.", "Two accounts of the same person become one. You see first what is taken over.")}
          >
            <button type="button" className="button compact danger" onClick={() => setMerging(true)}>
              <ArrowsMerge size={15} aria-hidden /> {t("Zusammenführen …", "Merge …")}
            </button>
          </PanelRow>
        </details>
        {(limitsChanged || saveStatus.state !== "idle") && (
          <div className="ux-save">
            <SaveState status={saveStatus} />
            <button className="button primary compact" disabled={!limitsChanged || saveStatus.state === "saving"}>
              {t("Grenzen speichern", "Save limits")}
            </button>
          </div>
        )}
      </form>
      <section className="ux-block ux-danger" aria-label={t("Sperren und Löschen", "Blocking and deleting")}>
        <PanelRow
          label={u.disabled ? t("Konto entsperren", "Unblock account") : t("Konto sperren", "Block account")}
          hint={u.disabled ? t("Die Person kann sich wieder anmelden.", "The person can sign in again.") : t("Beendet alle Sitzungen, lässt sich rückgängig machen.", "Ends all sessions, can be undone.")}
        >
          <button type="button" className="button compact" onClick={() => void act({ action: "admin.user", userId: u.id, disabled: !u.disabled })}>
            {u.disabled ? <LockOpen size={15} aria-hidden /> : <Prohibit size={15} aria-hidden />} {u.disabled ? t("Entsperren", "Unblock") : t("Sperren", "Block||account")}
          </button>
        </PanelRow>
        <PanelRow
          label={t("Konto löschen", "Delete account")}
          hint={u.disabled ? t("Endgültig – vorher siehst du, was mit den Arbeitsbereichen geschieht.", "Permanent – you see first what happens to the workspaces.") : t("Erst möglich, wenn das Konto gesperrt ist.", "Only possible once the account is blocked.")}
        >
          <button
            type="button"
            className="button compact danger"
            disabled={!u.disabled}
            onClick={async () => {
              const result = (await act({ action: "admin.deletePlan", userId: u.id })) as typeof plan;
              if (result) setPlan(result);
            }}
          >
            <Trash size={15} aria-hidden /> {t("Löschen …", "Delete …")}
          </button>
        </PanelRow>
      </section>
      {merging && <MergeDialog user={u} users={data.users} onClose={() => setMerging(false)} onMerged={onClose} />}
      <Modal open={!!plan} onClose={() => !deleting && setPlan(null)} title={t(`${u.name} löschen?`, `Delete ${u.name}?`)}>
        {plan && (
          <div className="delete-account">
            <p>{t("Das lässt sich nicht rückgängig machen.", "This cannot be undone.")}</p>
            <ul>
              <li>
                {t(
                  "Name, E-Mail-Adresse, Passwort, Passkeys, Sitzungen und persönliche Einstellungen werden gelöscht.",
                  "Name, e-mail address, password, passkeys, sessions and personal settings are deleted.",
                )}
              </li>
              {plan.removed.length > 0 && (
                <li>
                  {t(
                    "Diese Arbeitsbereiche hatten nur diese Person als Mitglied und werden mit allen Inhalten gelöscht:",
                    "These workspaces had only this person as a member and are deleted with all content:",
                  )}{" "}
                  <strong>{plan.removed.map((w) => w.name).join(", ")}</strong>
                </li>
              )}
              {plan.handedOver.map((w) => (
                <li key={w.name}>{t(`„${w.name}“ bekommt ${w.to} als Eigentümer.`, `“${w.name}” gets ${w.to} as owner.`)}</li>
              ))}
              {plan.kept.map((w) => (
                <li key={w.name}>
                  {w.disabled === 1
                    ? t(`„${w.name}“ bleibt erhalten – 1 deaktiviertes Mitglied.`, `“${w.name}” is kept – 1 deactivated member.`)
                    : t(`„${w.name}“ bleibt erhalten – ${w.disabled} deaktivierte Mitglieder.`, `“${w.name}” is kept – ${w.disabled} deactivated members.`)}
                </li>
              ))}
              {plan.privateSpaces > 0 && <li>{t(`${plan.privateSpaces} private Bereiche werden gelöscht.`, `${plan.privateSpaces} private spaces are deleted.`)}</li>}
              <li>
                {t(
                  "Beiträge in gemeinsamen Arbeitsbereichen (Seiten, Einträge, Kommentare, Dateien) bleiben und erscheinen als „Gelöschtes Konto“.",
                  "Contributions to shared workspaces (pages, records, comments, files) stay and appear as “Deleted account”.",
                )}
              </li>
            </ul>
            <div className="modal-actions">
              <button type="button" className="button" disabled={deleting} onClick={() => setPlan(null)}>
                {t("Abbrechen", "Cancel")}
              </button>
              <button
                type="button"
                className="button danger-solid"
                disabled={deleting}
                onClick={async () => {
                  setDeleting(true);
                  try {
                    if (await act({ action: "admin.deleteUser", userId: u.id })) {
                      setPlan(null);
                      onClose();
                    }
                  } finally {
                    setDeleting(false);
                  }
                }}
              >
                {deleting ? t("Löscht …", "Deleting …") : t("Endgültig löschen", "Delete permanently")}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </Modal>
  );
}

const hostOf = (issuer: string) => {
  try {
    return new URL(issuer).host;
  } catch {
    return issuer;
  }
};

// Merging two accounts of one person (#101, lib/account-merge.ts): pick the
// other account and which one stays, see what moves, then merge.
function MergeDialog({ user: u, users, onClose, onMerged }: { user: User; users: User[]; onClose: () => void; onMerged: () => void }) {
  const t = useT();
  const { act, mutate, onError } = useAdminData();
  const [query, setQuery] = useState(""),
    [other, setOther] = useState<User | null>(null),
    // false: this account is merged into the other one (and deleted).
    [keepThis, setKeepThis] = useState(false),
    [preview, setPreview] = useState<MergePreview | null>(null),
    [busy, setBusy] = useState(false);
  const needle = query.trim().toLocaleLowerCase();
  const candidates = users
    .filter((x) => x.id !== u.id && (!needle || `${x.name} ${x.email}`.toLocaleLowerCase().includes(needle)))
    // The same address first: the likely duplicates.
    .sort((a, b) => Number(b.email.toLowerCase() === u.email.toLowerCase()) - Number(a.email.toLowerCase() === u.email.toLowerCase()))
    .slice(0, 8);
  const source = other && (keepThis ? other : u),
    target = other && (keepThis ? u : other);
  useEffect(() => {
    setPreview(null);
    if (!source || !target) return;
    let stop = false;
    mutate({ action: "admin.mergePlan", sourceId: source.id, targetId: target.id })
      .then((p) => !stop && setPreview(p as MergePreview))
      .catch((e) => !stop && onError((e as Error).message));
    return () => {
      stop = true;
    };
  }, [source?.id, target?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const s = preview?.summary;
  const line = (n: number | undefined, one: string, many: (k: number) => string) => (n ? (n === 1 ? one : many(n)) : null);
  const items = s
    ? [
        line(s.workspaces, t("1 Arbeitsbereich (die höhere Rolle bleibt)", "1 workspace (the higher role stays)"), (k) => t(`${k} Arbeitsbereiche (die höhere Rolle bleibt)`, `${k} workspaces (the higher role stays)`)),
        line(s.ownedPages, t("1 eigene Seite", "1 own page"), (k) => t(`${k} eigene Seiten`, `${k} own pages`)),
        line(s.ownedSpaces, t("1 eigener Bereich", "1 own space"), (k) => t(`${k} eigene Bereiche`, `${k} own spaces`)),
        line(s.groups, t("1 Gruppe", "1 group"), (k) => t(`${k} Gruppen`, `${k} groups`)),
        line(s.comments, t("1 Kommentar", "1 comment"), (k) => t(`${k} Kommentare`, `${k} comments`)),
        line(s.records, t("1 Eintrag mit dieser Person (Personen-Eigenschaft)", "1 record naming this person (person property)"), (k) => t(`${k} Einträge mit dieser Person (Personen-Eigenschaft)`, `${k} records naming this person (person property)`)),
        line(s.documents, t("1 Dokument mit Erwähnungen", "1 document with mentions"), (k) => t(`${k} Dokumente mit Erwähnungen`, `${k} documents with mentions`)),
        line(s.favorites, t("1 Favorit", "1 favourite"), (k) => t(`${k} Favoriten`, `${k} favourites`)),
        line(s.notifications, t("1 Benachrichtigung", "1 notification"), (k) => t(`${k} Benachrichtigungen`, `${k} notifications`)),
        line(s.identities, t("1 SSO-Konto", "1 SSO identity"), (k) => t(`${k} SSO-Konten`, `${k} SSO identities`)),
        line(s.passkeys, t("1 Passkey", "1 passkey"), (k) => t(`${k} Passkeys`, `${k} passkeys`)),
      ].filter(Boolean)
    : [];
  return (
    <Modal open onClose={() => !busy && onClose()} title={t(`${u.name} zusammenführen`, `Merge ${u.name}`)} className="merge-dialog" wide>
      <div className="merge-accounts">
        {!other ? (
          <>
            <p className="muted">{t("Mit welchem Konto derselben Person?", "With which account of the same person?")}</p>
            <span className="admin-search">
              <MagnifyingGlass size={16} aria-hidden />
              <input type="search" autoFocus aria-label={t("Konto suchen", "Search account")} placeholder={t("Name oder E-Mail suchen …", "Search name or email …")} value={query} onChange={(e) => setQuery(e.target.value)} />
            </span>
            <ul className="merge-candidates">
              {candidates.map((x) => (
                <li key={x.id}>
                  <button type="button" className="merge-candidate" onClick={() => setOther(x)}>
                    <Avatar name={x.name} userId={x.id} />
                    <span className="merge-candidate-text">
                      <strong>{x.name}</strong>
                      <small>{x.email}</small>
                    </span>
                    {x.email.toLowerCase() === u.email.toLowerCase() && <StatusBadge tone="info">{t("Gleiche E-Mail", "Same e-mail")}</StatusBadge>}
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <>
            <div className="merge-pair">
              <div>
                <small>{t("Wird übernommen und gelöscht", "Taken over and deleted")}</small>
                <strong>{source!.name}</strong>
                <span className="muted">{source!.email}</span>
              </div>
              <button type="button" className="icon-button" aria-label={t("Richtung tauschen", "Swap direction")} title={t("Richtung tauschen", "Swap direction")} onClick={() => setKeepThis(!keepThis)}>
                <ArrowsLeftRight size={18} />
              </button>
              <div>
                <small>{t("Bleibt bestehen", "Stays")}</small>
                <strong>{target!.name}</strong>
                <span className="muted">{target!.email}</span>
              </div>
            </div>
            {!preview ? (
              <p className="muted">{t("Lädt …", "Loading …")}</p>
            ) : (
              <>
                <p>{t(`Zu ${target!.name} wechselt:`, `Moving to ${target!.name}:`)}</p>
                <ul className="merge-summary">
                  {items.map((text) => (
                    <li key={text}>{text}</li>
                  ))}
                  <li>{t("Alles Weitere: Zuweisungen, Journal, Sammlungen, Seitenleiste, Webhooks, Kalender, Kontakte, Zeiterfassung und Verlauf.", "Everything else: assignments, journal, collections, sidebar, webhooks, calendars, contacts, time tracking and history.")}</li>
                </ul>
                <ul className="merge-notes">
                  <li>{t(`${source!.name} wird überall abgemeldet; das Konto wird danach gelöscht.`, `${source!.name} is signed out everywhere; the account is then deleted.`)}</li>
                  {preview.notes.includes("tokens") && <li>{t(`Die ${s?.apiTokens} API-Tokens von ${source!.name} werden widerrufen – Skripte brauchen ein neues Token.`, `The ${s?.apiTokens} API tokens of ${source!.name} are revoked – scripts need a new token.`)}</li>}
                  {preview.notes.includes("password") && <li>{t(`Das Passwort von ${target!.name} bleibt; das von ${source!.name} entfällt.`, `The password of ${target!.name} stays; the one of ${source!.name} goes.`)}</li>}
                  {preview.notes.includes("totp-moved") && <li>{t("Die Authenticator-App wird übernommen; Wiederherstellungscodes bitte neu erzeugen.", "The authenticator app is taken over; please create new recovery codes.")}</li>}
                  {preview.notes.includes("totp-dropped") && <li>{t(`Die Authenticator-App von ${source!.name} entfällt; die von ${target!.name} bleibt.`, `The authenticator app of ${source!.name} goes; the one of ${target!.name} stays.`)}</li>}
                  {preview.notes.includes("e2ee") && <li>{t(`Beide haben Schlüssel für Ende-zu-Ende-Verschlüsselung: die von ${target!.name} bleiben; verschlüsselte Bereiche nur von ${source!.name} müssen neu freigegeben werden.`, `Both have end-to-end encryption keys: those of ${target!.name} stay; encrypted spaces only ${source!.name} had must be shared again.`)}</li>}
                </ul>
              </>
            )}
          </>
        )}
        <div className="modal-actions">
          {other && (
            <button type="button" className="button" disabled={busy} onClick={() => setOther(null)}>
              {t("Anderes Konto wählen", "Choose another account")}
            </button>
          )}
          <button type="button" className="button" disabled={busy} onClick={onClose}>
            {t("Abbrechen", "Cancel")}
          </button>
          {other && (
            <button
              type="button"
              className="button danger-solid"
              disabled={busy || !preview}
              onClick={async () => {
                setBusy(true);
                try {
                  if (await act({ action: "admin.mergeUsers", sourceId: source!.id, targetId: target!.id })) {
                    onClose();
                    onMerged();
                  }
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? t("Führt zusammen …", "Merging …") : t("Endgültig zusammenführen", "Merge permanently")}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
