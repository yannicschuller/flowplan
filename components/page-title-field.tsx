"use client";
// The title field above a page: one line of text, typed like an <input>,
// that wraps onto further lines where the screen is too narrow for it
// instead of being cut off – a journal day's "Dienstag, 10. November 2026"
// is wider than a phone. Wider windows keep it on one line
// (app/globals.css, `.page-title`). Enter adds no line break and a pasted
// one becomes a space.
import { useLayoutEffect, useRef, type TextareaHTMLAttributes } from "react";

export function PageTitleField(props: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "rows" | "value">) {
  const { onKeyDown, onInput, ...rest } = props;
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // As high as its lines (`field-sizing` is not everywhere yet).
    const fit = () => {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    };
    fit();
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fit();
    });
    observer.observe(el);
    el.addEventListener("input", fit);
    // Web fonts change the width of the text.
    void document.fonts?.ready.then(fit);
    return () => {
      observer.disconnect();
      el.removeEventListener("input", fit);
    };
  }, []);
  return (
    <textarea
      ref={ref}
      rows={1}
      {...rest}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.nativeEvent.isComposing) e.preventDefault();
        onKeyDown?.(e);
      }}
      onInput={(e) => {
        const el = e.currentTarget;
        if (/[\r\n]/.test(el.value)) {
          const caret = el.selectionStart;
          el.value = el.value.replace(/\r\n?|\n/g, " ");
          el.setSelectionRange(caret, caret);
        }
        onInput?.(e);
      }}
    />
  );
}
