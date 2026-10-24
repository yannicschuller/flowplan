// The app-wide keyboard shortcuts as one keymap: the default combinations,
// the person's own ones (stored per user, lib/user-shortcuts.ts, command
// `shortcuts.save`), parsing, matching key events and finding conflicts.
// Every global shortcut handler asks matchAction(); the overlay in
// components/keyboard-shortcuts.tsx edits the overrides. Shortcuts inside
// the editor (TipTap marks …) stay as they are and are only listed.
//
// A combination is written as "Mod+Alt+N": modifiers first (Mod, Ctrl, Meta,
// Alt, Shift), then one key. "Mod" is ⌘ on Apple devices and Ctrl elsewhere.
// Recorded and stored combinations use Mod for that key, so one account's
// shortcuts work on a Mac and a PC alike; "Ctrl" and "Meta" stay for the
// other physical keys (⌃ on the Mac, the Windows key elsewhere).
import { appleOS, currentOS } from "./device-os";

export const SHORTCUT_ACTIONS = [
  "search",
  "newPage",
  "capture",
  "shortcuts",
  "readMode",
  "sidebar",
  "focusMode",
  "comments",
  "theme",
  "splitView",
  "present",
] as const;
export type ShortcutAction = (typeof SHORTCUT_ACTIONS)[number];
export type Keymap = Record<ShortcutAction, string[]>;
// Only the actions that differ from the defaults; an empty list: no shortcut.
export type KeymapOverrides = Partial<Record<ShortcutAction, string[]>>;

export const DEFAULT_KEYMAP: Keymap = {
  search: ["Mod+K"],
  newPage: ["Mod+N"],
  capture: ["Mod+Alt+N"],
  shortcuts: ["?", "Mod+/"],
  readMode: ["Mod+Alt+E"],
  sidebar: ["Mod+Alt+B"],
  focusMode: ["Mod+Alt+Z"],
  comments: ["Mod+Alt+K"],
  theme: [],
  splitView: ["Mod+Alt+S"],
  present: ["Mod+Alt+P"],
};
// At most this many combinations per action.
export const MAX_COMBOS = 3;

// Shortcuts of the editor (TipTap and Flowplan's own), listed read-only and
// checked for conflicts with the global ones.
export const EDITOR_SHORTCUTS: { combo: string; id: string }[] = [
  { combo: "Mod+B", id: "bold" },
  { combo: "Mod+I", id: "italic" },
  { combo: "Mod+U", id: "underline" },
  { combo: "Mod+Shift+S", id: "strike" },
  { combo: "Mod+E", id: "code" },
  { combo: "Mod+Shift+E", id: "center" },
  { combo: "Mod+Shift+H", id: "highlight" },
  { combo: "Mod+Alt+H", id: "spoiler" },
  { combo: "Mod+.", id: "superscript" },
  { combo: "Mod+,", id: "subscript" },
  { combo: "Mod+Alt+F", id: "footnote" },
  { combo: "Mod+Alt+M", id: "comment" },
  { combo: "Mod+Shift+ArrowUp", id: "moveBlock" },
  { combo: "Mod+Shift+ArrowDown", id: "moveBlock" },
  { combo: "Mod+Alt+0", id: "paragraph" },
  ...[1, 2, 3, 4, 5, 6].map((n) => ({ combo: `Mod+Alt+${n}`, id: "heading" })),
  { combo: "Mod+Shift+7", id: "orderedList" },
  { combo: "Mod+Shift+8", id: "bulletList" },
  { combo: "Mod+Shift+9", id: "taskList" },
  { combo: "Mod+Shift+B", id: "blockquote" },
  { combo: "Mod+Alt+C", id: "codeBlock" },
  { combo: "Mod+Z", id: "undo" },
  { combo: "Mod+Shift+Z", id: "redo" },
  { combo: "Mod+J", id: "ai" },
];
// Combinations the browser keeps for itself (tabs, windows): a page cannot
// reliably use them.
export const BROWSER_RESERVED = [
  "Mod+W",
  "Mod+T",
  "Mod+Q",
  "Mod+Shift+T",
  "Mod+Shift+N",
  "Mod+Shift+W",
  "Mod+Tab",
  "Ctrl+Tab",
  "Mod+L",
  "Mod+R",
  "Mod+P",
  "F5",
];

export type Combo = {
  mod: boolean;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
};

const NAMED: Record<string, string> = {
  enter: "Enter",
  return: "Enter",
  escape: "Escape",
  esc: "Escape",
  space: "Space",
  " ": "Space",
  spacebar: "Space",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  del: "Delete",
  insert: "Insert",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  plus: "Plus",
  "+": "Plus",
};
const MODIFIER_KEYS = new Set(["Control", "Meta", "Alt", "Shift", "AltGraph", "OS", "Hyper", "Super", "CapsLock", "Fn"]);
const PUNCTUATION = /^[!-/:-@[-`{-~§°´^]$/;

// One key in its written form: letters upper case, named keys spelled out,
// punctuation as the character. Null for keys that cannot be a shortcut.
export function normalizeKey(raw: string): string | null {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (NAMED[lower]) return NAMED[lower];
  if (/^[a-z]$/i.test(raw)) return raw.toUpperCase();
  if (/^[0-9]$/.test(raw)) return raw;
  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(raw)) return raw.toUpperCase();
  if (PUNCTUATION.test(raw)) return raw;
  return null;
}
const isPunctuation = (key: string) => PUNCTUATION.test(key);

export function parseCombo(text: string): Combo | null {
  if (typeof text !== "string" || !text.trim() || text.length > 40) return null;
  // "Mod++" would be ambiguous: the plus key is written "Plus".
  const parts = text.trim().split("+").map((p) => p.trim());
  if (parts.some((p) => !p)) return null;
  const combo: Combo = { mod: false, ctrl: false, meta: false, alt: false, shift: false, key: "" };
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i],
      lower = part.toLowerCase(),
      last = i === parts.length - 1;
    const modifier =
      // ⌘ / Cmd is the Apple name of the platform modifier: stored as Mod,
      // so the combination works with Ctrl on Windows and Linux as well.
      lower === "mod" || lower === "cmd" || lower === "command" || lower === "⌘" ? "mod"
      : lower === "ctrl" || lower === "control" || lower === "strg" || lower === "⌃" ? "ctrl"
      : lower === "meta" || lower === "super" || lower === "win" ? "meta"
      : lower === "alt" || lower === "option" || lower === "opt" || lower === "⌥" ? "alt"
      : lower === "shift" || lower === "⇧" ? "shift"
      : null;
    if (modifier && !last) {
      if (combo[modifier]) return null;
      combo[modifier] = true;
      continue;
    }
    if (!last) return null;
    const key = normalizeKey(part);
    if (!key) return null;
    combo.key = key;
  }
  if (!combo.key) return null;
  // A character that needs Shift ("?") already says so.
  if (isPunctuation(combo.key)) combo.shift = false;
  return combo;
}

export function comboText(c: Combo): string {
  return [c.mod && "Mod", c.ctrl && "Ctrl", c.meta && "Meta", c.alt && "Alt", c.shift && "Shift", c.key].filter(Boolean).join("+");
}
// The written form of a combination, or null when it is not one.
export function normalizeCombo(text: string): string | null {
  const c = parseCombo(text);
  return c ? comboText(c) : null;
}
// The same combination on this platform with "Mod" spelled out, so
// "Mod+K" and "Ctrl+K" are recognised as equal off the Mac.
export function platformCombo(text: string, mac: boolean): string | null {
  const c = parseCombo(text);
  if (!c) return null;
  return comboText({
    mod: false,
    ctrl: c.ctrl || (c.mod && !mac),
    meta: c.meta || (c.mod && mac),
    alt: c.alt,
    shift: c.shift,
    key: c.key,
  });
}

// Whether THIS device writes and presses shortcuts the Apple way (⌘ for Mod).
// Decided per device (lib/device-os.ts), never per account.
export function isMacPlatform(): boolean {
  return appleOS(currentOS());
}

// The parts of a key event the keymap needs (KeyboardEvent fits).
export type KeyLike = {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  getModifierState?: (key: string) => boolean;
};

// The key of an event in written form. With Alt (⌥ on the Mac turns letters
// into other characters) the physical key decides – unless it was AltGr
// typing a character (Ctrl+Alt on Windows).
export function eventKey(e: KeyLike): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  const direct = normalizeKey(e.key);
  if (direct && /^[A-Z0-9]$/.test(direct)) return direct;
  const altGraph = !!e.getModifierState?.("AltGraph");
  const code = e.code || "";
  if (!altGraph) {
    const letter = code.match(/^Key([A-Z])$/);
    if (letter && (e.altKey || !direct)) return letter[1];
    const digit = code.match(/^(?:Digit|Numpad)([0-9])$/);
    // With Shift the character counts ("Mod+/" is Shift+7 on German keyboards).
    if (digit && ((e.altKey && !e.shiftKey) || !direct)) return digit[1];
  }
  return direct;
}

// The combination an event presses, for recording a new shortcut.
export function comboFromEvent(e: KeyLike, mac: boolean): string | null {
  const key = eventKey(e);
  if (!key) return null;
  const punctuation = isPunctuation(key);
  return comboText({
    mod: mac ? e.metaKey : e.ctrlKey,
    ctrl: mac ? e.ctrlKey : false,
    meta: mac ? false : e.metaKey,
    alt: e.altKey,
    shift: e.shiftKey && !punctuation,
    key,
  });
}

export function eventMatches(e: KeyLike, text: string, mac: boolean): boolean {
  const c = parseCombo(text);
  if (!c) return false;
  const ctrl = c.ctrl || (c.mod && !mac),
    meta = c.meta || (c.mod && mac);
  if (e.ctrlKey !== ctrl || e.metaKey !== meta || e.altKey !== c.alt) return false;
  const key = eventKey(e);
  if (key !== c.key) return false;
  // "?" is typed with Shift on most keyboards and without on others.
  return isPunctuation(c.key) || e.shiftKey === c.shift;
}

// A combination without Ctrl, ⌘ or Alt is typed text while writing.
export function needsModifier(text: string): boolean {
  const c = parseCombo(text);
  return !!c && !c.mod && !c.ctrl && !c.meta && !c.alt;
}

export function resolveKeymap(overrides?: KeymapOverrides | null): Keymap {
  const map = { ...DEFAULT_KEYMAP };
  for (const action of SHORTCUT_ACTIONS) {
    const own = overrides?.[action];
    if (Array.isArray(own)) map[action] = own.flatMap((c) => normalizeCombo(c) ?? []).slice(0, MAX_COMBOS);
  }
  return map;
}

// Overrides in their written form: unknown actions and invalid combinations
// dropped, duplicates removed, entries equal to the default left out.
export function cleanOverrides(input: unknown): KeymapOverrides {
  const out: KeymapOverrides = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return out;
  for (const action of SHORTCUT_ACTIONS) {
    const value = (input as Record<string, unknown>)[action];
    if (!Array.isArray(value)) continue;
    const combos = [...new Set(value.flatMap((c) => (typeof c === "string" ? normalizeCombo(c) ?? [] : [])))].slice(0, MAX_COMBOS);
    if (combos.join("|") === DEFAULT_KEYMAP[action].join("|")) continue;
    out[action] = combos;
  }
  return out;
}

export type Conflict =
  | { combo: string; kind: "action"; with: ShortcutAction }
  | { combo: string; kind: "editor"; with: string }
  | { combo: string; kind: "browser" };

// What else a combination of an action collides with on this platform.
export function conflictsOf(map: Keymap, action: ShortcutAction, mac: boolean): Conflict[] {
  const found: Conflict[] = [];
  const editor = EDITOR_SHORTCUTS.map((s) => ({ ...s, at: platformCombo(s.combo, mac) }));
  const browser = new Set(BROWSER_RESERVED.map((c) => platformCombo(c, mac)));
  for (const combo of map[action]) {
    const at = platformCombo(combo, mac);
    if (!at) continue;
    for (const other of SHORTCUT_ACTIONS)
      if (other !== action && map[other].some((c) => platformCombo(c, mac) === at))
        found.push({ combo, kind: "action", with: other });
    for (const e of editor) if (e.at === at) found.push({ combo, kind: "editor", with: e.id });
    if (browser.has(at)) found.push({ combo, kind: "browser" });
  }
  return found;
}
export function allConflicts(map: Keymap, mac: boolean): Partial<Record<ShortcutAction, Conflict[]>> {
  const out: Partial<Record<ShortcutAction, Conflict[]>> = {};
  for (const action of SHORTCUT_ACTIONS) {
    const list = conflictsOf(map, action, mac);
    if (list.length) out[action] = list;
  }
  return out;
}
// The other actions already using a combination.
export function actionsUsing(map: Keymap, combo: string, mac: boolean, except?: ShortcutAction): ShortcutAction[] {
  const at = platformCombo(combo, mac);
  if (!at) return [];
  return SHORTCUT_ACTIONS.filter((a) => a !== except && map[a].some((c) => platformCombo(c, mac) === at));
}

// The first action whose combination the event presses. While typing (in a
// field or the editor) combinations without Ctrl, ⌘ or Alt do not count.
export function actionForEvent(e: KeyLike, map: Keymap, mac: boolean, typing: boolean): ShortcutAction | null {
  for (const action of SHORTCUT_ACTIONS)
    for (const combo of map[action]) {
      if (typing && needsModifier(combo)) continue;
      if (eventMatches(e, combo, mac)) return action;
    }
  return null;
}

// How a combination reads: "⌘ ⌥ N" on the Mac, "Ctrl + Alt + N" elsewhere.
const KEY_LABELS: Record<string, string> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Enter: "↵",
  Escape: "Esc",
  Backspace: "⌫",
  Plus: "+",
};
// Off the Mac keys are written out, as on the keycaps there.
const PC_KEY_LABELS: Record<string, string> = { Enter: "Enter", Backspace: "Backspace" };
export function formatCombo(text: string, mac: boolean): string {
  const c = parseCombo(text);
  if (!c) return text;
  const key = (!mac && PC_KEY_LABELS[c.key]) || KEY_LABELS[c.key] || c.key;
  if (mac)
    return [c.ctrl && "⌃", c.alt && "⌥", c.shift && "⇧", (c.mod || c.meta) && "⌘", key].filter(Boolean).join(" ");
  return [(c.mod || c.ctrl) && "Ctrl", c.meta && "Win", c.alt && "Alt", c.shift && "Shift", key].filter(Boolean).join(" + ");
}

// ---- The keymap in effect in this browser ----

let current: Keymap = DEFAULT_KEYMAP;
const listeners = new Set<() => void>();
export function setKeymapOverrides(overrides?: KeymapOverrides | null) {
  const next = resolveKeymap(overrides);
  if (JSON.stringify(next) === JSON.stringify(current)) return;
  current = next;
  listeners.forEach((listener) => listener());
}
export function activeKeymap(): Keymap {
  return current;
}
export function subscribeKeymap(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
// For the global handlers: the action of a key event under the active keymap.
export function matchAction(e: KeyLike, typing: boolean, mac = isMacPlatform()): ShortcutAction | null {
  return actionForEvent(e, current, mac, typing);
}
// The first combination of an action, for hints in titles ("Lesemodus (⌘ ⌥ E)").
export function shortcutHint(action: ShortcutAction, mac = isMacPlatform()): string {
  const combo = current[action][0];
  return combo ? formatCombo(combo, mac) : "";
}
