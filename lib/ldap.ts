// A minimal LDAPv3 client without dependencies (RFC 4511): simple bind,
// search with RFC 4515 filters, unbind, ldaps:// over node:tls and
// optional StartTLS. Only the BER subset these operations need is encoded
// and decoded. Responses are bounded (message size, entries, buffered
// bytes) and every operation has a timeout.
//
// Configuration comes from the environment (lib/ldap-auth.ts uses it for
// sign-in and the group sync):
//   LDAP_URL               ldap://host:389 or ldaps://host:636
//   LDAP_BIND_DN/PASSWORD  the account that searches for people (optional:
//                          anonymous search without it)
//   LDAP_BASE_DN           where people are searched
//   LDAP_USER_FILTER       default (|(uid={user})(mail={user})); {user} is
//                          replaced by the escaped sign-in name
//   LDAP_GROUP_ATTRIBUTE   default memberOf
//   LDAP_TLS_CA            PEM file or PEM text of the CA to trust
//   LDAP_STARTTLS          true: upgrade ldap:// with StartTLS
//   LDAP_TIMEOUT_MS        per operation, default 8000
import { connect as netConnect, isIP, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { readFileSync } from "node:fs";

// ---- BER ----

const MAX_MESSAGE = 1024 * 1024;
const MAX_BUFFER = 4 * 1024 * 1024;
const MAX_ENTRIES = 2000;

export function berLength(length: number) {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let n = length; n > 0; n = Math.floor(n / 256)) bytes.unshift(n & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
export function tlv(tag: number, content: Buffer) {
  return Buffer.concat([Buffer.from([tag]), berLength(content.length), content]);
}
function integerBytes(value: number) {
  if (!Number.isInteger(value)) throw new Error("Not an integer");
  const bytes: number[] = [];
  let n = value;
  do {
    bytes.unshift(n & 0xff);
    n = Math.floor(n / 256);
  } while (n !== 0 && n !== -1);
  // Keep the sign bit right (two's complement).
  if (value >= 0 && bytes[0] & 0x80) bytes.unshift(0);
  if (value < 0 && !(bytes[0] & 0x80)) bytes.unshift(0xff);
  return Buffer.from(bytes);
}
export const ber = {
  int: (value: number, tag = 0x02) => tlv(tag, integerBytes(value)),
  enumerated: (value: number) => tlv(0x0a, integerBytes(value)),
  bool: (value: boolean, tag = 0x01) => tlv(tag, Buffer.from([value ? 0xff : 0])),
  str: (value: string | Buffer, tag = 0x04) => tlv(tag, typeof value === "string" ? Buffer.from(value, "utf8") : value),
  seq: (tag: number, ...children: Buffer[]) => tlv(tag, Buffer.concat(children)),
};

export type Tlv = { tag: number; value: Buffer; size: number };
// One element at the start of the buffer, or null while it is incomplete.
export function readTlv(buf: Buffer, offset = 0, limit = MAX_MESSAGE): Tlv | null {
  if (buf.length - offset < 2) return null;
  const tag = buf[offset];
  if ((tag & 0x1f) === 0x1f) throw new LdapError("Unsupported BER tag");
  let length = buf[offset + 1];
  let header = 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0) throw new LdapError("Indefinite BER length");
    if (count > 4) throw new LdapError("BER length too large");
    if (buf.length - offset < 2 + count) return null;
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + buf[offset + 2 + i];
    header += count;
  }
  if (length > limit) throw new LdapError("LDAP message too large");
  if (buf.length - offset < header + length) return null;
  return { tag, value: buf.subarray(offset + header, offset + header + length), size: header + length };
}
// The elements inside a constructed value.
export function children(value: Buffer): Tlv[] {
  const out: Tlv[] = [];
  let offset = 0;
  while (offset < value.length) {
    const item = readTlv(value, offset, value.length);
    if (!item) throw new LdapError("Truncated BER value");
    out.push(item);
    offset += item.size;
  }
  return out;
}
export function readInt(value: Buffer) {
  if (!value.length || value.length > 6) throw new LdapError("Invalid BER integer");
  let n = value[0] & 0x80 ? -1 : 0;
  for (const byte of value) n = n * 256 + byte;
  return n;
}

// ---- Filters (RFC 4515) ----

// A value inside a filter: the characters with a meaning in filters
// become \XX, so a sign-in name never changes the filter's structure.
export function escapeFilterValue(value: string) {
  return value.replace(/[\\*()\0]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
}
// A value inside a DN (RFC 4514).
export function escapeDnValue(value: string) {
  let out = value.replace(/[\\",+;<>=\0]/g, (c) => (c === "\0" ? "\\00" : `\\${c}`));
  if (/^[ #]/.test(out)) out = `\\${out}`;
  if (/ $/.test(out)) out = `${out.slice(0, -1)}\\ `;
  return out;
}
// The value of the first RDN of a DN ("cn=Team A,ou=groups" → "Team A"),
// or null when the text is no DN.
export function firstRdnValue(dn: string): string | null {
  let i = 0;
  const attr = /^\s*([A-Za-z][\w-]*|\d+(?:\.\d+)*)\s*=/.exec(dn);
  if (!attr) return null;
  i = attr[0].length;
  const bytes: number[] = [];
  while (i < dn.length) {
    const c = dn[i];
    if (c === "," || c === "+") break;
    if (c === "\\") {
      const hex = /^[0-9a-fA-F]{2}/.exec(dn.slice(i + 1));
      if (hex) {
        bytes.push(parseInt(hex[0], 16));
        i += 3;
      } else {
        bytes.push(...Buffer.from(dn[i + 1] || "", "utf8"));
        i += 2;
      }
      continue;
    }
    bytes.push(...Buffer.from(c, "utf8"));
    i++;
  }
  return Buffer.from(bytes).toString("utf8").trim() || null;
}

export type LdapFilter =
  | { type: "and" | "or"; filters: LdapFilter[] }
  | { type: "not"; filter: LdapFilter }
  | { type: "equal" | "approx" | "ge" | "le"; attr: string; value: Buffer }
  | { type: "present"; attr: string }
  | { type: "substrings"; attr: string; initial?: Buffer; any: Buffer[]; final?: Buffer };

const ATTRIBUTE = /^(?:[A-Za-z][A-Za-z0-9-]*|\d+(?:\.\d+)*)(?:;[A-Za-z0-9-]+)*$/;
// "\2a" escapes become bytes; "*" outside an escape splits substrings.
function unescapeParts(raw: string) {
  const parts: Buffer[] = [];
  let bytes: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === "*") {
      parts.push(Buffer.from(bytes));
      bytes = [];
    } else if (c === "\\") {
      const hex = raw.slice(i + 1, i + 3);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw new LdapError("Invalid escape in LDAP filter");
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else if (c === "(" || c === ")" || c === "\0") throw new LdapError("Invalid character in LDAP filter");
    else bytes.push(...Buffer.from(c, "utf8"));
  }
  parts.push(Buffer.from(bytes));
  return parts;
}
export function parseLdapFilter(input: string): LdapFilter {
  const text = input.trim().startsWith("(") ? input.trim() : `(${input.trim()})`;
  if (text.length > 4096) throw new LdapError("LDAP filter too long");
  let pos = 0;
  let depth = 0;
  function filter(): LdapFilter {
    if (text[pos] !== "(") throw new LdapError("Expected ( in LDAP filter");
    if (++depth > 32) throw new LdapError("LDAP filter nested too deeply");
    pos++;
    let result: LdapFilter;
    const c = text[pos];
    if (c === "&" || c === "|") {
      pos++;
      const filters: LdapFilter[] = [];
      while (text[pos] === "(") filters.push(filter());
      result = { type: c === "&" ? "and" : "or", filters };
    } else if (c === "!") {
      pos++;
      result = { type: "not", filter: filter() };
    } else {
      // An item: up to the closing parenthesis (escaped ones are \29).
      const end = text.indexOf(")", pos);
      if (end < 0) throw new LdapError("Missing ) in LDAP filter");
      const item = text.slice(pos, end);
      pos = end;
      const m = /^([^=~<>]+)(=|~=|>=|<=)([\s\S]*)$/.exec(item);
      if (!m || !ATTRIBUTE.test(m[1])) throw new LdapError("Invalid LDAP filter item");
      const [, attr, op, raw] = m;
      if (op === "=" && raw === "*") result = { type: "present", attr };
      else {
        const parts = unescapeParts(raw);
        if (op !== "=" && parts.length > 1) throw new LdapError("Wildcard only with =");
        if (parts.length === 1)
          result = { type: op === "=" ? "equal" : op === "~=" ? "approx" : op === ">=" ? "ge" : "le", attr, value: parts[0] };
        else {
          const initial = parts[0],
            final = parts[parts.length - 1];
          result = {
            type: "substrings",
            attr,
            ...(initial.length ? { initial } : {}),
            any: parts.slice(1, -1).filter((p) => p.length),
            ...(final.length ? { final } : {}),
          };
        }
      }
    }
    if (text[pos] !== ")") throw new LdapError("Expected ) in LDAP filter");
    pos++;
    depth--;
    return result;
  }
  const result = filter();
  if (pos !== text.length) throw new LdapError("Unexpected input after the LDAP filter");
  return result;
}
export function encodeFilter(f: LdapFilter): Buffer {
  switch (f.type) {
    case "and":
      return ber.seq(0xa0, ...f.filters.map(encodeFilter));
    case "or":
      return ber.seq(0xa1, ...f.filters.map(encodeFilter));
    case "not":
      return ber.seq(0xa2, encodeFilter(f.filter));
    case "equal":
    case "ge":
    case "le":
    case "approx":
      return ber.seq({ equal: 0xa3, ge: 0xa5, le: 0xa6, approx: 0xa8 }[f.type], ber.str(f.attr), ber.str(f.value));
    case "present":
      return ber.str(f.attr, 0x87);
    case "substrings":
      return ber.seq(
        0xa4,
        ber.str(f.attr),
        ber.seq(
          0x30,
          ...(f.initial ? [ber.str(f.initial, 0x80)] : []),
          ...f.any.map((a) => ber.str(a, 0x81)),
          ...(f.final ? [ber.str(f.final, 0x82)] : []),
        ),
      );
  }
}
// The other way round (for servers and tests).
export function decodeFilter(t: Tlv): LdapFilter {
  const items = () => children(t.value);
  switch (t.tag) {
    case 0xa0:
    case 0xa1:
      return { type: t.tag === 0xa0 ? "and" : "or", filters: items().map(decodeFilter) };
    case 0xa2:
      return { type: "not", filter: decodeFilter(items()[0]) };
    case 0xa3:
    case 0xa5:
    case 0xa6:
    case 0xa8: {
      const [attr, value] = items();
      const type = ({ 0xa3: "equal", 0xa5: "ge", 0xa6: "le", 0xa8: "approx" } as const)[t.tag];
      return { type, attr: attr.value.toString("utf8"), value: Buffer.from(value.value) };
    }
    case 0x87:
      return { type: "present", attr: t.value.toString("utf8") };
    case 0xa4: {
      const [attr, subs] = items();
      const f: LdapFilter = { type: "substrings", attr: attr.value.toString("utf8"), any: [] };
      for (const s of children(subs.value)) {
        if (s.tag === 0x80) f.initial = Buffer.from(s.value);
        else if (s.tag === 0x81) f.any.push(Buffer.from(s.value));
        else if (s.tag === 0x82) f.final = Buffer.from(s.value);
      }
      return f;
    }
    default:
      throw new LdapError("Unsupported LDAP filter");
  }
}
// The filter of the sign-in: {user} replaced by the escaped name.
export function userFilter(template: string, user: string) {
  return parseLdapFilter(template.split("{user}").join(escapeFilterValue(user)));
}

// ---- Protocol ----

export class LdapError extends Error {
  constructor(
    message: string,
    public code?: number,
  ) {
    super(message);
  }
  // Wrong name or password (invalidCredentials).
  get invalidCredentials() {
    return this.code === 49;
  }
}

export type LdapEntry = { dn: string; attributes: Record<string, string[]> };
export const attr = (entry: LdapEntry, name: string) => entry.attributes[name.toLowerCase()] || [];
export const first = (entry: LdapEntry, name: string) => attr(entry, name)[0] || "";

export type LdapConfig = {
  url: string;
  bindDn: string;
  bindPassword: string;
  baseDn: string;
  userFilter: string;
  groupAttribute: string;
  tlsCa?: string;
  startTls: boolean;
  timeoutMs: number;
};
export function ldapConfigured() {
  return !!process.env.LDAP_URL?.trim() && !!process.env.LDAP_BASE_DN?.trim();
}
export function ldapConfig(): LdapConfig | null {
  if (!ldapConfigured()) return null;
  const ca = process.env.LDAP_TLS_CA?.trim();
  return {
    url: process.env.LDAP_URL!.trim(),
    bindDn: process.env.LDAP_BIND_DN?.trim() || "",
    bindPassword: process.env.LDAP_BIND_PASSWORD || "",
    baseDn: process.env.LDAP_BASE_DN!.trim(),
    userFilter: process.env.LDAP_USER_FILTER?.trim() || "(|(uid={user})(mail={user}))",
    groupAttribute: process.env.LDAP_GROUP_ATTRIBUTE?.trim() || "memberOf",
    tlsCa: ca ? (ca.startsWith("-----BEGIN") ? ca.replace(/\\n/g, "\n") : readFileSync(ca, "utf8")) : undefined,
    startTls: process.env.LDAP_STARTTLS === "true",
    timeoutMs: Math.min(60_000, Math.max(1000, Number(process.env.LDAP_TIMEOUT_MS) || 8000)),
  };
}

type Pending = { onMessage: (op: Tlv) => void; fail: (e: Error) => void };
const RESULT_NAMES: Record<number, string> = {
  1: "operationsError",
  2: "protocolError",
  3: "timeLimitExceeded",
  4: "sizeLimitExceeded",
  32: "noSuchObject",
  34: "invalidDNSyntax",
  48: "inappropriateAuthentication",
  49: "invalidCredentials",
  50: "insufficientAccessRights",
  51: "busy",
  52: "unavailable",
  53: "unwillingToPerform",
};
function ldapResult(op: Tlv) {
  const [code, , message] = children(op.value);
  return { code: readInt(code.value), message: message ? message.value.toString("utf8") : "" };
}

export class LdapConnection {
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private closed: Error | null = null;
  private constructor(
    private socket: Socket | TLSSocket,
    private timeoutMs: number,
  ) {
    this.listen(socket);
  }
  private listen(socket: Socket | TLSSocket) {
    socket.on("data", (chunk: Buffer) => this.receive(chunk));
    socket.on("error", (e) => this.shutdown(new LdapError(`LDAP connection failed: ${e.message}`)));
    socket.on("close", () => this.shutdown(new LdapError("LDAP connection closed")));
  }
  static async open(config: Pick<LdapConfig, "url" | "tlsCa" | "startTls" | "timeoutMs">) {
    const url = new URL(config.url);
    if (url.protocol !== "ldap:" && url.protocol !== "ldaps:") throw new LdapError("LDAP_URL must start with ldap:// or ldaps://");
    const secure = url.protocol === "ldaps:";
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const port = Number(url.port) || (secure ? 636 : 389);
    const tlsOptions = { ca: config.tlsCa, servername: isIP(host) ? undefined : host, rejectUnauthorized: true };
    const socket = await new Promise<Socket | TLSSocket>((resolve, reject) => {
      const s = secure ? tlsConnect({ host, port, ...tlsOptions }) : netConnect({ host, port });
      const timer = setTimeout(() => {
        s.destroy();
        reject(new LdapError("LDAP server did not answer in time"));
      }, config.timeoutMs);
      s.once(secure ? "secureConnect" : "connect", () => {
        clearTimeout(timer);
        s.removeAllListeners("error");
        resolve(s);
      });
      s.once("error", (e) => {
        clearTimeout(timer);
        reject(new LdapError(`LDAP connection failed: ${e.message}`));
      });
    });
    const conn = new LdapConnection(socket, config.timeoutMs);
    if (!secure && config.startTls) await conn.startTls(tlsOptions);
    return conn;
  }
  private receive(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > MAX_BUFFER) return this.shutdown(new LdapError("LDAP response too large"));
    try {
      for (;;) {
        const message = readTlv(this.buffer);
        if (!message) return;
        this.buffer = this.buffer.subarray(message.size);
        if (message.tag !== 0x30) throw new LdapError("Invalid LDAP message");
        const [id, op] = children(message.value);
        const messageId = readInt(id.value);
        // Notice of disconnection (message 0) ends everything.
        if (messageId === 0) throw new LdapError("LDAP server closed the connection");
        this.pending.get(messageId)?.onMessage(op);
      }
    } catch (e) {
      this.shutdown(e instanceof LdapError ? e : new LdapError("Invalid LDAP response"));
    }
  }
  private shutdown(error: Error) {
    if (this.closed) return;
    this.closed = error;
    for (const p of this.pending.values()) p.fail(error);
    this.pending.clear();
    this.socket.destroy();
  }
  // Sends one request; handle() returns true once the answer is complete.
  private request<T>(op: Buffer, handle: (op: Tlv, done: (value: T) => void) => void): Promise<T> {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new LdapError("LDAP server did not answer in time"));
        this.shutdown(new LdapError("LDAP timeout"));
      }, this.timeoutMs);
      const finish = () => {
        clearTimeout(timer);
        this.pending.delete(id);
      };
      this.pending.set(id, {
        onMessage: (message) => {
          try {
            handle(message, (value) => {
              finish();
              resolve(value);
            });
          } catch (e) {
            finish();
            reject(e);
          }
        },
        fail: (e) => {
          finish();
          reject(e);
        },
      });
      this.socket.write(ber.seq(0x30, ber.int(id), op));
    });
  }
  private async startTls(options: { ca?: string; servername?: string; rejectUnauthorized: boolean }) {
    await this.request<void>(ber.seq(0x77, ber.str("1.3.6.1.4.1.1466.20037", 0x80)), (op, done) => {
      if (op.tag !== 0x78) throw new LdapError("Unexpected answer to StartTLS");
      const result = ldapResult(op);
      if (result.code !== 0) throw new LdapError(`StartTLS refused: ${result.message || RESULT_NAMES[result.code] || result.code}`, result.code);
      done();
    });
    const plain = this.socket;
    plain.removeAllListeners("data");
    plain.removeAllListeners("error");
    plain.removeAllListeners("close");
    this.socket = await new Promise<TLSSocket>((resolve, reject) => {
      const timer = setTimeout(() => reject(new LdapError("TLS handshake timed out")), this.timeoutMs);
      const secure = tlsConnect({ socket: plain, ...options });
      secure.once("secureConnect", () => {
        clearTimeout(timer);
        secure.removeAllListeners("error");
        resolve(secure);
      });
      secure.once("error", (e) => {
        clearTimeout(timer);
        reject(new LdapError(`TLS failed: ${e.message}`));
      });
    });
    this.listen(this.socket);
  }
  // Simple bind. An empty password would be an unauthenticated bind, which
  // servers accept without checking anything: refused here.
  async bind(dn: string, password: string) {
    if (!password) throw new LdapError("Empty password", 49);
    await this.request<void>(ber.seq(0x60, ber.int(3), ber.str(dn), ber.str(password, 0x80)), (op, done) => {
      if (op.tag !== 0x61) throw new LdapError("Unexpected answer to bind");
      const result = ldapResult(op);
      if (result.code !== 0) throw new LdapError(`LDAP bind failed: ${RESULT_NAMES[result.code] || result.code}`, result.code);
      done();
    });
  }
  // scope: 0 base object, 1 one level, 2 subtree. noSuchObject gives [].
  async search(options: { base: string; scope: 0 | 1 | 2; filter: LdapFilter; attributes: string[]; sizeLimit?: number }) {
    const limit = Math.min(MAX_ENTRIES, options.sizeLimit || MAX_ENTRIES);
    const entries: LdapEntry[] = [];
    return this.request<LdapEntry[]>(
      ber.seq(
        0x63,
        ber.str(options.base),
        ber.enumerated(options.scope),
        ber.enumerated(0),
        ber.int(limit),
        ber.int(Math.ceil(this.timeoutMs / 1000)),
        ber.bool(false),
        encodeFilter(options.filter),
        ber.seq(0x30, ...options.attributes.map((a) => ber.str(a))),
      ),
      (op, done) => {
        if (op.tag === 0x64) {
          if (entries.length >= limit) throw new LdapError("Too many LDAP entries");
          const [name, attrs] = children(op.value);
          const attributes: Record<string, string[]> = {};
          for (const a of attrs ? children(attrs.value) : []) {
            const [type, values] = children(a.value);
            attributes[type.value.toString("utf8").toLowerCase()] = children(values.value).map((v) => v.value.toString("utf8"));
          }
          entries.push({ dn: name.value.toString("utf8"), attributes });
        } else if (op.tag === 0x65) {
          const result = ldapResult(op);
          if (result.code === 0 || result.code === 4) done(entries);
          else if (result.code === 32) done([]);
          else throw new LdapError(`LDAP search failed: ${RESULT_NAMES[result.code] || result.code}`, result.code);
        } else if (op.tag !== 0x73) throw new LdapError("Unexpected answer to search");
      },
    );
  }
  close() {
    if (!this.closed) {
      try {
        this.socket.write(ber.seq(0x30, ber.int(this.nextId++), tlv(0x42, Buffer.alloc(0))));
      } catch {}
      this.socket.end();
      this.closed = new LdapError("LDAP connection closed");
      setTimeout(() => this.socket.destroy(), 1000).unref?.();
    }
  }
}

// ---- What Flowplan does with it ----

export function userAttributes(config: LdapConfig) {
  return [
    "mail",
    "cn",
    "displayName",
    "givenName",
    "sn",
    "uid",
    "sAMAccountName",
    "userPrincipalName",
    config.groupAttribute,
    "userAccountControl",
    "nsAccountLock",
    "pwdAccountLockedTime",
  ];
}

async function withConnection<T>(config: LdapConfig, fn: (conn: LdapConnection) => Promise<T>) {
  const conn = await LdapConnection.open(config);
  try {
    return await fn(conn);
  } finally {
    conn.close();
  }
}
async function serviceBind(conn: LdapConnection, config: LdapConfig) {
  if (config.bindDn) await conn.bind(config.bindDn, config.bindPassword);
}

// Signs in: finds the person with the search account, then binds as them
// with the password. Returns their entry; LdapError.invalidCredentials for
// an unknown name, an ambiguous one or a wrong password.
export async function ldapAuthenticate(user: string, password: string, config = ldapConfig()): Promise<LdapEntry> {
  if (!config) throw new LdapError("LDAP is not configured");
  // eslint-disable-next-line no-control-regex
  if (!user || user.length > 256 || /[\u0000-\u001f]/.test(user)) throw new LdapError("Invalid user name", 49);
  if (!password) throw new LdapError("Empty password", 49);
  return withConnection(config, async (conn) => {
    await serviceBind(conn, config);
    const found = await conn.search({
      base: config.baseDn,
      scope: 2,
      filter: userFilter(config.userFilter, user),
      attributes: userAttributes(config),
      sizeLimit: 2,
    });
    if (found.length !== 1) throw new LdapError("Unknown or ambiguous user", 49);
    await conn.bind(found[0].dn, password);
    return found[0];
  });
}
// Checks a password for a known DN (confirming changes in the settings).
export async function ldapCheckPassword(dn: string, password: string, config = ldapConfig()) {
  if (!config) return false;
  try {
    await withConnection(config, (conn) => conn.bind(dn, password));
    return true;
  } catch (e) {
    if (e instanceof LdapError && e.invalidCredentials) return false;
    throw e;
  }
}
// Reads the current entries of known people (base search per DN; a missing
// entry is null). The base DN is checked first, so a wrong configuration is
// an error rather than "everyone is gone".
export async function ldapReadEntries(dns: string[], config = ldapConfig()) {
  if (!config) throw new LdapError("LDAP is not configured");
  return withConnection(config, async (conn) => {
    await serviceBind(conn, config);
    const base = await conn.search({ base: config.baseDn, scope: 0, filter: { type: "present", attr: "objectClass" }, attributes: ["1.1"] });
    if (!base.length) throw new LdapError("LDAP_BASE_DN not found");
    const result = new Map<string, LdapEntry | null>();
    for (const dn of dns) {
      const found = await conn.search({ base: dn, scope: 0, filter: { type: "present", attr: "objectClass" }, attributes: userAttributes(config), sizeLimit: 1 });
      result.set(dn, found[0] || null);
    }
    return result;
  });
}
// Test connection from the administration: connect, bind, read the base.
export async function ldapTest(config = ldapConfig()) {
  const started = Date.now();
  if (!config) return { ok: false, ms: 0, error: "LDAP is not configured" };
  try {
    await withConnection(config, async (conn) => {
      await serviceBind(conn, config);
      const base = await conn.search({ base: config.baseDn, scope: 0, filter: { type: "present", attr: "objectClass" }, attributes: ["1.1"] });
      if (!base.length) throw new LdapError("LDAP_BASE_DN not found");
    });
    return { ok: true, ms: Date.now() - started, error: "" };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, error: e instanceof Error ? e.message : "LDAP error" };
  }
}

// The groups of an entry: for DN values the name of the group (the first
// RDN, e.g. the CN) and the full DN, so a mapping can name either.
export function groupNames(entry: LdapEntry, groupAttribute: string) {
  const names = new Set<string>();
  for (const value of attr(entry, groupAttribute).slice(0, 1000)) {
    const v = value.trim();
    if (!v) continue;
    names.add(v);
    const rdn = firstRdnValue(v);
    if (rdn && /=/.test(v)) names.add(rdn);
  }
  return [...names].map((n) => n.slice(0, 500));
}
// Disabled in the directory: Active Directory (userAccountControl bit 2),
// 389 Directory Server (nsAccountLock) or OpenLDAP ppolicy lock.
export function entryLocked(entry: LdapEntry) {
  const uac = Number(first(entry, "userAccountControl"));
  if (Number.isFinite(uac) && uac & 2) return true;
  if (first(entry, "nsAccountLock").toLowerCase() === "true") return true;
  return attr(entry, "pwdAccountLockedTime").length > 0;
}
export function entryProfile(entry: LdapEntry, user = "") {
  const mail = first(entry, "mail") || (first(entry, "userPrincipalName").includes("@") ? first(entry, "userPrincipalName") : "") || (user.includes("@") ? user : "");
  const name =
    first(entry, "displayName") ||
    first(entry, "cn") ||
    [first(entry, "givenName"), first(entry, "sn")].filter(Boolean).join(" ") ||
    first(entry, "uid") ||
    first(entry, "sAMAccountName") ||
    user;
  return {
    name: name.slice(0, 80) || "Mitglied",
    email: mail.slice(0, 200),
    username: (first(entry, "uid") || first(entry, "sAMAccountName") || user).slice(0, 200),
  };
}
