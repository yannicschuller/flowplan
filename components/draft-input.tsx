"use client";
import { useEffect, useRef, type InputHTMLAttributes } from "react";

// A settings field that saves what was typed on Enter, when it loses focus
// and when it unmounts while it still has focus (a panel closed with Escape
// or a click outside unmounts without a blur) – like the WIP limits (#131).
// `onCommit` gets the typed text and decides whether it is valid.
export function DraftInput({
  value,
  onCommit,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "defaultValue" | "onChange" | "onBlur"> & {
  value: string | number;
  onCommit: (text: string) => void;
}) {
  const draft = useRef<string | null>(null);
  const latest = useRef(onCommit);
  useEffect(() => {
    latest.current = onCommit;
  });
  const commit = useRef(() => {
    if (draft.current === null) return;
    const text = draft.current;
    draft.current = null;
    latest.current(text);
  }).current;
  useEffect(() => () => commit(), [commit]);
  return (
    <input
      {...props}
      defaultValue={value}
      onChange={(e) => {
        draft.current = e.target.value;
      }}
      onKeyDown={(e) => {
        props.onKeyDown?.(e);
        if (e.key !== "Enter" || e.defaultPrevented || e.nativeEvent.isComposing) return;
        e.preventDefault();
        commit();
      }}
      onBlur={commit}
    />
  );
}
