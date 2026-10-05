// Calculating with what people write in a document: "3/4 + 1/6",
// "12 × 2.400 €", "(a + b)²", "x² − 9", "2x + 3 = 11". Exact with fractions:
// numbers become reduced fractions, terms are expanded or factored with an
// exact polynomial arithmetic, equations in one variable are solved (linear
// and quadratic exactly, higher degrees through rational roots). mathjs
// only parses; the algebra is our own, so the output reads like a school
// notebook ("a² + 2ab + b²", not "a ^ 2 + a * b + b * a + b ^ 2").
import { evaluate, fraction, parse, type Fraction, type MathNode } from "mathjs";
import type { Locale } from "./i18n";

export type MathActionKind = "result" | "decimal" | "reduce" | "expand" | "factor" | "solve";
export type MathAction = {
  kind: MathActionKind;
  label: string;
  // Text to insert after the expression ("= 11/12", "⇒ x = 4") and the same
  // as LaTeX for formulas.
  text: string;
  latex: string;
};

const MAX_DEGREE = 12;
const MAX_TERMS = 200;
const MAX_INPUT = 300;

/* ---------- Reading what people write ---------- */

const FUNCTIONS = new Set(["sqrt", "pi"]);
const VULGAR: Record<string, string> = {
  "½": "1/2", "⅓": "1/3", "⅔": "2/3", "¼": "1/4", "¾": "3/4", "⅕": "1/5", "⅖": "2/5", "⅗": "3/5", "⅘": "4/5",
  "⅙": "1/6", "⅚": "5/6", "⅐": "1/7", "⅛": "1/8", "⅜": "3/8", "⅝": "5/8", "⅞": "7/8", "⅑": "1/9", "⅒": "1/10",
};

// Turns written maths into mathjs syntax. Returns null when the text is not
// a calculation (words, no operator, too long).
export function normalize(text: string, locale: Locale): { expr: string; unit: string } | null {
  let s = text.trim();
  if (!s || s.length > MAX_INPUT) return null;
  // A trailing "=" asks for the result.
  s = s.replace(/=\s*$/, "").trim();
  if (!s) return null;
  // Currency: one symbol, carried to the result.
  const units = new Set(s.match(/[€$£]/g) || []);
  if (units.size > 1) return null;
  const unit = [...units][0] || "";
  s = s.replace(/[€$£]/g, " ");
  // Fractions the editor's typography made of "3/4".
  s = s.replace(/[½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅐⅛⅜⅝⅞⅑⅒]/g, (c) => ` (${VULGAR[c]}) `);
  s = s
    .replace(/[−–—]/g, "-")
    .replace(/[×·⋅∙]/g, "*")
    .replace(/[÷]/g, "/")
    .replace(/π/g, " pi ")
    .replace(/²/g, "^2")
    .replace(/³/g, "^3")
    .replace(/√\s*\(/g, "sqrt(")
    .replace(/√\s*([0-9a-zA-Z.,]+)/g, "sqrt($1)")
    .replace(/(\d)\s*%/g, "$1/100");
  // Numbers: German "2.400,5" or English "2,400.5".
  if (locale === "de")
    s = s.replace(/\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+,\d+/g, (n) => n.replace(/\./g, "").replace(",", "."));
  else s = s.replace(/\d{1,3}(?:,\d{3})+(?:\.\d+)?/g, (n) => n.replace(/,/g, ""));
  // Division written as ":" between operands.
  s = s.replace(/:/g, "/");
  if (/[^0-9a-zA-Z.+\-*/^()=\s]/.test(s)) return null;
  // Words are text, not maths; "ab" is a product of two variables.
  for (const word of s.match(/[a-zA-Z]{3,}/g) || []) if (!FUNCTIONS.has(word)) return null;
  s = s.replace(/[a-zA-Z]+/g, (word) => (FUNCTIONS.has(word) ? word : word.split("").join("*")));
  // Something to calculate: an operator, a function or a power.
  if (!/[+\-*/^]|sqrt|pi/.test(s.replace(/^\s*-/, ""))) return null;
  if ((s.match(/=/g) || []).length > 1) return null;
  return { expr: s.replace(/\s+/g, " ").trim(), unit };
}

/* ---------- Exact polynomials ---------- */

type Monomial = Record<string, number>;
type Term = { mono: Monomial; coef: Fraction };
type Poly = Map<string, Term>;
class NotPolynomial extends Error {}

const ZERO = fraction(0);
const ONE = fraction(1);
const keyOf = (mono: Monomial) =>
  Object.keys(mono)
    .sort()
    .map((v) => `${v}^${mono[v]}`)
    .join("*");
const constant = (c: Fraction): Poly => (c.equals(0) ? new Map() : new Map([["", { mono: {}, coef: c }]]));
const variable = (name: string): Poly => new Map([[`${name}^1`, { mono: { [name]: 1 }, coef: ONE }]]);

function addTo(poly: Poly, mono: Monomial, coef: Fraction) {
  const key = keyOf(mono);
  const sum = (poly.get(key)?.coef || ZERO).add(coef);
  if (sum.equals(0)) poly.delete(key);
  else poly.set(key, { mono, coef: sum });
  if (poly.size > MAX_TERMS) throw new NotPolynomial("too many terms");
}
const add = (a: Poly, b: Poly, sign = 1) => {
  const out: Poly = new Map(a);
  for (const t of b.values()) addTo(out, t.mono, sign < 0 ? t.coef.neg() : t.coef);
  return out;
};
function mul(a: Poly, b: Poly): Poly {
  const out: Poly = new Map();
  for (const x of a.values())
    for (const y of b.values()) {
      const mono: Monomial = { ...x.mono };
      for (const [v, e] of Object.entries(y.mono)) mono[v] = (mono[v] || 0) + e;
      addTo(out, mono, x.coef.mul(y.coef));
    }
  return out;
}
const scale = (a: Poly, c: Fraction) => mul(a, constant(c));
const degree = (p: Poly, v?: string) =>
  Math.max(0, ...[...p.values()].map((t) => (v ? t.mono[v] || 0 : Object.values(t.mono).reduce((s, e) => s + e, 0))));
const variablesOf = (p: Poly) => [...new Set([...p.values()].flatMap((t) => Object.keys(t.mono)))].sort();
const isConstant = (p: Poly) => variablesOf(p).length === 0;
const constantOf = (p: Poly) => p.get("")?.coef || ZERO;

function toPoly(node: MathNode): Poly {
  switch (node.type) {
    case "ConstantNode": {
      const value = (node as unknown as { value: unknown }).value;
      if (typeof value !== "number" || !Number.isFinite(value)) throw new NotPolynomial("constant");
      return constant(fraction(value));
    }
    case "SymbolNode": {
      const name = (node as unknown as { name: string }).name;
      if (!/^[a-zA-Z]$/.test(name)) throw new NotPolynomial(name);
      return variable(name);
    }
    case "ParenthesisNode":
      return toPoly((node as unknown as { content: MathNode }).content);
    case "OperatorNode": {
      const { fn, args } = node as unknown as { fn: string; args: MathNode[] };
      if (fn === "unaryMinus") return scale(toPoly(args[0]), fraction(-1));
      if (fn === "unaryPlus") return toPoly(args[0]);
      const [a, b] = args.map(toPoly);
      if (fn === "add") return add(a, b);
      if (fn === "subtract") return add(a, b, -1);
      if (fn === "multiply") return mul(a, b);
      if (fn === "divide") {
        if (!isConstant(b) || constantOf(b).equals(0)) throw new NotPolynomial("division");
        return scale(a, ONE.div(constantOf(b)));
      }
      if (fn === "pow") {
        const e = constantOf(b);
        if (!isConstant(b) || e.d !== 1n || e.s < 0 || Number(e.n) > MAX_DEGREE) throw new NotPolynomial("power");
        let out = constant(ONE);
        for (let i = 0; i < Number(e.n); i++) out = mul(out, a);
        return out;
      }
      throw new NotPolynomial(fn);
    }
    default:
      throw new NotPolynomial(node.type);
  }
}

/* ---------- Writing results ---------- */

const SUPER: Record<string, string> = { "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹" };
const superscript = (n: number) => String(n).replace(/\d/g, (d) => SUPER[d]);

function decimal(value: number, locale: Locale) {
  return value
    .toLocaleString(locale === "de" ? "de-DE" : "en-GB", { maximumFractionDigits: 6, useGrouping: true })
    .replace(/^-/, "−");
}
// Two ways of writing the same thing ("(a+b)^2" and "(a + b)²").
const sameWriting = (a: string, b: string) => {
  const plain = (x: string) => x.replace(/[\s*·]/g, "").replace(/\^\((\d+)\)/g, "^$1").replace(/[−–]/g, "-").replace(/\^2/g, "²").replace(/\^3/g, "³");
  return plain(a) === plain(b);
};
// A fraction as text: "11/12", "−3", "2.400" (whole numbers with grouping).
function fracText(f: Fraction, locale: Locale) {
  const sign = f.s < 0 ? "−" : "";
  const n = f.n.toString(),
    d = f.d.toString();
  const whole = (x: string) => decimal(Number(x), locale);
  return d === "1" ? `${sign}${whole(n)}` : `${sign}${n}/${d}`;
}
function fracLatex(f: Fraction) {
  const sign = f.s < 0 ? "-" : "";
  return f.d === 1n ? `${sign}${f.n}` : `${sign}\\frac{${f.n}}{${f.d}}`;
}
function sortedTerms(p: Poly) {
  const order = (m: Monomial) => Object.keys(m).sort();
  return [...p.values()].sort((x, y) => {
    const dx = degree(new Map([["", x]])),
      dy = degree(new Map([["", y]]));
    if (dx !== dy) return dy - dx;
    for (const v of [...new Set([...order(x.mono), ...order(y.mono)])].sort()) {
      const diff = (y.mono[v] || 0) - (x.mono[v] || 0);
      if (diff) return diff;
    }
    return 0;
  });
}
function polyText(p: Poly, locale: Locale): string {
  if (!p.size) return "0";
  return sortedTerms(p)
    .map((t, i) => {
      const vars = Object.keys(t.mono)
        .sort()
        .map((v) => (t.mono[v] === 1 ? v : `${v}${superscript(t.mono[v])}`))
        .join("");
      const abs = t.coef.abs();
      const coef = vars && abs.equals(1) ? "" : fracText(abs, locale) + (vars && abs.d !== 1n ? "·" : "");
      const sign = t.coef.s < 0 ? (i ? " − " : "−") : i ? " + " : "";
      return `${sign}${coef}${vars}`;
    })
    .join("");
}
function polyLatex(p: Poly): string {
  if (!p.size) return "0";
  return sortedTerms(p)
    .map((t, i) => {
      const vars = Object.keys(t.mono)
        .sort()
        .map((v) => (t.mono[v] === 1 ? v : `${v}^{${t.mono[v]}}`))
        .join("");
      const abs = t.coef.abs();
      const coef = vars && abs.equals(1) ? "" : fracLatex(abs);
      const sign = t.coef.s < 0 ? (i ? " - " : "-") : i ? " + " : "";
      return `${sign}${coef}${vars}`;
    })
    .join("");
}

/* ---------- Factoring ---------- */

const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? (a < 0n ? -a : a) : gcd(b, a % b));
const lcm = (a: bigint, b: bigint) => (a / gcd(a, b)) * b;
function divisors(n: bigint): bigint[] {
  n = n < 0n ? -n : n;
  if (n === 0n || n > 1_000_000n) return n === 0n ? [] : [1n];
  const out: bigint[] = [];
  for (let i = 1n; i * i <= n; i++)
    if (n % i === 0n) {
      out.push(i);
      if (i * i !== n) out.push(n / i);
    }
  return out;
}
// Coefficients of a polynomial in one variable, lowest degree first.
function coefficients(p: Poly, v: string): Fraction[] {
  const out = Array.from({ length: degree(p, v) + 1 }, () => ZERO);
  for (const t of p.values()) out[t.mono[v] || 0] = out[t.mono[v] || 0].add(t.coef);
  return out;
}
const evaluateAt = (c: Fraction[], x: Fraction) => c.reduceRight((acc, k) => acc.mul(x).add(k), ZERO);
function divideByRoot(c: Fraction[], r: Fraction): Fraction[] {
  const out: Fraction[] = [];
  let carry = ZERO;
  for (let i = c.length - 1; i > 0; i--) {
    carry = carry.mul(r).add(c[i]);
    out.unshift(carry);
  }
  return out;
}
// Rational roots of a polynomial (rational root theorem), with multiplicity.
function rationalRoots(c: Fraction[]): { roots: Fraction[]; rest: Fraction[] } {
  let coef = c.slice();
  const roots: Fraction[] = [];
  while (coef.length > 1 && coef[0].equals(0)) {
    roots.push(ZERO);
    coef = coef.slice(1);
  }
  for (let guard = 0; coef.length > 2 && guard < MAX_DEGREE; guard++) {
    const common = coef.reduce((m, k) => lcm(m, k.d), 1n);
    const ints = coef.map((k) => (k.mul(fraction(common.toString())).n * BigInt(k.s)) as bigint);
    let found: Fraction | null = null;
    for (const p of divisors(ints[0]))
      for (const q of divisors(ints[ints.length - 1]))
        for (const sign of [1, -1]) {
          const r = fraction(`${sign * Number(p)}/${Number(q)}`);
          if (!found && evaluateAt(coef, r).equals(0)) found = r;
        }
    if (!found) break;
    roots.push(found);
    coef = divideByRoot(coef, found);
  }
  if (coef.length === 2) {
    roots.push(coef[0].neg().div(coef[1]));
    coef = [coef[1]];
  }
  return { roots, rest: coef };
}

type Factored = { text: string; latex: string };
// (q·x − p) for the root p/q, written with whole numbers.
function linearFactor(v: string, r: Fraction, locale: Locale): Factored {
  const q = r.d.toString(),
    p = r.abs().n.toString();
  const lead = q === "1" ? v : `${q}${v}`;
  if (r.equals(0)) return { text: v, latex: v };
  const op = r.s < 0 ? "+" : "−";
  return { text: `(${lead} ${op} ${decimal(Number(p), locale)})`, latex: `\\left(${lead} ${op === "+" ? "+" : "-"} ${p}\\right)` };
}
function joinFactors(lead: Fraction, factors: Factored[], rest: Poly | null, locale: Locale): Factored | null {
  const counts = new Map<string, { f: Factored; n: number }>();
  for (const f of factors) counts.set(f.text, { f, n: (counts.get(f.text)?.n || 0) + 1 });
  const parts = [...counts.values()];
  const text =
    (lead.equals(1) ? "" : lead.equals(-1) ? "−" : fracText(lead, locale)) +
    parts.map(({ f, n }) => f.text + (n > 1 ? superscript(n) : "")).join("") +
    (rest ? `(${polyText(rest, locale)})` : "");
  const latex =
    (lead.equals(1) ? "" : lead.equals(-1) ? "-" : fracLatex(lead)) +
    parts.map(({ f, n }) => f.latex + (n > 1 ? `^{${n}}` : "")).join("") +
    (rest ? `\\left(${polyLatex(rest)}\\right)` : "");
  return parts.length || rest ? { text, latex } : null;
}
function factor(p: Poly, locale: Locale): Factored | null {
  if (p.size < 2) return null;
  const terms = [...p.values()];
  // Common factor: number and variables in every term.
  const num = terms.reduce((g, t) => gcd(g, t.coef.n), 0n);
  const den = terms.reduce((l, t) => lcm(l, t.coef.d), 1n);
  let lead = fraction(`${num}/${den}`);
  if (terms[0] && sortedTerms(p)[0].coef.s < 0) lead = lead.neg();
  const common: Monomial = {};
  for (const v of variablesOf(p)) {
    const min = Math.min(...terms.map((t) => t.mono[v] || 0));
    if (min) common[v] = min;
  }
  let inner: Poly = new Map();
  for (const t of terms) {
    const mono: Monomial = { ...t.mono };
    for (const [v, e] of Object.entries(common)) {
      mono[v] -= e;
      if (!mono[v]) delete mono[v];
    }
    addTo(inner, mono, t.coef.div(lead));
  }
  const commonText = Object.keys(common)
    .sort()
    .map((v) => ({ text: common[v] === 1 ? v : `${v}${superscript(common[v])}`, latex: common[v] === 1 ? v : `${v}^{${common[v]}}` }));
  const vars = variablesOf(inner);
  const factors: Factored[] = [...commonText];
  let rest: Poly | null = inner;
  if (vars.length === 1 && degree(inner) >= 2) {
    const v = vars[0];
    const { roots, rest: remaining } = rationalRoots(coefficients(inner, v));
    if (roots.length) {
      // The leading factor of each root (q·x − p) carries q; adjust the lead.
      let adjust = ONE;
      for (const r of roots) {
        factors.push(linearFactor(v, r, locale));
        adjust = adjust.mul(fraction(r.d.toString()));
      }
      lead = lead.div(adjust);
      if (remaining.length > 1) {
        const restPoly: Poly = new Map();
        remaining.forEach((k, i) => !k.equals(0) && addTo(restPoly, i ? { [v]: i } : {}, k));
        rest = restPoly;
      } else {
        lead = lead.mul(remaining[0] || ONE);
        rest = null;
      }
    }
  } else if (vars.length === 2 && degree(inner) === 2 && [...inner.values()].every((t) => degree(new Map([["", t]])) === 2)) {
    // A·x² + B·xy + C·y²: the binomial formulas and their relatives.
    const [x, y] = vars;
    const A = inner.get(`${x}^2`)?.coef || ZERO,
      B = inner.get(`${x}^1*${y}^1`)?.coef || ZERO,
      C = inner.get(`${y}^2`)?.coef || ZERO;
    const roots = A.equals(0) ? [] : rationalRoots([C, B, A]).roots;
    if (roots.length === 2) {
      let adjust = ONE;
      for (const r of roots) {
        const f = linearFactor(x, r, locale);
        factors.push({ text: f.text.replace(/\)$/, `${y})`).replace(/ 1\)$/, ")").replace(/(\d)\)$/, "$1)"), latex: f.latex.replace(/\\right\)$/, `${y}\\right)`) });
        adjust = adjust.mul(fraction(r.d.toString()));
      }
      // "1y" reads as "y".
      for (const f of factors) {
        f.text = f.text.replace(/ 1([a-zA-Z])\)/, " $1)");
        f.latex = f.latex.replace(/ 1([a-zA-Z])\\right\)/, " $1\\right)");
      }
      lead = lead.mul(A).div(adjust);
      rest = null;
    }
  }
  if (rest && factors.length === 0 && lead.equals(1)) return null;
  if (rest && degree(rest) === 0) {
    lead = lead.mul(constantOf(rest));
    rest = null;
  }
  return joinFactors(lead, factors, rest, locale);
}

/* ---------- Solving ---------- */

// √(n/d) as p·√r with whole numbers: √(8/9) = 2/3·√2.
function surd(value: Fraction): { outside: Fraction; inside: bigint } {
  let k = value.n * value.d;
  let outside = 1n;
  for (let i = 2n; i * i <= k && i < 100_000n; i++)
    while (k % (i * i) === 0n) {
      k /= i * i;
      outside *= i;
    }
  return { outside: fraction(`${outside}/${value.d}`), inside: k };
}
function solve(p: Poly, v: string, locale: Locale): MathAction | null {
  const c = coefficients(p, v);
  if (c.length < 2 || c.slice(1).every((k) => k.equals(0))) return null;
  const solution = (values: string[], latex: string[]): MathAction => ({
    kind: "solve",
    label: locale === "de" ? `Nach ${v} auflösen` : `Solve for ${v}`,
    text: values.length ? `⇒ ${values.join(", ")}` : locale === "de" ? "⇒ keine reelle Lösung" : "⇒ no real solution",
    latex: values.length ? `\\Rightarrow ${latex.join(",\\ ")}` : "\\Rightarrow \\emptyset",
  });
  const { roots, rest } = rationalRoots(c);
  const unique = [...new Map(roots.map((r) => [r.toFraction(), r])).values()].sort((a, b) => a.compare(b));
  const texts = unique.map((r) => `${v} = ${fracText(r, locale)}`);
  const latex = unique.map((r) => `${v} = ${fracLatex(r)}`);
  if (rest.length === 3) {
    const [cc, bb, aa] = rest;
    const D = bb.mul(bb).sub(aa.mul(cc).mul(4));
    if (D.s >= 0) {
      const center = bb.neg().div(aa.mul(2));
      const { outside, inside } = surd(D);
      const spread = outside.div(aa.mul(2)).abs();
      const root = `${spread.equals(1) ? "" : fracText(spread, locale) + "·"}√${inside}`;
      const around = center.equals(0) ? `±${root}` : `${fracText(center, locale)} ± ${root}`;
      const approx = [center.valueOf() - spread.valueOf() * Math.sqrt(Number(inside)), center.valueOf() + spread.valueOf() * Math.sqrt(Number(inside))];
      texts.push(`${v} = ${around} (≈ ${approx.map((n) => decimal(n, locale)).join(locale === "de" ? "; " : ", ")})`);
      latex.push(`${v} = ${center.equals(0) ? "" : fracLatex(center)} \\pm ${spread.equals(1) ? "" : fracLatex(spread)}\\sqrt{${inside}}`);
    }
  } else if (rest.length > 3) return null;
  return solution(texts, latex);
}

/* ---------- Actions ---------- */

// What can be done with a written expression, best first. Empty when it is
// not a calculation.
export function mathActions(text: string, locale: Locale): MathAction[] {
  const input = normalize(text, locale);
  if (!input) return [];
  const de = locale === "de";
  const unit = input.unit ? ` ${input.unit}` : "";
  try {
    // Equations: solve for each variable.
    if (input.expr.includes("=")) {
      const [left, right] = input.expr.split("=");
      if (!left.trim() || !right.trim()) return [];
      const p = add(toPoly(parse(left)), toPoly(parse(right)), -1);
      const vars = variablesOf(p);
      if (vars.length === 1) {
        const s = solve(p, vars[0], locale);
        return s ? [s] : [];
      }
      // Several variables: solve for each one that appears linearly.
      return vars
        .filter((v) => degree(p, v) === 1 && [...p.values()].every((t) => !t.mono[v] || Object.keys(t.mono).length === 1))
        .map((v) => {
          const a = p.get(`${v}^1`)!.coef;
          const restPoly: Poly = new Map();
          for (const t of p.values()) if (!t.mono[v]) addTo(restPoly, t.mono, t.coef.neg().div(a));
          return { kind: "solve", label: de ? `Nach ${v} auflösen` : `Solve for ${v}`, text: `⇒ ${v} = ${polyText(restPoly, locale)}`, latex: `\\Rightarrow ${v} = ${polyLatex(restPoly)}` } as MathAction;
        });
    }
    const node = parse(input.expr);
    let poly: Poly | null = null;
    try {
      poly = toPoly(node);
    } catch (error) {
      if (!(error instanceof NotPolynomial)) throw error;
    }
    // Numbers only.
    if (!poly || isConstant(poly)) {
      if (poly) {
        const value = constantOf(poly);
        const actions: MathAction[] = [];
        const single = /^\s*-?\d+(\.\d+)?\s*\/\s*\d+(\.\d+)?\s*$/.test(input.expr);
        const resultText = fracText(value, locale);
        if (single) {
          if (resultText.replace(/\./g, "") !== input.expr.replace(/\s/g, "").replace("-", "−"))
            actions.push({ kind: "reduce", label: de ? "Kürzen" : "Reduce", text: `= ${resultText}${unit}`, latex: `= ${fracLatex(value)}` });
        } else actions.push({ kind: "result", label: de ? "Ergebnis" : "Result", text: `= ${resultText}${unit}`, latex: `= ${fracLatex(value)}` });
        if (value.d !== 1n)
          actions.push({
            kind: "decimal",
            label: de ? "Als Dezimalzahl" : "As a decimal",
            text: `≈ ${decimal(value.valueOf(), locale)}${unit}`,
            latex: `\\approx ${decimal(value.valueOf(), locale).replace(",", "{,}")}`,
          });
        return actions;
      }
      // Roots, π …: a decimal result.
      if (/[a-zA-Z]/.test(input.expr.replace(/sqrt|pi/g, ""))) return [];
      const value = Number(evaluate(input.expr));
      if (!Number.isFinite(value)) return [];
      const exact = Number.isInteger(Math.round(value * 1e9) / 1e9) && Math.abs(value - Math.round(value)) < 1e-9;
      const shown = decimal(exact ? Math.round(value) : value, locale);
      return [{ kind: exact ? "result" : "decimal", label: de ? "Ergebnis" : "Result", text: `${exact ? "=" : "≈"} ${shown}${unit}`, latex: `${exact ? "=" : "\\approx"} ${shown.replace(",", "{,}")}` }];
    }
    // Terms: expand and factor.
    const actions: MathAction[] = [];
    const expanded = polyText(poly, locale);
    if (!sameWriting(expanded, input.expr))
      actions.push({ kind: "expand", label: de ? "Ausmultiplizieren" : "Expand", text: `= ${expanded}`, latex: `= ${polyLatex(poly)}` });
    const factored = factor(poly, locale);
    if (factored && !sameWriting(factored.text, expanded) && !sameWriting(factored.text, input.expr))
      actions.push({ kind: "factor", label: de ? "Faktorisieren" : "Factor", text: `= ${factored.text}`, latex: `= ${factored.latex}` });
    return actions;
  } catch {
    return [];
  }
}

// The calculation at the end of a line that ends with "=", for the hint
// while typing: "Budget: 12 × 2.400 € =" → "12 × 2.400 €".
export function trailingExpression(line: string): string | null {
  if (!/=\s*$/.test(line)) return null;
  const body = line.replace(/=\s*$/, "");
  // The longest end of the line made of maths characters and short words.
  const match = body.match(/(?:[0-9a-zA-Z.,+\-−–*/×·÷:^²³√π()€$£%½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅐⅛⅜⅝⅞⅑⅒\s])+$/);
  if (!match) return null;
  let candidate = match[0];
  // Drop leading words (text before the calculation).
  candidate = candidate.replace(/^.*?(?:[a-zA-ZäöüÄÖÜß]{3,}[\s:]*)+(?=[^a-zA-Z]*$|[\d(√π−-])/s, "");
  candidate = candidate.trim();
  // A calculation starts with a number, a variable, a bracket or a sign –
  // not with "+ 1/6" (then something before it was not understood).
  return candidate && !/^[+*/×·÷:^]/.test(candidate) ? candidate : null;
}

// A LaTeX formula as written maths, for calculating with formulas:
// \frac{3}{4} + \sqrt{x} \cdot 2 → (3)/(4) + √(x) * 2. Null when it uses
// something this calculator does not know (integrals, sums, matrices …).
export function latexToExpression(latex: string): string | null {
  let s = latex.trim();
  if (!s || s.length > MAX_INPUT * 2) return null;
  s = s
    .replace(/\\left|\\right/g, "")
    .replace(/\\[,;: !]|~/g, " ")
    .replace(/\\(cdot|times|ast)/g, "*")
    .replace(/\\div/g, "/")
    .replace(/\\pi/g, "π")
    .replace(/\\(dfrac|tfrac)/g, "\\frac");
  // Innermost first: \frac{a}{b}, \sqrt{x}, ^{n}.
  const rules: [RegExp, string][] = [
    [/\\frac\{([^{}]*)\}\{([^{}]*)\}/, "(($1)/($2))"],
    [/\\sqrt\{([^{}]*)\}/, "√($1)"],
    [/\^\{([^{}]*)\}/, "^($1)"],
    [/\{([^{}]*)\}/, "($1)"],
  ];
  // One rule at a time, the first that applies: plain braces only once no
  // fraction or root is left that still needs them.
  for (let guard = 0; guard < 100; guard++) {
    const rule = rules.find(([pattern]) => pattern.test(s));
    if (!rule) break;
    s = s.replace(rule[0], rule[1]);
  }
  if (/\\|_/.test(s)) return null;
  return s;
}
