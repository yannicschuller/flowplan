// Array methods for callbacks that await the database (#127, the
// asynchronous sweep): `rows.map(r => f(r))` became
// `await mapAsync(rows, async r => f(r))`. One item after the other, in
// order – inside a transaction the statements of one connection run one
// after another anyway, and side effects keep the order they had when the
// callbacks were synchronous. Where order and side effects do not matter
// and the items are independent, Promise.all(items.map(…)) is faster on
// PostgreSQL.
type Items<T> = readonly T[] | Iterable<T>;
const list = <T>(items: Items<T>): readonly T[] => (Array.isArray(items) ? items : [...items]);

export async function mapAsync<T, U>(items: Items<T>, fn: (item: T, index: number, array: readonly T[]) => U | Promise<U>): Promise<U[]> {
  const array = list(items);
  const out: U[] = [];
  for (let i = 0; i < array.length; i++) out.push(await fn(array[i], i, array));
  return out;
}
export async function forEachAsync<T>(items: Items<T>, fn: (item: T, index: number, array: readonly T[]) => unknown): Promise<void> {
  const array = list(items);
  for (let i = 0; i < array.length; i++) await fn(array[i], i, array);
}
export async function filterAsync<T>(items: Items<T>, fn: (item: T, index: number, array: readonly T[]) => unknown): Promise<T[]> {
  const array = list(items);
  const out: T[] = [];
  for (let i = 0; i < array.length; i++) if (await fn(array[i], i, array)) out.push(array[i]);
  return out;
}
export async function flatMapAsync<T, U>(
  items: Items<T>,
  fn: (item: T, index: number, array: readonly T[]) => U | readonly U[] | Promise<U | readonly U[]>,
): Promise<U[]> {
  const array = list(items);
  const out: U[] = [];
  for (let i = 0; i < array.length; i++) {
    const value = await fn(array[i], i, array);
    if (Array.isArray(value)) out.push(...(value as readonly U[]));
    else out.push(value as U);
  }
  return out;
}
export async function someAsync<T>(items: Items<T>, fn: (item: T, index: number, array: readonly T[]) => unknown): Promise<boolean> {
  const array = list(items);
  for (let i = 0; i < array.length; i++) if (await fn(array[i], i, array)) return true;
  return false;
}
export async function everyAsync<T>(items: Items<T>, fn: (item: T, index: number, array: readonly T[]) => unknown): Promise<boolean> {
  const array = list(items);
  for (let i = 0; i < array.length; i++) if (!(await fn(array[i], i, array))) return false;
  return true;
}
export async function findAsync<T>(items: Items<T>, fn: (item: T, index: number, array: readonly T[]) => unknown): Promise<T | undefined> {
  const array = list(items);
  for (let i = 0; i < array.length; i++) if (await fn(array[i], i, array)) return array[i];
  return undefined;
}
export async function findIndexAsync<T>(items: Items<T>, fn: (item: T, index: number, array: readonly T[]) => unknown): Promise<number> {
  const array = list(items);
  for (let i = 0; i < array.length; i++) if (await fn(array[i], i, array)) return i;
  return -1;
}
export async function reduceAsync<T, U>(items: Items<T>, fn: (acc: U, item: T, index: number, array: readonly T[]) => U | Promise<U>, initial: U): Promise<U> {
  const array = list(items);
  let acc = initial;
  for (let i = 0; i < array.length; i++) acc = await fn(acc, array[i], i, array);
  return acc;
}
// String.prototype.replace with a replacer that awaits: the matches are
// replaced one after the other, in order. Only for global regular
// expressions (every match) – as the callers use replace with /g.
export async function replaceAsync(
  text: string,
  pattern: RegExp,
  // The match and its groups (an unmatched group is undefined).
  fn: (match: string, ...groups: string[]) => string | Promise<string>,
): Promise<string> {
  if (!pattern.global) throw new Error("replaceAsync needs a global regular expression");
  const parts: string[] = [];
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    parts.push(text.slice(last, m.index), await fn(m[0], ...(m.slice(1) as string[])));
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return parts.join("");
}
