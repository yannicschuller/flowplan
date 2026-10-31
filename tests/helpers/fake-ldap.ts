// A small in-process LDAP directory speaking the BER subset of lib/ldap.ts
// over TCP (bind, search with base / one level / subtree, unbind), for the
// contacts tests. Values may be Buffers (photos, objectGUID). `delayMs`
// holds back search answers (timeouts), `sizeLimit` is honoured like a real
// server (sizeLimitExceeded after that many entries).
import { createServer, type Socket } from "node:net";
import { ber, children, decodeFilter, readInt, readTlv, type LdapFilter } from "../../lib/ldap";

export type FakeEntry = { password?: string; attrs: Record<string, (string | Buffer)[]> };
export type FakeDirectory = {
  entries: Map<string, FakeEntry>;
  url: string;
  searches: { base: string; scope: number; filter: LdapFilter }[];
  delayMs: number;
  close: () => Promise<void>;
};

const lower = (s: string) => s.toLowerCase().replace(/\s*,\s*/g, ",");
function evaluate(f: LdapFilter, attrs: Record<string, (string | Buffer)[]>): boolean {
  const values = (name: string) => Object.entries(attrs).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1] || [];
  const text = (v: string | Buffer) => (typeof v === "string" ? v : v.toString("latin1"));
  switch (f.type) {
    case "and":
      return f.filters.every((x) => evaluate(x, attrs));
    case "or":
      return f.filters.some((x) => evaluate(x, attrs));
    case "not":
      return !evaluate(f.filter, attrs);
    case "present":
      return f.attr.toLowerCase() === "objectclass" || values(f.attr).length > 0;
    case "substrings":
      return values(f.attr).some((raw) => {
        const s = text(raw).toLowerCase();
        if (f.initial && !s.startsWith(f.initial.toString().toLowerCase())) return false;
        let at = f.initial ? f.initial.length : 0;
        for (const a of f.any) {
          const i = s.indexOf(a.toString().toLowerCase(), at);
          if (i < 0) return false;
          at = i + a.length;
        }
        return !f.final || s.slice(at).endsWith(f.final.toString().toLowerCase());
      });
    default:
      return values(f.attr).some((v) =>
        Buffer.isBuffer(v) ? v.equals(f.value) : v.toLowerCase() === f.value.toString().toLowerCase(),
      );
  }
}
const result = (tag: number, code: number) => ber.seq(tag, ber.enumerated(code), ber.str(""), ber.str(""));

export async function startFakeLdap(entries = new Map<string, FakeEntry>()): Promise<FakeDirectory> {
  const directory: FakeDirectory = { entries, url: "", searches: [], delayMs: 0, close: async () => {} };
  const sockets = new Set<Socket>();
  const serve = (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    let bound = false;
    const send = (messageId: number, op: Buffer) => {
      if (!socket.destroyed) socket.write(ber.seq(0x30, ber.int(messageId), op));
    };
    socket.on("error", () => {});
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (let message = readTlv(buffer); message; message = readTlv(buffer)) {
        buffer = buffer.subarray(message.size);
        const [idTlv, op] = children(message.value);
        const messageId = readInt(idTlv.value);
        if (op.tag === 0x60) {
          const [, name, auth] = children(op.value);
          const entry = [...entries.entries()].find(([k]) => lower(k) === lower(name.value.toString()))?.[1];
          bound = !!entry?.password && entry.password === auth.value.toString();
          send(messageId, result(0x61, bound ? 0 : 49));
        } else if (op.tag === 0x63) {
          const [baseTlv, scopeTlv, , sizeTlv, , , filterTlv, attrList] = children(op.value);
          const base = baseTlv.value.toString(),
            scope = readInt(scopeTlv.value),
            sizeLimit = readInt(sizeTlv.value);
          const filter = decodeFilter(filterTlv);
          directory.searches.push({ base, scope, filter });
          const answer = () => {
            if (!bound) return send(messageId, result(0x65, 50));
            const b = lower(base);
            if (![...entries.keys()].some((k) => lower(k) === b)) return send(messageId, result(0x65, 32));
            const wanted = children(attrList.value).map((a) => a.value.toString().toLowerCase());
            let sent = 0;
            for (const [dn, entry] of entries) {
              const d = lower(dn);
              const inScope =
                scope === 0 ? d === b : scope === 1 ? d.endsWith(`,${b}`) && !d.slice(0, -(b.length + 1)).includes(",") : d === b || d.endsWith(`,${b}`);
              if (!inScope || !evaluate(filter, entry.attrs)) continue;
              if (sizeLimit && sent >= sizeLimit) return send(messageId, result(0x65, 4));
              const attrs = Object.entries(entry.attrs).filter(([k]) => wanted.includes(k.toLowerCase()));
              send(
                messageId,
                ber.seq(0x64, ber.str(dn), ber.seq(0x30, ...attrs.map(([k, vs]) => ber.seq(0x30, ber.str(k), ber.seq(0x31, ...vs.map((v) => ber.str(v))))))),
              );
              sent++;
            }
            send(messageId, result(0x65, 0));
          };
          if (directory.delayMs) setTimeout(answer, directory.delayMs);
          else answer();
        } else if (op.tag === 0x42) socket.end();
        else send(messageId, result(0x78, 2));
      }
    });
  };
  const server = createServer(serve);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  directory.url = `ldap://127.0.0.1:${(server.address() as { port: number }).port}`;
  directory.close = () =>
    new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    });
  return directory;
}
