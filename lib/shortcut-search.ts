// The search field of the keyboard shortcut overview
// (components/keyboard-shortcuts.tsx, #204): a row matches when every word
// of the query is in one of its names (the UI language, German, English),
// or when every key of the query is in one of its combinations. Keys are
// compared in one written form, whatever the keyboard: Ctrl, Strg, Cmd, ⌘,
// ⌃ and Mod are the same key here, as are Shift/⇧/Umschalt and
// Alt/Option/⌥; "+", "-", "," and spaces separate keys, and the Mac's
// symbols need none ("⇧⌘L"). Pure, for the tests.

const KEY_ALIASES: Record<string, string> = {
  mod: "mod",
  ctrl: "mod",
  control: "mod",
  ctl: "mod",
  strg: "mod",
  cmd: "mod",
  command: "mod",
  befehl: "mod",
  meta: "mod",
  win: "mod",
  "⌘": "mod",
  "⌃": "mod",
  "^": "mod",
  shift: "shift",
  umschalt: "shift",
  "⇧": "shift",
  alt: "alt",
  option: "alt",
  opt: "alt",
  wahl: "alt",
  "⌥": "alt",
  arrowup: "up",
  up: "up",
  "↑": "up",
  arrowdown: "down",
  down: "down",
  "↓": "down",
  arrowleft: "left",
  left: "left",
  "←": "left",
  arrowright: "right",
  right: "right",
  "→": "right",
  enter: "enter",
  return: "enter",
  eingabe: "enter",
  "↵": "enter",
  "⏎": "enter",
  esc: "esc",
  escape: "esc",
  space: "space",
  leertaste: "space",
  backspace: "backspace",
  "⌫": "backspace",
  del: "delete",
  delete: "delete",
  entf: "delete",
  klick: "click",
  click: "click",
};

const SYMBOLS = /([⌘⌃⇧⌥↑↓←→↵⏎⌫])/g;

// "Ctrl + Shift + L", "⇧ ⌘ L", "mod+shift+l", "⌘L" → ["mod", "shift", "l"].
export function keyTokens(text: string): string[] {
  const spaced = text.toLocaleLowerCase("en").replace(SYMBOLS, " $1 ");
  const out: string[] = [];
  // A "+" or "-" alone is a key at the end (Mod+Plus is "⌘ +", "Ctrl + +"),
  // elsewhere a separator.
  const parts = spaced.split(/[\s,]+/).filter(Boolean);
  for (const [i, part] of parts.entries()) {
    const alone = part === "+" || part === "-";
    if (alone && i < parts.length - 1) continue;
    const pieces = alone ? [part] : part.split(/[+-]/).filter(Boolean);
    for (const piece of pieces) out.push(KEY_ALIASES[piece] ?? (piece === "plus" ? "+" : piece));
  }
  return out;
}

// Lower case without accents: "ubersicht" finds "Übersicht".
function fold(text: string): string {
  return text
    .toLocaleLowerCase("de")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

export type SearchableShortcut = { labels: string[]; keys: string[] };

export function shortcutMatches(query: string, row: SearchableShortcut): boolean {
  const q = query.trim();
  if (!q) return true;
  const words = fold(q).split(/\s+/).filter(Boolean);
  if (row.labels.some((label) => {
    const text = fold(label);
    return words.every((word) => text.includes(word));
  }))
    return true;
  const wanted = keyTokens(q);
  if (!wanted.length) return false;
  return row.keys.some((combo) => {
    const have = new Set(keyTokens(combo));
    return wanted.every((token) => have.has(token));
  });
}
