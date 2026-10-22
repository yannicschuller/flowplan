"use client";
import { MarkdownExportSettings, type MarkdownExportStatus, type SpaceGitOverview } from "./markdown-export-settings";
import { EncryptionSettings, type EncryptionStatus } from "./encryption-settings";
import { NumberField, SaveBar, SettingGroup, SettingRow, SwitchRow, UsageMeter } from "./settings-ui";
import { serverMessage } from "@/lib/i18n-errors";
import { LOCALE_TAG } from "@/lib/locale-tag";
import type { BuildInfo } from "@/lib/build-info";
import type { UpdateStatus } from "@/lib/update-check";
import { useLocale, useT } from "./i18n";
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
  ArrowCircleUp,
  Sparkle,
} from "@phosphor-icons/react";
import { AdminAi, AiUserSwitch } from "./ai-settings";
import { api, Avatar, Modal } from "./ui";
import { Select } from "./select";
import { AdminStorage } from "./admin-storage";
import { AdminDirectory } from "./admin-directory";
import { AdminOperations, AuditExport } from "./admin-operations";
import { SsoMappings, type SsoMappingRow } from "./sso-mappings";
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
  build?: BuildInfo;
  // A newer release than the running one (lib/update-check.ts).
  update?: UpdateStatus | null;
  userUsage?: {
    id: string;
    bytes: number;
    workspaces: number;
    limits: { storageMb?: number | null; workspaces?: number | null; uploadMb?: number | null };
    effective: { storageMb: number; workspaces: number; uploadMb: number };
  }[];
  oidcConfigured: boolean;
  // SSO groups mapped to workspaces (lib/sso-mappings.ts).
  ssoMappings?: SsoMappingRow[];
  workspaceGroups?: { id: string; workspace_id: string; name: string }[];
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
  localLogin?: boolean;
  localAccounts?: Record<string, { admin: boolean; verified: boolean; passkeys: number; totp?: boolean }>;
  mail: {
    configured: boolean;
    host: string | null;
    from: string | null;
    pending: number;
    failed: number;
    sentWeek: number;
    lastError: string | null;
  };
  markdownExport: MarkdownExportStatus;
  spaceGitExport: SpaceGitOverview;
  encryption: EncryptionStatus;
  backup: {
    enabled: boolean;
    hourly: boolean;
    encrypted: boolean;
    keep: number;
    target: "s3" | "local";
    last: { at: number; target: string; name: string; bytes: number; error: string | null } | null;
  };
  // Who may use AI when only selected people may (lib/ai/settings.ts).
  aiPolicy?: { access: "everyone" | "selected"; enabled: boolean; allowed: string[] };
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
// i18n-table: 1 – [German, English] pairs
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
    ["Zustand der Instanz: Speicher, Warteschlangen, abgewiesene Anfragen, Hintergrunddienste, Warnungen und Wartungshinweise.", "State of the instance: storage, queues, refused requests, background workers, alerts and maintenance notices."],
  ],
  [
    "instance",
    ["Instanz", "Instance"],
    SlidersHorizontal,
    ["Name, Hinweise, Grenzen und Sicherung der gesamten Instanz.", "Name, notices, limits and backup of the whole instance."],
  ],
  [
    "ai",
    ["KI", "AI"],
    Sparkle,
    ["Künstliche Intelligenz: Anbieter, wer sie nutzen darf und welche Funktionen es gibt. Standardmäßig aus.", "Artificial intelligence: provider, who may use it and which features exist. Off by default."],
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
  const locale = useLocale();
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
        {data.build && (
          <span className="admin-build" aria-label={t("Laufende Version", "Running version")}>
            {data.build.version && <strong>v{data.build.version}</strong>}
            {data.build.commit ? (
              <a href={`${data.build.repository}/commit/${data.build.commit}`} target="_blank" rel="noreferrer" title={t(`Commit ${data.build.commit} auf GitHub ansehen`, `View commit ${data.build.commit} on GitHub`)}>
                <code>{data.build.commit.slice(0, 7)}</code>
              </a>
            ) : (
              <span title={t("Beim Bauen war kein Commit bekannt (GIT_COMMIT oder SOURCE_COMMIT).", "No commit was known when building (GIT_COMMIT or SOURCE_COMMIT).")}>{t("Commit unbekannt", "commit unknown")}</span>
            )}
            {data.build.builtAt && (
              <span title={new Date(data.build.builtAt).toLocaleString(LOCALE_TAG)}>
                {t("gebaut", "built")} {new Date(data.build.builtAt).toLocaleDateString(LOCALE_TAG, { day: "numeric", month: "short", year: "numeric" })}
              </span>
            )}
          </span>
        )}
      </div>
      {data.update && (
        <div className="callout admin-update" role="status">
          <ArrowCircleUp size={20} aria-hidden="true" />
          <span>
            <strong>{t(`Flowplan ${data.update.latest} ist verfügbar.`, `Flowplan ${data.update.latest} is available.`)}</strong>{" "}
            {t(`Diese Instanz läuft mit ${data.update.current}.`, `This instance runs ${data.update.current}.`)}
          </span>
          <span className="admin-update-links">
            {data.update.url && (
              <a href={data.update.url} target="_blank" rel="noreferrer">
                {t("Was ist neu", "What's new")}
              </a>
            )}
            <a href={locale === "de" ? "https://docs.flowplan.org/de/installation#aktualisieren" : "https://docs.flowplan.org/en/installation#update"} target="_blank" rel="noreferrer">
              {t("So aktualisierst du", "How to update")}
            </a>
          </span>
        </div>
      )}
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
                    <UserRow
                      key={u.id}
                      user={u}
                      usage={data.userUsage?.find((x) => x.id === u.id)}
                      settings={data.settings}
                      ai={data.aiPolicy?.enabled && data.aiPolicy.access === "selected" ? { allowed: data.aiPolicy.allowed.includes(u.id), onChange: load } : null}
                      local={data.localAccounts?.[u.id]}
                      resetLink={resetLink?.userId === u.id ? resetLink.url : null}
                      act={act}
                      onResetLink={(url) => setResetLink({ userId: u.id, url })}
                    />
                  ))}
              </div>
            </section>
          )}
          {tab === "users" && <AdminDirectory onError={onError} />}
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
                                    : t("unbegrenzt", "unlimited")
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
          {tab === "workspaces" && (data.oidcConfigured || !!data.ssoMappings?.length) && (
            <section className="settings-section">
              <h2>{t("SSO-Gruppen zentral zuordnen", "Map SSO groups centrally")}</h2>
              <p className="muted">
                {t(
                  "Gruppen aus dem Identitätsanbieter geben bei jeder SSO-Anmeldung eine Rolle im gewählten Arbeitsbereich und/oder eine seiner Gruppen. Dieselben Zuordnungen sehen und pflegen die Eigentümer des Arbeitsbereichs in seinen Einstellungen.",
                  "Groups from the identity provider give a role in the chosen workspace and/or one of its groups at every SSO sign-in. The workspace's owners see and maintain the same mappings in its settings.",
                )}
              </p>
              <SsoMappings
                mappings={data.ssoMappings || []}
                groups={data.workspaceGroups || []}
                workspaces={data.workspaces}
                onAdd={async (workspaceId, m) => !!(await act({ action: "admin.ssoMapping.add", workspaceId, ...m }))}
                onDelete={(workspaceId, id) => act({ action: "admin.ssoMapping.delete", workspaceId, id })}
              />
            </section>
          )}
          {tab === "instance" && (
            <>
              <InstanceSettingsForm
                initial={data.settings}
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
              <EncryptionSettings status={data.encryption} onChange={load} onError={onError} />
              <MarkdownExportSettings status={data.markdownExport} spaceGit={data.spaceGitExport} onChange={load} onError={onError} />
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
                      t(`${data.metrics.pushPending} offen · ${data.metrics.pushFailed} fehlgeschlagen`, `${data.metrics.pushPending} pending · ${data.metrics.pushFailed} failed`),
                    ],
                    [
                      t("Suchindex", "Search index"),
                      data.metrics.searchBacklog
                        ? t(`${data.metrics.searchBacklog} Änderungen ausstehend`, `${data.metrics.searchBacklog} changes pending`)
                        : t("aktuell", "up to date"),
                    ],
                    [t("Erinnerungen", "Reminders"), String(data.metrics.reminders)],
                    [
                      t("Demos", "Demos"),
                      t(`${data.metrics.demosActive} laufen · ${data.metrics.demosStarted} insgesamt gestartet`, `${data.metrics.demosActive} running · ${data.metrics.demosStarted} started in total`) +
                        (data.settings.publicDemo ? "" : t(" · ausgeschaltet", " · switched off")),
                    ],
                    [
                      t("Standardkontingent", "Default quota"),
                      data.metrics.defaultQuotaMb
                        ? t(`${data.metrics.defaultQuotaMb} MB je Arbeitsbereich`, `${data.metrics.defaultQuotaMb} MB per workspace`)
                        : t("unbegrenzt", "unlimited"),
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
          {tab === "operations" && <AdminOperations onError={onError} />}
          {tab === "operations" && <AdminStorage onError={onError} />}
          {tab === "ai" && <AdminAi onError={onError} onChange={load} />}
          {tab === "audit" && (
            <section className="settings-section">
              <div className="settings-list-head">
                <h2>{t("Aktivitätsprotokoll", "Activity log")}</h2>
                <AuditExport />
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

const mbText = (bytes: number) => `${(bytes / 1024 / 1024).toLocaleString(LOCALE_TAG, { maximumFractionDigits: bytes < 10 * 1024 * 1024 ? 1 : 0 })} MB`;

// One account: who, when last seen, how much storage; "Verwalten" opens its
// limits (empty = the instance default) and actions.
function UserRow({
  user: u,
  usage,
  settings,
  ai,
  local,
  resetLink,
  act,
  onResetLink,
}: {
  // The AI switch, when only selected people may use AI.
  ai: { allowed: boolean; onChange: () => void } | null;
  user: User;
  usage?: NonNullable<AdminData["userUsage"]>[number];
  settings: InstanceSettings;
  local?: { admin: boolean; verified: boolean; passkeys: number; totp?: boolean };
  resetLink: string | null;
  act: (body: Record<string, unknown>) => Promise<unknown>;
  onResetLink: (url: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [limits, setLimits] = useState(usage?.limits || {});
  const [busy, setBusy] = useState(false);
  // Deleting: what would happen, shown before it happens.
  const [plan, setPlan] = useState<{
    removed: { name: string }[];
    handedOver: { name: string; to: string }[];
    kept: { name: string; disabled: number }[];
    privateSpaces: number;
  } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const clean = (l: object) => JSON.stringify(Object.entries(l).filter(([, v]) => v !== null && v !== undefined).sort());
  const changed = clean(limits) !== clean(usage?.limits || {});
  const storage = usage?.effective.storageMb ?? 0;
  const defaults = {
    storage: settings.defaultUserStorageMb ? `${settings.defaultUserStorageMb} MB` : t("unbegrenzt", "unlimited"),
    workspaces: settings.defaultUserWorkspaces ? String(settings.defaultUserWorkspaces) : t("unbegrenzt", "unlimited"),
    upload: `${settings.maxUploadMb} MB`,
  };
  const panel = `user-panel-${u.id}`;
  return (
    <div className={`user-row${u.disabled ? " is-disabled" : ""}${open ? " open" : ""}`}>
      <div className="user-row-summary">
        <Avatar name={u.name} userId={u.id} />
        <span className="user-row-who">
          <strong>{u.name}</strong>
          <small>
            {u.email} ·{" "}
            {u.last_login_at
              ? t(`zuletzt angemeldet ${new Date(u.last_login_at).toLocaleDateString(LOCALE_TAG)}`, `last signed in ${new Date(u.last_login_at).toLocaleDateString(LOCALE_TAG)}`)
              : t("noch nie angemeldet", "never signed in")}
          </small>
        </span>
        <span className="user-row-chips">
          {ai && <AiUserSwitch userId={u.id} name={u.name} allowed={ai.allowed} onChange={ai.onChange} />}
          {!!u.disabled && <span className="status-chip muted-chip">{t("Deaktiviert", "Disabled")}</span>}
          {local?.admin && <span className="status-chip">{t("Admin", "Admin")}</span>}
          {local && !local.verified && (
            <span className="status-chip warning-chip" title={t("Die Person hat den Link aus der Bestätigungs-E-Mail noch nicht geöffnet.", "The person has not opened the link from the confirmation e-mail yet.")}>
              {t("E-Mail unbestätigt", "E-mail unconfirmed")}
            </span>
          )}
          {local && (
            <span className="status-chip muted-chip" title={t("Meldet sich mit E-Mail und Passwort an", "Signs in with email and password")}>
              E-Mail{local.passkeys ? ` · ${local.passkeys} Passkey` : ""}
            </span>
          )}
          {local && (
            <span
              className={`status-chip ${local.totp || local.passkeys ? "" : "muted-chip"}`}
              title={t("Zwei-Faktor-Anmeldung: Authenticator-App oder Passkey", "Two-factor sign-in: authenticator app or passkey")}
            >
              {local.totp ? t("2FA an", "2FA on") : local.passkeys ? t("2FA per Passkey", "2FA via passkey") : t("2FA aus", "2FA off")}
            </span>
          )}
          {usage && (
            <span className="user-row-storage" title={t("Belegter Speicher", "Storage used")}>
              {mbText(usage.bytes)}
              {storage ? ` / ${storage} MB` : ""}
            </span>
          )}
        </span>
        <button type="button" className="button compact" aria-expanded={open} aria-controls={panel} onClick={() => setOpen(!open)}>
          {t("Verwalten", "Manage")}
        </button>
      </div>
      {open && (
        <div className="user-row-panel" id={panel}>
          {usage && (
            <div className="user-row-meters">
              <UsageMeter label={t("Speicher", "Storage")} used={usage.bytes} limit={storage * 1024 * 1024} format={mbText} />
              <UsageMeter label={t("Eigene Arbeitsbereiche", "Own workspaces")} used={usage.workspaces} limit={usage.effective.workspaces} format={(n) => String(n)} />
            </div>
          )}
          <form
            className="user-row-limits"
            aria-label={t(`Grenzen für ${u.name}`, `Limits for ${u.name}`)}
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await act({ action: "admin.userLimits", userId: u.id, limits });
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              <span>{t("Speicher", "Storage")}</span>
              <NumberField label={t(`Speicher für ${u.name}`, `Storage for ${u.name}`)} value={limits.storageMb} unit="MB" placeholder={t(`Standard: ${defaults.storage}`, `Default: ${defaults.storage}`)} onChange={(storageMb) => setLimits({ ...limits, storageMb })} />
            </label>
            <label>
              <span>{t("Arbeitsbereiche", "Workspaces")}</span>
              <NumberField label={t(`Eigene Arbeitsbereiche für ${u.name}`, `Own workspaces for ${u.name}`)} value={limits.workspaces} max={10000} placeholder={t(`Standard: ${defaults.workspaces}`, `Default: ${defaults.workspaces}`)} onChange={(workspaces) => setLimits({ ...limits, workspaces })} />
            </label>
            <label>
              <span>{t("Größte Datei", "Largest file")}</span>
              <NumberField label={t(`Größte Datei für ${u.name}`, `Largest file for ${u.name}`)} value={limits.uploadMb} min={1} max={1024} unit="MB" placeholder={t(`Standard: ${defaults.upload}`, `Default: ${defaults.upload}`)} onChange={(uploadMb) => setLimits({ ...limits, uploadMb })} />
            </label>
            <button className="button primary compact" disabled={!changed || busy}>
              {busy ? t("Speichert …", "Saving …") : t("Grenzen speichern", "Save limits")}
            </button>
            <small className="muted">{t("Leer = Standard der Instanz, 0 = unbegrenzt. Für Admins gelten keine Grenzen.", "Empty = instance default, 0 = unlimited. Admins are not limited.")}</small>
          </form>
          <div className="user-row-actions">
            {local && (
              <>
                <button type="button" className="button compact" onClick={() => act({ action: "admin.localAdmin", userId: u.id, admin: !local.admin })}>
                  {local.admin ? t("Admin entziehen", "Revoke admin") : t("Zum Admin machen", "Make admin")}
                </button>
                <button
                  type="button"
                  className="button compact"
                  onClick={async () => {
                    const result = (await act({ action: "admin.resetLink", userId: u.id })) as { url?: string } | undefined;
                    if (result?.url) onResetLink(result.url);
                  }}
                >
                  {t("Link zum Zurücksetzen", "Reset link")}
                </button>
                {local.totp && (
                  <button
                    type="button"
                    className="button compact"
                    title={t("Etwa bei verlorenem Telefon. Die Person wird per E-Mail informiert.", "E.g. for a lost phone. The person is told by e-mail.")}
                    onClick={() => {
                      if (confirm(t(`Authenticator-App für ${u.name} ausschalten? Danach meldet sich ${u.name} nur mit Passwort (oder Passkey) an und kann sie neu einrichten.`, `Turn off the authenticator app for ${u.name}? ${u.name} then signs in with the password (or a passkey) and can set it up again.`)))
                        void act({ action: "admin.twoFactorReset", userId: u.id });
                    }}
                  >
                    {t("Zwei-Faktor zurücksetzen", "Reset two-factor")}
                  </button>
                )}
              </>
            )}
            <button type="button" className="button compact" onClick={() => act({ action: "admin.revoke", userId: u.id })}>
              {t("Sitzungen beenden", "End sessions")}
            </button>
            {local && !local.verified && (
              <button type="button" className="button compact" onClick={() => act({ action: "admin.confirmEmail", userId: u.id })}>
                {t("E-Mail als bestätigt markieren", "Mark e-mail as confirmed")}
              </button>
            )}
            <button type="button" className={`button compact ${u.disabled ? "" : "danger"}`} onClick={() => act({ action: "admin.user", userId: u.id, disabled: !u.disabled })}>
              {u.disabled ? t("Aktivieren", "Enable") : t("Deaktivieren", "Disable")}
            </button>
            {!!u.disabled && (
              <button
                type="button"
                className="button compact danger"
                onClick={async () => {
                  const result = (await act({ action: "admin.deletePlan", userId: u.id })) as typeof plan;
                  if (result) setPlan(result);
                }}
              >
                {t("Konto löschen …", "Delete account …")}
              </button>
            )}
          </div>
          {!u.disabled && (
            <small className="muted">{t("Löschen ist möglich, sobald das Konto deaktiviert ist.", "Deleting is possible once the account is disabled.")}</small>
          )}
          <Modal open={!!plan} onClose={() => !deleting && setPlan(null)} title={t(`${u.name} löschen?`, `Delete ${u.name}?`)}>
            {plan && (
              <div className="delete-account">
                <p>{t("Das lässt sich nicht rückgängig machen.", "This cannot be undone.")}</p>
                <ul>
                  <li>{t("Name, E-Mail-Adresse, Passwort, Passkeys, Sitzungen und persönliche Einstellungen werden gelöscht.", "Name, e-mail address, password, passkeys, sessions and personal settings are deleted.")}</li>
                  {plan.removed.length > 0 && (
                    <li>
                      {t("Diese Arbeitsbereiche hatten nur diese Person als Mitglied und werden mit allen Inhalten gelöscht:", "These workspaces had only this person as a member and are deleted with all content:")}{" "}
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
                  <li>{t("Beiträge in gemeinsamen Arbeitsbereichen (Seiten, Einträge, Kommentare, Dateien) bleiben und erscheinen als „Gelöschtes Konto“.", "Contributions to shared workspaces (pages, records, comments, files) stay and appear as “Deleted account”.")}</li>
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
                        if (await act({ action: "admin.deleteUser", userId: u.id })) setPlan(null);
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
          {resetLink && (
            <label className="reset-link">
              {t(`Zwei Stunden gültig – an ${u.name} weitergeben:`, `Valid for two hours – send to ${u.name}:`)}
              <input readOnly value={resetLink} onFocus={(e) => e.currentTarget.select()} />
            </label>
          )}
        </div>
      )}
    </div>
  );
}

// Instance-wide settings in groups; empty numbers fall back to the
// environment. Changes are kept as a draft until saved.
function InstanceSettingsForm({
  initial,
  localLogin,
  onSave,
}: {
  initial: InstanceSettings;
  localLogin: boolean;
  onSave: (settings: InstanceSettings) => Promise<void>;
}) {
  const t = useT();
  const [saved, setSaved] = useState(initial),
    [draft, setDraft] = useState(initial),
    [busy, setBusy] = useState(false),
    [done, setDone] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const set = (patch: Partial<InstanceSettings>) => {
    setDone(false);
    setDraft({ ...draft, ...patch });
  };
  const env = t("aus der Umgebung", "from the environment");
  const unlimited = t("unbegrenzt", "unlimited");
  return (
    <form
      className="instance-settings"
      aria-label={t("Instanzeinstellungen", "Instance settings")}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await onSave(draft);
          setSaved(draft);
          setDone(true);
        } finally {
          setBusy(false);
        }
      }}
    >
      <SettingGroup title={t("Allgemein", "General")} description={t("Wie die Instanz heißt und was alle oben sehen.", "What the instance is called and what everyone sees at the top.")}>
        <SettingRow id="instance-name" label={t("Name der Instanz", "Instance name")} description={t("Erscheint bei der Anmeldung und im Browser-Tab.", "Shown when signing in and in the browser tab.")}>
          <input id="instance-name" maxLength={60} placeholder={t("z. B. Flowplan der Muster GmbH", "e.g. Flowplan of Example Ltd")} value={draft.name} onChange={(e) => set({ name: e.target.value })} />
        </SettingRow>
        <SettingRow wide id="instance-notice" label={t("Hinweis für alle Personen", "Notice for everyone")} description={t("Ein Banner über jeder Seite, etwa für Wartungsarbeiten. Leer = kein Hinweis.", "A banner above every page, e.g. for maintenance. Empty = no notice.")}>
          <textarea id="instance-notice" maxLength={500} rows={2} placeholder={t("z. B. Wartung am Samstag ab 18 Uhr", "e.g. Maintenance on Saturday from 6 pm")} value={draft.announcement} onChange={(e) => set({ announcement: e.target.value })} />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title={t("Zugang", "Access")} description={t("Wer ein Konto bekommt und was neue Personen dürfen.", "Who gets an account and what new people may do.")}>
        {localLogin && (
          <SwitchRow
            label={t("Registrierung mit E-Mail und Passwort", "Sign-up with email and password")}
            description={t("Ausgeschaltet legen nur eingeladene Adressen ein Konto an. Das erste Konto einer Instanz verwaltet sie.", "When off, only invited addresses can create an account. The first account of an instance administers it.")}
            checked={!!draft.allowSignup}
            onChange={(allowSignup) => set({ allowSignup })}
          />
        )}
        {localLogin && (
          <SettingRow
            id="instance-two-factor"
            label={t("Zwei-Faktor-Anmeldung verlangen", "Require two-factor sign-in")}
            description={t(
              "Für Konten mit E-Mail und Passwort: Authenticator-App oder Passkey. Wer noch keinen zweiten Faktor hat, richtet ihn direkt nach der Anmeldung ein. SSO-Konten regelt der Anbieter.",
              "For accounts with email and password: authenticator app or passkey. Whoever has no second factor yet sets one up right after signing in. SSO accounts are handled by the provider.",
            )}
          >
            <Select id="instance-two-factor" value={draft.twoFactor || "off"} onChange={(e) => set({ twoFactor: e.target.value as InstanceSettings["twoFactor"] })}>
              <option value="off">{t("Nicht verlangen", "Not required")}</option>
              <option value="admins">{t("Nur für Admins", "Only for admins")}</option>
              <option value="all">{t("Für alle lokalen Konten", "For all local accounts")}</option>
            </Select>
          </SettingRow>
        )}
        <SwitchRow
          label={t("Alle dürfen Arbeitsbereiche anlegen", "Everyone may create workspaces")}
          description={t("Ausgeschaltet legen nur Admins neue Arbeitsbereiche an.", "When off, only admins create new workspaces.")}
          checked={draft.allowWorkspaceCreation}
          onChange={(allowWorkspaceCreation) => set({ allowWorkspaceCreation })}
        />
        <SwitchRow
          label={t("Öffentliche Demo", "Public demo")}
          description={t("Besucher bekommen unter /demo ohne Konto einen Arbeitsbereich mit Beispielen. Er verschwindet nach 45 Minuten ohne Aktivität (spätestens nach 3 Stunden). Demos können nichts veröffentlichen, teilen oder einladen.", "Visitors get a workspace with examples at /demo without an account. It disappears after 45 minutes without activity (3 hours at the latest). Demos cannot publish, share or invite.")}
          checked={!!draft.publicDemo}
          onChange={(publicDemo) => set({ publicDemo })}
        />
        <SettingRow label={t("Inaktive Konten sperren", "Block inactive accounts")} description={t("Nach so vielen Tagen ohne Anmeldung (mindestens 30). Leer = nie.", "After this many days without signing in (at least 30). Empty = never.")}>
          <NumberField label={t("Inaktive Konten sperren nach Tagen", "Block inactive accounts after days")} value={draft.inactiveDays} min={30} max={3650} unit={t("Tage", "days")} placeholder={t("nie", "never")} onChange={(inactiveDays) => set({ inactiveDays })} />
        </SettingRow>
      </SettingGroup>

      <SettingGroup
        title={t("Speicher und Grenzen", "Storage and limits")}
        description={t("Standardwerte für alle. Einzelne Arbeitsbereiche und Personen lassen sich in ihren Reitern abweichend einstellen. 0 = unbegrenzt; Admins sind nicht begrenzt.", "Defaults for everyone. Individual workspaces and people can differ in their tabs. 0 = unlimited; admins are not limited.")}
      >
        <SettingRow label={t("Speicher je Arbeitsbereich", "Storage per workspace")} description={t("Dateien und Bilder aller Mitglieder zusammen.", "Files and images of all members together.")}>
          <NumberField label={t("Speicher je Arbeitsbereich", "Storage per workspace")} value={draft.defaultQuotaMb} unit="MB" placeholder={env} onChange={(defaultQuotaMb) => set({ defaultQuotaMb })} />
        </SettingRow>
        <SettingRow label={t("Speicher je Person", "Storage per person")} description={t("Alles, was eine Person hochlädt oder kopiert – über alle Arbeitsbereiche.", "Everything a person uploads or copies – across all workspaces.")}>
          <NumberField label={t("Speicher je Person", "Storage per person")} value={draft.defaultUserStorageMb} unit="MB" placeholder={unlimited} onChange={(defaultUserStorageMb) => set({ defaultUserStorageMb })} />
        </SettingRow>
        <SettingRow label={t("Eigene Arbeitsbereiche je Person", "Own workspaces per person")} description={t("Wie viele Arbeitsbereiche eine Person besitzen darf.", "How many workspaces a person may own.")}>
          <NumberField label={t("Eigene Arbeitsbereiche je Person", "Own workspaces per person")} value={draft.defaultUserWorkspaces} unit="" placeholder={unlimited} max={10000} onChange={(defaultUserWorkspaces) => set({ defaultUserWorkspaces })} />
        </SettingRow>
        <SettingRow label={t("Größte Datei beim Hochladen", "Largest upload")} description={t("Für jede einzelne Datei; je Person änderbar.", "For each single file; can differ per person.")}>
          <NumberField label={t("Größte Datei beim Hochladen", "Largest upload")} value={draft.maxUploadMb} min={1} max={1024} unit="MB" required onChange={(maxUploadMb) => set({ maxUploadMb: maxUploadMb ?? 1 })} />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title={t("Versionen und Sicherung", "Versions and backup")}>
        <SettingRow label={t("Versionen aufbewahren", "Keep versions")} description={t("Ältere Versionsstände von Seiten werden danach gelöscht. 0 = für immer.", "Older page versions are deleted afterwards. 0 = forever.")}>
          <NumberField label={t("Versionen aufbewahren", "Keep versions")} value={draft.retentionDays} max={36500} unit={t("Tage", "days")} placeholder={env} onChange={(retentionDays) => set({ retentionDays })} />
        </SettingRow>
        <SwitchRow
          label={t("Tägliche Datenbanksicherung", "Daily database backup")}
          description={
            <>
              {t("Eine Kopie pro Tag – mit S3 in den Bucket (Ordner", "One copy per day – with S3 into the bucket (folder")} <code>backups/</code>
              {t("), sonst in den Datenordner.", "), otherwise into the data folder.")}
            </>
          }
          checked={draft.backupSchedule !== false}
          onChange={(backupSchedule) => set({ backupSchedule })}
        />
        <SwitchRow
          label={t("Stündlich statt täglich", "Hourly instead of daily")}
          description={t(
            "Für verschlüsselte Sicherungen anstelle von Litestream (FLOWPLAN_LITESTREAM=off). Dann mehr Sicherungen aufbewahren, z. B. 72 für drei Tage.",
            "For encrypted backups in place of Litestream (FLOWPLAN_LITESTREAM=off). Keep more backups then, e.g. 72 for three days.",
          )}
          checked={draft.backupInterval === "hourly"}
          disabled={draft.backupSchedule === false}
          onChange={(hourly) => set({ backupInterval: hourly ? "hourly" : "daily" })}
        />
        <SettingRow label={t("Aufbewahrte Sicherungen", "Backups kept")} description={t("Die ältesten werden danach entfernt.", "The oldest are removed afterwards.")}>
          <NumberField label={t("Aufbewahrte Sicherungen", "Backups kept")} value={draft.backupKeep ?? 7} min={1} max={365} unit={t("Stück", "copies")} onChange={(backupKeep) => set({ backupKeep: backupKeep ?? 7 })} />
        </SettingRow>
      </SettingGroup>
      <SaveBar
        dirty={dirty}
        busy={busy}
        onDiscard={() => setDraft(saved)}
        message={t("Ungespeicherte Änderungen", "Unsaved changes")}
        saveLabel={busy ? t("Speichert …", "Saving …") : t("Speichern", "Save")}
        discardLabel={t("Verwerfen", "Discard")}
      />
      {done && !dirty && <p role="status" className="muted small">{t("Gespeichert.", "Saved.")}</p>}
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
        <h2>{t("E-Mail-Versand", "Sending e-mail")}</h2>
        {mail.configured ? (
          <p>
            SMTP: <code>{mail.host}</code> {t("als", "as")}{" "}<code>{mail.from}</code> ·{" "}
            {mail.pending} {t("in der Warteschlange ·", "queued ·")}{" "}{mail.sentWeek} {t("gesendet (7 Tage)", "sent (7 days)")}
            {mail.failed > 0 && t(` · ${mail.failed} aufgegeben`, ` · ${mail.failed} given up`)}
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
          {backup.enabled ? (backup.hourly ? t("Stündlich", "Hourly") : t("Täglich", "Daily")) : t("Ausgeschaltet", "Off")} ·{" "}
          {backup.encrypted ? t("verschlüsselt", "encrypted") : t("unverschlüsselt", "unencrypted")} ·{" "}
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
            accept=".zip,.enc"
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
