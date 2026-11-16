// The peer stamp of the sign-in through a reverse proxy
// (lib/proxy-auth-config.ts installPeerStamp) on a real Node.js HTTP server,
// created the way Next.js's start-server creates it (http.createServer with
// a request listener): every request carries the connection's address under
// the random header name, whatever the client sent.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { connect } from "node:net";
const config = await import("../lib/proxy-auth-config");

test("a real HTTP server stamps the connection's address and drops a forged value", async () => {
  // Installed after the server class exists, like instrumentation.ts after
  // Next.js has created its server: the prototype patch reaches it.
  const seen: (string | undefined)[] = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers[config.peerHeaderName()!] as string | undefined);
    res.end("ok");
  });
  const name = config.installPeerStamp(http.Server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  try {
    // A client that knows the name (it cannot: random per process) still
    // gets the real address.
    const res = await fetch(`http://127.0.0.1:${port}/`, { headers: { [name]: "10.0.0.1", "x-forwarded-for": "127.0.0.1" } });
    assert.equal(await res.text(), "ok");
    // The same header twice in a raw request: still only the real address.
    await new Promise<void>((resolve, reject) => {
      const socket = connect(port, "127.0.0.1", () => socket.write(`GET / HTTP/1.1\r\nHost: x\r\n${name}: 10.0.0.2\r\n${name}: 10.0.0.3\r\nConnection: close\r\n\r\n`));
      socket.on("data", () => undefined).on("end", resolve).on("error", reject);
    });
    assert.deepEqual(seen.map((v) => config.plainAddress(v || "")), ["127.0.0.1", "127.0.0.1"]);
    assert.equal(config.requestPeer(new Headers({ [name]: "::ffff:127.0.0.1" })), "127.0.0.1");
    assert.equal(config.requestPeer(new Headers()), null);
  } finally {
    server.close();
  }
});
