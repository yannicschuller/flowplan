// A Git server for tests: git http-backend behind a small HTTP server with
// one user ("flowplan" / the token given as second argument). Prints its
// port. Runs as a process of its own, apart from the test.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
const [repos, token] = process.argv.slice(2);
const expected = `Basic ${Buffer.from(`flowplan:${token}`).toString("base64")}`;
const server = createServer((req, res) => {
  if (req.headers.authorization !== expected) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="git"' }).end();
    return;
  }
  const url = new URL(req.url, "http://localhost");
  const cgi = spawn("/usr/lib/git-core/git-http-backend", [], {
    env: {
      ...process.env,
      GIT_PROJECT_ROOT: repos,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: url.pathname,
      QUERY_STRING: url.search.slice(1),
      REQUEST_METHOD: req.method,
      CONTENT_TYPE: req.headers["content-type"] || "",
      ...(req.headers["content-length"] ? { CONTENT_LENGTH: req.headers["content-length"] } : {}),
      REMOTE_USER: "flowplan",
    },
  });
  req.pipe(cgi.stdin);
  let head = Buffer.alloc(0),
    started = false;
  cgi.stdout.on("data", (chunk) => {
    if (started) return void res.write(chunk);
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf("\r\n\r\n");
    if (end < 0) return;
    started = true;
    const headers = {};
    let status = 200;
    for (const line of head.subarray(0, end).toString().split("\r\n")) {
      const [key, ...value] = line.split(": ");
      if (key.toLowerCase() === "status") status = Number(value.join(": ").split(" ")[0]);
      else headers[key] = value.join(": ");
    }
    res.writeHead(status, headers);
    res.write(head.subarray(end + 4));
  });
  cgi.stdout.on("end", () => res.end());
});
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
