// Conditional answers for the app's 10 s refresh (lib/etag.ts): the same
// content gets the same weak ETag and, asked with it, a 304 without body.
import { test } from "node:test";
import assert from "node:assert/strict";
import { contentTag, jsonWithTag, tagMatches } from "../lib/etag";

const request = (tag?: string) => new Request("http://x/api/bootstrap", tag ? { headers: { "If-None-Match": tag } } : {});

test("an unchanged answer is a 304 without body, a changed one the whole JSON", async () => {
  const data = { pages: [{ id: "a", title: "Plan" }], n: 1 };
  const first = jsonWithTag(request(), data);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("Content-Type"), "application/json");
  assert.equal(first.headers.get("Cache-Control"), "no-store");
  const tag = first.headers.get("ETag")!;
  assert.match(tag, /^W\/"[\w-]{32}"$/);
  assert.deepEqual(await first.json(), data);
  const again = jsonWithTag(request(tag), { pages: [{ id: "a", title: "Plan" }], n: 1 });
  assert.equal(again.status, 304);
  assert.equal(await again.text(), "");
  assert.equal(again.headers.get("ETag"), tag);
  const changed = jsonWithTag(request(tag), { ...data, n: 2 });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.get("ETag"), tag);
});

test("If-None-Match lists, strong and weak forms", () => {
  const tag = contentTag("{}");
  assert.ok(tagMatches(`"other", ${tag}`, tag));
  assert.ok(tagMatches(tag.replace(/^W\//, ""), tag));
  assert.ok(tagMatches("*", tag));
  assert.ok(!tagMatches(null, tag));
  assert.ok(!tagMatches('W/"other"', tag));
});
