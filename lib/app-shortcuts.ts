// The global shortcuts (lib/keymap.ts) for the apps' hardware keyboard
// support (flowplan-app on the iPad and iPhone): the page lists them with
// `FlowplanApp.shortcuts`, the app makes key commands of them – holding ⌘
// shows them in the system's overlay – and runs a pressed one with
// `window.FlowplanShortcuts.run(action)`. The person's own combinations
// count; the list follows when they change.
//
// Depending on the system the key reaches the page as well; an action that
// both the key event and the app report runs once (`firstRun`).
import { activeKeymap, isMacPlatform, parseCombo, subscribeKeymap, SHORTCUT_ACTIONS, type Keymap, type ShortcutAction } from "./keymap";
import { nativeApp } from "./native-app";

export type AppKeyCommand = {
  action: ShortcutAction;
  title: string;
  // One character in lower case, or a named key ("up", "escape", "f5" …).
  input: string;
  modifiers: ("command" | "alternate" | "control" | "shift")[];
  // Further combinations of an action: they work, the overlay lists one.
  hidden?: true;
};

const NAMED: Record<string, string> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Escape: "escape",
  PageUp: "pageUp",
  PageDown: "pageDown",
  Home: "home",
  End: "end",
  Delete: "delete",
  Enter: "\r",
  Tab: "\t",
  Space: " ",
  Backspace: "\b",
  Plus: "+",
};

// The key commands of a keymap. Combinations without ⌘, ⌃ or ⌥ ("?") stay
// with the page: as key commands they would take the key away from typing.
export function appKeyCommands(map: Keymap, title: (action: ShortcutAction) => string, mac = true): AppKeyCommand[] {
  const out: AppKeyCommand[] = [];
  for (const action of SHORTCUT_ACTIONS) {
    let listed = false;
    for (const text of map[action]) {
      const c = parseCombo(text);
      if (!c) continue;
      const command = c.meta || (c.mod && mac);
      const control = c.ctrl || (c.mod && !mac);
      if (!command && !control && !c.alt) continue;
      const input = NAMED[c.key] ?? (/^F([1-9]|1[0-2])$/.test(c.key) ? c.key.toLowerCase() : c.key.length === 1 ? c.key.toLowerCase() : null);
      if (!input) continue;
      const modifiers: AppKeyCommand["modifiers"] = [];
      if (c.alt) modifiers.push("alternate");
      if (command) modifiers.push("command");
      if (control) modifiers.push("control");
      if (c.shift) modifiers.push("shift");
      out.push({ action, title: title(action), input, modifiers, ...(listed ? { hidden: true as const } : {}) });
      listed = true;
    }
  }
  return out;
}

// An action that ran a moment ago – from the key event or from the app –
// does not run again for the same key press.
const SAME_PRESS_MS = 250;
export function pressGuard(now: () => number = Date.now) {
  let last: { action: string; at: number } | null = null;
  return (action: string) => {
    const at = now();
    const again = !!last && last.action === action && at - last.at < SAME_PRESS_MS;
    last = { action, at };
    return !again;
  };
}
export const firstRun = pressGuard();

// Offers the shortcuts to the app and runs those it reports; nothing outside
// the apps or with apps that do not know shortcuts. Returns the clean-up.
export function installAppShortcuts(run: (action: ShortcutAction) => void, title: (action: ShortcutAction) => string) {
  const app = nativeApp();
  if (typeof window === "undefined" || !app?.shortcuts) return () => {};
  const offer = () => {
    try {
      app.shortcuts?.(appKeyCommands(activeKeymap(), title, isMacPlatform()));
    } catch {}
  };
  const api = Object.freeze({
    run: (action: unknown) => {
      if (typeof action !== "string" || !(SHORTCUT_ACTIONS as readonly string[]).includes(action)) return false;
      if (firstRun(action)) run(action as ShortcutAction);
      return true;
    },
  });
  (window as unknown as { FlowplanShortcuts?: typeof api }).FlowplanShortcuts = api;
  offer();
  const stop = subscribeKeymap(offer);
  return () => {
    stop();
    const w = window as unknown as { FlowplanShortcuts?: typeof api };
    if (w.FlowplanShortcuts === api) delete w.FlowplanShortcuts;
  };
}
