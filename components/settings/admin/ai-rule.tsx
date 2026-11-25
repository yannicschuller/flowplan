"use client";
// The "KI" part of a person's details (Administration → Benutzer) and of a
// workspace group's dialog: which model of the instance's provider they use
// (lib/ai/model-policy.ts), their quota limits – the same rules as the
// limits table of Administration → KI → Kontingente – and what they used.
// Saved at once (admin.aiRule, lib/ai/admin-rule.ts); the server decides,
// this only shows it.
import { useCallback, useEffect, useId, useState } from "react";
import { ArrowsClockwise, Sparkle } from "@phosphor-icons/react";
import { useT } from "../../i18n";
import { api } from "../../ui";
import { Select } from "../../select";
import { SaveState, useSaveState } from "../../settings-ui";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { upToLabel } from "../../ai-model-choice";
import type { AiRuleView } from "@/lib/ai/admin-rule";
import { QUOTA_PERIODS, quotaShare, type ModelDefault, type ModelPolicy, type QuotaLimits, type QuotaPeriod, type QuotaUnit } from "@/lib/ai/quota-shared";

type T = (de: string, en: string) => string;
type Scope = "user" | "group" | "role";

// i18n-table: 1 – [German, English] pairs
export const PERIOD_NAMES: Record<QuotaPeriod, readonly [string, string]> = {
  day: ["Tag", "Day"],
  week: ["Woche", "Week"],
  month: ["Monat", "Month"],
  year: ["Jahr", "Year"],
};
// i18n-table: 1 – [German, English] pairs
export const ROLE_NAMES: Record<string, readonly [string, string]> = {
  admin: ["Administratoren", "Administrators"],
  guest: ["Gäste (nur Gastzugänge)", "Guests (guest access only)"],
};

// One limit: empty is none; commits on Enter or leaving the field.
export function LimitInput({ value, unit, label, placeholder, disabled, onCommit }: { value: number | null | undefined; unit: QuotaUnit; label: string; placeholder?: string; disabled?: boolean; onCommit: (v: number | null) => void }) {
  const t = useT();
  const [raw, setRaw] = useState(value === null || value === undefined ? "" : String(value));
  useEffect(() => setRaw(value === null || value === undefined ? "" : String(value)), [value]);
  const commit = () => {
    const text = raw.trim().replace(",", ".");
    const next = text === "" ? null : Number(text);
    if (next !== null && (!Number.isFinite(next) || next < 0)) return setRaw(value === null || value === undefined ? "" : String(value));
    if ((next ?? null) !== (value ?? null)) onCommit(next === null ? null : unit === "tokens" ? Math.round(next) : Math.round(next * 100) / 100);
  };
  return (
    <input
      type="number"
      inputMode="decimal"
      className="ai-quota-limit"
      min={0}
      step={unit === "tokens" ? 1000 : 0.01}
      placeholder={placeholder ?? t("ohne", "none")}
      aria-label={label}
      disabled={disabled}
      value={raw}
      onChange={(e) => setRaw(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
    />
  );
}

// "Nach Erreichen des Kontingents": AI off, or go on with a model of the
// instance's provider (counted, not limited; lib/ai/quota.ts).
export function AfterSelect({ id, value, active, options, label, className = "", onChange }: { id?: string; value: string | null; active: boolean; options: string[]; label: string; className?: string; onChange: (model: string | null) => void }) {
  const t = useT();
  const list = [...new Set([...options, ...(value ? [value] : [])])].sort((a, b) => a.localeCompare(b));
  return (
    <Select id={id} className={className} aria-label={id ? undefined : label} value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">{t("KI aus", "AI off")}</option>
      {list.map((m) => (
        <option key={m} value={m}>
          {value === m && !active ? t(`weiter mit ${m} (anderer Anbieter – gilt nicht)`, `go on with ${m} (other provider – does not apply)`) : t(`weiter mit ${m}`, `go on with ${m}`)}
        </option>
      ))}
    </Select>
  );
}

// The continuation's own limit beside "Danach": "höchstens … (leer =
// unbegrenzt)" in the quota's unit for one period (lib/ai/quota.ts
// after_limits); once used up, AI is off until the period resets.
export function AfterLimitField({ value, unit, currency, label, onChange }: { value: QuotaLimits | null | undefined; unit: QuotaUnit; currency: string; label: string; onChange: (limits: QuotaLimits | null) => void }) {
  const t = useT();
  const current = QUOTA_PERIODS.find((p) => typeof value?.[p] === "number");
  const [period, setPeriod] = useState<QuotaPeriod>(current ?? "month");
  useEffect(() => {
    if (current) setPeriod(current);
  }, [current]);
  const amount = current ? (value![current] as number) : null;
  return (
    <span className="ai-quota-after-limit">
      <span className="muted">{t("höchstens", "at most")}</span>
      <LimitInput value={amount} unit={unit} placeholder={t("unbegrenzt", "unlimited")} label={t(`${label}: höchstens (leer = unbegrenzt, ${unit === "tokens" ? "Tokens" : currency})`, `${label}: at most (empty = unlimited, ${unit === "tokens" ? "tokens" : currency})`)} onCommit={(v) => onChange(v === null ? null : { [period]: v })} />
      <Select
        className="ai-quota-after-period"
        aria-label={t(`${label}: Zeitraum`, `${label}: period`)}
        value={period}
        onChange={(e) => {
          const next = e.target.value as QuotaPeriod;
          setPeriod(next);
          if (amount !== null) onChange({ [next]: amount });
        }}
      >
        {QUOTA_PERIODS.map((p) => (
          <option key={p} value={p}>
            {t(AFTER_PERIODS[p][0], AFTER_PERIODS[p][1])}
          </option>
        ))}
      </Select>
    </span>
  );
}
// i18n-table: 1 – [German, English] pairs
const AFTER_PERIODS: Record<QuotaPeriod, readonly [string, string]> = {
  day: ["am Tag", "a day"],
  week: ["in der Woche", "a week"],
  month: ["im Monat", "a month"],
  year: ["im Jahr", "a year"],
};

// The default of a choice ("Bis … – frei wählbar"): what its members get
// until they pick a model themselves. A new choice starts with the
// smallest (the form sends it); older rules are on the most capable.
export const defaultModelLabel = (d: ModelDefault, t: T) => (d === "smallest" ? t("Standard: kleinstes Modell", "Default: smallest model") : t("Standard: stärkstes Modell", "Default: most capable model"));
export function DefaultModelSelect({ value, label, id, className = "", onChange }: { value: ModelDefault; label: string; id?: string; className?: string; onChange: (d: ModelDefault) => void }) {
  const t = useT();
  return (
    <Select id={id} className={className} aria-label={id ? undefined : label} value={value} onChange={(e) => onChange(e.target.value as ModelDefault)}>
      <option value="smallest">{defaultModelLabel("smallest", t)}</option>
      <option value="largest">{defaultModelLabel("largest", t)}</option>
    </Select>
  );
}
// What a model rule of a group or role offers, in a few words.
export function choiceText(policy: ModelPolicy, t: T) {
  const list = policy.allowed?.join(", ") ?? policy.model;
  return policy.smallest ? t(`${list} · Standard: ${policy.standard} (kleinstes)`, `${list} · default: ${policy.standard} (smallest)`) : t(`${list} · Standard: ${policy.standard ?? policy.model}`, `${list} · default: ${policy.standard ?? policy.model}`);
}

// Where a model comes from, in a few words.
export function modelSource(policy: ModelPolicy | null, t: T, groupNames: Record<string, string> = {}) {
  if (!policy || policy.source === "instance") return t("Standard der Instanz", "Instance default");
  if (policy.source === "user") return policy.model === policy.default ? t("Standard der Instanz (fest)", "Instance default (fixed)") : t("eigene Einstellung", "own setting");
  if (policy.source === "role") {
    const role = ROLE_NAMES[policy.target || ""];
    return role ? t(`Rolle ${role[0]}`, `role ${role[1]}`) : t("Rolle", "role");
  }
  const name = groupNames[policy.target || ""];
  return name ? t(`Gruppe ${name}`, `group ${name}`) : t("Gruppe", "group");
}

export function AiRulePanel({ scope, target, name, className = "" }: { scope: Scope; target: string; name: string; className?: string }) {
  const t = useT();
  const [view, setView] = useState<AiRuleView | null>(null);
  const [error, setError] = useState("");
  const [fetched, setFetched] = useState<string[]>([]);
  const [fetching, setFetching] = useState(false);
  const [status, run] = useSaveState();
  const ids = { model: useId(), modelDefault: useId(), quota: useId(), after: useId() };
  const load = useCallback(async () => {
    try {
      setView(await api<AiRuleView>(`/api/ai/admin/rule?scope=${scope}&target=${encodeURIComponent(target)}`));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, [scope, target]);
  useEffect(() => void load(), [load]);
  const save = (patch: { model?: string | null; choice?: boolean; defaultModel?: ModelDefault; quota?: { exempt: boolean; limits: QuotaLimits; after?: string | null } | null }) =>
    void run(async () => {
      setView(await api<AiRuleView>("/api/command", { action: "admin.aiRule", scope, target, ...patch }));
    });
  const fetchModels = async () => {
    setFetching(true);
    setError("");
    try {
      setFetched((await api<{ models: string[] }>("/api/ai/admin/models", {})).models);
    } catch (e) {
      setError(t("Modelle konnten nicht abgerufen werden: ", "Could not fetch the models: ") + (e as Error).message);
    } finally {
      setFetching(false);
    }
  };
  const head = (
    <div className="ai-rule-head">
      <h3>
        <Sparkle size={15} aria-hidden /> {t("KI", "AI")}
      </h3>
      <SaveState status={status} />
    </div>
  );
  if (!view)
    return (
      <section className={`ai-rule ${className}`} aria-label={t(`KI für ${name}`, `AI for ${name}`)}>
        {head}
        <p className="muted ai-rule-note" role="status">
          {error || t("Wird geladen …", "Loading …")}
        </p>
      </section>
    );
  const amount = (n: number) =>
    view.unit === "cost" ? n.toLocaleString(LOCALE_TAG, { style: "currency", currency: view.currency, maximumFractionDigits: 2 }) : n.toLocaleString(LOCALE_TAG, { maximumFractionDigits: 0 });
  const unitName = view.unit === "cost" ? view.currency : t("Tokens", "Tokens");
  // The model.
  const own = view.model.own;
  const modelValue = !own ? "inherit" : own.model === "" ? "default" : `${own.choice ? "c" : "m"}:${own.model}`;
  const options = [...new Set([...view.model.options, ...fetched, ...(own?.model ? [own.model] : [])])].sort((a, b) => a.localeCompare(b));
  // "Bis … – frei wählbar" (#538): groups and roles only.
  const ranges = view.model.ranges;
  const choices = scope === "user" ? [] : [...new Set([...Object.keys(ranges), ...(own?.choice && own.model ? [own.model] : [])])].sort((a, b) => a.localeCompare(b));
  const effective = view.model.effective;
  const inherited = view.model.inherited;
  // The quota: inherited (no own rule), own limits, or exempt.
  const quota = view.quota.own;
  const quotaValue = !quota ? "inherit" : quota.exempt ? "exempt" : "own";
  const inheritedLimits = view.quota.inherited;
  const limitsText = (limits: QuotaLimits | null | undefined) => {
    const set = QUOTA_PERIODS.filter((p) => typeof limits?.[p] === "number");
    return set.length ? set.map((p) => `${t(PERIOD_NAMES[p][0], PERIOD_NAMES[p][1])} ${amount(limits![p] as number)}`).join(" · ") : t("keine Grenze", "no limit");
  };
  const inheritedText =
    scope !== "user"
      ? ""
      : inheritedLimits?.exempt
        ? t("ausgenommen (Gruppe oder Rolle)", "exempt (group or role)")
        : inheritedLimits?.source === "group"
          ? t(`Gruppe oder Rolle: ${limitsText(inheritedLimits.limits)}`, `group or role: ${limitsText(inheritedLimits.limits)}`)
          : inheritedLimits?.source === "default"
            ? t(`Standard je Person: ${limitsText(inheritedLimits.limits)}`, `default per person: ${limitsText(inheritedLimits.limits)}`)
            : t("keine Grenze", "no limit");
  const setLimit = (period: QuotaPeriod, v: number | null) => {
    const limits: QuotaLimits = { ...(quota?.limits || {}) };
    if (v === null) delete limits[period];
    else limits[period] = v;
    save({ quota: { exempt: false, limits, after: quota?.after ?? null } });
  };
  return (
    <section className={`ai-rule ${className}`} aria-label={t(`KI für ${name}`, `AI for ${name}`)}>
      {head}
      {error && (
        <p className="ai-rule-note ai-rule-error" role="alert">
          {error}
        </p>
      )}
      {!view.provider ? (
        <p className="muted ai-rule-note">{t("Die Instanz hat noch keinen KI-Anbieter (Einstellungen → Instanz → KI).", "The instance has no AI provider yet (Settings → Instance → AI).")}</p>
      ) : (
        <>
          <div className="ai-rule-row">
            <span className="ai-rule-text">
              <label htmlFor={ids.model}>{t("Modell", "Model")}</label>
              <small>
                {own && !view.model.active
                  ? t("Für einen anderen Anbieter gewählt – gilt nicht, bis du es neu setzt.", "Chosen for another provider – it does not apply until you set it again.")
                  : effective?.allowed
                    ? t(`Zur Wahl: ${effective.allowed.join(", ")} – Standard ${effective.model} (${modelSource(effective, t, view.groupNames)})`, `To choose from: ${effective.allowed.join(", ")} – default ${effective.model} (${modelSource(effective, t, view.groupNames)})`)
                    : t(`Verwendet: ${effective?.model || view.provider.model} (${modelSource(effective, t, view.groupNames)})`, `In use: ${effective?.model || view.provider.model} (${modelSource(effective, t, view.groupNames)})`)}
              </small>
            </span>
            <span className="ai-rule-control">
              <Select
                id={ids.model}
                className="ai-rule-select"
                value={modelValue}
                onChange={(e) => {
                  const v = e.target.value;
                  const choice = v.startsWith("c:");
                  // A new choice starts with the smallest model as the default.
                  save({ model: v === "inherit" ? null : v === "default" ? "" : v.slice(2), choice, ...(choice && !own?.choice ? { defaultModel: "smallest" as const } : {}) });
                }}
              >
                {scope === "user" ? (
                  <>
                    <option value="inherit">
                      {inherited && inherited.source !== "instance"
                        ? t(`Wie ${modelSource(inherited, t, view.groupNames)} (${inherited.model})`, `As ${modelSource(inherited, t, view.groupNames)} (${inherited.model})`)
                        : t(`Standard der Instanz (${view.provider.model})`, `Instance default (${view.provider.model})`)}
                    </option>
                    {((inherited && inherited.source !== "instance") || own?.model === "") && <option value="default">{t(`Standard der Instanz (${view.provider.model})`, `Instance default (${view.provider.model})`)}</option>}
                  </>
                ) : (
                  <option value="inherit">{t(`Standard der Instanz (${view.provider.model})`, `Instance default (${view.provider.model})`)}</option>
                )}
                {options
                  .filter((m) => m !== view.provider!.model || (own?.model === m && view.model.active))
                  .map((m) => (
                    <option key={m} value={`m:${m}`}>
                      {m}
                    </option>
                  ))}
                {choices.map((m) => (
                  <option key={`c:${m}`} value={`c:${m}`} title={(ranges[m] || [m]).join(", ")}>
                    {upToLabel(m, t)}
                  </option>
                ))}
              </Select>
              <button type="button" className="icon-button" disabled={fetching} aria-label={t("Modelle des Anbieters abrufen", "Fetch the provider's models")} title={t("Modelle des Anbieters abrufen", "Fetch the provider's models")} onClick={() => void fetchModels()}>
                <ArrowsClockwise size={16} aria-hidden />
              </button>
            </span>
          </div>
          {own?.choice && own.model && (
            <div className="ai-rule-row">
              <span className="ai-rule-text">
                <label htmlFor={ids.modelDefault}>{t("Standardmodell", "Default model")}</label>
                <small>{t("Was die Mitglieder bekommen, bis sie selbst ein Modell wählen.", "What the members get until they pick a model themselves.")}</small>
              </span>
              <span className="ai-rule-control">
                <DefaultModelSelect id={ids.modelDefault} className="ai-rule-select" label={t("Standardmodell", "Default model")} value={own.defaultModel ?? "largest"} onChange={(d) => save({ model: own.model, choice: true, defaultModel: d })} />
              </span>
            </div>
          )}
          <div className="ai-rule-row">
            <span className="ai-rule-text">
              <label htmlFor={ids.quota}>{t("Kontingent", "Quota")}</label>
              <small>{quotaValue === "inherit" && scope === "user" ? inheritedText : quotaValue === "exempt" ? t("Keine persönlichen Grenzen; die Grenze der Instanz gilt weiter.", "No personal limits; the instance's ceiling still applies.") : scope === "user" ? t(`In ${unitName}; leer heißt: keine Grenze für diesen Zeitraum.`, `In ${unitName}; empty means: no limit for that period.`) : t(`Für jedes Mitglied, in ${unitName}; es gilt die höchste Grenze der Gruppen und Rollen einer Person.`, `For every member, in ${unitName}; a person gets the highest limit of their groups and roles.`)}</small>
            </span>
            <span className="ai-rule-control">
              <Select
                id={ids.quota}
                className="ai-rule-select"
                value={quotaValue}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "inherit") save({ quota: null });
                  else if (v === "exempt") save({ quota: { exempt: true, limits: {} } });
                  // Own limits start from what applied so far.
                  else save({ quota: { exempt: false, limits: (scope === "user" && !inheritedLimits?.exempt ? inheritedLimits?.limits : null) || {} } });
                }}
              >
                <option value="inherit">{scope === "user" ? t("Geerbt", "Inherited") : t("Keine Grenze der Gruppe", "No group limit")}</option>
                <option value="own">{t("Eigene Grenzen", "Own limits")}</option>
                <option value="exempt">{t("Ausgenommen", "Exempt")}</option>
              </Select>
            </span>
          </div>
          {quotaValue === "own" && (
            <div className="ai-rule-row">
              <span className="ai-rule-text">
                <label htmlFor={ids.after}>{t("Nach Erreichen des Kontingents", "Once the quota is reached")}</label>
                <small>{t("KI aus – oder weiter mit einem anderen Modell: gezählt, aber nicht begrenzt; die Grenze der ganzen Instanz gilt weiter.", "AI off – or go on with another model: counted, but not limited; the whole instance's ceiling still applies.")}</small>
              </span>
              <span className="ai-rule-control">
                <AfterSelect
                  id={ids.after}
                  className="ai-rule-select"
                  label={t("Nach Erreichen des Kontingents", "Once the quota is reached")}
                  value={quota?.after ?? null}
                  active={!quota?.after || quota.afterKind === view.provider.kind}
                  options={view.model.options}
                  onChange={(after) => save({ quota: { exempt: false, limits: quota?.limits || {}, after } })}
                />
              </span>
            </div>
          )}
          {quotaValue === "inherit" && scope === "user" && view.quota.after && <p className="muted ai-rule-note">{t(`Danach weiter mit ${view.quota.after}.`, `Then goes on with ${view.quota.after}.`)}</p>}
          {quotaValue === "own" && (
            <div className="ai-rule-limits">
              {QUOTA_PERIODS.map((p) => (
                <label key={p}>
                  <span>{t(PERIOD_NAMES[p][0], PERIOD_NAMES[p][1])}</span>
                  <LimitInput value={quota?.limits[p]} unit={view.unit} label={t(`${name}: ${PERIOD_NAMES[p][0]}`, `${name}: ${PERIOD_NAMES[p][1]}`)} onCommit={(v) => setLimit(p, v)} />
                </label>
              ))}
            </div>
          )}
          <Usage view={view} amount={amount} t={t} />
        </>
      )}
    </section>
  );
}

// What was used per period (a person, or the members of a group together),
// with the limit and a bar where one applies.
function Usage({ view, amount, t }: { view: AiRuleView; amount: (n: number) => string; t: T }) {
  if (view.scope === "role") return null;
  return (
    <div className="ai-rule-usage">
      <p className="ai-rule-usage-head">{view.scope === "group" ? t(`Verbrauch der ${view.members ?? 0} Mitglieder`, `Usage of the ${view.members ?? 0} members`) : t("Verbrauch", "Usage||quota")}</p>
      <ul className="ai-quota-bars">
        {view.usage.map((u) => {
          const share = u.limit !== null ? quotaShare({ limit: u.limit, used: u.used }) : 0;
          const label = t(PERIOD_NAMES[u.period][0], PERIOD_NAMES[u.period][1]);
          return (
            <li key={u.period} className={`ai-quota-bar${share >= 1 ? " full" : share >= 0.8 ? " high" : ""}`}>
              <span className="ai-quota-bar-text">
                <span>{label}</span>
                <strong>
                  {u.limit === null || view.scope === "group"
                    ? amount(u.used)
                    : t(`${amount(u.used)} von ${amount(u.limit)} · ${amount(Math.max(0, u.limit - u.used))} übrig`, `${amount(u.used)} of ${amount(u.limit)} · ${amount(Math.max(0, u.limit - u.used))} left`)}
                </strong>
              </span>
              {u.limit !== null && view.scope === "user" && <progress max={Math.max(u.limit, 1e-9)} value={Math.min(u.used, u.limit)} aria-label={label} />}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
