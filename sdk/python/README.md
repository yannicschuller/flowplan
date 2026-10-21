# Flowplan Python client

A thin client for the Flowplan HTTP API in one file, using only the standard library (`urllib`), typed with `TypedDict`s from the instance's OpenAPI document. Python 3.11 or newer.

`flowplan_client.py` is generated from `lib/openapi.ts` in the Flowplan repository (`npm run sdk`); do not edit it by hand.

## Install

Copy `flowplan_client.py` next to your script. There is nothing to install.

## Use

```python
from flowplan_client import FlowplanClient, FlowplanError

client = FlowplanClient("https://flowplan.example.com", token="fp_…")  # Settings → API & Webhooks

shell = client.bootstrap()
workspace = shell["workspace"]
results = client.search({"workspace": workspace["id"], "q": "roadmap"})
page = client.get_page(results[0]["id"])
```

Changes go through `command`, the same actions the interface sends:

```python
created = client.command({"action": "row.create", "pageId": database_id, "cells": {"title": "From the SDK"}})
client.command({"action": "row.update", "pageId": database_id, "rowId": created["id"], "version": 0, "cells": {"done": True}})
```

Every method is one endpoint, named after the document's `operationId` in snake case (`get_page`, `upload_file`, `markdown_export`, …). Path parameters come first, then the body, then `query` (a dict), then optional `headers`. Multipart uploads take a dict whose files are `(filename, bytes, mime)` tuples:

```python
client.upload_file({"pageId": page_id, "file": ("photo.png", data, "image/png")})
```

Binary answers (`get_file`, `markdown_export`, `export_backup`) return `bytes`.

Answers outside 2xx raise `FlowplanError` with `status`, the server's `message` (in the reader's language), validation `details` (400) and `retry_after` seconds (429).

Anything not covered by a generated method goes through `client.request(method, path, query=…, json_body=…, form=…, raw=…)`, which returns `(status, headers, body)`.

See `example.py` for a complete script, `/api/docs` on your instance for the reference and [docs.flowplan.org/api-and-webhooks](https://docs.flowplan.org/api-and-webhooks) for the guide.
