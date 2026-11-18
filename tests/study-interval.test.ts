// The interval under the rating buttons of the focus mode (#346): written
// out, one spelling, German and English.
import { test } from "node:test";
import assert from "node:assert/strict";
import { intervalText, minutesText } from "../lib/study-interval";

const de = (d: string) => d;
const en = (_: string, e: string) => e;
const fmtDe = (n: number) => new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 }).format(n);
const fmtEn = (n: number) => new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1 }).format(n);

test("short and long interval texts", () => {
  assert.deepEqual(intervalText("now", 0, fmtDe, de), { short: "< 1 Min", long: "in weniger als einer Minute" });
  assert.equal(intervalText("minutes", 10, fmtDe, de).short, "10 Min");
  assert.equal(intervalText("minutes", 1, fmtDe, de).long, "in 1 Minute");
  assert.equal(intervalText("hours", 2.5, fmtDe, de).short, "2,5 Std");
  assert.deepEqual(intervalText("days", 1, fmtDe, de), { short: "1 Tag", long: "morgen" });
  assert.deepEqual(intervalText("days", 10, fmtDe, de), { short: "10 Tage", long: "in 10 Tagen" });
  assert.equal(intervalText("months", 1.5, fmtDe, de).short, "1,5 Mon.");
  assert.equal(intervalText("years", 1, fmtDe, de).short, "1 Jahr");
  assert.equal(intervalText("years", 2.1, fmtDe, de).short, "2,1 Jahre");
  assert.deepEqual(intervalText("days", 10, fmtEn, en), { short: "10 days", long: "in 10 days" });
  assert.equal(intervalText("days", 1, fmtEn, en).short, "1 day");
  assert.equal(intervalText("months", 3, fmtEn, en).short, "3 mo");
  assert.equal(minutesText(6, fmtDe, de), "6 Min");
  assert.equal(minutesText(6, fmtEn, en), "6 min");
});
