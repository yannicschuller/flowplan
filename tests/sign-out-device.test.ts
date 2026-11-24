// Signing out on this device (#501, #505, components/sign-out.ts): every
// way out removes the offline copy and what the tab keeps of the person,
// the server answers with Clear-Site-Data: "cache" (never "storage", which
// would wipe changes made offline that are not sent yet), and notebook
// recordings left on a shared device are offered only to their account.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = (path: string) => readFileSync(join(import.meta.dirname, "..", path), "utf8");
const block = (text: string, marker: string, length: number) => {
  const at = text.indexOf(marker);
  assert.ok(at >= 0, marker);
  return text.slice(at, at + length);
};

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
}

test("the central step removes the offline copy and the tab's keys of the person", () => {
  const step = source("components/sign-out.ts");
  assert.match(step, /export async function clearAccountData\(\) \{\s*await disableOffline\(\)[^\n]*\n\s*clearAppCache\(\);/);
  // Nothing that holds changes not sent yet is dropped here.
  for (const unsynced of ["clearPendingReviews", "deleteDatabase", "removeSession", "dropUpload", "localStorage"])
    assert.ok(!step.includes(unsynced), unsynced);
});

test("every sign-out on this device runs it (account menu, demo, signed-in devices, two-factor screen, account deletion)", () => {
  const app = source("components/workspace-app.tsx");
  assert.match(block(app, "const signOut = async () => {", 200), /await clearAccountData\(\);\s*const done = await fetch\("\/api\/auth\/logout"/);
  assert.match(block(app, "onClick={async () => {\n                await clearAccountData();", 200), /\/api\/auth\/trial-end/);
  assert.match(block(source("components/my-sessions.tsx"), "if (result.current) {", 200), /await clearAccountData\(\);\s*location\.reload\(\)/);
  assert.match(block(source("components/two-factor.tsx"), "As every sign-out on this device", 300), /clearAccountData\(\)[\s\S]*\/api\/auth\/logout/);
  assert.match(block(source("components/delete-own-account.tsx"), "Signed out: nothing of the account", 200), /await clearAccountData\(\);\s*window\.location\.replace/);
  // No sign-out request without the step before it.
  for (const file of ["components/workspace-app.tsx", "components/two-factor.tsx"]) {
    const text = source(file);
    for (let at = text.indexOf('"/api/auth/logout"'); at >= 0; at = text.indexOf('"/api/auth/logout"', at + 1))
      assert.match(text.slice(Math.max(0, at - 400), at), /clearAccountData\(\)/, file);
  }
});

test("the server's sign-out answers carry Clear-Site-Data: \"cache\", never \"storage\"", async () => {
  const { SIGNED_OUT_HEADERS } = await import("../lib/sign-out");
  assert.equal(SIGNED_OUT_HEADERS["Clear-Site-Data"], '"cache"');
  const auth = source("app/api/auth/[action]/handler.ts");
  assert.match(block(auth, 'if (action === "logout") {', 1200), /NextResponse\.json\([\s\S]*\{ headers: SIGNED_OUT_HEADERS \}\);/);
  assert.match(block(auth, 'if (action === "trial-end") {', 300), /headers: SIGNED_OUT_HEADERS/);
  assert.match(block(auth, "await sweepSpaceGitCopies();", 200), /headers: SIGNED_OUT_HEADERS/);
  // POST /api/sessions/end: only when this device's own session ended.
  const api = source("app/api/[...path]/handler.ts");
  assert.match(block(api, 'path[0] === "sessions" && path[1] === "end"', 500), /NextResponse\.json\(result, result\.current \? \{ headers: SIGNED_OUT_HEADERS \} : undefined\)/);
});

test("clearAppCache drops the Ask-AI conversation, the history titles and the page cache, nothing else", async () => {
  const storage = memoryStorage();
  (globalThis as { sessionStorage?: unknown }).sessionStorage = storage;
  try {
    const { clearAppCache } = await import("../lib/swr-cache");
    const { ASK_STORAGE_PREFIX, HISTORY_TITLES_KEY, isAccountTabKey } = await import("../lib/tab-storage");
    storage.setItem(`${ASK_STORAGE_PREFIX}ws-1`, JSON.stringify({ messages: [{ role: "user", text: "DUMMY-QUESTION" }] }));
    storage.setItem(HISTORY_TITLES_KEY, JSON.stringify({ a: { title: "DUMMY-TITLE" } }));
    storage.setItem("flowplan:swr:user-a:page:p1", "{}");
    storage.setItem("flowplan-frame-tabs", "[]");
    clearAppCache();
    assert.deepEqual([...storage.map.keys()], ["flowplan-frame-tabs"]);
    // The sign-in page clears the same keys (components/login.tsx).
    assert.match(source("components/login.tsx"), /isAccountTabKey\(key\)\) sessionStorage\.removeItem\(key\)/);
    assert.ok(isAccountTabKey("flowplan-ask:x") && !isAccountTabKey("flowplan-offline-queue:user-a"));
  } finally {
    delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
  }
});

test("a notebook recording left on the device is offered only to the account that made it (#505)", async () => {
  const store = await import("../components/notebook/audio-store");
  const base = { mime: "audio/webm", name: "Recording", startedAt: 1, durationMs: 1000, updatedAt: 1, bytes: 0, chunks: 0, state: "stopped" as const };
  await store.saveSession({ ...base, id: "s-a", userId: "user-a", pageId: "page-1" });
  await store.saveSession({ ...base, id: "s-b", userId: "user-b", pageId: "page-1", startedAt: 2 });
  await store.saveSession({ ...base, id: "s-a2", userId: "user-a", pageId: "page-2" });
  await store.addChunk((await store.pendingSessions("user-a", "page-1"))[0], new Blob(["DUMMY-AUDIO-OF-A"]));
  assert.deepEqual((await store.pendingSessions("user-a", "page-1")).map((s) => s.id), ["s-a"]);
  assert.deepEqual((await store.pendingSessions("user-b", "page-1")).map((s) => s.id), ["s-b"]);
  assert.deepEqual((await store.pendingSessions("user-c", "page-1")).map((s) => s.id), []);
  assert.deepEqual((await store.pendingSessions("user-a", "page-2")).map((s) => s.id), ["s-a2"]);
  // Kept before #505 (no account): still offered, so it is not lost with the update.
  await store.saveSession({ ...base, id: "s-old", pageId: "page-3" });
  assert.deepEqual((await store.pendingSessions("user-c", "page-3")).map((s) => s.id), ["s-old"]);
  // The recorder stores who recorded and the list asks for the signed-in person.
  const audio = source("components/notebook/notebook-audio.tsx");
  assert.match(audio, /pendingSessions\(userId, pageId\)/);
  assert.match(block(audio, "const session: StoredSession = {", 120), /userId,/);
  for (const [file, value] of [["components/workspace-app.tsx", "boot.user.id"], ["components/split-pane.tsx", "userId"]] as const)
    assert.match(source(file), new RegExp(`<NotebookView key=\\{data\\.page\\.id\\} pageId=\\{data\\.page\\.id\\} userId=\\{${value.replace(".", "\\.")}\\}`), file);
});
