"use client";
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
  `${(bytes / 1024 / 1024).toLocaleString("de-DE", { maximumFractionDigits: 1 })} MB`;
const duration = (seconds: number) =>
  seconds < 3600
    ? `${Math.round(seconds / 60)} Min.`
    : seconds < 86400
      ? `${Math.round(seconds / 3600)} Std.`
      : `${Math.round(seconds / 86400)} Tage`;
const adminTabs = [
  [
    "users",
    "Benutzer",
    Users,
    "Konten der Instanz: Sitzungen beenden, sperren und wieder freigeben.",
  ],
  [
    "workspaces",
    "Arbeitsbereiche",
    Stack,
    "Alle Arbeitsbereiche mit Belegung und Speicherkontingent.",
  ],
  [
    "operations",
    "Betrieb",
    Gauge,
    "Zustand der Instanz: Speicher, Warteschlangen, Suchindex und Laufzeit.",
  ],
  [
    "instance",
    "Instanz",
    SlidersHorizontal,
    "Name, Hinweise, Grenzen und Sicherung der gesamten Instanz.",
  ],
  [
    "audit",
    "Aktivitätsprotokoll",
    ListChecks,
    "Die letzten Änderungen mit Person und betroffener Ressource.",
  ],
] as const;
const auditTime = (value: string) => {
  const date = new Date(
    /[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : value.replace(" ", "T") + "Z",
  );
  return Number.isFinite(date.getTime())
    ? date.toLocaleString("de-DE", {
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
      await mutate(b);
      await load();
    } catch (e) {
      onError((e as Error).message);
    }
  }
  if (!data)
    return <div className="loading-content">Administration wird geladen …</div>;
  return (
    <div className="utility-content admin-page">
      <div className="utility-title">
        <ShieldCheck size={32} />
        <h1>Administration</h1>
        <p>Benutzer, Arbeitsbereiche und Zugriffe deiner Flowplan-Instanz.</p>
      </div>
      <div className="admin-stats">
        <div>
          <Users />
          <strong>{data.users.length}</strong>
          <span>Benutzer</span>
        </div>
        <div>
          <Stack />
          <strong>{data.workspaces.length}</strong>
          <span>Arbeitsbereiche</span>
        </div>
        <div>
          <Key />
          <strong>{data.sessions}</strong>
          <span>Aktive Sitzungen</span>
        </div>
      </div>
      <div className="callout">
        <ShieldCheck size={20} />
        <span>
          Admin-Gruppe: <strong>{data.adminGroup}</strong> · OIDC{" "}
          {data.oidcConfigured ? "konfiguriert" : "nicht konfiguriert"}
        </span>
      </div>
      <div className="settings-layout">
        <nav className="settings-tabs" aria-label="Bereiche der Administration">
          {adminTabs.map(([id, label, Icon]) => (
            <button
              key={id}
              className={tab === id ? "selected" : ""}
              aria-current={tab === id ? "page" : undefined}
              onClick={() => setTab(id)}
            >
              <Icon size={18} aria-hidden="true" />
              {label}
            </button>
          ))}
          <button
            className="settings-refresh"
            title="Aktualisieren"
            aria-label="Aktualisieren"
            onClick={() => load()}
          >
            <ArrowCounterClockwise size={16} aria-hidden="true" />
            Aktualisieren
          </button>
        </nav>
        <div className="settings-body">
          <p className="settings-intro">
            {adminTabs.find(([id]) => id === tab)?.[3]}
          </p>
          {tab === "users" && (
            <section className="settings-section">
              <div className="settings-list-head">
                <h2>Benutzer · {data.users.length}</h2>
                <input
                  type="search"
                  aria-label="Benutzer suchen"
                  placeholder="Name oder E-Mail suchen …"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <Select
                  aria-label="Status"
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                >
                  <option value="all">Alle</option>
                  <option value="active">Aktiv</option>
                  <option value="disabled">Deaktiviert</option>
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
                            ? `zuletzt angemeldet ${new Date(u.last_login_at).toLocaleDateString("de-DE")}`
                            : "noch nie angemeldet"}
                        </small>
                      </span>
                      {!!u.disabled && (
                        <span className="status-chip muted-chip">
                          Deaktiviert
                        </span>
                      )}
                      <button
                        className="button compact"
                        onClick={() =>
                          act({ action: "admin.revoke", userId: u.id })
                        }
                      >
                        Sitzungen beenden
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
                        {u.disabled ? "Aktivieren" : "Deaktivieren"}
                      </button>
                    </div>
                  ))}
              </div>
            </section>
          )}
          {tab === "workspaces" && (
            <section className="settings-section">
              <div className="settings-list-head">
                <h2>Arbeitsbereiche · {data.workspaces.length}</h2>
                <input
                  type="search"
                  aria-label="Arbeitsbereiche suchen"
                  placeholder="Arbeitsbereich suchen …"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <div className="data-table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Arbeitsbereich</th>
                      <th>Mitglieder</th>
                      <th>Seiten</th>
                      <th>Speicher</th>
                      <th>Kontingent (MB)</th>
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
                                  aria-label={`Belegung ${w.name}`}
                                />
                              )}
                            </td>
                            <td>
                              <input
                                type="number"
                                min={0}
                                className="quota-input"
                                aria-label={`Kontingent ${w.name}`}
                                placeholder={
                                  data.metrics.defaultQuotaMb
                                    ? `Standard ${data.metrics.defaultQuotaMb}`
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
                onSave={(settings) =>
                  act({ action: "admin.settings", settings })
                }
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
              <h2>Betriebsmetriken</h2>
              <div className="admin-metrics" aria-label="Betriebsmetriken">
                {(
                  [
                    ["Datenbank", mb(data.metrics.databaseBytes)],
                    [
                      "Uploads",
                      `${mb(data.metrics.uploadBytes)} · ${data.metrics.files} Dateien`,
                    ],
                    [
                      "Seiten",
                      `${data.metrics.pages} aktiv · ${data.metrics.trashedPages} im Papierkorb`,
                    ],
                    ["Datensätze", String(data.metrics.rows)],
                    [
                      "Versionen",
                      `${data.metrics.snapshots} · Aufbewahrung ${data.metrics.retentionDays ? `${data.metrics.retentionDays} Tage` : "unbegrenzt"}`,
                    ],
                    [
                      "Push-Warteschlange",
                      `${data.metrics.pushPending} offen · ${data.metrics.pushFailed} fehlgeschlagen`,
                    ],
                    [
                      "Suchindex",
                      data.metrics.searchBacklog
                        ? `${data.metrics.searchBacklog} Änderungen ausstehend`
                        : "aktuell",
                    ],
                    ["Erinnerungen", String(data.metrics.reminders)],
                    [
                      "Demos",
                      `${data.metrics.demosActive} laufen · ${data.metrics.demosStarted} insgesamt gestartet${data.settings.publicDemo ? "" : " · ausgeschaltet"}`,
                    ],
                    [
                      "Standardkontingent",
                      data.metrics.defaultQuotaMb
                        ? `${data.metrics.defaultQuotaMb} MB je Arbeitsbereich`
                        : "unbegrenzt",
                    ],
                    [
                      "Laufzeit",
                      `${duration(data.metrics.uptimeSeconds)} · Node ${data.metrics.node}`,
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
                <h2>Aktivitätsprotokoll</h2>
                <a className="button compact" href="/api/admin/audit.csv" download>
                  Als CSV exportieren
                </a>
                <input
                  type="search"
                  aria-label="Protokoll durchsuchen"
                  placeholder="Person oder Aktion suchen …"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <div className="data-table-scroll">
                <table className="data-table audit-table">
                  <thead>
                    <tr>
                      <th>Zeitpunkt</th>
                      <th>Person</th>
                      <th>Aktion</th>
                      <th>Ressource</th>
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
                          <td>{a.name || "System"}</td>
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

// Instance-wide settings; empty numbers fall back to the environment.
function InstanceSettingsForm({
  initial,
  publicSite,
  onSave,
}: {
  initial: InstanceSettings;
  publicSite: boolean;
  onSave: (settings: InstanceSettings) => Promise<void>;
}) {
  const [draft, setDraft] = useState(initial),
    [saved, setSaved] = useState(false);
  const optional = (value: string) =>
    value.trim() === "" ? null : Math.max(0, Math.round(Number(value)));
  return (
    <form
      className="settings-section instance-settings"
      aria-label="Instanzeinstellungen"
      onSubmit={async (e) => {
        e.preventDefault();
        setSaved(false);
        await onSave(draft);
        setSaved(true);
      }}
    >
      <h2>Instanz</h2>
      <p>
        Leere Felder übernehmen die Werte aus der Umgebung (Konfigurationsdatei
        oder Umgebungsvariablen).
      </p>
      <label>
        Name der Instanz
        <input
          maxLength={60}
          placeholder="z. B. Flowplan der Muster GmbH"
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />
      </label>
      <label>
        Hinweis für alle Personen
        <textarea
          maxLength={500}
          rows={2}
          placeholder="z. B. Wartung am Samstag ab 18 Uhr"
          value={draft.announcement}
          onChange={(e) => setDraft({ ...draft, announcement: e.target.value })}
        />
      </label>
      <label>
        Standard-Speicherkontingent je Arbeitsbereich (MB, 0 = unbegrenzt)
        <input
          type="number"
          min={0}
          placeholder="Wert aus der Umgebung"
          value={draft.defaultQuotaMb ?? ""}
          onChange={(e) =>
            setDraft({ ...draft, defaultQuotaMb: optional(e.target.value) })
          }
        />
      </label>
      <label>
        Versionen aufbewahren (Tage, 0 = unbegrenzt)
        <input
          type="number"
          min={0}
          placeholder="Wert aus der Umgebung"
          value={draft.retentionDays ?? ""}
          onChange={(e) =>
            setDraft({ ...draft, retentionDays: optional(e.target.value) })
          }
        />
      </label>
      <label>
        Größte Datei beim Hochladen (MB)
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
        Alle Personen dürfen Arbeitsbereiche anlegen
      </label>
      {publicSite && (
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={!!draft.publicDemo}
          onChange={(e) => setDraft({ ...draft, publicDemo: e.target.checked })}
        />
        <span>
          Demo auf der Startseite anbieten
          <small className="muted">
            Besucher erhalten ohne Konto einen eigenen Arbeitsbereich mit
            Beispielen. Er wird nach 45 Minuten ohne Aktivität (spätestens
            nach 3 Stunden) oder mit „Demo beenden“ gelöscht. Demo-Konten
            können nichts veröffentlichen, teilen oder einladen.
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
          Tägliche Datenbanksicherung
          <small className="muted">
            Eine Kopie der Datenbank pro Tag – mit S3 in den Bucket
            (Ordner <code>backups/</code>), sonst in den Datenordner.
          </small>
        </span>
      </label>
      <label>
        Aufbewahrte Sicherungen
        <input
          type="number"
          min={1}
          max={365}
          value={draft.backupKeep ?? 7}
          onChange={(e) => setDraft({ ...draft, backupKeep: Math.max(1, Number(e.target.value) || 1) })}
        />
      </label>
      <label>
        Konten ohne Anmeldung sperren nach (Tagen)
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
      <button className="button primary">Einstellungen speichern</button>
      {saved && <p role="status">Gespeichert.</p>}
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
            SMTP: <code>{mail.host}</code> als <code>{mail.from}</code> ·{" "}
            {mail.pending} in der Warteschlange · {mail.sentWeek} gesendet (7 Tage)
            {mail.failed > 0 && ` · ${mail.failed} aufgegeben`}
          </p>
        ) : (
          <p className="muted">
            Nicht eingerichtet. Mit <code>SMTP_HOST</code>, <code>SMTP_PORT</code>,{" "}
            <code>SMTP_USER</code>, <code>SMTP_PASSWORD</code> und <code>SMTP_FROM</code>{" "}
            verschickt Flowplan Einladungen und Zusammenfassungen ungelesener
            Benachrichtigungen.
          </p>
        )}
        {mail.lastError && <p className="error">Letzter Fehler: {mail.lastError}</p>}
        {mail.configured && (
          <form
            className="integration-form"
            onSubmit={(e) => {
              e.preventDefault();
              void post("/api/admin/mail-test", { to }, `Test-E-Mail an ${to} gesendet.`);
            }}
          >
            <input
              type="email"
              required
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="E-Mail-Adresse"
              aria-label="Empfänger der Test-E-Mail"
            />
            <button className="button" disabled={!!busy}>
              Test-E-Mail senden
            </button>
          </form>
        )}
      </section>
      <section className="settings-section">
        <h2>Geplante Sicherung</h2>
        <p>
          {backup.enabled ? "Täglich" : "Ausgeschaltet"} ·{" "}
          {backup.target === "s3" ? "in den S3-Bucket" : "in den Datenordner"} · die neuesten{" "}
          {backup.keep} bleiben erhalten.
        </p>
        {backup.last && (
          <p className={backup.last.error ? "error" : "muted"}>
            Letzte Sicherung {new Date(backup.last.at).toLocaleString("de-DE")}:{" "}
            {backup.last.error
              ? backup.last.error
              : `${backup.last.name} (${(backup.last.bytes / 1048576).toFixed(1)} MB)`}
          </p>
        )}
        <button
          className="button"
          disabled={!!busy}
          onClick={() => void post("/api/admin/backup-run", {}, "Sicherung erstellt.")}
        >
          {busy === "/api/admin/backup-run" ? "Sichert …" : "Jetzt sichern"}
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
  const [busy, setBusy] = useState(false);
  return (
    <section
      className="settings-section instance-backup"
      aria-label="Instanzsicherung"
    >
      <h2>Sicherung der gesamten Instanz</h2>
      <p className="muted">
        Enthält alle Arbeitsbereiche, Konten, Einstellungen und Dateien. Die
        Datei enthält vertrauliche Daten und sollte sicher verwahrt werden.
      </p>
      <a className="button" href="/api/admin/instance-backup" download>
        Sicherung herunterladen
      </a>
      <h3>Aus Sicherung wiederherstellen</h3>
      <p className="muted">
        Die hochgeladene Sicherung wird geprüft und beim nächsten Neustart des
        Servers übernommen. Der bisherige Stand bleibt im Datenordner als
        „pre-restore-…“ erhalten. Alle Sitzungen enden mit der Übernahme.
      </p>
      {pending ? (
        <div className="callout" role="status">
          <span>
            Bereit zur Übernahme beim Neustart: Sicherung vom{" "}
            {pending.createdAt
              ? new Date(pending.createdAt).toLocaleString("de-DE")
              : "unbekannten Datum"}{" "}
            mit {pending.workspaces} Arbeitsbereichen, {pending.pages} Seiten,{" "}
            {pending.users} Konten und {pending.files} Dateien.
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
                if (!r.ok) throw new Error((await r.json()).error);
                await onChange();
              } catch (e) {
                onError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Wiederherstellung abbrechen
          </button>
        </div>
      ) : (
        <label className="button file-label">
          {busy ? "Sicherung wird geprüft …" : "Sicherung auswählen"}
          <input
            type="file"
            accept=".zip"
            hidden
            aria-label="Instanzsicherung hochladen"
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
                if (!r.ok) throw new Error((await r.json()).error);
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
