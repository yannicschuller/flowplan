import { test } from "node:test";
import assert from "node:assert/strict";
import { clientAddress } from "../lib/client-address";

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
  assert.equal(clientAddress(h()), "local");
});
