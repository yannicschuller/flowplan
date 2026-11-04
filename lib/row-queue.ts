// Changes of one record (#104) – from a table cell, a board card, the record
// dialog or the record as a page – go through one path per record: they run
// one after the other, and each carries the newest version of the record
// this tab knows. The server answers every such change with the record's
// version after it (`rowVersion`, lib/api.ts), so the next change does not
// depend on the reloaded page having arrived and been rendered yet: a quick
// second edit (the title, then the status) used to carry the version from
// before the first save and was refused as a conflict.

// Which property of a command holds the record's version: row.move and
// row.schedule carry the database's version in `version`.
const VERSION_KEYS: Record<string, "version" | "rowVersion"> = {
  "row.update": "version",
  "row.appearance": "version",
  "row.recurrence": "version",
  "row.repeat": "version",
  "row.detachOccurrence": "version",
  "row.move": "rowVersion",
  "row.schedule": "rowVersion",
};
export function rowVersionKey(body: Record<string, unknown>): "version" | "rowVersion" | null {
  const key = VERSION_KEYS[String(body.action)];
  return key && typeof body.rowId === "string" && typeof body[key] === "number" ? key : null;
}

// One task after the other per record. `fresh` tells the task that another
// one ran before it.
export function createRowQueue() {
  const tails = new Map<string, Promise<unknown>>();
  return function run<T>(rowId: string, task: (fresh: boolean) => Promise<T>): Promise<T> {
    const previous = tails.get(rowId);
    const result = previous ? previous.then(() => task(true)) : task(false);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    tails.set(rowId, tail);
    void tail.then(() => {
      if (tails.get(rowId) === tail) tails.delete(rowId);
    });
    return result;
  };
}

// The version to send: the newest of the one the change was made on, the
// one the shown data has and the one the server last answered with.
export function currentVersion(sent: number, ...known: (number | undefined)[]) {
  return known.reduce<number>((v, k) => (typeof k === "number" && k > v ? k : v), sent);
}

// The version the server answered with, if it did (not for a change that
// waits offline).
export function answeredVersion(result: unknown): number | undefined {
  const v = (result as { rowVersion?: unknown } | null)?.rowVersion;
  return typeof v === "number" && Number.isInteger(v) ? v : undefined;
}

export function createRowChanges() {
  const queue = createRowQueue();
  // Per record: the version the server answered last.
  const answered = new Map<string, number>();
  return {
    // Sends `body` once the record's earlier changes are done, with the
    // newest version known by then. `shown` reads the version of the data
    // shown right now.
    run<T>(body: Record<string, unknown>, shown: () => number | undefined, send: (body: Record<string, unknown>) => Promise<T>): Promise<T> {
      const key = rowVersionKey(body);
      if (!key) return send(body);
      const rowId = body.rowId as string;
      return queue(rowId, async () => {
        const seen = shown();
        let known = answered.get(rowId);
        // The shown data caught up (or someone else changed the record
        // since): it knows best from now on – also when the record's
        // version went back (a restored version of the database).
        if (known !== undefined && seen !== undefined && seen >= known) {
          answered.delete(rowId);
          known = undefined;
        }
        const version = currentVersion(body[key] as number, seen, known);
        const sent = version === body[key] ? body : { ...body, [key]: version };
        try {
          const result = await send(sent);
          const next = answeredVersion(result);
          if (next !== undefined) answered.set(rowId, next);
          return result;
        } catch (e) {
          // A refusal: the next change starts from the shown data again.
          answered.delete(rowId);
          throw e;
        }
      });
    },
    // For tests and callers that learn a version elsewhere.
    known: (rowId: string) => answered.get(rowId),
  };
}

// One path for the whole tab: a record open in two views (the page and a
// split pane, a linked database) still saves one change after the other.
export const rowChanges = createRowChanges();
