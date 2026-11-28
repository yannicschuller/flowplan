// Calculus for school functions (lib/math-analysis.ts): derivatives, curve
// analysis, antiderivatives and integrals, tangents, intersections, limits
// and asymptotes – exact where the algebra allows, otherwise marked "≈".
// Abitur-style examples with known results, the maintainer's sheet, and
// properties (fast-check): the symbolic derivative matches a numeric one,
// ∫ₐᵇ f′ = f(b) − f(a), an antiderivative's derivative is f, and what is
// written can be read back.
import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { check } from "./helpers/properties";
import { analysisHint, antiderivative, compileEx, derivative, functionActions, plotFunction, readExpression, readFunction, show, type Ex } from "../lib/math-analysis";

type L = "de" | "en";
// The actions as "label: text".
const actions = (text: string, locale: L = "de") => functionActions(text, locale).map((a) => `${a.label}: ${a.text}`);
const action = (text: string, label: string, locale: L = "de") => functionActions(text, locale).find((a) => a.label === label)?.text;
const d = (text: string, n = 1) => {
  const def = readFunction(text, "de")!;
  let ex = def.ex;
  for (let i = 0; i < n; i++) ex = derivative(ex, def.variable);
  return show(ex, "t", "de");
};

/* ---------- The maintainer's sheet ---------- */

test("sheet: f(t) = ½·t³·e^(−t/3 − 3/5)", () => {
  const f = "f(t) = ½·t³·e^(−t/3 − 3/5)";
  assert.equal(action(f, "1. Ableitung"), "⇒ f′(t) = (3/2·t² − 1/6·t³)·e^(−1/3·t − 3/5)");
  assert.equal(action(f, "2. Ableitung"), "⇒ f″(t) = (1/18·t³ − t² + 3t)·e^(−1/3·t − 3/5)");
  assert.equal(action(f, "Nullstellen"), "⇒ t = 0");
  // f′ = −1/6·t²·(t − 9)·e^…: a maximum at 9, no sign change at 0.
  assert.equal(action(f, "Extrempunkte"), "⇒ H(9 | 729/2·e^(−18/5) ≈ 9,9595)");
  // f″ = 1/18·t·(t² − 18t + 54)·e^…: t = 0 (a saddle), 9 ± 3√3.
  assert.equal(action(f, "Wendepunkte"), "⇒ S(0 | 0); W(9 − 3√3 ≈ 3,8038 | ≈ 4,2501); W(9 + 3√3 ≈ 14,1962 | ≈ 6,9152)");
  assert.equal(action(f, "Monotonie"), "⇒ streng monoton steigend für t < 9; streng monoton fallend für t > 9");
  assert.equal(
    action(f, "Krümmung"),
    "⇒ rechtsgekrümmt für t < 0; linksgekrümmt für 0 < t < 9 − 3√3; rechtsgekrümmt für 9 − 3√3 < t < 9 + 3√3; linksgekrümmt für t > 9 + 3√3",
  );
  assert.equal(action(f, "Stammfunktion"), "⇒ F(t) = −(3/2·t³ + 27/2·t² + 81t + 243)·e^(−1/3·t − 3/5)");
  assert.equal(action(f, "Grenzwerte"), "⇒ lim t→−∞ f(t) = −∞; lim t→∞ f(t) = 0");
  assert.equal(action(f, "Asymptoten"), "⇒ waagerecht: y = 0 (für t → ∞)");
  // The tangent is called w here: t is the variable.
  assert.match(action(f, "Wendetangente")!, /^⇒ w\(t\) ≈ 1,9352t − 3,1113; w\(t\) ≈ −0,8437t \+ 18,8925$/);
});

test("sheet: f(x) = (x+3)·eˣ", () => {
  const f = "f(x) = (x+3)·eˣ";
  assert.equal(action(f, "1. Ableitung"), "⇒ f′(x) = (x + 4)·eˣ");
  assert.equal(action(f, "2. Ableitung"), "⇒ f″(x) = (x + 5)·eˣ");
  assert.equal(action(f, "Nullstellen"), "⇒ x = −3");
  assert.equal(action(f, "Extrempunkte"), "⇒ T(−4 | −e⁻⁴ ≈ −0,01832)");
  assert.equal(action(f, "Wendepunkte"), "⇒ W(−5 | −2e⁻⁵ ≈ −0,01348)");
  assert.equal(action(f, "Monotonie"), "⇒ streng monoton fallend für x < −4; streng monoton steigend für x > −4");
  assert.equal(action(f, "Stammfunktion"), "⇒ F(x) = (x + 2)·eˣ");
  assert.equal(action(f, "Grenzwerte"), "⇒ lim x→−∞ f(x) = 0; lim x→∞ f(x) = ∞");
  assert.equal(action(f, "Asymptoten"), "⇒ waagerecht: y = 0 (für x → −∞)");
  assert.equal(action(f, "Wendetangente"), "⇒ t(x) = −e⁻⁵·x − 7e⁻⁵");
  assert.deepEqual(actions("∫_0^1 (x+3)·e^x dx"), ["Integral: = 3e − 2 ≈ 6,1548", "Mittelwert auf [0; 1]: ⇒ m = 3e − 2 ≈ 6,1548"]);
});

test("sheet: f(x) = (2x²−13)²¹ – the chain rule, no expanding", () => {
  const f = "f(x) = (2x²−13)²¹";
  assert.equal(action(f, "1. Ableitung"), "⇒ f′(x) = 84x·(2x² − 13)²⁰");
  assert.equal(action(f, "2. Ableitung"), "⇒ f″(x) = (6888x² − 1092)·(2x² − 13)¹⁹");
  assert.equal(action(f, "Nullstellen"), "⇒ x = −√26/2 ≈ −2,5495; x = √26/2 ≈ 2,5495");
  // (−13)²¹ stays a power: 24 digits are no school number.
  assert.equal(action(f, "Extrempunkte"), "⇒ T(0 | −13²¹ ≈ −2,4706·10²³)");
  // The zeros of f′ at ±√26/2 have no sign change: saddle points.
  assert.equal(
    action(f, "Wendepunkte"),
    "⇒ S(−√26/2 ≈ −2,5495 | 0); W(−√1066/82 ≈ −0,3982 | ≈ −1,471·10²³); W(√1066/82 ≈ 0,3982 | ≈ −1,471·10²³); S(√26/2 ≈ 2,5495 | 0)",
  );
  assert.equal(action(f, "Monotonie"), "⇒ streng monoton fallend für x < 0; streng monoton steigend für x > 0");
});

test("sheet: f(x) = 2x·e^(2−4x)", () => {
  const f = "f(x) = 2x·e^(2−4x)";
  assert.equal(action(f, "1. Ableitung"), "⇒ f′(x) = (2 − 8x)·e^(2 − 4x)");
  assert.equal(action(f, "2. Ableitung"), "⇒ f″(x) = (32x − 16)·e^(2 − 4x)");
  assert.equal(action(f, "Extrempunkte"), "⇒ H(1/4 | 1/2·e ≈ 1,3591)");
  assert.equal(action(f, "Wendepunkte"), "⇒ W(1/2 | 1)");
  assert.equal(action(f, "Wendetangente"), "⇒ t(x) = −2x + 2");
  assert.equal(action(f, "Stammfunktion"), "⇒ F(x) = −(1/2·x + 1/8)·e^(2 − 4x)");
  assert.equal(action(f, "Grenzwerte"), "⇒ lim x→−∞ f(x) = −∞; lim x→∞ f(x) = 0");
});

/* ---------- Derivatives ---------- */

test("derivatives: product, quotient and chain rule, e, ln, sin, cos, powers and roots", () => {
  assert.equal(d("f(x) = x³ − 6x² + 9x"), "3x² − 12x + 9");
  assert.equal(d("f(x) = x³ − 6x² + 9x", 2), "6x − 12");
  assert.equal(d("f(x) = x²·sin(x)"), "2x·sin(x) + x²·cos(x)");
  assert.equal(d("f(x) = x·e^(−x)"), "(1 − x)·e⁻ˣ");
  assert.equal(d("f(x) = e^(x²)"), "2x·e^(x²)");
  assert.equal(d("f(x) = (x²+1)/(x−1)"), "(x² − 2x − 1)/(x − 1)²");
  assert.equal(d("f(x) = (x²+1)/(x−1)", 2), "4/(x − 1)³");
  assert.equal(d("f(x) = 1/(x^2+1)"), "−2x/(x² + 1)²");
  assert.equal(d("f(x) = 1/x"), "−1/x²");
  assert.equal(d("f(x) = ln(x)"), "1/x");
  assert.equal(d("f(x) = ln(x)/x"), "(1 − ln(x))/x²");
  assert.equal(d("f(x) = ln(x)/x", 2), "(2·ln(x) − 3)/x³");
  assert.equal(d("f(x) = ln(x² + 1)"), "2x/(x² + 1)");
  assert.equal(d("f(x) = sqrt(x)"), "1/(2√x)");
  assert.equal(d("f(x) = √(x² + 1)"), "x/√(x² + 1)");
  assert.equal(d("f(x) = sin(2x + 1)"), "2·cos(2x + 1)");
  assert.equal(d("f(x) = cos(x)²"), "−2·cos(x)·sin(x)");
  assert.equal(d("f(x) = tan(x)"), "1/cos²(x)");
  assert.equal(d("f(x) = (x + 1)³"), "3(x + 1)²");
  assert.equal(d("f(x) = 2^x"), "ln(2)·2^x");
  assert.equal(d("f(x) = eˣ/(x + 1)"), "x·eˣ/(x + 1)²");
  // Any variable name.
  assert.equal(d("g(s) = s⁴ − 2s"), "4s³ − 2");
  assert.equal(d("h(t) = t·e^(2t)"), "(2t + 1)·e²ᵗ");
});

/* ---------- Curve analysis ---------- */

test("curve analysis of a cubic: extrema, inflection point, monotony, curvature, area", () => {
  const f = "f(x) = x³ − 6x² + 9x";
  assert.equal(action(f, "Nullstellen"), "⇒ x = 0; x = 3");
  assert.equal(action(f, "Extrempunkte"), "⇒ H(1 | 4); T(3 | 0)");
  assert.equal(action(f, "Wendepunkte"), "⇒ W(2 | 2)");
  assert.equal(action(f, "Monotonie"), "⇒ streng monoton steigend für x < 1; streng monoton fallend für 1 < x < 3; streng monoton steigend für x > 3");
  assert.equal(action(f, "Krümmung"), "⇒ rechtsgekrümmt für x < 2; linksgekrümmt für x > 2");
  assert.equal(action(f, "Wendetangente"), "⇒ t(x) = −3x + 8");
  assert.equal(action(f, "Fläche mit der x-Achse"), "⇒ A = 27/4 (zwischen x = 0 und x = 3)");
  // Zeros with roots, the area exactly.
  assert.equal(action("f(x) = x³ − 3x", "Nullstellen"), "⇒ x = −√3 ≈ −1,7321; x = 0; x = √3 ≈ 1,7321");
  assert.equal(action("f(x) = x³ − 3x", "Fläche mit der x-Achse"), "⇒ A = 9/2 (zwischen x = −√3 ≈ −1,7321 und x = √3 ≈ 1,7321)");
  // x⁴ − 4x³: a saddle point at 0.
  assert.equal(action("f(x) = x^4 - 4x^3", "Wendepunkte"), "⇒ S(0 | 0); W(2 | −16)");
  assert.equal(action("f(x) = x^4 - 4x^3", "Extrempunkte"), "⇒ T(3 | −27)");
});

test("curve analysis with e and ln: exact points from logarithms", () => {
  assert.equal(action("f(x) = e^x − 2", "Nullstellen"), "⇒ x = ln(2) ≈ 0,6931");
  assert.equal(action("f(x) = x·ln(x)", "Extrempunkte"), "⇒ T(e⁻¹ ≈ 0,3679 | −e⁻¹ ≈ −0,3679)");
  assert.equal(action("f(x) = ln(x)/x", "Extrempunkte"), "⇒ H(e ≈ 2,7183 | e⁻¹ ≈ 0,3679)");
  assert.equal(action("f(x) = ln(x)/x", "Wendepunkte"), "⇒ W(e^(3/2) ≈ 4,4817 | 3/2·e^(−3/2) ≈ 0,3347)");
  assert.equal(action("f(x) = ln(x)", "Monotonie"), "⇒ streng monoton steigend für x > 0");
  assert.equal(action("f(x) = x·e^(−x)", "Extrempunkte"), "⇒ H(1 | e⁻¹ ≈ 0,3679)");
});

test("what stays numeric is marked ≈, periodic functions in −2π … 2π", () => {
  assert.equal(action("f(x) = x^5 - 5x + 1", "Nullstellen"), "⇒ x ≈ −1,5417; x ≈ 0,2001; x ≈ 1,4405");
  assert.equal(action("f(x) = x^5 - 5x + 1", "Extrempunkte"), "⇒ H(−1 | 5); T(1 | −3)");
  assert.equal(action("f(x) = sin(x)", "Nullstellen"), "⇒ x ≈ −3,1416; x ≈ 0; x ≈ 3,1416 (für −2π ≤ x ≤ 2π)");
  assert.match(action("f(x) = e^(2x) - 3e^x", "Monotonie")!, /^⇒ streng monoton fallend für x < 0,4055; streng monoton steigend für x > 0,4055 \(Grenzen gerundet\)$/);
});

test("English: the same in English school terms", () => {
  const f = "f(x) = x³ − 6x² + 9x";
  assert.equal(action(f, "Extreme points", "en"), "⇒ max (1 | 4), min (3 | 0)");
  assert.equal(action(f, "Inflection points", "en"), "⇒ inflection (2 | 2)");
  assert.equal(action(f, "Monotonicity", "en"), "⇒ strictly increasing for x < 1, strictly decreasing for 1 < x < 3, strictly increasing for x > 3");
  assert.equal(action(f, "Curvature", "en"), "⇒ right-curved (concave) for x < 2, left-curved (convex) for x > 2");
  assert.equal(action("f(x) = (x+3)·eˣ", "Extreme points", "en"), "⇒ min (−4 | −e⁻⁴ ≈ −0.01832)");
  assert.equal(action("f(x) = (x²+1)/(x−1)", "Asymptotes", "en"), "⇒ vertical: x = 1, oblique: y = x + 1");
});

/* ---------- Integrals ---------- */

test("antiderivatives where they are exact, none rather than a guess", () => {
  const F = (text: string) => action(text, "Stammfunktion");
  assert.equal(F("f(x) = 3x² − 4x + 1"), "⇒ F(x) = x³ − 2x² + x");
  assert.equal(F("f(x) = e^(2x+1)"), "⇒ F(x) = 1/2·e^(2x + 1)");
  assert.equal(F("f(x) = sin(3x)"), "⇒ F(x) = −1/3·cos(3x)");
  assert.equal(F("f(x) = cos(2x − 1)"), "⇒ F(x) = 1/2·sin(2x − 1)");
  assert.equal(F("f(x) = 1/x"), "⇒ F(x) = ln|x|");
  assert.equal(F("f(x) = 1/(2x + 1)"), "⇒ F(x) = 1/2·ln|2x + 1|");
  assert.equal(F("f(x) = 1/(x − 1)²"), "⇒ F(x) = −1/(x − 1)");
  assert.equal(F("f(x) = √x"), "⇒ F(x) = 2/3·x^(3/2)");
  assert.equal(F("f(x) = (x²+1)/(x−1)"), "⇒ F(x) = 1/2·x² + x + 2·ln|x − 1|");
  assert.equal(F("f(x) = x·sin(x)"), "⇒ F(x) = −x·cos(x) + sin(x)");
  assert.equal(F("f(x) = ln(x)"), "⇒ F(x) = x·ln(x) − x");
  assert.equal(F("f(x) = x^2·ln(x)"), "⇒ F(x) = 1/3·x³·ln(x) − 1/9·x³");
  assert.equal(F("f(x) = ln(x)/x"), "⇒ F(x) = 1/2·(ln(x))²");
  assert.equal(F("f(x) = x·(2x² − 13)^21"), "⇒ F(x) = 1/88·(2x² − 13)²²");
  // No elementary antiderivative, or none this knows: said so.
  assert.equal(F("f(x) = e^(x²)"), "⇒ keine Stammfunktion gefunden");
  assert.equal(F("f(x) = 1/(x^2+1)"), "⇒ keine Stammfunktion gefunden");
});

test("definite integrals: exact with the antiderivative, numeric without; the mean value", () => {
  assert.deepEqual(actions("∫₀² x² dx"), ["Integral: = 8/3", "Mittelwert auf [0; 2]: ⇒ m = 4/3"]);
  assert.deepEqual(actions("∫_0^π sin(x) dx"), ["Integral: = 2", "Mittelwert auf [0; π]: ⇒ m = 2/π ≈ 0,6366"]);
  assert.deepEqual(actions("∫_1^e 1/x dx"), ["Integral: = 1", "Mittelwert auf [1; e]: ⇒ m = 1/(e − 1) ≈ 0,582"]);
  assert.equal(actions("∫_0^(π/2) cos(x) dx")[0], "Integral: = 1");
  // No antiderivative: adaptive Simpson, ∫₀¹ e^(x²) dx = 1.4626517…
  assert.deepEqual(actions("∫_0^1 e^(x^2) dx"), ["Integral: ≈ 1,4627", "Mittelwert auf [0; 1]: ⇒ m ≈ 1,4627"]);
  assert.equal(actions("∫_{-1}^{1} 1/(x^2+1) dx", "en")[0], "Integral: ≈ 1.5708");
  // Not defined everywhere between the bounds.
  assert.deepEqual(actions("∫_-1^1 1/x dx"), ["Integral: ⇒ nicht überall definiert auf [−1; 1]"]);
  // Without bounds: an antiderivative + C.
  assert.deepEqual(actions("∫ 2x·e^(x²) dx"), ["Stammfunktion: = e^(x²) + C"]);
});

/* ---------- Tangents, values, intersections ---------- */

test("tangent and normal at a point, the function value", () => {
  assert.deepEqual(actions("f(x) = x² − 4x, x₀ = 1"), ["Funktionswert: ⇒ f(1) = −3", "Tangente bei x = 1: ⇒ t(x) = −2x − 1", "Normale bei x = 1: ⇒ n(x) = 1/2·x − 7/2"]);
  assert.deepEqual(actions("f(x) = eˣ, x0 = 0"), ["Funktionswert: ⇒ f(0) = 1", "Tangente bei x = 0: ⇒ t(x) = x + 1", "Normale bei x = 0: ⇒ n(x) = −x + 1"]);
  assert.equal(actions("f(x) = eˣ bei x = 1")[1], "Tangente bei x = 1: ⇒ t(x) = e·x");
  // A horizontal tangent: the normal is vertical.
  assert.equal(actions("f(x) = x², x₀ = 0")[2], "Normale bei x = 0: ⇒ x = 0");
  assert.deepEqual(actions("f(x) = x^2, x0 = 2", "en"), ["Function value: ⇒ f(2) = 4", "Tangent at x = 2: ⇒ t(x) = 4x − 4", "Normal at x = 2: ⇒ n(x) = −1/4·x + 9/2"]);
});

test("intersections of two functions", () => {
  assert.deepEqual(actions("f(x) = x², g(x) = 2x + 3"), ["Schnittpunkte: ⇒ S(−1 | 1); S(3 | 9)"]);
  assert.deepEqual(actions("f(x) = x² und g(x) = x + 1"), ["Schnittpunkte: ⇒ S(1/2 − √5/2 ≈ −0,618 | 3/2 − √5/2 ≈ 0,382); S(1/2 + √5/2 ≈ 1,618 | 3/2 + √5/2 ≈ 2,618)"]);
  assert.deepEqual(actions("f(x) = x², g(x) = −1"), ["Schnittpunkte: ⇒ keine Schnittpunkte"]);
  assert.deepEqual(actions("f(x) = e^x; g(x) = x + 2"), ["Schnittpunkte: ⇒ S(≈ −1,8414 | ≈ 0,1586); S(≈ 1,1462 | ≈ 3,1462)"]);
});

/* ---------- Limits and asymptotes ---------- */

test("limits: x → ±∞ and x → a, one- and two-sided", () => {
  const lim = (text: string, locale: L = "de") => functionActions(text, locale)[0]?.text;
  assert.equal(lim("lim x→2 (x²−4)/(x−2)"), "= 4");
  assert.equal(lim("lim x→0 sin(x)/x"), "= 1");
  assert.equal(lim("lim x→0 x·ln(x)"), "= 0");
  assert.equal(lim("lim x→0⁺ ln(x)"), "= −∞");
  assert.equal(lim("lim x→0+ 1/x"), "= ∞");
  assert.equal(lim("lim x→0- 1/x"), "= −∞");
  assert.equal(lim("lim x→0 1/x"), "⇒ existiert nicht (links −∞, rechts ∞)");
  assert.equal(lim("lim x→0 1/x", "en"), "⇒ does not exist (left −∞, right ∞)");
  assert.equal(lim("lim x→1 1/(x-1)^2"), "= ∞");
  assert.equal(lim("lim x→∞ (2x²+1)/(x²−3)"), "= 2");
  assert.equal(lim("lim x→−∞ x³ − x"), "= −∞");
  assert.equal(lim("lim x→∞ x²·e^(−x)"), "= 0");
  assert.equal(lim("lim x→∞ ln(x)/x"), "= 0");
  assert.equal(lim("lim x→∞ e^x − x^5"), "= ∞");
  assert.equal(lim("lim x→3 x² + 1"), "= 10");
  // Not exactly: numerically, with ≈.
  assert.equal(lim("lim x→∞ (1+1/x)^x"), "≈ 2,7183");
  assert.equal(lim("lim x→0 (e^x − 1)/x"), "≈ 1");
});

test("limits and asymptotes of rational functions", () => {
  const f = "f(x) = (x^2-4)/(x^2-1)";
  assert.equal(action(f, "Grenzwerte"), "⇒ lim x→−∞ f(x) = 1; lim x→−1⁻ f(x) = −∞; lim x→−1⁺ f(x) = ∞; lim x→1⁻ f(x) = ∞; lim x→1⁺ f(x) = −∞; lim x→∞ f(x) = 1");
  assert.equal(action(f, "Asymptoten"), "⇒ senkrecht: x = −1, x = 1; waagerecht: y = 1");
  assert.equal(action("f(x) = (x²+1)/(x−1)", "Asymptoten"), "⇒ senkrecht: x = 1; schief: y = x + 1");
  assert.equal(action("f(x) = (2x³ − x)/(x² + 1)", "Asymptoten"), "⇒ schief: y = 2x");
  assert.equal(action("f(x) = 1/x", "Asymptoten"), "⇒ senkrecht: x = 0; waagerecht: y = 0");
  // A gap that can be lifted is no asymptote: the limit there exists.
  assert.equal(action("f(x) = (x²−1)/(x−1)", "Grenzwerte"), "⇒ lim x→−∞ f(x) = −∞; lim x→1 f(x) = 2; lim x→∞ f(x) = ∞");
  assert.equal(action("f(x) = (x²−1)/(x−1)", "Asymptoten"), "⇒ keine Asymptoten");
  // Oblique for exponential functions too: f = x + 1 + e^(−x).
  assert.equal(action("f(x) = x + 1 + e^(−x)", "Asymptoten"), "⇒ schief: y = x + 1 (für x → ∞)");
  assert.equal(action("f(x) = ln(x)", "Asymptoten"), "⇒ senkrecht: x = 0");
});

/* ---------- Where the actions are offered ---------- */

test("only written functions get the actions; any variable name", () => {
  assert.deepEqual(functionActions("x² − 9", "de"), []);
  assert.deepEqual(functionActions("3/4 + 1/6", "de"), []);
  assert.deepEqual(functionActions("Hallo Welt", "de"), []);
  assert.deepEqual(functionActions("f(x) = 5", "de"), []);
  assert.ok(functionActions("y = x² − 2", "de").length > 5);
  assert.equal(readFunction("f(t) = ½·t³·e^(−t/3 − 3/5)", "de")?.variable, "t");
  assert.equal(readFunction("f(x) = x² ⇒ f′(x) = 2x", "de")?.body, "x²");
  // Two variables or a parameter: not a function of one variable.
  assert.equal(readFunction("f(x) = a·x²", "de"), null);
});

test("calculation hints for a function written before", () => {
  const before = ["f(x) = (x+3)·eˣ", "Some text"];
  assert.deepEqual(analysisHint("f′(x) =", before, "de"), { text: "(x + 4)·eˣ", latex: "\\left(x + 4\\right) \\cdot e^{x}" });
  assert.equal(analysisHint("f″(x) = ", before, "de")?.text, "(x + 5)·eˣ");
  assert.equal(analysisHint("f''(x) =", before, "de")?.text, "(x + 5)·eˣ");
  assert.equal(analysisHint("F(x) =", before, "de")?.text, "(x + 2)·eˣ");
  assert.equal(analysisHint("f(0) =", before, "de")?.text, "3");
  assert.equal(analysisHint("f(1) =", before, "de")?.text, "4e ≈ 10,8731");
  assert.equal(analysisHint("f′(−4) =", before, "de")?.text, "0");
  assert.equal(analysisHint("lim x→−∞ f(x) =", before, "de")?.text, "0");
  assert.equal(analysisHint("∫₀¹ f(x) dx =", before, "de")?.text, "3e − 2 ≈ 6,1548");
  assert.equal(analysisHint("Die Steigung ist f′(2) =", ["f(x) = x³"], "de")?.text, "12");
  // In the same line: "f(t) = t², f′(t) =".
  assert.equal(analysisHint("f(t) = t², f′(t) =", [], "de")?.text, "2t");
  // The nearest definition counts.
  assert.equal(analysisHint("f(2) =", ["f(x) = x", "f(x) = x²"], "de")?.text, "4");
  // Part of a calculation, nothing defined, or the definition itself: no hint.
  assert.equal(analysisHint("3 + f(0) =", before, "de"), null);
  assert.equal(analysisHint("g′(x) =", before, "de"), null);
  assert.equal(analysisHint("f(x) =", before, "de"), null);
  assert.equal(analysisHint("3 + 4 =", before, "de"), null);
});

test("graphs: derivatives, marked points and the integral", () => {
  const plot = plotFunction("(x+3)·eˣ", "de")!;
  assert.equal(plot.variable, "x");
  assert.equal(plot.derivativeText(1), "(x + 4)·eˣ");
  assert.ok(Math.abs(plot.derivative(1)!(0) - 4) < 1e-12);
  assert.deepEqual(
    plot.points().map((p) => `${p.kind} ${p.title}`),
    ["zero Nullstelle x = −3", "min Tiefpunkt T(−4 | −e⁻⁴ ≈ −0,01832)", "inflection Wendepunkt W(−5 | −2e⁻⁵ ≈ −0,01348)"],
  );
  const area = plotFunction("x²", "de")!.integral("0", "2")!;
  assert.deepEqual([area.from, area.to, area.value, area.mean], [0, 2, "8/3", "4/3"]);
  assert.equal(plotFunction("t^2", "de")!.variable, "t");
  assert.equal(plotFunction("(1; 2)", "de"), null);
});

/* ---------- Properties ---------- */

// Random school functions: sums and products of polynomials, e-powers,
// sin/cos of linear terms, powers of linear terms and quotients.
const small = fc.integer({ min: -4, max: 4 });
const linearText = fc.tuple(fc.integer({ min: 1, max: 3 }), small).map(([a, b]) => `(${a}x ${b < 0 ? "-" : "+"} ${Math.abs(b)})`);
const atom = fc.oneof(
  fc.tuple(small, fc.integer({ min: 0, max: 4 })).map(([c, n]) => `${c}x^${n}`),
  linearText.map((l) => `e^${l}`),
  linearText.map((l) => `sin${l}`),
  linearText.map((l) => `cos${l}`),
  fc.tuple(linearText, fc.integer({ min: 2, max: 5 })).map(([l, n]) => `${l}^${n}`),
);
const term = fc.oneof(
  atom,
  fc.tuple(atom, atom).map(([a, b]) => `(${a})*(${b})`),
  fc.tuple(atom, linearText).map(([a, b]) => `(${a})/(${b})`),
);
const school = fc.tuple(term, term).map(([a, b]) => `${a} + ${b}`);
const value = (ex: Ex, x: number) => compileEx(ex, "x")(x);
const close = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol * (1 + Math.abs(a) + Math.abs(b));

test("property: the symbolic derivative matches a numeric one at random points", () => {
  check(
    fc.property(school, fc.double({ min: -3, max: 3, noNaN: true }), (text, x) => {
      const read = readExpression(text, "de", "x");
      if (!read) return true;
      const f = (t: number) => value(read.ex, t);
      const h = 1e-5;
      const numeric = (f(x + h) - f(x - h)) / (2 * h);
      const symbolic = value(derivative(read.ex, "x"), x);
      if (![f(x - h), f(x + h), numeric, symbolic].every(Number.isFinite) || Math.abs(symbolic) > 1e5) return true;
      // Near a pole the difference quotient is no good.
      if (Math.abs(f(x)) > 1e5) return true;
      return close(numeric, symbolic, 1e-5);
    }),
    300,
  );
});

test("property: ∫ₐᵇ f′ = f(b) − f(a), exactly or numerically", () => {
  check(
    fc.property(school, fc.integer({ min: -3, max: 3 }), fc.integer({ min: 1, max: 3 }), (text, a, width) => {
      const read = readExpression(text, "de", "x");
      if (!read) return true;
      const b = a + width;
      const f = (t: number) => value(read.ex, t);
      const samples = Array.from({ length: 41 }, (_, i) => f(a + (width * i) / 40));
      if (!samples.every(Number.isFinite) || samples.some((y) => Math.abs(y) > 1e6)) return true;
      const derived = show(derivative(read.ex, "x"), "t", "en");
      const result = functionActions(`∫_${a}^${b} ${derived} dx`, "en")[0];
      if (!result) return true;
      const shown = Number(result.text.replace(/^.*≈\s*|^=\s*/, "").replace(/,/g, "").replace("−", "-").replace(/·10([⁻⁰¹²³⁴⁵⁶⁷⁸⁹]+)$/, ""));
      if (!Number.isFinite(shown) || /10[⁻⁰¹²³⁴⁵⁶⁷⁸⁹]/.test(result.text)) return true;
      // The shown value is rounded to 4 places (or 4 digits).
      return Math.abs(shown - (f(b) - f(a))) <= 1e-4 * (1 + Math.abs(f(b) - f(a)));
    }),
    150,
  );
});

test("property: an antiderivative differentiates back to f", () => {
  check(
    fc.property(school, fc.double({ min: -3, max: 3, noNaN: true }), (text, x) => {
      const read = readExpression(text, "de", "x");
      if (!read) return true;
      const F = antiderivative(read.ex, "x");
      if (!F) return true;
      const a = value(read.ex, x),
        b = value(derivative(F, "x"), x);
      return !Number.isFinite(a) || !Number.isFinite(b) || close(a, b, 1e-7);
    }),
    300,
  );
});

test("property: what is written reads back as the same function", () => {
  check(
    fc.property(school, fc.double({ min: -3, max: 3, noNaN: true }), (text, x) => {
      const read = readExpression(text, "de", "x");
      if (!read) return true;
      for (const ex of [read.ex, derivative(read.ex, "x")]) {
        const again = readExpression(show(ex, "t", "de"), "de", "x");
        assert.ok(again, `cannot read back ${show(ex, "t", "de")}`);
        const [p, q] = [value(ex, x), value(again.ex, x)];
        if (Number.isFinite(p) && Number.isFinite(q) && Math.abs(p) < 1e8) assert.ok(close(p, q, 1e-9), `${show(ex, "t", "de")}: ${p} ≠ ${q}`);
      }
      return true;
    }),
    300,
  );
});
