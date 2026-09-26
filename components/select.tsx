"use client";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { CaretDown, Check } from "@phosphor-icons/react";

type Choice = {
  value: string;
  label: string;
  disabled: boolean;
  group?: string;
};
// Drop-in replacement for <select> with a styled list. The native element
// stays in place (invisible) as the form control: it keeps the value,
// labels, forms and keyboard focus; the list only sets its value and fires
// the usual change event.
export function Select({
  className = "",
  style,
  ref,
  onKeyDown,
  ...props
}: ComponentProps<"select">) {
  const native = useRef<HTMLSelectElement | null>(null),
    list = useRef<HTMLDivElement | null>(null),
    wrapper = useRef<HTMLSpanElement | null>(null);
  const [open, setOpen] = useState(false),
    [choices, setChoices] = useState<Choice[]>([]),
    [active, setActive] = useState(0),
    [label, setLabel] = useState(""),
    [place, setPlace] = useState<{
      host: HTMLElement;
      top: number;
      left: number;
      width: number;
      up: boolean;
    } | null>(null);
  const setRefs = useCallback(
    (node: HTMLSelectElement | null) => {
      native.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );
  const read = useCallback(() => {
    const el = native.current;
    if (!el) return [];
    return [...el.options].map((o) => ({
      value: o.value,
      label: o.label || o.text,
      disabled: o.disabled,
      group:
        o.parentElement instanceof HTMLOptGroupElement
          ? o.parentElement.label
          : undefined,
    }));
  }, []);
  // The shown text follows the native value (controlled or not).
  useLayoutEffect(() => {
    const el = native.current;
    if (!el) return;
    const sync = () => {
      const option = el.options[el.selectedIndex];
      setLabel(option ? option.label || option.text : "");
    };
    sync();
    el.addEventListener("change", sync);
    const observer = new MutationObserver(sync);
    observer.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      el.removeEventListener("change", sync);
      observer.disconnect();
    };
  });
  const place_ = useCallback(() => {
    const el = wrapper.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // Inside dialogs the list stays in the dialog, so it remains usable.
    const host =
      (el.closest("[role=dialog]") as HTMLElement | null) || document.body;
    const base =
      host === document.body
        ? { top: -window.scrollY, left: -window.scrollX }
        : (() => {
            const r = host.getBoundingClientRect();
            return {
              top: r.top + host.clientTop - host.scrollTop,
              left: r.left + host.clientLeft - host.scrollLeft,
            };
          })();
    const below = window.innerHeight - rect.bottom;
    const up = below < 240 && rect.top > below;
    setPlace({
      host,
      top: (up ? rect.top - 4 : rect.bottom + 4) - base.top,
      left: rect.left - base.left,
      width: rect.width,
      up,
    });
  }, []);
  const show = useCallback(() => {
    const el = native.current;
    if (!el || el.disabled) return;
    const next = read();
    setChoices(next);
    setActive(Math.max(0, el.selectedIndex));
    place_();
    setOpen(true);
    el.focus({ preventScroll: true });
  }, [read, place_]);
  const choose = useCallback((index: number) => {
    const el = native.current,
      choice = el?.options[index];
    setOpen(false);
    if (!el || !choice || choice.disabled) return;
    el.focus({ preventScroll: true });
    if (el.selectedIndex === index) return;
    el.selectedIndex = index;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, []);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (
        !wrapper.current?.contains(e.target as Node) &&
        !list.current?.contains(e.target as Node)
      )
        setOpen(false);
    };
    const reposition = (e: Event) => {
      if (list.current?.contains(e.target as Node)) return;
      place_();
    };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", place_);
    window.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("resize", place_);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open, place_]);
  useEffect(() => {
    if (open)
      list.current
        ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
        ?.scrollIntoView({ block: "nearest" });
  }, [open, active]);
  const step = (from: number, delta: number) => {
    const all = read();
    for (let i = from + delta; i >= 0 && i < all.length; i += delta)
      if (!all[i].disabled) return i;
    return from;
  };
  const keyDown = (e: KeyboardEvent<HTMLSelectElement>) => {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    if (!open) {
      if ([" ", "Enter", "ArrowDown", "ArrowUp"].includes(e.key)) {
        e.preventDefault();
        show();
      }
      return;
    }
    if (e.key === "Escape" || e.key === "Tab") {
      if (e.key === "Escape") e.preventDefault();
      setOpen(false);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => step(a, e.key === "ArrowDown" ? 1 : -1));
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      setActive(e.key === "Home" ? step(-1, 1) : step(choices.length, -1));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      choose(active);
    } else if (e.key.length === 1) {
      const next = choices.findIndex(
        (c, i) =>
          i > active &&
          !c.disabled &&
          c.label.toLocaleLowerCase("de").startsWith(e.key.toLocaleLowerCase("de")),
      );
      const first = choices.findIndex(
        (c) =>
          !c.disabled &&
          c.label.toLocaleLowerCase("de").startsWith(e.key.toLocaleLowerCase("de")),
      );
      if (next >= 0 || first >= 0) {
        e.preventDefault();
        setActive(next >= 0 ? next : first);
      }
    }
  };
  return (
    <span
      ref={wrapper}
      className={`fp-select${props.disabled ? " disabled" : ""}${open ? " open" : ""} ${className}`}
      style={style}
      onPointerDown={(e) => {
        // Events from the list arrive here through the portal.
        if (e.button !== 0 || list.current?.contains(e.target as Node)) return;
        // Touch: the system picker opens anyway (iOS, Android); showing the
        // styled list as well would open two lists at once.
        if (e.pointerType === "touch" || e.pointerType === "pen") {
          // Phones tap the native select itself (see globals.css); on touch
          // screens with a mouse as main pointer it is not hit directly.
          const el = native.current;
          if (el && e.target !== el && !el.disabled)
            try {
              el.showPicker();
            } catch {
              el.focus();
            }
          return;
        }
        e.preventDefault();
        if (open) setOpen(false);
        else show();
      }}
    >
      <select
        {...props}
        ref={setRefs}
        className="fp-select-native"
        onKeyDown={keyDown}
        onBlur={(e) => {
          props.onBlur?.(e);
          if (!list.current?.contains(e.relatedTarget as Node)) setOpen(false);
        }}
      />
      <span className="fp-select-value" aria-hidden="true">
        {label || " "}
      </span>
      <CaretDown className="fp-select-caret" size={13} aria-hidden="true" />
      {open &&
        place &&
        createPortal(
          <div
            ref={list}
            className={`fp-select-list${place.up ? " up" : ""}`}
            style={{
              top: place.top,
              left: place.left,
              minWidth: place.width,
            }}
            aria-hidden="true"
            onPointerDown={(e) => e.preventDefault()}
          >
            {choices.map((c, i) => (
              <div key={`${i}:${c.value}`}>
                {c.group && c.group !== choices[i - 1]?.group && (
                  <div className="fp-select-group">{c.group}</div>
                )}
                <div
                  data-index={i}
                  className={`fp-select-option${i === active ? " active" : ""}${c.disabled ? " disabled" : ""}${native.current?.selectedIndex === i ? " selected" : ""}`}
                  onPointerEnter={() => !c.disabled && setActive(i)}
                  onClick={() => choose(i)}
                >
                  <span>{c.label || " "}</span>
                  {native.current?.selectedIndex === i && <Check size={14} />}
                </div>
              </div>
            ))}
          </div>,
          place.host,
        )}
    </span>
  );
}
