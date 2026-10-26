// Optimistic changes: what someone does shows at once, the request goes out
// in the background, and a refusal of the server puts the old state back
// (the caller shows the server's message).
//
//   optimistic({ apply, commit, rollback })  – one change by hand: apply()
//     changes the local state, commit() sends it, rollback() undoes apply()
//     when commit() fails. With a `key` a newer change of the same thing
//     wins: an older one that fails afterwards does not roll back over it.
//   createOverlays()                         – changes as layers over the
//     state the server sent last (components/workspace-app.tsx): a layer
//     stays while its request runs and is dropped afterwards – the reloaded
//     state then shows the result, or the old value comes back by itself.
//     Several layers at once stack in the order they were made, so
//     concurrent changes never undo each other.
//
// Versions stay the server's business: the request carries the version it
// was made on, a conflict (409) is a failure like any other, and the layer or
// the rollback takes the change back.

export type OptimisticOptions<T> = {
  apply: () => void;
  commit: () => Promise<T>;
  rollback: () => void;
  // Changes of the same thing (a record's cell, a page's title …).
  key?: string;
  // After a failed commit (and its rollback): show the server's message.
  onError?: (error: unknown) => void;
};

const latest = new Map<string, number>();
let sequence = 0;

// Resolves with commit()'s result, or undefined when it failed (then the
// error went to onError, or is thrown when there is none).
export async function optimistic<T>(options: OptimisticOptions<T>): Promise<T | undefined> {
  const turn = ++sequence;
  if (options.key) latest.set(options.key, turn);
  options.apply();
  try {
    return await options.commit();
  } catch (error) {
    // A newer change of the same thing is on screen: it stays (its own
    // request decides about it).
    const superseded = options.key !== undefined && latest.get(options.key) !== turn;
    if (!superseded) options.rollback();
    if (options.onError) options.onError(error);
    else throw error;
    return undefined;
  } finally {
    if (options.key && latest.get(options.key) === turn) latest.delete(options.key);
  }
}

// ---------------------------------------------------------------- overlays
export type Overlay<S> = { id: number; apply: (state: S) => S };

export function applyOverlays<S>(state: S, overlays: readonly Overlay<S>[]): S {
  let next = state;
  for (const overlay of overlays) {
    try {
      next = overlay.apply(next);
    } catch {
      // A layer that no longer fits (the page closed, the record is gone)
      // shows nothing instead of breaking the view.
    }
  }
  return next;
}

export function createOverlays<S>() {
  let list: Overlay<S>[] = [];
  let next = 0;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((listener) => listener());
  return {
    add(apply: (state: S) => S) {
      const overlay = { id: ++next, apply };
      list = [...list, overlay];
      emit();
      return () => {
        if (!list.includes(overlay)) return;
        list = list.filter((o) => o !== overlay);
        emit();
      };
    },
    list: () => list,
    view: (state: S) => applyOverlays(state, list),
    clear() {
      if (!list.length) return;
      list = [];
      emit();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

// Runs a change as a layer: shown while commit() runs (and settle() – e.g.
// the reload that brings the stored state – finishes), dropped afterwards.
export async function withOverlay<S, T>(
  overlays: ReturnType<typeof createOverlays<S>>,
  apply: ((state: S) => S) | null,
  commit: () => Promise<T>,
): Promise<T> {
  const remove = apply ? overlays.add(apply) : () => {};
  try {
    return await commit();
  } finally {
    remove();
  }
}
