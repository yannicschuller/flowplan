"use client";
// Administration → Benutzer: the accounts of the instance as a searchable
// list with their state (active, inactive, disabled, admin), actions for
// several at once, and one account's limits, sessions and actions in a side
// sheet (full screen on phones). Registration is set under Anmeldung & SSO.
import { useEffect, useMemo, useState } from "react";
import { MagnifyingGlass, UserCircleMinus, Users } from "@phosphor-icons/react";
import type { User } from "@/lib/types";
import type { InstanceSettings } from "@/lib/instance-settings";
import { useT } from "../../i18n";
import { Avatar, Modal } from "../../ui";
import { DangerZone, EmptyState, NumberField, SaveState, SettingGroup, SettingRow, StatusBadge, UsageMeter, useSaveState, type Tone } from "../../settings-ui";
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
};
type Usage = NonNullable<AdminData["userUsage"]>[number];
type Filter = "all" | "here" | "active" | "inactive" | "disabled" | "admins";
// No sign-in for this long counts as inactive (the instance may disable such
// accounts automatically after its own number of days).
const INACTIVE_DAYS = 30;
const DAY = 86_400_000;

// The state of one account, as a badge.
function stateOf(u: User, now: number): { key: "active" | "inactive" | "disabled"; days: number } {
  const last = u.last_login_at ?? Date.parse(u.created_at.includes("T") ? u.created_at : `${u.created_at.replace(" ", "T")}Z`);
  const days = Number.isFinite(last) ? Math.floor((now - last) / DAY) : 0;
  if (u.disabled) return { key: "disabled", days };
  return { key: days >= INACTIVE_DAYS ? "inactive" : "active", days };
}

export default function UsersSection() {
  const t = useT();
  const { data, mutate, load, onError } = useAdminData();
  const [query, setQuery] = useState(""),
    [filter, setFilter] = useState<Filter>("all"),
    [selected, setSelected] = useState<Set<string>>(new Set()),
    [open, setOpen] = useState<string | null>(null),
    [bulk, setBulk] = useState(false);
  const now = useMemo(() => Date.now(), [data]);
  const live = useLiveActivity();
  if (!data) return <AdminLoading />;
  // The live times (every 30 s) over the ones the page was loaded with.
  const activityOf = (u: User): Pick<UserActivity, "openAt" | "activeAt"> =>
    live.users.get(u.id) ?? { openAt: u.last_open_at ?? null, activeAt: u.last_active_at ?? null };
  const liveNow = live.now || now;
  const local = data.localAccounts || {};
  const admins = new Set(data.adminIds || []);
  const isAdmin = (id: string) => admins.has(id) || !!local[id]?.admin;
  const states = new Map(data.users.map((u) => [u.id, stateOf(u, now)]));
  const count = (f: Filter) => data.users.filter((u) => matches(u, f)).length;
  function matches(u: User, f: Filter) {
    const s = states.get(u.id)!.key;
    if (f === "here") return ["active", "idle"].includes(activityState(activityOf(u), liveNow));
    return f === "all" || (f === "admins" ? isAdmin(u.id) : s === f);
  }
  const needle = query.trim().toLocaleLowerCase();
  const shown = data.users.filter((u) => matches(u, filter) && (!needle || `${u.name} ${u.email}`.toLocaleLowerCase().includes(needle)));
  const chosen = data.users.filter((u) => selected.has(u.id));
  const allShown = shown.length > 0 && shown.every((u) => selected.has(u.id));
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
                onChange={(e) => setQuery(e.target.value)}
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
              <button key={key} type="button" className={`admin-user-filter${filter === key ? " on" : ""}`} aria-pressed={filter === key} onClick={() => setFilter(key)}>
                {key === "here" && <i className="presence-dot" aria-hidden="true" />}
                {label}
                <span>{n}</span>
              </button>
            ))}
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
                {t("Aktivieren", "Enable")}
              </button>
            )}
            {chosen.some((u) => !u.disabled) && (
              <button
                type="button"
                className="button danger"
                disabled={bulk}
                onClick={() => {
                  const n = chosen.filter((u) => !u.disabled).length;
                  if (confirm(t(`${n} Konten deaktivieren? Ihre Sitzungen enden, sie können sich nicht mehr anmelden.`, `Disable ${n} accounts? Their sessions end and they can no longer sign in.`)))
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
                {t("Deaktivieren", "Disable")}
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
          <table className="admin-user-table" aria-label={t("Benutzer", "Users")}>
            <thead>
              <tr>
                <th scope="col" className="check">
                  <input
                    type="checkbox"
                    aria-label={t("Alle angezeigten auswählen", "Select all shown")}
                    checked={allShown}
                    onChange={(e) => setSelected(e.target.checked ? new Set([...selected, ...shown.map((u) => u.id)]) : new Set([...selected].filter((id) => !shown.some((u) => u.id === id))))}
                  />
                </th>
                <th scope="col">{t("Person · Anmeldung", "Person · sign-in")}</th>
                <th scope="col">{t("Zuletzt aktiv", "Last active")}</th>
                <th scope="col" className="end">
                  {t("Speicher", "Storage")}
                </th>
                <th scope="col">{t("Status", "Status")}</th>
                <th scope="col">
                  <span className="sr-only">{t("Aktionen", "Actions")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((u) => (
                <UserRow
                  key={u.id}
                  user={u}
                  local={local[u.id]}
                  admin={isAdmin(u.id)}
                  usage={data.userUsage?.find((x) => x.id === u.id)}
                  state={states.get(u.id)!}
                  activity={activityOf(u)}
                  now={liveNow}
                  selected={selected.has(u.id)}
                  onSelect={(on) => toggle(u.id, on)}
                  onOpen={() => setOpen(u.id)}
                />
              ))}
            </tbody>
          </table>
        )}
      </section>
      {person && <UserSheet key={person.id} user={person} data={data} state={states.get(person.id)!} activity={activityOf(person)} now={liveNow} onClose={() => setOpen(null)} />}
    </>
  );
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
function Presence({ activity, now, long }: { activity: Pick<UserActivity, "openAt" | "activeAt">; now: number; long?: boolean }) {
  const t = useT();
  const state = activityState(activity, now);
  const idle = activity.activeAt ? duration(Math.max(60, (now - activity.activeAt) / 1000), t) : null;
  const text =
    state === "active"
      ? t("Jetzt aktiv", "Active now")
      : state === "idle"
        ? idle
          ? t(`Geöffnet · inaktiv seit ${idle}`, `Open · idle for ${idle}`)
          : t("Geöffnet · inaktiv", "Open · idle")
        : state === "offline"
          ? activity.activeAt
            ? long
              ? t(`Zuletzt aktiv ${ago(activity.activeAt, t, now)}`, `Last active ${ago(activity.activeAt, t, now)}`)
              : ago(activity.activeAt, t, now)
            : t("offline", "offline")
          : t("noch nie da", "never here");
  return (
    <span className={`presence presence-${state}`}>
      <i aria-hidden="true" />
      {text}
    </span>
  );
}

// Inactive for too long: deleted on this day unless the person comes back
// (or an admin enables a blocked account).
function DeletionBadge({ due }: { due?: number | null }) {
  const t = useT();
  if (!due) return null;
  const date = new Date(due).toLocaleDateString(LOCALE_TAG, { day: "numeric", month: "short" });
  return (
    <StatusBadge tone="error">
      {t(`Wird am ${date} gelöscht`, `Deleted on ${date}`)}
    </StatusBadge>
  );
}

function StateBadge({ state }: { state: ReturnType<typeof stateOf> }) {
  const t = useT();
  const tone: Tone = state.key === "disabled" ? "error" : state.key === "inactive" ? "warn" : "ok";
  return (
    <StatusBadge tone={tone}>
      {state.key === "disabled" ? t("Deaktiviert", "Disabled") : state.key === "inactive" ? t(`Inaktiv · ${state.days} T.`, `Inactive · ${state.days} d`) : t("Aktiv", "Active")}
    </StatusBadge>
  );
}

// How the account signs in: e-mail and password (with passkeys and a second
// factor), or through the identity provider / directory.
function signIn(local: Local | undefined, t: (de: string, en: string) => string) {
  if (!local) return t("SSO / Verzeichnis", "SSO / directory");
  return [t("E-Mail", "E-mail"), local.passkeys ? (local.passkeys === 1 ? "Passkey" : `${local.passkeys} Passkeys`) : null, local.totp ? "2FA" : null].filter(Boolean).join(" · ");
}

function UserRow({
  user: u,
  local,
  admin,
  usage,
  state,
  activity,
  now,
  selected,
  onSelect,
  onOpen,
}: {
  user: User;
  local?: Local;
  admin: boolean;
  usage?: Usage;
  state: ReturnType<typeof stateOf>;
  activity: Pick<UserActivity, "openAt" | "activeAt">;
  now: number;
  selected: boolean;
  onSelect: (on: boolean) => void;
  onOpen: () => void;
}) {
  const t = useT();
  const storage = usage?.effective.storageMb ?? 0;
  return (
    <tr className={`user-row${u.disabled ? " is-disabled" : ""}${selected ? " is-selected" : ""}`}>
      <td className="check">
        <input type="checkbox" aria-label={t(`${u.name} auswählen`, `Select ${u.name}`)} checked={selected} onChange={(e) => onSelect(e.target.checked)} />
      </td>
      <td className="who">
        <div className="admin-who">
          <Avatar name={u.name} userId={u.id} />
          <span>
            <strong>
              {u.name}
              {admin && <StatusBadge tone="info">{t("Admin", "Admin")}</StatusBadge>}
              {local && !local.verified && <StatusBadge tone="warn">{t("E-Mail unbestätigt", "E-mail unconfirmed")}</StatusBadge>}
              <DeletionBadge due={u.deletion_due_at} />
            </strong>
            <small>{u.email}</small>
            <small className="signin">{signIn(local, t)}</small>
          </span>
        </div>
      </td>
      <td className="last" data-label={t("Zuletzt aktiv", "Last active")}>
        <Presence activity={activity} now={now} />
      </td>
      <td className="storage end" data-label={t("Speicher", "Storage")}>
        {usage ? `${mbText(usage.bytes)}${storage ? ` / ${storage} MB` : ""}` : "–"}
      </td>
      <td className="state">
        <StateBadge state={state} />
      </td>
      <td className="action">
        <button type="button" className="button compact" aria-haspopup="dialog" onClick={onOpen}>
          {t("Verwalten", "Manage")}
        </button>
      </td>
    </tr>
  );
}

// One account in a side sheet: usage, limits, access and – at the end – what
// cannot be undone.
function UserSheet({
  user: u,
  data,
  state,
  activity,
  now,
  onClose,
}: {
  user: User;
  data: AdminData;
  state: ReturnType<typeof stateOf>;
  activity: Pick<UserActivity, "openAt" | "activeAt">;
  now: number;
  onClose: () => void;
}) {
  const t = useT();
  const { act, load } = useAdminData();
  const local = data.localAccounts?.[u.id];
  const admin = !!local?.admin || !!data.adminIds?.includes(u.id);
  const usage = data.userUsage?.find((x) => x.id === u.id);
  const ai = data.aiPolicy?.enabled && data.aiPolicy.access === "selected" ? { allowed: data.aiPolicy.allowed.includes(u.id) } : null;
  const [resetLink, setResetLink] = useState("");
  const [note, setNote] = useState("");
  const [plan, setPlan] = useState<{
    removed: { name: string }[];
    handedOver: { name: string; to: string }[];
    kept: { name: string; disabled: number }[];
    privateSpaces: number;
  } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const run = async (body: Record<string, unknown>, done?: string) => {
    setNote("");
    const result = await act(body);
    if (result !== undefined && done) setNote(done);
    return result;
  };
  return (
    <Modal open onClose={onClose} title={u.name} className="modal-side admin-user-sheet">
      <div className="admin-user-sheet-head">
        <Avatar name={u.name} userId={u.id} />
        <span>
          <small>{u.email}</small>
          <span className="admin-user-badges">
            <StateBadge state={state} />
            {admin && <StatusBadge tone="info">{t("Admin", "Admin")}</StatusBadge>}
            {local && !local.verified && <StatusBadge tone="warn">{t("E-Mail unbestätigt", "E-mail unconfirmed")}</StatusBadge>}
            <DeletionBadge due={u.deletion_due_at} />
          </span>
          <Presence activity={activity} now={now} long />
          <small>
            {signIn(local, t)} · {u.last_login_at ? t(`zuletzt angemeldet ${ago(u.last_login_at, t)}`, `last signed in ${ago(u.last_login_at, t)}`) : t("noch nie angemeldet", "never signed in")}
          </small>
        </span>
      </div>
      {note && (
        <p className="admin-user-note" role="status">
          {note}
        </p>
      )}
      <Limits user={u} usage={usage} settings={data.settings} />
      <SettingGroup title={t("Zugang", "Access")}>
        {ai && (
          <SettingRow
            label={t("KI-Funktionen", "AI features")}
            description={t("Nur ausgewählte Personen dürfen KI nutzen (Administration → KI).", "Only selected people may use AI (Administration → AI).")}
          >
            <AiUserSwitch userId={u.id} name={u.name} allowed={ai.allowed} onChange={() => void load()} />
          </SettingRow>
        )}
        <SettingRow label={t("Sitzungen", "Sessions")} description={t("Meldet die Person auf allen Geräten ab.", "Signs the person out on every device.")}>
          <button type="button" className="button" onClick={() => void run({ action: "admin.revoke", userId: u.id }, t("Alle Sitzungen beendet.", "All sessions ended."))}>
            {t("Sitzungen beenden", "End sessions")}
          </button>
        </SettingRow>
        {local && (
          <>
            <SettingRow
              label={t("Administrator", "Administrator")}
              description={
                local.admin
                  ? t("Darf diese Instanz verwalten.", "May administer this instance.")
                  : t("Ein lokales Konto mit allen Rechten der Administration.", "A local account with all rights of the administration.")
              }
            >
              <button
                type="button"
                className="button"
                onClick={() =>
                  void run({
                    action: "admin.localAdmin",
                    userId: u.id,
                    admin: !local.admin,
                  })
                }
              >
                {local.admin ? t("Admin entziehen", "Revoke admin") : t("Zum Admin machen", "Make admin")}
              </button>
            </SettingRow>
            <SettingRow
              wide={!!resetLink}
              label={t("Passwort", "Password")}
              description={t("Ein Link zum Zurücksetzen, zwei Stunden gültig – zum Weitergeben.", "A reset link, valid for two hours – to hand over.")}
            >
              {resetLink ? (
                <input readOnly aria-label={t(`Link zum Zurücksetzen für ${u.name}`, `Reset link for ${u.name}`)} value={resetLink} onFocus={(e) => e.currentTarget.select()} />
              ) : (
                <button
                  type="button"
                  className="button"
                  onClick={async () => {
                    const result = (await act({
                      action: "admin.resetLink",
                      userId: u.id,
                    })) as { url?: string } | undefined;
                    if (result?.url) setResetLink(result.url);
                  }}
                >
                  {t("Link zum Zurücksetzen", "Reset link")}
                </button>
              )}
            </SettingRow>
            {local.totp && (
              <SettingRow
                label={t("Zwei-Faktor-Anmeldung", "Two-factor sign-in")}
                description={t("Etwa bei verlorenem Telefon. Die Person wird per E-Mail informiert.", "E.g. for a lost phone. The person is told by e-mail.")}
              >
                <button
                  type="button"
                  className="button"
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
                  {t("Zwei-Faktor zurücksetzen", "Reset two-factor")}
                </button>
              </SettingRow>
            )}
            {!local.verified && (
              <SettingRow
                label={t("E-Mail-Adresse", "E-mail address")}
                description={t("Die Person hat den Link aus der Bestätigungs-E-Mail noch nicht geöffnet.", "The person has not opened the link from the confirmation e-mail yet.")}
              >
                <button type="button" className="button" onClick={() => void run({ action: "admin.confirmEmail", userId: u.id })}>
                  {t("E-Mail als bestätigt markieren", "Mark e-mail as confirmed")}
                </button>
              </SettingRow>
            )}
          </>
        )}
      </SettingGroup>
      <DangerZone>
        <SettingRow
          label={u.disabled ? t("Konto aktivieren", "Enable account") : t("Konto deaktivieren", "Disable account")}
          description={
            u.disabled
              ? t("Die Person kann sich wieder anmelden.", "The person can sign in again.")
              : t("Beendet alle Sitzungen; die Person kann sich nicht mehr anmelden. Lässt sich rückgängig machen.", "Ends all sessions; the person can no longer sign in. Can be undone.")
          }
        >
          <button
            type="button"
            className={`button${u.disabled ? "" : " danger"}`}
            onClick={() =>
              void act({
                action: "admin.user",
                userId: u.id,
                disabled: !u.disabled,
              })
            }
          >
            {u.disabled ? t("Aktivieren", "Enable") : t("Deaktivieren", "Disable")}
          </button>
        </SettingRow>
        <SettingRow
          label={t("Konto löschen", "Delete account")}
          description={
            u.disabled
              ? t("Endgültig – vorher siehst du, was mit den Arbeitsbereichen geschieht.", "Permanent – you see first what happens to the workspaces.")
              : t("Löschen ist möglich, sobald das Konto deaktiviert ist.", "Deleting is possible once the account is disabled.")
          }
        >
          {!!u.disabled && (
            <button
              type="button"
              className="button danger"
              onClick={async () => {
                const result = (await act({
                  action: "admin.deletePlan",
                  userId: u.id,
                })) as typeof plan;
                if (result) setPlan(result);
              }}
            >
              <UserCircleMinus size={16} aria-hidden /> {t("Konto löschen …", "Delete account …")}
            </button>
          )}
        </SettingRow>
      </DangerZone>
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

// Storage, own workspaces and largest file for this person; empty = the
// instance default. Saved together.
function Limits({ user: u, usage, settings }: { user: User; usage?: Usage; settings: InstanceSettings }) {
  const t = useT();
  const { mutate, load } = useAdminData();
  const [limits, setLimits] = useState(usage?.limits || {});
  const [status, run] = useSaveState();
  const clean = (l: object) =>
    JSON.stringify(
      Object.entries(l)
        .filter(([, v]) => v !== null && v !== undefined)
        .sort(),
    );
  const changed = clean(limits) !== clean(usage?.limits || {});
  const storage = usage?.effective.storageMb ?? 0;
  const defaults = {
    storage: settings.defaultUserStorageMb ? `${settings.defaultUserStorageMb} MB` : t("unbegrenzt", "unlimited"),
    workspaces: settings.defaultUserWorkspaces ? String(settings.defaultUserWorkspaces) : t("unbegrenzt", "unlimited"),
    upload: `${settings.maxUploadMb} MB`,
  };
  return (
    <form
      aria-label={t(`Grenzen für ${u.name}`, `Limits for ${u.name}`)}
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await mutate({ action: "admin.userLimits", userId: u.id, limits });
          await load();
        });
      }}
    >
      <SettingGroup
        title={t("Belegung und Grenzen", "Usage and limits")}
        description={t("Leer = Standard der Instanz, 0 = unbegrenzt. Für Admins gelten keine Grenzen.", "Empty = instance default, 0 = unlimited. Admins are not limited.")}
      >
        {usage && (
          <div className="setting-row wide admin-user-meters">
            <UsageMeter label={t("Speicher", "Storage")} used={usage.bytes} limit={storage * 1024 * 1024} format={mbText} />
            <UsageMeter label={t("Eigene Arbeitsbereiche", "Own workspaces")} used={usage.workspaces} limit={usage.effective.workspaces} format={(n) => String(n)} />
          </div>
        )}
        <SettingRow id={`limit-storage-${u.id}`} label={t("Speicher", "Storage")} description={t(`Standard: ${defaults.storage}`, `Default: ${defaults.storage}`)}>
          <NumberField
            id={`limit-storage-${u.id}`}
            label={t(`Speicher für ${u.name}`, `Storage for ${u.name}`)}
            value={limits.storageMb}
            unit="MB"
            placeholder={defaults.storage}
            onChange={(storageMb) => setLimits({ ...limits, storageMb })}
          />
        </SettingRow>
        <SettingRow id={`limit-workspaces-${u.id}`} label={t("Eigene Arbeitsbereiche", "Own workspaces")} description={t(`Standard: ${defaults.workspaces}`, `Default: ${defaults.workspaces}`)}>
          <NumberField
            id={`limit-workspaces-${u.id}`}
            label={t(`Eigene Arbeitsbereiche für ${u.name}`, `Own workspaces for ${u.name}`)}
            value={limits.workspaces}
            max={10000}
            placeholder={defaults.workspaces}
            onChange={(workspaces) => setLimits({ ...limits, workspaces })}
          />
        </SettingRow>
        <SettingRow id={`limit-upload-${u.id}`} label={t("Größte Datei", "Largest file")} description={t(`Standard: ${defaults.upload}`, `Default: ${defaults.upload}`)}>
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
        </SettingRow>
        <div className="setting-row admin-form-actions">
          <SaveState status={status} />
          <button className="button primary" disabled={!changed || status.state === "saving"}>
            {t("Grenzen speichern", "Save limits")}
          </button>
        </div>
      </SettingGroup>
    </form>
  );
}
