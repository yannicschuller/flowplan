// pdf.js runs in a worker thread (lib/pdf-text.ts, lib/workers): the text
// of a long PDF comes out as before while the event loop stays free.
import { test } from "node:test";
import assert from "node:assert/strict";
import { samplePdf } from "./helpers/pdf";
import { pdfPoolState, pdfScanImages, pdfText } from "../lib/pdf-text";

test("a long PDF's text comes from the worker, the event loop keeps turning", async () => {
  const pages = Array.from({ length: 150 }, (_, i) => `Seite ${i + 1} ${"Lorem ipsum dolor sit amet ".repeat(40)}`);
  const pdf = samplePdf(pages);
  let turns = 0,
    longest = 0,
    last = performance.now(),
    watching = true;
  const watch = () => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
    turns++;
    if (watching) setImmediate(watch);
  };
  setImmediate(watch);
  const text = await pdfText(pdf);
  watching = false;
  assert.match(text, /Seite 1 Lorem/);
  assert.match(text, /Seite 150 Lorem/);
  assert.equal(pdfPoolState().running, true, "worker thread used");
  assert.equal(pdfPoolState().pending, 0);
  assert.ok(turns > 20, `${turns} turns`);
  assert.ok(longest < 500, `event loop held ${longest.toFixed(0)} ms`);
  // A PDF with a text layer has no scan images.
  assert.deepEqual(await pdfScanImages(pdf), []);
  // A broken file fails like before (the caller stores the failure).
  await assert.rejects(pdfText(new TextEncoder().encode("not a pdf")));
  assert.equal(pdfPoolState().pending, 0);
});
