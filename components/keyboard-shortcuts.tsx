"use client";
// The keyboard shortcuts of the app as one overlay: opened with "?" (outside
// of inputs), ⌘/Ctrl + /, the command "Tastenkürzel", the "?" in the
// sidebar tools and the link in Settings → Konto. The global shortcuts can
// be changed here ("Ändern" records a new combination); they are stored per
// person (command shortcuts.save) and applied by lib/keymap.ts. Shortcuts of
// the page tree, the editor, presentations and the split view are fixed and
// listed for reference.
import { useEffect, useRef, useState } from "react";
import { ArrowCounterClockwise, PencilSimple, Warning, X } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { Modal, reportError } from "./ui";
import {
  actionsUsing,
  cleanOverrides,
  comboFromEvent,
  conflictsOf,
  DEFAULT_KEYMAP,
  formatCombo,
  isMacPlatform,
  platformCombo,
  resolveKeymap,
  SHORTCUT_ACTIONS,
  type Conflict,
  type KeymapOverrides,
  type ShortcutAction,
} from "@/lib/keymap";

type T = (de: string, en: string) => string;

export function actionLabel(action: ShortcutAction, t: T): string {
  switch (action) {
    case "search":
      return t("Suchen und Befehle", "Search and commands");
    case "find":
      return t("Auf der Seite suchen", "Find on page");
    case "newPage":
      return t("Neue Seite", "New page");
    case "capture":
      return t("Schnell erfassen", "Quick capture");
    case "shortcuts":
      return t("Diese Übersicht", "This overview");
    case "readMode":
      return t("Lesen oder bearbeiten umschalten", "Switch between reading and editing");
    case "sidebar":
      return t("Seitenleiste ein- oder ausblenden", "Show or hide the sidebar");
    case "focusMode":
      return t("Fokusmodus ein oder aus", "Focus mode on or off");
    case "comments":
      return t("Kommentare ein- oder ausblenden", "Show or hide comments");
    case "ask":
      return t("KI fragen öffnen oder schließen", "Open or close Ask AI");
    case "theme":
      return t("Helles oder dunkles Design", "Light or dark theme");
    case "splitView":
      return t("Geteilte Ansicht öffnen oder schließen", "Open or close the split view");
    case "present":
      return t("Dokument präsentieren", "Present the document");
    case "journalToday":
      return t("Journal: heutigen Tag öffnen", "Journal: open today");
  }
}

// i18n-table: 1 – [German, English] pairs
const editorLabels: Record<string, [string, string]> = {
  underline: ["Unterstreichen", "Underline"],
  strike: ["Durchstreichen", "Strikethrough"],
  code: ["Code im Text", "Inline code"],
  highlight: ["Markieren", "Highlight"],
  spoiler: ["Verdecken", "Spoiler"],
  heading: ["Überschrift", "Heading"],
  orderedList: ["Nummerierte Liste", "Numbered list"],
  bulletList: ["Aufzählung", "Bulleted list"],
  taskList: ["Aufgabenliste", "Task list"],
  blockquote: ["Zitat", "Quote"],
  codeBlock: ["Codeblock", "Code block"],
  undo: ["Rückgängig", "Undo"],
  redo: ["Wiederholen", "Redo"],
  superscript: ["Hochgestellt", "Superscript"],
  subscript: ["Tiefgestellt", "Subscript"],
  moveBlock: ["Block verschieben", "Move the block"],
  paragraph: ["Text", "Text"],
  footnote: ["Fußnote", "Footnote"],
  comment: ["Textkommentar", "Text comment"],
  bold: ["Fett", "Bold"],
  italic: ["Kursiv", "Italic"],
  center: ["Text zentrieren", "Centre the text"],
  ai: ["KI-Schreibassistent", "AI writing assistant"],
};
function conflictText(conflict: Conflict, t: T) {
  if (conflict.kind === "action")
    return t(`Auch belegt durch „${actionLabel(conflict.with, t)}“.`, `Also used by “${actionLabel(conflict.with, t)}”.`);
  if (conflict.kind === "editor") {
    const label = editorLabels[conflict.with];
    const name = label ? t(label[0], label[1]) : "";
    return name
      ? t(`Im Editor schon belegt („${name}“) – dort gilt beides.`, `Already used in the editor (“${name}”) – both apply there.`)
      : t("Im Editor schon belegt – dort gilt beides.", "Already used in the editor – both apply there.");
  }
  return t("Der Browser behält diese Kombination meist für sich.", "The browser usually keeps this combination for itself.");
}

export type ShortcutGroup = { title: string; items: { label: string; keys: string[] }[] };

// The fixed shortcuts (not changeable), for this overview.
export function fixedShortcutGroups(t: T, ai: boolean, mac: boolean): ShortcutGroup[] {
  const k = (combo: string) => formatCombo(combo, mac);
  return [
    {
      title: t("Seitenbaum", "Page tree"),
      items: [
        { label: t("Zwischen Seiten bewegen", "Move between pages"), keys: ["↑", "↓"] },
        { label: t("Unterseiten öffnen oder schließen", "Expand or collapse sub-pages"), keys: ["→", "←"] },
        { label: t("Seite öffnen", "Open the page"), keys: ["↵"] },
        { label: t("In geteilter Ansicht öffnen", "Open in split view"), keys: [mac ? t("⌘ + Klick", "⌘ + click") : t("Ctrl + Klick", "Ctrl + click")] },
        { label: t("Seiten auswählen", "Select pages"), keys: [mac ? t("⇧ + Klick", "⇧ + click") : t("Shift + Klick", "Shift + click")] },
      ],
    },
    {
      title: t("Editor", "Editor"),
      items: [
        { label: t("Blöcke und Befehle", "Blocks and commands"), keys: ["/"] },
        { label: t("Personen, Seiten und Daten erwähnen", "Mention people, pages and dates"), keys: ["@"] },
        { label: t("Fett / Kursiv / Unterstrichen", "Bold / italic / underline"), keys: [k("Mod+B"), k("Mod+I"), k("Mod+U")] },
        { label: t("Durchstreichen", "Strikethrough"), keys: [k("Mod+Shift+S")] },
        { label: t("Markieren", "Highlight"), keys: [k("Mod+Shift+H")] },
        { label: t("Verdecken (Spoiler)", "Hide (spoiler)"), keys: [k("Mod+Alt+H")] },
        { label: t("Überschrift 1–3", "Heading 1–3"), keys: [k("Mod+Alt+1"), k("Mod+Alt+2"), k("Mod+Alt+3")] },
        { label: t("Text zentrieren", "Centre the text"), keys: [k("Mod+Shift+E")] },
        { label: t("Fußnote", "Footnote"), keys: [k("Mod+Alt+F")] },
        { label: t("Textkommentar", "Text comment"), keys: [k("Mod+Alt+M")] },
        { label: t("Block verschieben", "Move the block"), keys: [k("Mod+Shift+ArrowUp"), k("Mod+Shift+ArrowDown")] },
        { label: t("Rückgängig / Wiederholen", "Undo / redo"), keys: [k("Mod+Z"), k("Mod+Shift+Z")] },
        { label: t("Seitenlink in geteilter Ansicht öffnen", "Open a page link in split view"), keys: [mac ? t("⌘ + Klick", "⌘ + click") : t("Ctrl + Klick", "Ctrl + click")] },
        ...(ai ? [{ label: t("KI-Schreibassistent", "AI writing assistant"), keys: [k("Mod+J")] }] : []),
      ],
    },
    {
      title: t("Präsentation", "Presentation"),
      items: [
        { label: t("Nächste Folie", "Next slide"), keys: ["→", t("Leertaste", "Space"), "Page Down"] },
        { label: t("Vorherige Folie", "Previous slide"), keys: ["←", "Page Up"] },
        { label: t("Erste / letzte Folie", "First / last slide"), keys: ["Home", "End"] },
        { label: t("Präsentation beenden", "End the presentation"), keys: ["Esc"] },
      ],
    },
    {
      title: t("Geteilte Ansicht", "Split view"),
      items: [
        { label: t("Trennlinie verschieben (fokussiert)", "Move the divider (focused)"), keys: ["←", "→"] },
        { label: t("In großen Schritten", "In large steps"), keys: [k("Shift+ArrowLeft"), k("Shift+ArrowRight")] },
        { label: t("Halbe-halbe", "Half and half"), keys: ["↵"] },
      ],
    },
    {
      title: t("Überall", "Everywhere"),
      items: [{ label: t("Dialog oder Menü schließen", "Close a dialog or menu"), keys: ["Esc"] }],
    },
  ];
}

function Keys({ keys }: { keys: string[] }) {
  const t = useT();
  if (!keys.length) return <span className="muted small">{t("keins", "none")}</span>;
  return (
    <>
      {keys.map((key, i) => (
        <span key={`${key}-${i}`}>
          {i > 0 && <span className="shortcut-or">{t("oder", "or")}</span>}
          <kbd>{key}</kbd>
        </span>
      ))}
    </>
  );
}

export function KeyboardShortcuts({
  open,
  onClose,
  ai,
  overrides = {},
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  ai: boolean;
  // The own shortcuts; without onSave the list is read-only.
  overrides?: KeymapOverrides;
  onSave?: (overrides: KeymapOverrides) => Promise<void>;
}) {
  const t = useT();
  const [mac, setMac] = useState(false),
    // The action whose new combination is being recorded.
    [recording, setRecording] = useState<ShortcutAction | null>(null),
    // A recorded combination that another action already uses.
    [pending, setPending] = useState<{ action: ShortcutAction; combo: string; others: ShortcutAction[] } | null>(null),
    [saving, setSaving] = useState(false),
    [announce, setAnnounce] = useState("");
  const recordRef = useRef(recording);
  recordRef.current = recording;
  useEffect(() => setMac(isMacPlatform()), []);
  useEffect(() => {
    if (!open) {
      setRecording(null);
      setPending(null);
    }
  }, [open]);
  const map = resolveKeymap(overrides);
  const save = async (next: KeymapOverrides, message: string) => {
    if (!onSave) return;
    setSaving(true);
    try {
      await onSave(cleanOverrides(next));
      setAnnounce(message);
    } catch (e) {
      reportError(e);
    } finally {
      setSaving(false);
    }
  };
  const assign = (action: ShortcutAction, combo: string, takeFrom: ShortcutAction[] = []) => {
    const next: KeymapOverrides = { ...overrides, [action]: [combo] };
    for (const other of takeFrom) next[other] = map[other].filter((c) => platformCombo(c, mac) !== platformCombo(combo, mac));
    void save(next, t(`${actionLabel(action, t)}: ${formatCombo(combo, mac)}`, `${actionLabel(action, t)}: ${formatCombo(combo, mac)}`));
  };
  // Recording: the next combination pressed (Escape cancels). Runs before
  // the dialog and the app's own shortcuts.
  useEffect(() => {
    if (!recording) return;
    const key = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        setRecording(null);
        setAnnounce(t("Aufnahme abgebrochen.", "Recording cancelled."));
        return;
      }
      const combo = comboFromEvent(e, mac);
      // Only modifiers so far: wait for the key.
      if (!combo) return;
      const action = recordRef.current;
      if (!action) return;
      setRecording(null);
      const others = actionsUsing(map, combo, mac, action);
      if (others.length) setPending({ action, combo, others });
      else assign(action, combo);
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, mac, overrides]);
  const editable = !!onSave;
  const changed = SHORTCUT_ACTIONS.some((a) => overrides[a] !== undefined);
  return (
    <Modal open={open} onClose={onClose} title={t("Tastenkürzel", "Keyboard shortcuts")} className="shortcuts-dialog" wide>
      <div className="shortcut-groups">
        <section className="shortcut-group shortcut-group-editable" aria-label={t("Überall", "Everywhere")}>
          <h3>{t("Überall", "Everywhere")}</h3>
          {editable && (
            <p className="muted small shortcut-intro">
              {t("Mit „Ändern“ legst du eine eigene Kombination fest – sie gilt für dein Konto auf allen Geräten.", "With “Change” you set a combination of your own – it applies to your account on all devices.")}
            </p>
          )}
          <dl>
            {SHORTCUT_ACTIONS.map((action) => {
              const conflicts = conflictsOf(map, action, mac);
              const own = overrides[action] !== undefined;
              const isRecording = recording === action;
              return (
                <div key={action} className={`shortcut-row${isRecording ? " recording" : ""}${own ? " custom" : ""}`} data-action={action}>
                  <dt>
                    {actionLabel(action, t)}
                    {own && <span className="shortcut-custom">{t("eigene", "custom")}</span>}
                  </dt>
                  <dd>
                    {isRecording ? (
                      <span className="shortcut-recording" role="status">
                        {t("Drücke die neue Kombination … (Esc bricht ab)", "Press the new combination … (Esc cancels)")}
                      </span>
                    ) : (
                      <Keys keys={map[action].map((c) => formatCombo(c, mac))} />
                    )}
                    {editable && (
                      <span className="shortcut-actions">
                        <button
                          type="button"
                          className="text-button"
                          disabled={saving}
                          aria-label={t(`${actionLabel(action, t)}: Kombination ändern`, `${actionLabel(action, t)}: change the combination`)}
                          onClick={() => {
                            setPending(null);
                            setRecording(isRecording ? null : action);
                          }}
                        >
                          <PencilSimple size={13} />
                          {isRecording ? t("Abbrechen", "Cancel") : t("Ändern", "Change")}
                        </button>
                        {own && (
                          <button
                            type="button"
                            className="icon-button"
                            disabled={saving}
                            aria-label={t(`${actionLabel(action, t)}: zurücksetzen`, `${actionLabel(action, t)}: reset`)}
                            title={t(
                              `Zurück zu ${DEFAULT_KEYMAP[action].map((c) => formatCombo(c, mac)).join(" / ") || "keiner Kombination"}`,
                              `Back to ${DEFAULT_KEYMAP[action].map((c) => formatCombo(c, mac)).join(" / ") || "no combination"}`,
                            )}
                            onClick={() => {
                              const next = { ...overrides };
                              delete next[action];
                              void save(next, t(`${actionLabel(action, t)} zurückgesetzt.`, `${actionLabel(action, t)} reset.`));
                            }}
                          >
                            <ArrowCounterClockwise size={15} />
                          </button>
                        )}
                        {map[action].length > 0 && (
                          <button
                            type="button"
                            className="icon-button"
                            disabled={saving}
                            title={t("Kombination entfernen", "Remove the combination")}
                            aria-label={t(`${actionLabel(action, t)}: Kombination entfernen`, `${actionLabel(action, t)}: remove the combination`)}
                            onClick={() => void save({ ...overrides, [action]: [] }, t(`${actionLabel(action, t)}: keine Kombination.`, `${actionLabel(action, t)}: no combination.`))}
                          >
                            <X size={15} />
                          </button>
                        )}
                      </span>
                    )}
                  </dd>
                  {(pending?.action === action || (conflicts.length > 0 && !isRecording)) && (
                    <dd className="shortcut-notes">
                    {pending?.action === action && (
                      <span className="shortcut-conflict-prompt" role="alert">
                        <Warning size={14} aria-hidden="true" />
                        {t(
                          `${formatCombo(pending.combo, mac)} gehört schon zu „${pending.others.map((o) => actionLabel(o, t)).join("“, „")}“.`,
                          `${formatCombo(pending.combo, mac)} already belongs to “${pending.others.map((o) => actionLabel(o, t)).join("”, “")}”.`,
                        )}
                        <button
                          type="button"
                          className="button compact primary"
                          onClick={() => {
                            assign(action, pending.combo, pending.others);
                            setPending(null);
                          }}
                        >
                          {t("Trotzdem verwenden", "Use it anyway")}
                        </button>
                        <button type="button" className="button compact" onClick={() => setPending(null)}>
                          {t("Abbrechen", "Cancel")}
                        </button>
                      </span>
                    )}
                    {conflicts.length > 0 && !isRecording && (
                      <span className="shortcut-conflicts">
                        {conflicts.map((c, i) => (
                          <span key={i} className="shortcut-conflict">
                            <Warning size={13} aria-hidden="true" />
                            {formatCombo(c.combo, mac)}: {conflictText(c, t)}
                          </span>
                        ))}
                      </span>
                    )}
                    </dd>
                  )}
                </div>
              );
            })}
          </dl>
          {editable && changed && (
            <button
              type="button"
              className="button compact shortcut-reset-all"
              disabled={saving}
              onClick={() => void save({}, t("Alle Tastenkürzel zurückgesetzt.", "All keyboard shortcuts reset."))}
            >
              <ArrowCounterClockwise size={14} />
              {t("Alle zurücksetzen", "Reset all")}
            </button>
          )}
        </section>
        {fixedShortcutGroups(t, ai, mac).map((group) => (
          <section key={group.title} className="shortcut-group" aria-label={group.title}>
            <h3>
              {group.title} <span className="shortcut-fixed">{t("fest", "fixed")}</span>
            </h3>
            <dl>
              {group.items.map((item) => (
                <div key={item.label} className="shortcut-row">
                  <dt>{item.label}</dt>
                  <dd>
                    <Keys keys={item.keys} />
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {announce}
      </p>
      <p className="muted small shortcut-hint">
        {mac
          ? t("Angezeigt für Apple-Tastaturen: ⌘ Befehl, ⌥ Wahl, ⇧ Umschalt, ⌃ Control.", "Shown for Apple keyboards: ⌘ Command, ⌥ Option, ⇧ Shift, ⌃ Control.")
          : t("Auf dem Mac gilt ⌘ statt Ctrl (Strg) und ⌥ statt Alt.", "On a Mac ⌘ applies instead of Ctrl and ⌥ instead of Alt.")}
      </p>
    </Modal>
  );
}
