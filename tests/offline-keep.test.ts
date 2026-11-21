import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BROWSER_BUDGET,
  DESKTOP_BUDGET,
  GB,
  MB,
  budgetChoices,
  defaultBudget,
  isKept,
  keptPageIds,
  offlineBudget,
  planRelease,
  planRoom,
  planTrim,
  rowPage,
  toggleKeep,
  usageBySpace,
  type BudgetEntry,
} from "../lib/offline-keep";

const id = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const [s1, s2, s3] = ["space-1", "space-2", "space-secret"];
const [p1, p2, p3, p4, p5] = [1, 2, 3, 4, 5].map(id);
// s1: p1 › p2 › p3 (a database), p4 at the top; s2: p5; s3 is encrypted.
const pages = [
  { id: p1, space_id: s1, parent_id: null },
  { id: p2, space_id: s1, parent_id: p1 },
  { id: p3, space_id: s1, parent_id: p2 },
  { id: p4, space_id: s1, parent_id: null },
  { id: p5, space_id: s2, parent_id: null },
  { id: id(6), space_id: s3, parent_id: null },
];
const [r1, r2] = [7, 8].map(id);
const [f1, f2, f3] = ["a", "b", "c"].map((c) => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`);

test("budget: 2 GB in the desktop app, 200 MB in browsers, a chosen one where it is offered", () => {
  assert.equal(defaultBudget("desktop"), DESKTOP_BUDGET);
  assert.equal(DESKTOP_BUDGET, 2 * GB);
  assert.equal(defaultBudget("browser"), BROWSER_BUDGET);
  assert.equal(BROWSER_BUDGET, 200 * MB);
  assert.deepEqual(budgetChoices("desktop"), [200 * MB, GB, 2 * GB, 5 * GB, 10 * GB]);
  assert.deepEqual(budgetChoices("browser"), budgetChoices("desktop"));
  // The iPhone and iPad app keeps at most 2 GB per profile for everything.
  assert.deepEqual(budgetChoices("app"), [200 * MB, GB]);
  assert.equal(offlineBudget(undefined, "desktop"), 2 * GB);
  assert.equal(offlineBudget(5 * GB, "browser"), 5 * GB);
  assert.equal(offlineBudget(5 * GB, "app"), 200 * MB, "not offered in the app");
  assert.equal(offlineBudget(123, "desktop"), 2 * GB, "only the listed choices");
  assert.equal(offlineBudget("1073741824", "desktop"), 2 * GB);
});

test("keep: a space, or a page with everything below it; never an encrypted space", () => {
  assert.deepEqual([...keptPageIds([{ kind: "space", id: s1 }], pages)].sort(), [p1, p2, p3, p4].sort());
  assert.deepEqual([...keptPageIds([{ kind: "page", id: p2.toUpperCase() }], pages)].sort(), [p2, p3].sort());
  assert.deepEqual([...keptPageIds([{ kind: "page", id: p3 }, { kind: "page", id: p5 }], pages)].sort(), [p3, p5].sort());
  const encrypted = new Set([s3]);
  assert.deepEqual([...keptPageIds([{ kind: "space", id: s3 }, { kind: "page", id: id(6) }], pages, encrypted)], []);
  // A page no longer readable (gone from the tree) keeps nothing.
  assert.deepEqual([...keptPageIds([{ kind: "page", id: id(9) }], pages)], []);
  assert.deepEqual([...keptPageIds(undefined, pages)], []);
});

test("keep: switching off remembers the item, so the next refresh frees it", () => {
  let state = toggleKeep({}, { kind: "space", id: s1 }, true);
  assert.deepEqual(state, { keep: [{ kind: "space", id: s1 }], released: [] });
  assert.ok(isKept(state.keep, { kind: "space", id: s1 }));
  assert.ok(!isKept(state.keep, { kind: "page", id: s1 }));
  state = toggleKeep(state, { kind: "page", id: p3 }, true);
  state = toggleKeep(state, { kind: "space", id: s1 }, false);
  assert.deepEqual(state, { keep: [{ kind: "page", id: p3 }], released: [{ kind: "space", id: s1 }] });
  // On again before a refresh: nothing to free.
  assert.deepEqual(toggleKeep(state, { kind: "space", id: s1 }, true).released, []);
  // Off for something never kept: nothing to free either.
  assert.deepEqual(toggleKeep(state, { kind: "page", id: p5 }, false).released, [{ kind: "space", id: s1 }]);
});

const entry = (key: string, size: number, kept = false, locked = false): BudgetEntry => ({ key, size, kept, locked });
test("room: kept items come first within the budget", () => {
  const entries = [entry("/a", 40), entry("/b", 30), entry("/k", 20, true), entry("/l", 50, false, true)];
  const used = 140;
  // Fits as it is.
  assert.deepEqual(planRoom({ entries, used, budget: 200, size: 60, kept: false }), { fits: true, drop: [] });
  // Full: nothing more outside kept items …
  assert.deepEqual(planRoom({ entries, used, budget: 150, size: 30, kept: false }), { fits: false, drop: [] });
  // … but a kept one takes the room of the largest entries outside kept items, never a locked one.
  assert.deepEqual(planRoom({ entries, used, budget: 150, size: 30, kept: true }), { fits: true, drop: ["/a"] });
  assert.deepEqual(planRoom({ entries, used, budget: 150, size: 70, kept: true }), { fits: true, drop: ["/a", "/b"] });
  // Not even then: nothing is dropped in vain.
  assert.deepEqual(planRoom({ entries, used, budget: 150, size: 100, kept: true }), { fits: false, drop: [] });
});

test("trim: a lowered budget drops outside kept items first, locked entries never", () => {
  const entries = [entry("/a", 40), entry("/b", 30), entry("/k", 20, true), entry("/k2", 60, true), entry("/l", 50, false, true)];
  assert.deepEqual(planTrim(entries, 200), []);
  assert.deepEqual(planTrim(entries, 170), ["/a"]);
  assert.deepEqual(planTrim(entries, 130), ["/a", "/b"]);
  // Then kept ones, largest first; the locked one stays even over the budget.
  assert.deepEqual(planTrim(entries, 80), ["/a", "/b", "/k2"]);
  assert.deepEqual(planTrim(entries, 0), ["/a", "/b", "/k2", "/k"]);
});

test("release: what only a switched-off item kept goes, nothing that is still kept, locked or shared", () => {
  const keys = [
    `/api/pages/${p3}`,
    `/api/pages/${p3}/rows/${r1}`,
    `/api/pages/${p5}/rows/${r2}`,
    `/api/files/${f1}`,
    `/api/files/${f2}?download=1`,
    `/api/files/${f3}`,
  ];
  const referrers = new Map([
    [f1, new Set([p3])],
    [f2, new Set([p3, p5])],
    [f3, new Set(["cards"])],
  ]);
  const released = new Set([p3]);
  assert.deepEqual(planRelease({ keys, released, kept: new Set(), referrers }), [`/api/pages/${p3}/rows/${r1}`, `/api/files/${f1}`]);
  // Still kept through another item (its space): nothing goes.
  assert.deepEqual(planRelease({ keys, released, kept: new Set([p3]), referrers }), []);
  // A record with changes not sent yet stays.
  assert.deepEqual(planRelease({ keys, released, kept: new Set(), referrers, locked: (key) => key.includes(r1) }), [`/api/files/${f1}`]);
});

test("storage per space: pages, records and files", () => {
  const spaceOf = new Map([
    [p3, s1],
    [p5, s2],
  ]);
  const sizes: [string, number][] = [
    ["/", 5000],
    [`/api/bootstrap?workspace=${id(9)}`, 3000],
    [`/api/pages/${p3}`, 100],
    [`/api/pages/${p3}/study?offline=1`, 10],
    [`/api/pages/${p3}/rows/${r1}`, 20],
    [`/api/pages/${p5}/rows/${r2}`, 30],
    [`/api/files/${f1}`, 1000],
    [`/api/files/${f2}?download=1`, 2000],
    [`/api/files/${f3}`, 4000],
  ];
  const fileOwner = new Map([
    [f1, p3],
    [f2, p5],
  ]);
  assert.deepEqual(usageBySpace({ sizes, spaceOf, fileOwner }), {
    [s1]: { pages: 110, records: 20, files: 1000 },
    [s2]: { pages: 0, records: 30, files: 2000 },
  });
  assert.equal(rowPage(`/api/pages/${p3.toUpperCase()}/rows/${r1}`), p3);
  assert.equal(rowPage(`/api/pages/${p3}`), null);
});
