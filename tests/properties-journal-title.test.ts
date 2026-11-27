// Property-based tests (fast-check, tests/helpers/properties.ts) of the
// journal's automatic day titles (lib/journal-title.ts): every form in every
// language, for random dates (leap days and year ends included), is
// recognised as the automatic title of its own date and of no other; custom
// patterns of random tokens and literals never throw and fall back to the
// long form when they are unusable.
import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { check, nastyText } from "./helpers/properties";
import { LOCALES } from "../lib/i18n";
import {
  DAY_TITLE_FORMATS,
  MAX_DAY_TITLE_PATTERN,
  automaticDayTitle,
  dayTitle,
  dayTitleFormatOf,
  isAutoDayTitle,
  validDayTitlePattern,
} from "../lib/journal-title";

const iso = (date: Date) => date.toISOString().slice(0, 10);
const day = fc.oneof(
  { weight: 4, arbitrary: fc.date({ min: new Date("1900-01-01T00:00:00Z"), max: new Date("2100-12-31T00:00:00Z"), noInvalidDate: true }).map(iso) },
  { weight: 1, arbitrary: fc.constantFrom("2024-02-29", "2000-02-29", "2026-12-31", "2027-01-01", "2026-01-01", "1999-12-31", "2028-02-29", "2100-02-28") },
);
const otherDay = (date: string) => day.filter((other) => other !== date);
const locale = fc.constantFrom(...LOCALES);
const preset = fc.constantFrom(...DAY_TITLE_FORMATS.filter((format) => format !== "custom"));

const TOKENS = ["YYYY", "YY", "MMMM", "MMM", "MM", "M", "DD", "D", "dddd", "ddd"];
const LITERALS = [".", "-", "/", " ", ", ", "[Woche]", "[YYYY]", "[D]", "[", "]", "[]", "Do", "x", "年", "日", "😀"];
// A random pattern: tokens and literals in any order, also glued together.
const pattern = fc
  .array(fc.oneof(fc.constantFrom(...TOKENS), fc.constantFrom(...LITERALS), nastyText(2)), { maxLength: 12 })
  .map((parts) => parts.join(""));
// A pattern that names the day unambiguously: year, month and day, each
// between separators that are no digits.
const fullPattern = fc
  .tuple(
    fc.shuffledSubarray(["year", "month", "day"], { minLength: 3, maxLength: 3 }),
    fc.constantFrom("MMMM", "MMM", "MM", "M"),
    fc.constantFrom("DD", "D"),
    fc.array(fc.constantFrom(".", "-", "/", " ", ", ", " [de] "), { minLength: 2, maxLength: 2 }),
    fc.option(fc.constantFrom("dddd", "ddd"), { nil: undefined }),
  )
  .map(([order, month, dayToken, [first, second], weekday]) => {
    const parts = order.map((part) => (part === "year" ? "YYYY" : part === "month" ? month : dayToken));
    return `${weekday ? `${weekday} ` : ""}${parts[0]}${first}${parts[1]}${second}${parts[2]}`;
  });

test("property: every preset in every language is recognised for its date and no other", () => {
  check(
    fc.property(
      day.chain((date) => fc.tuple(fc.constant(date), otherDay(date))),
      locale,
      preset,
      ([date, other], lang, format) => {
        const title = dayTitle(date, lang, format);
        assert.ok(isAutoDayTitle(title, date), title);
        assert.ok(automaticDayTitle(title, date), title);
        assert.notEqual(dayTitleFormatOf(title, date), null, title);
        // Spaces and capitals changed: still not renamed.
        assert.ok(automaticDayTitle(`  ${title.toLocaleUpperCase()} `.replace(/ /g, "  "), date), title);
        assert.equal(isAutoDayTitle(title, other), false, `${title} for ${other}`);
        assert.equal(automaticDayTitle(title, other), false, `${title} for ${other}`);
      },
    ),
    300,
  );
});

test("property: custom patterns never throw, and unusable ones fall back to the long form", () => {
  check(
    fc.property(day, locale, pattern, (date, lang, own) => {
      const title = dayTitle(date, lang, "custom", own);
      assert.equal(typeof title, "string");
      if (!validDayTitlePattern(own)) {
        assert.equal(title, dayTitle(date, lang, "long"));
        return;
      }
      assert.ok(own.trim().length <= MAX_DAY_TITLE_PATTERN);
      assert.ok(title.length > 0);
      assert.ok(isAutoDayTitle(title, date, own), JSON.stringify({ own, title }));
      assert.ok(automaticDayTitle(title, date, own), JSON.stringify({ own, title }));
      assert.equal(dayTitleFormatOf(title, date, own) !== null, true);
    }),
    400,
  );
});

test("property: patterns over the length limit or without a token are unusable", () => {
  check(
    fc.property(pattern, fc.string({ minLength: MAX_DAY_TITLE_PATTERN + 1, maxLength: 120 }), (own, long) => {
      if (long.trim().length > MAX_DAY_TITLE_PATTERN) assert.equal(validDayTitlePattern(long), false);
      // Only bracketed literals: nothing of the date.
      const literal = `[${own.replace(/[[\]]/g, "")}]`;
      assert.equal(validDayTitlePattern(literal), false, literal);
    }),
    300,
  );
});

test("property: a custom pattern with year, month and day names its date and no other", () => {
  check(
    fc.property(
      day.chain((date) => fc.tuple(fc.constant(date), otherDay(date))),
      locale,
      fullPattern,
      ([date, other], lang, own) => {
        assert.ok(validDayTitlePattern(own), own);
        const title = dayTitle(date, lang, "custom", own);
        assert.ok(isAutoDayTitle(title, date, own), JSON.stringify({ own, title }));
        assert.equal(isAutoDayTitle(title, other, own), false, JSON.stringify({ own, title, other }));
        assert.equal(automaticDayTitle(title, other, own), false, JSON.stringify({ own, title, other }));
      },
    ),
    300,
  );
});
