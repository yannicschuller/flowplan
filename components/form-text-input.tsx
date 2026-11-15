"use client";
// The field for a form's or a question's description (#306): the small
// editor of formatted text (components/rich-text-editor.tsx) with
// underline and text colours, loaded on demand. Until it is there – or if
// it cannot load – a plain text field takes its place.
import { useEffect, useState } from "react";
import { useT } from "./i18n";
import { formTextPlain } from "@/lib/form-text";

const load = () => import("./rich-text-editor");
let loaded: Awaited<ReturnType<typeof load>>["default"] | null = null;

export function FormTextInput({
  value,
  onChange,
  label,
  maxLength,
  placeholder,
  disabled = false,
}: {
  value: string;
  onChange: (text: string) => void;
  label: string;
  maxLength: number;
  placeholder?: string;
  disabled?: boolean;
}) {
  const t = useT();
  const [Editor, setEditor] = useState(() => loaded);
  const [failed, setFailed] = useState(false);
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
    <>
      {failed ? (
        <textarea aria-label={label} value={value} rows={2} disabled={disabled} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      ) : Editor ? (
        <Editor value={value} onChange={onChange} commit="change" multiline formats="form" label={label} placeholder={placeholder} disabled={disabled} />
      ) : (
        <span className="rich-text-input multiline loading" aria-hidden>
          {formTextPlain(value) || "…"}
        </span>
      )}
      {value.length > maxLength && (
        <span className="error small" role="alert">
          {t(`Höchstens ${maxLength} Zeichen (mit Formatierung).`, `At most ${maxLength} characters (including formatting).`)}
        </span>
      )}
    </>
  );
}
