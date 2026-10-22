import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

process.env.APP_URL = "https://flowplan.example.test";
const { openApiDocument, commandActionNames, commandActions, commandSchemaName, tokenRefusedActionPrefixes, routesOutsideSpec } = await import("../lib/openapi");
const { generateSdks, outputs } = await import("../scripts/generate-sdk.mjs");

type Json = Record<string, unknown>;
const doc = openApiDocument();
const paths = doc.paths as Record<string, Record<string, Json>>;
const schemas = (doc.components as { schemas: Record<string, Json> }).schemas;
const operations = Object.entries(paths).flatMap(([path, item]) => Object.entries(item).map(([method, op]) => ({ path, method, op })));

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));

test("the document is OpenAPI 3.1 with the instance address and bearer tokens", () => {
  assert.equal(doc.openapi, "3.1.0");
  assert.deepEqual(doc.servers, [{ url: "https://flowplan.example.test", description: "This instance" }]);
  const security = (doc.components as { securitySchemes: Record<string, Json> }).securitySchemes;
  assert.equal(security.bearerAuth.scheme, "bearer");
  assert.ok(String((doc.info as Json).description).includes("429"));
  // The document survives JSON (no functions, no cycles) and stays below a megabyte.
  assert.ok(JSON.stringify(doc).length < 1_000_000);
});

test("every operation has a unique operationId, a known tag, responses and resolvable references", () => {
  const ids = new Set<string>();
  const tags = new Set((doc.tags as { name: string }[]).map((t) => t.name));
  for (const { path, method, op } of operations) {
    assert.match(method, /^(get|post)$/, path);
    const id = String(op.operationId);
    assert.ok(id && !ids.has(id), `${method} ${path}: operationId ${id}`);
    ids.add(id);
    assert.ok((op.tags as string[]).every((t) => tags.has(t)), `${id}: tag`);
    assert.ok(Object.keys(op.responses as Json).some((s) => s.startsWith("2")), `${id}: success response`);
    assert.ok(Array.isArray(op.security), `${id}: security`);
    // Every path parameter is declared.
    for (const [, name] of path.matchAll(/\{([^}]+)\}/g))
      assert.ok(((op.parameters as Json[]) || []).some((p) => p.name === name && p.in === "path"), `${id}: parameter ${name}`);
  }
  const refs: string[] = [];
  const collect = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(collect);
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref") refs.push(String(value));
      else collect(value);
    }
  };
  collect(doc);
  for (const ref of refs) {
    const match = ref.match(/^#\/components\/schemas\/([A-Za-z0-9_.-]+)$/);
    assert.ok(match && schemas[match[1]], `unresolved ${ref}`);
  }
  for (const [name, schema] of Object.entries(schemas)) assert.ok(!("$schema" in schema), `${name}: JSON Schema header left in`);
});

test("the command endpoint describes every action a token may send", () => {
  // The names come from the switch in lib/api.ts command().
  const source = readFileSync("lib/api.ts", "utf8");
  const body = source.slice(source.indexOf("export function command("));
  const inCode = new Set([...body.matchAll(/case "([a-zA-Z0-9.]+)":/g)].map((m) => m[1]).filter((name) => !tokenRefusedActionPrefixes.some((p) => name.startsWith(p))));
  assert.ok(inCode.size > 100);
  assert.deepEqual([...commandActionNames].sort(), [...inCode].sort());
  // Each documented action has a schema in the oneOf; the rest sit in CommandOther.
  const variants = (schemas.Command.oneOf as Json[]).map((v) => String(v.$ref).split("/").pop());
  for (const a of commandActions) {
    assert.ok(commandActionNames.includes(a.action as (typeof commandActionNames)[number]), a.action);
    assert.ok(variants.includes(commandSchemaName(a.action)), a.action);
    assert.equal((schemas[commandSchemaName(a.action)].properties as Record<string, Json>).action.const, a.action);
  }
  const other = ((schemas.CommandOther.properties as Record<string, Json>).action.enum as string[]);
  assert.ok(!other.some((name) => commandActions.some((a) => a.action === name)));
  assert.equal(other.length + commandActions.length, commandActionNames.length);
  const command = paths["/api/command"].post;
  assert.equal(command["x-write-token"], true);
  assert.ok("429" in (command.responses as Json));
});

test("every route file under app/api is described or named as outside the token API", () => {
  const files = walk("app/api").filter((f) => f.endsWith("route.ts"));
  assert.ok(files.includes("app/api/[...path]/route.ts"));
  const specPaths = Object.keys(paths);
  for (const file of files) {
    if (routesOutsideSpec[file]) continue;
    // The static beginning of the route: app/api/share/[token]/route.ts → /api/share/
    const url = "/" + file.replace(/\/route\.ts$/, "").replace(/^app\//, "");
    const prefix = url.split("/[")[0] + (url.includes("/[") ? "/" : "");
    assert.ok(
      specPaths.some((p) => p === prefix || p.startsWith(prefix)),
      `${file} is neither described in lib/openapi.ts nor listed in routesOutsideSpec`,
    );
  }
  for (const file of Object.keys(routesOutsideSpec)) assert.ok(files.includes(file), `${file} no longer exists`);
});

test("GET /api/openapi.json answers with the document, cached for an hour", async () => {
  const { GET } = await import("../app/api/openapi.json/route");
  const response = GET();
  assert.equal(response.headers.get("Cache-Control"), "public, max-age=3600");
  assert.match(response.headers.get("Content-Type") || "", /^application\/json/);
  const body = (await response.json()) as Json;
  assert.equal(body.openapi, "3.1.0");
  assert.ok((body.paths as Json)["/api/command"]);
});

const generated = generateSdks(doc);

test("the committed SDKs are what the generator produces from the document", () => {
  for (const [language, file] of Object.entries(outputs))
    assert.equal(readFileSync(file, "utf8"), generated[language as keyof typeof generated], `${file} differs: run npm run sdk`);
});

test("the TypeScript SDK compiles under strict settings and types the command results", () => {
  const typescript = generated.typescript;
  assert.ok(typescript.includes("export class FlowplanClient"));
  assert.ok(typescript.includes("async command<A extends Command>(body: A"));
  for (const { op } of operations) assert.ok(typescript.includes(`async ${op.operationId}`), String(op.operationId));
  // The client needs only the DOM's fetch; the example reads process.env.
  const args = ["--ignoreConfig", "--noEmit", "--strict", "--target", "es2022", "--module", "esnext", "--moduleResolution", "bundler", "--lib", "es2022,dom", "--types", "node", "--skipLibCheck"];
  const tsc = spawnSync(process.execPath, ["node_modules/typescript/bin/tsc", ...args, outputs.typescript, "sdk/typescript/example.ts"], { encoding: "utf8" });
  assert.equal(tsc.status, 0, tsc.stdout + tsc.stderr);
});

test("the Python SDK is valid Python without third-party imports", (t) => {
  const python = generated.python;
  assert.ok(python.includes("class FlowplanClient"));
  assert.ok(!/^import requests|^from requests/m.test(python));
  for (const { op } of operations)
    assert.ok(python.includes(`def ${String(op.operationId).replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}(`), String(op.operationId));
  const check = spawnSync("python3", ["-I", "-c", "import ast,sys\nfor f in sys.argv[1:]: ast.parse(open(f).read(), f)", outputs.python, "sdk/python/example.py"], { encoding: "utf8" });
  if (check.error) return t.skip("python3 is not installed");
  assert.equal(check.status, 0, check.stderr);
});
