// An S3 stand-in for tests: path-style objects in memory, ListObjectsV2
// (prefix, delimiter, Size, LastModified, max-keys and continuation
// tokens), HeadObject (Content-Length), CopyObject, DeleteObjects (POST
// ?delete), and failures on
// demand. Signed requests only (AWS4-HMAC-SHA256), like the real thing.
//
//   const s3 = await startFakeS3();
//   process.env.S3_ENDPOINT = s3.endpoint; process.env.S3_BUCKET = "bucket";
//   s3.objects.get("/bucket/flowplan/uploads/<id>")
import { createServer } from "node:http";

export type FakeS3 = {
  endpoint: string;
  objects: Map<string, { body: Buffer; at: number }>;
  requests: string[];
  // Requests whose path contains one of these answer 500.
  failing: Set<string>;
  // All requests answer 503 while set (the bucket is away).
  down: { value: boolean };
  // DeleteObjects answers 501 while set (a provider without it).
  noBatchDelete: { value: boolean };
  close: () => Promise<void>;
};

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

export async function startFakeS3(): Promise<FakeS3> {
  const objects = new Map<string, { body: Buffer; at: number }>();
  const requests: string[] = [];
  const failing = new Set<string>();
  const down = { value: false };
  const noBatchDelete = { value: false };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url || "", "http://x");
      const path = decodeURIComponent(url.pathname);
      requests.push(`${req.method} ${path}${url.search}`);
      if (!/^AWS4-HMAC-SHA256 /.test(String(req.headers.authorization))) return void res.writeHead(403).end();
      if (down.value) return void res.writeHead(503).end();
      if ([...failing].some((key) => path.includes(key))) return void res.writeHead(500).end();
      const bucket = path.split("/")[1];
      if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
        const prefix = url.searchParams.get("prefix") || "";
        const delimiter = url.searchParams.get("delimiter");
        const maxKeys = Math.min(1000, Number(url.searchParams.get("max-keys")) || 1000);
        const after = url.searchParams.get("continuation-token") ? Buffer.from(url.searchParams.get("continuation-token")!, "base64url").toString() : "";
        let truncated = false;
        let last = "";
        const contents: string[] = [];
        const common = new Set<string>();
        for (const [key, value] of [...objects.entries()].sort(([a], [b]) => a.localeCompare(b))) {
          if (!key.startsWith(`/${bucket}/`)) continue;
          const name = key.slice(bucket.length + 2);
          if (!name.startsWith(prefix)) continue;
          if (after && name <= after) continue;
          if (contents.length + common.size >= maxKeys) {
            truncated = true;
            break;
          }
          last = name;
          const rest = name.slice(prefix.length);
          if (delimiter && rest.includes(delimiter)) {
            common.add(prefix + rest.slice(0, rest.indexOf(delimiter) + 1));
            continue;
          }
          contents.push(`<Contents><Key>${xml(name)}</Key><LastModified>${new Date(value.at).toISOString()}</LastModified><Size>${value.body.length}</Size></Contents>`);
        }
        const prefixes = [...common].map((p) => `<CommonPrefixes><Prefix>${xml(p)}</Prefix></CommonPrefixes>`);
        const next = truncated ? `<NextContinuationToken>${Buffer.from(last).toString("base64url")}</NextContinuationToken>` : "";
        return void res.writeHead(200).end(`<ListBucketResult><IsTruncated>${truncated}</IsTruncated>${next}${contents.join("")}${prefixes.join("")}</ListBucketResult>`);
      }
      if (req.method === "POST" && url.searchParams.has("delete")) {
        if (noBatchDelete.value) return void res.writeHead(501).end();
        if (!req.headers["content-md5"]) return void res.writeHead(400).end("<Error><Code>MissingContentMD5</Code></Error>");
        const body = Buffer.concat(chunks).toString();
        const keys = [...body.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
        for (const key of keys) objects.delete(`/${bucket}/${key}`);
        return void res.writeHead(200).end(`<DeleteResult>${/<Quiet>true<\/Quiet>/.test(body) ? "" : keys.map((k) => `<Deleted><Key>${xml(k)}</Key></Deleted>`).join("")}</DeleteResult>`);
      }
      const source = req.headers["x-amz-copy-source"];
      if (req.method === "PUT" && typeof source === "string") {
        const body = objects.get(decodeURIComponent(source));
        if (!body) return void res.writeHead(404).end();
        objects.set(path, { body: body.body, at: Date.now() });
        return void res.writeHead(200).end("<CopyObjectResult/>");
      }
      if (req.method === "PUT") {
        objects.set(path, { body: Buffer.concat(chunks), at: Date.now() });
        return void res.writeHead(200).end();
      }
      if (req.method === "DELETE") {
        objects.delete(path);
        return void res.writeHead(204).end();
      }
      if (req.method === "HEAD") {
        const object = objects.get(path);
        if (!object) return void res.writeHead(404).end();
        return void res.writeHead(200, { "Content-Length": object.body.length }).end();
      }
      if (req.method === "GET") {
        const object = objects.get(path);
        if (!object) return void res.writeHead(404).end();
        return void res.writeHead(200).end(object.body);
      }
      res.writeHead(200).end();
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  server.unref();
  const port = (server.address() as { port: number }).port;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    objects,
    requests,
    failing,
    down,
    noBatchDelete,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}
