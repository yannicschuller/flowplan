import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { compareVersions, resetUpdateCheck, updateStatus } from "../lib/update-check";

const release = (body: unknown, status = 200) => {
  const calls: string[] = [];
  const fetcher = (async (url: string) => {
    calls.push(url);
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
};

beforeEach(() => {
  resetUpdateCheck();
  process.env.FLOWPLAN_VERSION = "0.3.3";
  delete process.env.FLOWPLAN_UPDATE_CHECK;
  delete process.env.FLOWPLAN_UPDATE_URL;
});

test("versions compare by semantic versioning", () => {
  assert.ok(compareVersions("0.3.10", "0.3.9") > 0);
  assert.ok(compareVersions("v1.0.0", "0.99.99") > 0);
  assert.equal(compareVersions("1.2.3", "v1.2.3"), 0);
  assert.ok(compareVersions("1.2.0-beta.1", "1.2.0") < 0);
  assert.ok(compareVersions("1.2.0-beta.2", "1.2.0-beta.10") < 0);
  assert.ok(compareVersions("1.2.0-alpha", "1.2.0-beta") < 0);
  assert.ok(compareVersions("1.2.0-beta", "1.2.0-beta.1") < 0);
  assert.equal(compareVersions("dev", "1.0.0"), 0);
});

test("a newer release is announced with its notes", async () => {
  const { fetcher } = release({ tag_name: "v0.4.0", html_url: "https://github.com/yannicschuller/flowplan/releases/tag/v0.4.0" });
  assert.deepEqual(await updateStatus(fetcher), {
    current: "0.3.3",
    latest: "0.4.0",
    url: "https://github.com/yannicschuller/flowplan/releases/tag/v0.4.0",
  });
});

test("the same, an older or a pre-release is not announced", async () => {
  for (const body of [{ tag_name: "v0.3.3" }, { tag_name: "v0.3.2" }, { tag_name: "v0.4.0", prerelease: true }, { tag_name: "v0.4.0", draft: true }, { tag_name: "latest" }]) {
    resetUpdateCheck();
    assert.equal(await updateStatus(release(body).fetcher), null, JSON.stringify(body));
  }
});

test("builds without a release version do not ask", async () => {
  process.env.FLOWPLAN_VERSION = "";
  const { fetcher, calls } = release({ tag_name: "v9.0.0" });
  assert.equal(await updateStatus(fetcher), null);
  assert.equal(calls.length, 0);
});

test("FLOWPLAN_UPDATE_CHECK=false turns the check off", async () => {
  process.env.FLOWPLAN_UPDATE_CHECK = "false";
  const { fetcher, calls } = release({ tag_name: "v9.0.0" });
  assert.equal(await updateStatus(fetcher), null);
  assert.equal(calls.length, 0);
});

test("offline or an error stays silent, and the answer is cached", async () => {
  const offline = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  assert.equal(await updateStatus(offline), null);
  resetUpdateCheck();
  assert.equal(await updateStatus(release({ message: "rate limited" }, 403).fetcher), null);
  resetUpdateCheck();
  const { fetcher, calls } = release({ tag_name: "v0.4.0", html_url: "javascript:alert(1)" });
  assert.equal((await updateStatus(fetcher))?.url, "");
  await updateStatus(fetcher);
  assert.equal(calls.length, 1);
});

test("FLOWPLAN_UPDATE_URL asks a mirror", async () => {
  process.env.FLOWPLAN_UPDATE_URL = "https://mirror.example/latest.json";
  const { fetcher, calls } = release({ tag_name: "v1.0.0" });
  assert.equal((await updateStatus(fetcher))?.latest, "1.0.0");
  assert.deepEqual(calls, ["https://mirror.example/latest.json"]);
});
