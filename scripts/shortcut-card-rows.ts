// The records of the template "Flowplan-Tastenkürzel" (lib/template-catalog.ts
// key "shortcuts", docs/specs/flashcards.md §8.5), made from the keymap: the
// changeable actions with their default combinations (lib/keymap.ts) and the
// fixed shortcuts of the editor, the flashcard session and presentations,
// named as the overview names them (components/keyboard-shortcuts.tsx), each
// with its keys on the Mac and on Windows and Linux. The catalog is plain
// data, so ./shortcut-cards.mjs writes these rows into
// lib/template-shortcut-cards.ts; tests/study-templates.test.ts fails when
// the checked-in rows no longer match the keymap.
import { DEFAULT_KEYMAP, SHORTCUT_ACTIONS, formatCombo } from "../lib/keymap";
import { actionLabel, fixedShortcutGroups } from "../components/keyboard-shortcuts";

type T = (de: string, en: string) => string;
export type ShortcutCardRow = { cells: { title: string; mac: string; pc: string; area: string } };

// The areas of the template's select property, in this order.
export const shortcutAreas = (t: T) => [t("App", "App"), t("Editor", "Editor"), t("Lernkarten", "Flashcards"), t("Präsentation", "Presentation")];
// Keys a card cannot ask for: mouse clicks.
const MOUSE = /klick|click|maustaste|mouse/i;

export function shortcutCardRows(t: T): ShortcutCardRow[] {
  const [app, ...areas] = shortcutAreas(t);
  const rows: ShortcutCardRow[] = [];
  for (const action of SHORTCUT_ACTIONS) {
    const combos = DEFAULT_KEYMAP[action];
    if (!combos.length) continue;
    rows.push({
      cells: {
        title: action === "shortcuts" ? t("Übersicht der Tastenkürzel", "Keyboard shortcut overview") : actionLabel(action, t),
        mac: combos.map((c) => formatCombo(c, true)).join(" / "),
        pc: combos.map((c) => formatCombo(c, false)).join(" / "),
        area: app,
      },
    });
  }
  const mac = fixedShortcutGroups(t, false, true),
    pc = fixedShortcutGroups(t, false, false);
  // The groups by their titles: Editor, Lernkarten, Präsentation.
  for (const [i, area] of areas.entries()) {
    const title = [t("Editor", "Editor"), t("Lernkarten", "Flashcards"), t("Präsentation", "Presentation")][i];
    const onMac = mac.find((g) => g.title === title),
      onPc = pc.find((g) => g.title === title);
    if (!onMac || !onPc) throw new Error(`No shortcut group "${title}"`);
    for (const [j, item] of onMac.items.entries()) {
      const other = onPc.items[j];
      if (!other || [...item.keys, ...other.keys].some((k) => MOUSE.test(k))) continue;
      rows.push({ cells: { title: item.label, mac: item.keys.join(" / "), pc: other.keys.join(" / "), area } });
    }
  }
  return rows;
}

// The file scripts/shortcut-cards.mjs writes.
export function shortcutCardsModule() {
  const de = shortcutCardRows((d) => d),
    en = shortcutCardRows((_d, e) => e);
  return `// Written by scripts/shortcut-cards.mjs (npm run shortcut-cards) from the
// keymap (scripts/shortcut-card-rows.ts) – do not edit by hand. The records of
// the template "Flowplan-Tastenkürzel" (lib/template-rows.ts).
import type { CatalogRow } from "./template-catalog";

export const shortcutCards: { de: CatalogRow[]; en: CatalogRow[] } = ${JSON.stringify({ de, en }, null, 2)};
`;
}
