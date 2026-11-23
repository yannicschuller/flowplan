// Loaded before server.js (node --import, docker/entrypoint.sh): Node.js
// ends a request that has not arrived completely within 5 minutes
// (http.Server requestTimeout, 300 s by default) with 408 – an upload of
// several gigabytes takes longer than that, and Next.js has no setting for
// it. Every HTTP server of the process gets FLOWPLAN_REQUEST_TIMEOUT
// instead: seconds for receiving a whole request, 21600 (6 hours) by
// default, 0 for no limit. Slow headers stay limited by headersTimeout
// (60 s), idle connections by keepAliveTimeout; the reverse proxy in front
// has timeouts of its own (docs: reverse proxy).
import http from "node:http";

const raw = (process.env.FLOWPLAN_REQUEST_TIMEOUT || "").trim();
const seconds = /^\d{1,7}$/.test(raw) ? Number(raw) : 21600;
const listen = http.Server.prototype.listen;
http.Server.prototype.listen = function (...args) {
  this.requestTimeout = seconds * 1000;
  // Node.js expects headersTimeout <= requestTimeout (0: none).
  if (seconds) this.headersTimeout = Math.min(this.headersTimeout, seconds * 1000);
  return listen.apply(this, args);
};
