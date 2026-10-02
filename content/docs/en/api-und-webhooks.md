# API and webhooks

With personal API tokens, scripts, n8n or Home Assistant access Flowplan; webhooks report new records, form answers and pages to other services.

## API tokens

Under **Settings → API & webhooks** you create tokens: with a name, **Read only** or **Read and write**. The token is shown only once – afterwards only its beginning is visible.

Every request with the token acts with your permissions:

```bash
curl -H "Authorization: Bearer fp_…" https://flowplan.example.com/api/bootstrap
```

- **Read**: all `GET` endpoints, such as `/api/bootstrap` (workspace, pages) and `/api/pages/<id>` (a document, or a database with its records).
  In a database's answer the records are under `rows` (with `preview` instead of the full document); `related` contains linked databases, the database's own records are only under `rows`.
- **Write**: `POST /api/command` with the same action as the interface, e.g. to create a record:

```bash
curl -X POST https://flowplan.example.com/api/command \
  -H "Authorization: Bearer fp_…" -H "Content-Type: application/json" \
  -d '{"action":"row.create","pageId":"<database ID>","cells":{"title":"From Home Assistant"}}'
```

Tokens never get administrator rights and cannot create further tokens. You can revoke them at any time in the same list; locked accounts lose their tokens automatically.

## Webhooks

Owners of a workspace create webhooks: an address, events and optionally a single database.

| Event | When |
| --- | --- |
| `row.created` | A new record in a database, also from a form |
| `row.updated` | A record changed (`changed` names the properties) |
| `form.submitted` | A form answer |
| `page.created` | A new page |

Flowplan sends JSON with `POST`:

```json
{
  "event": "row.created",
  "id": "…",
  "createdAt": "2026-09-27T10:00:00.000Z",
  "workspaceId": "…",
  "data": { "pageId": "…", "rowId": "…", "cells": { "title": "New" } }
}
```

### Check the signature

The header `X-Flowplan-Signature: sha256=<hex>` is the HMAC-SHA256 signature of the body with the secret key that is shown once when the webhook is created:

```js
import { createHmac, timingSafeEqual } from "node:crypto";
const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
const valid = timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers["x-flowplan-signature"]));
```

### Delivery

- Answers with status 2xx count as delivered; otherwise Flowplan retries up to six times with growing intervals.
- The list shows the last delivery or the last error per webhook.
- Only public HTTPS addresses are allowed. For services in the same network (Home Assistant, n8n) the administrators set `FLOWPLAN_WEBHOOK_ALLOW_PRIVATE=true`.

## Calendar subscriptions

Calendar views can be subscribed to as an iCalendar link, see [Views](/docs/ansichten#subscribe-to-a-calendar).
