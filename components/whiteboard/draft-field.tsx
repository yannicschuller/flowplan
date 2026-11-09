"use client";
// Text fields of the board's side panels that edit board elements (rack
// details, timeline editor …), #187.
//
// Board changes reach React one animation frame after they are written
// (whiteboard.tsx: itemsMap.observeDeep → requestAnimationFrame →
// setItems). A plain controlled field (value={item.text} onChange={write})
// therefore renders once more with the old value right after each
// keystroke: React puts the old text back into the field, and when the
// new text arrives a frame later the caret ends up at the end – typing in
// the middle of a word jumped to the end after one character.
//
// These fields keep what is typed as their own draft while they have the
// focus; the board's value only takes over while the field is not being
// edited (a collaborator's change, undo, another element) and on leaving
// the field, when the cleaned, stored value (e.g. a normalised MAC address)
// is shown.
import { useId, useState, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";

export function useDraft(value: string, options: { keepOnBlur?: (draft: string) => boolean } = {}) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  const [seen, setSeen] = useState(value);
  // The board's value changed: shown unless the person is typing here.
  if (value !== seen) {
    setSeen(value);
    if (!focused) setDraft(value);
  }
  return {
    draft,
    setDraft,
    focused,
    bind: {
      onFocus: () => setFocused(true),
      onBlur: () => {
        setFocused(false);
        if (!options.keepOnBlur?.(draft)) setDraft(value);
      },
    },
  };
}

type Common = {
  value: string;
  // Called with every change that passes `validate`.
  onValue: (value: string) => void;
  // An error message for a draft that cannot be saved (shown once the
  // field is left; the draft stays so it can be corrected).
  validate?: (draft: string) => string | null;
  hint?: ReactNode;
};
type InputProps = Common & Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "defaultValue" | "onChange">;
type AreaProps = Common & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "defaultValue" | "onChange">;

function useField({ value, onValue, validate }: Common, onFocus?: (e: never) => void, onBlur?: (e: never) => void) {
  const id = useId();
  const state = useDraft(value, { keepOnBlur: (draft) => !!validate?.(draft) });
  const error = validate ? validate(state.draft) : null;
  const shown = error && !state.focused ? error : null;
  return {
    shown,
    errorId: `${id}-error`,
    props: {
      value: state.draft,
      "aria-invalid": shown ? (true as const) : undefined,
      "aria-describedby": shown ? `${id}-error` : undefined,
      onChange: (e: { target: { value: string } }) => {
        state.setDraft(e.target.value);
        if (!validate?.(e.target.value)) onValue(e.target.value);
      },
      onFocus: (e: never) => {
        state.bind.onFocus();
        onFocus?.(e);
      },
      onBlur: (e: never) => {
        state.bind.onBlur();
        onBlur?.(e);
      },
    },
  };
}
const ErrorText = ({ id, text }: { id: string; text: string | null }) =>
  text ? (
    <small id={id} className="wb-field-error" role="alert">
      {text}
    </small>
  ) : null;

export function DraftInput({ value, onValue, validate, hint, onFocus, onBlur, ...rest }: InputProps) {
  const field = useField({ value, onValue, validate }, onFocus as never, onBlur as never);
  return (
    <>
      <input {...rest} {...field.props} />
      <ErrorText id={field.errorId} text={field.shown} />
      {!field.shown && hint}
    </>
  );
}
export function DraftTextarea({ value, onValue, validate, hint, onFocus, onBlur, ...rest }: AreaProps) {
  const field = useField({ value, onValue, validate }, onFocus as never, onBlur as never);
  return (
    <>
      <textarea {...rest} {...field.props} />
      <ErrorText id={field.errorId} text={field.shown} />
      {!field.shown && hint}
    </>
  );
}
