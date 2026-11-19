"use client";
// A password field with an eye button that shows or hides what was typed
// (#372). It takes the props of an <input> except `type`; a control-size
// class (components/settings-ui.tsx CONTROL) sizes the whole field, the
// eye included. The button comes right after the field in the tab order and
// says what it does and whether the text shows (aria-pressed).
import { useState, type InputHTMLAttributes, type Ref } from "react";
import { Eye, EyeSlash } from "@phosphor-icons/react";
import { useT } from "./i18n";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { ref?: Ref<HTMLInputElement> };

export function PasswordInput({ className = "", ref, ...props }: Props) {
  const t = useT();
  const [shown, setShown] = useState(false);
  const classes = className.split(/\s+/).filter(Boolean);
  const size = classes.filter((c) => c.startsWith("control-"));
  const own = classes.filter((c) => !c.startsWith("control-"));
  return (
    <span className={["password-field", ...size].join(" ")}>
      <input {...props} ref={ref} className={own.join(" ") || undefined} type={shown ? "text" : "password"} />
      <button
        type="button"
        className="password-toggle"
        aria-label={shown ? t("Zeichen verbergen", "Hide characters") : t("Zeichen anzeigen", "Show characters")}
        aria-pressed={shown}
        title={shown ? t("Zeichen verbergen", "Hide characters") : t("Zeichen anzeigen", "Show characters")}
        // Keeps the caret in the field on a mouse click.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setShown((s) => !s)}
      >
        {shown ? <EyeSlash size={18} aria-hidden /> : <Eye size={18} aria-hidden />}
      </button>
    </span>
  );
}
