import { test } from "node:test";
import assert from "node:assert/strict";
import { addressKey, clientAddress } from "../lib/client-address";

const h = (xff?: string, real?: string) => {
  const headers = new Headers();
  if (xff !== undefined) headers.set("x-forwarded-for", xff);
  if (real) headers.set("x-real-ip", real);
  return headers;
};

test("the client address comes from the trusted proxy, not from what the client sent", () => {
  delete process.env.FLOWPLAN_TRUSTED_PROXIES;
  // Traefik appends the real address after anything the client made up.
  assert.equal(clientAddress(h("203.0.113.9")), "203.0.113.9");
  assert.equal(clientAddress(h("1.1.1.1, 2.2.2.2, 203.0.113.9")), "203.0.113.9");
  // Two proxies (Pangolin in front of Traefik).
  process.env.FLOWPLAN_TRUSTED_PROXIES = "2";
  assert.equal(clientAddress(h("1.1.1.1, 203.0.113.9, 198.51.100.4")), "203.0.113.9");
  assert.equal(clientAddress(h("203.0.113.9")), "203.0.113.9");
  process.env.FLOWPLAN_TRUSTED_PROXIES = "nonsense";
  assert.equal(clientAddress(h("1.1.1.1, 203.0.113.9")), "203.0.113.9");
  delete process.env.FLOWPLAN_TRUSTED_PROXIES;
  assert.equal(clientAddress(h(undefined, "198.51.100.7")), "198.51.100.7");
});

test("without a forwarded address nobody shares a bucket, and 0 trusts no header", () => {
  delete process.env.FLOWPLAN_TRUSTED_PROXIES;
  // No header at all: unknown, not a constant that everyone would share.
  assert.equal(clientAddress(h()), "");
  assert.deepEqual(addressKey("ip", ""), []);
  assert.deepEqual(addressKey("ip", "203.0.113.9"), ["ip:203.0.113.9"]);
  // Exposed without a proxy: the header is the client's to make up, so it
  // is ignored altogether.
  process.env.FLOWPLAN_TRUSTED_PROXIES = "0";
  assert.equal(clientAddress(h("203.0.113.9", "198.51.100.7")), "");
  delete process.env.FLOWPLAN_TRUSTED_PROXIES;
});

test("X-Real-IP counts only behind exactly one trusted proxy", () => {
  // One proxy (nginx with proxy_set_header X-Real-IP $remote_addr): its value.
  process.env.FLOWPLAN_TRUSTED_PROXIES = "1";
  assert.equal(clientAddress(h(undefined, "198.51.100.7")), "198.51.100.7");
  // Two proxies: the inner one would name the outer one at best, or pass on
  // what the client sent – so a client cannot pick its address this way.
  process.env.FLOWPLAN_TRUSTED_PROXIES = "2";
  assert.equal(clientAddress(h(undefined, "198.51.100.7")), "");
  assert.equal(clientAddress(h("203.0.113.9, 198.51.100.4", "1.2.3.4")), "203.0.113.9", "X-Forwarded-For wins");
  process.env.FLOWPLAN_TRUSTED_PROXIES = "0";
  assert.equal(clientAddress(h(undefined, "198.51.100.7")), "");
  delete process.env.FLOWPLAN_TRUSTED_PROXIES;
});
