"use client";
// Emoji suggestions after ":" (#388) in the document editor and in comments:
// ":smi" opens a row of matching emojis at the caret, ←/→ move, Enter or Tab
// insert, Escape leaves the text as it is; ":smile:" turns into 😄 right
// away. The trigger rules (lib/emoji-trigger.ts) run with every change and
// are tiny; the row with the emoji data and the ranking
// (components/emoji-suggest-menu.tsx) loads the first time a trigger shows –
// nothing of it is in the editor's first load.
//
// Text-based like the "@" and "/" menus' Android path (#207): on-screen
// keyboards name their keys "Unidentified" and send the characters as text
// input, so the trigger is read from the text before the caret, never from
// key events; keys are only taken while the row is shown, not while an IME
// composes.
import dynamic from "next/dynamic";
import { useMemo, useState, useSyncExternalStore } from "react";
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { closedShortcodeAt, emojiTriggerAt, type EmojiTrigger } from "@/lib/emoji-trigger";
import { loadView } from "./view-fallback";

// What the loaded row offers the editor's keys.
export type EmojiRow = {
  count: number;
  move: (step: number) => void;
  pick: () => void;
};

export class EmojiSuggestController {
  view: EditorView | null = null;
  trigger: EmojiTrigger | null = null;
  // Set by the loaded row (its entries): ":name:" → the emoji to insert.
  exact: ((query: string) => { emoji: string } | null) | null = null;
  remember: ((emoji: string) => void) | null = null;
  row: EmojiRow | null = null;
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  get = () => this.trigger;
  set(trigger: EmojiTrigger | null) {
    const now = this.trigger;
    if (now === trigger || (now && trigger && now.from === trigger.from && now.to === trigger.to && now.query === trigger.query)) return;
    this.trigger = trigger;
    for (const listener of this.listeners) listener();
  }
  // Replaces the typed ":query" (or ":name:") with the emoji.
  insert(emoji: string, range = this.trigger) {
    const view = this.view;
    if (!view || !range || view.isDestroyed) return;
    view.dispatch(view.state.tr.insertText(emoji, range.from, range.to).scrollIntoView());
    this.remember?.(emoji);
    this.set(null);
    view.focus();
  }
  // Left/Right move, Enter or Tab insert, Escape dismisses: only while the
  // row shows emojis and no IME composes. Also called first by the editors'
  // own key handlers, ahead of every other Tab and Enter handling.
  keyDown(view: EditorView, event: KeyboardEvent) {
    const row = this.row;
    if (!this.trigger || !row?.count || event.isComposing || view.composing) return false;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      row.move(event.key === "ArrowRight" ? 1 : -1);
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      row.pick();
      return true;
    }
    if (event.key === "Escape") {
      this.dismiss();
      return true;
    }
    return false;
  }
  // Escape: the trigger stays text; typing on does not open it again.
  dismiss() {
    const view = this.view;
    if (view && this.trigger) view.dispatch(view.state.tr.setMeta(emojiSuggestKey, this.trigger.from));
    this.set(null);
  }
}

const emojiSuggestKey = new PluginKey<number | null>("emojiSuggest");

// The trigger at the caret, unless it was dismissed with Escape.
function current(state: EditorState, editable: boolean) {
  const trigger = editable ? emojiTriggerAt(state) : null;
  return trigger && emojiSuggestKey.getState(state) !== trigger.from ? trigger : null;
}

function emojiSuggestExtension(controller: EmojiSuggestController) {
  return Extension.create({
    name: "emojiSuggest",
    // Before the list and block shortcuts: Enter and Tab insert the emoji.
    priority: 1050,
    addProseMirrorPlugins() {
      return [
        new Plugin<number | null>({
          key: emojiSuggestKey,
          // Where the dismissed trigger's colon is.
          state: {
            init: () => null,
            apply: (tr, value) => {
              const meta = tr.getMeta(emojiSuggestKey);
              if (meta !== undefined) return meta;
              return value === null ? null : tr.mapping.map(value);
            },
          },
          view: (view) => {
            controller.view = view;
            return {
              update: (view, previous) => {
                const { state } = view;
                // ":smile:" – the closing colon just typed: the emoji right away.
                if (controller.exact && !view.composing && view.editable && view.hasFocus() && previous.doc !== state.doc) {
                  const head = state.selection.from;
                  const closed = closedShortcodeAt(state);
                  const hit = closed && previous.selection.empty && previous.selection.from === head - 1 && previous.doc.content.size === state.doc.content.size - 1 && controller.exact(closed.query);
                  if (closed && hit) {
                    queueMicrotask(() => {
                      if (!view.isDestroyed && view.state.doc.eq(state.doc)) controller.insert(hit.emoji, closed);
                    });
                    return controller.set(null);
                  }
                }
                controller.set(view.hasFocus() ? current(state, view.editable) : null);
              },
              destroy: () => {
                if (controller.view === view) controller.view = null;
                controller.set(null);
              },
            };
          },
          props: {
            handleKeyDown: (view, event) => controller.keyDown(view, event),
            handleDOMEvents: {
              blur: () => {
                controller.set(null);
                return false;
              },
              focus: (view) => {
                controller.set(current(view.state, view.editable));
                return false;
              },
            },
          },
        }),
      ];
    },
  });
}

const EmojiSuggestMenu = dynamic(() => loadView(() => import("./emoji-suggest-menu")), { ssr: false });

// The extension for the editor and the row to render next to it.
export function useEmojiSuggest() {
  const [controller] = useState(() => new EmojiSuggestController());
  const extension = useMemo(() => emojiSuggestExtension(controller), [controller]);
  const trigger = useSyncExternalStore(controller.subscribe, controller.get, () => null);
  return { extension, controller, trigger };
}

export function EmojiSuggest({ suggest }: { suggest: ReturnType<typeof useEmojiSuggest> }) {
  const { controller, trigger } = suggest;
  if (!trigger) return null;
  // Inside a dialog the row lives in the dialog (its focus trap).
  const container = controller.view?.dom.closest<HTMLElement>('[role="dialog"]') || null;
  return <EmojiSuggestMenu controller={controller} trigger={trigger} container={container} />;
}
