"use client";
// Administration → Aktivitätsprotokoll: the latest changes, filtered by
// person, kind and text, as a table (a list on phones), and the export of any
// period as CSV or JSON.
import { useMemo, useState } from "react";
import { DownloadSimple, ListChecks, MagnifyingGlass } from "@phosphor-icons/react";
import { useT } from "../../i18n";
import { Select } from "../../select";
import { EmptyState, ResponsiveTable, SettingGroup, SettingRow } from "../../settings-ui";
import { useAdminData } from "../admin-context";
import { AdminLoading } from "../shell";
import { AdminStatus } from "./parts";
import { auditTime } from "./format";

const PAGE = 25;
const DAY = 86_400_000;
const parse = (value: string) => Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : `${value.replace(" ", "T")}Z`);

export default function AuditSection() {
  const t = useT();
  const { data } = useAdminData();
  const [query, setQuery] = useState(""),
    [person, setPerson] = useState(""),
    [kind, setKind] = useState(""),
    [limit, setLimit] = useState(PAGE);
  const entries = data?.audit ?? [];
  const people = useMemo(() => [...new Set(entries.map((a) => a.name || ""))].sort((a, b) => a.localeCompare(b)), [entries]);
  // "page.update" → "page": the kinds of change that occur.
  const kinds = useMemo(() => [...new Set(entries.map((a) => a.action.split(".")[0]))].sort(), [entries]);
  if (!data) return <AdminLoading />;
  const needle = query.trim().toLocaleLowerCase();
  const shown = entries.filter(
    (a) =>
      (!person || (a.name || "") === person) &&
      (!kind || a.action.split(".")[0] === kind) &&
      (!needle || `${a.name || t("System", "System")} ${a.action} ${a.resource_id}`.toLocaleLowerCase().includes(needle)),
  );
  const day = entries.filter((a) => Date.now() - parse(a.created_at) < DAY).length;
  const filtered = !!(needle || person || kind);
  return (
    <>
      <AdminStatus
        items={[
          {
            tone: "info",
            label: day === 1 ? t("1 Änderung in 24 Stunden", "1 change in 24 hours") : t(`${day} Änderungen in 24 Stunden`, `${day} changes in 24 hours`),
          },
        ]}
      >
        {t(`Hier stehen die letzten ${entries.length} Einträge; ältere enthält der Export.`, `The latest ${entries.length} entries are shown here; the export holds older ones.`)}
      </AdminStatus>
      <section className="admin-list-card" aria-labelledby="admin-audit-title">
        <header className="admin-users-head">
          <h2 id="admin-audit-title">
            {t("Letzte Änderungen", "Latest changes")} <span className="muted">· {filtered ? `${shown.length} / ${entries.length}` : entries.length}</span>
          </h2>
        </header>
        <div className="admin-filters" role="group" aria-label={t("Filter", "Filter")}>
          <span className="admin-search">
            <MagnifyingGlass size={16} aria-hidden />
            <input
              type="search"
              aria-label={t("Protokoll durchsuchen", "Search the log")}
              placeholder={t("Person, Aktion oder Kennung …", "Person, action or id …")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </span>
          <Select aria-label={t("Person", "Person")} value={person} onChange={(e) => setPerson(e.target.value)}>
            <option value="">{t("Alle Personen", "Everyone")}</option>
            {people.map((p) => (
              <option key={p || "system"} value={p}>
                {p || t("System", "System")}
              </option>
            ))}
          </Select>
          <Select aria-label={t("Art", "Kind")} value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">{t("Alle Arten", "All kinds")}</option>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </Select>
          {filtered && (
            <button
              type="button"
              className="button"
              onClick={() => {
                setQuery("");
                setPerson("");
                setKind("");
              }}
            >
              {t("Filter zurücksetzen", "Reset filters")}
            </button>
          )}
        </div>
        <ResponsiveTable
          label={t("Aktivitätsprotokoll", "Activity log")}
          rows={shown.slice(0, limit)}
          rowKey={(a) => a.id}
          empty={
            <EmptyState icon={<ListChecks size={18} />} title={filtered ? t("Keine passenden Einträge", "No matching entries") : t("Noch keine Einträge", "No entries yet")}>
              {filtered ? t("Ändere die Suche oder die Filter.", "Change the search or the filters.") : undefined}
            </EmptyState>
          }
          columns={[
            {
              key: "action",
              header: t("Aktion", "Action"),
              primary: true,
              render: (a) => <code className="admin-break">{a.action}</code>,
            },
            {
              key: "who",
              header: t("Person", "Person"),
              render: (a) => a.name || t("System", "System"),
            },
            {
              key: "when",
              header: t("Zeitpunkt", "Time"),
              render: (a) => <span className="admin-nowrap">{auditTime(a.created_at)}</span>,
            },
            {
              key: "resource",
              header: t("Ressource", "Resource"),
              hideOnPhone: true,
              render: (a) => <small title={a.resource_id}>{a.resource_id.slice(0, 8)}</small>,
            },
          ]}
        />
        {shown.length > limit && (
          <div className="admin-more">
            <button type="button" className="button" onClick={() => setLimit(limit + PAGE)}>
              {t(`Weitere anzeigen (${shown.length - limit})`, `Show more (${shown.length - limit})`)}
            </button>
          </div>
        )}
      </section>
      <AuditExport />
    </>
  );
}

// The whole log for a period (UTC days, as stored) as CSV (semicolons, for
// Excel) or JSON.
function AuditExport() {
  const t = useT();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const href = (format: "csv" | "json") => {
    const params = new URLSearchParams({ export: "audit", format });
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    return `/api/admin/operations?${params}`;
  };
  return (
    <SettingGroup
      id="export"
      title={t("Exportieren", "Export")}
      description={t("Das ganze Protokoll eines Zeitraums. Leer = von Anfang an bzw. bis heute.", "The whole log of a period. Empty = from the start or until today.")}
    >
      <SettingRow id="audit-from" label={t("Von (UTC)", "From (UTC)")}>
        <input id="audit-from" className="control-md" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
      </SettingRow>
      <SettingRow id="audit-to" label={t("Bis (UTC)", "To (UTC)")}>
        <input id="audit-to" className="control-md" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
      </SettingRow>
      <SettingRow label={t("Format", "Format")} description={t("CSV mit Semikolons (für Excel) oder JSON.", "CSV with semicolons (for Excel) or JSON.")}>
        <a className="button" href={href("csv")} download>
          <DownloadSimple size={16} aria-hidden /> CSV
        </a>
        <a className="button" href={href("json")} download>
          <DownloadSimple size={16} aria-hidden /> JSON
        </a>
      </SettingRow>
    </SettingGroup>
  );
}
