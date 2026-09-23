import { Temporal } from "@js-temporal/polyfill";
import { cellText } from "./cell-text";
import { validDateValue, validZone, hasOffset, isTimed } from "./date-values";
import { formulaFunctionByName } from "./formula-catalog";
import type { Field } from "./types";

export type FormulaCode =
  | "#ERROR"
  | "#DIV/0"
  | "#LIMIT"
  | "#PROPERTY"
  | "#CYCLE"
  | "#ACCESS"
  | "#RELATION";
export type FormulaDiagnostic = {
  code: FormulaCode;
  message: string;
  start: number;
  end: number;
};
export type FormulaResult =
  { ok: true; value: unknown } | { ok: false; error: FormulaDiagnostic };
export class FormulaFault extends Error {
  constructor(public diagnostic: FormulaDiagnostic) {
    super(diagnostic.message);
  }
}
type Span = { start: number; end: number };
type Node = Span &
  (
    | { kind: "literal"; value: unknown }
    | { kind: "property"; name: string }
    | { kind: "unary"; op: string; child: Node }
    | { kind: "binary"; op: string; left: Node; right: Node }
    | { kind: "call"; name: string; args: Node[] }
  );
type Token = Span & {
  kind: "number" | "string" | "identifier" | "property" | "symbol" | "end";
  text: string;
  value?: unknown;
};
type Compiled =
  { ok: true; tree: Node } | { ok: false; error: FormulaDiagnostic };
export type FormulaOptions = { now?: Date };
export const FORMULA_MAX_LENGTH = 2000;
const MAX_TEXT = 20000,
  MAX_LIST = 1000;
const cache = new Map<string, Compiled>();
const precedence: Record<string, number> = {
  "||": 1,
  "&&": 2,
  "==": 3,
  "!=": 3,
  ">": 4,
  "<": 4,
  ">=": 4,
  "<=": 4,
  "+": 5,
  "-": 5,
  "*": 6,
  "/": 6,
  "%": 6,
};
function fail(
  message: string,
  span: Span,
  code: FormulaCode = "#ERROR",
): never {
  throw new FormulaFault({ ...span, message, code });
}
function diagnostic(error: unknown): FormulaDiagnostic {
  return error instanceof FormulaFault
    ? error.diagnostic
    : {
        code: "#ERROR",
        message: "Die Formel konnte nicht ausgewertet werden.",
        start: 0,
        end: 0,
      };
}
function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  while (at < source.length) {
    if (/\s/u.test(source[at])) {
      at++;
      continue;
    }
    const start = at,
      first = source[at];
    if (first === '"' || first === "'") {
      at++;
      let value = "",
        closed = false;
      while (at < source.length) {
        const char = source[at++];
        if (char === first) {
          closed = true;
          break;
        }
        if (char !== "\\") {
          value += char;
          continue;
        }
        const escaped = source[at++];
        const escapes: Record<string, string> = {
          n: "\n",
          r: "\r",
          t: "\t",
          b: "\b",
          f: "\f",
          "\\": "\\",
          '"': '"',
          "'": "'",
          "/": "/",
        };
        if (escaped === "u") {
          const hex = source.slice(at, at + 4);
          if (!/^[0-9a-f]{4}$/i.test(hex))
            fail("Ein Unicode-Escape benötigt vier Hexadezimalzeichen.", {
              start: at - 2,
              end: at + hex.length,
            });
          value += String.fromCharCode(parseInt(hex, 16));
          at += 4;
        } else if (Object.hasOwn(escapes, escaped)) value += escapes[escaped];
        else
          fail("Unbekannte Escape-Sequenz im Text.", {
            start: at - 2,
            end: at,
          });
      }
      if (!closed)
        fail("Das schließende Anführungszeichen fehlt.", { start, end: at });
      tokens.push({
        kind: "string",
        text: source.slice(start, at),
        value,
        start,
        end: at,
      });
    } else if (first === "{") {
      const end = source.indexOf("}", at + 1);
      if (end < 0)
        fail("Die schließende Eigenschaftsklammer } fehlt.", {
          start,
          end: source.length,
        });
      const name = source.slice(at + 1, end).trim();
      if (!name || name.includes("{"))
        fail("Bitte eine Eigenschaft zwischen { und } angeben.", {
          start,
          end: end + 1,
        });
      at = end + 1;
      tokens.push({ kind: "property", text: name, start, end: at });
    } else {
      const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(
        source.slice(at),
      );
      const identifier = /^[\p{L}_][\p{L}\p{N}_]*/u.exec(source.slice(at));
      if (number) {
        at += number[0].length;
        if (!Number.isFinite(Number(number[0])))
          fail("Die Zahl liegt außerhalb des unterstützten Bereichs.", {
            start,
            end: at,
          });
        tokens.push({
          kind: "number",
          text: number[0],
          value: Number(number[0]),
          start,
          end: at,
        });
      } else if (identifier) {
        at += identifier[0].length;
        tokens.push({
          kind: "identifier",
          text: identifier[0],
          start,
          end: at,
        });
      } else {
        const op = /^(?:==|!=|>=|<=|&&|\|\||[()+\-*/%,<>!])/.exec(
          source.slice(at),
        );
        if (!op)
          fail(`Ungültiges Zeichen „${first}“.`, { start, end: start + 1 });
        at += op[0].length;
        tokens.push({ kind: "symbol", text: op[0], start, end: at });
      }
    }
    if (tokens.length > 1000)
      fail(
        "Die Formel enthält zu viele Bestandteile.",
        { start: 0, end: at },
        "#LIMIT",
      );
  }
  tokens.push({
    kind: "end",
    text: "",
    start: source.length,
    end: source.length,
  });
  return tokens;
}
export function compileFormula(source: string): Compiled {
  const cached = cache.get(source);
  if (cached) return cached;
  let result: Compiled;
  try {
    if (source.length > FORMULA_MAX_LENGTH)
      fail(
        "Die Formel darf höchstens 2.000 Zeichen enthalten.",
        { start: FORMULA_MAX_LENGTH, end: source.length },
        "#LIMIT",
      );
    const tokens = tokenize(source);
    let at = 0;
    const peek = () => tokens[at];
    const symbol = (value: string) =>
      peek().kind === "symbol" && peek().text === value;
    function expression(min = 0, depth = 0): Node {
      if (depth > 50)
        fail("Die Formel ist zu tief verschachtelt.", peek(), "#LIMIT");
      const token = tokens[at++];
      let left: Node;
      if (!token || token.kind === "end")
        fail(
          "Hier fehlt ein Wert oder eine Eigenschaft.",
          token || tokens.at(-1)!,
        );
      if (token.kind === "symbol" && token.text === "(") {
        left = expression(0, depth + 1);
        if (!symbol(")")) fail("Die schließende Klammer ) fehlt.", peek());
        at++;
      } else if (
        token.kind === "symbol" &&
        ["-", "+", "!"].includes(token.text)
      ) {
        const child = expression(7, depth + 1);
        left = {
          kind: "unary",
          op: token.text,
          child,
          start: token.start,
          end: child.end,
        };
      } else if (token.kind === "string" || token.kind === "number") {
        left = {
          kind: "literal",
          value: token.value,
          start: token.start,
          end: token.end,
        };
      } else if (token.kind === "property") {
        left = {
          kind: "property",
          name: token.text,
          start: token.start,
          end: token.end,
        };
      } else if (token.kind === "identifier") {
        if (symbol("(")) {
          at++;
          const fn = formulaFunctionByName.get(token.text.toLowerCase());
          if (!fn) fail(`Unbekannte Funktion „${token.text}“.`, token);
          const args: Node[] = [];
          if (!symbol(")")) {
            while (true) {
              args.push(expression(0, depth + 1));
              if (!symbol(",")) break;
              at++;
            }
          }
          if (!symbol(")"))
            fail(
              "Zwischen Argumenten fehlt ein Komma oder die schließende Klammer.",
              peek(),
            );
          const end = tokens[at++].end;
          if (
            args.length < fn.min ||
            args.length > fn.max ||
            (fn.name === "ifs" && args.length % 2 !== 1)
          )
            fail(`Argumente prüfen: ${fn.signature}.`, {
              start: token.start,
              end,
            });
          left = {
            kind: "call",
            name: fn.name.toLowerCase(),
            args,
            start: token.start,
            end,
          };
        } else if (["true", "false", "null"].includes(token.text)) {
          left = {
            kind: "literal",
            value: token.text === "null" ? null : token.text === "true",
            start: token.start,
            end: token.end,
          };
        } else
          left = {
            kind: "property",
            name: token.text,
            start: token.start,
            end: token.end,
          };
      } else fail("Hier wird ein Wert oder eine Eigenschaft erwartet.", token);
      while (peek().kind === "symbol" && (precedence[peek().text] || 0) > min) {
        const op = tokens[at++];
        const right = expression(precedence[op.text], depth + 1);
        left = {
          kind: "binary",
          op: op.text,
          left,
          right,
          start: left.start,
          end: right.end,
        };
      }
      return left;
    }
    const tree = expression();
    if (peek().kind !== "end")
      fail(
        "Unerwarteter Ausdruck; hier fehlt möglicherweise ein Operator.",
        peek(),
      );
    result = { ok: true, tree };
  } catch (e) {
    result = { ok: false, error: diagnostic(e) };
  }
  if (source.length <= FORMULA_MAX_LENGTH) {
    if (cache.size >= 256) cache.delete(cache.keys().next().value!);
    cache.set(source, result);
  }
  return result;
}
export function validateFormula(
  source: string,
  properties?: Iterable<string>,
): FormulaDiagnostic | null {
  const result = compileFormula(source);
  if (!result.ok) return result.error;
  if (!properties) return null;
  const names = new Set(properties),
    pending = [result.tree];
  while (pending.length) {
    const node = pending.pop()!;
    const name =
      node.kind === "property"
        ? node.name
        : node.kind === "call" &&
            node.name === "prop" &&
            node.args[0].kind === "literal"
          ? String(node.args[0].value)
          : undefined;
    if (name !== undefined && !names.has(name))
      return {
        code: "#PROPERTY",
        message: `Eigenschaft „${name}“ wurde nicht gefunden.`,
        start: node.start,
        end: node.end,
      };
    if (node.kind === "call") pending.push(...node.args);
    if (node.kind === "binary") pending.push(node.right, node.left);
    if (node.kind === "unary") pending.push(node.child);
  }
  return null;
}
export function hasClockFormulas(
  fields: Field[],
  schemas: Record<string, Field[]> = {},
): boolean {
  return [...fields, ...Object.values(schemas).flat()].some((field) => {
    if (field.type !== "formula") return false;
    const compiled = compileFormula(field.formula || "");
    if (!compiled.ok) return false;
    const pending = [compiled.tree];
    while (pending.length) {
      const node = pending.pop()!;
      if (node.kind === "call") {
        if (node.name === "now" || node.name === "today") return true;
        pending.push(...node.args);
      }
      if (node.kind === "binary") pending.push(node.left, node.right);
      if (node.kind === "unary") pending.push(node.child);
    }
    return false;
  });
}
export function formulaErrorMessage(code: FormulaCode) {
  return {
    "#CYCLE": "Die Eigenschaften verweisen im Kreis aufeinander.",
    "#LIMIT": "Die Berechnungsgrenze wurde erreicht.",
    "#ACCESS": "Auf eine verknüpfte Datenbank besteht kein Zugriff.",
    "#PROPERTY": "Eine benötigte Eigenschaft ist nicht verfügbar.",
    "#RELATION": "Die benötigte Relation ist nicht verfügbar.",
    "#DIV/0": "Division durch null ist nicht möglich.",
    "#ERROR": "Eine abhängige Berechnung ist fehlerhaft.",
  }[code];
}

// Only actual property references are rewritten; ordinary text literals stay intact.
export function rewriteFormulaReferences(
  source: string,
  fields: Field[],
  mode: "store" | "display",
): string {
  const compiled = compileFormula(source);
  if (!compiled.ok) return source;
  const pending = [compiled.tree],
    edits: { start: number; end: number; text: string }[] = [];
  while (pending.length) {
    const node = pending.pop()!;
    const literal =
      node.kind === "call" &&
      node.name === "prop" &&
      node.args[0]?.kind === "literal" &&
      typeof node.args[0].value === "string"
        ? node.args[0]
        : undefined;
    const name =
      node.kind === "property"
        ? node.name
        : (literal?.value as string | undefined);
    if (name !== undefined) {
      const field =
        fields.find((f) => f.id === name) ||
        fields.findLast((f) => f.name === name);
      if (field) {
        const readable =
          fields.filter((f) => f.name === field.name).length === 1 &&
          !fields.some((f) => f.id === field.name && f.id !== field.id);
        const target = mode === "store" || !readable ? field.id : field.name;
        const span = literal || node;
        edits.push({
          start: span.start,
          end: span.end,
          text: literal
            ? JSON.stringify(target)
            : `prop(${JSON.stringify(target)})`,
        });
      }
    }
    if (node.kind === "call" && !literal) pending.push(...node.args);
    if (node.kind === "binary") pending.push(node.left, node.right);
    if (node.kind === "unary") pending.push(node.child);
  }
  for (const edit of edits.sort((a, b) => b.start - a.start))
    source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  return source;
}
export function isFormulaError(value: unknown): value is FormulaCode {
  return (
    typeof value === "string" &&
    [
      "#ERROR",
      "#DIV/0",
      "#LIMIT",
      "#PROPERTY",
      "#CYCLE",
      "#ACCESS",
      "#RELATION",
    ].includes(value)
  );
}

export function evaluateFormula(
  source: string,
  cells: Record<string, unknown>,
  options: FormulaOptions = {},
): FormulaResult {
  const compiled = compileFormula(source);
  if (!compiled.ok) return compiled;
  let evaluations = 0;
  const now = options.now || new Date();
  function guard(value: unknown, node: Span): unknown {
    let entries = 0,
      characters = 0;
    const seen = new Set<object>();
    function check(v: unknown, depth: number) {
      if (++entries > 10000 || depth > 30)
        fail(
          "Der berechnete Wert ist zu groß oder zu tief verschachtelt.",
          node,
          "#LIMIT",
        );
      if (typeof v === "number" && !Number.isFinite(v))
        fail("Das Ergebnis ist keine endliche Zahl.", node);
      if (typeof v === "string") {
        characters += v.length;
        if (characters > MAX_TEXT)
          fail(
            "Ein Ergebnis darf insgesamt höchstens 20.000 Textzeichen enthalten.",
            node,
            "#LIMIT",
          );
      }
      if (v && typeof v === "object") {
        if (seen.has(v))
          fail("Zyklische Werte werden nicht unterstützt.", node, "#LIMIT");
        seen.add(v);
        const values = Array.isArray(v) ? v : Object.values(v);
        if (values.length > MAX_LIST)
          fail(
            "Listen dürfen höchstens 1.000 Einträge enthalten.",
            node,
            "#LIMIT",
          );
        for (const item of values) check(item, depth + 1);
        seen.delete(v);
      } else if (
        !["undefined", "boolean", "number", "string", "object"].includes(
          typeof v,
        )
      )
        fail("Dieser Werttyp wird nicht unterstützt.", node);
    }
    check(value, 0);
    return value;
  }
  function text(value: unknown, node: Span): string {
    const result = cellText(guard(value, node));
    guard(result, node);
    return result;
  }
  function num(value: unknown, node: Span): number {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (value === null || value === undefined || value === "") return 0;
    if (typeof value === "boolean") return value ? 1 : 0;
    if (
      typeof value === "string" &&
      /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())
    ) {
      const number = Number(value);
      if (Number.isFinite(number)) return number;
    }
    fail("Hier wird eine endliche Zahl oder numerischer Text erwartet.", node);
  }
  function integer(value: unknown, node: Span): number {
    const result = num(value, node);
    if (!Number.isSafeInteger(result))
      fail(
        "Hier wird eine ganze Zahl im sicheren Zahlenbereich erwartet.",
        node,
      );
    return result;
  }
  function array(value: unknown, node: Span): unknown[] {
    if (!Array.isArray(value)) fail("Hier wird eine Liste erwartet.", node);
    guard(value, node);
    return value;
  }
  function zone(value: unknown, node: Span): string {
    if (value === undefined) return "UTC";
    if (typeof value !== "string" || !validZone(value))
      fail(
        "Bitte eine gültige IANA-Zeitzone angeben, zum Beispiel Europe/Berlin.",
        node,
      );
    return value;
  }
  function date(value: unknown, node: Span): string {
    if (!validDateValue(value))
      fail(
        "Hier wird ein gültiges ISO-Datum oder ein ISO-Zeitpunkt erwartet.",
        node,
      );
    return value;
  }
  function instant(value: unknown, node: Span) {
    const valueDate = date(value, node);
    return Temporal.Instant.from(
      isTimed(valueDate)
        ? hasOffset(valueDate)
          ? valueDate
          : `${valueDate}Z`
        : `${valueDate}T00:00:00Z`,
    );
  }
  function zoned(value: unknown, timeZone: unknown, node: Span) {
    const valueDate = date(value, node),
      name = zone(timeZone, node);
    return isTimed(valueDate)
      ? instant(valueDate, node).toZonedDateTimeISO(name)
      : Temporal.PlainDate.from(valueDate).toZonedDateTime(name);
  }
  function unit(
    value: unknown,
    node: Span,
  ): "years" | "months" | "weeks" | "days" | "hours" | "minutes" | "seconds" {
    const name = text(value, node).toLowerCase().replace(/s$/, "") + "s";
    if (
      ![
        "years",
        "months",
        "weeks",
        "days",
        "hours",
        "minutes",
        "seconds",
      ].includes(name)
    )
      fail(
        "Unbekannte Datumseinheit. Erlaubt: years, months, weeks, days, hours, minutes, seconds.",
        node,
      );
    return name as ReturnType<typeof unit>;
  }
  function property(name: string, node: Span) {
    if (!Object.hasOwn(cells, name))
      fail(`Eigenschaft „${name}“ wurde nicht gefunden.`, node, "#PROPERTY");
    try {
      return guard(cells[name] ?? "", node);
    } catch (e) {
      if (e instanceof FormulaFault) fail(e.message, node, e.diagnostic.code);
      throw e;
    }
  }
  function evaluate(node: Node, depth = 0): unknown {
    if (++evaluations > 10000 || depth > 100)
      fail("Die Berechnungsgrenze wurde erreicht.", node, "#LIMIT");
    const read = (child: Node) => evaluate(child, depth + 1);
    if (node.kind === "literal") return node.value;
    if (node.kind === "property") return property(node.name, node);
    if (node.kind === "unary") {
      const value = read(node.child);
      return node.op === "!"
        ? !value
        : node.op === "-"
          ? -num(value, node)
          : num(value, node);
    }
    if (node.kind === "binary") {
      const left = read(node.left);
      if (node.op === "&&") return !!left && !!read(node.right);
      if (node.op === "||") return !!left || !!read(node.right);
      const right = read(node.right);
      let value: unknown;
      switch (node.op) {
        case "+":
          value =
            typeof left === "string" || typeof right === "string"
              ? text(left, node) + text(right, node)
              : num(left, node) + num(right, node);
          break;
        case "-":
          value = num(left, node) - num(right, node);
          break;
        case "*":
          value = num(left, node) * num(right, node);
          break;
        case "/":
        case "%": {
          const divisor = num(right, node);
          if (divisor === 0)
            fail(formulaErrorMessage("#DIV/0"), node, "#DIV/0");
          value =
            node.op === "/"
              ? num(left, node) / divisor
              : num(left, node) % divisor;
          break;
        }
        case "==":
          value = left === right;
          break;
        case "!=":
          value = left !== right;
          break;
        case ">":
          value = num(left, node) > num(right, node);
          break;
        case "<":
          value = num(left, node) < num(right, node);
          break;
        case ">=":
          value = num(left, node) >= num(right, node);
          break;
        case "<=":
          value = num(left, node) <= num(right, node);
          break;
      }
      return guard(value, node);
    }
    const get = (index: number) =>
      node.args[index] ? read(node.args[index]) : undefined;
    // Branching functions resolve only the arguments they actually need.
    if (node.name === "if") return get(get(0) ? 1 : 2);
    if (node.name === "ifs") {
      for (let i = 0; i < node.args.length - 1; i += 2)
        if (get(i)) return get(i + 1);
      return get(node.args.length - 1);
    }
    if (node.name === "and") return node.args.every((arg) => !!read(arg));
    if (node.name === "or") return node.args.some((arg) => !!read(arg));
    if (node.name === "coalesce") {
      for (const arg of node.args) {
        const value = read(arg);
        if (value !== null && value !== undefined && value !== "") return value;
      }
      return "";
    }
    const args = node.args.map(read);
    const a = args[0],
      b = args[1],
      c = args[2];
    const number = (index: number) =>
      num(args[index], node.args[index] || node);
    const str = (index: number) => text(args[index], node.args[index] || node);
    let value: unknown;
    switch (node.name) {
      case "prop":
        if (typeof a !== "string")
          fail(
            "prop erwartet einen Eigenschaftsnamen oder eine ID als Text.",
            node,
          );
        return property(a, node);
      case "not":
        value = !a;
        break;
      case "sum":
      case "min":
      case "max":
      case "average": {
        const values = args.flat().map((v) => num(v, node));
        if (values.length > MAX_LIST)
          fail("Zu viele Zahlen für eine Berechnung.", node, "#LIMIT");
        if (!values.length && node.name !== "sum")
          fail("Die Zahlenliste darf nicht leer sein.", node);
        value =
          node.name === "min"
            ? Math.min(...values)
            : node.name === "max"
              ? Math.max(...values)
              : values.reduce((total, n) => total + n, 0) /
                (node.name === "average" ? values.length : 1);
        break;
      }
      case "round": {
        const digits = b === undefined ? 0 : integer(b, node);
        if (digits < 0 || digits > 10)
          fail("round unterstützt null bis zehn Nachkommastellen.", node);
        value = Number(number(0).toFixed(digits));
        break;
      }
      case "abs":
        value = Math.abs(number(0));
        break;
      case "ceil":
        value = Math.ceil(number(0));
        break;
      case "floor":
        value = Math.floor(number(0));
        break;
      case "sqrt":
        value = Math.sqrt(number(0));
        break;
      case "pow":
        value = Math.pow(number(0), number(1));
        break;
      case "sign":
        value = Math.sign(number(0));
        break;
      case "mod":
        if (number(1) === 0)
          fail(formulaErrorMessage("#DIV/0"), node, "#DIV/0");
        value = number(0) % number(1);
        break;
      case "concat":
        value = args.map((arg) => text(arg, node)).join("");
        break;
      case "length":
        value = str(0).length;
        break;
      case "lower":
        value = str(0).toLowerCase();
        break;
      case "upper":
        value = str(0).toUpperCase();
        break;
      case "empty":
        value = !str(0);
        break;
      case "contains":
        value = str(0).includes(str(1));
        break;
      case "trim":
        value = str(0).trim();
        break;
      case "slice":
        value = str(0).slice(
          integer(b, node),
          c === undefined ? undefined : integer(c, node),
        );
        break;
      case "replace":
      case "replaceall": {
        const source = str(0),
          search = str(1),
          replacement = str(2);
        if (!search) fail("Der Suchtext darf nicht leer sein.", node);
        const pieces = source.split(search);
        const count =
          node.name === "replace"
            ? Math.min(1, pieces.length - 1)
            : pieces.length - 1;
        if (
          source.length + count * (replacement.length - search.length) >
          MAX_TEXT
        )
          fail("Das Textergebnis ist zu lang.", node, "#LIMIT");
        value =
          node.name === "replace"
            ? source.replace(search, () => replacement)
            : pieces.join(replacement);
        break;
      }
      case "startswith":
        value = str(0).startsWith(str(1));
        break;
      case "endswith":
        value = str(0).endsWith(str(1));
        break;
      case "repeat": {
        const source = str(0),
          count = integer(b, node);
        if (count < 0)
          fail("Die Wiederholungsanzahl darf nicht negativ sein.", node);
        if (source.length * count > MAX_TEXT)
          fail("Das Textergebnis ist zu lang.", node, "#LIMIT");
        value = source.repeat(count);
        break;
      }
      case "format":
        value = str(0);
        break;
      case "tonumber":
        value = number(0);
        break;
      case "list":
        value = args;
        break;
      case "count":
        value = array(a, node).length;
        break;
      case "at":
        value = array(a, node).at(integer(b, node)) ?? null;
        break;
      case "first":
        value = array(a, node)[0] ?? null;
        break;
      case "last":
        value = array(a, node).at(-1) ?? null;
        break;
      case "join": {
        const parts = array(a, node).map((v) => text(v, node)),
          separator = b === undefined ? ", " : str(1);
        if (
          parts.reduce((size, part) => size + part.length, 0) +
            Math.max(0, parts.length - 1) * separator.length >
          MAX_TEXT
        )
          fail("Das Textergebnis ist zu lang.", node, "#LIMIT");
        value = parts.join(separator);
        break;
      }
      case "split":
        value = str(0).split(str(1));
        break;
      case "unique": {
        const seen = new Set<string>();
        value = array(a, node).filter((v) => {
          const key = JSON.stringify(v) ?? "undefined";
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        break;
      }
      case "sort":
        value = [...array(a, node)].sort((x, y) =>
          typeof x === "number" && typeof y === "number"
            ? x - y
            : text(x, node).localeCompare(text(y, node), "de"),
        );
        break;
      case "reverse":
        value = [...array(a, node)].reverse();
        break;
      case "now":
        value = now.toISOString();
        break;
      case "today":
        value = Temporal.Instant.fromEpochMilliseconds(now.getTime())
          .toZonedDateTimeISO(zone(a, node))
          .toPlainDate()
          .toString();
        break;
      case "parsedate": {
        const parsed = date(a, node);
        value = isTimed(parsed) ? instant(parsed, node).toString() : parsed;
        break;
      }
      case "formatdate": {
        const z = zoned(a, args[2], node),
          pattern = b === undefined ? "YYYY-MM-DD" : str(1);
        const parts: Record<string, string> = {
          YYYY: String(z.year).padStart(4, "0"),
          MM: String(z.month).padStart(2, "0"),
          DD: String(z.day).padStart(2, "0"),
          HH: String(z.hour).padStart(2, "0"),
          mm: String(z.minute).padStart(2, "0"),
          ss: String(z.second).padStart(2, "0"),
        };
        value = pattern.replace(
          /YYYY|MM|DD|HH|mm|ss/g,
          (token) => parts[token],
        );
        break;
      }
      case "dateadd":
      case "datesubtract": {
        const original = date(a, node),
          amount = integer(b, node) * (node.name === "datesubtract" ? -1 : 1),
          u = unit(c, node);
        if (
          !isTimed(original) &&
          ["years", "months", "weeks", "days"].includes(u)
        ) {
          zone(args[3], node);
          value = Temporal.PlainDate.from(original)
            .add({ [u]: amount })
            .toString();
        } else
          value = zoned(original, args[3], node)
            .add({ [u]: amount })
            .toInstant()
            .toString();
        if (!validDateValue(value))
          fail(
            "Das berechnete Datum liegt außerhalb von Jahr 0001 bis 9999.",
            node,
          );
        break;
      }
      case "datebetween": {
        const end = instant(a, node),
          start = instant(b, node),
          delta = end.epochMilliseconds - start.epochMilliseconds;
        if (c === undefined) value = Math.round(delta / 86400000);
        else {
          const u = unit(c, node);
          if (u === "years" || u === "months")
            value = Math.trunc(
              start
                .toZonedDateTimeISO("UTC")
                .until(end.toZonedDateTimeISO("UTC"), {
                  largestUnit: u,
                  smallestUnit: u,
                  roundingMode: "trunc",
                })[u],
            );
          else
            value = Math.trunc(
              delta /
                {
                  weeks: 604800000,
                  days: 86400000,
                  hours: 3600000,
                  minutes: 60000,
                  seconds: 1000,
                }[u],
            );
        }
        break;
      }
      case "year":
      case "month":
      case "day":
      case "hour":
      case "minute":
        value = zoned(a, b, node)[node.name];
        break;
      case "timestamp":
        value = instant(a, node).epochMilliseconds;
        break;
      case "fromtimestamp":
        value = Temporal.Instant.fromEpochMilliseconds(
          integer(a, node),
        ).toString();
        if (!validDateValue(value))
          fail("Der Zeitpunkt liegt außerhalb von Jahr 0001 bis 9999.", node);
        break;
      default:
        fail("Unbekannte Funktion.", node);
    }
    return guard(value, node);
  }
  try {
    return { ok: true, value: guard(evaluate(compiled.tree), compiled.tree) };
  } catch (e) {
    return { ok: false, error: diagnostic(e) };
  }
}
export function formula(
  expression: string,
  cells: Record<string, unknown>,
  options?: FormulaOptions,
): unknown {
  const result = evaluateFormula(expression, cells, options);
  return result.ok ? result.value : result.error.code;
}
