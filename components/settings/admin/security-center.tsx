"use client";
// Administration → Sicherheit (/api/admin/security, every 30 s while
// visible): the state at a glance, open incidents of the detection rules
// with what to do about them, addresses with failed sign-ins, the security
// events, signed-in people, open ways in (API tokens, share links, public
// pages), blocked addresses and how the events leave the instance.
// Anchors: #admin/threats/<incidents|addresses|events|sessions|access|blocks|setup>;
// an incident's own page: #admin/threats/incident/<id>.
import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeft, CheckCircle, DownloadSimple, Info, ShieldCheck, ShieldWarning, WarningCircle } from "@phosphor-icons/react";
import type { securityIncident, securityOverview, securityEvents } from "@/lib/security-admin";
import { securityKinds, securityRules, type SecurityKind, type SecurityRule } from "@/lib/security-kinds";
import { securityPlaybooks, type PlaybookStep } from "@/lib/security-playbooks";
import { useT } from "../../i18n";
import { api } from "../../ui";
import { BarChart, Legend } from "../../charts";
import { EmptyState, ResponsiveTable, SettingGroup, StatusBadge, type Tone } from "../../settings-ui";
import { useAdmin } from "../admin-context";
import { AdminLoading } from "../shell";
import { Kpi, LiveBadge } from "./live";
import { useLive } from "./use-live";
import { ago, clock, dateTime, num } from "./monitoring-format";
import { useDocs } from "./parts";

type Overview = ReturnType<typeof securityOverview>;
type EventPage = ReturnType<typeof securityEvents>;
type SecurityEventRow = EventPage["events"][number];
type Incident = Overview["incidents"][number];
type IncidentDetailData = ReturnType<typeof securityIncident>;
type T = (de: string, en: string) => string;

const URL = "/api/admin/security";
const tone = (severity: string): Tone => (severity === "critical" ? "error" : severity === "warn" ? "warn" : "ok");

export default function SecurityCenterSection() {
  const t = useT();
  const live = useLive<Overview>(URL, 30_000);
  const { onError } = useAdmin();
  const [busy, setBusy] = useState(false);
  const d = live.data;
  const incidentId = useIncidentRoute();
  // Every action answers with the fresh overview.
  const act = async (body: Record<string, unknown>, question?: string) => {
    if (question && !confirm(question)) return;
    setBusy(true);
    try {
      live.setData(await api<Overview>(URL, body));
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!d)
    return live.state === "error" ? (
      <EmptyState icon={<WarningCircle size={20} />} title={t("Der Sicherheitsbereich ist nicht erreichbar.", "Security is not reachable.")} action={<button type="button" className="button" onClick={() => void live.reload()}>{t("Erneut versuchen", "Try again")}</button>}>
        {live.error}
      </EmptyState>
    ) : (
      <AdminLoading />
    );
  if (incidentId) return <IncidentPage id={incidentId} live={d} act={act} busy={busy} />;
  return (
    <div className="mon security-center" aria-busy={busy}>
      <div className="mon-toolbar">
        <LiveBadge state={live.state} label={live.updatedAt ? t(`aktualisiert ${clock(live.updatedAt)}`, `updated ${clock(live.updatedAt)}`) : undefined} />
        <span className="security-export">
          <a className="text-button" href={`${URL}?export=csv`} download>
            <DownloadSimple size={14} aria-hidden /> CSV
          </a>
          <a className="text-button" href={`${URL}?export=json`} download>
            <DownloadSimple size={14} aria-hidden /> JSON
          </a>
        </span>
      </div>
      <Verdict d={d} />
      <div className="security-kpis">
        <Kpi label={t("Offene Vorfälle", "Open incidents")} value={num(d.summary.openIncidents)} note={d.summary.criticalIncidents ? t(`${d.summary.criticalIncidents} kritisch`, `${d.summary.criticalIncidents} critical`) : undefined} />
        <Kpi label={t("Fehlgeschlagene Anmeldungen (24 h)", "Failed sign-ins (24 h)")} value={num(d.summary.failedSignIns)} />
        <Kpi label={t("Anmeldungen (24 h)", "Sign-ins (24 h)")} value={num(d.summary.signIns)} />
        <Kpi label={t("Abgewiesen (24 h)", "Refused (24 h)")} value={num(d.summary.refused)} />
        <Kpi label={t("Exporte (24 h)", "Exports (24 h)")} value={num(d.summary.exports)} />
        <Kpi label={t("Admin-Sitzungen", "Admin sessions")} value={num(d.summary.adminSessions)} />
        <Kpi label={t("Gesperrt", "Blocked")} value={num(d.summary.blocks)} />
      </div>
      <SignInChart d={d} />
      <Incidents d={d} act={act} busy={busy} />
      <Addresses d={d} act={act} busy={busy} />
      <Events first={d.events} act={act} busy={busy} />
      <Sessions d={d} act={act} busy={busy} />
      <Access d={d} act={act} busy={busy} />
      <Blocks d={d} act={act} busy={busy} />
      <Setup d={d} />
    </div>
  );
}

type Act = (body: Record<string, unknown>, question?: string) => Promise<void>;

/* ---------- At a glance ---------- */

function Verdict({ d }: { d: Overview }) {
  const t = useT();
  const s = d.summary;
  const notes: ReactNode[] = [];
  if (d.setup.addressMissing)
    notes.push(
      t(
        "Bei den Anmeldungen kommt keine Client-Adresse an – Sperren und Regeln pro Adresse wirken nicht. Prüfe, dass der Reverse-Proxy X-Forwarded-For setzt (FLOWPLAN_TRUSTED_PROXIES).",
        "Sign-ins arrive without a client address – blocks and per-address rules do not work. Make sure the reverse proxy sets X-Forwarded-For (FLOWPLAN_TRUSTED_PROXIES).",
      ),
    );
  if (!d.setup.webhook && !d.setup.mail)
    notes.push(t("Vorfälle erscheinen nur im Posteingang der Admins und hier – richte E-Mail oder einen Webhook ein, um sie auch unterwegs zu bekommen.", "Incidents only show in the admins' inbox and here – set up e-mail or a webhook to get them on the go as well."));
  const state = s.criticalIncidents ? "error" : s.openIncidents ? "warn" : "ok";
  return (
    <div className={`security-verdict ${state}`} role="status">
      {state === "ok" ? <ShieldCheck size={28} aria-hidden /> : <ShieldWarning size={28} aria-hidden />}
      <div>
        <strong>
          {state === "ok"
            ? t("Keine offenen Sicherheitsvorfälle", "No open security incidents")
            : state === "error"
              ? s.criticalIncidents === 1
                ? t("1 kritischer Vorfall offen", "1 critical incident open")
                : t(`${s.criticalIncidents} kritische Vorfälle offen`, `${s.criticalIncidents} critical incidents open`)
              : s.openIncidents === 1
                ? t("1 Vorfall offen", "1 incident open")
                : t(`${s.openIncidents} Vorfälle offen`, `${s.openIncidents} incidents open`)}
        </strong>
        <span>
          {t(
            `${num(s.events)} Ereignisse in 24 Stunden, davon ${num(s.warnings)} Warnungen. Die Regeln laufen bei jedem Ereignis.`,
            `${num(s.events)} events in 24 hours, ${num(s.warnings)} of them warnings. The rules run on every event.`,
          )}
        </span>
        {notes.map((note, i) => (
          <p key={i} className="mon-note">
            <Info size={16} aria-hidden />
            {note}
          </p>
        ))}
      </div>
    </div>
  );
}

function SignInChart({ d }: { d: Overview }) {
  const t = useT();
  const series = [
    { key: "signIns", label: t("erfolgreich", "successful"), values: d.hourly.map((h) => h.signIns), color: 0 },
    { key: "failures", label: t("fehlgeschlagen", "failed"), values: d.hourly.map((h) => h.failures), color: 1 },
  ];
  return (
    <SettingGroup title={t("Anmeldungen je Stunde", "Sign-ins per hour")} description={t("Die letzten 24 Stunden – ein Berg roter Balken ist ein Angriff auf Passwörter.", "The last 24 hours – a mountain of red bars is an attack on passwords.")}>
      <Legend items={series.map((s) => ({ label: s.label, color: s.color }))} />
      <BarChart
        title={t("Anmeldungen je Stunde", "Sign-ins per hour")}
        description={t("Erfolgreiche und fehlgeschlagene Anmeldungen der letzten 24 Stunden.", "Successful and failed sign-ins of the last 24 hours.")}
        labels={d.hourly.map((h) => clock(h.at))}
        tips={d.hourly.map((h) => dateTime(h.at))}
        series={series}
        formatY={(n) => num(n)}
        height={160}
      />
    </SettingGroup>
  );
}

/* ---------- Incidents ---------- */

const ruleTitle = (rule: string, t: T) => {
  const r = securityRules[rule as SecurityRule];
  return r ? t(r.de, r.en) : rule;
};
const kindTitle = (kind: string, t: T) => {
  const k = securityKinds[kind as SecurityKind];
  return k ? t(k.de, k.en) : kind;
};
const person = (p: { name: string; email: string } | null) => (p ? p.name || p.email : "");

function Incidents({ d, act, busy }: { d: Overview; act: Act; busy: boolean }) {
  const t = useT();
  const open = d.incidents.filter((i) => !i.resolvedAt);
  const done = d.incidents.filter((i) => i.resolvedAt);
  return (
    <SettingGroup
      id="incidents"
      title={t("Vorfälle", "Incidents")}
      description={t("Was die Erkennungsregeln gefunden haben. Gleiches innerhalb eines Tages zählt beim selben Vorfall weiter.", "What the detection rules found. The same thing within a day counts on the same incident.")}
      actions={
        open.length > 1 ? (
          <button type="button" className="button" disabled={busy} onClick={() => void act({ action: "incident.resolveAll" }, t("Alle offenen Vorfälle als erledigt markieren?", "Mark all open incidents as resolved?"))}>
            {t("Alle erledigt", "All resolved")}
          </button>
        ) : undefined
      }
    >
      {!open.length && (
        <EmptyState icon={<CheckCircle size={20} />} title={t("Nichts offen", "Nothing open")}>
          {t("Neue Vorfälle erscheinen hier und gehen an alle Admins.", "New incidents appear here and go to all admins.")}
        </EmptyState>
      )}
      <ul className="security-incidents">
        {[...open, ...done].map((i) => (
          <IncidentItem key={i.id} i={i} act={act} busy={busy} />
        ))}
      </ul>
    </SettingGroup>
  );
}

const incidentHref = (id: string) => `#admin/threats/incident/${id}`;

function IncidentItem({ i, act, busy }: { i: Incident; act: Act; busy: boolean }) {
  const t = useT();
  return (
    <li className={`security-incident ${i.resolvedAt ? "resolved" : i.severity}`}>
      <div className="security-incident-head">
        <StatusBadge tone={i.resolvedAt ? "off" : tone(i.severity)}>
          {i.resolvedAt ? t("erledigt", "resolved") : i.severity === "critical" ? t("kritisch", "critical") : t("Warnung", "warning")}
        </StatusBadge>
        <a className="security-incident-title" href={incidentHref(i.id)}>
          {ruleTitle(i.rule, t)}
        </a>
        {i.count > 1 && <span className="muted">× {num(i.count)}</span>}
      </div>
      <p>
        {[i.detail, person(i.actor), i.network].filter(Boolean).join(" · ")}
        <br />
        <small className="muted">
          {i.count > 1 ? t(`zuerst ${dateTime(i.firstAt)}, zuletzt ${ago(i.lastAt, t)}`, `first ${dateTime(i.firstAt)}, last ${ago(i.lastAt, t)}`) : dateTime(i.firstAt)}
          {i.resolvedAt && ` · ${t("erledigt", "resolved")}${i.resolvedBy ? ` ${t("von", "by")} ${i.resolvedBy}` : ""}`}
        </small>
      </p>
      <div className="security-actions">
        <a className="button" href={incidentHref(i.id)}>
          {t("Details & nächste Schritte", "Details & next steps")}
        </a>
        <IncidentActions i={i} act={act} busy={busy} />
      </div>
    </li>
  );
}

// Resolve or reopen, block the origin, end the sessions or disable the account.
function IncidentActions({ i, act, busy }: { i: Incident; act: Act; busy: boolean }) {
  const t = useT();
  return (
    <>
      {i.resolvedAt ? (
        <button type="button" className="text-button" disabled={busy} onClick={() => void act({ action: "incident.reopen", id: i.id })}>
          {t("Wieder öffnen", "Reopen")}
        </button>
      ) : (
        <button type="button" className="text-button" disabled={busy} onClick={() => void act({ action: "incident.resolve", id: i.id })}>
          {t("Erledigt", "Resolved")}
        </button>
      )}
      {!i.resolvedAt && i.address && <BlockAddress address={i.address} network={i.network} act={act} busy={busy} />}
      {!i.resolvedAt && i.actor && <EndSessions actor={i.actor} act={act} busy={busy} />}
      {!i.resolvedAt && i.actor && <DisableAccount actor={i.actor} act={act} busy={busy} />}
    </>
  );
}

type Actor = NonNullable<Incident["actor"]>;
function EndSessions({ actor, act, busy }: { actor: Actor; act: Act; busy: boolean }) {
  const t = useT();
  return (
    <button
      type="button"
      className="text-button"
      disabled={busy}
      onClick={() => void act({ action: "sessions.end", userId: actor.id }, t(`Alle Sitzungen von ${person(actor)} beenden? Die Person muss sich neu anmelden.`, `End all sessions of ${person(actor)}? They have to sign in again.`))}
    >
      {t("Sitzungen beenden", "End sessions")}
    </button>
  );
}
function DisableAccount({ actor, act, busy }: { actor: Actor; act: Act; busy: boolean }) {
  const t = useT();
  return (
    <button
      type="button"
      className="text-button danger"
      disabled={busy}
      onClick={() => void act({ action: "user.disable", userId: actor.id }, t(`Das Konto von ${person(actor)} sperren? Alle Sitzungen und Tokens enden; unter Personen lässt es sich wieder freigeben.`, `Disable the account of ${person(actor)}? All sessions and tokens end; it can be enabled again under People.`))}
    >
      {t("Konto sperren", "Disable account")}
    </button>
  );
}

const duration = (ms: number, t: T) => {
  const m = Math.round(ms / 60_000);
  if (m < 1) return t("unter 1 Min.", "under 1 min");
  if (m < 120) return t(`${m} Min.`, `${m} min`);
  const h = Math.round(m / 60);
  return h < 48 ? t(`${h} Std.`, `${h} h`) : t(`${Math.round(h / 24)} Tage`, `${Math.round(h / 24)} days`);
};

// Counted values as small chips ("alice@… × 12").
function Counts({ label, rows, tone: chipTone }: { label: string; rows: { value: string; n: number }[]; tone?: "error" }) {
  if (!rows.length) return null;
  return (
    <>
      <dt>
        {label}
        {rows.length > 1 && <span className="muted"> ({num(rows.length)})</span>}
      </dt>
      <dd className="security-chips">
        {rows.map((r, n) => (
          <span key={`${r.value}-${n}`} className={`security-chip${chipTone ? ` ${chipTone}` : ""}`}>
            {r.value}
            {r.n > 1 && <span className="muted"> × {num(r.n)}</span>}
          </span>
        ))}
      </dd>
    </>
  );
}

// #admin/threats/incident/<id>: the incident's own page.
function useIncidentRoute() {
  const read = () => (typeof location === "undefined" ? null : /^#admin\/threats\/incident\/([0-9a-f-]{36})$/.exec(location.hash)?.[1] ?? null);
  const [id, setId] = useState(read);
  useEffect(() => {
    const sync = () => setId(read());
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  return id;
}

// One incident: on the left what happened (why the rule fired, everything
// involved, the events), on the right what it means, when it is harmless and
// what to do, step by step with the action right there.
function IncidentPage({ id, live, act, busy }: { id: string; live: Overview; act: Act; busy: boolean }) {
  const t = useT();
  const [d, setD] = useState<IncidentDetailData | null>(null);
  const [error, setError] = useState("");
  const [all, setAll] = useState(false);
  const [version, setVersion] = useState(0);
  const listed = live.incidents.find((x) => x.id === id);
  useEffect(() => {
    let alive = true;
    api<IncidentDetailData>(`${URL}?incident=${encodeURIComponent(id)}`).then(
      (x) => alive && (setD(x), setError("")),
      (e) => alive && setError((e as Error).message),
    );
    return () => {
      alive = false;
    };
    // Reloads after an action and when the incident counts on.
  }, [id, version, listed?.count, listed?.lastAt, listed?.resolvedAt]);
  useEffect(() => {
    document.getElementById("incident-title")?.focus({ preventScroll: false });
  }, [id]);
  // Actions answer with the overview; the page then loads the incident again.
  const actHere: Act = async (body, question) => {
    await act(body, question);
    setVersion((v) => v + 1);
  };
  const back = (
    <a className="security-back" href="#admin/threats/incidents">
      <ArrowLeft size={16} aria-hidden /> {t("Alle Vorfälle", "All incidents")}
    </a>
  );
  if (error)
    return (
      <div className="security-incident-page">
        {back}
        <EmptyState icon={<WarningCircle size={20} />} title={t("Vorfall nicht verfügbar", "Incident not available")}>
          {error}
        </EmptyState>
      </div>
    );
  if (!d)
    return (
      <div className="security-incident-page" aria-busy="true">
        {back}
        <AdminLoading />
      </div>
    );
  const i = d.incident;
  const playbook = securityPlaybooks[i.rule as SecurityRule];
  const events = all ? d.events : d.events.slice(0, 40);
  const statuses = d.evidence ? Object.entries(d.evidence.statuses).sort((a, b) => b[1] - a[1]) : [];
  const stepAction = (step: PlaybookStep) => {
    if (i.resolvedAt && step.action !== "resolve") return null;
    switch (step.action) {
      case "block":
        return i.address ? <BlockAddress address={i.address} network={i.network} act={actHere} busy={busy} /> : null;
      case "sessions":
        return i.actor ? <EndSessions actor={i.actor} act={actHere} busy={busy} /> : null;
      case "disable":
        return i.actor ? <DisableAccount actor={i.actor} act={actHere} busy={busy} /> : null;
      case "resolve":
        return i.resolvedAt ? (
          <span className="muted">{t(`Erledigt${i.resolvedBy ? ` von ${i.resolvedBy}` : ""}`, `Resolved${i.resolvedBy ? ` by ${i.resolvedBy}` : ""}`)}</span>
        ) : (
          <button type="button" className="text-button" disabled={busy} onClick={() => void actHere({ action: "incident.resolve", id: i.id })}>
            {t("Als erledigt markieren", "Mark as resolved")}
          </button>
        );
    }
    return null;
  };
  return (
    <div className={`security-incident-page ${i.resolvedAt ? "resolved" : i.severity}`} aria-busy={busy}>
      {back}
      <header className="security-incident-page-head">
        <StatusBadge tone={i.resolvedAt ? "off" : tone(i.severity)}>
          {i.resolvedAt ? t("erledigt", "resolved") : i.severity === "critical" ? t("kritisch", "critical") : t("Warnung", "warning")}
        </StatusBadge>
        <h2 id="incident-title" tabIndex={-1}>
          {ruleTitle(i.rule, t)}
        </h2>
        <p>{[i.detail, person(i.actor), i.network].filter(Boolean).join(" · ")}</p>
        <div className="security-actions">
          <IncidentActions i={i} act={actHere} busy={busy} />
        </div>
      </header>
      <div className="security-incident-columns">
        <section className="security-incident-detail" aria-labelledby="incident-what">
          <h3 id="incident-what">{t("Was ist passiert", "What happened")}</h3>
          <p className="security-reason">
            <Info size={16} aria-hidden />
            <span>{t(d.reason.de, d.reason.en)}</span>
          </p>
      <dl className="security-facts">
        <dt>{t("Zeitraum", "Period")}</dt>
        <dd>
          {dateTime(i.firstAt)}
          {i.lastAt > i.firstAt &&
            ` – ${new Date(i.lastAt).toDateString() === new Date(i.firstAt).toDateString() ? clock(i.lastAt) : dateTime(i.lastAt)} (${duration(i.lastAt - i.firstAt, t)})`}
        </dd>
        <dt>{t("Ereignisse", "Events")}</dt>
        <dd>
          {t(`${num(d.total)} im Zeitraum der Regel`, `${num(d.total)} in the rule's window`)}
          {i.count > 1 && t(` · Regel ${num(i.count)}× ausgelöst`, ` · rule fired ${num(i.count)}×`)}
        </dd>
        {(i.network || i.address) && (
          <>
            <dt>{t("Herkunft", "Origin")}</dt>
            <dd>
              {[i.network, i.address && t(`Adresse ${i.address.slice(0, 6)}…`, `address ${i.address.slice(0, 6)}…`)].filter(Boolean).join(" · ")}
              {d.blocked.length ? (
                <StatusBadge tone="ok">{d.blocked.map((b) => (b.kind === "network" ? t("Netz gesperrt", "network blocked") : t("Adresse gesperrt", "address blocked"))).join(", ")}</StatusBadge>
              ) : (
                <span className="muted"> · {t("nicht gesperrt", "not blocked")}</span>
              )}
            </dd>
          </>
        )}
        {i.actor && (
          <>
            <dt>{t("Person", "Person")}</dt>
            <dd>{[i.actor.name, i.actor.email].filter(Boolean).join(" · ")}</dd>
          </>
        )}
        <Counts label={t("Probierte Konten", "Accounts tried")} rows={d.accounts} />
        {d.successes.length > 0 && (
          <Counts
            label={t("Erfolgreich angemeldet", "Signed in successfully")}
            rows={d.successes.map((x) => ({ value: x.who, n: x.n }))}
            tone={["brute_force_account", "brute_force_address", "credential_stuffing", "login_after_failures"].includes(d.rule) ? "error" : undefined}
          />
        )}
        <Counts label={t("Netze", "Networks")} rows={d.networks.length > 1 ? d.networks : []} />
        <Counts label={t("Länder", "Countries")} rows={d.countries} />
        <Counts label={t("Geräte", "Devices")} rows={d.devices} />
        <Counts label={t("Arten", "Kinds")} rows={d.kinds.map((k) => ({ value: kindTitle(k.value, t), n: k.n }))} />
      </dl>
      {d.evidence && d.evidence.paths.length > 0 && (
        <div className="security-evidence">
          <strong>{t("Abgefragte Pfade", "Requested paths")}</strong>
          <span className="security-chips">
            {statuses.map(([status, n]) => (
              <span key={status} className="security-chip">
                {status} <span className="muted">× {num(n)}</span>
              </span>
            ))}
          </span>
          <table className="security-paths">
            <thead>
              <tr>
                <th scope="col">{t("Antwort", "Answer")}</th>
                <th scope="col">{t("Pfad", "Path")}</th>
                <th scope="col" className="num">{t("Anzahl", "Count")}</th>
              </tr>
            </thead>
            <tbody>
              {d.evidence.paths.map((p) => (
                <tr key={`${p.status} ${p.path}`}>
                  <td>{p.status}</td>
                  <td className="mono">{p.path}</td>
                  <td className="num">{num(p.count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <small className="muted">{t("IDs und Tokens in Pfaden sind durch :id, :n und :token ersetzt.", "IDs and tokens in paths are replaced by :id, :n and :token.")}</small>
        </div>
      )}
      <div className="security-timeline">
        <strong>{t("Verlauf", "Timeline")}</strong>
        {d.events.length ? (
          <ol>
            {events.map((e) => (
              <li key={e.id}>
                <time dateTime={new Date(e.at).toISOString()}>{clock(e.at)}</time>
                <i className={`security-dot ${e.severity}`} aria-label={e.severity} />
                <span>
                  <b>{kindTitle(e.kind, t)}</b>
                  <small className="muted">{[person(e.actor) || e.subject, e.network, e.country, e.device, e.detail].filter(Boolean).join(" · ")}</small>
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted">{t("Die Ereignisse dazu sind nicht mehr gespeichert (Aufbewahrungsdauer).", "Its events are no longer stored (retention).")}</p>
        )}
        {d.events.length > events.length && (
          <button type="button" className="text-button" onClick={() => setAll(true)}>
            {t(`Alle ${num(d.events.length)} zeigen`, `Show all ${num(d.events.length)}`)}
          </button>
        )}
        {all && d.more > 0 && <small className="muted">{t(`${num(d.more)} ältere nicht angezeigt – siehe Ereignisse oder Export.`, `${num(d.more)} older not shown – see events or the export.`)}</small>}
      </div>
        </section>
        {playbook && (
          <aside className="security-playbook" aria-labelledby="incident-todo">
            <h3>{t("Was bedeutet das?", "What does it mean?")}</h3>
            <p>{t(playbook.meaning.de, playbook.meaning.en)}</p>
            <h3>{t("Wann ist es harmlos?", "When is it harmless?")}</h3>
            <p>{t(playbook.harmless.de, playbook.harmless.en)}</p>
            <h3 id="incident-todo">{t("Was du tun solltest", "What to do")}</h3>
            <ol className="security-steps">
              {playbook.steps.map((step, n) => {
                const action = stepAction(step);
                return (
                  <li key={n}>
                    <span>{t(step.de, step.en)}</span>
                    {(action || step.link) && (
                      <span className="security-step-actions">
                        {action}
                        {step.link && (
                          <a className="text-button" href={step.link.href}>
                            {t(step.link.de, step.link.en)} →
                          </a>
                        )}
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>
          </aside>
        )}
      </div>
    </div>
  );
}

// "Block address" for 24 hours, "Block network" (/24, /48) for 24 hours.
function BlockAddress({ address, network, act, busy }: { address: string; network: string; act: Act; busy: boolean }) {
  const t = useT();
  return (
    <>
      <button
        type="button"
        className="text-button"
        disabled={busy}
        onClick={() => void act({ action: "block.add", kind: "address", value: address, hours: 24, reason: "" }, t("Diese Adresse 24 Stunden sperren? Anfragen von ihr werden abgewiesen.", "Block this address for 24 hours? Its requests are refused."))}
      >
        {t("Adresse sperren", "Block address")}
      </button>
      {network && (
        <button
          type="button"
          className="text-button"
          disabled={busy}
          onClick={() => void act({ action: "block.add", kind: "network", value: network, hours: 24, reason: "" }, t(`Das ganze Netz ${network} 24 Stunden sperren? Das trifft alle Personen darin.`, `Block the whole network ${network} for 24 hours? This affects everyone in it.`))}
        >
          {t("Netz sperren", "Block network")}
        </button>
      )}
    </>
  );
}

/* ---------- Addresses ---------- */

function Addresses({ d, act, busy }: { d: Overview; act: Act; busy: boolean }) {
  const t = useT();
  return (
    <SettingGroup id="addresses" title={t("Adressen mit Fehlversuchen", "Addresses with failures")} description={t("Die letzten 24 Stunden. Gezeigt wird das Netz; die Adresse selbst speichert Flowplan nicht.", "The last 24 hours. The network is shown; Flowplan does not store the address itself.")}>
      <ResponsiveTable
        label={t("Adressen mit Fehlversuchen", "Addresses with failures")}
        rows={d.addresses}
        rowKey={(r) => r.address}
        empty={<p className="muted">{t("Keine Fehlversuche in den letzten 24 Stunden.", "No failures in the last 24 hours.")}</p>}
        columns={[
          { key: "network", header: t("Netz", "Network"), primary: true, render: (r) => <span className="mono">{r.network || "–"}</span> },
          { key: "failures", header: t("Fehlversuche", "Failures"), align: "end", render: (r) => num(r.failures) },
          { key: "accounts", header: t("Konten", "Accounts"), align: "end", render: (r) => num(r.accounts) },
          { key: "refused", header: t("Abgewiesen", "Refused"), align: "end", render: (r) => num(r.refused) },
          { key: "last", header: t("Zuletzt", "Last"), render: (r) => ago(r.lastAt, t) },
          {
            key: "action",
            header: "",
            render: (r) =>
              r.blocked ? (
                <StatusBadge tone="off">{t("gesperrt", "blocked")}</StatusBadge>
              ) : (
                <span className="security-cell-actions">
                  <BlockAddress address={r.address} network={r.network} act={act} busy={busy} />
                </span>
              ),
          },
        ]}
      />
    </SettingGroup>
  );
}

/* ---------- Events ---------- */

const GROUPS = [
  ["", "Alle", "All"],
  ["login.", "Anmeldung", "Sign-in"],
  ["account.", "Konto", "Account"],
  ["admin.", "Administration", "Administration"],
  ["data.export", "Exporte", "Exports"],
  ["share.", "Freigaben", "Sharing"],
  ["blocked.", "Abgewehrt", "Blocked"],
  ["request.", "Anfragen", "Requests"],
] as const;

function Events({ first, act, busy }: { first: EventPage; act: Act; busy: boolean }) {
  const t = useT();
  const { onError } = useAdmin();
  const [severity, setSeverity] = useState("all");
  const [kind, setKind] = useState("");
  const [page, setPage] = useState<EventPage | null>(null);
  const [loading, setLoading] = useState(false);
  const filtered = severity !== "all" || kind !== "";
  // The first page follows the live overview; filters and "more" load their own.
  const shown = page ?? (filtered ? { events: [], more: false } : first);
  const load = async (next: { severity: string; kind: string }, before?: number) => {
    setLoading(true);
    try {
      const query = new URLSearchParams({ events: "1", severity: next.severity, kind: next.kind, ...(before ? { before: String(before) } : {}) });
      const answer = await api<EventPage>(`${URL}?${query}`);
      setPage(before && page ? { events: [...page.events, ...answer.events], more: answer.more } : answer);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  const filter = (next: { severity: string; kind: string }) => {
    setSeverity(next.severity);
    setKind(next.kind);
    if (next.severity === "all" && !next.kind) setPage(null);
    else void load(next);
  };
  return (
    <SettingGroup id="events" title={t("Ereignisse", "Events")} description={t("Jedes sicherheitsrelevante Ereignis der Instanz, das neueste zuerst.", "Every security-relevant event of the instance, newest first.")}>
      <div className="security-filters">
        <div className="segmented" role="group" aria-label={t("Schwere", "Severity")}>
          {(
            [
              ["all", t("Alle", "All")],
              ["critical", t("Kritisch", "Critical")],
              ["warn", t("Warnung", "Warning")],
              ["info", t("Info", "Info")],
            ] as const
          ).map(([value, label]) => (
            <button key={value} type="button" aria-pressed={severity === value} onClick={() => filter({ severity: value, kind })}>
              {label}
            </button>
          ))}
        </div>
        <select aria-label={t("Art", "Kind")} value={kind} onChange={(e) => filter({ severity, kind: e.target.value })}>
          {GROUPS.map(([value, deLabel, enLabel]) => (
            <option key={value} value={value}>
              {t(deLabel, enLabel)}
            </option>
          ))}
        </select>
      </div>
      <ResponsiveTable<SecurityEventRow>
        label={t("Sicherheitsereignisse", "Security events")}
        rows={shown.events}
        rowKey={(e) => String(e.id)}
        empty={<p className="muted">{loading ? t("Wird geladen …", "Loading …") : t("Keine Ereignisse.", "No events.")}</p>}
        columns={[
          { key: "at", header: t("Zeit", "Time"), render: (e) => <span title={new Date(e.at).toISOString()}>{dateTime(e.at)}</span> },
          {
            key: "kind",
            header: t("Ereignis", "Event"),
            primary: true,
            render: (e) => (
              <span className="security-event-kind">
                <i className={`security-dot ${e.severity}`} aria-label={e.severity} />
                {kindTitle(e.kind, t)}
              </span>
            ),
          },
          { key: "who", header: t("Wer", "Who"), render: (e) => person(e.actor) || e.subject || "–" },
          { key: "where", header: t("Woher", "From"), hideOnPhone: true, render: (e) => [e.network, e.country, e.device].filter(Boolean).join(" · ") || "–" },
          { key: "detail", header: t("Details", "Details"), hideOnPhone: true, render: (e) => <span className="security-detail">{e.detail || ""}</span> },
          {
            key: "action",
            header: "",
            render: (e) => (e.address && e.severity !== "info" ? <BlockAddress address={e.address} network="" act={act} busy={busy} /> : null),
          },
        ]}
      />
      {shown.more && (
        <button type="button" className="button" disabled={loading} onClick={() => void load({ severity, kind }, shown.events.at(-1)?.id)}>
          {t("Ältere laden", "Load older")}
        </button>
      )}
    </SettingGroup>
  );
}

/* ---------- Sessions and ways in ---------- */

function Sessions({ d, act, busy }: { d: Overview; act: Act; busy: boolean }) {
  const t = useT();
  return (
    <SettingGroup id="sessions" title={t("Angemeldete Personen", "Signed-in people")} description={t("Admins zuerst. Sitzungen beenden meldet auf allen Geräten ab; die App muss sich neu anmelden.", "Admins first. Ending sessions signs out on every device; the app has to sign in again.")}>
      <ResponsiveTable
        label={t("Angemeldete Personen", "Signed-in people")}
        rows={d.sessions}
        rowKey={(s) => s.id}
        empty={<p className="muted">{t("Niemand angemeldet.", "Nobody signed in.")}</p>}
        columns={[
          {
            key: "name",
            header: t("Person", "Person"),
            primary: true,
            render: (s) => (
              <span>
                {s.name || s.email} {s.admin && <StatusBadge tone="warn">Admin</StatusBadge>}
              </span>
            ),
          },
          { key: "email", header: t("E-Mail", "E-mail"), hideOnPhone: true, render: (s) => s.email },
          { key: "sessions", header: t("Sitzungen", "Sessions"), align: "end", render: (s) => num(s.sessions) },
          { key: "seen", header: t("Zuletzt aktiv", "Last active"), render: (s) => (s.lastSeen ? ago(s.lastSeen, t) : "–") },
          {
            key: "action",
            header: "",
            render: (s) => (
              <button type="button" className="text-button" disabled={busy} onClick={() => void act({ action: "sessions.end", userId: s.id }, t(`Alle Sitzungen von ${s.name || s.email} beenden?`, `End all sessions of ${s.name || s.email}?`))}>
                {t("Sitzungen beenden", "End sessions")}
              </button>
            ),
          },
        ]}
      />
    </SettingGroup>
  );
}

function Access({ d, act, busy }: { d: Overview; act: Act; busy: boolean }) {
  const t = useT();
  const roles: Record<string, string> = { editor: t("bearbeiten", "edit"), commenter: t("kommentieren", "comment"), viewer: t("ansehen", "view") };
  return (
    <SettingGroup id="access" title={t("Offene Zugänge", "Open ways in")} description={t("API-Tokens, Freigabelinks und öffentliche Seiten der ganzen Instanz – was nicht mehr gebraucht wird, schließt du hier.", "API tokens, share links and public pages of the whole instance – close what is no longer needed here.")}>
      <h3 className="security-sub">{t(`API-Tokens (${d.tokens.length})`, `API tokens (${d.tokens.length})`)}</h3>
      <ResponsiveTable
        label={t("API-Tokens", "API tokens")}
        rows={d.tokens}
        rowKey={(r) => r.id}
        empty={<p className="muted">{t("Keine Tokens.", "No tokens.")}</p>}
        columns={[
          { key: "name", header: t("Token", "Token"), primary: true, render: (r) => `${r.name} (${r.prefix}…)` },
          { key: "owner", header: t("Person", "Person"), render: (r) => r.owner || r.email },
          { key: "scope", header: t("Recht", "Scope"), render: (r) => (r.scope === "write" ? <StatusBadge tone="warn">{t("schreiben", "write")}</StatusBadge> : r.scope) },
          { key: "used", header: t("Zuletzt benutzt", "Last used"), render: (r) => (r.lastUsedAt ? ago(r.lastUsedAt, t) : t("nie", "never")) },
          {
            key: "action",
            header: "",
            render: (r) => (
              <button type="button" className="text-button danger" disabled={busy} onClick={() => void act({ action: "token.revoke", id: r.id }, t(`Das Token „${r.name}“ von ${r.owner} widerrufen? Skripte damit hören sofort auf zu funktionieren.`, `Revoke the token “${r.name}” of ${r.owner}? Scripts using it stop working at once.`))}>
                {t("Widerrufen", "Revoke")}
              </button>
            ),
          },
        ]}
      />
      <h3 className="security-sub">{t(`Freigabelinks (${d.links.shares.length})`, `Share links (${d.links.shares.length})`)}</h3>
      <ResponsiveTable
        label={t("Freigabelinks", "Share links")}
        rows={d.links.shares}
        rowKey={(r) => r.id}
        empty={<p className="muted">{t("Keine Freigabelinks.", "No share links.")}</p>}
        columns={[
          { key: "page", header: t("Seite", "Page"), primary: true, render: (r) => <a href={`#page=${r.pageId}`}>{r.page || t("Ohne Titel", "Untitled")}</a> },
          { key: "name", header: t("Link", "Link"), render: (r) => r.name },
          { key: "role", header: t("Recht", "Right"), render: (r) => (r.role === "editor" ? <StatusBadge tone="warn">{roles.editor}</StatusBadge> : roles[r.role] || r.role) },
          { key: "creator", header: t("Erstellt von", "Created by"), hideOnPhone: true, render: (r) => r.creator || "–" },
          {
            key: "action",
            header: "",
            render: (r) => (
              <button type="button" className="text-button danger" disabled={busy} onClick={() => void act({ action: "share.revoke", id: r.id }, t(`Den Link „${r.name}“ zu „${r.page}“ löschen? Wer ihn hat, kommt nicht mehr hinein.`, `Delete the link “${r.name}” to “${r.page}”? Whoever has it can no longer get in.`))}>
                {t("Löschen", "Delete")}
              </button>
            ),
          },
        ]}
      />
      <h3 className="security-sub">{t(`Öffentliche Seiten (${d.links.published.length})`, `Public pages (${d.links.published.length})`)}</h3>
      <ResponsiveTable
        label={t("Öffentliche Seiten", "Public pages")}
        rows={d.links.published}
        rowKey={(r) => r.id}
        empty={<p className="muted">{t("Keine öffentlichen Seiten.", "No public pages.")}</p>}
        columns={[
          { key: "page", header: t("Seite", "Page"), primary: true, render: (r) => <a href={`#page=${r.id}`}>{r.page || t("Ohne Titel", "Untitled")}</a> },
          {
            key: "action",
            header: "",
            render: (r) => (
              <button type="button" className="text-button danger" disabled={busy} onClick={() => void act({ action: "publication.end", pageId: r.id }, t(`„${r.page}“ nicht mehr veröffentlichen?`, `Stop publishing “${r.page}”?`))}>
                {t("Veröffentlichung beenden", "Stop publishing")}
              </button>
            ),
          },
        ]}
      />
    </SettingGroup>
  );
}

/* ---------- Blocks ---------- */

function Blocks({ d, act, busy }: { d: Overview; act: Act; busy: boolean }) {
  const t = useT();
  const [network, setNetwork] = useState("");
  const [hours, setHours] = useState("24");
  const [reason, setReason] = useState("");
  return (
    <SettingGroup id="blocks" title={t("Sperren", "Blocks")} description={t("Gesperrte Adressen und Netze bekommen nur noch eine Ablehnung – auch angemeldete Personen darin. Die eigene Adresse lässt sich nicht sperren.", "Blocked addresses and networks only get a refusal – signed-in people in them too. Your own address cannot be blocked.")}>
      <ResponsiveTable
        label={t("Sperren", "Blocks")}
        rows={d.blocks}
        rowKey={(b) => b.id}
        empty={<p className="muted">{t("Nichts gesperrt.", "Nothing blocked.")}</p>}
        columns={[
          { key: "label", header: t("Adresse oder Netz", "Address or network"), primary: true, render: (b) => <span className="mono">{b.label}</span> },
          { key: "kind", header: t("Art", "Kind"), render: (b) => (b.kind === "network" ? t("Netz", "Network") : t("Adresse", "Address")) },
          { key: "until", header: t("Bis", "Until"), render: (b) => (b.until ? dateTime(b.until) : t("unbefristet", "indefinitely")) },
          { key: "reason", header: t("Grund", "Reason"), hideOnPhone: true, render: (b) => [b.reason, b.creator].filter(Boolean).join(" · ") || "–" },
          {
            key: "action",
            header: "",
            render: (b) => (
              <button type="button" className="text-button" disabled={busy} onClick={() => void act({ action: "block.remove", id: b.id })}>
                {t("Aufheben", "Lift")}
              </button>
            ),
          },
        ]}
      />
      <form
        className="security-block-form"
        onSubmit={(e) => {
          e.preventDefault();
          void act({ action: "block.add", kind: "network", value: network, hours: hours ? Number(hours) : null, reason }).then(() => setNetwork(""));
        }}
      >
        <label>
          {t("Netz", "Network")}
          <input value={network} onChange={(e) => setNetwork(e.target.value)} placeholder="203.0.113.0/24" required maxLength={60} />
        </label>
        <label>
          {t("Dauer", "Duration")}
          <select value={hours} onChange={(e) => setHours(e.target.value)}>
            <option value="1">{t("1 Stunde", "1 hour")}</option>
            <option value="24">{t("24 Stunden", "24 hours")}</option>
            <option value="168">{t("7 Tage", "7 days")}</option>
            <option value="720">{t("30 Tage", "30 days")}</option>
            <option value="">{t("unbefristet", "indefinitely")}</option>
          </select>
        </label>
        <label>
          {t("Grund", "Reason")}
          <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
        </label>
        <button type="submit" className="button" disabled={busy || !network.trim()}>
          {t("Netz sperren", "Block network")}
        </button>
      </form>
    </SettingGroup>
  );
}

/* ---------- Detection and connection ---------- */

function Setup({ d }: { d: Overview }) {
  const t = useT();
  const docs = useDocs();
  const th = d.thresholds;
  const minutes = (ms: number) => Math.round(ms / 60_000);
  const describe: Record<SecurityRule, string> = {
    brute_force_account: t(`${th.accountFailures} Fehlversuche bei einem Konto in ${minutes(th.window)} Minuten`, `${th.accountFailures} failures on one account in ${minutes(th.window)} minutes`),
    brute_force_address: t(`${th.addressFailures} Fehlversuche von einer Adresse in ${minutes(th.window)} Minuten`, `${th.addressFailures} failures from one address in ${minutes(th.window)} minutes`),
    credential_stuffing: t(`${th.stuffingAccounts} verschiedene Konten von einer Adresse in ${minutes(th.window)} Minuten`, `${th.stuffingAccounts} different accounts from one address in ${minutes(th.window)} minutes`),
    login_after_failures: t(`Erfolgreiche Anmeldung nach ${th.failuresBeforeSuccess} Fehlversuchen`, `Successful sign-in after ${th.failuresBeforeSuccess} failures`),
    admin_new_device: t("Admin meldet sich mit einem Gerät an, das 90 Tage nicht dabei war", "An admin signs in with a device not seen for 90 days"),
    impossible_travel: t("Zwei Länder innerhalb von 2 Stunden (braucht FLOWPLAN_COUNTRY_HEADER)", "Two countries within 2 hours (needs FLOWPLAN_COUNTRY_HEADER)"),
    privilege_change: t("Adminrechte, LDAP/SCIM, Wiederherstellung, Erweiterungen, Domains", "Admin rights, LDAP/SCIM, restore, extensions, domains"),
    mass_export: t(`Mehr als ${th.exportsPerHour} Exporte einer Person in einer Stunde`, `More than ${th.exportsPerHour} exports by one person in an hour`),
    probing: t(`${th.probes} abgewiesene API-Anfragen (401/403/404) einer Adresse in ${minutes(th.probeWindow)} Minuten`, `${th.probes} refused API requests (401/403/404) from one address in ${minutes(th.probeWindow)} minutes`),
    injection_attempts: t(`${th.contentAttempts} abgewehrte Skripte oder interne Adressen in einer Stunde`, `${th.contentAttempts} refused scripts or internal addresses in an hour`),
  };
  const on = (value: boolean, label: string) => <StatusBadge tone={value ? "ok" : "off"}>{label}</StatusBadge>;
  return (
    <SettingGroup id="setup" title={t("Erkennung & Anbindung", "Detection & connection")} description={<a href={docs("operations", "sicherheit", "security")} target="_blank" rel="noreferrer">{t("Anleitung: Logs, OpenTelemetry, Prometheus, fail2ban und CrowdSec", "Guide: logs, OpenTelemetry, Prometheus, fail2ban and CrowdSec")}</a>}>
      <h3 className="security-sub">{t("Regeln", "Rules")}</h3>
      <ul className="security-rules">
        {d.rules.map((r) => (
          <li key={r.rule}>
            <i className={`security-dot ${r.active ? r.severity : "off"}`} aria-hidden />
            <div>
              <strong>{ruleTitle(r.rule, t)}</strong>
              <small>{describe[r.rule as SecurityRule]}</small>
            </div>
            {!r.active && <StatusBadge tone="off">{t("aus", "off")}</StatusBadge>}
          </li>
        ))}
      </ul>
      <h3 className="security-sub">{t("Wohin die Ereignisse gehen", "Where the events go")}</h3>
      <dl className="security-setup">
        <dt>{t("Log-Zeilen (stdout, JSON)", "Log lines (stdout, JSON)")}</dt>
        <dd>{on(d.setup.logMode !== "off", d.setup.logMode === "on" ? t("mit Adresse", "with address") : d.setup.logMode === "anonymous" ? t("ohne Adresse", "without address") : t("aus", "off"))} <code>FLOWPLAN_SECURITY_LOG</code></dd>
        <dt>OpenTelemetry (OTLP)</dt>
        <dd>{on(!!d.setup.otlp, d.setup.otlp || t("nicht eingerichtet", "not set up"))} <code>OTEL_EXPORTER_OTLP_ENDPOINT</code></dd>
        <dt>Prometheus</dt>
        <dd>{on(d.setup.prometheus, d.setup.prometheus ? "/api/metrics" : t("aus", "off"))} <code>FLOWPLAN_METRICS_TOKEN</code></dd>
        <dt>{t("Webhook für Vorfälle", "Webhook for incidents")}</dt>
        <dd>
          {on(d.setup.webhook, d.setup.webhook ? t("an", "on") : t("aus", "off"))} <a href="#admin/monitoring/alerts">{t("Überwachung → Warnungen", "Monitoring → Alerts")}</a>
        </dd>
        <dt>{t("E-Mail an Admins", "E-mail to admins")}</dt>
        <dd>{on(d.setup.mail, d.setup.mail ? t("an", "on") : t("kein SMTP", "no SMTP"))}</dd>
        <dt>{t("Land der Anfrage", "Country of the request")}</dt>
        <dd>{on(d.setup.countryHeader, d.setup.countryHeader ? t("an", "on") : t("aus", "off"))} <code>FLOWPLAN_COUNTRY_HEADER</code></dd>
        <dt>{t("Aufbewahrung", "Retention")}</dt>
        <dd>
          {t(`${d.setup.retentionDays} Tage`, `${d.setup.retentionDays} days`)} <code>FLOWPLAN_SECURITY_RETENTION_DAYS</code>
        </dd>
      </dl>
    </SettingGroup>
  );
}
