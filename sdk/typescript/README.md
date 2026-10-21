# Flowplan TypeScript client

A thin, dependency-free client for the Flowplan HTTP API: one file, ESM, built on `fetch`, typed from the instance's OpenAPI document. Works in Node 18+, Deno, Bun and browsers.

`flowplan.ts` is generated from `lib/openapi.ts` in the Flowplan repository (`npm run sdk`); do not edit it by hand.

## Install

Copy `flowplan.ts` into your project (or import it from a checkout of the repository). There is nothing else to install.

## Use

```ts
import { FlowplanClient, FlowplanError } from "./flowplan.js";

const client = new FlowplanClient({
  baseUrl: "https://flowplan.example.com",
  token: process.env.FLOWPLAN_TOKEN, // a personal API token, Settings → API & Webhooks
});

const { workspace, pages } = await client.bootstrap();
const results = await client.search({ workspace: workspace.id, q: "roadmap" });
const page = await client.getPage(results[0].id);
```

Changes go through `command`, the same actions the interface sends. The result type follows the action:

```ts
const { id } = await client.command({ action: "row.create", pageId: database.id, cells: { title: "From the SDK" } });
await client.command({ action: "row.update", pageId: database.id, rowId: id, version: 0, cells: { done: true } });
```

Every method is one endpoint; the generated names follow the `operationId` of the document (`getPage`, `uploadFile`, `markdownExport`, …). Path parameters come first, then `query`, then the body, then `options` (`signal`, extra `headers`). Multipart uploads take a plain object with `Blob`s:

```ts
await client.uploadFile({ pageId, file: new Blob([bytes], { type: "image/png" }) });
```

Binary answers (`getFile`, `markdownExport`, `exportBackup`) return the `Response`, so you decide between `.blob()`, `.arrayBuffer()` and streaming.

Errors outside 2xx throw `FlowplanError` with `status`, the server's `message` (in the reader's language), validation `details` (400) and `retryAfter` seconds (429).

Anything not covered by a generated method goes through `client.request(method, path, { query, json, form, raw })`.

See `example.ts` for a complete script, `/api/docs` on your instance for the reference and [docs.flowplan.org/api-and-webhooks](https://docs.flowplan.org/api-and-webhooks) for the guide.
