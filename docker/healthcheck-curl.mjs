#!/usr/bin/env node
// A small stand-in for `curl` in the image, for health checks only.
//
// The real curl/libcurl are not in the image: Debian's packages carried
// critical findings without a fix, and Flowplan itself never needs them.
// Health checks that run inside the container still call `curl` – Coolify's
// HTTP check runs `curl -s -X GET -f http://localhost:3000/api/health` – so
// this script answers such calls with Node's fetch: one GET/HEAD/POST to the
// given http(s) address, the body to stdout (or -o FILE), and curl's exit
// codes for what a health check looks at (0 OK, 22 HTTP error with -f,
// 7 no connection, 28 timeout). Anything else exits with 2 and says so.
const args = process.argv.slice(2);
let method = "GET",
  url = null,
  fail = false,
  silent = false,
  head = false,
  output = null,
  maxTime = 30;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "-X" || a === "--request") method = String(args[++i] || "GET").toUpperCase();
  else if (a === "-o" || a === "--output") output = args[++i];
  else if (a === "-m" || a === "--max-time" || a === "--connect-timeout") maxTime = Number(args[++i]) || maxTime;
  else if (a === "-I" || a === "--head") head = true;
  else if (a === "-H" || a === "--header" || a === "-A" || a === "--user-agent" || a === "-w" || a === "--write-out") i++;
  else if (a.startsWith("--")) {
    if (a === "--fail" || a === "--fail-with-body") fail = true;
    else if (a === "--silent") silent = true;
    // --location, --insecure, --show-error, --compressed …: nothing to do.
  } else if (a.startsWith("-") && a.length > 1) {
    // Combined short flags such as -fsSL or -sf.
    for (const flag of a.slice(1)) {
      if (flag === "f") fail = true;
      else if (flag === "s") silent = true;
      else if (flag === "I") head = true;
      // S, L, k, v, q: nothing to do.
    }
  } else url = a;
}
if (!url || !/^https?:\/\//i.test(url)) {
  if (!silent) process.stderr.write("curl (Flowplan health check stand-in): only http(s) addresses are supported\n");
  process.exit(2);
}
if (head) method = "HEAD";
try {
  const response = await fetch(url, { method, redirect: "follow", signal: AbortSignal.timeout(maxTime * 1000) });
  if (fail && response.status >= 400) {
    if (!silent) process.stderr.write(`curl: (22) The requested URL returned error: ${response.status}\n`);
    process.exit(22);
  }
  const body = method === "HEAD" ? "" : await response.text();
  if (output && output !== "/dev/null") (await import("node:fs")).writeFileSync(output, body);
  else if (!output) process.stdout.write(body);
  process.exit(0);
} catch (error) {
  const timeout = error?.name === "TimeoutError";
  if (!silent) process.stderr.write(`curl: (${timeout ? 28 : 7}) ${error?.cause?.message || error?.message || error}\n`);
  process.exit(timeout ? 28 : 7);
}
