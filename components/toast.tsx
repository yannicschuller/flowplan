"use client";
// The one toast of the app: confirmations, errors (with "Retry") and undo
// offers ("… gelöscht · Rückgängig"). Rendered once by the workspace shell
// (<Toaster/>); everything else calls showToast()/showUndo().
//
// - Undo offers stay about 6 s, longer while the pointer or the focus is on
//   the toast. Mod+Z (⌘Z on Apple devices, Ctrl+Z elsewhere) takes the change
//   back while the offer is visible – unless the focus is in a text field or
//   the editor, where Mod+Z keeps undoing typing.
// - Two live regions that always exist: polite for confirmations and undo,
//   assertive for errors, so screen readers announce every toast.
// - On phones the toast sits above the tab bar and the safe area
//   (app/globals.css, .toast).
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ArrowCounterClockwise, Check, WarningCircle, X } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { useKeyboardHints } from "@/lib/keyboard-hints";
import { eventMatches } from "@/lib/keymap";
import { tr } from "@/lib/locale-tag";

export type ToastTone = "info" | "error" | "undo";
export type ToastInput = {
  text: string;
  detail?: string;
  tone?: ToastTone;
  // A button in the toast ("Retry", "Undo").
  action?: { label: string; run: () => void };
  // Milliseconds until it goes (paused while hovered or focused).
  duration?: number;
};
type Shown = ToastInput & { id: number; tone: ToastTone };

export const UNDO_MS = 6000;
export const UNDO_COMBO = "Mod+Z";
let current: Shown | null = null;
let serial = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function showToast(input: ToastInput) {
  current = { ...input, tone: input.tone || "info", id: ++serial };
  emit();
  return current.id;
}
export function dismissToast(id?: number) {
  if (id !== undefined && current?.id !== id) return;
  current = null;
  emit();
}
// "… gelöscht · Rückgängig": undo() takes the change back.
export function showUndo(message: string, undo: () => void | Promise<unknown>) {
  let used = false;
  return showToast({
    text: message,
    tone: "undo",
    duration: UNDO_MS,
    action: {
      label: tr("Rückgängig", "Undo"),
      run: () => {
        if (used) return;
        used = true;
        void undo();
      },
    },
  });
}
// The number of the last toast: callers that show their own confirmation
// only do so when no undo offer appeared meanwhile.
export const toastSerial = () => serial;
export const undoShownSince = (since: number) => serial > since && current?.tone === "undo";
export const currentToast = () => current;
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

// Typing somewhere: Mod+Z belongs to that field.
const typingIn = (el: Element | null) =>
  el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

export function Toaster() {
  const t = useT();
  const keyHints = useKeyboardHints();
  const toast = useSyncExternalStore(subscribe, currentToast, () => null);
  const ref = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(false);
  // The timer: restarts for each toast, waits while paused.
  useEffect(() => {
    if (!toast || paused) return;
    const timer = setTimeout(() => dismissToast(toast.id), toast.duration ?? (toast.tone === "error" ? 8000 : 5000));
    return () => clearTimeout(timer);
  }, [toast, paused]);
  useEffect(() => setPaused(false), [toast?.id]);
  // Mod+Z while an undo offer is visible.
  useEffect(() => {
    if (toast?.tone !== "undo" || !toast.action) return;
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !eventMatches(e, UNDO_COMBO, keyHints.mac)) return;
      const focus = document.activeElement;
      if (typingIn(focus) && !ref.current?.contains(focus)) return;
      e.preventDefault();
      e.stopPropagation();
      run(toast);
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [toast, keyHints.mac]);
  function run(shown: Shown) {
    // The focus was on the toast: it goes back to the page instead of the body.
    const hadFocus = ref.current?.contains(document.activeElement);
    dismissToast(shown.id);
    shown.action?.run();
    if (hadFocus) document.querySelector<HTMLElement>("main")?.focus({ preventScroll: true });
  }
  const combo = keyHints.keys(UNDO_COMBO);
  const body = toast && (
    <div
      ref={ref}
      key={toast.id}
      className={`toast toast-${toast.tone}${toast.tone === "error" ? " toast-error" : ""}`}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setPaused(false);
      }}
    >
      {toast.tone === "error" ? (
        <WarningCircle size={18} weight="fill" aria-hidden="true" />
      ) : toast.tone === "undo" ? (
        <ArrowCounterClockwise size={18} aria-hidden="true" />
      ) : (
        <Check size={18} aria-hidden="true" />
      )}
      {toast.detail ? (
        <span className="toast-text">
          <strong>{toast.text}</strong>
          <span>{toast.detail}</span>
        </span>
      ) : (
        <span className="toast-message">{toast.text}</span>
      )}
      {toast.action && (
        <button
          type="button"
          className="toast-action"
          aria-keyshortcuts={toast.tone === "undo" ? (keyHints.mac ? "Meta+Z" : "Control+Z") : undefined}
          onClick={() => run(toast)}
        >
          {toast.action.label}
          {toast.tone === "undo" && combo && (
            <kbd className="toast-kbd" aria-hidden="true">
              {combo}
            </kbd>
          )}
        </button>
      )}
      <button
        type="button"
        className="icon-button"
        aria-label={t("Meldung schließen", "Close message")}
        onClick={() => dismissToast(toast.id)}
      >
        <X size={16} />
      </button>
    </div>
  );
  return (
    <>
      <div className="toast-live" role="status" aria-live="polite" aria-atomic="true">
        {toast && toast.tone !== "error" ? body : null}
      </div>
      <div className="toast-live" role="alert" aria-live="assertive" aria-atomic="true">
        {toast && toast.tone === "error" ? body : null}
      </div>
    </>
  );
}
