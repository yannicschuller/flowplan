"use client";
// Collapsible frames on the board (#455, lib/whiteboard-collapse.ts): the
// folded view the board draws, folding and unfolding (the caret before a
// frame's title, the style bar, the frames panel) and unfolding what has to
// be seen – a search hit, an element link, the slide being presented.
// People who may change the board fold frames for everyone; the others fold
// them on their own screen only.
import { useCallback, useMemo, useRef, useState } from "react";
import { CaretDown, CaretRight } from "@phosphor-icons/react";
import { useT } from "../i18n";
import { collapseMembers, foldView, foldersOf, isCollapsed, unfoldForCopy, type FoldView } from "@/lib/whiteboard-collapse";
import type { WhiteboardItem } from "@/lib/whiteboard-model";

export type FrameFolding = {
  view: FoldView;
  // The items as stored (collapsed frames at full height, hidden ones too).
  all: WhiteboardItem[];
  stored: (id: string) => WhiteboardItem | undefined;
  folded: (id: string) => boolean;
  toggle: (id: string) => void;
  // Unfolds the frames that hide the element (and the element itself when
  // it is a collapsed frame); true when something was unfolded.
  reveal: (id: string) => boolean;
  // What moves along with these elements: everything collapsed frames
  // among them hide.
  hiddenWith: (ids: Iterable<string>) => WhiteboardItem[];
  forCopy: <T extends WhiteboardItem>(selected: T[]) => WhiteboardItem[];
  onPointerDownCapture: (e: React.PointerEvent) => boolean;
};

export function useFrameFolding({
  all,
  editable,
  change,
  setProps,
}: {
  all: WhiteboardItem[];
  editable: boolean;
  change: (fn: () => void) => void;
  setProps: (id: string, props: Partial<WhiteboardItem>) => void;
}): FrameFolding {
  // This viewer's own folding: frame → shown open (true) or folded (false).
  const [own, setOwn] = useState<ReadonlyMap<string, boolean>>(new Map());
  const view = useMemo(() => foldView(all, own), [all, own]);
  const byId = useMemo(() => new Map(all.map((i) => [i.id, i])), [all]);
  const latest = useRef({ all, byId, view, editable, change, setProps });
  latest.current = { all, byId, view, editable, change, setProps };

  const setOwnState = (id: string, open: boolean | null) =>
    setOwn((before) => {
      const next = new Map(before);
      if (open === null) next.delete(id);
      else next.set(id, open);
      return next;
    });
  const toggle = useCallback((id: string) => {
    const { byId, view, editable, change, setProps, all } = latest.current;
    const frame = byId.get(id);
    if (frame?.type !== "frame") return;
    const folded = view.hidden.has(id);
    if (editable) {
      setOwnState(id, null);
      change(() => setProps(id, { collapsed: folded ? undefined : collapseMembers(frame, all) }));
    } else setOwnState(id, isCollapsed(frame) === folded ? !folded : null);
  }, []);
  const reveal = useCallback((id: string) => {
    const { byId, view, editable, change, setProps } = latest.current;
    const frames = foldersOf(id, view, byId);
    if (!frames.length) return false;
    const shared = editable ? frames.filter((f) => isCollapsed(byId.get(f))) : [];
    if (shared.length) change(() => shared.forEach((f) => setProps(f, { collapsed: undefined })));
    for (const f of frames) setOwnState(f, shared.includes(f) ? null : true);
    return true;
  }, []);
  const hiddenWith = useCallback((ids: Iterable<string>) => {
    const { byId, view } = latest.current;
    const out = new Map<string, WhiteboardItem>();
    for (const id of ids)
      for (const inner of view.hidden.get(id) || []) {
        const item = byId.get(inner);
        if (item) out.set(inner, item);
      }
    return [...out.values()];
  }, []);
  const forCopy = useCallback(<T extends WhiteboardItem>(selected: T[]) => unfoldForCopy(selected, latest.current.view, latest.current.byId), []);
  const onPointerDownCapture = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return false;
      const button = (e.target as Element | null)?.closest?.("[data-wb-frame-toggle]");
      const id = button?.closest("[data-item]")?.getAttribute("data-item");
      if (!id) return false;
      e.stopPropagation();
      e.preventDefault();
      toggle(id);
      return true;
    },
    [toggle],
  );
  return {
    view,
    all,
    stored: (id) => byId.get(id),
    folded: (id) => view.hidden.has(id),
    toggle,
    reveal,
    hiddenWith,
    forCopy,
    onPointerDownCapture,
  };
}

// "Einklappen" / "Aufklappen" in the style bar of a selected frame.
export function FoldButton({ frame, folding }: { frame: WhiteboardItem; folding: FrameFolding }) {
  const t = useT();
  const folded = folding.folded(frame.id);
  const label = folded ? t("Rahmen aufklappen", "Expand frame") : t("Rahmen einklappen", "Collapse frame");
  return (
    <button aria-label={label} title={label} aria-expanded={!folded} onClick={() => folding.toggle(frame.id)}>
      {folded ? <CaretRight size={16} /> : <CaretDown size={16} />}
    </button>
  );
}
