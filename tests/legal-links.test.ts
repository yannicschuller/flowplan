import { test } from "node:test";
import assert from "node:assert/strict";
import { legalLinks } from "../lib/legal-links";

test("legal links appear only when set, and only as web addresses", () => {
  delete process.env.IMPRINT_URL;
  delete process.env.PRIVACY_URL;
  assert.deepEqual(legalLinks(), {});
  process.env.IMPRINT_URL = "https://example.com/impressum";
  assert.deepEqual(legalLinks(), { imprint: "https://example.com/impressum" });
  process.env.PRIVACY_URL = "javascript:alert(1)";
  assert.deepEqual(legalLinks(), { imprint: "https://example.com/impressum" });
  process.env.PRIVACY_URL = " https://example.com/datenschutz ";
  assert.deepEqual(legalLinks(), { imprint: "https://example.com/impressum", privacy: "https://example.com/datenschutz" });
  delete process.env.IMPRINT_URL;
  delete process.env.PRIVACY_URL;
});
