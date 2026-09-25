import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { privateAddress, safeFetch } from "../lib/safe-fetch";
import { previewCard, resolveEmbed } from "../lib/oembed";
import { cleanHtml, htmlState, stateHtml } from "../lib/document-server";

const roundTrip = (html: string) => {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, htmlState(cleanHtml(html)));
    return stateHtml(doc);
  } finally {
    doc.destroy();
  }
};

test("previews never reach internal addresses", async () => {
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "172.20.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "fd00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
  ])
    assert.equal(privateAddress(ip), true, ip);
  for (const ip of ["93.184.216.34", "2606:2800:220:1::1"])
    assert.equal(privateAddress(ip), false, ip);
  await assert.rejects(safeFetch("http://example.com"), /HTTPS/);
  await assert.rejects(safeFetch("https://127.0.0.1/"), /Interne/);
  await assert.rejects(safeFetch("https://[::1]/"), /Interne/);
  await assert.rejects(safeFetch("https://user:pw@example.com/"), /HTTPS/);
  await assert.rejects(
    safeFetch("https://localhost/"),
    /Interne|nicht geladen/,
  );
  // Known players need no request at all.
  assert.deepEqual(await resolveEmbed("https://vimeo.com/76979871"), {
    kind: "player",
    src: "https://player.vimeo.com/video/76979871",
    provider: "Vimeo",
  });
});

test("link cards come from oEmbed and Open Graph data", () => {
  const html = `<html><head><title>Fallback</title>
    <meta property="og:title" content="Quartalsbericht &amp; Ausblick">
    <meta property="og:site_name" content="Beispiel AG">
    <meta name="description" content="Zahlen und Ziele">
    <meta property="og:image" content="/bild.png"></head></html>`;
  assert.deepEqual(previewCard(html, "https://example.org/bericht"), {
    kind: "card",
    url: "https://example.org/bericht",
    title: "Quartalsbericht & Ausblick",
    provider: "Beispiel AG",
    description: "Zahlen und Ziele",
    image: "https://example.org/bild.png",
  });
  const fromOembed = previewCard("", "https://example.org/x", {
    title: "Song",
    provider_name: "Musikdienst",
    thumbnail_url: "http://insecure.example/t.jpg",
  });
  assert.equal(fromOembed.kind === "card" && fromOembed.title, "Song");
  assert.equal(fromOembed.kind === "card" && fromOembed.image, "");
});

test("link cards and media widths survive storage safely", () => {
  const card = roundTrip(
    '<div data-link-card="https://example.org/a" data-link-title="Titel" data-link-provider="Beispiel" data-link-description="Text" data-link-image="https://example.org/i.png"></div>',
  );
  assert.match(card, /data-link-card="https:\/\/example.org\/a"/);
  assert.match(
    card,
    /<a href="https:\/\/example.org\/a"[^>]*rel="noopener noreferrer"/,
  );
  assert.match(card, /<img src="https:\/\/example.org\/i.png"/);
  const unsafe = roundTrip(
    '<div data-link-card="javascript:alert(1)" data-link-title="x"></div>',
  );
  assert.doesNotMatch(unsafe, /javascript|link-card/);
  const video = roundTrip(
    '<iframe src="https://player.vimeo.com/video/76979871" style="width: 50%"></iframe>',
  );
  assert.match(video, /style="width:\s?50%"/);
  const odd = roundTrip(
    '<iframe src="https://player.vimeo.com/video/76979871" style="width: 33%"></iframe>',
  );
  assert.doesNotMatch(odd, /width/);
});
