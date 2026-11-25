"use client";
// Administration → Grenzen & Aufbewahrung → Export / Import: the limits and
// AI settings of the paid plans as one JSON file (lib/limits-file.ts) –
// export, paste or upload, "Prüfen" lists every change, "Übernehmen"
// applies them all at once.
import { useState } from "react";
import { DownloadSimple, UploadSimple } from "@phosphor-icons/react";
import { useT } from "../../i18n";
import { SettingGroup } from "../../settings-ui";
import { useAdminData } from "../admin-context";
import { LOCALE_TAG } from "@/lib/locale-tag";
import type { FileIssue, LimitsChange, LimitsImportResult, QuotaSide } from "@/lib/limits-file";

type T = ReturnType<typeof useT>;
const num = (n: number) => n.toLocaleString(LOCALE_TAG);

function periodWord(t: T, period: QuotaSide["period"]) {
  return period === "day" ? t("am Tag", "a day") : period === "week" ? t("in der Woche", "a week") : period === "year" ? t("im Jahr", "a year") : t("im Monat", "a month");
}
function quotaText(t: T, s: QuotaSide | null, unit: "tokens" | "cost", currency: string, scope: string) {
  if (!s) return t("keine Regel", "no rule");
  if (s.exempt) return t("ausgenommen", "exempt");
  const amount = s.limit === null ? t("ohne Grenze", "no limit") : unit === "tokens" ? t(`${num(s.limit)} Tokens`, `${num(s.limit)} tokens`) : `${s.limit.toLocaleString(LOCALE_TAG, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
  const actions = scope !== "instance" && s.actions !== null ? t(`${num(s.actions)} Aktionen (${amount})`, `${num(s.actions)} actions (${amount})`) : amount;
  const afterLimit = typeof s.afterLimit === "number" ? (unit === "tokens" ? t(` (höchstens ${num(s.afterLimit)} Tokens)`, ` (at most ${num(s.afterLimit)} tokens)`) : ` (≤ ${s.afterLimit.toLocaleString(LOCALE_TAG, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency})`) : "";
  const after = scope === "instance" ? "" : s.after ? t(`, danach ${s.after}${afterLimit}`, `, then ${s.after}${afterLimit}`) : t(", danach KI aus", ", then AI off");
  return `${actions} ${periodWord(t, s.period)}${after}`;
}

// One change in plain words.
export function changeText(t: T, c: LimitsChange): string {
  const mb = (v: number | string | null) => (v === null ? t("nicht festgelegt", "not set") : v === 0 ? t("unbegrenzt", "unlimited") : `${num(Number(v))} MB`);
  const count = (v: number | string | null) => (v === null ? t("nicht festgelegt", "not set") : v === 0 ? t("unbegrenzt", "unlimited") : num(Number(v)));
  const mode = (v: number | string | null) => (v === "add" ? t("zusätzlich (Add-on)", "additional (add-on)") : t("Grenze", "limit"));
  const unit = (v: number | string | null) => (v === "cost" ? t("Kosten", "cost") : t("Tokens", "tokens"));
  switch (c.area) {
    case "setting": {
      if (c.field === "defaultUserStorageMb") return t(`Standard: Speicher je Person ${mb(c.before)} → ${mb(c.after)}`, `Default: storage per person ${mb(c.before)} → ${mb(c.after)}`);
      if (c.field === "maxUploadMb") return t(`Standard: größte Datei ${mb(c.before)} → ${mb(c.after)}`, `Default: largest file ${mb(c.before)} → ${mb(c.after)}`);
      if (c.field === "defaultUserWorkspaces") return t(`Standard: eigene Arbeitsbereiche ${count(c.before)} → ${count(c.after)}`, `Default: own workspaces ${count(c.before)} → ${count(c.after)}`);
      if (c.field === "unit") return t(`KI-Kontingente: Einheit ${unit(c.before)} → ${unit(c.after)}`, `AI quotas: unit ${unit(c.before)} → ${unit(c.after)}`);
      const link = (v: number | string | null) => (v ? String(v) : t("kein Link", "no link"));
      return t(`Link für mehr Speicher oder KI: ${link(c.before)} → ${link(c.after)}`, `Link for more storage or AI: ${link(c.before)} → ${link(c.after)}`);
    }
    case "limits": {
      if (c.field === "storageMb") return t(`Gruppe ${c.name}: Speicher ${mb(c.before)} → ${mb(c.after)}`, `Group ${c.name}: storage ${mb(c.before)} → ${mb(c.after)}`);
      if (c.field === "uploadMb") return t(`Gruppe ${c.name}: größte Datei ${mb(c.before)} → ${mb(c.after)}`, `Group ${c.name}: largest file ${mb(c.before)} → ${mb(c.after)}`);
      if (c.field === "workspaces") return t(`Gruppe ${c.name}: eigene Arbeitsbereiche ${count(c.before)} → ${count(c.after)}`, `Group ${c.name}: own workspaces ${count(c.before)} → ${count(c.after)}`);
      return t(`Gruppe ${c.name}: Art des Speichers ${mode(c.before)} → ${mode(c.after)}`, `Group ${c.name}: kind of storage ${mode(c.before)} → ${mode(c.after)}`);
    }
    case "limitsRemoved":
      return t(`Gruppe ${c.name}: Grenzen entfernt`, `Group ${c.name}: limits removed`);
    case "quota": {
      const who =
        c.scope === "default" ? t("KI-Standard je Person", "AI default per person") : c.scope === "instance" ? t("KI-Grenze der Instanz", "AI ceiling of the instance") : c.scope === "role" ? t(`KI-Regel für Rolle ${c.name}`, `AI rule for role ${c.name}`) : t(`KI-Regel für ${c.name}`, `AI rule for ${c.name}`);
      if (!c.before) return t(`${who}: neu, ${quotaText(t, c.after, c.unit, c.currency, c.scope)}`, `${who}: new, ${quotaText(t, c.after, c.unit, c.currency, c.scope)}`);
      if (!c.after) return t(`${who}: entfernt (war ${quotaText(t, c.before, c.unit, c.currency, c.scope)})`, `${who}: removed (was ${quotaText(t, c.before, c.unit, c.currency, c.scope)})`);
      return `${who}: ${quotaText(t, c.before, c.unit, c.currency, c.scope)} → ${quotaText(t, c.after, c.unit, c.currency, c.scope)}`;
    }
    case "model": {
      const m = (v: string | null) => v || t("Standard der Instanz", "instance default");
      if (!c.before) return t(`KI-Modell für ${c.name}: neu, ${m(c.after)}`, `AI model for ${c.name}: new, ${m(c.after)}`);
      if (!c.after) return t(`KI-Modell für ${c.name}: entfernt (war ${m(c.before)})`, `AI model for ${c.name}: removed (was ${m(c.before)})`);
      return t(`KI-Modell für ${c.name}: ${m(c.before)} → ${m(c.after)}`, `AI model for ${c.name}: ${m(c.before)} → ${m(c.after)}`);
    }
  }
}

// One error (or note) with its place in the file.
export function issueText(t: T, e: FileIssue): string {
  const where = e.path || t("Datei", "file");
  const list = e.allowed?.length ? e.allowed.join(", ") : t("keine", "none");
  switch (e.code) {
    case "invalid_json":
      return t(`${where}: kein gültiges JSON`, `${where}: not valid JSON`);
    case "too_large":
      return t("Die Datei ist zu groß (höchstens 512 KB).", "The file is too large (at most 512 KB).");
    case "unsupported":
      return t(`${where}: nur Version 1 wird unterstützt`, `${where}: only version 1 is supported`);
    case "required":
      return t(`${where}: fehlt`, `${where}: missing`);
    case "unknown_field":
      return t(`${where}: unbekanntes Feld`, `${where}: unknown field`);
    case "out_of_range":
      return t(`${where}: außerhalb des erlaubten Bereichs (höchstens ${num(e.max ?? 0)})`, `${where}: out of range (at most ${num(e.max ?? 0)})`);
    case "too_many":
      return t(`${where}: zu viele Einträge (höchstens ${num(e.max ?? 0)})`, `${where}: too many entries (at most ${num(e.max ?? 0)})`);
    case "duplicate":
      return t(`${where}: doppelt`, `${where}: duplicate`);
    case "invalid_url":
      return t(`${where}: bitte eine Adresse mit http:// oder https://`, `${where}: please an address with http:// or https://`);
    case "not_found":
      return t(`${where}: keine solche Gruppe in diesem Arbeitsbereich`, `${where}: no such group in that workspace`);
    case "ambiguous":
      return t(`${where}: mehrere Gruppen mit diesem Namen`, `${where}: several groups with this name`);
    case "no_provider":
      return t(`${where}: zuerst einen KI-Anbieter der Instanz einrichten (Einstellungen → Instanz → KI)`, `${where}: set up an AI provider for the instance first (Settings → Instance → AI)`);
    case "unknown_model":
      return t(`${where}: das Modell „${e.value}“ kennt die Instanz nicht – erlaubt: ${list}`, `${where}: the instance does not know the model “${e.value}” – allowed: ${list}`);
    case "no_family_model":
      return t(`${where}: kein Modell für „${e.value}“ bei der Instanz – erlaubt: ${list}`, `${where}: no model for “${e.value}” on this instance – allowed: ${list}`);
    case "no_prices":
      return t(`${where}: Kostengrenzen brauchen Preise je Modell (Einstellungen → Instanz → KI → Preise)`, `${where}: cost limits need prices per model (Settings → Instance → AI → Prices)`);
    case "unit_mismatch":
      return t(`${where}: passt nicht zur Einheit ${e.value} der KI-Kontingente – nimm ${list} oder setze „unit“`, `${where}: does not fit the AI quotas' unit ${e.value} – use ${list} or set “unit”`);
    case "currency_mismatch":
      return t(`${where}: die KI-Preise der Instanz sind in ${e.value} – nimm ${list}`, `${where}: the instance's AI prices are in ${e.value} – use ${list}`);
    case "tokens_need_unit":
      return t(
        `${where}: Tokens gelten nur, wenn die KI-Kontingente in Tokens zählen (jetzt: Kosten) – setze „flowplan.aiQuota.unit“ auf „tokens“ oder gib die Grenze als Kosten an (aiActions mit costPerAction)`,
        `${where}: tokens only apply when the AI quotas count in tokens (now: cost) – set “flowplan.aiQuota.unit” to “tokens” or give the limit as cost (aiActions with costPerAction)`,
      );
    case "tokens_win":
      return t(`${where}: ${e.value} ist ebenfalls angegeben und gilt – dieser Wert wird nicht verwendet`, `${where}: ${e.value} is given too and applies – this value is not used`);
    case "tokens_ignored":
      return t(`${where}: nicht verwendet – die KI-Kontingente zählen in Kosten, es gilt aiActions`, `${where}: not used – the AI quotas count in cost, aiActions applies`);
    case "capped":
      return t(`${where}: auf ${num(e.max ?? 0)} MB begrenzt (größte Datei, die dieser Server annimmt)`, `${where}: capped at ${num(e.max ?? 0)} MB (the largest file this server takes)`);
    default:
      return t(`${where}: ungültig`, `${where}: invalid`);
  }
}

export function LimitsFile() {
  const t = useT();
  const { mutate, onError, load } = useAdminData();
  const [text, setText] = useState("");
  const [checked, setChecked] = useState<{ text: string; result: LimitsImportResult } | null>(null);
  const [applied, setApplied] = useState<LimitsImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRun = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const exportFile = () =>
    busyRun(async () => {
      const file = await mutate({ action: "admin.limitsExport" });
      const json = JSON.stringify(file, null, 2);
      setText(json);
      setChecked(null);
      setApplied(null);
      const url = URL.createObjectURL(new Blob([json + "\n"], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `flowplan-limits-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  const check = () =>
    busyRun(async () => {
      setApplied(null);
      const result = (await mutate({ action: "admin.limitsImport", file: text, dryRun: true })) as LimitsImportResult;
      setChecked({ text, result });
    });
  const apply = () => {
    if (!checked || checked.text !== text || !checked.result.ok) return;
    const n = checked.result.changes.length;
    if (!window.confirm(t(`${n} Änderungen jetzt übernehmen? Alle oder keine werden gespeichert.`, `Apply ${n} changes now? All or none are saved.`))) return;
    void busyRun(async () => {
      const result = (await mutate({ action: "admin.limitsImport", file: text, dryRun: false })) as LimitsImportResult;
      setApplied(result);
      setChecked(null);
      await load();
    });
  };
  const current = checked && checked.text === text ? checked.result : null;
  return (
    <SettingGroup
      id="limits-file"
      title={t("Export / Import", "Export / import")}
      description={t(
        "Grenzen und KI-Einstellungen der Tarife als eine JSON-Datei – dasselbe Format wie der Tarif-Import des Abrechnungsdienstes. „Prüfen“ zeigt jede Änderung, ohne etwas zu speichern; „Übernehmen“ speichert alle auf einmal. Was nicht in der Datei steht, bleibt, wie es ist.",
        "The plans' limits and AI settings as one JSON file – the same format as the billing service's plan import. “Check” shows every change without saving anything; “Apply” saves all of them at once. What is not in the file stays as it is.",
      )}
    >
      <div className="setting-row wide limits-file">
        <div className="limits-file-actions">
          <button type="button" className="button" disabled={busy} onClick={() => void exportFile()}>
            <DownloadSimple size={16} aria-hidden />
            {t("Exportieren", "Export")}
          </button>
          <label className={`button file-label${busy ? " disabled" : ""}`}>
            <UploadSimple size={16} aria-hidden />
            {t("Datei öffnen", "Open file")}
            <input
              type="file"
              accept=".json,application/json"
              hidden
              aria-label={t("Datei mit Grenzen öffnen", "Open a file with limits")}
              disabled={busy}
              onChange={async (e) => {
                const file = e.currentTarget.files?.[0];
                e.currentTarget.value = "";
                if (!file) return;
                setText(await file.text());
                setChecked(null);
                setApplied(null);
              }}
            />
          </label>
        </div>
        <label className="limits-file-label">
          {t("Datei (JSON)", "File (JSON)")}
          <textarea
            className="limits-file-text"
            rows={12}
            spellCheck={false}
            autoComplete="off"
            value={text}
            placeholder={'{ "version": 1, "plans": [ … ], "flowplan": { … } }'}
            onChange={(e) => {
              setText(e.currentTarget.value);
              setApplied(null);
            }}
          />
        </label>
        <div className="limits-file-actions">
          <button type="button" className="button" disabled={busy || !text.trim()} onClick={() => void check()}>
            {t("Prüfen", "Check")}
          </button>
          <button type="button" className="button primary" disabled={busy || !current?.ok || !current.changes.length} onClick={apply}>
            {t("Übernehmen", "Apply")}
          </button>
        </div>
        {current && (
          <div className="limits-file-result" role="status" aria-label={t("Ergebnis der Prüfung", "Result of the check")}>
            {!current.ok ? (
              <>
                <p className="limits-file-head" data-tone="error">
                  {t(`Die Datei enthält ${current.errorCount} Fehler – nichts wird geändert:`, `The file has ${current.errorCount} error(s) – nothing will be changed:`)}
                </p>
                <ul className="limits-file-list">
                  {current.errors.map((e, i) => (
                    <li key={i}>{issueText(t, e)}</li>
                  ))}
                </ul>
              </>
            ) : current.changes.length ? (
              <>
                <p className="limits-file-head">{t(`${current.changes.length} Änderungen:`, `${current.changes.length} changes:`)}</p>
                <ul className="limits-file-list">
                  {current.changes.map((c, i) => (
                    <li key={i}>{changeText(t, c)}</li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="limits-file-head">{t("Keine Änderungen – alles ist schon so eingestellt.", "No changes – everything is already set this way.")}</p>
            )}
            {current.notes.length > 0 && (
              <ul className="limits-file-list limits-file-notes">
                {current.notes.map((e, i) => (
                  <li key={i}>{issueText(t, e)}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        {applied && (
          <p className="limits-file-head" role="status" data-tone="ok">
            {applied.applied ? t(`${applied.changes.length} Änderungen übernommen.`, `${applied.changes.length} changes applied.`) : t("Keine Änderungen.", "No changes.")}
          </p>
        )}
      </div>
    </SettingGroup>
  );
}
