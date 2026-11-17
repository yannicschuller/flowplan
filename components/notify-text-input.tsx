"use client";
// The message of a database rule's notification (#330): the small editor
// of formatted text (components/rich-text-editor.tsx, loaded on demand) in
// the dialect of notifications – bold, italic, underline, strike, code,
// links, line breaks, @mentions of members (shown only, nobody is notified
// by them) and $formulas$. Until it is there – or if it cannot load – a
// plain text field takes its place. Workflows have their own field with
// placeholders (workflow/notify-message-input.tsx).
import { useEffect, useRef, useState } from "react";
import { At } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { notifyPlain } from "@/lib/notify-text";
import type { MentionPerson, RichTextHandle } from "./rich-text-editor";

const load = () => import("./rich-text-editor");
let loaded: Awaited<ReturnType<typeof load>>["default"] | null = null;

export function NotifyTextInput({ value, onChange, label, members, maxLength, placeholder, disabled = false }: { value: string; onChange: (text: string) => void; label: string; members: MentionPerson[]; maxLength: number; placeholder?: string; disabled?: boolean }) {
  const t = useT();
  const [Editor, setEditor] = useState(() => loaded);
  const [failed, setFailed] = useState(false);
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
  return (
    <span className="notify-text-input">
      <span className="notify-text-row">
        {failed ? (
          <input aria-label={label} value={value} maxLength={maxLength} placeholder={placeholder} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
        ) : Editor ? (
          <Editor value={value} onChange={onChange} commit="change" multiline formats="notify" members={members} label={label} placeholder={placeholder} disabled={disabled} handle={handle} />
        ) : (
          <span className="rich-text-input loading" aria-hidden>
            {notifyPlain(value) || placeholder || "…"}
          </span>
        )}
        {Editor && !disabled && members.length > 0 && (
          <button type="button" className="icon-button" aria-label={t("Mitglied erwähnen", "Mention a member")} title={t("Mitglied erwähnen (@)", "Mention a member (@)")} onMouseDown={(e) => e.preventDefault()} onClick={() => handle.current?.insertText("@")}>
            <At />
          </button>
        )}
      </span>
      {value.length > maxLength && (
        <span className="error small" role="alert">
          {t(`Höchstens ${maxLength} Zeichen (mit Formatierung).`, `At most ${maxLength} characters (including formatting).`)}
        </span>
      )}
    </span>
  );
}
