"use client";
// Settings → Arbeitsbereich → Automatische Links (#202, lib/auto-link.ts):
// rules that turn text like "ABC-123" into a link while someone types or
// pastes it in a page, a record's document or a comment. Owners change
// them, members see them; a tester shows what a sample text becomes.
import { useMemo, useState } from "react";
import { LinkSimple, Plus, Trash } from "@phosphor-icons/react";
import { useT } from "../../i18n";
import { EmptyState, SaveBar, SettingGroup, Switch } from "../../settings-ui";
import { useUserSettings } from "../user-context";
import { AUTO_LINK_LIMITS, compileRules, findAutoLinks, ruleProblems, type AutoLinkProblem, type AutoLinkRule } from "@/lib/auto-link";

type Say = (de: string, en: string) => string;
function problemText(problem: AutoLinkProblem, t: Say) {
  switch (problem) {
    case "pattern-empty":
      return t("Das Muster fehlt.", "The pattern is missing.");
    case "pattern-long":
      return t("Das Muster ist länger als 200 Zeichen.", "The pattern is longer than 200 characters.");
    case "pattern-invalid":
      return t("Das Muster ist kein gültiger regulärer Ausdruck.", "The pattern is not a valid regular expression.");
    case "pattern-empty-match":
      return t("Das Muster darf nicht auf leeren Text passen.", "The pattern must not match empty text.");
    case "pattern-nested":
      return t("Das Muster wiederholt eine Gruppe, die selbst schon wiederholt (zu langsam).", "The pattern repeats a group that repeats itself (too slow).");
    case "template-empty":
      return t("Die Link-Vorlage fehlt.", "The link template is missing.");
    case "template-long":
      return t("Die Link-Vorlage ist länger als 500 Zeichen.", "The link template is longer than 500 characters.");
    case "template-scheme":
      return t("Die Link-Vorlage muss mit https://, http:// oder mailto: beginnen.", "The link template must start with https://, http:// or mailto:.");
    case "template-unsafe":
      return t("Die Link-Vorlage ergibt keine gültige Adresse.", "The link template does not give a valid address.");
    case "name-long":
      return t("Der Name ist länger als 60 Zeichen.", "The name is longer than 60 characters.");
  }
}

const newRule = (): AutoLinkRule => ({ id: crypto.randomUUID(), name: "", pattern: "", template: "https://", enabled: true });
const same = (a: AutoLinkRule[], b: AutoLinkRule[]) => JSON.stringify(a) === JSON.stringify(b);

export default function LinkRulesSection() {
  const t = useT();
  const { boot, owner, mutate, onError } = useUserSettings();
  const saved = boot.linkRules ?? [];
  const [draft, setDraft] = useState<AutoLinkRule[]>(saved);
  const [base, setBase] = useState<AutoLinkRule[]>(saved);
  const [busy, setBusy] = useState(false);
  const [sample, setSample] = useState("");
  const dirty = !same(draft, base);
  const problems = useMemo(() => draft.map((r) => ruleProblems(r)), [draft]);
  const valid = problems.every((p) => !p.length);
  const update = (index: number, change: Partial<AutoLinkRule>) => setDraft((list) => list.map((r, i) => (i === index ? { ...r, ...change } : r)));
  const save = async () => {
    setBusy(true);
    try {
      const result = (await mutate({ action: "workspace.linkRules", workspaceId: boot.workspace.id, rules: draft })) as { rules: AutoLinkRule[] };
      setDraft(result.rules);
      setBase(result.rules);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  // The tester uses the rules as they are being edited (enabled and valid).
  const compiled = useMemo(() => compileRules(draft), [draft]);
  const matches = useMemo(() => findAutoLinks(sample.slice(0, 4000), compiled), [sample, compiled]);
  const preview = useMemo(() => {
    const parts: (string | { text: string; href: string })[] = [];
    let at = 0;
    for (const m of matches) {
      if (m.from > at) parts.push(sample.slice(at, m.from));
      parts.push({ text: m.text, href: m.href });
      at = m.to;
    }
    if (at < sample.length) parts.push(sample.slice(at, 4000));
    return parts;
  }, [matches, sample]);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!owner || !dirty) return;
        if (valid) void save();
        else onError(t("Bitte zuerst die markierten Regeln korrigieren.", "Please fix the marked rules first."));
      }}
    >
      <SettingGroup
        id="link-rules"
        title={t("Automatische Links", "Automatic links")}
        description={
          owner
            ? t(
                "Text, der zu einem Muster passt, wird beim Tippen und Einfügen zum Link – in Seiten, Dokumenten von Datenbankeinträgen und Kommentaren, für alle im Arbeitsbereich. Vorhandener Text bleibt unverändert; Rückgängig direkt danach entfernt nur den Link.",
                "Text that matches a pattern becomes a link while typing and pasting – in pages, documents of database records and comments, for everyone in the workspace. Existing text stays unchanged; undo right after removes only the link.",
              )
            : t("Nur Eigentümer ändern die Regeln.", "Only owners change the rules.")
        }
        actions={
          owner && (
            <button type="button" className="button compact" disabled={draft.length >= AUTO_LINK_LIMITS.rules} onClick={() => setDraft((list) => [...list, newRule()])}>
              <Plus aria-hidden /> {t("Regel hinzufügen", "Add rule")}
            </button>
          )
        }
      >
        {!draft.length && (
          <div className="setting-row wide">
            <EmptyState icon={<LinkSimple size={20} />} title={t("Noch keine Regeln", "No rules yet")}>
              {t("Zum Beispiel macht das Muster ABC-\\d+ mit der Vorlage https://jira.example.com/browse/{match} aus ABC-123 einen Link.", "For example, the pattern ABC-\\d+ with the template https://jira.example.com/browse/{match} turns ABC-123 into a link.")}
            </EmptyState>
          </div>
        )}
        {draft.map((rule, index) => (
          <fieldset key={rule.id} className="link-rule" disabled={!owner}>
            <legend className="sr-only">{rule.name || t(`Regel ${index + 1}`, `Rule ${index + 1}`)}</legend>
            <div className="link-rule-head">
              <input
                aria-label={t("Name (optional)", "Name (optional)")}
                placeholder={t("Name (optional)", "Name (optional)")}
                maxLength={AUTO_LINK_LIMITS.name}
                value={rule.name}
                onChange={(e) => update(index, { name: e.target.value })}
              />
              <Switch checked={rule.enabled} label={t("Aktiv", "Enabled")} disabled={!owner} onChange={(enabled) => update(index, { enabled })} />
              {owner && (
                <button type="button" className="icon-button" title={t("Regel löschen", "Delete rule")} aria-label={t("Regel löschen", "Delete rule")} onClick={() => setDraft((list) => list.filter((_, i) => i !== index))}>
                  <Trash aria-hidden />
                </button>
              )}
            </div>
            <label className="link-rule-field">
              <span>{t("Muster (regulärer Ausdruck)", "Pattern (regular expression)")}</span>
              <input className="mono" spellCheck={false} autoCapitalize="off" autoCorrect="off" maxLength={AUTO_LINK_LIMITS.pattern} placeholder="\bABC-\d+\b" value={rule.pattern} onChange={(e) => update(index, { pattern: e.target.value })} />
            </label>
            <label className="link-rule-field">
              <span>{t("Link-Vorlage", "Link template")}</span>
              <input
                className="mono"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                inputMode="url"
                maxLength={AUTO_LINK_LIMITS.template}
                placeholder="https://jira.example.com/browse/{match}"
                value={rule.template}
                onChange={(e) => update(index, { template: e.target.value })}
              />
            </label>
            {owner && problems[index].length > 0 && (rule.pattern || rule.template !== "https://") && (
              <ul className="link-rule-problems" role="status">
                {problems[index].map((p) => (
                  <li key={p}>{problemText(p, t)}</li>
                ))}
              </ul>
            )}
          </fieldset>
        ))}
        <p className="link-rule-help">
          {t(
            "In der Vorlage steht {match} für den ganzen Treffer, $1 bis $9 (oder {1} bis {9}) für die Gruppen in Klammern. Die Werte werden URL-kodiert eingesetzt. Nicht in Code, vorhandenen Links, Formeln und Titeln.",
            "In the template, {match} is the whole match, $1 to $9 (or {1} to {9}) are the groups in parentheses. The values are inserted URL-encoded. Not in code, existing links, formulas and titles.",
          )}
        </p>
      </SettingGroup>
      <SettingGroup id="link-rules-test" title={t("Ausprobieren", "Try it")} description={t("Beispieltext eingeben; Treffer der aktiven Regeln erscheinen als Links.", "Enter a sample text; matches of the enabled rules show as links.")}>
        <div className="setting-row wide">
          <div className="setting-control link-rule-tester">
            <textarea
              rows={3}
              aria-label={t("Beispieltext", "Sample text")}
              placeholder={t("Siehe ABC-123 und #42", "See ABC-123 and #42")}
              value={sample}
              onChange={(e) => setSample(e.target.value)}
            />
            {sample && (
              <div className="link-rule-preview" aria-live="polite">
                <p>
                  {preview.map((part, i) =>
                    typeof part === "string" ? (
                      <span key={i}>{part}</span>
                    ) : (
                      <a key={i} href={part.href} target="_blank" rel="noopener noreferrer">
                        {part.text}
                      </a>
                    ),
                  )}
                </p>
                {matches.length ? (
                  <ul>
                    {matches.map((m, i) => (
                      <li key={i}>
                        <code>{m.text}</code> → <code>{m.href}</code>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">{t("Kein Treffer.", "No match.")}</p>
                )}
              </div>
            )}
          </div>
        </div>
      </SettingGroup>
      {owner && (
        <SaveBar
          dirty={dirty}
          busy={busy}
          onDiscard={() => setDraft(base)}
          saveLabel={t("Speichern", "Save")}
          discardLabel={t("Verwerfen", "Discard")}
          message={t("Ungespeicherte Änderungen an den Regeln", "Unsaved changes to the rules")}
        />
      )}
    </form>
  );
}
