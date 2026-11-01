// Issue #67: link properties (url, email, phone) open as links – only safe
// schemes, shortened labels.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cellHref, isLinkField, linkLabel, mailHref, telHref, webHref } from "../lib/cell-links";

test("url cells link only to http(s) and mailto", () => {
  assert.equal(cellHref("url", "https://example.org/docs"), "https://example.org/docs");
  assert.equal(cellHref("url", "  http://example.org  "), "http://example.org/");
  assert.equal(cellHref("url", "HTTPS://Example.org/A?b=1#c"), "https://example.org/A?b=1#c");
  assert.equal(cellHref("url", "mailto:anna@example.org"), "mailto:anna@example.org");
  for (const unsafe of [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox",
    "file:///etc/passwd",
    "ftp://example.org",
    "/relative/path",
    "#page=abc",
    "example.org",
    "www.example.org",
    "//example.org/x",
    "https://user:secret@example.org",
    "https://",
    "https://exa mple.org",
    "https://example.org/\"onmouseover=x",
    "mailto:not-an-address",
    "mailto:a@example.org,b@example.org",
    "",
    "   ",
  ])
    assert.equal(cellHref("url", unsafe), null, unsafe);
  assert.equal(cellHref("url", 42), null);
  assert.equal(cellHref("url", null), null);
  assert.equal(cellHref("text", "https://example.org"), null);
});

test("email and phone cells link to mailto and tel", () => {
  assert.equal(cellHref("email", "anna@example.org"), "mailto:anna@example.org");
  assert.equal(cellHref("email", "mailto:anna@example.org"), "mailto:anna@example.org");
  assert.equal(cellHref("email", "anna"), null);
  assert.equal(cellHref("email", "anna@example.org?bcc=eve@example.org"), null);
  assert.equal(cellHref("email", "javascript:alert(1)//@x.org"), null);
  assert.equal(mailHref("a b@example.org"), null);
  assert.equal(cellHref("phone", "+49 (30) 123-45 67"), "tel:+49301234567");
  assert.equal(cellHref("phone", "030 1234"), "tel:0301234");
  assert.equal(cellHref("phone", "call me"), null);
  assert.equal(cellHref("phone", "12"), null);
  assert.equal(telHref("javascript:1"), null);
  assert.equal(webHref("tel:123"), null);
  assert.ok(isLinkField("url") && isLinkField("email") && isLinkField("phone"));
  assert.ok(!isLinkField("text") && !isLinkField("files"));
});

test("link labels show host and path, shortened", () => {
  assert.equal(linkLabel("https://www.example.org/"), "example.org");
  assert.equal(linkLabel("https://example.org/docs/guide/"), "example.org/docs/guide");
  assert.equal(linkLabel("https://example.org/a?b=1"), "example.org/a…");
  assert.equal(linkLabel("http://localhost:3000/x"), "localhost:3000/x");
  assert.equal(linkLabel("https://example.org/%C3%BCber"), "example.org/über");
  assert.equal(linkLabel("mailto:anna@example.org"), "anna@example.org");
  assert.equal(linkLabel("tel:+4930"), "+4930");
  const long = linkLabel("https://example.org/" + "a".repeat(80));
  assert.equal(long.length, 40);
  assert.ok(long.endsWith("…") && long.startsWith("example.org/aaa"));
  assert.equal(linkLabel("https://example.org/abcdef", 10), "example.o…");
});
