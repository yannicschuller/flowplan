// A small round-robin load balancer for the cluster load test
// (scripts/load-test-cluster.mjs): one public origin in front of several
// instances, as Caddy or an ingress would be. Each request goes to the next
// instance; bodies and server-sent event streams are piped through
// unbuffered. Its own process, so it does not compete with the load
// generator's event loop.
//
//   node scripts/loadtest/balancer.mjs --port 3600 --to 127.0.0.1:3601,127.0.0.1:3602
import http from "node:http";
import { parseArgs } from "node:util";

const { values: opt } = parseArgs({ options: { port: { type: "string", default: "3600" }, to: { type: "string" } } });
const targets = (opt.to || "").split(",").filter(Boolean).map((t) => {
  const [host, port] = t.split(":");
  return { host, port: Number(port) };
});
if (!targets.length) throw new Error("--to host:port,… is required");
const agent = new http.Agent({ keepAlive: true, maxSockets: 1024 });
let next = 0;
const server = http.createServer((req, res) => {
  const target = targets[next++ % targets.length];
  const upstream = http.request(
    { host: target.host, port: target.port, method: req.method, path: req.url, headers: { ...req.headers, "x-forwarded-for": req.socket.remoteAddress || "" }, agent },
    (answer) => {
      res.writeHead(answer.statusCode || 502, answer.headers);
      answer.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502).end();
    else res.destroy();
  });
  res.on("close", () => upstream.destroy());
  req.pipe(upstream);
});
server.keepAliveTimeout = 65_000;
server.listen(Number(opt.port), "127.0.0.1", () => console.log(`balancer on :${opt.port} → ${opt.to}`));
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
