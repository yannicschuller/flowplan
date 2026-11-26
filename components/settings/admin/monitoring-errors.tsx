"use client";
// Administration → Überwachung → Fehler im Detail (#settings/instance/monitoring/errors):
// where the 5xx answers come from – one row per kind of error (route or
// command, error name, short message, count in the range, trend, last
// time); opened, its occurrences (time, request id, status, instance,
// version, role) and the stack frames. Per group its build-independent
// signature, "GitHub-Issue öffnen" (a preview of exactly the public report –
// lib/error-report.ts publicReport, no request ids or host names – then the
// new issue in a new tab, built in the browser), "Schon gemeldet?" (GitHub's
// search for the signature), "Als gemeldet markieren" and "Stummschalten"
// (for the weekly digest, lib/error-digest.ts), and an internal plain-text
// report with request ids for this instance's log. The switch
// "Wöchentliche Fehlerübersicht" below the list. A click on the error chart
// above filters to that time slot.
// Data: /api/admin/monitoring?view=errors (lib/error-details.ts), loaded
// when the section opens and whenever the dashboard counts new errors.
//
// Below it, "Fehler bei Fremddiensten" (#settings/instance/monitoring/upstream, #514):
// 5xx answers that report a failing third-party service (AI provider,
// linked site, image search, calendar server …) – counted apart from the
// server errors, per place, service and host with count and last time.
// Data: /api/admin/monitoring?view=upstream.
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowClockwise, ArrowSquareOut, CheckCircle, Copy, GithubLogo, MagnifyingGlass, Trash, X } from "@phosphor-icons/react";
import type { ErrorDetails, UpstreamFailures } from "@/lib/error-details";
import { frameText, githubSearchUrl, issueReport, publicReport, type BuildVersion, type ErrorGroupView, type ErrorOccurrence, type UpstreamFailureView } from "@/lib/error-report";
import { useT } from "../../i18n";
import { api } from "../../ui";
import { Sparkline } from "../../sparkline";
import { EmptyState, ResponsiveTable, SaveState, SettingRow, StatusBadge, Switch, useSaveState } from "../../settings-ui";
import { useAdmin } from "../admin-context";
import { ago, clock, dateTime, num } from "./monitoring-format";
import { ErrorIssueDialog, MarkReportedDialog } from "./error-issue-dialog";

type T = (de: string, en: string) => string;
type Range = "1h" | "24h" | "7d";
// The range in the public report (always English, like the issue).
const RANGE_LABEL: Record<Range, string> = { "1h": "the last hour", "24h": "the last 24 hours", "7d": "the last 7 days" };
export type ErrorSlot = { from: number; to: number };

const roleName = (role: ErrorOccurrence["role"], t: T) =>
  (
    ({
      admin: t("Administration", "Administrator"),
      member: t("Mitglied", "Member"),
      demo: t("Demo", "Demo"),
      guest: t("Gast (Freigabe)", "Guest (shared link)"),
      anonymous: t("nicht angemeldet", "not signed in"),
      token: t("API-Token", "API token"),
      mcp: "MCP",
    }) as Record<string, string>
  )[role] || "–";
const kindName = (g: ErrorGroupView, t: T) => (g.kind === "worker" ? t("Hintergrunddienst", "Background worker") : g.kind === "job" ? t("Hintergrundauftrag", "Background job") : null);

// Failures of a group inside [from, to): its buckets that overlap the slot.
function inSlot(g: ErrorGroupView, step: number, slot: ErrorSlot) {
  return g.buckets.reduce((a, [at, n]) => (at < slot.to && at + step > slot.from ? a + n : a), 0);
}
// The trend over the range: 12 values of 5 minutes (1 hour), 24 hours
// (24 hours) or 28 quarter days (7 days).
function trend(g: ErrorGroupView, since: number, now: number) {
  const span = now - since;
  const steps = span <= 3_600_000 ? 12 : span <= 86_400_000 ? 24 : 28;
  const size = span / steps;
  const values = new Array<number>(steps).fill(0);
  for (const [at, n] of g.buckets) {
    const i = Math.floor((at - since) / size);
    if (i >= 0 && i < steps) values[i] += n;
    else if (i < 0 && at + size > since) values[0] += n;
  }
  return values;
}

export function ErrorDetailsCard({ range, refreshKey, slot, onSlot }: { range: Range; refreshKey: number; slot: ErrorSlot | null; onSlot: (slot: ErrorSlot | null) => void }) {
  const t = useT();
  const { onError } = useAdmin();
  const [data, setData] = useState<ErrorDetails | null>(null);
  const [failed, setFailed] = useState("");
  const [sort, setSort] = useState<"last" | "count">("last");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      setData(await api<ErrorDetails>(`/api/admin/monitoring?view=errors&range=${range}`));
      setFailed("");
    } catch (e) {
      setFailed((e as Error).message);
    }
  }, [range]);
  useEffect(() => {
    void load();
  }, [load, refreshKey]);
  const clear = async () => {
    if (!confirm(t("Alle Fehlerdetails löschen? Die Zählung der Fehler (5xx) bleibt.", "Clear all error details? The count of errors (5xx) stays."))) return;
    setBusy(true);
    try {
      setData(await api<ErrorDetails>("/api/admin/monitoring", { action: "errors.clear" }));
      onSlot(null);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const now = Date.now();
  const groups = useMemo(() => {
    if (!data) return [];
    const list = data.groups.map((g) => ({ g, n: slot ? inSlot(g, data.step, slot) : g.inRange }));
    const shown = slot ? list.filter((x) => x.n > 0) : list;
    return shown.sort((a, b) => (sort === "count" ? b.n - a.n || b.g.lastSeen - a.g.lastSeen : b.g.lastSeen - a.g.lastSeen));
  }, [data, slot, sort]);
  const slotLabel = slot ? `${dateTime(slot.from)}–${clock(slot.to)}` : "";
  return (
    <section className="setting-group mon-card mon-errors-card" id="errors" aria-labelledby="errors-title">
      <header>
        <div>
          <h2 id="errors-title">{t("Fehler im Detail", "Errors in detail")}</h2>
          <p>
            {t("Woher die Fehler (5xx) kommen – je Art eines Fehlers mit Route, Meldung und Stelle im Code.", "Where the errors (5xx) come from – per kind of error with route, message and place in the code.")}
            {data ? ` ${t(`Aufbewahrt ${data.keep.days} Tage, höchstens ${data.keep.maxGroups} Arten.`, `Kept ${data.keep.days} days, at most ${data.keep.maxGroups} kinds.`)}` : ""}
          </p>
        </div>
        <div className="setting-group-actions">
          <button type="button" className="button compact" onClick={() => void load()} aria-label={t("Neu laden", "Reload")} title={t("Neu laden", "Reload")}>
            <ArrowClockwise size={16} aria-hidden />
          </button>
          {!!data?.groups.length && (
            <button type="button" className="button compact danger" onClick={() => void clear()} disabled={busy}>
              <Trash size={15} aria-hidden /> {t("Zurücksetzen", "Clear")}
            </button>
          )}
        </div>
      </header>
      <div className="mon-card-body">
        {!data ? (
          failed ? <p className="muted">{failed}</p> : <p className="muted">{t("Lädt …", "Loading …")}</p>
        ) : !data.groups.length ? (
          <EmptyState icon={<CheckCircle size={20} />} title={t("Keine Fehler in den letzten 14 Tagen.", "No errors in the last 14 days.")}>
            {t("Sobald der Server mit 500–599 antwortet, steht hier, wo es passiert ist.", "As soon as the server answers with 500–599, this shows where it happened.")}
          </EmptyState>
        ) : (
          <>
            <div className="mon-errors-tools">
              {slot ? (
                <span className="mon-errors-slot">
                  {t(`Nur ${slotLabel}`, `Only ${slotLabel}`)}
                  <button type="button" className="icon-button" onClick={() => onSlot(null)} aria-label={t("Filter aufheben", "Clear filter")} title={t("Filter aufheben", "Clear filter")}>
                    <X size={14} aria-hidden />
                  </button>
                </span>
              ) : (
                <span className="muted">{t("Tipp: Ein Klick ins Fehlerdiagramm zeigt nur diesen Zeitraum.", "Tip: a click into the error chart shows only that time slot.")}</span>
              )}
              <label className="mon-range">
                <span>{t("Sortieren", "Sort")}</span>
                <select value={sort} onChange={(e) => setSort(e.target.value as "last" | "count")}>
                  <option value="last">{t("zuletzt aufgetreten", "last seen")}</option>
                  <option value="count">{t("Anzahl", "count")}</option>
                </select>
              </label>
            </div>
            {!groups.length ? (
              <p className="muted">{t("In diesem Zeitraum keine Fehler mit Details.", "No errors with details in this time slot.")}</p>
            ) : (
              <ul className="mon-errors" aria-label={t("Fehlerarten", "Kinds of errors")}>
                {groups.map(({ g, n }) => (
                  <ErrorGroup key={g.fingerprint} g={g} n={n} values={trend(g, data.since, now)} t={t} now={now} build={data.build} range={data.range} onData={setData} />
                ))}
              </ul>
            )}
            {data.total > data.groups.length && (
              <p className="muted">{t(`Die ${num(data.groups.length)} zuletzt aufgetretenen von ${num(data.total)} Fehlerarten.`, `The ${num(data.groups.length)} most recent of ${num(data.total)} kinds of errors.`)}</p>
            )}
          </>
        )}
        {data?.digest && <DigestSwitch enabled={data.digest.enabled} onData={setData} />}
      </div>
    </section>
  );
}

// "Wöchentliche Fehlerübersicht": on Mondays one notification to the
// administrators (lib/error-digest.ts).
function DigestSwitch({ enabled, onData }: { enabled: boolean; onData: (d: ErrorDetails) => void }) {
  const t = useT();
  const [status, run] = useSaveState();
  const [on, setOn] = useState(enabled);
  useEffect(() => setOn(enabled), [enabled]);
  return (
    <div className="mon-error-digest">
      <SettingRow
        label={t("Wöchentliche Fehlerübersicht", "Weekly error summary")}
        description={t(
          "Montags eine Benachrichtigung an die Administration: Fehler, die in der letzten Woche neu waren oder nach vier ruhigen Wochen wiederkamen – nur Anzahl, Route und Fehlername. Gemeldete und stummgeschaltete fehlen.",
          "On Mondays one notification to the administrators: errors that were new in the last week or came back after four quiet weeks – only count, route and error name. Reported and muted ones are left out.",
        )}
      >
        <SaveState status={status} />
        <Switch
          checked={on}
          label={t("Wöchentliche Fehlerübersicht", "Weekly error summary")}
          onChange={(next) => {
            setOn(next);
            void run(async () => {
              try {
                onData(await api<ErrorDetails>("/api/admin/monitoring", { action: "errors.digest", enabled: next }));
              } catch (e) {
                setOn(!next);
                throw e;
              }
            });
          }}
        />
      </SettingRow>
    </div>
  );
}

function ErrorGroup({
  g,
  n,
  values,
  t,
  now,
  build,
  range,
  onData,
}: {
  g: ErrorGroupView;
  n: number;
  values: number[];
  t: T;
  now: number;
  build: BuildVersion;
  range: Range;
  onData: (d: ErrorDetails) => void;
}) {
  const { onError } = useAdmin();
  const [copied, setCopied] = useState<"" | "report" | "stack">("");
  const [dialog, setDialog] = useState<"" | "issue" | "reported">("");
  const [busy, setBusy] = useState(false);
  const mark = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      onData(await api<ErrorDetails>("/api/admin/monitoring", { ...body, signature: g.signature }));
    } finally {
      setBusy(false);
    }
  };
  const act = (body: Record<string, unknown>) => void mark(body).catch((e) => onError((e as Error).message));
  const reported = !!g.mark?.reportedAt;
  const muted = g.mark?.mutedUntil ?? null;
  const copy = (what: "report" | "stack", text: string) =>
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(what);
        setTimeout(() => setCopied(""), 2000);
      })
      .catch(() => {});
  const where = g.action ? `${g.route} · ${g.action}` : g.route;
  const kind = kindName(g, t);
  const stack = g.frames.map((f) => `at ${frameText(f)}`).join("\n");
  return (
    <li className="mon-errgroup">
      <details>
        <summary>
          <span className="mon-error-main">
            <code className="mon-error-where">{where}</code>
            <span className="mon-error-what">
              <strong>{g.name}</strong>
              {g.message && <span> {g.message}</span>}
            </span>
            {(reported || muted) && (
              <span className="mon-error-marks">
                {reported && <StatusBadge tone="info">{t("Gemeldet", "Reported")}</StatusBadge>}
                {muted && <StatusBadge tone="off">{t(`Stumm bis ${dateTime(muted)}`, `Muted until ${dateTime(muted)}`)}</StatusBadge>}
              </span>
            )}
            <small className="muted">
              {kind ? `${kind} · ` : ""}
              {t(`Status ${g.status} · zuletzt ${ago(g.lastSeen, t, now)} · insgesamt ${num(g.count)}`, `status ${g.status} · last ${ago(g.lastSeen, t, now)} · ${num(g.count)} in total`)}
              {g.dbCode ? ` · ${g.dbCode}` : ""}
            </small>
          </span>
          <span className="mon-error-count">
            <strong>{num(n)}</strong>
            <span className="mon-error-trend" aria-hidden>
              <Sparkline values={values} label={t("Verlauf im Zeitraum", "Trend in the range")} tone={2} height={22} />
            </span>
          </span>
        </summary>
        <div className="mon-error-body">
          <h3 className="mon-subhead">{t("Stelle im Code", "Place in the code")}</h3>
          {g.frames.length ? (
            <>
              <pre className="mon-error-stack" tabIndex={0} aria-label={t("Stack-Frames", "Stack frames")}>
                {stack}
              </pre>
              {!g.frames.some((f) => f.mapped) && (
                <p className="muted mon-error-hint">
                  {t("Kompilierte Dateien: die Quellen stehen nur mit den Source-Maps des Builds daneben (nicht im Docker-Image).", "Compiled files: the sources show only with the build's source maps next to them (not in the Docker image).")}
                </p>
              )}
            </>
          ) : (
            <p className="muted">{t("Keine Ausnahme bekannt – die Antwort selbst hatte diesen Status.", "No exception known – the answer itself had this status.")}</p>
          )}
          <h3 className="mon-subhead">{t("Vorkommen", "Occurrences")}</h3>
          <ResponsiveTable
            label={t("Vorkommen", "Occurrences")}
            rows={g.occurrences}
            rowKey={(o) => `${o.at}-${o.requestId}`}
            columns={[
              { key: "at", header: t("Zeit", "Time"), primary: true, render: (o) => dateTime(o.at) },
              { key: "id", header: t("Fehler-ID", "Error ID"), render: (o) => <code>{o.requestId || "–"}</code> },
              { key: "status", header: "Status", render: (o) => String(o.status) },
              { key: "node", header: t("Instanz", "Instance"), render: (o) => o.node || "–", hideOnPhone: true },
              { key: "version", header: "Version", render: (o) => o.version || "–" },
              { key: "role", header: t("Rolle", "Role"), render: (o) => roleName(o.role, t) },
            ]}
          />
          <h3 className="mon-subhead">{t("Melden", "Report||verb")}</h3>
          <p className="muted mon-error-hint">
            {t("Signatur – gleich in jedem Build, damit ein Issue zu finden ist:", "Signature – the same in every build, so an issue can be found:")} <code>{g.signature}</code>
            {reported && g.mark?.issueUrl && (
              <>
                {" · "}
                <a href={g.mark.issueUrl} target="_blank" rel="noopener noreferrer">
                  {t("Gemeldetes Issue", "Reported issue")} <ArrowSquareOut size={12} aria-hidden />
                </a>
              </>
            )}
          </p>
          <div className="mon-error-actions">
            <button type="button" className="button compact primary" onClick={() => setDialog("issue")}>
              <GithubLogo size={15} aria-hidden /> {t("GitHub-Issue öffnen", "Open GitHub issue")}
            </button>
            <a className="button compact" href={githubSearchUrl(g.signature)} target="_blank" rel="noopener noreferrer">
              <MagnifyingGlass size={15} aria-hidden /> {t("Schon gemeldet?", "Already reported?")}
            </a>
            {reported ? (
              <button type="button" className="button compact" disabled={busy} onClick={() => act({ action: "errors.reported", reported: false })}>
                {t("Nicht mehr als gemeldet markieren", "Unmark as reported")}
              </button>
            ) : (
              <button type="button" className="button compact" disabled={busy} onClick={() => setDialog("reported")}>
                {t("Als gemeldet markieren", "Mark as reported")}
              </button>
            )}
            {muted ? (
              <button type="button" className="button compact" disabled={busy} onClick={() => act({ action: "errors.mute", weeks: 0 })}>
                {t("Stummschaltung aufheben", "Unmute")}
              </button>
            ) : (
              <label className="mon-range">
                <span>{t("Stummschalten", "Mute||error")}</span>
                <select value="" disabled={busy} onChange={(e) => e.target.value && act({ action: "errors.mute", weeks: Number(e.target.value) })}>
                  <option value="">{t("nicht stumm", "not muted")}</option>
                  <option value="1">{t("1 Woche", "1 week")}</option>
                  <option value="4">{t("4 Wochen", "4 weeks")}</option>
                  <option value="12">{t("12 Wochen", "12 weeks")}</option>
                  <option value="52">{t("1 Jahr", "1 year")}</option>
                </select>
              </label>
            )}
          </div>
          <div className="mon-error-actions">
            <button
              type="button"
              className="button compact"
              onClick={() => copy("report", issueReport(g))}
              title={t("Mit Fehler-IDs und Instanznamen – zum Suchen im Log dieser Instanz, nicht für ein öffentliches Issue.", "With error IDs and instance names – to search this instance's log, not for a public issue.")}
            >
              <Copy size={15} aria-hidden /> {copied === "report" ? t("Kopiert", "Copied") : t("Intern kopieren (mit Fehler-IDs)", "Copy internal report (with error IDs)")}
            </button>
            {!!g.frames.length && (
              <button type="button" className="button compact" onClick={() => copy("stack", stack)}>
                {copied === "stack" ? t("Kopiert", "Copied") : t("Stack kopieren", "Copy stack")}
              </button>
            )}
          </div>
        </div>
      </details>
      {dialog === "issue" && <ErrorIssueDialog report={publicReport(g, build, RANGE_LABEL[range])} onClose={() => setDialog("")} />}
      {dialog === "reported" && <MarkReportedDialog onClose={() => setDialog("")} onSave={(issueUrl) => mark({ action: "errors.reported", reported: true, ...(issueUrl ? { issueUrl } : {}) })} />}
    </li>
  );
}

// The third-party service by its key (lib/auth.ts HttpError `upstream`).
const serviceName = (service: string, t: T) =>
  (
    ({
      ai: t("KI-Anbieter", "AI provider"),
      oembed: t("Verlinkte Seite (Einbettung)", "Linked site (embed)"),
      web: t("Website", "Website"),
      "image-search": t("Bildsuche", "Image search"),
      "gif-search": t("GIF-Suche", "GIF search"),
      calendar: t("Kalenderanbieter", "Calendar provider"),
      "calendar-feed": t("Kalender-Abo (ICS)", "Calendar feed (ICS)"),
      telegram: "Telegram",
      git: t("Git-Anbieter", "Git provider"),
      sftp: t("SFTP-Server", "SFTP server"),
      s3: t("S3-Speicher", "S3 storage"),
      netbox: "NetBox",
      ldap: t("Verzeichnisdienst (LDAP)", "Directory service (LDAP)"),
      notion: "Notion",
      bookstack: "BookStack",
      "instance-move": t("Quell-Instanz (Umzug)", "Source instance (move)"),
      doi: t("DOI-Auflösung", "DOI resolver"),
      smtp: t("Mailserver (SMTP)", "Mail server (SMTP)"),
      transcription: t("Transkriptionsdienst", "Transcription service"),
    }) as Record<string, string>
  )[service] || service;

export function UpstreamFailuresCard({ range, refreshKey }: { range: Range; refreshKey: number }) {
  const t = useT();
  const [data, setData] = useState<UpstreamFailures | null>(null);
  const [failed, setFailed] = useState("");
  const load = useCallback(async () => {
    try {
      setData(await api<UpstreamFailures>(`/api/admin/monitoring?view=upstream&range=${range}`));
      setFailed("");
    } catch (e) {
      setFailed((e as Error).message);
    }
  }, [range]);
  useEffect(() => {
    void load();
  }, [load, refreshKey]);
  const now = Date.now();
  return (
    <section className="setting-group mon-card" id="upstream" aria-labelledby="upstream-title">
      <header>
        <div>
          <h2 id="upstream-title">{t("Fehler bei Fremddiensten", "Errors from external services")}</h2>
          <p>
            {t(
              "Antworten mit 502–504, weil ein anderer Dienst versagt hat – etwa der KI-Anbieter, eine verlinkte Seite oder die Bildsuche. Sie zählen nicht als Serverfehler (5xx) oben.",
              "Answers with 502–504 because another service failed – such as the AI provider, a linked site or the image search. They do not count as server errors (5xx) above.",
            )}
          </p>
        </div>
        <div className="setting-group-actions">
          <button type="button" className="button compact" onClick={() => void load()} aria-label={t("Neu laden", "Reload")} title={t("Neu laden", "Reload")}>
            <ArrowClockwise size={16} aria-hidden />
          </button>
        </div>
      </header>
      <div className="mon-card-body">
        {!data ? (
          failed ? <p className="muted">{failed}</p> : <p className="muted">{t("Lädt …", "Loading …")}</p>
        ) : !data.items.length ? (
          <p className="muted">{t("Keine Fehler bei Fremddiensten in den letzten 14 Tagen.", "No errors from external services in the last 14 days.")}</p>
        ) : (
          <ResponsiveTable<UpstreamFailureView>
            label={t("Fehler bei Fremddiensten", "Errors from external services")}
            rows={data.items}
            rowKey={(u) => u.key}
            columns={[
              { key: "service", header: t("Dienst", "Service"), primary: true, render: (u) => <span title={u.message || undefined}>{serviceName(u.service, t)}</span> },
              { key: "host", header: "Host", render: (u) => (u.host ? <code>{u.host}</code> : "–") },
              {
                key: "where",
                header: t("Wo", "Where"),
                render: (u) => <code>{u.action ? `${u.route} · ${u.action}` : u.route}</code>,
                hideOnPhone: true,
              },
              { key: "status", header: "Status", render: (u) => String(u.status), hideOnPhone: true },
              { key: "count", header: t("Anzahl", "Count"), align: "end", render: (u) => (u.inRange === u.count ? num(u.count) : t(`${num(u.inRange)} (insgesamt ${num(u.count)})`, `${num(u.inRange)} (${num(u.count)} in total)`)) },
              { key: "last", header: t("Zuletzt", "Last"), render: (u) => ago(u.lastSeen, t, now) },
            ]}
          />
        )}
      </div>
    </section>
  );
}
