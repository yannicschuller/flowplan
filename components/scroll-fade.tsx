"use client";
// A horizontal scroller (table, board, view tabs) in a wrapper that shows a
// fade at the right edge while more content lies beyond it, so clipped
// columns and tabs are never mistaken for the end.
import { useEffect, useRef, type HTMLAttributes } from "react";

export function ScrollFade({ children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () =>
      el.parentElement?.classList.toggle("scroll-more", el.scrollWidth - el.clientWidth - el.scrollLeft > 1);
    const sizes = new ResizeObserver(update);
    const watch = () => {
      sizes.disconnect();
      sizes.observe(el);
      for (const child of el.children) sizes.observe(child);
      update();
    };
    const children = new MutationObserver(watch);
    children.observe(el, { childList: true });
    el.addEventListener("scroll", update, { passive: true });
    watch();
    return () => {
      el.removeEventListener("scroll", update);
      sizes.disconnect();
      children.disconnect();
    };
  }, []);
  return (
    <div className="scroll-fade">
      <div ref={ref} {...rest}>
        {children}
      </div>
    </div>
  );
}
