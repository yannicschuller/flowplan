"use client";
// Link properties (url, email, phone) as links that open, with a pencil to
// edit them (issue #67). Only http(s), mailto and tel become links
// (lib/cell-links.ts); anything else is shown as plain text.
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { PencilSimple } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { cellHref, linkLabel, type LinkFieldType } from "@/lib/cell-links";

// The value as a link (or plain text), shortened, the full value as title.
// Clicks on the link open it and go no further (a row or card around it
// would open the record instead).
export function LinkValue({ type, value }: { type: LinkFieldType; value: unknown }) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  const href = cellHref(type, text);
  if (!href)
    return (
      <span className="cell-link-text" title={text}>
        {text}
      </span>
    );
  const web = /^https?:/i.test(href);
  return (
    <a
      className="cell-link"
      href={href}
      title={text}
      target={web ? "_blank" : undefined}
      rel="noopener noreferrer"
      draggable={false}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {type === "url" ? linkLabel(href) : text}
    </a>
  );
}

// A table cell that is not being edited: the link and, if it may be
// changed, a pencil (on hover or focus; always on touch screens).
export function LinkCellDisplay({
  type,
  value,
  name,
  onEdit,
}: {
  type: LinkFieldType;
  value: unknown;
  name: string;
  onEdit?: () => void;
}) {
  const t = useT();
  const empty = !(typeof value === "string" && value.trim());
  if (empty) return <span className="muted">—</span>;
  return (
    <span className="link-cell">
      <LinkValue type={type} value={value} />
      {onEdit && (
        <button
          type="button"
          className="link-cell-edit"
          aria-label={t(`${name} bearbeiten`, `Edit ${name}`)}
          title={t("Bearbeiten", "Edit")}
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
        >
          <PencilSimple size={13} aria-hidden="true" />
        </button>
      )}
    </span>
  );
}

const INPUT_TYPE: Record<LinkFieldType, string> = { url: "url", email: "email", phone: "tel" };

// The editable property: the link with a pencil; a click on the empty part
// of the field, the pencil or Enter on it switch to the input. In the input
// Enter saves, Escape restores the old value. Empty values show the input.
export function LinkInput({
  type,
  name,
  value,
  disabled,
  placeholder,
  editing: startEditing = false,
  onChange,
  onCancel,
}: {
  type: LinkFieldType;
  name: string;
  value: unknown;
  disabled?: boolean;
  placeholder?: string;
  // Opens straight in the input (a table cell that was clicked).
  editing?: boolean;
  onChange: (v: unknown) => void | Promise<unknown>;
  // The edit ended without a change (Escape, or Enter/leaving unchanged).
  onCancel?: () => void;
}) {
  const t = useT();
  const saved = typeof value === "string" ? value : value == null ? "" : String(value);
  const [draft, setDraft] = useState(saved);
  const [editing, setEditing] = useState(startEditing);
  const input = useRef<HTMLInputElement>(null),
    pencil = useRef<HTMLButtonElement>(null),
    focusInput = useRef(startEditing),
    focusPencil = useRef(false),
    cancelled = useRef(false);
  useEffect(() => {
    if (!editing) setDraft(saved);
  }, [saved, editing]);
  useEffect(() => {
    if (editing && focusInput.current) {
      focusInput.current = false;
      input.current?.focus();
      input.current?.select();
    }
    if (!editing && focusPencil.current) {
      focusPencil.current = false;
      pencil.current?.focus();
    }
  }, [editing]);
  const showInput = !disabled && (editing || !saved.trim());
  function finish(save: boolean) {
    const changed = save && draft.trim() !== saved.trim();
    if (changed) void onChange(draft.trim());
    else setDraft(saved);
    if (draft.trim() || !save) setEditing(false);
    if (!changed) onCancel?.();
  }
  const escape = useRef<() => boolean>(() => false);
  escape.current = () => {
    // Nothing being edited: Escape goes on (and closes a dialog, say).
    if (!editing && draft === saved) return false;
    focusPencil.current = !!saved.trim();
    cancelled.current = true;
    finish(false);
    return true;
  };
  useEffect(() => {
    if (!showInput) return;
    // Dialogs listen for Escape on the document in the capture phase; the
    // window hears it first, so only the edit ends and the dialog stays.
    const listener = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.target !== input.current || event.isComposing) return;
      if (!escape.current()) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  }, [showInput]);
  if (!showInput)
    return (
      <span
        className={`link-field${disabled ? " disabled" : ""}`}
        onClick={(e: MouseEvent) => {
          // The empty part of the field edits; the link itself opens.
          if (disabled || (e.target as HTMLElement).closest("a, button")) return;
          focusInput.current = true;
          setEditing(true);
        }}
      >
        {saved.trim() ? <LinkValue type={type} value={saved} /> : <span className="muted">—</span>}
        {!disabled && (
          <button
            ref={pencil}
            type="button"
            className="link-cell-edit"
            aria-label={t(`${name} bearbeiten`, `Edit ${name}`)}
            title={t("Bearbeiten", "Edit")}
            onClick={() => {
              focusInput.current = true;
              setEditing(true);
            }}
          >
            <PencilSimple size={13} aria-hidden="true" />
          </button>
        )}
      </span>
    );
  return (
    <input
      ref={input}
      aria-label={name}
      type={INPUT_TYPE[type]}
      inputMode={type === "phone" ? "tel" : undefined}
      autoComplete="off"
      disabled={disabled}
      value={draft}
      placeholder={placeholder ?? t("Leer", "Empty")}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => {
        cancelled.current = false;
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          focusPencil.current = !!draft.trim();
          cancelled.current = true;
          finish(true);
        }
        // Escape: see the listener on the window above.
      }}
      onBlur={() => {
        // Enter or Escape already decided.
        if (cancelled.current) {
          cancelled.current = false;
          return;
        }
        finish(true);
      }}
    />
  );
}
