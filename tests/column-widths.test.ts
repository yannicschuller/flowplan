// Default widths of a table's columns (lib/column-widths.ts, #523): the
// title 280, most properties 180, a date as wide as its format needs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultColumnWidth, OTHER_COLUMN, TITLE_COLUMN } from "../lib/column-widths";

test("title and other properties keep their widths", () => {
  assert.equal(defaultColumnWidth({ type: "text" }, true), TITLE_COLUMN);
  assert.equal(TITLE_COLUMN, 280);
  for (const type of ["text", "number", "select", "person", "url"] as const)
    assert.equal(defaultColumnWidth({ type }, false), OTHER_COLUMN);
  assert.equal(OTHER_COLUMN, 180);
  // A date as the first column is still the title.
  assert.equal(defaultColumnWidth({ type: "date" }, true), 280);
});

test("a date column fits its format, with or without time", () => {
  const width = (format: string, noTime?: boolean, timeFormat?: "24" | "12") =>
    defaultColumnWidth({ type: "date", format, noTime, timeFormat }, false);
  // Without time: short < long, numeric the narrowest.
  assert.equal(width("", true), 130);
  assert.equal(width("long", true), 160);
  for (const format of ["eu", "iso", "us"]) assert.equal(width(format, true), 120);
  // With time (the default, "Mit Uhrzeit" on): the time adds its width,
  // 12-hour times a little more.
  assert.equal(width(""), 170);
  assert.equal(width("", false, "12"), 190);
  assert.equal(width("iso"), 160);
  assert.equal(width("long"), 200);
  // A new date property (default format, time allowed) starts below 180.
  assert.ok(width("") < OTHER_COLUMN);
  // An unknown format falls back to the short date.
  assert.equal(width("other", true), 130);
});

test("created and edited time always have a time", () => {
  assert.equal(defaultColumnWidth({ type: "created_at" }, false), 170);
  assert.equal(defaultColumnWidth({ type: "updated_at", format: "eu", noTime: true }, false), 160);
});
