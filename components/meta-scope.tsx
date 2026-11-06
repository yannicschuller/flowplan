"use client";
// Scopes of tags, page properties and templates (#136) in the browser: the
// small badge that tells "whole workspace" from "this space", the choice of
// a scope when something new is created, and the step that resolves what a
// move or a template from another space brings along (map, copy, remove –
// lib/meta-scope.ts).
import { useState } from "react";
import { FolderSimple, Globe } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { Modal } from "./ui";
import { Select } from "./select";
import { defaultChoice, planFrom, type ForeignMeta, type MetaChoice, type MetaPlan } from "@/lib/meta-scope";

type SpaceRef = { id: string; name: string };

// "Arbeitsbereich" or the space's name.
export function ScopeBadge({ spaceId, spaces, compact = false }: { spaceId?: string | null; spaces: SpaceRef[]; compact?: boolean }) {
  const t = useT();
  const space = spaceId ? spaces.find((s) => s.id === spaceId) : null;
  const label = spaceId ? (space?.name ?? t("Anderer Bereich", "Other space")) : t("Arbeitsbereich", "Workspace");
  const title = spaceId ? t(`Nur im Bereich „${label}“`, `Only in the space “${label}”`) : t("Im ganzen Arbeitsbereich", "In the whole workspace");
  return (
    <span className={`scope-badge${spaceId ? " scope-badge-space" : ""}${compact ? " compact" : ""}`} title={title}>
      {spaceId ? <FolderSimple size={11} aria-hidden /> : <Globe size={11} aria-hidden />}
      {compact ? <span className="sr-only">{title}</span> : label}
    </span>
  );
}

// "Nur in diesem Bereich" (the default) or "Im ganzen Arbeitsbereich".
export function ScopeChoice({
  value,
  spaceId,
  spaceName,
  workspaceAllowed,
  spaceAllowed = true,
  onChange,
}: {
  value: string | null;
  spaceId: string | null;
  spaceName?: string;
  workspaceAllowed: boolean;
  spaceAllowed?: boolean;
  onChange: (spaceId: string | null) => void;
}) {
  const t = useT();
  return (
    <fieldset className="scope-choice">
      <legend>{t("Gilt", "Applies")}</legend>
      {spaceId && (
        <label className="checkbox-label">
          <input type="radio" name="scope" checked={value === spaceId} disabled={!spaceAllowed} onChange={() => onChange(spaceId)} />
          {spaceName ? t(`Nur in diesem Bereich („${spaceName}“)`, `Only in this space (“${spaceName}”)`) : t("Nur in diesem Bereich", "Only in this space")}
        </label>
      )}
      <label className="checkbox-label">
        <input type="radio" name="scope" checked={value === null} disabled={!workspaceAllowed} onChange={() => onChange(null)} />
        {t("Im ganzen Arbeitsbereich", "In the whole workspace")}
        {!workspaceAllowed && <small className="muted"> {t("(nur Eigentümer)", "(owners only)")}</small>}
      </label>
    </fieldset>
  );
}

const choiceValue = (choice: MetaChoice) => (choice.action === "map" ? `map:${choice.to}` : choice.action);
const parseChoice = (value: string): MetaChoice => (value.startsWith("map:") ? { action: "map", to: value.slice(4) } : { action: value as "copy" | "remove" });

// One row per item a move or template brings: where it comes from, what
// carries it, and the choice – the same-named one there, another one, a
// copy, or removing it.
export function MetaResolution({
  items,
  target,
  choices,
  onChoose,
}: {
  items: ForeignMeta[];
  target: string;
  choices: Record<string, MetaChoice>;
  onChoose: (key: string, choice: MetaChoice) => void;
}) {
  const t = useT();
  return (
    <ul className="meta-resolution" aria-label={t("Tags und Eigenschaften", "Tags and properties")}>
      {items.map((item) => {
        const key = `${item.kind}:${item.id}`;
        const choice = choices[key] ?? defaultChoice(item);
        const uses = [
          item.pages ? (item.pages === 1 ? t("1 Seite", "1 page") : t(`${item.pages} Seiten`, `${item.pages} pages`)) : "",
          item.records ? (item.records === 1 ? t("1 Eintrag", "1 record") : t(`${item.records} Einträge`, `${item.records} records`)) : "",
        ].filter(Boolean);
        return (
          <li key={key} className="meta-resolution-item">
            <div className="meta-resolution-name">
              {item.kind === "tag" ? (
                <span className={`page-tag page-tag-${item.color ?? "gray"}`}>
                  <span className="page-tag-name">{item.name}</span>
                </span>
              ) : (
                <strong>{item.name}</strong>
              )}
              <small className="muted">
                {item.kind === "tag" ? t("Tag", "Tag") : t("Eigenschaft", "Property")}
                {item.spaceName ? ` · ${t(`aus „${item.spaceName}“`, `from “${item.spaceName}”`)}` : ""}
                {uses.length ? ` · ${uses.join(", ")}` : ""}
              </small>
            </div>
            <Select
              aria-label={t(`Was mit „${item.name}“ geschieht`, `What happens to “${item.name}”`)}
              value={choiceValue(choice)}
              onChange={(e) => onChoose(key, parseChoice(e.target.value))}
            >
              {item.candidates.length > 0 && (
                <optgroup label={t(`Zuordnen (in „${target}“)`, `Map (in “${target}”)`)}>
                  {item.candidates.map((c) => (
                    <option key={c.id} value={`map:${c.id}`}>
                      {c.id === item.sameName ? t(`${c.name} (gleicher Name)`, `${c.name} (same name)`) : c.name}
                      {c.spaceId ? "" : t(" · Arbeitsbereich", " · workspace")}
                    </option>
                  ))}
                </optgroup>
              )}
              <option value="copy">{t(`Nach „${target}“ kopieren`, `Copy to “${target}”`)}</option>
              <option value="remove">{t("Entfernen (Werte gehen verloren)", "Remove (values are lost)")}</option>
            </Select>
          </li>
        );
      })}
    </ul>
  );
}

// The step as a dialog of its own (drag and drop in the sidebar, templates).
export function MetaResolveDialog({
  open,
  title,
  intro,
  items,
  target,
  confirm,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  intro: string;
  items: ForeignMeta[];
  target: string;
  confirm: string;
  onConfirm: (plan: MetaPlan) => Promise<unknown> | unknown;
  onClose: () => void;
}) {
  const t = useT();
  const [choices, setChoices] = useState<Record<string, MetaChoice>>({});
  const [busy, setBusy] = useState(false);
  return (
    <Modal open={open} sheet onClose={() => !busy && onClose()} title={title}>
      <div className="meta-resolve-dialog">
        <p className="muted">{intro}</p>
        <MetaResolution items={items} target={target} choices={choices} onChoose={(key, choice) => setChoices((all) => ({ ...all, [key]: choice }))} />
        <div className="modal-actions">
          <button type="button" className="button" disabled={busy} onClick={onClose}>
            {t("Abbrechen", "Cancel")}
          </button>
          <button
            type="button"
            className="button primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm(planFrom(items, choices));
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirm}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export const moveIntro = (t: (de: string, en: string) => string, target: string) =>
  t(
    `Diese Seiten verwenden Tags und Eigenschaften, die nur in ihrem bisherigen Bereich gelten. Wähle, was in „${target}“ daraus wird – nichts geht ohne deine Wahl verloren.`,
    `These pages use tags and properties that only apply in their current space. Choose what they become in “${target}” – nothing is lost without your choice.`,
  );
