"use client";
// The keyboard shortcuts of the app as one overlay: opened with "?" (outside
// of inputs), ⌘/Ctrl + /, the command "Tastenkürzel", the "?" in the
// sidebar tools and the link in Settings → Konto. Settings and the
// onboarding reuse the same list.
import { useT } from "./i18n";
import { Modal } from "./ui";

export type ShortcutGroup = { title: string; items: { label: string; keys: string[] }[] };

// `ai`: the AI writing assistant is available (⌘ J).
export function shortcutGroups(t: (de: string, en: string) => string, ai: boolean): ShortcutGroup[] {
  const mod = "⌘ / Ctrl";
  return [
    {
      title: t("Überall", "Everywhere"),
      items: [
        { label: t("Suchen und Befehle", "Search and commands"), keys: [`${mod} + K`] },
        { label: t("Neue Seite", "New page"), keys: [`${mod} + N`] },
        { label: t("Schnell erfassen", "Quick capture"), keys: [`${mod} + ⌥ + N`] },
        { label: t("Lesen oder bearbeiten umschalten", "Switch between reading and editing"), keys: [`${mod} + ⌥ + E`] },
        { label: t("Diese Übersicht", "This overview"), keys: ["?", `${mod} + /`] },
        { label: t("Dialog oder Menü schließen", "Close a dialog or menu"), keys: ["Esc"] },
      ],
    },
    {
      title: t("Seitenbaum", "Page tree"),
      items: [
        { label: t("Zwischen Seiten bewegen", "Move between pages"), keys: ["↑", "↓"] },
        { label: t("Unterseiten öffnen oder schließen", "Expand or collapse sub-pages"), keys: ["→", "←"] },
        { label: t("Seite öffnen", "Open the page"), keys: ["↵"] },
      ],
    },
    {
      title: t("Editor", "Editor"),
      items: [
        { label: t("Blöcke und Befehle", "Blocks and commands"), keys: ["/"] },
        { label: t("Personen, Seiten und Daten erwähnen", "Mention people, pages and dates"), keys: ["@"] },
        { label: t("Fett / Kursiv", "Bold / italic"), keys: [`${mod} + B`, `${mod} + I`] },
        { label: t("Text zentrieren", "Centre the text"), keys: [`${mod} + ⇧ + E`] },
        ...(ai ? [{ label: t("KI-Schreibassistent", "AI writing assistant"), keys: [`${mod} + J`] }] : []),
      ],
    },
  ];
}

export function KeyboardShortcuts({ open, onClose, ai }: { open: boolean; onClose: () => void; ai: boolean }) {
  const t = useT();
  return (
    <Modal open={open} onClose={onClose} title={t("Tastenkürzel", "Keyboard shortcuts")} className="shortcuts-dialog">
      <div className="shortcut-groups">
        {shortcutGroups(t, ai).map((group) => (
          <section key={group.title} className="shortcut-group" aria-label={group.title}>
            <h3>{group.title}</h3>
            <dl>
              {group.items.map((item) => (
                <div key={item.label} className="shortcut-row">
                  <dt>{item.label}</dt>
                  <dd>
                    {item.keys.map((key, i) => (
                      <span key={key}>
                        {i > 0 && <span className="shortcut-or">{t("oder", "or")}</span>}
                        <kbd>{key}</kbd>
                      </span>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
      <p className="muted small shortcut-hint">
        {t("Auf dem Mac gilt ⌘, sonst Ctrl (Strg).", "On a Mac ⌘ applies, Ctrl otherwise.")}
      </p>
    </Modal>
  );
}
