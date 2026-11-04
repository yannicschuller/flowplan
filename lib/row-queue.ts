// Changes of one record run one after the other. A quick second edit (the
// title, then the next field) would otherwise carry the record's version from
// before the first save and the server would refuse it. `fresh` tells the
// task that something ran before it, so it should read the current version.
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

// The version to send: the record's current one when it moved on meanwhile.
export function currentVersion(sent: number, latest: number | undefined) {
  return typeof latest === "number" && latest > sent ? latest : sent;
}
