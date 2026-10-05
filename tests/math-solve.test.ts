import { test } from "node:test";
import assert from "node:assert/strict";
import { mathActions, normalize, trailingExpression } from "../lib/math-solve";

const texts = (s: string, locale: "de" | "en" = "de") => mathActions(s, locale).map((a) => `${a.kind}: ${a.text}`);

test("written maths is read in German and English notation", () => {
  assert.equal(normalize("12 × 2.400 €", "de")?.expr, "12 * 2400");
  assert.equal(normalize("12 × 2.400 €", "de")?.unit, "€");
  assert.equal(normalize("2,5 + 1,5", "de")?.expr, "2.5 + 1.5");
  assert.equal(normalize("2,400.5 + 1", "en")?.expr, "2400.5 + 1");
  assert.equal(normalize("7:2", "de")?.expr, "7/2");
  assert.equal(normalize("Hallo Welt", "de"), null);
  assert.equal(normalize("3 Äpfel", "de"), null);
  assert.equal(normalize("42", "de"), null);
});

test("numbers: exact fractions, reducing and decimals", () => {
  assert.deepEqual(texts("3/4 + 1/6"), ["result: = 11/12", "decimal: ≈ 0,916667"]);
  assert.deepEqual(texts("12/18"), ["reduce: = 2/3", "decimal: ≈ 0,666667"]);
  assert.deepEqual(texts("12 × 2.400 €"), ["result: = 28.800 €"]);
  assert.deepEqual(texts("2,5 + 1,5"), ["result: = 4"]);
  assert.deepEqual(texts("√16 + 1"), ["result: = 5"]);
  assert.deepEqual(texts("√2"), ["decimal: ≈ 1,414214"]);
  assert.deepEqual(texts("1/3 + 1/6", "en"), ["result: = 1/2", "decimal: ≈ 0.5"]);
});

test("terms: binomial formulas, expanding and factoring", () => {
  assert.deepEqual(texts("(a+b)²"), ["expand: = a² + 2ab + b²"]);
  assert.deepEqual(texts("(a − b)(a + b)"), ["expand: = a² − b²"]);
  assert.deepEqual(texts("(2x-3)^2"), ["expand: = 4x² − 12x + 9"]);
  assert.deepEqual(texts("a² + 2ab + b²"), ["factor: = (a + b)²"]);
  assert.deepEqual(texts("x² − 9"), ["factor: = (x − 3)(x + 3)"]);
  assert.deepEqual(texts("4x² − 12x + 9"), ["factor: = (2x − 3)²"]);
  assert.deepEqual(texts("6x² + 9x"), ["factor: = 3x(2x + 3)"]);
  assert.deepEqual(texts("x/2 + x/3"), ["expand: = 5/6·x"]);
});

test("factoring with several variables, grouping and higher powers", () => {
  assert.deepEqual(texts("ax + ay + bx + by"), ["factor: = (x + y)(a + b)"]);
  assert.deepEqual(texts("x²y² − 1"), ["factor: = (xy − 1)(xy + 1)"]);
  assert.deepEqual(texts("a³ − b³"), ["factor: = (a − b)(a² + ab + b²)"]);
  assert.deepEqual(texts("x⁴ − y⁴"), ["factor: = (x − y)(x + y)(x² + y²)"]);
  assert.deepEqual(texts("x² + 2xy + y² − 1"), ["factor: = (x + y − 1)(x + y + 1)"]);
  assert.deepEqual(texts("4x² − 9y²"), ["factor: = (2x − 3y)(2x + 3y)"]);
  assert.deepEqual(texts("2a²b − 8b"), ["factor: = 2b(a − 2)(a + 2)"]);
  assert.deepEqual(texts("x³ + x² − x − 1"), ["factor: = (x − 1)(x + 1)²"]);
  assert.deepEqual(texts("x^4 - 5x^2 + 4"), ["factor: = (x − 1)(x + 1)(x − 2)(x + 2)"]);
  // Nothing to factor: nothing offered.
  assert.deepEqual(texts("x² + x + 1"), []);
});

test("fractions with variables: reduce, combine and solve with the domain", () => {
  assert.deepEqual(texts("(x² − 1)/(x − 1)"), ["expand: = x + 1"]);
  assert.deepEqual(texts("(x+2)/(x²-4)"), ["expand: = 1/(x − 2)"]);
  assert.deepEqual(texts("1/x + 1/(x+1)"), ["expand: = (2x + 1)/(x(x + 1))"]);
  assert.deepEqual(texts("3/(x-1) = 1"), ["solve: ⇒ x = 4"]);
  assert.deepEqual(texts("2/x + 1 = 5/x"), ["solve: ⇒ x = 3"]);
  assert.deepEqual(texts("x/(x-1) = 1/(x-1)"), ["solve: ⇒ keine Lösung (x = 1 entfällt: Nenner wäre 0)"]);
  assert.deepEqual(texts("(x²-1)/(x-1) = 2"), ["solve: ⇒ keine Lösung (x = 1 entfällt: Nenner wäre 0)"]);
  assert.deepEqual(texts("1/(x+1) + 1/(x-1) = 0"), ["solve: ⇒ x = 0"]);
  assert.deepEqual(texts("1/x = 0"), ["solve: ⇒ keine Lösung"]);
  assert.deepEqual(texts("x/(x-1) = 1/(x-1)", "en"), ["solve: ⇒ no solution (x = 1 excluded: a denominator would be 0)"]);
});

test("equations are solved for their variable", () => {
  assert.deepEqual(texts("2x + 3 = 11"), ["solve: ⇒ x = 4"]);
  assert.deepEqual(texts("x² − 5x + 6 = 0"), ["solve: ⇒ x = 2, x = 3"]);
  assert.deepEqual(texts("x² + 2x − 4 = 0"), ["solve: ⇒ x = −1 ± √5 (≈ −3,236068; 1,236068)"]);
  assert.deepEqual(texts("x^2 + 1 = 0"), ["solve: ⇒ keine reelle Lösung"]);
  assert.deepEqual(texts("x^3 - 6x^2 + 11x - 6 = 0"), ["solve: ⇒ x = 1, x = 2, x = 3"]);
  assert.deepEqual(texts("2x + y = 10"), ["solve: ⇒ x = −1/2·y + 5", "solve: ⇒ y = −2x + 10"]);
});

test("the calculation before a typed equals sign", () => {
  assert.equal(trailingExpression("Budget: 12 × 2.400 € ="), "12 × 2.400 €");
  assert.equal(trailingExpression("Das ergibt 3/4 + 1/6 ="), "3/4 + 1/6");
  assert.equal(trailingExpression("(a+b)^2 ="), "(a+b)^2");
  assert.equal(trailingExpression("Kein Gleichheitszeichen"), null);
  // "3/4" may have become "¾" while typing.
  assert.equal(trailingExpression("¾ + 1/6 ="), "¾ + 1/6");
  assert.deepEqual(texts("¾ + 1/6"), ["result: = 11/12", "decimal: ≈ 0,916667"]);
  assert.equal(trailingExpression("Text + 1/6 ="), null);
});

test("formulas in LaTeX can be calculated", async () => {
  const { latexToExpression } = await import("../lib/math-solve");
  assert.equal(latexToExpression("\\frac{3}{4} + \\frac{1}{6}"), "((3)/(4)) + ((1)/(6))");
  assert.deepEqual(texts(latexToExpression("\\frac{3}{4} + \\frac{1}{6}")!), ["result: = 11/12", "decimal: ≈ 0,916667"]);
  assert.deepEqual(texts(latexToExpression("\\left(a+b\\right)^{2}")!), ["expand: = a² + 2ab + b²"]);
  assert.equal(latexToExpression("\\int_0^1 x\\,dx"), null);
});
