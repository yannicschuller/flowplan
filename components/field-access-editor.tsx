"use client";
import { Lock } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { Select } from "./select";
import type { AccessRule, FieldAccess } from "@/lib/field-access-rules";
import { describeRule, restrictedAccess } from "@/lib/field-access-rules";
import type { Field } from "@/lib/types";

type Group = { id: string; name: string };
type Choice = "all" | "editors" | "owners" | "groups";
const choiceOf = (rule: AccessRule | undefined, fallback: Choice): Choice =>
  !rule ? fallback : typeof rule === "object" ? "groups" : rule;

// "Visibility" in the property settings: who reads and who changes a
// property (lib/field-access.ts). Only database owners change it.
export function FieldAccessEditor({
  draft,
  groups,
  owner,
  isTitle,
  disabled,
  onChange,
}: {
  draft: Field;
  groups: Group[];
  owner: boolean;
  isTitle: boolean;
  disabled: boolean;
  onChange: (access: FieldAccess | undefined) => void;
}) {
  const t = useT();
  const access = draft.access || {};
  const set = (kind: "read" | "write", rule: AccessRule | undefined) => {
    const next: FieldAccess = { ...access, [kind]: rule };
    if (!next.read || next.read === "all") delete next.read;
    if (!next.write || next.write === "editors" || next.write === "all") delete next.write;
    onChange(next.read || next.write ? next : undefined);
  };
  const row = (kind: "read" | "write") => {
    const rule = access[kind];
    const fallback: Choice = kind === "read" ? "all" : "editors";
    const choice = choiceOf(rule, fallback);
    const selected = typeof rule === "object" ? rule.groups : [];
    const locked = disabled || !owner || (kind === "read" && isTitle);
    return (
      <div className="field-access-row">
        <label>
          {kind === "read" ? t("Sehen", "Read") : t("Bearbeiten", "Edit")}
          <Select
            aria-label={kind === "read" ? t("Wer sieht diese Eigenschaft?", "Who can see this property?") : t("Wer bearbeitet diese Eigenschaft?", "Who can edit this property?")}
            value={choice}
            disabled={locked}
            onChange={(e) => {
              const value = e.target.value as Choice;
              set(kind, value === "groups" ? { groups: selected.length ? selected : groups[0] ? [groups[0].id] : [] } : value);
            }}
          >
            {kind === "read" && <option value="all">{t("Alle mit Zugriff", "Everyone with access")}</option>}
            <option value="editors">{t("Bearbeiter und Besitzer", "Editors and owners")}</option>
            <option value="owners">{t("Nur Besitzer", "Owners only")}</option>
            <option value="groups" disabled={!groups.length}>
              {t("Ausgewählte Gruppen", "Selected groups")}
            </option>
          </Select>
        </label>
        {choice === "groups" && (
          <div className="field-access-groups" role="group" aria-label={t("Gruppen", "Groups")}>
            {groups.map((g) => (
              <label key={g.id} className="checkbox-label">
                <input
                  type="checkbox"
                  disabled={locked}
                  checked={selected.includes(g.id)}
                  onChange={(e) => {
                    const next = e.target.checked ? [...selected, g.id] : selected.filter((id) => id !== g.id);
                    set(kind, next.length ? { groups: next } : "owners");
                  }}
                />
                {g.name}
              </label>
            ))}
          </div>
        )}
      </div>
    );
  };
  return (
    <fieldset className="field-access">
      <legend>
        <Lock size={14} aria-hidden /> {t("Sichtbarkeit", "Visibility")}
      </legend>
      {row("read")}
      {row("write")}
      <small className="muted">
        {isTitle
          ? t("Die Titeleigenschaft sehen alle mit Zugriff auf die Datenbank.", "Everyone with access to the database sees the title property.")
          : !owner
            ? t("Nur Besitzer der Datenbank ändern die Sichtbarkeit.", "Only owners of the database change the visibility.")
            : t(
                "Besitzer sehen und bearbeiten immer alles. Was jemand nicht sehen darf, fehlt für ihn auch in Suche, Exporten, KI und Formeln; öffentliche Links und Formulare zeigen solche Eigenschaften nie.",
                "Owners always see and edit everything. What someone may not see is also missing for them in search, exports, AI and formulas; public links and forms never show such properties.",
              )}
      </small>
      {restrictedAccess(draft.access) && (
        <small className="muted">
          {describeRule(draft.access?.read, "read", groups, t)} · {describeRule(draft.access?.write, "write", groups, t)}
        </small>
      )}
    </fieldset>
  );
}
// The lock next to a restricted property's name.
export function FieldLock({ field, groups }: { field: Field; groups: Group[] }) {
  const t = useT();
  if (!restrictedAccess(field.access)) return null;
  const label = `${describeRule(field.access?.read, "read", groups, t)} · ${describeRule(field.access?.write, "write", groups, t)}`;
  return (
    <span className="field-lock" title={label} aria-label={label} role="img">
      <Lock size={12} weight="bold" />
    </span>
  );
}
