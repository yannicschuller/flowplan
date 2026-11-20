"use client";
// Administration → KI → Kontingente (#382, lib/ai/quota.ts): the unit
// (tokens or, with prices, cost), the calendar of the periods, the warning
// threshold and workflows; the limits per level (the whole instance, the
// default per person, roles, workspace groups, single accounts – each per
// day, week, month and year, or exempt); and the usage of a period per
// person, group and model with each person's limit.
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { Info, Trash } from "@phosphor-icons/react";
import { useT } from "../../i18n";
import { api, reportError } from "../../ui";
import { Select } from "../../select";
import { ResponsiveTable, SaveState, SettingGroup, SettingRow, Switch, useSaveState } from "../../settings-ui";
import { NumberInput } from "./parts";
import { LimitInput, modelSource, PERIOD_NAMES, ROLE_NAMES } from "./ai-rule";
import { LOCALE_TAG } from "@/lib/locale-tag";
import type { AdminQuotaView } from "@/lib/ai/quota";
import { QUOTA_PERIODS, type QuotaLimits, type QuotaPeriod, type QuotaRule } from "@/lib/ai/quota-shared";

type T = (de: string, en: string) => string;
type Person = AdminQuotaView["people"][number];

const PERIODS = PERIOD_NAMES;
const ROLES = ROLE_NAMES;
// i18n-table: 1 – [German, English] pairs
const SOURCES: Record<string, readonly [string, string]> = {
  user: ["eigene Grenze", "own limit"],
  group: ["Gruppe oder Rolle", "group or role"],
  default: ["Standard", "default"],
  none: ["keine", "none"],
  exempt: ["ausgenommen", "exempt"],
};
const zones = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    return [];
  }
})();

export function AiQuotasSection() {
  const t = useT();
  const [period, setPeriod] = useState<QuotaPeriod>("month");
  const [view, setView] = useState<AdminQuotaView | null>(null);
  const [status, run] = useSaveState();
  const load = useCallback(async () => {
    try {
      setView(await api<AdminQuotaView>(`/api/ai/admin/quotas?period=${period}`));
    } catch (e) {
      reportError(e);
    }
  }, [period]);
  useEffect(() => void load(), [load]);
  const save = (patch: { settings?: Record<string, unknown>; rules?: QuotaRule[] }) =>
    void run(async () => {
      await api("/api/command", { action: "admin.aiQuotas", ...patch });
      await load();
    });
  // One row's model or both of its rules (admin.aiRule, lib/ai/admin-rule.ts).
  const saveRule = (scope: string, target: string, patch: { model?: string | null; quota?: null }) =>
    void run(async () => {
      await api("/api/command", { action: "admin.aiRule", scope, target, ...patch });
      await load();
    });
  if (!view)
    return (
      <SettingGroup id="quotas" title={t("Kontingente", "Quotas")}>
        <p className="settings-loading" role="status">
          {t("Wird geladen …", "Loading …")}
        </p>
      </SettingGroup>
    );
  const amount = (n: number | null) =>
    n === null ? "–" : view.settings.unit === "cost" ? n.toLocaleString(LOCALE_TAG, { style: "currency", currency: view.currency, maximumFractionDigits: 2 }) : n.toLocaleString(LOCALE_TAG, { maximumFractionDigits: 0 });
  return (
    <>
      <QuotaSettings view={view} save={save} status={status} />
      <QuotaLimitsTable view={view} save={save} saveRule={saveRule} />
      <SettingGroup
        id="quota-usage"
        title={t("Nutzung und Grenzen", "Usage and limits")}
        description={t(
          `Verbrauch über den Anbieter der Instanz in diesem Zeitraum (ab ${view.start}). Eigene Anbieter und die KI auf dem Gerät zählen nicht.`,
          `Usage through the instance's provider in this period (since ${view.start}). Own providers and on-device AI do not count.`,
        )}
        actions={
          <label className="mon-range">
            <span>{t("Zeitraum", "Period")}</span>
            <Select value={period} onChange={(e) => setPeriod(e.target.value as QuotaPeriod)}>
              {QUOTA_PERIODS.map((p) => (
                <option key={p} value={p}>
                  {t(PERIODS[p][0], PERIODS[p][1])}
                </option>
              ))}
            </Select>
          </label>
        }
      >
        <p className="ai-quota-instance">
          {view.instance.limit !== null
            ? t(`Ganze Instanz: ${amount(view.instance.used)} von ${amount(view.instance.limit)}`, `Whole instance: ${amount(view.instance.used)} of ${amount(view.instance.limit)}`)
            : t(`Ganze Instanz: ${amount(view.instance.used)} (ohne Obergrenze)`, `Whole instance: ${amount(view.instance.used)} (no ceiling)`)}
          {view.workflows.tokens > 0 && (
            <small className="muted">
              {" · "}
              {view.settings.workflowsCountInstance
                ? t(`davon Workflows ${view.workflows.tokens.toLocaleString(LOCALE_TAG)} Tokens`, `workflows ${view.workflows.tokens.toLocaleString(LOCALE_TAG)} tokens of it`)
                : t(`Workflows ${view.workflows.tokens.toLocaleString(LOCALE_TAG)} Tokens (zählen nicht)`, `workflows ${view.workflows.tokens.toLocaleString(LOCALE_TAG)} tokens (not counted)`)}
            </small>
          )}
        </p>
        <PeopleTable view={view} amount={amount} />
        <h3 className="mon-subhead ai-quota-sub">{t("Nach Gruppe", "By group")}</h3>
        <div className="mon-table">
          <ResponsiveTable
            label={t("Nach Gruppe", "By group")}
            rows={view.groups.filter((g) => g.used > 0 || g.tokens > 0)}
            rowKey={(g) => g.id}
            empty={<p className="muted ai-quota-empty">{t("Keine Nutzung durch Gruppenmitglieder.", "No usage by group members.")}</p>}
            columns={[
              { key: "name", header: t("Gruppe", "Group"), primary: true, render: (g) => `${g.workspace ?? "–"} · ${g.name}` },
              { key: "members", header: t("Mitglieder", "Members"), align: "end", render: (g) => String(g.members) },
              { key: "used", header: t("Verbraucht", "Used||quota"), align: "end", render: (g) => amount(g.used) },
              { key: "tokens", header: t("Tokens", "Tokens"), align: "end", hideOnPhone: true, render: (g) => g.tokens.toLocaleString(LOCALE_TAG) },
            ]}
          />
        </div>
        <h3 className="mon-subhead ai-quota-sub">{t("Nach Modell", "By model")}</h3>
        <div className="mon-table">
          <ResponsiveTable
            label={t("Nach Modell", "By model")}
            rows={view.models}
            rowKey={(m) => m.model || "-"}
            empty={<p className="muted ai-quota-empty">{t("Noch keine Nutzung in diesem Zeitraum.", "No usage in this period yet.")}</p>}
            columns={[
              {
                key: "name",
                header: t("Modell", "Model"),
                primary: true,
                render: (m) => (
                  <span>
                    {m.model || t("Unbekannt", "Unknown")}
                    {view.priced && !m.priced && <small className="muted"> · {t("kein Preis", "no price")}</small>}
                  </span>
                ),
              },
              { key: "tokens", header: t("Tokens", "Tokens"), align: "end", render: (m) => m.tokens.toLocaleString(LOCALE_TAG) },
              { key: "cost", header: t("Kosten (geschätzt)", "Cost (estimated)"), align: "end", render: (m) => (m.cost === null ? "–" : m.cost.toLocaleString(LOCALE_TAG, { style: "currency", currency: view.currency, maximumFractionDigits: 2 })) },
            ]}
          />
        </div>
      </SettingGroup>
    </>
  );
}

function QuotaSettings({ view, save, status }: { view: AdminQuotaView; save: (patch: { settings?: Record<string, unknown> }) => void; status: ReturnType<typeof useSaveState>[0] }) {
  const t = useT();
  const ids = { unit: useId(), zone: useId(), week: useId(), warn: useId() };
  const [zone, setZone] = useState(view.settings.timeZone);
  useEffect(() => setZone(view.settings.timeZone), [view.settings.timeZone]);
  const hasLimits = view.rules.some((r) => QUOTA_PERIODS.some((p) => typeof r.limits[p] === "number"));
  return (
    <SettingGroup
      id="quotas"
      title={t("Kontingente", "Quotas")}
      description={t(
        "Grenzen für KI über den Anbieter der Instanz – je Kalendertag, -woche, -monat und -jahr. Eine Anfrage, die eine Grenze überschreiten würde, wird vorher abgelehnt; eigene Anbieter und die KI auf dem Gerät gehen weiter.",
        "Limits for AI through the instance's provider – per calendar day, week, month and year. A request that would cross a limit is refused before it is sent; own providers and on-device AI keep working.",
      )}
      actions={<SaveState status={status} />}
    >
      <SettingRow
        id={ids.unit}
        label={t("Einheit", "Unit")}
        description={view.priced ? t("Kosten rechnet Flowplan aus den Preisen je Modell oben.", "Flowplan computes cost from the prices per model above.") : t("Kosten gibt es, sobald oben Preise je Modell eingetragen sind.", "Cost becomes available once prices per model are entered above.")}
      >
        <Select
          id={ids.unit}
          value={view.settings.unit}
          onChange={(e) => {
            const unit = e.target.value;
            if (hasLimits && !window.confirm(t("Die eingetragenen Grenzen gelten in der alten Einheit und werden geleert. Fortfahren?", "The limits entered are in the old unit and will be cleared. Continue?"))) return;
            save({ settings: { unit } });
          }}
        >
          <option value="tokens">{t("Tokens (Eingabe und Ausgabe)", "Tokens (input and output)")}</option>
          <option value="cost" disabled={!view.priced}>
            {t(`Kosten (${view.currency})`, `Cost (${view.currency})`)}
          </option>
        </Select>
      </SettingRow>
      {view.missingPrices.length > 0 && (
        <div className="callout" role="note">
          <Info size={20} aria-hidden="true" />
          <span>
            {t(
              `Ohne Preis und daher nicht in den Kostengrenzen: ${view.missingPrices.join(", ")}. Trage oben einen Preis ein.`,
              `No price, so not in the cost limits: ${view.missingPrices.join(", ")}. Enter a price above.`,
            )}
          </span>
        </div>
      )}
      <SettingRow id={ids.zone} label={t("Zeitzone", "Time zone")} description={t("Tage, Wochen, Monate und Jahre beginnen um Mitternacht in dieser Zone.", "Days, weeks, months and years start at midnight in this zone.")}>
        <input
          id={ids.zone}
          className="control-md"
          list={`${ids.zone}-zones`}
          value={zone}
          onChange={(e) => setZone(e.target.value)}
          onBlur={() => zone.trim() && zone !== view.settings.timeZone && save({ settings: { timeZone: zone.trim() } })}
          onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
        />
        <datalist id={`${ids.zone}-zones`}>
          {zones.map((z) => (
            <option key={z} value={z} />
          ))}
        </datalist>
      </SettingRow>
      <SettingRow id={ids.week} label={t("Woche beginnt am", "Week starts on")}>
        <Select id={ids.week} value={view.settings.weekStart} onChange={(e) => save({ settings: { weekStart: e.target.value } })}>
          <option value="monday">{t("Montag", "Monday")}</option>
          <option value="sunday">{t("Sonntag", "Sunday")}</option>
        </Select>
      </SettingRow>
      <SettingRow
        id={ids.warn}
        label={t("Hinweis ab", "Note from")}
        description={t("Ab diesem Anteil sehen Personen einen Hinweis in den KI-Fenstern; für die ganze Instanz bekommen Administratoren eine Benachrichtigung (und beim Erreichen der Grenze).", "From this share people see a note in the AI panels; for the whole instance administrators get a notification (and when the limit is reached).")}
      >
        <NumberInput id={ids.warn} value={view.settings.warnAt} min={1} max={99} unit="%" onCommit={(v) => v !== null && save({ settings: { warnAt: v } })} />
      </SettingRow>
      <SettingRow
        label={t("Workflows zählen zur Instanzgrenze", "Workflows count towards the instance ceiling")}
        description={t("Nie zur Person, als die ein Workflow läuft; jeder Workflow behält sein eigenes Tagesbudget.", "Never towards the person a workflow runs as; every workflow keeps its own daily budget.")}
      >
        <Switch checked={view.settings.workflowsCountInstance} label={t("Workflows zählen zur Instanzgrenze", "Workflows count towards the instance ceiling")} onChange={(on) => save({ settings: { workflowsCountInstance: on } })} />
      </SettingRow>
    </SettingGroup>
  );
}

// A row of the limits table; inherit: only a model is set for it, its
// limits come from elsewhere (no quota rule) until one is entered.
type LimitRow = QuotaRule & { inherit?: boolean };
function QuotaLimitsTable({ view, save, saveRule }: { view: AdminQuotaView; save: (patch: { rules: QuotaRule[] }) => void; saveRule: (scope: string, target: string, patch: { model?: string | null; quota?: null }) => void }) {
  const t = useT();
  const rules = view.rules;
  const unit = view.settings.unit;
  const groupName = (id: string) => {
    const g = view.groups.find((x) => x.id === id);
    return g ? `${g.workspace ?? "–"} · ${g.name}` : t("Gelöschte Gruppe", "Deleted group");
  };
  const personName = (id: string) => {
    const p = view.people.find((x) => x.id === id);
    return p ? `${p.name || p.email}${p.email && p.name ? ` (${p.email})` : ""}` : t("Gelöschtes Konto", "Deleted account");
  };
  const name = (r: Pick<QuotaRule, "scope" | "target">) =>
    r.scope === "instance"
      ? t("Ganze Instanz (alle zusammen)", "Whole instance (everyone together)")
      : r.scope === "default"
        ? t("Standard je Person", "Default per person")
        : r.scope === "role"
          ? t(ROLES[r.target]?.[0] ?? r.target, ROLES[r.target]?.[1] ?? r.target)
          : r.scope === "group"
            ? groupName(r.target)
            : personName(r.target);
  const order = ["instance", "default", "role", "group", "user"];
  const modelOnly: LimitRow[] = view.model.rules.filter((m) => !rules.some((r) => r.scope === m.scope && r.target === m.target)).map((m) => ({ scope: m.scope, target: m.target, exempt: false, limits: {}, inherit: true }));
  const rows: LimitRow[] = [
    rules.find((r) => r.scope === "instance") ?? { scope: "instance", target: "", exempt: false, limits: {} },
    rules.find((r) => r.scope === "default") ?? { scope: "default", target: "", exempt: false, limits: {} },
    ...[...rules.filter((r) => r.scope !== "instance" && r.scope !== "default"), ...modelOnly].sort((a, b) => order.indexOf(a.scope) - order.indexOf(b.scope) || name(a).localeCompare(name(b))),
  ];
  const key = (r: Pick<QuotaRule, "scope" | "target">) => `${r.scope}|${r.target}`;
  const hasNumbers = (r: QuotaRule) => QUOTA_PERIODS.some((p) => typeof r.limits[p] === "number");
  const commit = (next: LimitRow[]) =>
    save({ rules: next.filter((r) => (r.inherit ? r.exempt || hasNumbers(r) : r.exempt || hasNumbers(r) || (r.scope !== "instance" && r.scope !== "default"))).map((r) => ({ scope: r.scope, target: r.target, exempt: r.exempt, limits: r.limits })) });
  const change = (rule: LimitRow, patch: Partial<QuotaRule>) => commit(rows.map((r) => (key(r) === key(rule) ? { ...r, ...patch, inherit: false } : r)));
  const modelOf = (r: Pick<QuotaRule, "scope" | "target">) => view.model.rules.find((m) => m.scope === r.scope && m.target === r.target);
  const setLimit = (rule: QuotaRule, period: QuotaPeriod, v: number | null) => {
    const limits: QuotaLimits = { ...rule.limits };
    if (v === null) delete limits[period];
    else limits[period] = v;
    change(rule, { limits });
  };
  const add = (scope: QuotaRule["scope"], target: string) => {
    if (!target || rows.some((r) => key(r) === `${scope}|${target}`)) return;
    commit([...rows, { scope, target, exempt: false, limits: {} }]);
  };
  const free = useMemo(() => new Set(rows.map(key)), [rows]);
  const groupId = useId(),
    personId = useId();
  return (
    <SettingGroup
      id="quota-limits"
      title={t("Grenzen", "Limits")}
      description={t(
        "Leer heißt: keine Grenze für diesen Zeitraum. Für eine Person gilt ihre eigene Grenze, sonst die höchste ihrer Gruppen und Rollen, sonst der Standard; die Grenze der ganzen Instanz gilt immer zusätzlich. „Ausgenommen“ hebt die persönlichen Grenzen auf.",
        "Empty means: no limit for that period. A person gets their own limit, else the highest of their groups and roles, else the default; the whole instance's ceiling always applies on top. “Exempt” lifts the personal limits.",
      )}
    >
      <div className="mon-table ai-quota-limits">
        <ResponsiveTable
          label={t("Grenzen", "Limits")}
          rows={rows}
          rowKey={key}
          columns={[
            { key: "name", header: t("Für", "For"), primary: true, render: (r) => name(r) },
            ...QUOTA_PERIODS.map((p) => ({
              key: p,
              header: unit === "cost" ? t(`${PERIODS[p][0]} (${view.currency})`, `${PERIODS[p][1]} (${view.currency})`) : t(`${PERIODS[p][0]} (Tokens)`, `${PERIODS[p][1]} (tokens)`),
              render: (r: LimitRow) =>
                r.exempt ? (
                  <span className="muted">–</span>
                ) : (
                  <LimitInput value={r.limits[p]} unit={unit} placeholder={r.inherit ? t("geerbt", "inherited") : undefined} label={`${name(r)}: ${t(PERIODS[p][0], PERIODS[p][1])}`} onCommit={(v) => setLimit(r, p, v)} />
                ),
            })),
            {
              key: "model",
              header: t("Modell", "Model"),
              render: (r) => <ModelCell view={view} rule={r} label={name(r)} own={modelOf(r)} onChange={(model) => saveRule(r.scope, r.target, { model })} />,
            },
            {
              key: "exempt",
              header: t("Ausgenommen", "Exempt"),
              render: (r) =>
                r.scope === "instance" || r.scope === "default" ? null : (
                  <input type="checkbox" checked={r.exempt} aria-label={t(`${name(r)} ausnehmen`, `Exempt ${name(r)}`)} onChange={(e) => change(r, { exempt: e.target.checked, limits: e.target.checked ? {} : r.limits })} />
                ),
            },
            {
              key: "remove",
              header: "",
              render: (r) =>
                r.scope === "instance" || r.scope === "default" ? null : (
                  <button type="button" className="icon-button" aria-label={t(`Grenze für ${name(r)} entfernen`, `Remove the limit for ${name(r)}`)} onClick={() => (modelOf(r) ? saveRule(r.scope, r.target, { quota: null, model: null }) : commit(rows.filter((x) => key(x) !== key(r))))}>
                    <Trash size={16} />
                  </button>
                ),
            },
          ]}
        />
      </div>
      <p className="ai-quota-model-note muted">
        {t(
          `Modell: Eine Person nutzt ihr eigenes Modell, sonst das leistungsfähigste ihrer Gruppen und Rollen (das teuerste laut Preisliste), sonst den Standard der Instanz (${view.model.provider?.model || "–"}). Nur für den Anbieter der Instanz; eigene Anbieter und die KI auf dem Gerät wählen selbst.`,
          `Model: a person uses their own model, else the most capable of their groups and roles (the most expensive by the price list), else the instance default (${view.model.provider?.model || "–"}). Only for the instance's provider; own providers and on-device AI choose their own.`,
        )}
      </p>
      <SettingRow id={groupId} label={t("Gruppe oder Rolle hinzufügen", "Add a group or role")} description={t("Gruppen der Arbeitsbereiche – auch die aus SSO-, SCIM- und LDAP-Gruppen über die SSO-Zuordnungen.", "Workspace groups – also those filled from SSO, SCIM and LDAP groups through the SSO mappings.")}>
        <Select
          id={groupId}
          value=""
          onChange={(e) => {
            const [scope, target] = e.target.value.split(":");
            if (scope === "role" || scope === "group") add(scope, target);
          }}
        >
          <option value="">{t("Auswählen …", "Choose …")}</option>
          {Object.keys(ROLES)
            .filter((r) => !free.has(`role|${r}`))
            .map((r) => (
              <option key={r} value={`role:${r}`}>
                {t(ROLES[r][0], ROLES[r][1])}
              </option>
            ))}
          {view.groups
            .filter((g) => !free.has(`group|${g.id}`))
            .map((g) => (
              <option key={g.id} value={`group:${g.id}`}>
                {`${g.workspace ?? "–"} · ${g.name}`}
              </option>
            ))}
        </Select>
      </SettingRow>
      <SettingRow id={personId} label={t("Person hinzufügen", "Add a person")} description={t("Mehr, weniger oder ausgenommen – für einzelne Konten.", "More, less or exempt – for single accounts.")}>
        <Select id={personId} value="" onChange={(e) => add("user", e.target.value)}>
          <option value="">{t("Auswählen …", "Choose …")}</option>
          {view.people
            .filter((p) => !free.has(`user|${p.id}`))
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name || p.email}
              </option>
            ))}
        </Select>
      </SettingRow>
    </SettingGroup>
  );
}

type Sort = "used" | "left" | "name";
function PeopleTable({ view, amount }: { view: AdminQuotaView; amount: (n: number | null) => string }) {
  const t = useT();
  const [sort, setSort] = useState<Sort>("used");
  const sortId = useId();
  const left = (p: Person) => (p.limit === null || p.exempt ? Infinity : p.limit - p.used);
  const rows = [...view.people]
    .filter((p) => p.used > 0 || p.limit !== null || p.source === "user")
    .sort((a, b) => (sort === "name" ? (a.name || a.email).localeCompare(b.name || b.email) : sort === "left" ? left(a) - left(b) : b.used - a.used));
  return (
    <>
      <div className="ai-quota-people-head">
        <h3 className="mon-subhead ai-quota-sub">{t("Nach Person", "By person")}</h3>
        <label className="mon-range" htmlFor={sortId}>
          <span>{t("Sortieren nach", "Sort by")}</span>
          <Select id={sortId} value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            <option value="used">{t("Verbrauch", "Usage||quota")}</option>
            <option value="left">{t("Rest", "Left||remaining")}</option>
            <option value="name">{t("Name", "Name")}</option>
          </Select>
        </label>
      </div>
      <div className="mon-table">
        <ResponsiveTable
          label={t("Nach Person", "By person")}
          rows={rows}
          rowKey={(p) => p.id}
          empty={<p className="muted ai-quota-empty">{t("Noch keine Nutzung in diesem Zeitraum.", "No usage in this period yet.")}</p>}
          columns={[
            { key: "name", header: t("Person", "Person"), primary: true, render: (p) => p.name || p.email },
            { key: "used", header: t("Verbraucht", "Used||quota"), align: "end", render: (p) => amount(p.used) },
            { key: "limit", header: t("Grenze", "Limit"), align: "end", render: (p) => (p.exempt ? t("ausgenommen", "exempt") : p.limit === null ? "–" : amount(p.limit)) },
            { key: "left", header: t("Übrig", "Left||remaining"), align: "end", render: (p) => (p.exempt || p.limit === null ? "–" : amount(Math.max(0, p.limit - p.used))) },
            { key: "source", header: t("Woher", "From"), hideOnPhone: true, render: (p) => sourceLabel(p, t) },
            { key: "model", header: t("Modell", "Model"), hideOnPhone: true, render: (p) => (p.model ? <span title={modelSource(p.model, t)}>{p.model.model}</span> : "–") },
          ]}
        />
      </div>
    </>
  );
}
const sourceLabel = (p: Person, t: T) => {
  const s = SOURCES[p.exempt ? "exempt" : p.source];
  return s ? t(s[0], s[1]) : p.source;
};

// The model of a row of the limits table: the instance's default for the
// instance and the default per person, a choice for roles, groups and people.
function ModelCell({ view, rule, label, own, onChange }: { view: AdminQuotaView; rule: QuotaRule; label: string; own?: AdminQuotaView["model"]["rules"][number]; onChange: (model: string | null) => void }) {
  const t = useT();
  const fallback = view.model.provider?.model || "";
  if (rule.scope === "instance") return <span className="muted">–</span>;
  if (rule.scope === "default" || !view.model.provider) return <span className="muted">{fallback || "–"}</span>;
  const value = !own ? "inherit" : own.model === "" ? "default" : `m:${own.model}`;
  const options = [...new Set([...view.model.options, ...(own?.model ? [own.model] : [])])].filter((m) => m !== fallback || own?.model === m);
  return (
    <Select
      className="ai-quota-model"
      aria-label={t(`Modell für ${label}`, `Model for ${label}`)}
      value={value}
      onChange={(e) => {
        const v = e.target.value;
        onChange(v === "inherit" ? null : v === "default" ? "" : v.slice(2));
      }}
    >
      {rule.scope === "user" ? (
        <>
          <option value="inherit">{t("Geerbt", "Inherited")}</option>
          <option value="default">{t(`Standard der Instanz (${fallback})`, `Instance default (${fallback})`)}</option>
        </>
      ) : (
        <option value="inherit">{t(`Standard der Instanz (${fallback})`, `Instance default (${fallback})`)}</option>
      )}
      {options.map((m) => (
        <option key={m} value={`m:${m}`}>
          {own?.model === m && !own.active ? t(`${m} (anderer Anbieter – gilt nicht)`, `${m} (other provider – does not apply)`) : m}
        </option>
      ))}
    </Select>
  );
}
