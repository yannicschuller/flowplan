"use client";
// Administration → Überwachung → Fehler im Detail (#admin/monitoring/errors):
// where the 5xx answers come from – one row per kind of error (route or
// command, error name, short message, count in the range, trend, last
// time); opened, its occurrences (time, request id, status, instance,
// version, role) and the stack frames, and a plain-text report to copy into
// an issue. A click on the error chart above filters to that time slot.
// Data: /api/admin/monitoring?view=errors (lib/error-details.ts), loaded
// when the section opens and whenever the dashboard counts new errors.
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowClockwise, CheckCircle, Copy, Trash, X } from "@phosphor-icons/react";
import type { ErrorDetails } from "@/lib/error-details";
import { frameText, issueReport, type ErrorGroupView, type ErrorOccurrence } from "@/lib/error-report";
import { useT } from "../../i18n";
import { api } from "../../ui";
import { Sparkline } from "../../sparkline";
import { EmptyState, ResponsiveTable } from "../../settings-ui";
import { useAdmin } from "../admin-context";
import { ago, clock, dateTime, num } from "./monitoring-format";

type T = (de: string, en: string) => string;
type Range = "1h" | "24h" | "7d";
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
                  <ErrorGroup key={g.fingerprint} g={g} n={n} values={trend(g, data.since, now)} t={t} now={now} />
                ))}
              </ul>
            )}
            {data.total > data.groups.length && (
              <p className="muted">{t(`Die ${num(data.groups.length)} zuletzt aufgetretenen von ${num(data.total)} Fehlerarten.`, `The ${num(data.groups.length)} most recent of ${num(data.total)} kinds of errors.`)}</p>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function ErrorGroup({ g, n, values, t, now }: { g: ErrorGroupView; n: number; values: number[]; t: T; now: number }) {
  const [copied, setCopied] = useState<"" | "report" | "stack">("");
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
          <div className="mon-error-actions">
            <button type="button" className="button compact" onClick={() => copy("report", issueReport(g))}>
              <Copy size={15} aria-hidden /> {copied === "report" ? t("Kopiert", "Copied") : t("Kopieren für ein Issue", "Copy for an issue")}
            </button>
            {!!g.frames.length && (
              <button type="button" className="button compact" onClick={() => copy("stack", stack)}>
                {copied === "stack" ? t("Kopiert", "Copied") : t("Stack kopieren", "Copy stack")}
              </button>
            )}
          </div>
        </div>
      </details>
    </li>
  );
}
