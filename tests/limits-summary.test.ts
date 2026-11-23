// Settings → Speicher & KI (lib/limits-summary.ts): the tile's texts, the
// source label, the AI states and the notice at 80 % / 100 % with its
// dismissal, plus the old addresses that lead to the page.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aiPeriodKey,
  aiState,
  aiSummary,
  dismissNotice,
  instanceCeiling,
  levelOf,
  limitNotices,
  parseNoticeMemory,
  storageSource,
  storageSummary,
  storageText,
  type MyLimits,
  type NoticeMemory,
} from "../lib/limits-summary";
import { parseSettingsHash, findSection, SETTINGS_SECTIONS } from "../lib/settings-sections";
import type { AiStatus } from "../lib/ai/features";
import type { QuotaStatus } from "../lib/ai/quota-shared";

const de = (d: string) => d;
const en = (_: string, e: string) => e;
const GB = 1024 ** 3;
const MB = 1024 ** 2;

const limits = (over: Partial<MyLimits> = {}): MyLimits => ({ storageMb: 25 * 1024, workspaces: 3, uploadMb: 10, usedBytes: 4.2 * GB, ownedWorkspaces: 1, groupNames: {}, ...over });

test("storage: one unit, decimals below ten, unlimited", () => {
  assert.equal(storageText(4.2 * GB, 25 * 1024, de, "de-DE"), "4,2 von 25 GB");
  assert.equal(storageText(4.2 * GB, 25 * 1024, en, "en-US"), "4.2 of 25 GB");
  assert.equal(storageText(12.4 * GB, 25 * 1024, de, "de-DE"), "12 von 25 GB");
  // A little in a large limit: in MB.
  assert.equal(storageText(3 * MB, 25 * 1024, de, "de-DE"), "3 MB von 25 GB");
  assert.equal(storageText(0, 200, de, "de-DE"), "0 von 200 MB");
  // Not whole gigabytes: MB.
  assert.equal(storageText(350 * MB, 1500, en, "en-US"), "350 of 1,500 MB");
  assert.equal(storageText(4.2 * GB, 0, de, "de-DE"), "4,2 GB · unbegrenzt");
  assert.equal(storageText(20 * MB, 0, en, "en-US"), "20 MB · unlimited");
});

test("storage: share and level", () => {
  assert.equal(storageSummary(limits(), de, "de-DE").share?.toFixed(3), (4.2 / 25).toFixed(3));
  assert.equal(storageSummary(limits(), de, "de-DE").level, 0);
  assert.equal(storageSummary(limits({ usedBytes: 20 * GB }), de, "de-DE").level, 80);
  assert.equal(storageSummary(limits({ usedBytes: 26 * GB }), de, "de-DE").share, 1);
  assert.equal(storageSummary(limits({ usedBytes: 26 * GB }), de, "de-DE").level, 100);
  assert.deepEqual([storageSummary(limits({ storageMb: 0 }), de, "de-DE").share, storageSummary(limits({ storageMb: 0 }), de, "de-DE").level], [null, 0]);
  assert.equal(levelOf(0.79), 0);
  assert.equal(levelOf(0.8), 80);
  assert.equal(levelOf(0.7, 70), 80);
  assert.equal(levelOf(null), 0);
});

test("storage: where it comes from", () => {
  assert.equal(storageSource(limits(), de), "Standard");
  assert.equal(storageSource(limits({ sources: { storageMb: { from: "default", group: null } } as MyLimits["sources"] }), en), "Default");
  assert.equal(storageSource(limits({ sources: { storageMb: { from: "user", group: null } } as MyLimits["sources"] }), de), "Für dich festgelegt");
  const plus = { storageMb: { from: "group", group: "dir:Flowplan Plus" } } as MyLimits["sources"];
  assert.equal(storageSource(limits({ sources: plus, groupNames: { "dir:Flowplan Plus": "Flowplan Plus" } }), de), "Flowplan Plus");
  const addon = { storageMb: { from: "group", group: "dir:Flowplan Plus", base: 25600, addons: [{ group: "dir:+50", mb: 51200 }] } } as MyLimits["sources"];
  assert.equal(storageSource(limits({ sources: addon, groupNames: { "dir:Flowplan Plus": "Flowplan Plus", "dir:+50": "Flowplan +50 GB" } }), de), "Flowplan Plus + Flowplan +50 GB");
  assert.equal(storageSource(limits({ sources: plus }), de), "eine deiner Gruppen");
  assert.equal(storageSource(limits({ admin: true }), de), "Administrator");
});

const ai = (over: Partial<AiStatus> = {}): AiStatus =>
  ({ enabled: true, features: { ask: { ok: true } }, provider: { kind: "openai", model: "m", host: "h", source: "instance", local: false }, userProviders: false, scope: "all", excludedPages: [], device: null, ...over }) as AiStatus;
const quota = (over: Partial<QuotaStatus> = {}): QuotaStatus => ({
  applies: true,
  unit: "tokens",
  currency: "EUR",
  warnAt: 80,
  timeZone: "UTC",
  exempt: false,
  low: false,
  blocked: false,
  periods: [{ level: "person", period: "month", limit: 1000, used: 340, left: 660, resetAt: Date.UTC(2026, 11, 1) }],
  ...over,
});

test("AI: states", () => {
  assert.equal(aiState(undefined, null), "none");
  // The instance has no AI: no figure.
  assert.equal(aiState(ai({ enabled: false, provider: null, features: { ask: { ok: false, reason: "no-provider" } } as AiStatus["features"] }), null), "none");
  assert.equal(aiState(ai({ enabled: false, provider: null, features: { ask: { ok: false, reason: "off" } } as AiStatus["features"] }), null), "none");
  // Switched off for the person.
  assert.equal(aiState(ai({ enabled: false, features: { ask: { ok: false, reason: "user-off" } } as AiStatus["features"] }), null), "off");
  assert.equal(aiState(ai({ enabled: false, features: { ask: { ok: false, reason: "not-allowed" } } as AiStatus["features"] }), null), "off");
  assert.equal(aiState(ai({ provider: { kind: "openai", model: "x", host: "h", source: "user", local: false } }), null), "own");
  assert.equal(aiState(ai(), quota({ applies: false, periods: [] })), "unlimited");
  assert.equal(aiState(ai(), quota({ exempt: true })), "unlimited");
  assert.equal(aiState(ai(), quota()), "quota");
});

test("AI: texts with the period, unlimited and off", () => {
  assert.equal(aiSummary(ai(), quota(), de, "de-DE").text, "340 von 1.000 Tokens diesen Monat");
  assert.equal(aiSummary(ai(), quota(), en, "en-US").text, "340 of 1,000 tokens this month");
  const cost = quota({ unit: "cost", periods: [{ level: "person", period: "day", limit: 5, used: 4.5, left: 0.5, resetAt: 1 }] });
  assert.equal(aiSummary(ai(), cost, de, "de-DE").text.replace(/\u00a0/g, " "), "4,50 € von 5,00 € heute");
  assert.equal(aiSummary(ai(), cost, de, "de-DE").level, 80);
  assert.equal(aiSummary(ai(), quota({ periods: [] }), de, "de-DE").text, "unbegrenzt");
  assert.equal(aiSummary(ai({ enabled: false, features: { ask: { ok: false, reason: "user-off" } } as AiStatus["features"] }), null, de, "de-DE").text, "KI aus");
  assert.equal(aiSummary(undefined, null, de, "de-DE").state, "none");
  // The person's tightest period, not the instance's ceiling.
  const two = quota({
    periods: [
      { level: "person", period: "day", limit: 100, used: 10, left: 90, resetAt: 1 },
      { level: "person", period: "month", limit: 1000, used: 900, left: 100, resetAt: 2 },
      { level: "instance", period: "month", limit: 10, used: 10, left: 0, resetAt: 2 },
    ],
  });
  assert.equal(aiSummary(ai(), two, de, "de-DE").period?.period, "month");
  assert.equal(aiSummary(ai(), two, de, "de-DE").period?.level, "person");
  // The ceiling shows only where it bites.
  assert.equal(instanceCeiling(two)?.level, "instance");
  assert.equal(instanceCeiling(quota()), null);
});

test("notices: once per level, storage again after dropping below", () => {
  let memory: NoticeMemory = {};
  const at = (storage: 0 | 80 | 100) => ({ storage, ai: null });
  assert.deepEqual(limitNotices(at(0), memory).show, []);
  assert.deepEqual(limitNotices(at(80), memory).show, ["storage"]);
  memory = dismissNotice(at(80), memory, "storage");
  assert.deepEqual(memory, { storage: 80 });
  assert.deepEqual(limitNotices(at(80), memory).show, []);
  // 100 % comes once more.
  assert.deepEqual(limitNotices(at(100), memory).show, ["storage"]);
  memory = dismissNotice(at(100), memory, "storage");
  assert.deepEqual(limitNotices(at(100), memory).show, []);
  // Back to 80 %: no new notice (80 % was seen).
  memory = limitNotices(at(80), memory).memory;
  assert.deepEqual(memory, { storage: 80 });
  assert.deepEqual(limitNotices(at(80), memory).show, []);
  // Below 80 % and up again: it comes back.
  memory = limitNotices(at(0), memory).memory;
  assert.deepEqual(memory, {});
  assert.deepEqual(limitNotices(at(80), memory).show, ["storage"]);
});

test("notices: AI once per period and level", () => {
  const month = { period: "month" as const, resetAt: Date.UTC(2026, 11, 1) };
  const next = { period: "month" as const, resetAt: Date.UTC(2027, 0, 1) };
  const at = (level: 0 | 80 | 100, p = month) => ({ storage: 0 as const, ai: { level, key: aiPeriodKey(p) } });
  let memory: NoticeMemory = {};
  assert.deepEqual(limitNotices(at(80), memory).show, ["ai"]);
  memory = dismissNotice(at(80), memory, "ai");
  assert.deepEqual(limitNotices(at(80), memory).show, []);
  assert.deepEqual(limitNotices(at(100), memory).show, ["ai"]);
  memory = dismissNotice(at(100), memory, "ai");
  assert.deepEqual(limitNotices(at(100), memory).show, []);
  // Still loading: the memory stays.
  assert.deepEqual(limitNotices({ storage: 0 }, memory).memory, memory);
  // The next period starts afresh.
  assert.deepEqual(limitNotices(at(0, next), memory).memory, {});
  assert.deepEqual(limitNotices(at(80, next), memory).show, ["ai"]);
  // Both at once, closed one by one.
  const both = { storage: 80 as const, ai: { level: 80 as const, key: aiPeriodKey(month) } };
  assert.deepEqual(limitNotices(both, {}).show, ["storage", "ai"]);
  assert.deepEqual(limitNotices(both, dismissNotice(both, {}, "ai")).show, ["storage"]);
});

test("notices: the stored memory is checked", () => {
  assert.deepEqual(parseNoticeMemory(null), {});
  assert.deepEqual(parseNoticeMemory("nope"), {});
  assert.deepEqual(parseNoticeMemory(JSON.stringify({ storage: 80, ai: { key: "month:1", level: 100 } })), { storage: 80, ai: { key: "month:1", level: 100 } });
  assert.deepEqual(parseNoticeMemory(JSON.stringify({ storage: 50, ai: { key: 1, level: 80 } })), {});
});

test("Speicher & KI: first in the personal group, for beginners, and the old places lead there", () => {
  const personal = SETTINGS_SECTIONS.filter((s) => s.area === "settings" && s.group === "personal");
  assert.equal(personal[0].id, "usage");
  assert.equal(personal[0].level ?? "beginner", "beginner");
  assert.ok(findSection("settings", "usage"));
  assert.deepEqual(parseSettingsHash("#settings/account/limits"), { area: "settings", section: "usage", anchor: "storage", redirected: true });
  assert.deepEqual(parseSettingsHash("#settings/ai/quota"), { area: "settings", section: "usage", anchor: "ai", redirected: true });
  // Other anchors stay where they are.
  assert.deepEqual(parseSettingsHash("#settings/account/passkeys"), { area: "settings", section: "account", anchor: "passkeys", redirected: false });
  // No entry of another section points to the old places.
  for (const s of SETTINGS_SECTIONS) for (const e of s.entries || []) assert.ok(!(s.id === "account" && e.anchor === "limits") && !(s.id === "ai" && e.anchor === "quota"), `${s.id}/${e.anchor}`);
});
