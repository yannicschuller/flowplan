// A synchronous renderer (HTML → Markdown, a whiteboard as SVG, sanitize
// transforms) with lookups that await the database (#127): the renderer
// runs once with lookups that note what they are asked and answer null,
// the noted lookups are resolved, and it runs again with the answers – until
// it asks nothing new (a few rounds: an answer can lead to further
// questions). The renderer must be free of side effects of its own; each
// lookup runs once per distinct arguments.
//
//   const svg = await withLookups<WhiteboardSvgContext, string>({ … }, (l) => whiteboardSvg(items, l));
type Lookup = (...args: never[]) => unknown;
// The lookups of a context `C`, each allowed to return a promise.
export type Awaitable<C> = {
  [K in keyof C]: NonNullable<C[K]> extends (...args: infer A) => infer R ? (...args: A) => R | Promise<R> : C[K];
};

export async function withLookups<C extends object, T>(lookups: Awaitable<C>, render: (sync: C) => T, rounds = 6): Promise<T> {
  const answers = new Map<string, unknown>();
  for (let round = 0; ; round++) {
    const pending: (() => Promise<void>)[] = [];
    const sync = {} as Record<string, unknown>;
    for (const [name, fn] of Object.entries(lookups)) {
      if (typeof fn !== "function") {
        sync[name] = fn;
        continue;
      }
      sync[name] = (...args: unknown[]) => {
        const key = `${name}\u0000${JSON.stringify(args)}`;
        if (answers.has(key)) return answers.get(key);
        const result = (fn as Lookup)(...(args as never[]));
        if (!(result instanceof Promise)) {
          answers.set(key, result);
          return result;
        }
        answers.set(key, null);
        // Awaited below; noted here so that a failure waiting its turn is not "unhandled".
        result.catch(() => {});
        pending.push(async () => void answers.set(key, await result));
        return null;
      };
    }
    // A pass with open questions may fail on the nulls it got: it is only
    // asked again once they are answered.
    let output: T;
    try {
      output = render(sync as C);
    } catch (error) {
      if (!pending.length) throw error;
      output = undefined as T;
    }
    if (!pending.length) return output;
    if (output instanceof Promise) output.catch(() => {});
    for (const resolve of pending) await resolve();
    if (round >= rounds) return render(sync as C);
  }
}
