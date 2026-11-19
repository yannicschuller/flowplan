// Who has the app shell's right column (lib/side-panel.ts, #392): the
// docked side panel of a record or a PDF claims it while it is open, the
// shell (components/workspace-app.tsx) gives it the column and its width.
// One panel at a time: a new claim closes the panel before it (its
// `onEvict`), as does opening "KI fragen" or the comments (`evictDock`).
// A tiny store for useSyncExternalStore, free of React.
import type { SidePanelKind } from "./side-panel";

export type DockState = { owner: string; kind: SidePanelKind; width: number; docked: boolean } | null;
type Claim = { owner: string; kind: SidePanelKind; width: number; docked: boolean; onEvict?: () => void };

let claim: Claim | null = null;
let state: DockState = null;
const listeners = new Set<() => void>();
const emit = () => {
  state = claim ? { owner: claim.owner, kind: claim.kind, width: claim.width, docked: claim.docked } : null;
  for (const listener of listeners) listener();
};

export const subscribeDock = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
export const dockState = (): DockState => state;
export const serverDockState = (): DockState => null;

// Takes the column; the panel that had it closes. Claiming again (same
// owner) only updates the width or the place.
export function claimDock(next: Claim) {
  const previous = claim;
  const same = previous?.owner === next.owner;
  claim = same ? { ...next, onEvict: next.onEvict ?? previous!.onEvict } : next;
  if (previous && !same) previous.onEvict?.();
  if (!previous || previous.owner !== next.owner || previous.width !== next.width || previous.docked !== next.docked) emit();
}
export function updateDock(owner: string, change: { width?: number; docked?: boolean; onEvict?: () => void }) {
  if (claim?.owner !== owner) return;
  const before = claim;
  claim = { ...claim, ...change };
  if (before.width !== claim.width || before.docked !== claim.docked) emit();
}
export function releaseDock(owner: string) {
  if (claim?.owner !== owner) return;
  claim = null;
  emit();
}
// Something else takes the right edge ("KI fragen", the comments).
export function evictDock() {
  const previous = claim;
  if (!previous) return;
  claim = null;
  previous.onEvict?.();
  emit();
}
