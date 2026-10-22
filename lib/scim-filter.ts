// SCIM 2.0 filters and PATCH paths (RFC 7644 §3.4.2.2 and §3.5.2): a small
// parser and an evaluator over the JSON resources lib/scim.ts renders.
// Attribute names are case-insensitive; string comparisons too, except for
// "id" and "externalId" (caseExact in RFC 7643).
export const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
export const GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
export const ENTERPRISE_SCHEMA = "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";
const CORE = [USER_SCHEMA, GROUP_SCHEMA];
const EXTENSIONS = [ENTERPRISE_SCHEMA];

export class ScimFilterError extends Error {}

type Value = string | number | boolean | null;
export type Filter =
  | { kind: "cmp"; path: string[]; op: string; value: Value }
  | { kind: "pr"; path: string[] }
  | { kind: "and" | "or"; left: Filter; right: Filter }
  | { kind: "not"; filter: Filter }
  | { kind: "value"; path: string[]; filter: Filter };

const OPS = new Set(["eq", "ne", "co", "sw", "ew", "gt", "ge", "lt", "le"]);

// "name.givenName", "urn:…:User:userName", "urn:…:enterprise:2.0:User:department"
// → the segments to walk in a resource.
export function attributePath(raw: string): string[] {
  const lower = raw.toLowerCase();
  for (const urn of EXTENSIONS)
    if (lower.startsWith(`${urn.toLowerCase()}:`)) return [urn, ...raw.slice(urn.length + 1).split(".")];
  for (const urn of [...CORE, ...EXTENSIONS]) if (lower === urn.toLowerCase()) return [urn];
  for (const urn of CORE) if (lower.startsWith(`${urn.toLowerCase()}:`)) return raw.slice(urn.length + 1).split(".");
  if (!/^[A-Za-z$][\w$-]*(\.[A-Za-z$][\w$-]*)?$/.test(raw)) throw new ScimFilterError(`Invalid attribute path: ${raw}`);
  return raw.split(".");
}

type Token = { type: "word" | "string" | "punct"; value: string };
function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if ("()[]".includes(c)) {
      tokens.push({ type: "punct", value: c });
      i++;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < input.length && input[j] !== '"') j += input[j] === "\\" ? 2 : 1;
      if (j >= input.length) throw new ScimFilterError("Unterminated string");
      try {
        tokens.push({ type: "string", value: JSON.parse(input.slice(i, j + 1)) });
      } catch {
        throw new ScimFilterError("Invalid string");
      }
      i = j + 1;
      continue;
    }
    const m = /^[^\s()[\]"]+/.exec(input.slice(i));
    if (!m) throw new ScimFilterError("Invalid filter");
    tokens.push({ type: "word", value: m[0] });
    i += m[0].length;
  }
  return tokens;
}

export function parseFilter(input: string): Filter {
  if (input.length > 2000) throw new ScimFilterError("Filter too long");
  const tokens = tokenize(input);
  let pos = 0;
  let depth = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const keyword = (word: string) => peek()?.type === "word" && peek().value.toLowerCase() === word;
  const expect = (value: string) => {
    const t = next();
    if (!t || t.type !== "punct" || t.value !== value) throw new ScimFilterError(`Expected ${value}`);
  };
  function or(): Filter {
    let left = and();
    while (keyword("or")) {
      next();
      left = { kind: "or", left, right: and() };
    }
    return left;
  }
  function and(): Filter {
    let left = unary();
    while (keyword("and")) {
      next();
      left = { kind: "and", left, right: unary() };
    }
    return left;
  }
  function unary(): Filter {
    if (++depth > 20) throw new ScimFilterError("Filter nested too deeply");
    try {
      if (keyword("not")) {
        next();
        expect("(");
        const filter = or();
        expect(")");
        return { kind: "not", filter };
      }
      if (peek()?.type === "punct" && peek().value === "(") {
        next();
        const filter = or();
        expect(")");
        return filter;
      }
      const attr = next();
      if (!attr || attr.type !== "word") throw new ScimFilterError("Expected an attribute");
      const path = attributePath(attr.value);
      if (peek()?.type === "punct" && peek().value === "[") {
        next();
        const filter = or();
        expect("]");
        return { kind: "value", path, filter };
      }
      const op = next();
      if (!op || op.type !== "word") throw new ScimFilterError("Expected an operator");
      const name = op.value.toLowerCase();
      if (name === "pr") return { kind: "pr", path };
      if (!OPS.has(name)) throw new ScimFilterError(`Unknown operator ${op.value}`);
      const raw = next();
      if (!raw) throw new ScimFilterError("Expected a value");
      let value: Value;
      if (raw.type === "string") value = raw.value;
      else if (raw.type === "word" && ["true", "false"].includes(raw.value.toLowerCase())) value = raw.value.toLowerCase() === "true";
      else if (raw.type === "word" && raw.value.toLowerCase() === "null") value = null;
      else if (raw.type === "word" && /^-?\d+(\.\d+)?$/.test(raw.value)) value = Number(raw.value);
      else throw new ScimFilterError("Invalid value");
      return { kind: "cmp", path, op: name, value };
    } finally {
      depth--;
    }
  }
  const filter = or();
  if (pos !== tokens.length) throw new ScimFilterError("Unexpected input after the filter");
  return filter;
}

type Json = Record<string, unknown>;
// The value under one key, ignoring case.
export function getKey(obj: unknown, key: string): unknown {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return undefined;
  const lower = key.toLowerCase();
  for (const [k, v] of Object.entries(obj as Json)) if (k.toLowerCase() === lower) return v;
  return undefined;
}
// All values at a path, multi-valued attributes flattened.
function valuesAt(resource: unknown, path: string[]): unknown[] {
  let current: unknown[] = [resource];
  for (const segment of path) {
    const nextValues: unknown[] = [];
    for (const item of current) {
      const v = getKey(item, segment);
      if (Array.isArray(v)) nextValues.push(...v);
      else if (v !== undefined) nextValues.push(v);
    }
    current = nextValues;
  }
  return current;
}

const caseExact = (path: string[]) => ["id", "externalid"].includes(path[path.length - 1].toLowerCase()) && path.length === 1;
function compare(actual: unknown, op: string, expected: Value, exact: boolean): boolean {
  if (actual && typeof actual === "object") {
    // A complex value compared directly: its "value" sub-attribute.
    return compare(getKey(actual, "value"), op, expected, exact);
  }
  if (expected === null) return op === "eq" ? actual === null || actual === undefined : op === "ne" ? actual !== null && actual !== undefined : false;
  if (typeof expected === "boolean") {
    const a = typeof actual === "string" ? actual.toLowerCase() === "true" : actual === true;
    return op === "eq" ? a === expected : op === "ne" ? a !== expected : false;
  }
  if (typeof expected === "number" && typeof actual === "number") {
    switch (op) {
      case "eq": return actual === expected;
      case "ne": return actual !== expected;
      case "gt": return actual > expected;
      case "ge": return actual >= expected;
      case "lt": return actual < expected;
      case "le": return actual <= expected;
      default: return false;
    }
  }
  if (actual === null || actual === undefined) return op === "ne";
  let a = String(actual);
  let e = String(expected);
  if (!exact) {
    a = a.toLowerCase();
    e = e.toLowerCase();
  }
  switch (op) {
    case "eq": return a === e;
    case "ne": return a !== e;
    case "co": return a.includes(e);
    case "sw": return a.startsWith(e);
    case "ew": return a.endsWith(e);
    case "gt": return a > e;
    case "ge": return a >= e;
    case "lt": return a < e;
    case "le": return a <= e;
    default: return false;
  }
}

export function matches(resource: unknown, filter: Filter): boolean {
  switch (filter.kind) {
    case "and":
      return matches(resource, filter.left) && matches(resource, filter.right);
    case "or":
      return matches(resource, filter.left) || matches(resource, filter.right);
    case "not":
      return !matches(resource, filter.filter);
    case "pr":
      return valuesAt(resource, filter.path).some((v) => v !== null && v !== "" && !(Array.isArray(v) && !v.length));
    case "value":
      return valuesAt(resource, filter.path).some((item) => matches(item, filter.filter));
    case "cmp": {
      const values = valuesAt(resource, filter.path);
      const exact = caseExact(filter.path);
      if (filter.op === "ne") return !values.some((v) => compare(v, "eq", filter.value, exact));
      return values.some((v) => compare(v, filter.op, filter.value, exact));
    }
  }
}

// A PATCH path: an attribute, optionally a filter on its values and a
// sub-attribute ("emails[type eq \"work\"].value", "members[value eq \"…\"]").
export type PatchPath = { attr: string[]; filter?: Filter; sub?: string };
export function parsePatchPath(raw: string): PatchPath {
  const open = raw.indexOf("[");
  if (open < 0) {
    const attr = attributePath(raw.trim());
    return { attr };
  }
  const close = raw.lastIndexOf("]");
  if (close < open) throw new ScimFilterError("Invalid path");
  const attr = attributePath(raw.slice(0, open).trim());
  const filter = parseFilter(raw.slice(open + 1, close));
  const rest = raw.slice(close + 1).trim();
  if (rest && !/^\.[A-Za-z$][\w$-]*$/.test(rest)) throw new ScimFilterError("Invalid path");
  return { attr, filter, ...(rest ? { sub: rest.slice(1) } : {}) };
}
