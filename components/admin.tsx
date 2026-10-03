"use client";
import { serverMessage } from "@/lib/i18n-errors";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { useT } from "./i18n";
import { useEffect, useState } from "react";
import {
  ShieldCheck,
  Users,
  Stack,
  Key,
  ArrowCounterClockwise,
  Gauge,
  SlidersHorizontal,
  ListChecks,
} from "@phosphor-icons/react";
import { api, Avatar } from "./ui";
import { Select } from "./select";
import { AdminStorage } from "./admin-storage";
import type { User } from "@/lib/types";
import type { InstanceSettings } from "@/lib/instance-settings";
type AdminData = {
  users: User[];
  workspaces: { id: string; name: string; members: number; pages: number }[];
  sessions: number;
  audit: {
    id: string;
    name: string;
    action: string;
    resource_id: string;
    created_at: string;
  }[];
  adminGroup: string;
  oidcConfigured: boolean;
  metrics: {
    databaseBytes: number;
    uploadBytes: number;
    files: number;
    pages: number;
    trashedPages: number;
    rows: number;
    snapshots: number;
    pushPending: number;
    pushFailed: number;
    searchBacklog: number;
    reminders: number;
    demosActive: number;
    demosStarted: number;
    retentionDays: number;
    defaultQuotaMb: number;
    uptimeSeconds: number;
    node: string;
  };
  usage: {
    id: string;
    bytes: number;
    quotaMb: number | null;
    effectiveQuotaMb: number;
  }[];
  settings: InstanceSettings;
  publicSite?: boolean;
  localLogin?: boolean;
  localAccounts?: Record<string, { admin: boolean; verified: boolean; passkeys: number }>;
  mail: {
    configured: boolean;
    host: string | null;
    from: string | null;
    pending: number;
    failed: number;
    sentWeek: number;
    lastError: string | null;
  };
  backup: {
    enabled: boolean;
    keep: number;
    target: "s3" | "local";
    last: { at: number; target: string; name: string; bytes: number; error: string | null } | null;
  };
  restorePending: {
    createdAt: string;
    users: number;
    workspaces: number;
    pages: number;
    files: number;
  } | null;
};
const mb = (bytes: number) =>
  `${(bytes / 1024 / 1024).toLocaleString(LOCALE_TAG, { maximumFractionDigits: 1 })} MB`;
const duration = (seconds: number, t: (de: string, en: string) => string) =>
  seconds < 3600
    ? t(`${Math.round(seconds / 60)} Min.`, `${Math.round(seconds / 60)} min`)
    : seconds < 86400
      ? t(`${Math.round(seconds / 3600)} Std.`, `${Math.round(seconds / 3600)} h`)
      : t(`${Math.round(seconds / 86400)} Tage`, `${Math.round(seconds / 86400)} days`);
const adminTabs = [
  [
    "users",
    ["Benutzer", "Users"],
    Users,
    ["Konten der Instanz: Sitzungen beenden, sperren und wieder freigeben.", "Accounts of the instance: end sessions, block and unblock."],
  ],
  [
    "workspaces",
    ["Arbeitsbereiche", "Workspaces"],
    Stack,
    ["Alle Arbeitsbereiche mit Belegung und Speicherkontingent.", "All workspaces with usage and storage quota."],
  ],
  [
    "operations",
    ["Betrieb", "Operations"],
    Gauge,
    ["Zustand der Instanz: Speicher, Warteschlangen, Suchindex und Laufzeit.", "State of the instance: storage, queues, search index and uptime."],
  ],
  [
    "instance",
    ["Instanz", "Instance"],
    SlidersHorizontal,
    ["Name, Hinweise, Grenzen und Sicherung der gesamten Instanz.", "Name, notices, limits and backup of the whole instance."],
  ],
  [
    "audit",
    ["Aktivitätsprotokoll", "Activity log"],
    ListChecks,
    ["Die letzten Änderungen mit Person und betroffener Ressource.", "The latest changes with person and affected resource."],
  ],
] as const;
const auditTime = (value: string) => {
  const date = new Date(
    /[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : value.replace(" ", "T") + "Z",
  );
  return Number.isFinite(date.getTime())
    ? date.toLocaleString(LOCALE_TAG, {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : value;
};
export default function Admin({
  mutate,
  onError,
}: {
  mutate: (b: Record<string, unknown>) => Promise<unknown>;
  onError: (s: string) => void;
}) {
  const t = useT();
  const [data, setData] = useState<AdminData | null>(null),
    [tab, setTabState] = useState("users"),
    [query, setQuery] = useState(""),
    [status, setStatus] = useState("all");
  const setTab = (next: string) => {
    setTabState(next);
    setQuery("");
  };
  async function load() {
    try {
      setData(await api("/api/admin"));
    } catch (e) {
      onError((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function act(b: Record<string, unknown>) {
    try {
      const result = await mutate(b);
      await load();
      return result;
    } catch (e) {
      onError((e as Error).message);
    }
  }
  // A reset link for an account with e-mail and password, to hand over.
  const [resetLink, setResetLink] = useState<{ userId: string; url: string } | null>(null);
  if (!data)
    return <div className="loading-content">{t("Administration wird geladen …", "Loading administration …")}</div>;
  return (
    <div className="utility-content admin-page">
      <div className="utility-title">
        <ShieldCheck size={32} />
        <h1>{t("Administration", "Administration")}</h1>
        <p>{t("Benutzer, Arbeitsbereiche und Zugriffe deiner Flowplan-Instanz.", "Users, workspaces and access of your Flowplan instance.")}</p>
      </div>
      <div className="admin-stats">
        <div>
          <Users />
          <strong>{data.users.length}</strong>
          <span>{t("Benutzer", "Users")}</span>
        </div>
        <div>
          <Stack />
          <strong>{data.workspaces.length}</strong>
          <span>{t("Arbeitsbereiche", "Workspaces")}</span>
        </div>
        <div>
          <Key />
          <strong>{data.sessions}</strong>
          <span>{t("Aktive Sitzungen", "Active sessions")}</span>
        </div>
      </div>
      <div className="callout">
        <ShieldCheck size={20} />
        <span>
          {t("Admin-Gruppe:", "Admin group:")}{" "}<strong>{data.adminGroup}</strong> · OIDC{" "}
          {data.oidcConfigured ? "konfiguriert" : t("nicht konfiguriert", "not configured")}
        </span>
      </div>
      <div className="settings-layout">
        <nav className="settings-tabs" aria-label={t("Bereiche der Administration", "Administration sections")}>
          {adminTabs.map(([id, label, Icon]) => (
            <button
              key={id}
              className={tab === id ? "selected" : ""}
              aria-current={tab === id ? "page" : undefined}
              onClick={() => setTab(id)}
            >
              <Icon size={18} aria-hidden="true" />
              {t(label[0], label[1])}
            </button>
          ))}
          <button
            className="settings-refresh"
            title={t("Aktualisieren", "Refresh")}
            aria-label={t("Aktualisieren", "Refresh")}
            onClick={() => load()}
          >
            <ArrowCounterClockwise size={16} aria-hidden="true" />
            {t("Aktualisieren", "Refresh")}
          </button>
        </nav>
        <div className="settings-body">
          <p className="settings-intro">
            {(([de, en]) => t(de, en))(adminTabs.find(([id]) => id === tab)![3])}
          </p>
          {tab === "users" && data.localLogin && (
            <SignupSwitch
              open={!!data.settings.allowSignup}
              onChange={(allowSignup) =>
                act({ action: "admin.settings", settings: { ...data.settings, allowSignup } })
              }
            />
          )}
          {tab === "users" && (
            <section className="settings-section">
              <div className="settings-list-head">
                <h2>{t("Benutzer ·", "Users ·")}{" "}{data.users.length}</h2>
                <input
                  type="search"
                  aria-label={t("Benutzer suchen", "Search users")}
                  placeholder={t("Name oder E-Mail suchen …", "Search name or email …")}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <Select
                  aria-label={t("Status", "Status")}
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                >
                  <option value="all">{t("Alle", "All")}</option>
                  <option value="active">{t("Aktiv", "Active")}</option>
                  <option value="disabled">{t("Deaktiviert", "Disabled")}</option>
                </Select>
              </div>
              <div className="settings-list">
                {data.users
                  .filter(
                    (u) =>
                      (status === "all" ||
                        (status === "disabled") === !!u.disabled) &&
                      `${u.name} ${u.email}`
                        .toLowerCase()
                        .includes(query.toLowerCase()),
                  )
                  .map((u) => (
                    <div
                      className={`member-row${u.disabled ? " is-disabled" : ""}`}
                      key={u.id}
                    >
                      <Avatar name={u.name} userId={u.id} />
                      <span>
                        {u.name}
                        <small>
                          {u.email}
                          {" · "}
                          {u.last_login_at
                            ? `zuletzt angemeldet ${new Date(u.last_login_at).toLocaleDateString(LOCALE_TAG)}`
                            : t("noch nie angemeldet", "never signed in")}
                        </small>
                      </span>
                      {!!u.disabled && (
                        <span className="status-chip muted-chip">
                          {t("Deaktiviert", "Disabled")}
                        </span>
                      )}
                      {data.localAccounts?.[u.id] && (
                        <span className="status-chip muted-chip" title={t("Meldet sich mit E-Mail und Passwort an", "Signs in with email and password")}>
                          {data.localAccounts[u.id].admin ? t("Admin · E-Mail", "Admin · email") : "E-Mail"}
                          {data.localAccounts[u.id].passkeys ? ` · ${data.localAccounts[u.id].passkeys} Passkey` : ""}
                        </span>
                      )}
                      {data.localAccounts?.[u.id] && (
                        <>
                          <button
                            className="button compact"
                            onClick={() =>
                              act({ action: "admin.localAdmin", userId: u.id, admin: !data.localAccounts![u.id].admin })
                            }
                          >
                            {data.localAccounts[u.id].admin ? t("Admin entziehen", "Revoke admin") : t("Zum Admin machen", "Make admin")}
                          </button>
                          <button
                            className="button compact"
                            onClick={async () => {
                              const result = (await act({ action: "admin.resetLink", userId: u.id })) as { url?: string } | undefined;
                              if (result?.url) setResetLink({ userId: u.id, url: result.url });
                            }}
                          >
                            {t("Link zum Zurücksetzen", "Reset link")}
                          </button>
                        </>
                      )}
                      <button
                        className="button compact"
                        onClick={() =>
                          act({ action: "admin.revoke", userId: u.id })
                        }
                      >
                        {t("Sitzungen beenden", "End sessions")}
                      </button>
                      <button
                        className={`button compact ${u.disabled ? "" : "danger"}`}
                        onClick={() =>
                          act({
                            action: "admin.user",
                            userId: u.id,
                            disabled: !u.disabled,
                          })
                        }
                      >
                        {u.disabled ? t("Aktivieren", "Enable") : t("Deaktivieren", "Disable")}
                      </button>
                      {resetLink?.userId === u.id && (
                        <label className="reset-link">
                          {t("Zwei Stunden gültig – an", "Valid for two hours – send to")}{" "}{u.name} weitergeben:
                          <input readOnly value={resetLink.url} onFocus={(e) => e.currentTarget.select()} />
                        </label>
                      )}
                    </div>
                  ))}
              </div>
            </section>
          )}
          {tab === "workspaces" && (
            <section className="settings-section">
              <div className="settings-list-head">
                <h2>{t("Arbeitsbereiche ·", "Workspaces ·")}{" "}{data.workspaces.length}</h2>
                <input
                  type="search"
                  aria-label={t("Arbeitsbereiche suchen", "Search workspaces")}
                  placeholder={t("Arbeitsbereich suchen …", "Search workspace …")}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <div className="data-table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>{t("Arbeitsbereich", "Workspace")}</th>
                      <th>{t("Mitglieder", "Members")}</th>
                      <th>{t("Seiten", "Pages")}</th>
                      <th>{t("Speicher", "Storage")}</th>
                      <th>{t("Kontingent (MB)", "Quota (MB)")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.workspaces
                      .filter((w) =>
                        w.name.toLowerCase().includes(query.toLowerCase()),
                      )
                      .map((w) => {
                        const usage = data.usage.find((u) => u.id === w.id);
                        const quota = usage?.effectiveQuotaMb || 0;
                        return (
                          <tr key={w.id}>
                            <td>{w.name}</td>
                            <td>{w.members}</td>
                            <td>{w.pages}</td>
                            <td>
                              {mb(usage?.bytes || 0)}
                              {quota > 0 && (
                                <meter
                                  min={0}
                                  max={quota * 1024 * 1024}
                                  value={usage?.bytes || 0}
                                  high={quota * 1024 * 1024 * 0.9}
                                  aria-label={t(`Belegung ${w.name}`, `Usage ${w.name}`)}
                                />
                              )}
                            </td>
                            <td>
                              <input
                                type="number"
                                min={0}
                                className="quota-input"
                                aria-label={t(`Kontingent ${w.name}`, `Quota ${w.name}`)}
                                placeholder={
                                  data.metrics.defaultQuotaMb
                                    ? t(`Standard ${data.metrics.defaultQuotaMb}`, `Default ${data.metrics.defaultQuotaMb}`)
                                    : "unbegrenzt"
                                }
                                defaultValue={usage?.quotaMb ?? ""}
                                onBlur={(e) => {
                                  const raw = e.target.value.trim();
                                  const next = raw === "" ? null : Number(raw);
                                  if (next === (usage?.quotaMb ?? null)) return;
                                  void act({
                                    action: "admin.quota",
                                    workspaceId: w.id,
                                    quotaMb: next,
                                  });
                                }}
                              />
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            </section>
          )}
          {tab === "instance" && (
            <>
              <InstanceSettingsForm
                initial={data.settings}
                publicSite={!!data.publicSite}
                localLogin={!!data.localLogin}
                onSave={async (settings) => {
                  await act({ action: "admin.settings", settings });
                }}
              />
              <MailAndBackup
                mail={data.mail}
                backup={data.backup}
                onChange={load}
                onError={onError}
              />
              <InstanceBackup
                pending={data.restorePending}
                onChange={load}
                onError={onError}
              />
            </>
          )}
          {tab === "operations" && (
            <section className="settings-section">
              <h2>{t("Betriebsmetriken", "Operating metrics")}</h2>
              <div className="admin-metrics" aria-label={t("Betriebsmetriken", "Operating metrics")}>
                {(
                  [
                    [t("Datenbank", "Database"), mb(data.metrics.databaseBytes)],
                    [
                      t("Uploads", "Uploads"),
                      t(`${mb(data.metrics.uploadBytes)} · ${data.metrics.files} Dateien`, `${mb(data.metrics.uploadBytes)} · ${data.metrics.files} files`),
                    ],
                    [
                      t("Seiten", "Pages"),
                      t(`${data.metrics.pages} aktiv · ${data.metrics.trashedPages} im Papierkorb`, `${data.metrics.pages} active · ${data.metrics.trashedPages} in trash`),
                    ],
                    [t("Datensätze", "Records"), String(data.metrics.rows)],
                    [
                      t("Versionen", "Versions"),
                      t(`${data.metrics.snapshots} · Aufbewahrung ${data.metrics.retentionDays ? `${data.metrics.retentionDays} Tage` : "unbegrenzt"}`, `${data.metrics.snapshots} · kept ${data.metrics.retentionDays ? `${data.metrics.retentionDays} days` : "forever"}`),
                    ],
                    [
                      t("Push-Warteschlange", "Push queue"),
                      `${data.metrics.pushPending} offen · ${data.metrics.pushFailed} fehlgeschlagen`,
                    ],
                    [
                      t("Suchindex", "Search index"),
                      data.metrics.searchBacklog
                        ? t(`${data.metrics.searchBacklog} Änderungen ausstehend`, `${data.metrics.searchBacklog} changes pending`)
                        : "aktuell",
                    ],
                    [t("Erinnerungen", "Reminders"), String(data.metrics.reminders)],
                    [
                      t("Demos", "Demos"),
                      `${data.metrics.demosActive} laufen · ${data.metrics.demosStarted} insgesamt gestartet${data.settings.publicDemo ? "" : " · ausgeschaltet"}`,
                    ],
                    [
                      t("Standardkontingent", "Default quota"),
                      data.metrics.defaultQuotaMb
                        ? t(`${data.metrics.defaultQuotaMb} MB je Arbeitsbereich`, `${data.metrics.defaultQuotaMb} MB per workspace`)
                        : "unbegrenzt",
                    ],
                    [
                      t("Laufzeit", "Uptime"),
                      `${duration(data.metrics.uptimeSeconds, t)} · Node ${data.metrics.node}`,
                    ],
                  ] as const
                ).map(([label, value]) => (
                  <div key={label}>
                    <span>{label}</span>
                    <strong>{value}</strong>
                  </div>
                ))}
              </div>
            </section>
          )}
          {tab === "operations" && <AdminStorage onError={onError} />}
          {tab === "audit" && (
            <section className="settings-section">
              <div className="settings-list-head">
                <h2>{t("Aktivitätsprotokoll", "Activity log")}</h2>
                <a className="button compact" href="/api/admin/audit.csv" download>
                  {t("Als CSV exportieren", "Export as CSV")}
                </a>
                <input
                  type="search"
                  aria-label={t("Protokoll durchsuchen", "Search the log")}
                  placeholder={t("Person oder Aktion suchen …", "Search person or action …")}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <div className="data-table-scroll">
                <table className="data-table audit-table">
                  <thead>
                    <tr>
                      <th>{t("Zeitpunkt", "Time")}</th>
                      <th>{t("Person", "Person")}</th>
                      <th>{t("Aktion", "Action")}</th>
                      <th>{t("Ressource", "Resource")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.audit
                      .filter((a) =>
                        `${a.name || "System"} ${a.action}`
                          .toLowerCase()
                          .includes(query.toLowerCase()),
                      )
                      .map((a) => (
                        <tr key={a.id}>
                          <td>{auditTime(a.created_at)}</td>
                          <td>{a.name || t("System", "System")}</td>
                          <td>
                            <code>{a.action}</code>
                          </td>
                          <td>
                            <small>{a.resource_id.slice(0, 8)}</small>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

// Whether people can create an account themselves; saved right away.
function SignupSwitch({ open, onChange }: { open: boolean; onChange: (open: boolean) => Promise<unknown> }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  return (
    <section className="settings-section signup-switch" aria-label={t("Registrierung", "Sign-up")}>
      <label className="js-switch">
        <input
          type="checkbox"
          role="switch"
          checked={open}
          disabled={busy}
          onChange={async (e) => {
            setBusy(true);
            await onChange(e.target.checked);
            setBusy(false);
          }}
        />
        <span>
          <strong>
            {t("Registrierung", "Sign-up")}: {open ? t("offen", "open") : t("geschlossen", "closed")}
          </strong>
          <small>
            {open
              ? t("Jede Person kann sich mit E-Mail und Passwort ein Konto anlegen.", "Anyone can create an account with email and password.")
              : t("Nur eingeladene Adressen können ein Konto anlegen. Der Knopf „Registrieren“ ist ausgeblendet.", "Only invited addresses can create an account. The “Sign up” button is hidden.")}
          </small>
        </span>
      </label>
    </section>
  );
}

// Instance-wide settings; empty numbers fall back to the environment.
function InstanceSettingsForm({
  initial,
  publicSite,
  localLogin,
  onSave,
}: {
  initial: InstanceSettings;
  publicSite: boolean;
  localLogin: boolean;
  onSave: (settings: InstanceSettings) => Promise<void>;
}) {
  const t = useT();
  const [draft, setDraft] = useState(initial),
    [saved, setSaved] = useState(false);
  const optional = (value: string) =>
    value.trim() === "" ? null : Math.max(0, Math.round(Number(value)));
  return (
    <form
      className="settings-section instance-settings"
      aria-label={t("Instanzeinstellungen", "Instance settings")}
      onSubmit={async (e) => {
        e.preventDefault();
        setSaved(false);
        await onSave(draft);
        setSaved(true);
      }}
    >
      <h2>{t("Instanz", "Instance")}</h2>
      <p>
        {t("Leere Felder übernehmen die Werte aus der Umgebung (Konfigurationsdatei oder Umgebungsvariablen).", "Empty fields take the values from the environment (configuration file or environment variables).")}
      </p>
      <label>
        {t("Name der Instanz", "Instance name")}
        <input
          maxLength={60}
          placeholder={t("z. B. Flowplan der Muster GmbH", "e.g. Flowplan of Example Ltd")}
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />
      </label>
      <label>
        {t("Hinweis für alle Personen", "Notice for everyone")}
        <textarea
          maxLength={500}
          rows={2}
          placeholder="z. B. Wartung am Samstag ab 18 Uhr"
          value={draft.announcement}
          onChange={(e) => setDraft({ ...draft, announcement: e.target.value })}
        />
      </label>
      <label>
        {t("Standard-Speicherkontingent je Arbeitsbereich (MB, 0 = unbegrenzt)", "Default storage quota per workspace (MB, 0 = unlimited)")}
        <input
          type="number"
          min={0}
          placeholder={t("Wert aus der Umgebung", "Value from the environment")}
          value={draft.defaultQuotaMb ?? ""}
          onChange={(e) =>
            setDraft({ ...draft, defaultQuotaMb: optional(e.target.value) })
          }
        />
      </label>
      <label>
        {t("Versionen aufbewahren (Tage, 0 = unbegrenzt)", "Keep versions (days, 0 = forever)")}
        <input
          type="number"
          min={0}
          placeholder={t("Wert aus der Umgebung", "Value from the environment")}
          value={draft.retentionDays ?? ""}
          onChange={(e) =>
            setDraft({ ...draft, retentionDays: optional(e.target.value) })
          }
        />
      </label>
      <label>
        {t("Größte Datei beim Hochladen (MB)", "Largest upload (MB)")}
        <input
          type="number"
          min={1}
          max={1024}
          required
          value={draft.maxUploadMb}
          onChange={(e) =>
            setDraft({
              ...draft,
              maxUploadMb: Math.min(
                1024,
                Math.max(1, Math.round(Number(e.target.value) || 1)),
              ),
            })
          }
        />
      </label>
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={draft.allowWorkspaceCreation}
          onChange={(e) =>
            setDraft({ ...draft, allowWorkspaceCreation: e.target.checked })
          }
        />
        {t("Alle Personen dürfen Arbeitsbereiche anlegen", "Everyone may create workspaces")}
      </label>
      {localLogin && (
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={!!draft.allowSignup}
            onChange={(e) => setDraft({ ...draft, allowSignup: e.target.checked })}
          />
          <span>
            {t("Registrierung mit E-Mail und Passwort erlauben", "Allow sign-up with email and password")}
            <small className="muted">
              {t("Ohne diese Einstellung legen nur eingeladene Adressen ein Konto an. Das erste Konto einer Instanz verwaltet sie.", "Without this setting only invited addresses can create an account. The first account of an instance administers it.")}
            </small>
          </span>
        </label>
      )}
      {publicSite && (
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={!!draft.publicDemo}
          onChange={(e) => setDraft({ ...draft, publicDemo: e.target.checked })}
        />
        <span>
          {t("Demo auf der Startseite anbieten", "Offer a demo on the start page")}
          <small className="muted">
            {t("Besucher erhalten ohne Konto einen eigenen Arbeitsbereich mit Beispielen. Er wird nach 45 Minuten ohne Aktivität (spätestens nach 3 Stunden) oder mit „Demo beenden“ gelöscht. Demo-Konten können nichts veröffentlichen, teilen oder einladen.", "Visitors get their own workspace with examples without an account. It is deleted after 45 minutes without activity (after 3 hours at the latest) or with “End demo”. Demo accounts cannot publish, share or invite.")}
          </small>
        </span>
      </label>
      )}
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={draft.backupSchedule !== false}
          onChange={(e) => setDraft({ ...draft, backupSchedule: e.target.checked })}
        />
        <span>
          {t("Tägliche Datenbanksicherung", "Daily database backup")}
          <small className="muted">
            {t("Eine Kopie der Datenbank pro Tag – mit S3 in den Bucket (Ordner", "One copy of the database per day – with S3 into the bucket (folder")}{" "}<code>backups/</code>{t("), sonst in den Datenordner.", "), otherwise into the data folder.")}
          </small>
        </span>
      </label>
      <label>
        {t("Aufbewahrte Sicherungen", "Backups kept")}
        <input
          type="number"
          min={1}
          max={365}
          value={draft.backupKeep ?? 7}
          onChange={(e) => setDraft({ ...draft, backupKeep: Math.max(1, Number(e.target.value) || 1) })}
        />
      </label>
      <label>
        {t("Konten ohne Anmeldung sperren nach (Tagen)", "Block accounts without sign-in after (days)")}
        <input
          type="number"
          min={30}
          max={3650}
          placeholder="nie"
          value={draft.inactiveDays ?? ""}
          onChange={(e) =>
            setDraft({ ...draft, inactiveDays: e.target.value ? Number(e.target.value) : null })
          }
        />
      </label>
      <button className="button primary">{t("Einstellungen speichern", "Save settings")}</button>
      {saved && <p role="status">{t("Gespeichert.", "Saved.")}</p>}
    </form>
  );
}

// E-mail and scheduled backups: configuration state and a manual run.
function MailAndBackup({
  mail,
  backup,
  onChange,
  onError,
}: {
  mail: AdminData["mail"];
  backup: AdminData["backup"];
  onChange: () => void;
  onError: (message: string) => void;
}) {
  const t = useT();
  const [to, setTo] = useState(""),
    [busy, setBusy] = useState(""),
    [note, setNote] = useState("");
  const post = async (path: string, body: unknown, done: string) => {
    setBusy(path);
    setNote("");
    try {
      await api(path, body);
      setNote(done);
      onChange();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  return (
    <>
      <section className="settings-section">
        <h2>E-Mail-Versand</h2>
        {mail.configured ? (
          <p>
            SMTP: <code>{mail.host}</code> {t("als", "as")}{" "}<code>{mail.from}</code> ·{" "}
            {mail.pending} {t("in der Warteschlange ·", "queued ·")}{" "}{mail.sentWeek} {t("gesendet (7 Tage)", "sent (7 days)")}
            {mail.failed > 0 && ` · ${mail.failed} aufgegeben`}
          </p>
        ) : (
          <p className="muted">
            {t("Nicht eingerichtet. Mit", "Not set up. With")}{" "}<code>SMTP_HOST</code>, <code>SMTP_PORT</code>,{" "}
            <code>SMTP_USER</code>, <code>SMTP_PASSWORD</code> {t("und", "and")}{" "}<code>SMTP_FROM</code>{" "}
            {t("verschickt Flowplan Einladungen und Zusammenfassungen ungelesener Benachrichtigungen.", "Flowplan sends invitations and digests of unread notifications.")}
          </p>
        )}
        {mail.lastError && <p className="error">{t("Letzter Fehler:", "Last error:")}{" "}{mail.lastError}</p>}
        {mail.configured && (
          <form
            className="integration-form"
            onSubmit={(e) => {
              e.preventDefault();
              void post("/api/admin/mail-test", { to }, t(`Test-E-Mail an ${to} gesendet.`, `Test email sent to ${to}.`));
            }}
          >
            <input
              type="email"
              required
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="E-Mail-Adresse"
              aria-label={t("Empfänger der Test-E-Mail", "Test email recipient")}
            />
            <button className="button" disabled={!!busy}>
              {t("Test-E-Mail senden", "Send test email")}
            </button>
          </form>
        )}
      </section>
      <section className="settings-section">
        <h2>{t("Geplante Sicherung", "Scheduled backup")}</h2>
        <p>
          {backup.enabled ? t("Täglich", "Daily") : t("Ausgeschaltet", "Off")} ·{" "}
          {backup.target === "s3" ? t("in den S3-Bucket", "into the S3 bucket") : t("in den Datenordner", "into the data folder")} {t("· die neuesten", "· the latest")}{" "}
          {backup.keep} bleiben erhalten.
        </p>
        {backup.last && (
          <p className={backup.last.error ? "error" : "muted"}>
            {t("Letzte Sicherung", "Last backup")}{" "}{new Date(backup.last.at).toLocaleString(LOCALE_TAG)}:{" "}
            {backup.last.error
              ? backup.last.error
              : `${backup.last.name} (${(backup.last.bytes / 1048576).toFixed(1)} MB)`}
          </p>
        )}
        <button
          className="button"
          disabled={!!busy}
          onClick={() => void post("/api/admin/backup-run", {}, t("Sicherung erstellt.", "Backup created."))}
        >
          {busy === "/api/admin/backup-run" ? t("Sichert …", "Backing up …") : t("Jetzt sichern", "Back up now")}
        </button>
      </section>
      {note && <p role="status">{note}</p>}
    </>
  );
}

// Backup and restore of the whole instance (database and uploads).
function InstanceBackup({
  pending,
  onChange,
  onError,
}: {
  pending: AdminData["restorePending"];
  onChange: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  return (
    <section
      className="settings-section instance-backup"
      aria-label={t("Instanzsicherung", "Instance backup")}
    >
      <h2>{t("Sicherung der gesamten Instanz", "Backup of the whole instance")}</h2>
      <p className="muted">
        {t("Enthält alle Arbeitsbereiche, Konten, Einstellungen und Dateien. Die Datei enthält vertrauliche Daten und sollte sicher verwahrt werden.", "Contains all workspaces, accounts, settings and files. The file holds confidential data and should be kept safe.")}
      </p>
      <a className="button" href="/api/admin/instance-backup" download>
        {t("Sicherung herunterladen", "Download backup")}
      </a>
      <h3>{t("Aus Sicherung wiederherstellen", "Restore from backup")}</h3>
      <p className="muted">
        {t("Die hochgeladene Sicherung wird geprüft und beim nächsten Neustart des Servers übernommen. Der bisherige Stand bleibt im Datenordner als „pre-restore-…“ erhalten. Alle Sitzungen enden mit der Übernahme.", "The uploaded backup is checked and applied on the next server restart. The previous state stays in the data folder as “pre-restore-…”. All sessions end when it is applied.")}
      </p>
      {pending ? (
        <div className="callout" role="status">
          <span>
            {t("Bereit zur Übernahme beim Neustart: Sicherung vom", "Ready to apply on restart: backup from")}{" "}
            {pending.createdAt
              ? new Date(pending.createdAt).toLocaleString(LOCALE_TAG)
              : "unbekannten Datum"}{" "}
            {t("mit", "with")}{" "}{pending.workspaces} {t("Arbeitsbereichen,", "workspaces,")}{" "}{pending.pages} {t("Seiten,", "pages,")}{" "}
            {pending.users} {t("Konten und", "accounts and")}{" "}{pending.files} {t("Dateien.", "files.")}
          </span>
          <button
            className="button compact"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await fetch("/api/admin/instance-backup", {
                  method: "DELETE",
                });
                if (!r.ok) throw new Error(serverMessage((await r.json()).error));
                await onChange();
              } catch (e) {
                onError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {t("Wiederherstellung abbrechen", "Cancel restore")}
          </button>
        </div>
      ) : (
        <label className="button file-label">
          {busy ? t("Sicherung wird geprüft …", "Checking backup …") : t("Sicherung auswählen", "Choose backup")}
          <input
            type="file"
            accept=".zip"
            hidden
            aria-label={t("Instanzsicherung hochladen", "Upload instance backup")}
            disabled={busy}
            onChange={async (e) => {
              const file = e.currentTarget.files?.[0];
              e.currentTarget.value = "";
              if (!file) return;
              setBusy(true);
              try {
                const r = await fetch("/api/admin/instance-backup", {
                  method: "POST",
                  headers: { "Content-Type": "application/zip" },
                  body: file,
                });
                if (!r.ok) throw new Error(serverMessage((await r.json()).error));
                await onChange();
              } catch (e) {
                onError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          />
        </label>
      )}
    </section>
  );
}
