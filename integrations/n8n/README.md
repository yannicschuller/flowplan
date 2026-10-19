# n8n-nodes-flowplan

[n8n](https://n8n.io) community nodes for [Flowplan](https://flowplan.org):

- **Flowplan** – workspaces, pages, database records and search through
  Flowplan's REST API.
- **Flowplan Trigger** – starts a workflow on Flowplan webhooks (new or
  changed records, form answers, new pages). It registers its webhook in
  Flowplan when the workflow is activated and removes it again afterwards.

## Install

In n8n (self-hosted): **Settings → Community Nodes → Install**, enter
`n8n-nodes-flowplan`, confirm, done. The nodes then appear as *Flowplan* and
*Flowplan Trigger*.

Manually (e.g. in a Docker image): `npm install n8n-nodes-flowplan` in
`~/.n8n/nodes`, then restart n8n.

## Credentials

Create a personal API token in Flowplan under **Settings → API & webhooks**
and add a credential *Flowplan API* in n8n:

| Field | Value |
| --- | --- |
| Instance URL | Your Flowplan address, e.g. `https://flowplan.example.org` |
| API Token | The token (`fp_…`) – shown only once when it is created |

The token acts as the person who created it, with their permissions.
A **read** token is enough for listing and search; creating pages and records
needs a **write** token. The trigger needs a write token of a **workspace
owner**, because only owners manage webhooks. The credential test calls
`GET /api/tokens`.

## Flowplan node

| Resource | Operation | Flowplan API |
| --- | --- | --- |
| Workspace | Get Many | `GET /api/bootstrap` |
| Page | Get Many (filter by kind, space, parent) | `GET /api/bootstrap?workspace=…` |
| Page | Get (with HTML, or properties of a database) | `GET /api/pages/{id}` |
| Page | Create (document, database, whiteboard; optional Markdown/HTML content and parent page) | `POST /api/command` `page.create`, or `page.import` (+ `page.move`) with content |
| Database Record | Get Many / Get (optionally with the record's page HTML) | `GET /api/pages/{databaseId}` (`/rows/{id}`) |
| Database Record | Create | `POST /api/command` `row.create` |
| Database Record | Update | `POST /api/command` `row.update` (with the record's current version) |
| Search | Search (all, documents, databases, whiteboards, records, comments, files) | `GET /api/search?workspace=…&q=…` |

Record properties are given by **name** (or ID), either one by one
("Define Below": values are converted to the property's type – numbers,
`true`/`false`, comma-separated lists for multi-select and relations) or as
JSON:

```json
{ "Name": "Call back", "Status": "Open", "Due": "2026-11-01", "Tags": ["Sales"] }
```

Select options are given by their text; dates as `YYYY-MM-DD` (or with time);
people by their user ID; relations as a list of record IDs. Computed
properties (formulas, rollups, ID, created/updated) cannot be set. The output
lists the values by property name (option *Output Property Names*).

## Trigger

Choose a workspace you own, the events (*Record Created*, *Record Updated*,
*Form Submitted*, *Page Created*) and optionally one database. On activation
the node calls `POST /api/webhooks` with n8n's webhook URL; on deactivation
it removes the webhook (`webhook.delete`). Each delivery looks like this:

```json
{
  "event": "row.created",
  "id": "…",
  "createdAt": "2026-10-19T12:00:00.000Z",
  "workspaceId": "…",
  "data": { "pageId": "…", "rowId": "…", "cells": { "title": "…" } }
}
```

`row.updated` also carries `data.changed` (the property IDs that changed).
Deliveries are signed: `X-Flowplan-Signature: sha256=<HMAC-SHA256 of the raw
body with the webhook's secret>`. The node keeps the secret it got when
registering the webhook and rejects deliveries with a wrong signature
(option *Verify Signature*).

Flowplan delivers only to **HTTPS addresses on the internet**. If n8n runs in
your own network (e.g. `http://n8n:5678`), set
`FLOWPLAN_WEBHOOK_ALLOW_PRIVATE=true` on the Flowplan instance. Failed
deliveries are retried up to six times with growing pauses.

### Without the trigger node

A webhook can also be added by hand in Flowplan (**Settings → API &
webhooks**) with the URL of an n8n *Webhook* node (POST). Flowplan shows the
secret once; check the signature in a *Code* node, for example:

```js
const crypto = require('crypto');
const secret = 'the secret from Flowplan';
const body = JSON.stringify($json.body);
const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
if ($json.headers['x-flowplan-signature'] !== expected) throw new Error('Invalid signature');
return [{ json: $json.body }];
```

(`require('crypto')` needs `NODE_FUNCTION_ALLOW_BUILTIN=crypto` in n8n.)

## Build and publish

```sh
cd integrations/n8n
npm install
npm run build      # TypeScript → dist/, icons copied
npm run lint       # n8n's rules for community nodes
npm test           # tests against dist/
npm run dev        # starts n8n with the nodes linked, for trying them out
npm publish        # runs lint, build and tests first (prepublishOnly)
```

The package is independent of the Flowplan app: it has its own
`package.json`, is not part of the app's build and only uses Flowplan's
public REST API (any instance with API tokens; the trigger needs a version
where write tokens may register webhooks).

## License

MIT
