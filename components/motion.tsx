"use client";
// React parts of the motion helpers (lib/motion.ts): content that opens and
// closes with a height animation, items that leave with a short fade, and a
// cross-fade between two states of a small label.
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { DURATION, EASE_OUT, motionAllowed, prefersReducedMotion } from "@/lib/motion";

/**
 * Children that unfold and fold (height and opacity) instead of appearing
 * and vanishing. While folding, the last open content stays rendered; the
 * first render and changes made by typing (a filter) do not animate.
 */
export function Collapse({
  open,
  children,
  className,
}: {
  open: boolean;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const kept = useRef<ReactNode>(children);
  if (open) kept.current = children;
  const [closing, setClosing] = useState(false);
  const [was, setWas] = useState(open);
  if (was !== open) {
    setWas(open);
    setClosing(!open && motionAllowed());
  }
  // The state the last run of the effect saw: only a real change animates,
  // not the first render nor a replay of the effect (Strict Mode, a subtree
  // shown again) while nothing changed.
  const shown = useRef<boolean | null>(null);
  useLayoutEffect(() => {
    const before = shown.current;
    shown.current = open;
    if (before === null || (before === open && !closing)) return;
    const el = ref.current;
    if (!el || typeof el.animate !== "function") return;
    if (open) {
      if (!motionAllowed()) return;
      const height = el.scrollHeight;
      el.style.overflow = "clip";
      el.animate(
        [
          { height: "0px", opacity: 0 },
          { height: `${height}px`, opacity: 1 },
        ],
        { duration: DURATION.base, easing: EASE_OUT },
      )
        .finished.catch(() => {})
        .then(() => (el.style.overflow = ""));
    } else if (closing) {
      el.style.overflow = "clip";
      const animation = el.animate(
        [
          { height: `${el.offsetHeight}px`, opacity: 1 },
          { height: "0px", opacity: 0 },
        ],
        { duration: DURATION.base, easing: EASE_OUT, fill: "forwards" },
      );
      animation.finished.then(
        () => setClosing(false),
        () => {},
      );
      return () => animation.cancel();
    }
  }, [open, closing]);
  if (!open && !closing) return null;
  return (
    <div ref={ref} className={className}>
      {open ? children : kept.current}
    </div>
  );
}

/**
 * Keeps items that disappeared from `items` for `ms` with `leaving: true`,
 * so they can fade out. Without motion they go at once.
 */
export function useLeaving<T>(items: T[], key: (item: T) => string, ms: number = DURATION.base) {
  const [gone, setGone] = useState<{ item: T; index: number; at: number }[]>([]);
  const previous = useRef(items);
  // The order last rendered (ghosts included) before `items` changed: a
  // leaving item keeps its place in it, also when several leave in a row.
  const keys = items.map(key).join("\n");
  const rendered = useRef<string[]>([]),
    lastKeys = useRef(keys),
    order = useRef<string[]>([]);
  if (lastKeys.current !== keys) {
    lastKeys.current = keys;
    order.current = rendered.current;
  }
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = items;
    if (prefersReducedMotion()) return;
    const now = new Set(items.map(key));
    const at = Date.now();
    const left = before
      .map((item, index) => {
        const place = order.current.indexOf(key(item));
        return { item, index: place < 0 ? index : place, at };
      })
      .filter(({ item }) => !now.has(key(item)));
    if (!left.length) return;
    const leaving = new Set(left.map((l) => key(l.item)));
    setGone((list) => [...list.filter((g) => !now.has(key(g.item)) && !leaving.has(key(g.item))), ...left]);
    // One timer per batch; each purges every ghost whose time is up, so a
    // batch never outlives its timer because a later one started.
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setGone((list) => list.filter((g) => Date.now() - g.at < ms));
    }, ms);
    timers.current.add(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys]);
  useLayoutEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, []);
  const present = new Set(items.map(key));
  const result: { item: T; leaving: boolean }[] = items.map((item) => ({ item, leaving: false }));
  for (const g of [...gone].sort((a, b) => a.index - b.index))
    if (!present.has(key(g.item)))
      result.splice(Math.min(g.index, result.length), 0, { item: g.item, leaving: true });
  rendered.current = result.map((r) => key(r.item));
  return result;
}

/**
 * A small label that cross-fades when `value` changes: the old content
 * fades out while the new fades in, in the same place.
 */
export function CrossFade({ value, children, className }: { value: string; children: ReactNode; className?: string }) {
  const [shown, setShown] = useState<{ value: string; node: ReactNode }[]>([{ value, node: children }]);
  if (shown[shown.length - 1].value !== value) {
    setShown([...(prefersReducedMotion() ? [] : shown.slice(-1)), { value, node: children }]);
  }
  useLayoutEffect(() => {
    if (shown.length < 2) return;
    const timer = setTimeout(() => setShown((list) => list.slice(-1)), DURATION.base);
    return () => clearTimeout(timer);
  }, [shown]);
  const current = shown[shown.length - 1];
  return (
    <span className={`cross-fade${className ? ` ${className}` : ""}`}>
      {shown.map((s) =>
        s === current ? (
          <span key={s.value} className={shown.length > 1 ? "cross-fade-in" : undefined}>
            {s.value === value ? children : s.node}
          </span>
        ) : (
          <span key={s.value} className="cross-fade-out" aria-hidden="true">
            {s.node}
          </span>
        ),
      )}
    </span>
  );
}
