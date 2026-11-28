// Calculus for school functions up to the Abitur: derivatives, curve
// analysis (zeros, extreme and inflection points, monotony, curvature),
// antiderivatives and integrals, tangents, intersections, limits and
// asymptotes. Like lib/math-solve.ts, mathjs only parses; the algebra is
// our own, so results read like a school notebook:
// f′(t) = (3/2·t² − 1/6·t³)·e^(−1/3·t − 3/5), T(−4 | −e⁻⁴ ≈ −0,0183).
// Exact where the algebra allows (rational and quadratic roots, e-powers,
// logarithms), otherwise numeric and marked with "≈".
import { fraction, parse, type Fraction, type MathNode } from "mathjs";
import { decimalComma, localeTag, translate, type Locale } from "./i18n";
import { normalize, rationalRoots, realRoots, surd, surdLatex, surdText, superscript, type MathAction } from "./math-solve";

/* ---------- Expressions ---------- */

type Fn = "exp" | "ln" | "sin" | "cos" | "tan" | "abs";
// A number, a variable (or π), a sum, a product, a power or a function.
// e^u is exp(u), √u is u^(1/2), u/w is u·w^(−1).
export type Ex =
  | { k: "n"; v: Fraction }
  | { k: "v"; name: string }
  | { k: "+"; a: Ex[] }
  | { k: "*"; a: Ex[] }
  | { k: "^"; b: Ex; e: Ex }
  | { k: "f"; f: Fn; a: Ex };
type Num = Extract<Ex, { k: "n" }>;

const F0 = fraction(0);
const F1 = fraction(1);
const HALF = fraction("1/2");
const frac = (n: bigint, d = 1n) => fraction(`${n}/${d}`);
const num = (v: Fraction): Ex => ({ k: "n", v });
const int = (n: number): Ex => num(fraction(n));
const ZERO = int(0);
const ONE = int(1);
const MINUS = int(-1);
const V = (name: string): Ex => ({ k: "v", name });
const add = (...a: Ex[]): Ex => ({ k: "+", a });
const mul = (...a: Ex[]): Ex => ({ k: "*", a });
const pow = (b: Ex, e: Ex): Ex => ({ k: "^", b, e });
const fn = (f: Fn, a: Ex): Ex => ({ k: "f", f, a });
const neg = (e: Ex) => mul(MINUS, e);
const sub = (a: Ex, b: Ex) => add(a, neg(b));
const inv = (e: Ex) => pow(e, MINUS);
const isZero = (e: Ex) => e.k === "n" && e.v.equals(0);
const isOne = (e: Ex) => e.k === "n" && e.v.equals(1);
const negative = (f: Fraction) => f.s < 0n && !f.equals(0);

const keys = new WeakMap<Ex, string>();
function key(e: Ex): string {
  const known = keys.get(e);
  if (known) return known;
  const k =
    e.k === "n"
      ? e.v.toFraction()
      : e.k === "v"
        ? e.name
        : e.k === "^"
          ? `(^ ${key(e.b)} ${key(e.e)})`
          : e.k === "f"
            ? `(${e.f} ${key(e.a)})`
            : `(${e.k} ${e.a.map(key).join(" ")})`;
  keys.set(e, k);
  return k;
}
function has(e: Ex, v: string): boolean {
  switch (e.k) {
    case "n":
      return false;
    case "v":
      return e.name === v;
    case "^":
      return has(e.b, v) || has(e.e, v);
    case "f":
      return has(e.a, v);
    default:
      return e.a.some((x) => has(x, v));
  }
}
function subst(e: Ex, v: string, value: Ex): Ex {
  switch (e.k) {
    case "n":
      return e;
    case "v":
      return e.name === v ? value : e;
    case "^":
      return pow(subst(e.b, v, value), subst(e.e, v, value));
    case "f":
      return fn(e.f, subst(e.a, v, value));
    default:
      return { k: e.k, a: e.a.map((x) => subst(x, v, value)) };
  }
}
const contains = (e: Ex, test: (x: Ex) => boolean): boolean =>
  test(e) || (e.k === "^" ? contains(e.b, test) || contains(e.e, test) : e.k === "f" ? contains(e.a, test) : e.k === "+" || e.k === "*" ? e.a.some((x) => contains(x, test)) : false);

/* ---------- Polynomials in one variable (lowest degree first) ---------- */

type P = Fraction[];
const MAX_DEGREE = 24;
const trim = (p: P) => {
  const q = p.slice();
  while (q.length && q[q.length - 1].equals(0)) q.pop();
  return q;
};
const pdeg = (p: P) => trim(p).length - 1;
const padd = (a: P, b: P, sign = 1): P =>
  trim(Array.from({ length: Math.max(a.length, b.length) }, (_, i) => (a[i] ?? F0).add(sign < 0 ? (b[i] ?? F0).neg() : (b[i] ?? F0))));
function pmul(a: P, b: P): P {
  if (!a.length || !b.length) return [];
  const out = Array.from({ length: a.length + b.length - 1 }, () => F0);
  a.forEach((x, i) => b.forEach((y, j) => (out[i + j] = out[i + j].add(x.mul(y)))));
  return trim(out);
}
const pscale = (a: P, c: Fraction) => trim(a.map((x) => x.mul(c)));
const pder = (a: P) => trim(a.slice(1).map((x, i) => x.mul(i + 1)));
const pint = (a: P): P => trim([F0, ...a.map((x, i) => x.div(i + 1))]);
const pval = (a: P, x: number) => a.reduceRight((s, c) => s * x + c.valueOf(), 0);
const pvalF = (a: P, x: Fraction) => a.reduceRight((s, c) => s.mul(x).add(c), F0);
const mono = (c: Fraction, k: number): P => trim([...Array.from({ length: k }, () => F0), c]);
function pdivmod(a: P, b: P): [P, P] {
  const d = trim(b);
  let r = trim(a);
  const q: P = Array.from({ length: Math.max(0, r.length - d.length + 1) }, () => F0);
  for (let guard = 0; r.length >= d.length && r.length && guard < 100; guard++) {
    const k = r.length - d.length;
    const c = r[r.length - 1].div(d[d.length - 1]);
    q[k] = c;
    r = padd(r, pmul(mono(c, k), d), -1);
  }
  return [trim(q), r];
}
function pgcd(a: P, b: P): P {
  let x = trim(a),
    y = trim(b);
  for (let guard = 0; y.length && guard < 60; guard++) [x, y] = [y, pdivmod(x, y)[1]];
  return x.length ? pscale(x, F1.div(x[x.length - 1])) : x;
}
// p(x + a): the polynomial around a.
function pshift(p: P, a: Fraction): P {
  let out: P = [];
  for (let i = p.length - 1; i >= 0; i--) out = padd(pmul(out, [a, F1]), [p[i]]);
  return out;
}
const igcd = (a: bigint, b: bigint): bigint => (b === 0n ? (a < 0n ? -a : a) : igcd(b, a % b));
// p = content · (whole, coprime coefficients, positive leading one).
function content(p: P): Fraction {
  const q = trim(p);
  if (!q.length) return F1;
  const n = q.reduce((g, c) => igcd(g, c.n), 0n);
  const d = q.reduce((l, c) => (l / igcd(l, c.d)) * c.d, 1n);
  const c = frac(n, d);
  return negative(q[q.length - 1]) ? c.neg() : c;
}
// d = lead · Π factorᵐ: linear factors from rational roots, the rest whole.
function factorLinear(d: P): { lead: Fraction; factors: { p: P; m: number }[] } {
  const q = trim(d);
  const { roots, rest } = rationalRoots(q);
  const counts = new Map<string, { r: Fraction; m: number }>();
  for (const r of roots) counts.set(r.toFraction(), { r, m: (counts.get(r.toFraction())?.m || 0) + 1 });
  const factors: { p: P; m: number }[] = [];
  let product: P = [F1];
  for (const { r, m } of [...counts.values()].sort((a, b) => a.r.compare(b.r))) {
    // x − p/q as q·x − p.
    const p: P = [frac(-(r.s < 0n ? -r.n : r.n)), frac(r.d)];
    factors.push({ p, m });
    for (let i = 0; i < m; i++) product = pmul(product, p);
  }
  const left = trim(rest);
  if (pdeg(left) >= 1)
    for (const part of squarefree(left)) {
      const prim = pscale(part.p, F1.div(content(part.p)));
      factors.push({ p: prim, m: part.m });
      for (let i = 0; i < part.m; i++) product = pmul(product, prim);
    }
  return { lead: q[q.length - 1].div(product[product.length - 1]), factors };
}
// p = Π partᵐ with squarefree parts (Yun).
function squarefree(p: P): { p: P; m: number }[] {
  const out: { p: P; m: number }[] = [];
  let c = pgcd(p, pder(p));
  let w = pdivmod(p, c)[0];
  for (let m = 1; pdeg(w) > 0 && m < 30; m++) {
    const y = pgcd(w, c);
    const z = pdivmod(w, y)[0];
    if (pdeg(z) > 0) out.push({ p: z, m });
    w = y;
    c = pdivmod(c, y)[0];
  }
  return out.length ? out : [{ p, m: 1 }];
}

// The parts of an expression that are polynomials, as they stand
// (numbers, xⁿ, sums of these) – nothing is multiplied out.
function monomial(e: Ex, v: string): { c: Fraction; k: number } | null {
  if (e.k === "n") return { c: e.v, k: 0 };
  if (e.k === "v") return e.name === v ? { c: F1, k: 1 } : null;
  if (e.k === "^") {
    const x = e.e;
    return e.b.k === "v" && e.b.name === v && x.k === "n" && x.v.d === 1n && x.v.s > 0n && x.v.n <= 60n ? { c: F1, k: Number(x.v.n) } : null;
  }
  if (e.k === "*" && e.a.length === 2 && e.a[0].k === "n") {
    const m = monomial(e.a[1], v);
    return m && m.k > 0 ? { c: e.a[0].v.mul(m.c), k: m.k } : null;
  }
  return null;
}
function plainPoly(e: Ex, v: string): P | null {
  if (e.k === "+") {
    let p: P = [];
    for (const t of e.a) {
      const m = monomial(t, v);
      if (!m) return null;
      p = padd(p, mono(m.c, m.k));
    }
    return p;
  }
  const m = monomial(e, v);
  return m ? mono(m.c, m.k) : null;
}
// The expression multiplied out as a polynomial, or null.
function asPoly(e: Ex, v: string, cap = MAX_DEGREE): P | null {
  switch (e.k) {
    case "n":
      return trim([e.v]);
    case "v":
      return e.name === v ? [F0, F1] : null;
    case "+": {
      let p: P = [];
      for (const t of e.a) {
        const q = asPoly(t, v, cap);
        if (!q) return null;
        p = padd(p, q);
      }
      return p;
    }
    case "*": {
      let p: P = [F1];
      for (const t of e.a) {
        const q = asPoly(t, v, cap);
        if (!q) return null;
        p = pmul(p, q);
        if (pdeg(p) > cap) return null;
      }
      return p;
    }
    case "^": {
      const x = e.e;
      if (x.k !== "n" || x.v.d !== 1n || negative(x.v) || x.v.n > BigInt(cap)) return null;
      const b = asPoly(e.b, v, cap);
      if (!b || pdeg(b) * Number(x.v.n) > cap) return null;
      let p: P = [F1];
      for (let i = 0n; i < x.v.n; i++) p = pmul(p, b);
      return p;
    }
    default:
      return null;
  }
}
// The expression as a fraction of two polynomials, or null.
function asRational(e: Ex, v: string): { n: P; d: P } | null {
  switch (e.k) {
    case "+": {
      let n: P = [],
        d: P = [F1];
      for (const t of e.a) {
        const r = asRational(t, v);
        if (!r) return null;
        [n, d] = [padd(pmul(n, r.d), pmul(r.n, d)), pmul(d, r.d)];
      }
      return pdeg(d) > MAX_DEGREE * 2 ? null : { n, d };
    }
    case "*": {
      let n: P = [F1],
        d: P = [F1];
      for (const t of e.a) {
        const r = asRational(t, v);
        if (!r) return null;
        [n, d] = [pmul(n, r.n), pmul(d, r.d)];
      }
      return pdeg(n) > MAX_DEGREE * 2 || pdeg(d) > MAX_DEGREE * 2 ? null : { n, d };
    }
    case "^": {
      const x = e.e;
      if (x.k !== "n" || x.v.d !== 1n || x.v.n > 24n) return null;
      const b = asRational(e.b, v);
      if (!b) return null;
      let n: P = [F1],
        d: P = [F1];
      for (let i = 0n; i < x.v.n; i++) [n, d] = [pmul(n, b.n), pmul(d, b.d)];
      if (negative(x.v)) [n, d] = [d, n];
      return n.length ? { n, d } : null;
    }
    default: {
      const p = asPoly(e, v);
      return p ? { n: p, d: [F1] } : null;
    }
  }
}
function polyEx(p: P, v: string): Ex {
  const q = trim(p);
  const terms: Ex[] = [];
  for (let k = q.length - 1; k >= 0; k--) {
    const c = q[k];
    if (c.equals(0)) continue;
    const base = k === 0 ? null : k === 1 ? V(v) : pow(V(v), int(k));
    terms.push(!base ? num(c) : c.equals(1) ? base : mul(num(c), base));
  }
  return !terms.length ? ZERO : terms.length === 1 ? terms[0] : add(...terms);
}

/* ---------- Simplifying ---------- */

// Order in a product: constants, polynomials, powers, functions, e-powers.
function rank(e: Ex, v: string) {
  if (!has(e, v)) return 0;
  if (plainPoly(e, v)) return 1;
  if (e.k === "^" || e.k === "+") return 2;
  return e.k === "f" && e.f === "exp" ? 4 : 3;
}
const ordered = (a: Ex[], v: string) => a.slice().sort((x, y) => rank(x, v) - rank(y, v) || (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0));

export function simp(e: Ex, v: string): Ex {
  switch (e.k) {
    case "n":
    case "v":
      return e;
    case "f":
      return sFn(e.f, simp(e.a, v));
    case "^":
      return sPow(simp(e.b, v), simp(e.e, v), v);
    case "*":
      return sMul(e.a.map((x) => simp(x, v)), v);
    case "+":
      return sAdd(e.a.map((x) => simp(x, v)), v);
  }
}
function sFn(f: Fn, a: Ex): Ex {
  if (f === "exp") {
    if (isZero(a)) return ONE;
    if (a.k === "f" && a.f === "ln") return a.a;
    return fn("exp", a);
  }
  if (f === "ln") {
    if (isOne(a)) return ZERO;
    if (a.k === "f" && a.f === "exp") return a.a;
    if (a.k === "f" && a.f === "abs" && a.a.k === "f" && a.a.f === "exp") return a.a.a;
    return fn("ln", a);
  }
  if (f === "abs") {
    if (a.k === "n") return num(a.v.abs());
    if (a.k === "f" && (a.f === "exp" || a.f === "abs")) return a;
    return fn("abs", a);
  }
  if (isZero(a)) return f === "cos" ? ONE : ZERO;
  const known = trigValue(f, a);
  if (known) return known;
  return fn(f, a);
}
// sin, cos and tan at multiples of π/6 and π/4: sin(π/3) = √3/2.
function trigValue(f: Fn, a: Ex): Ex | null {
  const q = a.k === "v" && a.name === "pi" ? F1 : a.k === "*" && a.a.length === 2 && a.a[0].k === "n" && a.a[1].k === "v" && a.a[1].name === "pi" ? a.a[0].v : null;
  if (!q || (f !== "sin" && f !== "cos" && f !== "tan")) return null;
  const root = (k: number, c: string) => sMul([num(fraction(c)), pow(int(k), num(HALF))], "\u0000");
  const sinOf = (t: Fraction): Ex | null => {
    const r = t.sub(t.div(2).floor().mul(2)); // [0, 2)
    const sign = r.compare(1) >= 0 ? -1 : 1;
    const s = r.compare(1) >= 0 ? r.sub(1) : r; // [0, 1)
    const m = s.compare(HALF) > 0 ? F1.sub(s) : s; // [0, 1/2]
    const table: Record<string, Ex> = { "0": ZERO, "1/6": num(HALF), "1/4": root(2, "1/2"), "1/3": root(3, "1/2"), "1/2": ONE };
    const value = table[m.toFraction()];
    return value ? (sign < 0 ? sMul([MINUS, value], "\u0000") : value) : null;
  };
  const s = sinOf(q),
    c = sinOf(q.add(HALF));
  if (f === "sin") return s;
  if (f === "cos") return c;
  if (!s || !c || isZero(c)) return null;
  return simp(mul(s, inv(c)), "\u0000");
}
const digits = (n: bigint) => (n < 0n ? -n : n).toString().length;
function iroot(n: bigint, q: number): bigint | null {
  if (n > 10n ** 15n) return null;
  const r = BigInt(Math.round(Math.pow(Number(n), 1 / q)));
  for (const c of [r - 1n, r, r + 1n]) if (c >= 0n && c ** BigInt(q) === n) return c;
  return null;
}
// A number to a rational power: exact where possible, big powers stay
// powers, (−13)²¹ = −13²¹, √8 = 2√2.
function numPow(b: Fraction, e: Fraction): Ex {
  const k = Number(e.n);
  if (e.d === 1n) {
    if (negative(e) && b.equals(0)) return pow(num(b), num(e));
    if (k * Math.max(digits(b.n), digits(b.d)) <= 22) return num(b.pow(e));
    const base = pow(num(b.abs()), num(e));
    return negative(b) && k % 2 === 1 ? mul(MINUS, base) : base;
  }
  if (negative(b)) return pow(num(b), num(e));
  const q = Number(e.d);
  const rn = iroot(b.n, q),
    rd = iroot(b.d, q);
  if (rn !== null && rd !== null) return numPow(frac(rn, rd), negative(e) ? frac(-e.n) : frac(e.n));
  if (q === 2 && k === 1) {
    const { outside, inside } = surd(b);
    const root = pow(num(frac(inside)), num(HALF));
    if (negative(e)) return mul(num(F1.div(outside.mul(frac(inside)))), root);
    return outside.equals(1) ? root : mul(num(outside), root);
  }
  return pow(num(b), num(e));
}
function sPow(b: Ex, e: Ex, v: string): Ex {
  if (isZero(e)) return ONE;
  if (isOne(e)) return b;
  if (b.k === "n") {
    if (b.v.equals(1)) return ONE;
    if (b.v.equals(0)) return e.k === "n" && !negative(e.v) ? ZERO : pow(b, e);
    if (e.k === "n") return numPow(b.v, e.v);
  }
  if (b.k === "f" && b.f === "exp") return sFn("exp", sMul([b.a, e], v));
  if (b.k === "f" && b.f === "abs" && e.k === "n" && e.v.d === 1n && e.v.n % 2n === 0n) return sPow(b.a, e, v);
  if (b.k === "^" && e.k === "n" && b.e.k === "n" && (e.v.d === 1n || b.e.v.n === 1n)) return sPow(b.b, num(b.e.v.mul(e.v)), v);
  if (b.k === "*" && e.k === "n" && e.v.d === 1n) return sMul(b.a.map((f) => sPow(f, e, v)), v);
  return pow(b, e);
}
function sMul(list: Ex[], v: string): Ex {
  let c = F1;
  const flat: Ex[] = [];
  const push = (f: Ex) => {
    if (f.k === "*") f.a.forEach(push);
    else if (f.k === "n") c = c.mul(f.v);
    else flat.push(f);
  };
  list.forEach(push);
  if (c.equals(0)) return ZERO;
  // Equal bases: the exponents add up; e-powers become one.
  const bases = new Map<string, { b: Ex; e: Ex[]; f: Ex }>();
  const exps: Ex[] = [];
  for (const f of flat) {
    if (f.k === "f" && f.f === "exp") {
      exps.push(f.a);
      continue;
    }
    const [b, e] = f.k === "^" ? [f.b, f.e] : [f, ONE];
    const found = bases.get(key(b));
    if (found) found.e.push(e);
    else bases.set(key(b), { b, e: [e], f });
  }
  const out: Ex[] = [];
  const take = (f: Ex) => {
    if (f.k === "n") c = c.mul(f.v);
    else if (f.k === "*") f.a.forEach(take);
    else out.push(f);
  };
  for (const { b, e, f } of bases.values()) take(e.length === 1 ? f : sPow(b, sAdd(e, v), v));
  if (exps.length) take(exps.length === 1 ? fn("exp", exps[0]) : sFn("exp", sAdd(exps, v)));
  if (c.equals(0)) return ZERO;
  // Polynomials are multiplied out, with the number: 2·(x + 3) = 2x + 6.
  const polys = out.filter((f) => plainPoly(f, v));
  const rest = out.filter((f) => !plainPoly(f, v));
  let factors = out;
  if (polys.length) {
    let p: P = [c];
    for (const f of polys) p = pmul(p, plainPoly(f, v)!);
    if (pdeg(p) <= 60) {
      const pe = polyEx(p, v);
      c = F1;
      if (pe.k === "n") {
        c = pe.v;
        factors = rest;
      } else if (pe.k === "*") {
        c = (pe.a[0] as Num).v;
        factors = [pe.a[1], ...rest];
      } else factors = [pe, ...rest];
    }
  }
  factors = ordered(factors, v);
  if (!factors.length) return num(c);
  if (c.equals(1) && factors.length === 1) return factors[0];
  return mul(...(c.equals(1) ? [] : [num(c)]), ...factors);
}
// Splits a term into its polynomial part and the rest: 3x·eˣ → 3x, [eˣ].
function splitTerm(t: Ex, v: string, expand: boolean): { p: P; rest: Ex[] } {
  const small = (f: Ex) =>
    expand && f.k === "^" && f.b.k === "+" && f.e.k === "n" && f.e.v.d === 1n && !negative(f.e.v) && f.e.v.n <= 4n && plainPoly(f.b, v) ? asPoly(f, v, 8) : null;
  const whole = plainPoly(t, v) ?? small(t);
  if (whole) return { p: whole, rest: [] };
  if (t.k === "*") {
    let p: P = [F1];
    const rest: Ex[] = [];
    for (const f of t.a) {
      const q = plainPoly(f, v) ?? small(f);
      if (q) p = pmul(p, q);
      else rest.push(f);
    }
    return { p, rest };
  }
  return { p: [F1], rest: [t] };
}
function sAdd(list: Ex[], v: string): Ex {
  const flat: Ex[] = [];
  const push = (t: Ex): void => {
    if (t.k === "+") return t.a.forEach(push);
    // 2·(1 − ln(x)) in a sum: 2 − 2·ln(x)
    if (t.k === "*") {
      const sums = t.a.filter((f) => f.k === "+");
      const others = t.a.filter((f) => f.k !== "+");
      if (sums.length === 1 && others.every((f) => monomial(f, v)) && (sums[0] as { a: Ex[] }).a.length <= 12)
        return (sums[0] as { a: Ex[] }).a.forEach((term) => push(sMul([...others, term], v)));
    }
    flat.push(t);
  };
  list.forEach(push);
  const group = (expand: boolean) => {
    const groups = new Map<string, { rest: Ex[]; p: P }>();
    for (const t of flat) {
      const { p, rest } = splitTerm(t, v, expand);
      const k = rest.map(key).join("·");
      const found = groups.get(k);
      if (found) found.p = padd(found.p, p);
      else groups.set(k, { rest, p: trim(p) });
    }
    return [...groups.values()].filter((g) => g.p.length);
  };
  let live = group(false);
  if (live.length > 1 && live.some((g) => g.rest.some((f) => f.k === "^" && f.b.k === "+" && f.e.k === "n" && !negative(f.e.v)))) live = group(true);
  if (!live.length) return ZERO;
  const common = commonFactor(live, v);
  if (common) return common;
  const terms = live.flatMap((g) => {
    const t = g.rest.length ? sMul([polyEx(g.p, v), ...g.rest], v) : polyEx(g.p, v);
    return t.k === "+" ? t.a : [t];
  });
  return terms.length === 1 ? terms[0] : add(...terms);
}
// A factor every term has: 3/(x + 1) + 2/(x + 1)² = (3x + 5)/(x + 1)²,
// eˣ·sin(x) + eˣ·cos(x) = (sin(x) + cos(x))·eˣ.
function commonFactor(groups: { rest: Ex[]; p: P }[], v: string): Ex | null {
  if (groups.length < 2) return null;
  const split = (f: Ex): [Ex, Fraction] => (f.k === "^" && f.e.k === "n" ? [f.b, f.e.v] : [f, F1]);
  for (const candidate of groups[0].rest) {
    const [base] = split(candidate);
    if (!has(base, v)) continue;
    const k = key(base);
    let least: Fraction | null = null;
    for (const g of groups) {
      const found = g.rest.map(split).find(([b]) => key(b) === k);
      if (!found) {
        least = null;
        break;
      }
      if (!least || found[1].compare(least) < 0) least = found[1];
    }
    if (!least) continue;
    const m = least;
    const inner = groups.map((g) =>
      sMul(
        [
          polyEx(g.p, v),
          ...g.rest.map((f) => {
            const [b, e] = split(f);
            return key(b) === k ? sPow(b, num(e.sub(m)), v) : f;
          }),
        ],
        v,
      ),
    );
    return sMul([sPow(base, num(m), v), sAdd(inner, v)], v);
  }
  return null;
}

/* ---------- Derivatives ---------- */

function deriv(e: Ex, v: string): Ex {
  if (!has(e, v)) return ZERO;
  switch (e.k) {
    case "n":
      return ZERO;
    case "v":
      return ONE;
    case "+":
      return add(...e.a.map((t) => deriv(t, v)));
    case "*":
      return add(...e.a.map((f, i) => mul(deriv(f, v), ...e.a.filter((_, j) => j !== i))));
    case "^":
      if (!has(e.e, v)) return mul(e.e, pow(e.b, add(e.e, MINUS)), deriv(e.b, v));
      // bᵘ = e^(u·ln b)
      return mul(e, add(mul(deriv(e.e, v), fn("ln", e.b)), mul(e.e, deriv(e.b, v), inv(e.b))));
    case "f": {
      const u = e.a;
      const du = deriv(u, v);
      switch (e.f) {
        case "exp":
          return mul(e, du);
        case "ln":
          return u.k === "f" && u.f === "abs" ? mul(deriv(u.a, v), inv(u.a)) : mul(du, inv(u));
        case "sin":
          return mul(fn("cos", u), du);
        case "cos":
          return mul(MINUS, fn("sin", u), du);
        case "tan":
          return mul(du, pow(fn("cos", u), int(-2)));
        case "abs":
          return mul(du, u, inv(e));
      }
    }
  }
}
// A fraction of polynomials as school writes it: the numerator multiplied
// out, the denominator in factors, (x² − 2x − 1)/(x − 1)².
function rationalEx(n: P, d: P, v: string): Ex {
  const g = pgcd(n, d);
  if (pdeg(g) > 0) {
    n = pdivmod(n, g)[0];
    d = pdivmod(d, g)[0];
  }
  if (!trim(n).length) return ZERO;
  if (pdeg(d) <= 0) return polyEx(pscale(n, F1.div(trim(d)[0])), v);
  const { lead, factors } = factorLinear(d);
  const c = content(n);
  return sMul([num(c.div(lead)), polyEx(pscale(n, F1.div(c)), v), ...factors.map(({ p, m }) => pow(polyEx(p, v), int(-m)))], v);
}
export function derivative(e: Ex, v: string): Ex {
  const r = asRational(e, v);
  if (r && pdeg(r.d) > 0) return rationalEx(padd(pmul(pder(r.n), r.d), pmul(r.n, pder(r.d)), -1), pmul(r.d, r.d), v);
  return simp(deriv(e, v), v);
}

/* ---------- Writing ---------- */

type Mode = "t" | "x";
const SUP_LETTERS: Record<string, string> = {
  a: "ᵃ", b: "ᵇ", c: "ᶜ", d: "ᵈ", e: "ᵉ", f: "ᶠ", g: "ᵍ", h: "ʰ", i: "ⁱ", j: "ʲ", k: "ᵏ", l: "ˡ", m: "ᵐ",
  n: "ⁿ", o: "ᵒ", p: "ᵖ", r: "ʳ", s: "ˢ", t: "ᵗ", u: "ᵘ", v: "ᵛ", w: "ʷ", x: "ˣ", y: "ʸ", z: "ᶻ",
};
const SUP_READ: Record<string, string> = Object.fromEntries([
  ...[..."⁰¹²³⁴⁵⁶⁷⁸⁹"].map((c, i) => [c, String(i)]),
  ["⁻", "-"],
  ["⁺", "+"],
  ["⁽", "("],
  ["⁾", ")"],
  ...Object.entries(SUP_LETTERS).map(([l, s]) => [s, l]),
]);
const SUB_READ: Record<string, string> = Object.fromEntries([...[..."₀₁₂₃₄₅₆₇₈₉"].map((c, i) => [c, String(i)]), ["₋", "-"], ["₊", "+"]]);
const superMinus = (n: bigint) => (n < 0n ? "⁻" : "") + superscript(Number(n < 0n ? -n : n));

function numText(f: Fraction, L: Locale) {
  const sign = negative(f) ? "−" : "";
  return f.d === 1n ? sign + (f.n < 10000n ? f.n.toString() : f.n.toLocaleString(localeTag(L))) : `${sign}${f.n}/${f.d}`;
}
const numLatex = (f: Fraction) => `${negative(f) ? "-" : ""}${f.d === 1n ? f.n : `\\frac{${f.n}}{${f.d}}`}`;
// Whether a string has `chars` outside brackets.
function topLevel(s: string, chars: RegExp) {
  let depth = 0;
  for (const c of s) {
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (!depth && chars.test(c)) return true;
  }
  return false;
}
// The exponent of e as superscript where that reads well: e⁻⁴, eˣ, e⁻²ˣ.
function supExponent(a: Ex): string | null {
  if (a.k === "n" && a.v.d === 1n) return superMinus(negative(a.v) ? -a.v.n : a.v.n);
  if (a.k === "v" && SUP_LETTERS[a.name]) return SUP_LETTERS[a.name];
  if (a.k === "*" && a.a.length === 2 && a.a[0].k === "n" && a.a[0].v.d === 1n && a.a[0].v.n < 100n && a.a[1].k === "v" && SUP_LETTERS[a.a[1].name]) {
    const c = a.a[0].v;
    return (negative(c) ? "⁻" : "") + (c.n === 1n ? "" : superscript(Number(c.n))) + SUP_LETTERS[a.a[1].name];
  }
  return null;
}
function signed(t: Ex): [boolean, Ex] {
  if (t.k === "n" && negative(t.v)) return [true, num(t.v.neg())];
  if (t.k === "*" && t.a[0].k === "n" && negative(t.a[0].v)) {
    const c = t.a[0].v.neg();
    const rest = t.a.slice(1);
    return [true, c.equals(1) ? (rest.length === 1 ? rest[0] : mul(...rest)) : mul(num(c), ...rest)];
  }
  return [false, t];
}
function showSum(terms: Ex[], m: Mode, L: Locale, inner: boolean): string {
  let list = terms;
  // In brackets a positive term leads: (3/2·t² − 1/6·t³).
  if (inner && signed(list[0])[0] && list.some((t) => !signed(t)[0])) list = [...list.filter((t) => !signed(t)[0]), ...list.filter((t) => signed(t)[0])];
  return list
    .map((t, i) => {
      const [minus, body] = signed(t);
      const s = showProduct(body, m, L);
      if (!i) return minus ? (m === "t" ? "−" : "-") + s : s;
      return (minus ? (m === "t" ? " − " : " - ") : " + ") + s;
    })
    .join("");
}
// Inside brackets (exponents, arguments): a positive term first, e^(2 − 4x).
const showInner = (e: Ex, m: Mode, L: Locale) => (e.k === "+" ? showSum(e.a, m, L, true) : show(e, m, L));
export function show(e: Ex, m: Mode, L: Locale): string {
  if (e.k === "+") return showSum(e.a, m, L, false);
  const [minus, body] = signed(e);
  return (minus ? (m === "t" ? "−" : "-") : "") + showProduct(body, m, L);
}
function join(c: Fraction, factors: Ex[], m: Mode, L: Locale): string {
  const parts = factors.map((f) => showFactor(f, m, L));
  let s = !c.equals(1) || !parts.length ? (m === "t" ? numText(c, L) : numLatex(c)) : "";
  parts.forEach((p, i) => {
    if (!s) s = p;
    else if (i === 0 && c.d === 1n && (m === "x" ? /^(\\left\(|\\sqrt|\\pi|[a-zA-Z(])/.test(p) && !/^\\(sin|cos|tan|ln)/.test(p) : /^[a-zA-Zπ(√∛]/.test(p) && !/^(sin|cos|tan|ln)/.test(p))) s += p;
    else s += m === "t" ? `·${p}` : ` \\cdot ${p}`;
  });
  return s;
}
function showProduct(e: Ex, m: Mode, L: Locale): string {
  const fs = e.k === "*" ? e.a : [e];
  let c = F1;
  const top: Ex[] = [],
    bottom: Ex[] = [];
  for (const f of fs) {
    if (f.k === "n") c = c.mul(f.v);
    else if (f.k === "^" && f.e.k === "n" && negative(f.e.v)) bottom.push(f.e.v.equals(-1) ? f.b : pow(f.b, num(f.e.v.neg())));
    else top.push(f);
  }
  const minus = negative(c) ? (m === "t" ? "−" : "-") : "";
  c = c.abs();
  // −(x + 1) instead of (−x − 1).
  let sign = minus;
  const flip = top.findIndex((f) => f.k === "+" && f.a.every((t) => signed(t)[0]));
  if (c.equals(1) && flip >= 0) {
    sign = sign ? "" : m === "t" ? "−" : "-";
    top[flip] = { k: "+", a: (top[flip] as { a: Ex[] }).a.map((t) => signed(t)[1]) };
  }
  // π/2 rather than 1/2·π
  const piOnly = top.length > 0 && top.every((f) => f.k === "v" && f.name === "pi") && c.d !== 1n;
  if (!bottom.length && !piOnly) return sign + join(c, top, m, L);
  const numer = join(frac(c.n), top, m, L);
  const denom = join(frac(c.d), bottom, m, L);
  if (m === "x") return `${sign}\\frac{${numer}}{${denom}}`;
  const wrapTop = topLevel(numer, /[\s/]/) ? `(${numer})` : numer;
  const wrapBottom = topLevel(denom, /[\s·/]/) || (/^\d/.test(denom) && /[^\d]/.test(denom)) ? `(${denom})` : denom;
  return `${sign}${wrapTop}/${wrapBottom}`;
}
function showFactor(f: Ex, m: Mode, L: Locale): string {
  switch (f.k) {
    case "n":
      return negative(f.v) || f.v.d !== 1n ? (m === "t" ? `(${numText(f.v, L)})` : `\\left(${numLatex(f.v)}\\right)`) : m === "t" ? numText(f.v, L) : numLatex(f.v);
    case "v":
      return f.name === "pi" ? (m === "t" ? "π" : "\\pi") : f.name;
    case "+":
      return m === "t" ? `(${showSum(f.a, m, L, true)})` : `\\left(${showSum(f.a, m, L, true)}\\right)`;
    case "*":
      return m === "t" ? `(${show(f, m, L)})` : `\\left(${show(f, m, L)}\\right)`;
    case "^":
      return showPow(f.b, f.e, m, L);
    case "f":
      return showFn(f.f, f.a, m, L);
  }
}
function showPow(b: Ex, e: Ex, m: Mode, L: Locale): string {
  const x = e.k === "n" ? e.v : null;
  const atom = b.k === "v" || (b.k === "n" && b.v.d === 1n && !negative(b.v));
  if (x && (x.equals(HALF) || x.equals(fraction("1/3")))) {
    if (m === "x") return x.equals(HALF) ? `\\sqrt{${show(b, m, L)}}` : `\\sqrt[3]{${show(b, m, L)}}`;
    const sign = x.equals(HALF) ? "√" : "∛";
    return sign + (atom || b.k === "+" ? showFactor(b, m, L) : `(${show(b, m, L)})`);
  }
  if (b.k === "f" && (b.f === "sin" || b.f === "cos" || b.f === "tan") && x && x.d === 1n && !negative(x))
    return m === "t" ? `${b.f}${superscript(Number(x.n))}(${showInner(b.a, m, L)})` : `\\${b.f}^{${x.n}}\\left(${showInner(b.a, m, L)}\\right)`;
  const base = atom || b.k === "+" ? showFactor(b, m, L) : m === "t" ? `(${show(b, m, L)})` : `\\left(${show(b, m, L)}\\right)`;
  if (m === "x") return `${base}^{${showInner(e, m, L)}}`;
  if (x && x.d === 1n && !negative(x)) return base + superscript(Number(x.n));
  const exponent = showInner(e, m, L);
  return `${base}^${/^[\w.]+$/.test(exponent) ? exponent : `(${exponent})`}`;
}
function showFn(f: Fn, a: Ex, m: Mode, L: Locale): string {
  if (f === "exp") {
    if (isOne(a)) return "e";
    if (m === "x") return `e^{${showInner(a, m, L)}}`;
    const sup = supExponent(a);
    return sup ? `e${sup}` : `e^(${showInner(a, m, L)})`;
  }
  if (f === "abs") return m === "t" ? `|${show(a, m, L)}|` : `\\left|${show(a, m, L)}\\right|`;
  if (f === "ln" && a.k === "f" && a.f === "abs") return m === "t" ? `ln|${show(a.a, m, L)}|` : `\\ln\\left|${show(a.a, m, L)}\\right|`;
  return m === "t" ? `${f}(${showInner(a, m, L)})` : `\\${f}\\left(${showInner(a, m, L)}\\right)`;
}

/* ---------- Reading ---------- */

export type FunctionDef = { name: string; variable: string; body: string; ex: Ex };
const MAX_INPUT = 300;

// Superscripts, |…| and e^{…} as normalize() reads them.
function prepare(text: string) {
  // sin²(x) → (sin(x))^2
  let s = text;
  for (let guard = 0; guard < 10; guard++) {
    const m = s.match(/(sin|cos|tan)([²³⁴])\s*\(/);
    if (!m || m.index === undefined) break;
    let depth = 0,
      end = -1;
    for (let i = m.index + m[0].length - 1; i < s.length; i++) {
      if (s[i] === "(") depth++;
      else if (s[i] === ")" && --depth === 0) {
        end = i;
        break;
      }
    }
    if (end < 0) break;
    s = `${s.slice(0, m.index)}(${m[1]}${s.slice(m.index + m[0].length - 1, end + 1)})${m[2]}${s.slice(end + 1)}`;
  }
  return s
    .replace(/ln\s*\|([^|]+)\|/g, "ln(abs($1))")
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁻⁺⁽⁾ᵃᵇᶜᵈᵉᶠᵍʰⁱʲᵏˡᵐⁿᵒᵖʳˢᵗᵘᵛʷˣʸᶻ]+/g, (run) => `^(${[...run].map((c) => SUP_READ[c]).join("")})`)
    .replace(/\{/g, "(")
    .replace(/\}/g, ")")
    .replace(/\|([^|]+)\|/g, "abs($1)")
    .replace(/(\d)\s*e(?![a-zA-Z])/g, "$1*e");
}
function toEx(node: MathNode, ctx: { v: string | null }): Ex {
  const n = node as unknown as { type: string; value?: unknown; name?: string; content?: MathNode; fn?: unknown; args?: MathNode[] };
  switch (n.type) {
    case "ConstantNode": {
      if (typeof n.value !== "number" || !Number.isFinite(n.value)) throw new Error("constant");
      return num(fraction(n.value));
    }
    case "SymbolNode": {
      const name = n.name!;
      if (name === "e") return fn("exp", ONE);
      if (name === "pi") return V("pi");
      if (!/^[a-zA-Z]$/.test(name)) throw new Error(name);
      if (ctx.v === null) ctx.v = name;
      if (name !== ctx.v) throw new Error("two variables");
      return V(name);
    }
    case "ParenthesisNode":
      return toEx(n.content!, ctx);
    case "OperatorNode": {
      const op = n.fn as string;
      const args = n.args!;
      if (op === "unaryMinus") return neg(toEx(args[0], ctx));
      if (op === "unaryPlus") return toEx(args[0], ctx);
      if (op === "pow") {
        const base = args[0] as unknown as { type: string; name?: string };
        const exponent = toEx(args[1], ctx);
        if (base.type === "SymbolNode" && base.name === "e") return fn("exp", exponent);
        return pow(toEx(args[0], ctx), exponent);
      }
      const [a, b] = args.map((x) => toEx(x, ctx));
      if (op === "add") return add(a, b);
      if (op === "subtract") return sub(a, b);
      if (op === "multiply") return mul(a, b);
      if (op === "divide") return mul(a, inv(b));
      throw new Error(op);
    }
    case "FunctionNode": {
      const name = (n.fn as { name?: string })?.name || "";
      const args = n.args!;
      if (args.length !== 1) throw new Error(name);
      const a = toEx(args[0], ctx);
      if (name === "sqrt") return pow(a, num(HALF));
      if (name === "exp") return fn("exp", a);
      if (name === "log") return fn("ln", a);
      if (name === "log10") return mul(fn("ln", a), inv(fn("ln", int(10))));
      if (name === "sin" || name === "cos" || name === "tan" || name === "abs") return fn(name, a);
      // x(x + 1): a product.
      if (/^[a-zA-Z]$/.test(name) && name !== "e") return mul(toEx({ type: "SymbolNode", name } as unknown as MathNode, ctx), a);
      throw new Error(name);
    }
    default:
      throw new Error(n.type);
  }
}
// An expression in one variable (`variable`, or the one letter it uses).
export function readExpression(text: string, locale: Locale, variable: string | null = null): { ex: Ex; variable: string } | null {
  if (!text.trim() || text.length > MAX_INPUT || /=/.test(text)) return null;
  const input = normalize(prepare(text), locale, true);
  if (!input || input.unit) return null;
  try {
    const ctx = { v: variable };
    const ex = toEx(parse(input.expr), ctx);
    const v = ctx.v || "x";
    if (v === "e") return null;
    return { ex: simp(ex, v), variable: v };
  } catch {
    return null;
  }
}
const DEFINITION = /^\s*([a-zA-Z])\s*\(\s*([a-zA-Z])\s*\)\s*[=:]\s*([\s\S]+)$/;
// A written function: "f(x) = x² − 2", "f(t) = ½·t³·e^(−t/3 − 3/5)",
// "y = 2x + 1"; `bare`: also a term alone ("x² − 2"). Results inserted
// after it ("⇒ f′(x) = …") are not part of it.
export function readFunction(text: string, locale: Locale, bare = false): FunctionDef | null {
  const s = text.split("⇒")[0].trim().replace(/=\s*$/, "").trim();
  if (!s || s.length > MAX_INPUT) return null;
  const m = s.match(DEFINITION);
  const y = !m && s.match(/^\s*y\s*=\s*([\s\S]+)$/);
  if (!m && !y && !bare) return null;
  const name = m ? m[1] : "f";
  const body = (m ? m[3] : y ? y[1] : s).trim();
  if (m && m[2] === "e") return null;
  const read = readExpression(body, locale, m ? m[2] : null);
  if (!read) return null;
  return { name, variable: read.variable, body, ex: read.ex };
}

/* ---------- Numbers ---------- */

export function compileEx(e: Ex, v: string): (x: number) => number {
  switch (e.k) {
    case "n": {
      const c = e.v.valueOf();
      return () => c;
    }
    case "v":
      return e.name === v ? (x) => x : e.name === "pi" ? () => Math.PI : () => NaN;
    case "+": {
      const fs = e.a.map((t) => compileEx(t, v));
      return (x) => fs.reduce((s, f) => s + f(x), 0);
    }
    case "*": {
      const fs = e.a.map((t) => compileEx(t, v));
      return (x) => fs.reduce((s, f) => s * f(x), 1);
    }
    case "^": {
      const b = compileEx(e.b, v);
      if (e.e.k === "n") {
        const p = e.e.v;
        const value = p.valueOf();
        const odd = p.d % 2n === 1n,
          oddTop = p.n % 2n === 1n;
        return (x) => {
          const y = b(x);
          return y < 0 && p.d !== 1n && odd ? (oddTop ? -1 : 1) * Math.pow(-y, value) : Math.pow(y, value);
        };
      }
      const ex = compileEx(e.e, v);
      return (x) => Math.pow(b(x), ex(x));
    }
    case "f": {
      const a = compileEx(e.a, v);
      const f = { exp: Math.exp, ln: Math.log, sin: Math.sin, cos: Math.cos, tan: Math.tan, abs: Math.abs }[e.f];
      return (x) => f(a(x));
    }
  }
}
const valueOf = (e: Ex) => compileEx(e, "\u0000")(0);

// Rounded sensibly: 4 decimals, small and big numbers with 4 digits.
export function approxText(x: number, L: Locale): string {
  if (!Number.isFinite(x)) return x > 0 ? "∞" : x < 0 ? "−∞" : "?";
  if (Math.abs(x) < 1e-12) return "0";
  const a = Math.abs(x);
  if (a !== 0 && (a >= 1e9 || a < 1e-4)) {
    const exp = Math.floor(Math.log10(a));
    const mantissa = x / Math.pow(10, exp);
    return `${mantissa.toLocaleString(localeTag(L), { maximumFractionDigits: 4 }).replace(/^-/, "−")}·10${superMinus(BigInt(exp))}`;
  }
  const opts = a < 1 ? { maximumSignificantDigits: 4 } : { maximumFractionDigits: 4 };
  const s = (Math.abs(x) < 1e-12 ? 0 : x).toLocaleString(localeTag(L), opts).replace(/^-/, "−");
  return s === "−0" ? "0" : s;
}
const approxLatex = (x: number, L: Locale) =>
  approxText(x, L)
    .replace(/,/g, "{,}")
    .replace(/−/g, "-")
    .replace(/·10([⁻⁰¹²³⁴⁵⁶⁷⁸⁹]+)/, (_, d: string) => `\\cdot 10^{${[...d].map((c) => SUP_READ[c]).join("")}}`)
    .replace(/[  ]/g, "\\,");

// Adaptive Simpson, split into 32 pieces first so narrow bumps are seen.
function simpson(f: (x: number) => number, a: number, b: number): number {
  let budget = 400_000;
  const rec = (a: number, b: number, fa: number, fm: number, fb: number, whole: number, eps: number, depth: number): number => {
    budget -= 2;
    const m = (a + b) / 2,
      lm = (a + m) / 2,
      rm = (m + b) / 2;
    const flm = f(lm),
      frm = f(rm);
    const left = ((m - a) / 6) * (fa + 4 * flm + fm),
      right = ((b - m) / 6) * (fm + 4 * frm + fb);
    const diff = left + right - whole;
    if (depth <= 0 || budget <= 0 || Math.abs(diff) <= 15 * eps || !Number.isFinite(diff)) return left + right + diff / 15;
    return rec(a, m, fa, flm, fm, left, eps / 2, depth - 1) + rec(m, b, fm, frm, fb, right, eps / 2, depth - 1);
  };
  const pieces = 32;
  const xs = Array.from({ length: 2 * pieces + 1 }, (_, i) => a + ((b - a) * i) / (2 * pieces));
  const ys = xs.map(f);
  // The tolerance relative to the size of the values (and of the interval).
  const eps = 1e-12 * (1 + Math.max(...ys.map(Math.abs))) * Math.max(1, Math.abs(b - a));
  let sum = 0;
  for (let i = 0; i < pieces; i++) {
    const [x0, x1] = [xs[2 * i], xs[2 * i + 2]];
    const [f0, fm, f1] = [ys[2 * i], ys[2 * i + 1], ys[2 * i + 2]];
    sum += rec(x0, x1, f0, fm, f1, ((x1 - x0) / 6) * (f0 + 4 * fm + f1), eps / pieces, 40);
  }
  return sum;
}
// Zeros found by sampling: sign changes refined by bisection, touching
// zeros as minima of |f|. Poles (sign changes with huge values) are no zeros.
function numericZeros(f: (x: number) => number, lo: number, hi: number, samples = 8000): number[] {
  const out: number[] = [];
  const step = (hi - lo) / samples;
  const xs = Array.from({ length: samples + 1 }, (_, i) => lo + i * step);
  const ys = xs.map(f);
  const found = (r: number) => {
    const last = out[out.length - 1];
    if (last === undefined || Math.abs(last - r) >= 1e-7 * (1 + Math.abs(r))) out.push(Math.abs(r) < 1e-13 ? 0 : r);
  };
  for (let i = 1; i <= samples; i++) {
    const [y0, y1] = [ys[i - 1], ys[i]];
    if (!Number.isFinite(y0) || !Number.isFinite(y1)) continue;
    if (y1 === 0) {
      found(xs[i]);
      continue;
    }
    if (y0 * y1 < 0) {
      let a = xs[i - 1],
        b = xs[i],
        fa = y0;
      for (let n = 0; n < 80; n++) {
        const m = (a + b) / 2,
          fm = f(m);
        if (!Number.isFinite(fm)) break;
        if (fa * fm <= 0) b = m;
        else {
          a = m;
          fa = fm;
        }
      }
      const r = (a + b) / 2;
      if (Math.abs(f(r)) <= 1e-6 * (Math.abs(y0) + Math.abs(y1)) + 1e-12) found(r);
      continue;
    }
    // A touching zero: |f| has a small minimum between samples.
    if (i < samples) {
      const y2 = ys[i + 1];
      const scale = Math.max(Math.abs(y0), Math.abs(y2), 1e-300);
      if (Number.isFinite(y2) && Math.abs(y1) < Math.abs(y0) && Math.abs(y1) <= Math.abs(y2) && Math.abs(y1) < 1e-2 * scale) {
        let a = xs[i - 1],
          b = xs[i + 1];
        for (let n = 0; n < 100; n++) {
          const m1 = a + (b - a) / 3,
            m2 = b - (b - a) / 3;
          if (Math.abs(f(m1)) < Math.abs(f(m2))) b = m2;
          else a = m1;
        }
        const r = (a + b) / 2;
        if (Math.abs(f(r)) < 1e-9 * (1 + scale)) found(r);
      }
    }
  }
  return out.sort((a, b) => a - b);
}

/* ---------- Exact values: roots, surds ---------- */

// a + b·√k
type QS = { a: Fraction; b: Fraction; k: bigint };
const qs = (a: Fraction, b = F0, k = 1n): QS => ({ a, b, k });
const qsAdd = (x: QS, y: QS): QS => ({ a: x.a.add(y.a), b: x.b.add(y.b), k: x.k === 1n ? y.k : x.k });
const qsMul = (x: QS, y: QS): QS => {
  const k = x.k === 1n ? y.k : x.k;
  return { a: x.a.mul(y.a).add(x.b.mul(y.b).mul(frac(k))), b: x.a.mul(y.b).add(x.b.mul(y.a)), k };
};
function qsInv(x: QS): QS | null {
  const d = x.a.mul(x.a).sub(x.b.mul(x.b).mul(frac(x.k)));
  return d.equals(0) ? null : { a: x.a.div(d), b: x.b.neg().div(d), k: x.k };
}
// The value of a rational expression at x = a + b√k, exactly; null for
// anything else (e-powers, roots …).
function qsEval(e: Ex, v: string, x: QS): QS | null {
  switch (e.k) {
    case "n":
      return qs(e.v, F0, x.k);
    case "v":
      return e.name === v ? x : null;
    case "+": {
      let s: QS | null = qs(F0, F0, x.k);
      for (const t of e.a) {
        const y = qsEval(t, v, x);
        if (!y || !s) return null;
        s = qsAdd(s, y);
      }
      return s;
    }
    case "*": {
      let s: QS | null = qs(F1, F0, x.k);
      for (const t of e.a) {
        const y = qsEval(t, v, x);
        if (!y || !s) return null;
        s = qsMul(s, y);
      }
      return s;
    }
    case "^": {
      if (e.e.k !== "n" || e.e.v.d !== 1n || e.e.v.n > 60n) return null;
      const b = qsEval(e.b, v, x);
      if (!b) return null;
      let s: QS = qs(F1, F0, x.k);
      for (let i = 0n; i < e.e.v.n; i++) s = qsMul(s, b);
      return negative(e.e.v) ? qsInv(s) : s;
    }
    default:
      return null;
  }
}
function qsText(x: QS, L: Locale, m: Mode): string {
  const n = (f: Fraction) => (m === "t" ? numText(f, L) : numLatex(f));
  const root = (f: Fraction) => (m === "t" ? surdText(f, x.k, L) : surdLatex(f, x.k));
  if (x.b.equals(0) || x.k === 1n) return n(x.a.add(x.k === 1n ? x.b : F0));
  if (x.a.equals(0)) return root(x.b);
  return `${n(x.a)} ${negative(x.b) ? (m === "t" ? "−" : "-") : "+"} ${root(x.b.abs())}`;
}

// A value as written: exact ("9", "729/2·e^(−18/5)", "1 + √2") and/or
// rounded.
type Val = { x: number; exact: string | null; latex: string | null; rational: boolean; ex?: Ex; qs?: QS; frac?: Fraction };
const MAX_EXACT = 44;
function valFromEx(e: Ex, L: Locale): Val {
  const x = valueOf(e);
  const text = show(e, "t", L);
  if (e.k === "n") return { x, exact: text, latex: show(e, "x", L), rational: true, ex: e, frac: e.v };
  return text.length <= MAX_EXACT && Number.isFinite(x) ? { x, exact: text, latex: show(e, "x", L), rational: false, ex: e } : { x, exact: null, latex: null, rational: false };
}
const qsEx = (q: QS): Ex => (q.b.equals(0) || q.k === 1n ? num(q.a.add(q.k === 1n ? q.b : F0)) : sAdd([num(q.a), sMul([num(q.b), pow(num(frac(q.k)), num(HALF))], "\u0000")], "\u0000"));
const valFromQS = (q: QS, L: Locale): Val =>
  q.b.equals(0) || q.k === 1n
    ? valFromEx(num(q.a.add(q.k === 1n ? q.b : F0)), L)
    : { x: q.a.valueOf() + q.b.valueOf() * Math.sqrt(Number(q.k)), exact: qsText(q, L, "t"), latex: qsText(q, L, "x"), rational: false, qs: q, ex: qsEx(q) };
const qsOf = (v: Val): QS | null => (v.qs ? v.qs : v.frac ? qs(v.frac) : null);
const valApprox = (x: number): Val => ({ x, exact: null, latex: null, rational: false });
// "9", "9 − 3√3 ≈ 3,8038", "≈ 2,4142"
function valText(v: Val, L: Locale): string {
  if (v.exact && v.rational) return v.exact;
  if (v.exact) return `${v.exact} ≈ ${approxText(v.x, L)}`;
  return `≈ ${approxText(v.x, L)}`;
}
function valLatex(v: Val, L: Locale): string {
  if (v.latex && v.rational) return v.latex;
  if (v.latex) return `${v.latex} \\approx ${approxLatex(v.x, L)}`;
  return `\\approx ${approxLatex(v.x, L)}`;
}
// The value of f at a point given exactly or as a number.
function valueAt(e: Ex, v: string, at: Val, L: Locale): Val {
  const f = compileEx(e, v);
  try {
    // At a + b√k only rational functions stay exact: (9 − 3√3)³·e^(…) is no school value.
    if (at.qs) {
      const q = qsEval(e, v, at.qs);
      const out = q ? valFromQS(q, L) : null;
      return out && out.exact && out.exact.length <= MAX_EXACT ? out : valApprox(out ? out.x : f(at.x));
    }
    if (at.ex) {
      const r = simp(subst(e, v, at.ex), v);
      if (!has(r, v)) {
        const out = valFromEx(r, L);
        if (Number.isFinite(out.x)) return out;
      }
    }
  } catch {
    // too big for exact arithmetic
  }
  return valApprox(f(at.x));
}

// Distinct real roots of a polynomial, exact where possible.
function polyRoots(c: P, L: Locale): Val[] {
  const q = trim(c);
  if (pdeg(q) < 1) return [];
  const { roots, rest } = rationalRoots(q);
  const out: Val[] = [...new Map(roots.map((r) => [r.toFraction(), r])).values()].map((r) => valFromEx(num(r), L));
  const left = trim(rest);
  if (left.length === 3) {
    const [cc, bb, aa] = left;
    const D = bb.mul(bb).sub(aa.mul(cc).mul(4));
    if (!negative(D) && !D.equals(0)) {
      const center = bb.neg().div(aa.mul(2));
      const { outside, inside } = surd(D);
      const spread = outside.div(aa.mul(2)).abs();
      for (const sign of [-1, 1]) out.push(valFromQS({ a: center, b: sign < 0 ? spread.neg() : spread, k: inside }, L));
    }
  } else if (left.length > 3) {
    const n = left.length - 1;
    if (left.slice(1, -1).every((k) => k.equals(0))) {
      // a·xⁿ + c = 0
      const r = left[0].neg().div(left[n]);
      const value = Math.pow(Math.abs(r.valueOf()), 1 / n);
      const xs = n % 2 ? [negative(r) ? -value : value] : negative(r) ? [] : [-value, value];
      out.push(...xs.map(valApprox));
    } else if (left.every((k, i) => i % 2 === 0 || k.equals(0))) {
      // Only even powers: u = x².
      const u = left.filter((_, i) => i % 2 === 0);
      const { roots: ur, rest: urest } = rationalRoots(u);
      for (const r of new Map(ur.map((x) => [x.toFraction(), x])).values()) {
        if (negative(r)) continue;
        if (r.equals(0)) continue;
        const { outside, inside } = surd(r);
        for (const sign of [-1, 1]) out.push(valFromQS({ a: F0, b: sign < 0 ? outside.neg() : outside, k: inside }, L));
      }
      for (const uv of trim(urest).length > 1 ? realRoots(trim(urest).map((k) => k.valueOf())) : [])
        if (uv > 0) out.push(valApprox(-Math.sqrt(uv)), valApprox(Math.sqrt(uv)));
    } else out.push(...realRoots(left.map((k) => k.valueOf())).map(valApprox));
  }
  return dedupe(out);
}
function dedupe(list: Val[]): Val[] {
  const out: Val[] = [];
  for (const v of list.filter((x) => Number.isFinite(x.x)).sort((a, b) => a.x - b.x)) {
    const same = out.findIndex((w) => Math.abs(w.x - v.x) < 1e-7 * (1 + Math.abs(v.x)));
    if (same < 0) out.push(v);
    else if (!out[same].exact && v.exact) out[same] = v;
  }
  return out;
}
const periodic = (e: Ex, v: string) => contains(e, (x) => x.k === "f" && (x.f === "sin" || x.f === "cos" || x.f === "tan") && has(x.a, v));
// Where numbers are searched when the algebra does not find everything.
function searchWindow(e: Ex, v: string): { lo: number; hi: number; periodic: boolean } {
  return periodic(e, v) ? { lo: -2 * Math.PI, hi: 2 * Math.PI, periodic: true } : { lo: -50, hi: 50, periodic: false };
}
// Zeros of e: exact for products of polynomials, powers, e-functions and
// logarithms, A·e^(ax+b) + B; otherwise numeric in the search window.
function exactZeros(e: Ex, v: string, L: Locale): { roots: Val[]; complete: boolean } {
  if (!has(e, v)) return { roots: [], complete: !isZero(e) };
  const factors = e.k === "*" ? e.a : [e];
  const roots: Val[] = [];
  let complete = true;
  for (const f of factors) {
    if (!has(f, v) || (f.k === "f" && f.f === "exp")) continue;
    if (f.k === "^" && f.e.k === "n") {
      if (negative(f.e.v)) continue;
      const inner = exactZeros(f.b, v, L);
      roots.push(...inner.roots);
      complete &&= inner.complete;
      continue;
    }
    const p = asPoly(f, v);
    if (p) {
      roots.push(...polyRoots(p, L));
      continue;
    }
    if (f.k === "f" && (f.f === "ln" || f.f === "abs")) {
      const u = f.a.k === "f" && f.a.f === "abs" ? f.a.a : f.a;
      const target = f.f === "abs" ? u : f.a.k === "f" && f.a.f === "abs" ? simp(mul(sub(u, ONE), add(u, ONE)), v) : simp(sub(u, ONE), v);
      const inner = exactZeros(target, v, L);
      roots.push(...inner.roots);
      complete &&= inner.complete;
      continue;
    }
    if (f.k === "+") {
      const low = Math.min(...f.a.map((t) => splitTerm(t, v, false).p.findIndex((c) => !c.equals(0))));
      if (low >= 1 && Number.isFinite(low)) {
        roots.push(valFromEx(ZERO, L));
        const inner = exactZeros(sAdd(f.a.map((t) => sMul([t, pow(V(v), int(-low))], v)), v), v, L);
        roots.push(...inner.roots);
        complete &&= inner.complete;
        continue;
      }
    }
    // A·e^(ax + b) + B = 0 ⇔ x = (ln(−B/A) − b)/a
    if (f.k === "+" && f.a.length === 2) {
      const [s, t] = f.a[0].k === "n" ? [f.a[1], f.a[0]] : [f.a[0], f.a[1]];
      const parts = s.k === "*" ? s.a : [s];
      const A = parts.length === 2 && parts[0].k === "n" ? parts[0].v : parts.length === 1 ? F1 : null;
      const g = parts[parts.length - 1];
      const lin = g.k === "f" && (g.f === "exp" || g.f === "ln") ? asPoly(g.a, v) : null;
      if (t.k === "n" && A && lin && pdeg(lin) === 1) {
        const q = t.v.neg().div(A);
        // e^u = q ⇔ u = ln q; ln u = q ⇔ u = e^q
        if (g.k === "f" && g.f === "exp" && (negative(q) || q.equals(0))) continue;
        const u = g.k === "f" && g.f === "exp" ? fn("ln", num(q)) : fn("exp", num(q));
        const x = simp(mul(sub(u, num(lin[0] ?? F0)), num(F1.div(lin[1]))), v);
        roots.push(valFromEx(x, L));
        continue;
      }
    }
    complete = false;
  }
  return { roots: dedupe(roots), complete };
}
function zeros(e: Ex, v: string, L: Locale): { roots: Val[]; complete: boolean; window: ReturnType<typeof searchWindow> | null } {
  // A constant has no zeros worth naming (0 itself: no sign change either).
  if (!has(e, v)) return { roots: [], complete: true, window: null };
  const exact = exactZeros(e, v, L);
  if (exact.complete) return { ...exact, window: null };
  const w = searchWindow(e, v);
  const f = compileEx(e, v);
  const found = numericZeros(f, w.lo, w.hi).map(valApprox);
  return { roots: dedupe([...exact.roots, ...found]), complete: false, window: w };
}
// Where e is not defined or not continuous: zeros of denominators, of
// what is under a root or in a logarithm.
function breaks(e: Ex, v: string, L: Locale): Val[] {
  const out: Val[] = [];
  const visit = (x: Ex) => {
    if (x.k === "^") {
      if (x.e.k === "n" && (negative(x.e.v) || x.e.v.d !== 1n) && has(x.b, v)) out.push(...zeros(x.b, v, L).roots);
      visit(x.b);
      visit(x.e);
    } else if (x.k === "f") {
      if (x.f === "ln" && has(x.a, v)) out.push(...zeros(x.a.k === "f" && x.a.f === "abs" ? x.a.a : x.a, v, L).roots);
      if (x.f === "tan" && has(x.a, v)) out.push(...zeros(fn("cos", x.a), v, L).roots);
      visit(x.a);
    } else if (x.k === "+" || x.k === "*") x.a.forEach(visit);
  };
  visit(e);
  return dedupe(out);
}

/* ---------- Limits ---------- */

// How an expression behaves for x → ∞: ~ c·e^(E(x))·x^p·(ln x)^l, E
// without its constant. `z`: negligible (→ 0 faster than anything),
// `osc`: bounded, oscillating.
type G = { ex: P; p: Fraction; l: number; c: Ex; z?: boolean; osc?: boolean };
const G_ZERO: G = { ex: [], p: F0, l: 0, c: ZERO, z: true };
const G_OSC: G = { ex: [], p: F0, l: 0, c: ONE, osc: true };
const constG = (c: Ex): G => ({ ex: [], p: F0, l: 0, c });
function grows(g: G): number {
  if (g.z) return -1;
  const e = trim(g.ex);
  if (pdeg(e) >= 1) return negative(e[e.length - 1]) ? -1 : 1;
  if (!g.p.equals(0)) return negative(g.p) ? -1 : 1;
  return Math.sign(g.l);
}
function dominance(a: G, b: G): number {
  if (a.z || b.z) return a.z && b.z ? 0 : a.z ? -1 : 1;
  const d = trim(padd(a.ex, b.ex, -1));
  if (pdeg(d) >= 1) return negative(d[d.length - 1]) ? -1 : 1;
  const p = a.p.compare(b.p);
  return p || Math.sign(a.l - b.l);
}
function growth(e: Ex, v: string): G | null {
  if (!has(e, v)) return isZero(e) ? G_ZERO : constG(e);
  switch (e.k) {
    case "v":
      return { ex: [], p: F1, l: 0, c: ONE };
    case "*": {
      let acc = constG(ONE);
      let osc = false;
      for (const f of e.a) {
        const g = growth(f, v);
        if (!g) return null;
        if (g.z) return G_ZERO;
        if (g.osc) {
          osc = true;
          continue;
        }
        acc = { ex: padd(acc.ex, g.ex), p: acc.p.add(g.p), l: acc.l + g.l, c: sMul([acc.c, g.c], v) };
      }
      return osc ? (grows(acc) < 0 ? G_ZERO : null) : acc;
    }
    case "+": {
      const gs = e.a.map((t) => growth(t, v));
      if (gs.some((g) => !g)) return null;
      const live = (gs as G[]).filter((g) => !g.osc && !g.z);
      const osc = (gs as G[]).some((g) => g.osc);
      if (!live.length) return osc ? null : G_ZERO;
      const best = live.reduce((a, b) => (dominance(b, a) > 0 ? b : a));
      if (osc && grows(best) <= 0) return null;
      const c = sAdd(
        live.filter((g) => dominance(g, best) === 0).map((g) => g.c),
        v,
      );
      if (isZero(c) || Math.abs(valueOf(c)) < 1e-13) return null;
      return { ...best, c };
    }
    case "^": {
      if (has(e.e, v)) return has(e.b, v) ? null : growth(simp(fn("exp", mul(e.e, fn("ln", e.b))), v), v);
      if (e.e.k !== "n") return null;
      const r = e.e.v;
      const g = growth(e.b, v);
      if (!g || g.osc) return null;
      if (g.z) return negative(r) ? null : G_ZERO;
      if (r.d !== 1n && valueOf(g.c) < 0) return null;
      return { ex: pscale(g.ex, r), p: g.p.mul(r), l: g.l * r.valueOf(), c: simp(pow(g.c, num(r)), v) };
    }
    case "f": {
      const u = e.a;
      if (e.f === "exp") {
        const p = asPoly(u, v);
        if (p) return { ex: [F0, ...p.slice(1)], p: F0, l: 0, c: sFn("exp", num(p[0] ?? F0)) };
        const g = growth(u, v);
        if (!g || g.osc) return null;
        if (grows(g) < 0) return constG(ONE);
        if (grows(g) === 0) return constG(sFn("exp", g.c));
        if (!trim(g.ex).length && g.l === 0 && g.p.d === 1n) return { ex: mono(fraction(valueOf(g.c)), Number(g.p.n)), p: F0, l: 0, c: ONE };
        return null;
      }
      if (e.f === "ln") {
        const inner = u.k === "f" && u.f === "abs" ? u.a : u;
        const g = growth(inner, v);
        if (!g || g.osc || g.z) return null;
        const ex = trim(g.ex);
        if (pdeg(ex) >= 1) return { ex: [], p: fraction(pdeg(ex)), l: 0, c: num(ex[ex.length - 1]) };
        if (inner === u && valueOf(g.c) < 0) return null;
        if (!g.p.equals(0)) return { ex: [], p: F0, l: 1, c: num(g.p) };
        if (g.l) return null;
        const cv = valueOf(g.c);
        if (Math.abs(cv - 1) < 1e-12 || (cv <= 0 && inner === u)) return null;
        return constG(sFn("ln", inner === u ? g.c : sFn("abs", g.c)));
      }
      if (e.f === "abs") {
        const g = growth(u, v);
        return !g || g.osc || g.z ? g : { ...g, c: sFn("abs", g.c) };
      }
      const g = growth(u, v);
      if (!g) return null;
      if (g.osc) return e.f === "tan" ? null : G_OSC;
      if (g.z) return e.f === "cos" ? constG(ONE) : G_ZERO;
      // u → 0: sin u ~ u, tan u ~ u, cos u → 1; u → c: the value there.
      if (grows(g) < 0) return e.f === "cos" ? constG(ONE) : g;
      if (grows(g) === 0) return constG(sFn(e.f, g.c));
      return e.f === "tan" ? null : G_OSC;
    }
    default:
      return null;
  }
}
type Lim = { inf: 1 | -1; approx: boolean } | { value: Val; approx: boolean };
function limitFromGrowth(g: G | null, L: Locale): Lim | null {
  if (!g || g.osc) return null;
  const r = grows(g);
  if (r > 0) {
    const s = Math.sign(valueOf(g.c));
    return s ? { inf: s > 0 ? 1 : -1, approx: false } : null;
  }
  if (r < 0) return { value: valFromEx(ZERO, L), approx: false };
  const c = simp(g.c, "\u0000");
  const value = valFromEx(c, L);
  return Number.isFinite(value.x) ? { value, approx: false } : null;
}
// The limit along a sequence of points (x = 10ᵏ, or a ± 10⁻ᵏ).
function numericLimit(sample: (k: number) => number, L: Locale): Lim | null {
  const ys = Array.from({ length: 8 }, (_, i) => sample(i + 1));
  const last = ys.slice(-4);
  if (last.some((y) => !Number.isFinite(y))) {
    const s = last[last.length - 1];
    return s === Infinity || s === -Infinity ? { inf: s > 0 ? 1 : -1, approx: true } : null;
  }
  const [a, b, c, d] = last;
  if (Math.abs(d) > 1e6 && Math.abs(d) > Math.abs(c) * 1.5 && Math.abs(c) > Math.abs(b) && Math.sign(c) === Math.sign(d)) return { inf: d > 0 ? 1 : -1, approx: true };
  if (Math.abs(d - c) <= 1e-6 * (1 + Math.abs(d)) && Math.abs(c - b) <= 1e-4 * (1 + Math.abs(d)) + Math.abs(b - a)) {
    const rounded = Math.abs(d - Math.round(d)) < 1e-6 ? Math.round(d) : d;
    return { value: valApprox(rounded), approx: true };
  }
  return null;
}
function limitInfinity(e: Ex, v: string, dir: 1 | -1, L: Locale): Lim | null {
  const at = compileEx(e, v);
  if ([10, 30, 100].some((x) => Number.isNaN(at(dir * x)))) return null;
  const g = dir > 0 ? e : simp(subst(e, v, neg(V(v))), v);
  const exact = limitFromGrowth(growth(g, v), L);
  if (exact) return exact;
  const f = compileEx(e, v);
  return numericLimit((k) => f(dir * Math.pow(10, k)), L);
}
// One-sided limit at a (side +1: from the right).
function limitAt(e: Ex, v: string, a: Val, side: 1 | -1, L: Locale): Lim | null {
  const f = compileEx(e, v);
  const r = a.frac ? asRational(e, v) : null;
  if (r && a.frac) {
    // Around a: f(a + h) ~ c·hᵒ.
    const n = pshift(r.n, a.frac),
      d = pshift(r.d, a.frac);
    const low = (p: P) => p.findIndex((c) => !c.equals(0));
    const kn = low(n),
      kd = low(d);
    if (kn < 0) return { value: valFromEx(ZERO, L), approx: false };
    const c = n[kn].div(d[kd]);
    const order = kn - kd;
    if (order > 0) return { value: valFromEx(ZERO, L), approx: false };
    if (order === 0) return { value: valFromEx(num(c), L), approx: false };
    const s = (negative(c) ? -1 : 1) * (side < 0 && order % 2 ? -1 : 1);
    return { inf: s > 0 ? 1 : -1, approx: false };
  }
  const here = f(a.x);
  const near = f(a.x + side * 1e-9 * (1 + Math.abs(a.x)));
  if (Number.isFinite(here) && Number.isFinite(near) && Math.abs(here - near) < 1e-6 * (1 + Math.abs(here)) && a.ex) return { value: valueAt(e, v, a, L), approx: false };
  if (a.ex) {
    const shifted = simp(subst(e, v, add(a.ex, mul(int(side), inv(V(v))))), v);
    const exact = limitFromGrowth(growth(shifted, v), L);
    if (exact) return exact;
  }
  return numericLimit((k) => f(a.x + side * Math.pow(10, -k - 1)), L);
}
function limText(l: Lim | null, L: Locale, m: Mode = "t"): string | null {
  if (!l) return null;
  if ("inf" in l) return m === "t" ? (l.inf > 0 ? "∞" : "−∞") : l.inf > 0 ? "\\infty" : "-\\infty";
  if (l.approx) return m === "t" ? `≈ ${approxText(l.value.x, L)}` : `\\approx ${approxLatex(l.value.x, L)}`;
  return m === "t" ? valText(l.value, L) : valLatex(l.value, L);
}
const sameLimit = (a: Lim | null, b: Lim | null) =>
  !!a && !!b && ("inf" in a ? "inf" in b && a.inf === b.inf : !("inf" in b) && Math.abs(a.value.x - b.value.x) < 1e-9 * (1 + Math.abs(a.value.x)));

/* ---------- Antiderivatives ---------- */

const lnAbs = (u: Ex) => fn("ln", fn("abs", u));
function linear(u: Ex, v: string): P | null {
  const p = asPoly(u, v);
  return p && pdeg(p) === 1 ? p : null;
}
// ∫ P·g with g = e^(ax+b), sin(ax+b), cos(ax+b): integration by parts,
// as a table: Σ (−1)ᵏ P⁽ᵏ⁾·G_{k+1}.
function byParts(p: P, g: Ex, v: string): Ex | null {
  if (g.k !== "f") return null;
  const lin = linear(g.a, v);
  if (!lin) return null;
  const a = lin[1];
  const terms: Ex[] = [];
  let d = trim(p);
  // The repeated antiderivatives of g.
  const repeated = (k: number): Ex => {
    const s = F1.div(a.pow(k));
    if (g.f === "exp") return mul(num(s), g);
    if (g.f !== "sin" && g.f !== "cos") throw new Error("parts");
    // sin → −cos/a → −sin/a² → cos/a³ → sin/a⁴
    const cycle = g.f === "sin" ? ([["cos", -1], ["sin", -1], ["cos", 1], ["sin", 1]] as const) : ([["sin", 1], ["cos", -1], ["sin", -1], ["cos", 1]] as const);
    const [name, sign] = cycle[(k - 1) % 4];
    return mul(num(s.mul(sign)), fn(name, g.a));
  };
  if (g.f !== "exp" && g.f !== "sin" && g.f !== "cos") return null;
  for (let k = 0; d.length && k < 30; k++) {
    terms.push(mul(int(k % 2 ? -1 : 1), polyEx(d, v), repeated(k + 1)));
    d = pder(d);
  }
  return simp(add(...terms), v);
}
function integrateRational(r: { n: P; d: P }, v: string): Ex | null {
  const [q, rem] = pdivmod(r.n, r.d);
  const parts: Ex[] = [polyEx(pint(q), v)];
  if (trim(rem).length) {
    const { lead, factors } = factorLinear(r.d);
    if (factors.some((f) => pdeg(f.p) !== 1)) return null;
    if (factors.length === 1) {
      // rem / (lead·(αx + β)ᵐ): rem in powers of (αx + β).
      const [beta, alpha] = factors[0].p;
      const m = factors[0].m;
      const root = beta.neg().div(alpha);
      const shifted = pshift(rem, root);
      const L = polyEx(factors[0].p, v);
      shifted.forEach((c, j) => {
        if (c.equals(0)) return;
        const coef = c.div(alpha.pow(j)).div(lead);
        const k = j - m;
        parts.push(k === -1 ? mul(num(coef.div(alpha)), lnAbs(L)) : mul(num(coef.div(alpha.mul(k + 1))), pow(L, int(k + 1))));
      });
    } else {
      if (factors.some((f) => f.m !== 1)) return null;
      // Distinct linear factors: Σ A/(x − r), A = rem(r)/d′(r).
      for (const f of factors) {
        const root = f.p[0].neg().div(f.p[1]);
        const A = pvalF(rem, root).div(pvalF(pder(r.d), root));
        parts.push(mul(num(A), lnAbs(polyEx(pscale(f.p, F1.div(f.p[1])), v))));
      }
    }
  }
  return simp(add(...parts), v);
}
function integrateRaw(e: Ex, v: string): Ex | null {
  if (!has(e, v)) return mul(e, V(v));
  if (e.k === "+") {
    const parts = e.a.map((t) => integrateRaw(t, v));
    return parts.every(Boolean) ? add(...(parts as Ex[])) : null;
  }
  const p = asPoly(e, v, 12);
  if (p) return polyEx(pint(p), v);
  const r = asRational(e, v);
  if (r && pdeg(r.d) > 0 && pdeg(r.d) <= 8 && pdeg(r.n) <= 12) {
    const out = integrateRational(r, v);
    if (out) return out;
  }
  const fs = e.k === "*" ? e.a : [e];
  const consts = fs.filter((f) => !has(f, v)),
    vary = fs.filter((f) => has(f, v));
  const c = consts.length ? mul(...consts) : ONE;
  const found = integrateFactors(vary, v);
  if (found) return mul(c, found);
  // A polynomial of high degree, multiplied out.
  const big = asPoly(e, v, 60);
  return big ? polyEx(pint(big), v) : null;
}
function integrateFactors(fs: Ex[], v: string): Ex | null {
  if (fs.length === 1) {
    const g = fs[0];
    if (g.k === "f") {
      const lin = linear(g.a, v);
      if (lin && (g.f === "exp" || g.f === "sin" || g.f === "cos")) return byParts([F1], g, v);
      if (lin && g.f === "ln") return sub(mul(add(V(v), num(lin[0].div(lin[1]))), g), V(v));
    }
    if (g.k === "^" && g.e.k === "n") {
      const lin = linear(g.b, v);
      if (lin) {
        const n = g.e.v;
        return n.equals(-1) ? mul(num(F1.div(lin[1])), lnAbs(g.b)) : mul(num(F1.div(lin[1].mul(n.add(1)))), pow(g.b, num(n.add(1))));
      }
    }
    if (g.k === "^" && !has(g.b, v) && g.b.k === "n" && !negative(g.b.v)) {
      const lin = linear(g.e, v);
      if (lin) return mul(g, inv(mul(num(lin[1]), fn("ln", g.b))));
    }
  }
  // P·e^(ax+b), P·sin(ax+b), P·cos(ax+b)
  if (fs.length >= 2) {
    const outer = fs.filter((f) => f.k === "f" && (f.f === "exp" || f.f === "sin" || f.f === "cos") && linear(f.a, v));
    if (outer.length === 1) {
      const rest = fs.filter((f) => f !== outer[0]);
      const p = asPoly(rest.length === 1 ? rest[0] : mul(...rest), v, 12);
      if (p) {
        const out = byParts(p, outer[0], v);
        if (out) return out;
      }
    }
  }
  // P·ln(ax + b): by parts, Q = ∫P.
  if (fs.length >= 2) {
    const logs = fs.filter((f) => f.k === "f" && f.f === "ln" && linear(f.a.k === "f" && f.a.f === "abs" ? f.a.a : f.a, v));
    if (logs.length === 1) {
      const rest = fs.filter((f) => f !== logs[0]);
      const p = asPoly(rest.length === 1 ? rest[0] : mul(...rest), v, 12);
      const g = logs[0] as { a: Ex };
      const u = g.a.k === "f" && g.a.f === "abs" ? g.a.a : g.a;
      if (p) {
        const Q = pint(p);
        const lin = linear(u, v)!;
        const back = integrateRational({ n: pscale(Q, lin[1]), d: lin }, v);
        if (back) return sub(mul(polyEx(Q, v), logs[0]), back);
      }
    }
  }
  // Substitution: h(u)·u′ – x·(2x² − 13)²¹, 2x·e^(x²), ln(x)/x.
  // Each factor h(u) with its antiderivative H(u); and h itself as u (ln(x)·1/x → ½·ln(x)²).
  const candidates: { h: Ex; u: Ex; H: (u: Ex) => Ex | null }[] = [];
  for (const h of fs) {
    if (h.k === "^" && h.e.k === "n") {
      const n = h.e.v;
      candidates.push({ h, u: h.b, H: (u) => (n.equals(-1) ? lnAbs(u) : mul(num(F1.div(n.add(1))), pow(u, num(n.add(1))))) });
    } else if (h.k === "f" && h.f !== "abs") {
      const name = h.f;
      candidates.push({ h, u: h.a, H: (u) => (name === "exp" ? fn("exp", u) : name === "sin" ? neg(fn("cos", u)) : name === "cos" ? fn("sin", u) : name === "ln" ? sub(mul(u, fn("ln", u)), u) : null) });
    }
    if (h.k === "f" && h.f !== "exp") candidates.push({ h, u: h, H: (u) => mul(num(HALF), pow(u, int(2))) });
  }
  for (const { h, u, H } of candidates) {
    if (!has(u, v)) continue;
    const rest = fs.filter((f) => f !== h);
    const R = rest.length ? simp(mul(...rest), v) : ONE;
    const du = derivative(u, v);
    let k: Ex | null = null;
    const pr = asPoly(R, v),
      pu = asPoly(du, v);
    if (pr && pu && pdeg(pr) === pdeg(pu)) {
      const ratio = pr[pr.length - 1].div(pu[pu.length - 1]);
      if (!trim(padd(pr, pscale(pu, ratio), -1)).length) k = num(ratio);
    } else if (!isZero(du)) {
      const q = simp(mul(R, inv(du)), v);
      if (!has(q, v)) k = q;
    }
    const found = k && H(u);
    if (found) return mul(k!, found);
  }
  return null;
}
// An antiderivative, checked against f at a few points; null rather than
// a guess.
export function antiderivative(e: Ex, v: string): Ex | null {
  let F: Ex | null;
  try {
    F = integrateRaw(e, v);
  } catch {
    return null;
  }
  if (!F) return null;
  F = simp(F, v);
  const f = compileEx(e, v),
    dF = compileEx(simp(deriv(F, v), v), v);
  let checked = 0;
  const points = [-2.31, -1.17, -0.43, 0.37, 0.91, 1.63, 2.77, 4.19];
  const scale = Math.max(1, ...points.map((x) => Math.abs(f(x))).filter(Number.isFinite));
  for (const x of points) {
    const a = f(x),
      b = dF(x);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    if (Math.abs(a - b) > 1e-7 * (Math.abs(a) + 1e-3 * scale + 1)) return null;
    checked++;
  }
  return checked >= 2 ? F : null;
}

/* ---------- Curve analysis ---------- */

export type PointKind = "zero" | "max" | "min" | "inflection" | "saddle";
export type CurvePoint = { kind: PointKind; x: Val; y: Val };
type Interval = { lo: Val | null; hi: Val | null; sign: number };

export type Analysis = {
  def: FunctionDef;
  v: string;
  f: (x: number) => number;
  derivative: (n: 1 | 2) => Ex;
  derivativeFn: (n: 1 | 2) => (x: number) => number;
  zeros: () => ReturnType<typeof zeros>;
  breaks: () => Val[];
  points: () => CurvePoint[];
  monotony: () => Interval[];
  curvature: () => Interval[];
  antiderivative: () => Ex | null;
};
const cache = new Map<string, Analysis>();
// Everything about a function, worked out when first asked for.
export function analyze(def: FunctionDef, L: Locale): Analysis {
  const id = `${L}\u0000${def.variable}\u0000${key(def.ex)}`;
  const known = cache.get(id);
  if (known) return known;
  const v = def.variable;
  const memo = <T>(make: () => T) => {
    let value: T | undefined;
    let done = false;
    return () => {
      if (!done) {
        value = make();
        done = true;
      }
      return value as T;
    };
  };
  const d1 = memo(() => derivative(def.ex, v));
  const d2 = memo(() => derivative(d1(), v));
  const fn1 = memo(() => compileEx(d1(), v));
  const fn2 = memo(() => compileEx(d2(), v));
  const f = compileEx(def.ex, v);
  const brk = memo(() => breaks(def.ex, v, L));
  // Signs of g between its zeros and the breaks, where f is defined.
  const intervals = (g: Ex, gf: (x: number) => number): { list: Interval[]; roots: Val[] } => {
    const roots = zeros(g, v, L).roots;
    const marks = dedupe([...roots, ...brk()]);
    const list: Interval[] = [];
    const bounds = [null, ...marks, null];
    for (let i = 0; i + 1 < bounds.length; i++) {
      const lo = bounds[i],
        hi = bounds[i + 1];
      const t = lo && hi ? (lo.x + hi.x) / 2 : lo ? lo.x + Math.max(1, Math.abs(lo.x) * 0.1) : hi ? hi.x - Math.max(1, Math.abs(hi.x) * 0.1) : 0.5;
      const value = f(t),
        slope = gf(t);
      if (!Number.isFinite(value) || !Number.isFinite(slope)) list.push({ lo, hi, sign: NaN });
      else list.push({ lo, hi, sign: Math.abs(slope) < 1e-14 ? 0 : Math.sign(slope) });
    }
    return { list, roots };
  };
  const isBreak = (x: Val) => brk().some((b) => Math.abs(b.x - x.x) < 1e-9 * (1 + Math.abs(x.x)));
  const merge = (list: Interval[]) => {
    const out: Interval[] = [];
    for (const it of list) {
      const last = out[out.length - 1];
      if (last && last.sign === it.sign && Number.isFinite(it.sign) && it.lo && !isBreak(it.lo)) last.hi = it.hi;
      else out.push({ ...it });
    }
    return out.filter((it) => Number.isFinite(it.sign));
  };
  const mono = memo(() => intervals(d1(), fn1()));
  const curv = memo(() => intervals(d2(), fn2()));
  const near = (a: Val, b: Val) => Math.abs(a.x - b.x) < 1e-7 * (1 + Math.abs(a.x));
  const points = memo((): CurvePoint[] => {
    const out: CurvePoint[] = [];
    const y = (x: Val) => valueAt(def.ex, v, x, L);
    for (const z of zeros(def.ex, v, L).roots) if (!isBreak(z)) out.push({ kind: "zero", x: z, y: valFromEx(ZERO, L) });
    const sides = (list: Interval[], x: Val) => [list.find((it) => it.hi && near(it.hi, x))?.sign, list.find((it) => it.lo && near(it.lo, x))?.sign];
    const { list: m, roots: crit } = mono();
    for (const x of crit) {
      if (isBreak(x)) continue;
      const [left, right] = sides(m, x);
      if (!Number.isFinite(left!) || !Number.isFinite(right!) || !left || !right || left === right) continue;
      out.push({ kind: left > 0 ? "max" : "min", x, y: y(x) });
    }
    const { list: c, roots: infl } = curv();
    for (const x of infl) {
      if (isBreak(x)) continue;
      const [left, right] = sides(c, x);
      if (!Number.isFinite(left!) || !Number.isFinite(right!) || !left || !right || left === right) continue;
      const flat = crit.some((r) => near(r, x)) || Math.abs(fn1()(x.x)) < 1e-9;
      out.push({ kind: flat ? "saddle" : "inflection", x, y: y(x) });
    }
    return out;
  });
  const result: Analysis = {
    def,
    v,
    f,
    derivative: (n) => (n === 1 ? d1() : d2()),
    derivativeFn: (n) => (n === 1 ? fn1() : fn2()),
    zeros: memo(() => zeros(def.ex, v, L)),
    breaks: brk,
    points,
    monotony: memo(() => merge(mono().list)),
    curvature: memo(() => merge(curv().list)),
    antiderivative: memo(() => antiderivative(def.ex, v)),
  };
  if (cache.size > 60) cache.delete(cache.keys().next().value!);
  cache.set(id, result);
  return result;
}

/* ---------- Integrals ---------- */

export type IntegralResult = { value: Val; mean: Val } | { undefinedOn: true };
export function integral(a: Analysis, lo: Val, hi: Val, L: Locale): IntegralResult {
  const { v } = a;
  const [x0, x1] = [Math.min(lo.x, hi.x), Math.max(lo.x, hi.x)];
  const inside = a.breaks().some((b) => b.x >= x0 - 1e-12 && b.x <= x1 + 1e-12);
  const samples = Array.from({ length: 65 }, (_, i) => a.f(x0 + ((x1 - x0) * i) / 64));
  if (inside || samples.some((y) => !Number.isFinite(y))) return { undefinedOn: true };
  const width = hi.x - lo.x;
  const F = a.antiderivative();
  if (F && lo.ex && hi.ex) {
    try {
      const exact = simp(sub(subst(F, v, hi.ex), subst(F, v, lo.ex)), v);
      const value = valFromEx(exact, L);
      if (Number.isFinite(value.x) && Math.abs(value.x - simpson(a.f, lo.x, hi.x)) < 1e-6 * (1 + Math.abs(value.x))) {
        const mean = width ? valFromEx(simp(mul(exact, inv(sub(hi.ex, lo.ex))), v), L) : valFromEx(ZERO, L);
        return { value, mean };
      }
    } catch {
      // numeric below
    }
  }
  // Bounds with roots (zeros of polynomials): exact in a + b√k.
  const qlo = qsOf(lo),
    qhi = qsOf(hi);
  if (F && qlo && qhi && (qlo.k === qhi.k || qlo.k === 1n || qhi.k === 1n)) {
    const top = qsEval(F, v, qhi),
      bottom = qsEval(F, v, qlo);
    if (top && bottom) {
      const q = qsAdd(top, qsMul(bottom, qs(fraction(-1), F0, bottom.k)));
      const value = valFromQS(q, L);
      const back = qsInv(qsAdd(qhi, qsMul(qlo, qs(fraction(-1), F0, qlo.k))));
      if (Number.isFinite(value.x) && Math.abs(value.x - simpson(a.f, lo.x, hi.x)) < 1e-6 * (1 + Math.abs(value.x)))
        return { value, mean: back ? valFromQS(qsMul(q, back), L) : valApprox(width ? value.x / width : 0) };
    }
  }
  const value = simpson(a.f, lo.x, hi.x);
  return { value: valApprox(value), mean: valApprox(width ? value / width : 0) };
}

/* ---------- Actions ---------- */

const primes = (n: number) => ["", "′", "″", "‴"][n] ?? `^(${n})`;
const primesLatex = (n: number) => ["", "'", "''", "'''"][n] ?? `^{(${n})}`;
const listSep = (L: Locale) => (decimalComma(L) ? "; " : ", ");
// A number written as a value: "2", "−1/2", "π".
function readValue(text: string, L: Locale): Val | null {
  const read = readExpression(text.replace(/^\(|\)$/g, "").trim(), L, "\u0001");
  if (!read || has(read.ex, "\u0001")) return null;
  const value = valFromEx(read.ex, L);
  return Number.isFinite(value.x) ? value : null;
}
function inequality(it: Interval, v: string, L: Locale, rounded: { yes: boolean }): string {
  const b = (x: Val) => {
    if (!x.exact) rounded.yes = true;
    return x.exact ?? approxText(x.x, L);
  };
  if (!it.lo && !it.hi) return translate(L)(`für alle ${v}`, `for all ${v}`);
  const say = translate(L);
  if (!it.lo) return say(`für ${v} < ${b(it.hi!)}`, `for ${v} < ${b(it.hi!)}`);
  if (!it.hi) return say(`für ${v} > ${b(it.lo)}`, `for ${v} > ${b(it.lo)}`);
  const lo = b(it.lo),
    hi = b(it.hi);
  return say(`für ${lo} < ${v} < ${hi}`, `for ${lo} < ${v} < ${hi}`);
}
function pointText(p: CurvePoint, L: Locale): string {
  const say = translate(L);
  const x = valText(p.x, L),
    y = valText(p.y, L);
  switch (p.kind) {
    case "max":
      return say(`H(${x} | ${y})`, `max (${x} | ${y})`);
    case "min":
      return say(`T(${x} | ${y})`, `min (${x} | ${y})`);
    case "saddle":
      return say(`S(${x} | ${y})`, `saddle (${x} | ${y})`);
    case "inflection":
      return say(`W(${x} | ${y})`, `inflection (${x} | ${y})`);
    default:
      return `(${x} | ${y})`;
  }
}
const tex = (text: string) => `\\text{${text.replace(/[\\{}]/g, "")}}`;
function windowNote(w: { periodic: boolean } | null, v: string, L: Locale) {
  return w?.periodic ? translate(L)(` (für −2π ≤ ${v} ≤ 2π)`, ` (for −2π ≤ ${v} ≤ 2π)`) : "";
}
function tangentLine(a: Analysis, at: Val, L: Locale, normal = false): { text: string; latex: string } | null {
  const { v } = a;
  const y0 = valueAt(a.def.ex, v, at, L);
  const m = valueAt(a.derivative(1), v, at, L);
  if (!Number.isFinite(y0.x) || !Number.isFinite(m.x)) return null;
  if (at.qs && y0.qs !== undefined && m.qs !== undefined) {
    const mq = qsOf(m),
      yq = qsOf(y0);
    if (mq && yq) {
      if (normal && mq.a.equals(0) && mq.b.equals(0)) return { text: `${v} = ${at.exact}`, latex: `${v} = ${at.latex}` };
      const slope = normal ? qsInv(qsMul(mq, qs(fraction(-1), F0, mq.k))) : mq;
      if (slope) {
        const b = qsAdd(yq, qsMul(qsMul(slope, at.qs), qs(fraction(-1), F0, at.qs.k)));
        const line = sAdd([sMul([qsEx(slope), V(v)], v), qsEx(b)], v);
        return { text: show(line, "t", L), latex: show(line, "x", L) };
      }
    }
  }
  if (at.ex && y0.ex && m.ex) {
    if (normal && isZero(m.ex)) return { text: `${v} = ${at.exact}`, latex: `${v} = ${at.latex}` };
    const slope = normal ? simp(neg(inv(m.ex)), v) : m.ex;
    const b = simp(sub(y0.ex, mul(slope, at.ex)), v);
    const mx = simp(mul(slope, V(v)), v);
    const terms = [mx, b].filter((t) => !isZero(t));
    // Rational: one polynomial; else m·x + b as two terms, −e⁻⁵·x − 7e⁻⁵.
    const line = terms.every((t) => plainPoly(t, v)) ? simp(add(...terms), v) : terms.length === 1 ? terms[0] : terms.length ? add(...terms) : ZERO;
    return { text: show(line, "t", L), latex: show(line, "x", L) };
  }
  // Rounded: y = m·x + b
  if (normal && Math.abs(m.x) < 1e-12) return { text: `${v} ≈ ${approxText(at.x, L)}`, latex: `${v} \\approx ${approxLatex(at.x, L)}` };
  const slope = normal ? -1 / m.x : m.x;
  const b = y0.x - slope * at.x;
  const text = `≈ ${approxText(slope, L)}${v} ${b < 0 ? "−" : "+"} ${approxText(Math.abs(b), L)}`;
  return { text, latex: `\\approx ${approxLatex(slope, L)}${v} ${b < 0 ? "-" : "+"} ${approxLatex(Math.abs(b), L)}` };
}
function lineAction(label: string, text: string, latex: string, kind: MathAction["kind"] = "analysis"): MathAction {
  return { kind, label, text: `⇒ ${text}`, latex: `\\Rightarrow ${latex}` };
}

// What can be worked out about a written function, for the text menu's
// "Analysis" group.
function definitionActions(def: FunctionDef, L: Locale): MathAction[] {
  const say = translate(L);
  const a = analyze(def, L);
  const { variable: v, name } = def;
  const head = (n: number, m: Mode = "t") => (m === "t" ? `${name}${primes(n)}(${v})` : `${name}${primesLatex(n)}(${v})`);
  const actions: MathAction[] = [];
  const safely = (make: () => void) => {
    try {
      make();
    } catch {
      // skip what cannot be worked out
    }
  };
  for (const n of [1, 2] as const)
    safely(() => {
      const d = a.derivative(n);
      const text = show(d, "t", L);
      if (text.length > 160) return;
      actions.push(lineAction(n === 1 ? say("1. Ableitung", "First derivative") : say("2. Ableitung", "Second derivative"), `${head(n)} = ${text}`, `${head(n, "x")} = ${show(d, "x", L)}`, "derivative"));
    });
  safely(() => {
    const z = a.zeros();
    const roots = z.roots.filter((r) => !a.breaks().some((b) => Math.abs(b.x - r.x) < 1e-9));
    const text = roots.length ? roots.map((r) => `${v} = ${valText(r, L).replace(/^≈ /, "≈ ")}`.replace(`${v} = ≈`, `${v} ≈`)).join(listSep(L)) + windowNote(z.window, v, L) : say("keine Nullstellen", "no zeros") + windowNote(z.window, v, L);
    actions.push(lineAction(say("Nullstellen", "Zeros"), text, tex(text)));
  });
  safely(() => {
    const pts = a.points();
    const note = windowNote(zeros(a.derivative(1), v, L).window, v, L);
    const ext = pts.filter((p) => p.kind === "max" || p.kind === "min");
    const text = ext.length ? ext.map((p) => pointText(p, L)).join(listSep(L)) + note : say("keine Extrempunkte", "no extreme points") + note;
    actions.push(lineAction(say("Extrempunkte", "Extreme points"), text, tex(text)));
    const infl = pts.filter((p) => p.kind === "inflection" || p.kind === "saddle");
    const note2 = windowNote(zeros(a.derivative(2), v, L).window, v, L);
    const text2 = infl.length ? infl.map((p) => pointText(p, L)).join(listSep(L)) + note2 : say("keine Wendepunkte", "no inflection points") + note2;
    actions.push(lineAction(say("Wendepunkte", "Inflection points"), text2, tex(text2)));
  });
  safely(() => {
    const rounded = { yes: false };
    const list = a.monotony();
    if (!list.length) return;
    const words = (s: number) => (s > 0 ? say("streng monoton steigend", "strictly increasing") : s < 0 ? say("streng monoton fallend", "strictly decreasing") : say("konstant", "constant"));
    const text = list.map((it) => `${words(it.sign)} ${inequality(it, v, L, rounded)}`).join(listSep(L)) + (rounded.yes ? say(" (Grenzen gerundet)", " (bounds rounded)") : "");
    actions.push(lineAction(say("Monotonie", "Monotonicity"), text, tex(text)));
  });
  safely(() => {
    const rounded = { yes: false };
    const list = a.curvature();
    if (!list.length || list.every((it) => it.sign === 0)) return;
    const words = (s: number) => (s > 0 ? say("linksgekrümmt", "left-curved (convex)") : s < 0 ? say("rechtsgekrümmt", "right-curved (concave)") : say("nicht gekrümmt", "not curved"));
    const text = list.map((it) => `${words(it.sign)} ${inequality(it, v, L, rounded)}`).join(listSep(L)) + (rounded.yes ? say(" (Grenzen gerundet)", " (bounds rounded)") : "");
    actions.push(lineAction(say("Krümmung", "Curvature"), text, tex(text)));
  });
  safely(() => {
    const F = a.antiderivative();
    const big = name.toUpperCase() === name ? `${name}₁` : name.toUpperCase();
    if (!F) {
      actions.push(lineAction(say("Stammfunktion", "Antiderivative"), say("keine Stammfunktion gefunden", "no antiderivative found"), tex(say("keine Stammfunktion gefunden", "no antiderivative found")), "integral"));
      return;
    }
    const text = show(F, "t", L);
    if (text.length > 160) return;
    actions.push(lineAction(say("Stammfunktion", "Antiderivative"), `${big}(${v}) = ${text}`, `${big}(${v}) = ${show(F, "x", L)}`, "integral"));
  });
  safely(() => {
    // The area the graph encloses with the x-axis, from the first zero to the last.
    const roots = a.zeros().roots;
    if (roots.length < 2 || a.zeros().window?.periodic) return;
    let exact: Ex | null = ZERO;
    let surds: QS | null = qs(F0);
    let total = 0;
    for (let i = 0; i + 1 < roots.length; i++) {
      const r = integral(a, roots[i], roots[i + 1], L);
      if ("undefinedOn" in r) return;
      total += Math.abs(r.value.x);
      const sign = r.value.x < 0 ? -1 : 1;
      exact = exact && r.value.ex && r.value.exact ? simp(add(exact, sign < 0 ? neg(r.value.ex) : r.value.ex), v) : null;
      const q = r.value.exact ? qsOf(r.value) : null;
      surds = surds && q && (surds.k === 1n || q.k === 1n || surds.k === q.k) ? qsAdd(surds, qsMul(q, qs(fraction(sign), F0, q.k))) : null;
    }
    const value = exact ? valFromEx(exact, L) : surds ? valFromQS(surds, L) : valApprox(total);
    const from = valText(roots[0], L),
      to = valText(roots[roots.length - 1], L);
    const text = say(`A = ${valText(value, L)} (zwischen ${v} = ${from} und ${v} = ${to})`, `A = ${valText(value, L)} (between ${v} = ${from} and ${v} = ${to})`).replace(/= ≈/g, "≈");
    actions.push(lineAction(say("Fläche mit der x-Achse", "Area with the x-axis"), text, tex(text), "integral"));
  });
  safely(() => {
    const parts: string[] = [];
    const lim = (target: string, l: Lim | null) => {
      const t = limText(l, L);
      if (t) parts.push(`lim ${v}→${target} ${head(0)} ${t.startsWith("≈") ? t : `= ${t}`}`);
    };
    lim("−∞", limitInfinity(def.ex, v, -1, L));
    for (const b of a.breaks()) {
      if (!b.exact) continue;
      const left = Number.isFinite(a.f(b.x - 1e-9 * (1 + Math.abs(b.x)))) ? limitAt(def.ex, v, b, -1, L) : null;
      const right = Number.isFinite(a.f(b.x + 1e-9 * (1 + Math.abs(b.x)))) ? limitAt(def.ex, v, b, 1, L) : null;
      if (left && right && sameLimit(left, right)) lim(b.exact, left);
      else {
        if (left) lim(`${b.exact}⁻`, left);
        if (right) lim(`${b.exact}⁺`, right);
      }
    }
    lim("∞", limitInfinity(def.ex, v, 1, L));
    if (parts.length) actions.push(lineAction(say("Grenzwerte", "Limits||maths"), parts.join(listSep(L)), tex(parts.join("; ")), "limit"));
  });
  safely(() => {
    const text = asymptotes(a, L);
    if (text) actions.push(lineAction(say("Asymptoten", "Asymptotes"), text, tex(text), "limit"));
  });
  safely(() => {
    const infl = a.points().filter((p) => p.kind === "inflection" && (p.x.exact || p.x.qs));
    if (!infl.length || infl.length > 2) return;
    const lines = infl.map((p) => tangentLine(a, p.x, L)).filter(Boolean) as { text: string; latex: string }[];
    if (lines.length !== infl.length) return;
    const t = v === "t" ? "w" : "t";
    const eq = (s: string) => (s.startsWith("≈") || s.startsWith("\\approx") ? ` ${s}` : ` = ${s}`);
    const text = lines.map((l) => `${t}(${v})${eq(l.text)}`).join(listSep(L));
    if (text.length > 200) return;
    actions.push(lineAction(say("Wendetangente", "Inflection tangent"), text, lines.map((l) => `${t}(${v})${eq(l.latex)}`).join(",\\ ")));
  });
  return actions;
}
// Vertical, horizontal and oblique asymptotes.
function asymptotes(a: Analysis, L: Locale): string {
  const say = translate(L);
  const { v } = a;
  const ex = a.def.ex;
  const parts: string[] = [];
  const vertical = a.breaks().filter((b) => {
    const sides = [-1, 1].map((s) => (Number.isFinite(a.f(b.x + s * 1e-9 * (1 + Math.abs(b.x)))) ? limitAt(ex, v, b, s as 1 | -1, L) : null));
    return sides.some((l) => l && "inf" in l);
  });
  const eq = (b: Val) => (b.exact ? `${v} = ${valText(b, L)}` : `${v} ${valText(b, L)}`);
  if (vertical.length) parts.push(say(`senkrecht: ${vertical.map(eq).join(", ")}`, `vertical: ${vertical.map(eq).join(", ")}`));
  const side = (dir: 1 | -1): { kind: "h" | "o"; text: string } | null => {
    const l = limitInfinity(ex, v, dir, L);
    if (l && !("inf" in l)) return { kind: "h", text: `y ${l.approx ? "" : "= "}${limText(l, L)}` };
    // Oblique: f = m·x + b + (→ 0)
    const raw = asRational(ex, v);
    const g = raw ? pgcd(raw.n, raw.d) : null;
    const r = raw && g ? { n: pdivmod(raw.n, g)[0], d: pdivmod(raw.d, g)[0] } : null;
    let line: P | null = null;
    if (r && pdeg(r.d) > 0 && pdeg(r.n) === pdeg(r.d) + 1) line = pdivmod(r.n, r.d)[0];
    else if (ex.k === "+") {
      const poly = ex.a.reduce<P>((sum, t) => padd(sum, plainPoly(t, v) ?? []), []);
      if (pdeg(poly) === 1) {
        const rest = simp(sub(ex, polyEx(poly, v)), v);
        const lr = isZero(rest) ? null : limitInfinity(rest, v, dir, L);
        if (lr && !("inf" in lr) && !lr.approx && Math.abs(lr.value.x) < 1e-15) line = poly;
      }
    }
    return line ? { kind: "o", text: `y = ${show(polyEx(line, v), "t", L)}` } : null;
  };
  const minus = side(-1),
    plus = side(1);
  const word = (k: "h" | "o", text: string) => (k === "h" ? say(`waagerecht: ${text}`, `horizontal: ${text}`) : say(`schief: ${text}`, `oblique: ${text}`));
  if (minus && plus && minus.text === plus.text) parts.push(word(minus.kind, minus.text));
  else {
    if (minus) parts.push(word(minus.kind, minus.text) + say(` (für ${v} → −∞)`, ` (as ${v} → −∞)`));
    if (plus) parts.push(word(plus.kind, plus.text) + say(` (für ${v} → ∞)`, ` (as ${v} → ∞)`));
  }
  return parts.length ? parts.join(listSep(L)) : say("keine Asymptoten", "no asymptotes");
}

// "f(x) = x², x₀ = 1": the value, the tangent and the normal there.
function pointActions(def: FunctionDef, at: Val, L: Locale): MathAction[] {
  const say = translate(L);
  const a = analyze(def, L);
  const { variable: v, name } = def;
  const where = at.exact ?? approxText(at.x, L);
  const actions: MathAction[] = [];
  const y = valueAt(def.ex, v, at, L);
  if (Number.isFinite(y.x)) actions.push(lineAction(say("Funktionswert", "Function value"), `${name}(${where}) ${y.exact ? "= " : ""}${valText(y, L)}`, `${name}(${at.latex ?? where}) ${y.latex ? "= " : ""}${valLatex(y, L)}`, "result"));
  const t = tangentLine(a, at, L);
  if (t) actions.push(lineAction(say(`Tangente bei ${v} = ${where}`, `Tangent at ${v} = ${where}`), `t(${v}) ${t.text.startsWith("≈") ? t.text : `= ${t.text}`}`, `t(${v}) ${t.latex.startsWith("\\approx") ? t.latex : `= ${t.latex}`}`));
  const n = tangentLine(a, at, L, true);
  if (n) {
    const vertical = n.text.startsWith(`${v} `);
    actions.push(lineAction(say(`Normale bei ${v} = ${where}`, `Normal at ${v} = ${where}`), vertical ? n.text : `n(${v}) ${n.text.startsWith("≈") ? n.text : `= ${n.text}`}`, vertical ? n.latex : `n(${v}) ${n.latex.startsWith("\\approx") ? n.latex : `= ${n.latex}`}`));
  }
  return actions;
}
function intersectionActions(f: FunctionDef, g: FunctionDef, L: Locale): MathAction[] {
  const say = translate(L);
  const v = f.variable;
  const gx = g.variable === v ? g.ex : simp(subst(g.ex, g.variable, V(v)), v);
  const diff = simp(sub(f.ex, gx), v);
  if (isZero(diff)) return [];
  const z = zeros(diff, v, L);
  const domain = [...breaks(f.ex, v, L), ...breaks(gx, v, L)];
  const pts = z.roots
    .filter((r) => !domain.some((b) => Math.abs(b.x - r.x) < 1e-9))
    .map((r) => ({ x: r, y: valueAt(f.ex, v, r, L) }))
    .filter((p) => Number.isFinite(p.y.x));
  const text = pts.length
    ? pts.map((p) => say(`S(${valText(p.x, L)} | ${valText(p.y, L)})`, `(${valText(p.x, L)} | ${valText(p.y, L)})`)).join(listSep(L)) + windowNote(z.window, v, L)
    : say("keine Schnittpunkte", "no intersections") + windowNote(z.window, v, L);
  return [lineAction(say("Schnittpunkte", "Intersections"), text, tex(text))];
}

// Written limits and integrals: "lim x→2 (x² − 4)/(x − 2)", "lim x→0⁺ 1/x",
// "∫₀² x² dx", "∫_0^1 (x+3)·e^x dx", "∫ 2x·e^(x²) dx".
type Lookup = (name: string) => FunctionDef | null;
const LIMIT = /^\s*lim\s*_?\s*[({]?\s*([a-zA-Z])\s*(?:→|->|\\to|\\rightarrow)\s*([^\s)}]+?)\s*[)}]?\s+([\s\S]+?)\s*$/;
const INTEGRAL = /^\s*∫\s*(?:_\s*(\([^)]*\)|\{[^}]*\}|[^\s^]+?)\s*\^\s*(\([^)]*\)|\{[^}]*\}|[^\s(]+)|([₀-₉₋₊]+)\s*([⁰¹²³⁴⁵⁶⁷⁸⁹⁻⁺]+))?\s*([\s\S]+?)\s*d([a-zA-Z])\s*$/;
// A body that names a function ("f(x)", "f′(x)") or is written out.
function bodyExpression(body: string, variable: string, L: Locale, lookup: Lookup): Ex | null {
  const ref = body.trim().match(/^([a-zA-Z])\s*(′{1,3}|'{1,3}|″|‴)?\s*\(\s*([a-zA-Z])\s*\)$/);
  if (ref) {
    const def = lookup(ref[1]);
    if (def) {
      const order = !ref[2] ? 0 : ref[2] === "″" ? 2 : ref[2] === "‴" ? 3 : ref[2].length;
      let ex = def.ex;
      for (let i = 0; i < order; i++) ex = derivative(ex, def.variable);
      return simp(subst(ex, def.variable, V(ref[3])), ref[3]);
    }
  }
  return readExpression(body, L, variable)?.ex ?? null;
}
function limitTarget(raw: string, L: Locale): { inf: 1 | -1 } | { at: Val; side: 0 | 1 | -1 } | null {
  const s = raw.replace(/[−–]/g, "-").replace(/\^/g, "");
  if (/^\+?(∞|inf|oo)$/.test(s)) return { inf: 1 };
  if (/^-(∞|inf|oo)$/.test(s)) return { inf: -1 };
  const side = /[+⁺]$/.test(s) && s.length > 1 ? 1 : /[-⁻]$/.test(s) && s.length > 1 ? -1 : 0;
  const at = readValue(side ? s.slice(0, -1) : s, L);
  return at ? { at, side } : null;
}
function limitValue(ex: Ex, v: string, target: NonNullable<ReturnType<typeof limitTarget>>, L: Locale): { text: string; latex: string } {
  const say = translate(L);
  const out = (l: Lim | null) => {
    const t = limText(l, L);
    if (!t) return { text: say("⇒ kein Grenzwert gefunden", "⇒ no limit found"), latex: tex(say("kein Grenzwert gefunden", "no limit found")) };
    return { text: t.startsWith("≈") ? t : `= ${t}`, latex: limText(l, L, "x")!.startsWith("\\approx") ? limText(l, L, "x")! : `= ${limText(l, L, "x")}` };
  };
  if ("inf" in target) return out(limitInfinity(ex, v, target.inf, L));
  const f = compileEx(ex, v);
  const defined = (s: number) => Number.isFinite(f(target.at.x + s * 1e-9 * (1 + Math.abs(target.at.x))));
  if (target.side) return out(defined(target.side) ? limitAt(ex, v, target.at, target.side, L) : null);
  const left = defined(-1) ? limitAt(ex, v, target.at, -1, L) : null,
    right = defined(1) ? limitAt(ex, v, target.at, 1, L) : null;
  if (left && right && !sameLimit(left, right)) {
    const text = say(`⇒ existiert nicht (links ${limText(left, L)}, rechts ${limText(right, L)})`, `⇒ does not exist (left ${limText(left, L)}, right ${limText(right, L)})`);
    return { text, latex: tex(text) };
  }
  return out(left || right);
}
function notationActions(text: string, L: Locale, lookup: Lookup): MathAction[] | null {
  const say = translate(L);
  const lim = text.match(LIMIT);
  if (lim) {
    const target = limitTarget(lim[2], L);
    const ex = target && bodyExpression(lim[3], lim[1], L, lookup);
    if (!target || !ex) return [];
    const r = limitValue(ex, lim[1], target, L);
    return [{ kind: "limit", label: say("Grenzwert", "Limit||maths"), text: r.text, latex: r.latex }];
  }
  const int = text.match(INTEGRAL);
  if (!int) return null;
  const v = int[6];
  const ex = bodyExpression(int[5].replace(/[·*]\s*$/, ""), v, L, lookup);
  if (!ex) return [];
  const def: FunctionDef = { name: "f", variable: v, body: int[5], ex };
  const a = analyze(def, L);
  const unwrap = (s: string) => s.replace(/^[({](.*)[)}]$/, "$1");
  const lo = int[1] ?? (int[3] ? [...int[3]].map((c) => SUB_READ[c]).join("") : null);
  const hi = int[2] ?? (int[4] ? [...int[4]].map((c) => SUP_READ[c]).join("") : null);
  if (lo === null || hi === null) {
    const F = a.antiderivative();
    if (!F) return [{ kind: "integral", label: say("Stammfunktion", "Antiderivative"), text: say("⇒ keine Stammfunktion gefunden", "⇒ no antiderivative found"), latex: tex(say("keine Stammfunktion gefunden", "no antiderivative found")) }];
    return [{ kind: "integral", label: say("Stammfunktion", "Antiderivative"), text: `= ${show(F, "t", L)} + C`, latex: `= ${show(F, "x", L)} + C` }];
  }
  const a0 = readValue(unwrap(lo), L),
    b0 = readValue(unwrap(hi), L);
  if (!a0 || !b0) return [];
  const r = integral(a, a0, b0, L);
  const range = (de: boolean) => (de ? `[${a0.exact ?? approxText(a0.x, L)}; ${b0.exact ?? approxText(b0.x, L)}]` : `[${a0.exact ?? approxText(a0.x, L)}, ${b0.exact ?? approxText(b0.x, L)}]`);
  if ("undefinedOn" in r) {
    const message = say(`⇒ nicht überall definiert auf ${range(true)}`, `⇒ not defined everywhere on ${range(false)}`);
    return [{ kind: "integral", label: say("Integral", "Integral"), text: message, latex: tex(message) }];
  }
  return [
    { kind: "integral", label: say("Integral", "Integral"), text: r.value.exact ? `= ${valText(r.value, L)}` : valText(r.value, L), latex: r.value.latex ? `= ${valLatex(r.value, L)}` : valLatex(r.value, L) },
    {
      kind: "integral",
      label: say(`Mittelwert auf ${range(true)}`, `Mean value on ${range(false)}`),
      text: `⇒ m ${r.mean.exact ? "= " : ""}${valText(r.mean, L)}`,
      latex: `\\Rightarrow \\bar{m} ${r.mean.latex ? "= " : ""}${valLatex(r.mean, L)}`,
    },
  ];
}

const POINT = /^([\s\S]*?)(?:[,;]|\s(?:bei|für|an\s+der\s+Stelle|at|for))\s*([a-zA-Z])\s*(?:₀|0|_0|_\{0\})?\s*=\s*([^=,;]+?)\s*$/;
const TWO = /\s*(?:[,;]|\bund\b|\band\b)\s*(?=[a-zA-Z]\s*\(\s*[a-zA-Z]\s*\)\s*=)/;

// What the text menu offers for a selected function, limit or integral
// (the "Analysis" group). Empty when the text is none of these.
export function functionActions(text: string, locale: Locale): MathAction[] {
  try {
    const s = text.trim();
    if (!s || s.length > MAX_INPUT) return [];
    const notation = notationActions(s, locale, () => null);
    if (notation) return notation;
    // Two functions: where they meet.
    const parts = s.split(TWO);
    if (parts.length === 2) {
      const [f, g] = parts.map((p) => readFunction(p, locale));
      return f && g ? intersectionActions(f, g, locale) : [];
    }
    // A function and a point: value, tangent, normal.
    const point = s.match(POINT);
    if (point) {
      const def = readFunction(point[1], locale);
      const at = readValue(point[3], locale);
      if (def && at && point[2] === def.variable) return pointActions(def, at, locale);
    }
    const def = readFunction(s, locale);
    return def && has(def.ex, def.variable) ? definitionActions(def, locale) : [];
  } catch {
    return [];
  }
}

// The calculation hint for a line ending with "=" that asks about a
// function written before: "f′(x) =", "f″(t) =", "F(x) =", "f(2) =",
// "f′(−1) =", "lim x→∞ f(x) =", "∫₀² f(x) dx =". `before`: the text of
// earlier paragraphs, nearest last. Null when the line asks nothing of this.
export function analysisHint(line: string, before: string[], locale: Locale): { text: string; latex: string } | null {
  try {
    const body = line.replace(/=\s?$/, "");
    const lookup: Lookup = (name) => {
      for (const text of [body, ...before.slice().reverse()]) {
        for (const piece of text.split(/[;⇒]|,\s+(?=[a-zA-Z]\s*['′″‴]*\s*\()/).reverse()) {
          const m = piece.trim().match(DEFINITION);
          if (m && m[1] === name) {
            const def = readFunction(piece.trim(), locale);
            if (def) return def;
          }
        }
      }
      return null;
    };
    const tail = body.match(/(?:^|[\s:;,⇒])((?:lim\b|∫)[\s\S]*)$/);
    if (tail) {
      const actions = notationActions(tail[1].trim(), locale, lookup);
      const first = actions?.find((a) => a.kind !== "analysis");
      if (first && !first.text.startsWith("⇒")) return { text: first.text.replace(/^=\s*/, ""), latex: first.latex.replace(/^=\s*/, "") };
      return null;
    }
    const ask = body.match(/(?:^|[^a-zA-Z])([a-zA-Z])\s*(′{1,3}|'{1,3}|″|‴)?\s*\(\s*([^()=]{1,40}?)\s*\)\s*$/);
    // "3 + f(2) =" is a calculation, not a question about f.
    if (!ask || /[+\-−*/·×÷^]\s*$/.test(body.slice(0, ask.index! + ask[0].indexOf(ask[1])))) return null;
    const [, name, marks, arg] = ask;
    const order = !marks ? 0 : marks === "″" ? 2 : marks === "‴" ? 3 : marks.length;
    let def = lookup(name);
    let integrate = false;
    if (!def && name === name.toUpperCase() && !marks) {
      def = lookup(name.toLowerCase());
      integrate = true;
    }
    if (!def) return null;
    const v = def.variable;
    let ex: Ex | null = def.ex;
    if (integrate) ex = antiderivative(def.ex, v);
    else for (let i = 0; i < order; i++) ex = derivative(ex, v);
    if (!ex) return null;
    if (arg.trim() === v) {
      if (!order && !integrate) return null;
      return { text: show(ex, "t", locale), latex: show(ex, "x", locale) };
    }
    const at = readValue(arg, locale);
    if (!at) return null;
    const y = valueAt(ex, v, at, locale);
    if (!Number.isFinite(y.x)) return null;
    return y.exact ? { text: valText(y, locale), latex: valLatex(y, locale) } : { text: valText(y, locale).replace(/^≈ /, "≈ "), latex: valLatex(y, locale) };
  } catch {
    return null;
  }
}

/* ---------- Graphs ---------- */

export type PlotPoint = { kind: PointKind; x: number; y: number; title: string };
// What a graph draws for a function: f, its derivatives as functions and as
// text, the points worth marking and integrals. Null for no function.
export function plotFunction(expr: string, locale: Locale) {
  const def = readFunction(expr, locale, true);
  if (!def) return null;
  const a = analyze(def, locale);
  const say = translate(locale);
  return {
    variable: def.variable,
    name: def.name,
    f: a.f,
    derivative(n: 1 | 2) {
      try {
        return a.derivativeFn(n);
      } catch {
        return null;
      }
    },
    derivativeText(n: 1 | 2) {
      try {
        return show(a.derivative(n), "t", locale);
      } catch {
        return "";
      }
    },
    points(): PlotPoint[] {
      try {
        return a
          .points()
          .filter((p) => Number.isFinite(p.x.x) && Number.isFinite(p.y.x))
          .map((p) => ({
            kind: p.kind,
            x: p.x.x,
            y: p.y.x,
            title:
              p.kind === "zero"
                ? say(`Nullstelle ${def.variable} = ${valText(p.x, locale)}`, `Zero ${def.variable} = ${valText(p.x, locale)}`).replace("= ≈", "≈")
                : `${{ max: say("Hochpunkt", "Maximum"), min: say("Tiefpunkt", "Minimum"), inflection: say("Wendepunkt", "Inflection point"), saddle: say("Sattelpunkt", "Saddle point") }[p.kind]} ${pointText(p, locale)}`,
          }));
      } catch {
        return [];
      }
    },
    integral(from: string, to: string) {
      const lo = readValue(from, locale),
        hi = readValue(to, locale);
      if (!lo || !hi) return null;
      try {
        const r = integral(a, lo, hi, locale);
        if ("undefinedOn" in r) return null;
        return { from: lo.x, to: hi.x, value: valText(r.value, locale), mean: valText(r.mean, locale), fromText: lo.exact ?? approxText(lo.x, locale), toText: hi.exact ?? approxText(hi.x, locale) };
      } catch {
        return null;
      }
    },
  };
}
// Intersections of two graphs for marking (numeric, in a range).
export function plotIntersections(f: (x: number) => number, g: (x: number) => number, lo: number, hi: number): { x: number; y: number }[] {
  const d = (x: number) => f(x) - g(x);
  return numericZeros(d, lo, hi, 2000)
    .map((x) => ({ x, y: f(x) }))
    .filter((p) => Number.isFinite(p.y));
}
