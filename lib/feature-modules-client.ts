import { useSyncExternalStore } from "react";
import { hiddenModulesOf, moduleShownIn, sameModules, type FeatureModule, type FeatureModulesBoot } from "./feature-modules";

// The features switched off (#378, lib/feature-modules.ts) in the browser:
// set from the bootstrap (components/workspace-app.tsx) and by the switches
// in Settings; the entry points read it.
type State = FeatureModulesBoot;
const EMPTY: State = { hidden: [], own: false, standard: [] };
const listeners = new Set<() => void>();
let current: State = EMPTY;
let primed = false;
const emit = () => listeners.forEach((listener) => listener());

export function featureModules(): State {
  return current;
}
export function hiddenModules(): FeatureModule[] {
  return current.hidden;
}
export const moduleShown = (module: FeatureModule | undefined) => moduleShownIn(current.hidden, module);

function stateOf(boot: Partial<FeatureModulesBoot> | null | undefined): State {
  return { hidden: hiddenModulesOf(boot?.hidden), own: !!boot?.own, standard: hiddenModulesOf(boot?.standard) };
}
const same = (a: State, b: State) => a.own === b.own && sameModules(a.hidden, b.hidden) && sameModules(a.standard, b.standard);

// The first bootstrap, while the app renders for the first time: taken
// without telling anyone (nothing has read it yet), so the hidden entries
// never flash up.
export function primeFeatureModules(boot: Partial<FeatureModulesBoot> | null | undefined) {
  if (primed || !boot) return;
  primed = true;
  current = stateOf(boot);
}
// A save on its way wins over a bootstrap loaded meanwhile.
let pending = 0;
export function setFeatureModulesFromServer(boot: Partial<FeatureModulesBoot> | null | undefined) {
  if (pending || !boot) return;
  primed = true;
  const next = stateOf(boot);
  if (same(next, current)) return;
  current = next;
  emit();
}
function setLocal(next: State) {
  if (same(next, current)) return;
  current = next;
  emit();
}

// The person's own choice (null: back to the instance's default): at once
// here, then on the server (profile.modules, all devices); back to the
// previous one when that fails. Saves go one after the other.
let queue: Promise<unknown> = Promise.resolve();
export function saveFeatureModules(mutate: (body: Record<string, unknown>) => Promise<unknown>, hidden: FeatureModule[] | null) {
  const before = current;
  setLocal(hidden === null ? { ...current, hidden: current.standard, own: false } : { ...current, hidden: hiddenModulesOf(hidden), own: true });
  pending++;
  const done = queue.then(() => mutate({ action: "profile.modules", hidden }));
  queue = done.catch(() => undefined);
  return done
    .catch((e) => {
      setLocal(before);
      throw e;
    })
    .finally(() => {
      pending--;
    });
}
// The instance's default changed (Administration → Instanz): whoever has no
// choice of their own sees it at once; `reset`: everyone was put on it
// ("Allen bestehenden Konten zuweisen"), this person as well.
export function setFeatureModulesStandard(standard: FeatureModule[], reset = false) {
  setLocal(current.own && !reset ? { ...current, standard } : { hidden: standard, own: false, standard });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function useFeatureModules(): State {
  return useSyncExternalStore(subscribe, featureModules, () => EMPTY);
}
export function useHiddenModules(): FeatureModule[] {
  return useFeatureModules().hidden;
}
