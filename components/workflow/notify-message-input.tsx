"use client";
// The message of "Notify a person" (#330): the small editor of formatted
// text (components/rich-text-editor.tsx, loaded on demand) in the dialect
// of notifications – bold, italic, underline, strike, code, links, line
// breaks, @mentions of members and $formulas$ – with the placeholders of
// the workflow as chips. The {} button or typing "{{" opens the picker as
// in every template field (template-input.tsx), the @ button the list of
// members. Shown and typed in the display form (names in the reader's
// language), stored with ids (fromDisplay). Until the editor is there – or
// if it cannot load – the plain template field takes its place.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { At, BracketsCurly } from "@phosphor-icons/react";
import { useLocale } from "../i18n";
import { fromDisplay } from "@/lib/workflows/placeholders";
import { notifyPlain } from "@/lib/notify-text";
import type { MentionPerson, RichTextHandle } from "../rich-text-editor";
import { PlaceholderPicker, TemplateInput, type PickerContext } from "./template-input";
import { displayContext, showText, useStableT } from "./model";

const load = () => import("../rich-text-editor");
let loaded: Awaited<ReturnType<typeof load>>["default"] | null = null;
export const MAX_NOTIFY_MESSAGE = 2000;

export function NotifyMessageInput({
  value,
  onChange,
  label,
  picker,
  members,
  disabled = false,
  template = true,
  maxLength = MAX_NOTIFY_MESSAGE,
}: {
  value: string;
  onChange: (stored: string) => void;
  label: string;
  picker: PickerContext | null;
  members: MentionPerson[];
  disabled?: boolean;
  // false: a database rule's message (no placeholders).
  template?: boolean;
  maxLength?: number;
}) {
  const t = useStableT();
  const locale = useLocale();
  const id = useId();
  const ctx = useMemo(() => (picker ? displayContext(picker.graph, locale, picker.ws) : null), [picker, locale]);
  const shown = useMemo(() => (ctx && template ? showText(value, ctx) : value), [value, ctx, template]);
  const [Editor, setEditor] = useState(() => loaded);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const handle = useRef<RichTextHandle | null>(null);
  useEffect(() => {
    if (Editor) return;
    let live = true;
    load().then(
      (m) => {
        loaded = m.default;
        if (live) setEditor(() => m.default);
      },
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [Editor]);
  if (failed && template) return <TemplateInput label={label} value={value} picker={picker} disabled={disabled} multiline onChange={onChange} />;
  const commit = (display: string) => {
    try {
      const stored = ctx && template ? fromDisplay(display, ctx) : display;
      setError(null);
      if (stored !== value) onChange(stored);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const chipLabel = (raw: string) => raw.replace(/^\{\{\s*|\s*\}\}$/g, "");
  const errorId = `${id}-error`;
  return (
    <div className="wf-template wf-notify-message">
      <span className="wf-field-label" id={`${id}-label`}>
        {label}
      </span>
      <div className="wf-template-row">
        {Editor ? (
          <Editor
            value={shown}
            onChange={commit}
            commit="change"
            multiline
            formats="notify"
            slots={template}
            members={members}
            label={label}
            disabled={disabled}
            chipLabel={chipLabel}
            handle={handle}
            describedBy={error ? errorId : `${id}-hint`}
            placeholder={t("Nachricht (optional)", "Message (optional)")}
            onPlaceholder={() => picker && setOpen(true)}
          />
        ) : failed ? (
          <textarea aria-label={label} value={value} rows={3} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
        ) : (
          <span className="rich-text-input multiline loading" aria-hidden>
            {notifyPlain(value) || "…"}
          </span>
        )}
        {!disabled && Editor && (
          <span className="wf-notify-tools">
            {picker && template && (
              <button type="button" className="icon-button" aria-label={t(`Platzhalter einfügen in „${label}“`, `Insert a placeholder into “${label}”`)} aria-expanded={open} onClick={() => setOpen(!open)}>
                <BracketsCurly />
              </button>
            )}
            {members.length > 0 && (
              <button type="button" className="icon-button" aria-label={t("Mitglied erwähnen", "Mention a member")} title={t("Mitglied erwähnen (@)", "Mention a member (@)")} onMouseDown={(e) => e.preventDefault()} onClick={() => handle.current?.insertText("@")}>
                <At />
              </button>
            )}
          </span>
        )}
      </div>
      <small className="muted wf-notify-hint" id={`${id}-hint`}>
        {t(
          "Text markieren zum Formatieren · @ erwähnt ein Mitglied (nur angezeigt, ohne Benachrichtigung) · $x^2$ wird eine Formel",
          "Select text to format · @ mentions a member (shown only, not notified) · $x^2$ becomes a formula",
        )}
      </small>
      {error && (
        <small className="wf-field-error" id={errorId}>
          {error}
        </small>
      )}
      {value.length > maxLength && (
        <small className="wf-field-error" role="alert">
          {t(`Höchstens ${maxLength} Zeichen (mit Formatierung).`, `At most ${maxLength} characters (including formatting).`)}
        </small>
      )}
      {open && picker && (
        <PlaceholderPicker
          ctx={picker}
          onPick={(stored) => {
            setOpen(false);
            const raw = ctx ? showText(stored, ctx) : stored;
            requestAnimationFrame(() => handle.current?.insertPlaceholder(raw));
          }}
          onClose={() => {
            setOpen(false);
            handle.current?.focus();
          }}
        />
      )}
    </div>
  );
}
