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
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]+/g, (digits) => `^${[...digits].map((d) => "⁰¹²³⁴⁵⁶⁷⁸⁹".indexOf(d)).join("")}`)
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
  const plain = (x: string) =>
    x
      .replace(/[\s*·]/g, "")
      .replace(/\^\((\d+)\)/g, "^$1")
      .replace(/[−–]/g, "-")
      .replace(/\^(\d+)/g, (_, n: string) => superscript(Number(n)));
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

const termDegree = (t: Term) => Object.values(t.mono).reduce((s, e) => s + e, 0);
const fromTerms = (terms: Term[]) => {
  const out: Poly = new Map();
  for (const t of terms) addTo(out, t.mono, t.coef);
  return out;
};
// The same polynomial written the same way (for comparing factors).
const polyKey = (p: Poly) => sortedTerms(p).map((t) => `${t.coef.toFraction()}*${keyOf(t.mono)}`).join("+");
const leadingTerm = (p: Poly) => sortedTerms(p)[0];
// p = content · primitive: whole, coprime coefficients and a positive
// leading coefficient ("2x + 3" from "4/3·x + 2").
function primitive(p: Poly): { content: Fraction; poly: Poly } {
  const terms = [...p.values()];
  if (!terms.length) return { content: ZERO, poly: p };
  const num = terms.reduce((g, t) => gcd(g, t.coef.n), 0n);
  const den = terms.reduce((l, t) => lcm(l, t.coef.d), 1n);
  let content = fraction(`${num}/${den}`);
  if (leadingTerm(p).coef.s < 0) content = content.neg();
  return { content, poly: scale(p, ONE.div(content)) };
}
// a / b when b divides a exactly, else null (division with a graded order).
function divideExact(a: Poly, b: Poly): Poly | null {
  if (!b.size) return null;
  const lb = leadingTerm(b);
  let rest: Poly = new Map(a);
  const quotient: Poly = new Map();
  for (let guard = 0; rest.size && guard < 400; guard++) {
    const lr = leadingTerm(rest);
    const mono: Monomial = { ...lr.mono };
    for (const [v, e] of Object.entries(lb.mono)) {
      mono[v] = (mono[v] || 0) - e;
      if (mono[v] < 0) return null;
      if (!mono[v]) delete mono[v];
    }
    const step = new Map([[keyOf(mono), { mono, coef: lr.coef.div(lb.coef) }]]);
    addTo(quotient, mono, lr.coef.div(lb.coef));
    rest = add(rest, mul(step, b), -1);
  }
  return rest.size ? null : quotient;
}
// √p for a perfect square polynomial, else null.
function polySqrt(p: Poly): Poly | null {
  if (!p.size) return new Map();
  const squareRoot = (f: Fraction) => {
    if (f.s < 0) return null;
    const n = BigInt(Math.round(Math.sqrt(Number(f.n)))),
      d = BigInt(Math.round(Math.sqrt(Number(f.d))));
    return n * n === f.n && d * d === f.d ? fraction(`${n}/${d}`) : null;
  };
  const lt = leadingTerm(p);
  const c = squareRoot(lt.coef);
  if (!c || Object.values(lt.mono).some((e) => e % 2)) return null;
  const rootMono = Object.fromEntries(Object.entries(lt.mono).map(([v, e]) => [v, e / 2]));
  let root = fromTerms([{ mono: rootMono, coef: c }]);
  for (let guard = 0; guard < 60; guard++) {
    const rest = add(p, mul(root, root), -1);
    if (!rest.size) return root;
    const lr = leadingTerm(rest);
    const step = divideExact(fromTerms([lr]), fromTerms([{ mono: rootMono, coef: c.mul(2) }]));
    if (!step || step.size !== 1) return null;
    root = add(root, step);
  }
  return null;
}
// The rational root p/q of the variable as the factor q·v − p.
const linearIn = (v: string, r: Fraction): Poly =>
  primitive(add(variable(v), constant(r), -1)).poly;

// Ways to split a primitive polynomial into two factors, tried in order.
function split(q: Poly): [Poly, Poly] | null {
  const vars = variablesOf(q);
  const terms = [...q.values()];
  const tryFactor = (f: Poly) => {
    const g = primitive(f).poly;
    if (isConstant(g) || polyKey(g) === polyKey(q)) return null;
    const rest = divideExact(q, g);
    return rest ? ([g, rest] as [Poly, Poly]) : null;
  };
  // One variable: rational roots.
  if (vars.length === 1) {
    const v = vars[0];
    const { roots } = rationalRoots(coefficients(q, v));
    if (roots.length && degree(q) > 1) return tryFactor(linearIn(v, roots[0]));
    return null;
  }
  // All terms powers of one monomial (x²y² − 1, a⁴b² − c⁰ …): substitute u.
  {
    const vectors = terms.map((t) => vars.map((v) => t.mono[v] || 0));
    const base = vectors.find((vec) => vec.some((e) => e));
    if (base) {
      const g = base.reduce((a, b) => Number(gcd(BigInt(a), BigInt(b))), 0);
      const unit = base.map((e) => e / g);
      const powers = vectors.map((vec) => {
        const k = unit.findIndex((u) => u) >= 0 ? vec[unit.findIndex((u) => u)] / unit[unit.findIndex((u) => u)] : 0;
        return Number.isInteger(k) && vec.every((e, i) => e === unit[i] * k) ? k : -1;
      });
      if (powers.every((k) => k >= 0) && Math.max(...powers) > 1) {
        const c = Array.from({ length: Math.max(...powers) + 1 }, () => ZERO);
        terms.forEach((t, i) => (c[powers[i]] = c[powers[i]].add(t.coef)));
        const { roots } = rationalRoots(c);
        if (roots.length) {
          const mono = Object.fromEntries(vars.map((v, i) => [v, unit[i]]).filter(([, e]) => e));
          const found = tryFactor(add(fromTerms([{ mono, coef: fraction(roots[0].d.toString()) }]), constant(fraction(roots[0].s < 0 ? `-${roots[0].n}` : roots[0].n.toString())), -1));
          if (found) return found;
        }
      }
    }
  }
  // Homogeneous in two variables (a³ − b³, x² + 2xy + y² …): t = x / y.
  if (vars.length === 2 && new Set(terms.map(termDegree)).size === 1) {
    const [x, y] = vars;
    const n = termDegree(terms[0]);
    const c = Array.from({ length: n + 1 }, () => ZERO);
    for (const t of terms) c[t.mono[x] || 0] = c[t.mono[x] || 0].add(t.coef);
    const { roots } = rationalRoots(c);
    if (roots.length) {
      const r = roots[0];
      const found = tryFactor(add(scale(variable(x), fraction(r.d.toString())), scale(variable(y), fraction(r.s < 0 ? `-${r.n}` : r.n.toString())), -1));
      if (found) return found;
    }
  }
  // Quadratic in one variable with a perfect-square discriminant:
  // x² + 2xy + y² − 1 = (x + y − 1)(x + y + 1), (x + 1)² − y² …
  for (const v of vars) {
    if (degree(q, v) !== 2) continue;
    const part = (k: number) => {
      const out: Poly = new Map();
      for (const t of terms)
        if ((t.mono[v] || 0) === k) {
          const mono = { ...t.mono };
          delete mono[v];
          addTo(out, mono, t.coef);
        }
      return out;
    };
    const A = part(2),
      B = part(1),
      C = part(0);
    if (!isConstant(A)) continue;
    const a = constantOf(A);
    const S = polySqrt(add(mul(B, B), scale(C, a.mul(4)), -1));
    if (!S) continue;
    // v − (−B + S)/(2a)
    const root = scale(add(scale(B, fraction(-1)), S), ONE.div(a.mul(2)));
    const found = tryFactor(add(variable(v), root, -1));
    if (found) return found;
  }
  // Grouping: ax + ay + bx + by = (a + b)(x + y), also 3 + 3 terms.
  if (terms.length === 4 || terms.length === 6) {
    const half = terms.length / 2;
    const choose = (from: number[], k: number): number[][] =>
      k === 0 ? [[]] : from.flatMap((i, j) => choose(from.slice(j + 1), k - 1).map((rest) => [i, ...rest]));
    for (const group of choose([...terms.keys()], half)) {
      if (!group.includes(0)) continue;
      const one = fromTerms(group.map((i) => terms[i]));
      const found = tryFactor(primitive(commonFree(one)).poly);
      if (found) return found;
    }
  }
  return null;
}
// p without the monomial every term shares (6x²y + 9xy → 6x + 9).
function commonFree(p: Poly): Poly {
  const terms = [...p.values()];
  const common: Monomial = {};
  for (const v of variablesOf(p)) {
    const min = Math.min(...terms.map((t) => t.mono[v] || 0));
    if (min) common[v] = min;
  }
  return divideExact(p, fromTerms([{ mono: common, coef: ONE }])) || p;
}

// Factors with whole coefficients and a leading number: 6x² − 6 →
// 6 · (x − 1) · (x + 1).
function factorPoly(p: Poly): { lead: Fraction; factors: Poly[] } {
  if (!p.size) return { lead: ZERO, factors: [] };
  const { content, poly } = primitive(p);
  let lead = content;
  const factors: Poly[] = [];
  // Variables in every term.
  const free = commonFree(poly);
  const common = divideExact(poly, free)!;
  for (const [v, e] of Object.entries(leadingTerm(common).mono)) for (let i = 0; i < e; i++) factors.push(variable(v));
  const queue = [primitive(free).poly];
  lead = lead.mul(primitive(free).content);
  for (let guard = 0; queue.length && guard < 40; guard++) {
    const q = queue.shift()!;
    if (isConstant(q)) {
      lead = lead.mul(constantOf(q));
      continue;
    }
    const parts = split(q);
    if (!parts) {
      factors.push(q);
      continue;
    }
    for (const part of parts) {
      const { content: c, poly: f } = primitive(part);
      lead = lead.mul(c);
      queue.push(f);
    }
  }
  return { lead, factors };
}
function factoredWriting(lead: Fraction, factors: Poly[], locale: Locale): Factored | null {
  const groups = new Map<string, { f: Poly; n: number }>();
  for (const f of factors) groups.set(polyKey(f), { f, n: (groups.get(polyKey(f))?.n || 0) + 1 });
  const parts = [...groups.values()].sort((a, b) => a.f.size - b.f.size || degree(a.f) - degree(b.f));
  if (!parts.length) return null;
  const write = (f: Poly, n: number, tex: boolean) => {
    const inner = tex ? polyLatex(f) : polyText(f, locale);
    const wrapped = f.size > 1 || (n > 1 && !/^[a-zA-Z]$/.test(inner)) ? (tex ? `\\left(${inner}\\right)` : `(${inner})`) : inner;
    return wrapped + (n > 1 ? (tex ? `^{${n}}` : superscript(n)) : "");
  };
  const lone = parts.length === 1 && parts[0].n === 1;
  const prefix = (tex: boolean) =>
    lead.equals(1) ? "" : lead.equals(-1) ? (tex ? "-" : "−") : tex ? fracLatex(lead) : fracText(lead, locale) + (lead.d !== 1n ? "·" : "");
  // A single factor without a number in front is no factorization.
  if (lone && lead.abs().equals(1)) return null;
  return {
    text: prefix(false) + parts.map(({ f, n }) => write(f, n, false)).join(lone ? "" : ""),
    latex: prefix(true) + parts.map(({ f, n }) => write(f, n, true)).join(""),
  };
}
function factor(p: Poly, locale: Locale): Factored | null {
  if (p.size < 2) return null;
  const { lead, factors } = factorPoly(p);
  return factoredWriting(lead, factors, locale);
}
// Factoring over the real numbers: quadratic factors that have no rational
// roots but real ones become two factors with roots,
// x² − 2 = (x − √2)(x + √2), x² + 2x − 4 = (x + 1 − √5)(x + 1 + √5).
// Null when nothing changes compared with the rational factoring.
function factorWithRoots(p: Poly, locale: Locale): Factored | null {
  if (p.size < 2 || variablesOf(p).length !== 1) return null;
  const v = variablesOf(p)[0];
  const { lead, factors } = factorPoly(p);
  let changed = false;
  let scaleBy = lead;
  const parts: { text: string; latex: string; key: string }[] = [];
  for (const f of factors) {
    const c = coefficients(f, v);
    if (c.length === 3) {
      const [cc, bb, aa] = c;
      const D = bb.mul(bb).sub(aa.mul(cc).mul(4));
      if (D.s > 0) {
        const { outside, inside } = surd(D);
        if (inside !== 1n) {
          changed = true;
          scaleBy = scaleBy.mul(aa);
          // Roots −b/(2a) ± √D/(2a); the factor is v − root.
          const center = bb.neg().div(aa.mul(2));
          const spread = outside.div(aa.mul(2)).abs();
          for (const sign of [1, -1]) {
            const shift = center.neg();
            const text = `(${v}${shift.equals(0) ? "" : shift.s < 0 ? ` − ${fracText(shift.abs(), locale)}` : ` + ${fracText(shift, locale)}`} ${sign < 0 ? "+" : "−"} ${surdText(spread, inside, locale)})`;
            const tex = `\\left(${v}${shift.equals(0) ? "" : shift.s < 0 ? ` - ${fracLatex(shift.abs())}` : ` + ${fracLatex(shift)}`} ${sign < 0 ? "+" : "-"} ${surdLatex(spread, inside)}\\right)`;
            parts.push({ text, latex: tex, key: text });
          }
          continue;
        }
      }
    }
    const inner = polyText(f, locale);
    const wrapped = f.size > 1 ? `(${inner})` : inner;
    parts.push({ text: wrapped, latex: f.size > 1 ? `\\left(${polyLatex(f)}\\right)` : polyLatex(f), key: polyKey(f) });
  }
  if (!changed) return null;
  // Equal factors as powers.
  const grouped = new Map<string, { text: string; latex: string; n: number }>();
  for (const part of parts) grouped.set(part.key, { ...part, n: (grouped.get(part.key)?.n || 0) + 1 });
  const prefix = (tex: boolean) =>
    scaleBy.equals(1) ? "" : scaleBy.equals(-1) ? (tex ? "-" : "−") : tex ? fracLatex(scaleBy) : fracText(scaleBy, locale) + (scaleBy.d !== 1n ? "·" : "");
  return {
    text: prefix(false) + [...grouped.values()].map((g) => g.text + (g.n > 1 ? superscript(g.n) : "")).join(""),
    latex: prefix(true) + [...grouped.values()].map((g) => g.latex + (g.n > 1 ? `^{${g.n}}` : "")).join(""),
  };
}

/* ---------- Fractions with variables ---------- */

// The least common multiple of two denominators (by their factors).
function commonMultiple(a: Poly, b: Poly): Poly {
  if (isConstant(a)) return b;
  if (isConstant(b)) return a;
  const count = (fs: Poly[]) => {
    const out = new Map<string, { f: Poly; n: number }>();
    for (const f of fs) out.set(polyKey(f), { f, n: (out.get(polyKey(f))?.n || 0) + 1 });
    return out;
  };
  const fa = count(factorPoly(a).factors),
    fb = count(factorPoly(b).factors);
  let out = constant(ONE);
  for (const key of new Set([...fa.keys(), ...fb.keys()])) {
    const f = (fa.get(key) || fb.get(key))!.f;
    for (let i = 0; i < Math.max(fa.get(key)?.n || 0, fb.get(key)?.n || 0); i++) out = mul(out, f);
  }
  return out;
}

type Rational = { num: Poly; den: Poly };
const ratConst = (p: Poly): Rational => ({ num: p, den: constant(ONE) });
function toRational(node: MathNode): Rational {
  switch (node.type) {
    case "ParenthesisNode":
      return toRational((node as unknown as { content: MathNode }).content);
    case "OperatorNode": {
      const { fn, args } = node as unknown as { fn: string; args: MathNode[] };
      if (fn === "unaryMinus") {
        const r = toRational(args[0]);
        return { num: scale(r.num, fraction(-1)), den: r.den };
      }
      if (fn === "unaryPlus") return toRational(args[0]);
      if (fn === "pow") {
        const base = toRational(args[0]);
        const e = toPoly(args[1]);
        const k = constantOf(e);
        if (!isConstant(e) || k.d !== 1n || Number(k.abs().n) > MAX_DEGREE) throw new NotPolynomial("power");
        let out: Rational = ratConst(constant(ONE));
        for (let i = 0; i < Number(k.abs().n); i++) out = { num: mul(out.num, base.num), den: mul(out.den, base.den) };
        return k.s < 0 ? { num: out.den, den: out.num } : out;
      }
      const [a, b] = args.map(toRational);
      if (fn === "add" || fn === "subtract")
        return { num: add(mul(a.num, b.den), mul(b.num, a.den), fn === "add" ? 1 : -1), den: mul(a.den, b.den) };
      if (fn === "multiply") return { num: mul(a.num, b.num), den: mul(a.den, b.den) };
      if (fn === "divide") {
        if (!b.num.size) throw new NotPolynomial("division by zero");
        return { num: mul(a.num, b.den), den: mul(a.den, b.num) };
      }
      throw new NotPolynomial(fn);
    }
    default:
      return ratConst(toPoly(node));
  }
}
// Cancels common factors: (x² − 1)/(x − 1) = x + 1. The denominator keeps a
// positive leading number of 1.
function reduceRational(r: Rational): Rational {
  if (isConstant(r.den)) return ratConst(scale(r.num, ONE.div(constantOf(r.den))));
  const n = factorPoly(r.num),
    d = factorPoly(r.den);
  const denLeft = [...d.factors];
  const numLeft: Poly[] = [];
  for (const f of n.factors) {
    const i = denLeft.findIndex((g) => polyKey(g) === polyKey(f));
    if (i >= 0) denLeft.splice(i, 1);
    else numLeft.push(f);
  }
  const product = (fs: Poly[]) => fs.reduce((acc, f) => mul(acc, f), constant(ONE));
  const lead = n.lead.div(d.lead);
  return { num: scale(product(numLeft), lead), den: product(denLeft) };
}
function rationalWriting(r: Rational, locale: Locale): Factored {
  if (isConstant(r.den)) return { text: polyText(r.num, locale), latex: polyLatex(r.num) };
  const den = factorPoly(r.den);
  const denText = factoredWriting(den.lead, den.factors, locale);
  const wrap = (p: Poly) => (p.size > 1 ? `(${polyText(p, locale)})` : polyText(p, locale));
  const denPlain = denText && den.factors.length > 1 ? denText.text : wrap(r.den);
  return {
    text: `${wrap(r.num)}/${denPlain.startsWith("(") || r.den.size === 1 ? denPlain : `(${denPlain})`}`,
    latex: `\\frac{${polyLatex(r.num)}}{${denText && den.factors.length > 1 ? denText.latex : polyLatex(r.den)}}`,
  };
}

/* ---------- Solving ---------- */

// Real roots of a polynomial (coefficients lowest degree first), found
// numerically: all complex roots at once (Durand–Kerner), the real ones
// polished with Newton's method.
function realRoots(coef: number[]): number[] {
  const c = coef.slice();
  while (c.length > 1 && c[c.length - 1] === 0) c.pop();
  const n = c.length - 1;
  if (n < 1) return [];
  const lead = c[n];
  const monic = c.map((k) => k / lead);
  const value = (re: number, im: number) => {
    let r = 0,
      i = 0;
    for (let k = n; k >= 0; k--) [r, i] = [r * re - i * im + monic[k], r * im + i * re];
    return [r, i];
  };
  const bound = 1 + Math.max(...monic.slice(0, n).map(Math.abs));
  let roots = Array.from({ length: n }, (_, k) => [bound * Math.cos((2 * Math.PI * k) / n + 0.4), bound * Math.sin((2 * Math.PI * k) / n + 0.4)]);
  for (let iteration = 0; iteration < 500; iteration++) {
    let moved = 0;
    roots = roots.map(([re, im], k) => {
      let [nr, ni] = value(re, im);
      for (let j = 0; j < n; j++) {
        if (j === k) continue;
        const dr = re - roots[j][0],
          di = im - roots[j][1];
        const d = dr * dr + di * di || 1e-30;
        [nr, ni] = [(nr * dr + ni * di) / d, (ni * dr - nr * di) / d];
      }
      moved = Math.max(moved, Math.hypot(nr, ni));
      return [re - nr, im - ni];
    });
    if (moved < 1e-14) break;
  }
  const f = (x: number) => c.reduceRight((acc, k) => acc * x + k, 0);
  const derivative = (x: number) => c.slice(1).reduceRight((acc, k, i) => acc * x + (i + 1) * k, 0);
  const real = roots
    .filter(([re, im]) => Math.abs(im) < 1e-6 * (1 + Math.abs(re)))
    .map(([re]) => {
      let x = re;
      for (let i = 0; i < 30; i++) {
        const d = derivative(x);
        if (!d) break;
        const step = f(x) / d;
        x -= step;
        if (Math.abs(step) < 1e-15) break;
      }
      return x;
    })
    .sort((a, b) => a - b);
  return real.filter((x, i) => i === 0 || Math.abs(x - real[i - 1]) > 1e-7 * (1 + Math.abs(x)));
}
// "x ≈ 1,324718" for a numeric root.
const approxText = (v: string, x: number, locale: Locale) => `${v} ≈ ${decimal(Math.abs(x) < 1e-12 ? 0 : x, locale)}`;
const approxLatex = (v: string, x: number, locale: Locale) => `${v} \\approx ${decimal(Math.abs(x) < 1e-12 ? 0 : x, locale).replace(",", "{,}").replace("−", "-")}`;

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
// Solves p = 0 for v. Values that make `den` zero (a denominator in the
// equation) are no solutions and are named as excluded.
// q·√k as text: "√5", "3√2", "√6/2"; empty q·√1 is just q.
function surdText(q: Fraction, k: bigint, locale: Locale) {
  if (k === 1n) return fracText(q, locale);
  const n = q.abs().n,
    d = q.d;
  return `${q.s < 0 ? "−" : ""}${n === 1n ? "" : decimal(Number(n), locale)}√${k}${d === 1n ? "" : `/${d}`}`;
}
function surdLatex(q: Fraction, k: bigint) {
  if (k === 1n) return fracLatex(q);
  const n = q.abs().n,
    d = q.d;
  const core = `${n === 1n ? "" : n}\\sqrt{${k}}`;
  return `${q.s < 0 ? "-" : ""}${d === 1n ? core : `\\frac{${core}}{${d}}`}`;
}
function solve(p: Poly, v: string, locale: Locale, den?: Poly): MathAction | null {
  const c = coefficients(p, v);
  const denAt = (x: number) => (den ? coefficients(den, v).reduceRight((acc, k) => acc * x + k.valueOf(), 0) : 1);
  if (c.length < 2 || c.slice(1).every((k) => k.equals(0))) return null;
  const solution = (values: string[], latex: string[]): MathAction => ({
    kind: "solve",
    label: locale === "de" ? `Nach ${v} auflösen` : `Solve for ${v}`,
    text: values.length ? `⇒ ${values.join(", ")}` : locale === "de" ? "⇒ keine reelle Lösung" : "⇒ no real solution",
    latex: values.length ? `\\Rightarrow ${latex.join(",\\ ")}` : "\\Rightarrow \\emptyset",
  });
  const { roots, rest } = rationalRoots(c);
  const all = [...new Map(roots.map((r) => [r.toFraction(), r])).values()].sort((a, b) => a.compare(b));
  const excluded = den ? all.filter((r) => evaluateAt(coefficients(den, v), r).equals(0)) : [];
  const unique = all.filter((r) => !excluded.includes(r));
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
      if (approx.some((x) => Math.abs(denAt(x)) < 1e-9)) return null;
      texts.push(`${v} = ${around} (≈ ${approx.map((n) => decimal(n, locale)).join(locale === "de" ? "; " : ", ")})`);
      latex.push(`${v} = ${center.equals(0) ? "" : fracLatex(center)} \\pm ${spread.equals(1) ? "" : fracLatex(spread)}\\sqrt{${inside}}`);
    }
  } else if (rest.length > 3 && rest.slice(1, -1).every((k) => k.equals(0))) {
    // a·xⁿ + c = 0: xⁿ = q, exactly as an n-th root.
    const n = rest.length - 1;
    const q = rest[0].neg().div(rest[n]);
    const root = (tex: boolean) =>
      tex ? `\\sqrt[${n}]{${fracLatex(q.abs())}}` : `${n === 3 ? "∛" : n === 4 ? "∜" : `${superscript(n)}√`}${fracText(q.abs(), locale).replace(/^(.*\/.*)$/, "($1)")}`;
    const value = Math.pow(q.abs().valueOf(), 1 / n);
    if (n % 2) {
      const x = q.s < 0 ? -value : value;
      if (Math.abs(denAt(x)) >= 1e-9) {
        texts.push(`${v} = ${q.s < 0 ? "−" : ""}${root(false)} (≈ ${decimal(x, locale)})`);
        latex.push(`${v} = ${q.s < 0 ? "-" : ""}${root(true)}`);
      }
    } else if (q.s > 0 && Math.abs(denAt(value)) >= 1e-9 && Math.abs(denAt(-value)) >= 1e-9) {
      texts.push(`${v} = ±${root(false)} (≈ ±${decimal(value, locale)})`);
      latex.push(`${v} = \\pm ${root(true)}`);
    }
  } else if (rest.length > 3) {
    const even = rest.every((k, i) => i % 2 === 0 || k.equals(0));
    const numeric: number[] = [];
    if (even) {
      // Only even powers: u = x², exact where u is rational.
      const u = rest.filter((_, i) => i % 2 === 0);
      const { roots: uRoots, rest: uRest } = rationalRoots(u);
      for (const r of [...new Map(uRoots.map((x) => [x.toFraction(), x])).values()].sort((a, b) => a.compare(b))) {
        if (r.s < 0) continue;
        const { outside, inside } = surd(r);
        const value = Math.sqrt(r.valueOf());
        if (Math.abs(denAt(value)) < 1e-9 || Math.abs(denAt(-value)) < 1e-9) continue;
        if (r.equals(0)) {
          texts.push(`${v} = 0`);
          latex.push(`${v} = 0`);
        } else {
          texts.push(`${v} = ±${surdText(outside, inside, locale)}` + (inside === 1n ? "" : ` (≈ ±${decimal(value, locale)})`));
          latex.push(`${v} = \\pm ${surdLatex(outside, inside)}`);
        }
      }
      for (const uValue of uRest.length > 1 ? realRoots(uRest.map((k) => k.valueOf())) : [])
        if (uValue >= 0) numeric.push(-Math.sqrt(uValue), Math.sqrt(uValue));
    } else numeric.push(...realRoots(rest.map((k) => k.valueOf())));
    for (const x of numeric.sort((a, b) => a - b)) {
      if (Math.abs(denAt(x)) < 1e-9) continue;
      texts.push(approxText(v, x, locale));
      latex.push(approxLatex(v, x, locale));
    }
  }
  const action = solution(texts, latex);
  if (excluded.length) {
    // Only excluded values: there is no solution at all (not "no real one").
    if (!texts.length) action.text = locale === "de" ? "⇒ keine Lösung" : "⇒ no solution";
    const list = excluded.map((r) => `${v} = ${fracText(r, locale)}`).join(", ");
    action.text += locale === "de" ? ` (${list} entfällt: Nenner wäre 0)` : ` (${list} excluded: a denominator would be 0)`;
  }
  return action;
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
      const rawLeft = toRational(parse(left)),
        rawRight = toRational(parse(right));
      // Every denominator as written: its zeros are never solutions.
      const domain = mul(rawLeft.den, rawRight.den);
      const l = reduceRational(rawLeft),
        r = reduceRational(rawRight);
      // Multiplied by the common denominator, as in school: N = 0.
      const lcd = commonMultiple(l.den, r.den);
      const both = {
        num: add(mul(l.num, divideExact(lcd, l.den)!), mul(r.num, divideExact(lcd, r.den)!), -1),
        den: lcd,
      };
      if (!isConstant(domain)) {
        const vars = [...new Set([...variablesOf(both.num), ...variablesOf(domain)])];
        if (vars.length !== 1) return [];
        if (isConstant(both.num)) {
          // Nothing left to solve for: no solution, or every allowed value.
          const none = !both.num.size ? null : de ? "⇒ keine Lösung" : "⇒ no solution";
          return none ? [{ kind: "solve", label: de ? `Nach ${vars[0]} auflösen` : `Solve for ${vars[0]}`, text: none, latex: "\\Rightarrow \\emptyset" }] : [];
        }
        const s = solve(both.num, vars[0], locale, domain);
        return s ? [s] : [];
      }
      const p = scale(both.num, ONE.div(constantOf(both.den)));
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
      const rational = reduceRational(toRational(node));
      if (!isConstant(rational.den)) {
        // Fractions with variables: reduce or combine into one fraction.
        const written = rationalWriting(rational, locale);
        return sameWriting(written.text, input.expr)
          ? []
          : [{ kind: "expand", label: de ? "Vereinfachen" : "Simplify", text: `= ${written.text}`, latex: `= ${written.latex}` }];
      }
      poly = rational.num;
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
    const withRoots = factorWithRoots(poly, locale);
    if (withRoots)
      actions.push({ kind: "factor", label: de ? "Faktorisieren mit Wurzeln" : "Factor with roots", text: `= ${withRoots.text}`, latex: `= ${withRoots.latex}` });
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
