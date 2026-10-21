"""Creates a record in the first database of your workspace and finds it again.

    FLOWPLAN_URL=https://flowplan.example.com FLOWPLAN_TOKEN=fp_… python3 example.py
"""
import os

from flowplan_client import FlowplanClient, FlowplanError

client = FlowplanClient(os.environ.get("FLOWPLAN_URL", "http://localhost:3000"), token=os.environ.get("FLOWPLAN_TOKEN"))

try:
    shell = client.bootstrap()
    workspace, pages = shell["workspace"], shell["pages"]
    print(f'Workspace "{workspace["name"]}" with {len(pages)} pages')

    database = next((page for page in pages if page["kind"] == "database"), None)
    if not database:
        raise SystemExit("Create a database first")
    data = client.get_page(database["id"])
    fields = data.get("database", {}).get("fields", [])
    print(f'Database "{database["title"]}": {len(data.get("rows", []))} records, properties {", ".join(f["name"] for f in fields)}')

    # Property values are keyed by property ID; the first property is the title.
    title_field = fields[0]["id"] if fields else "title"
    created = client.command({"action": "row.create", "pageId": database["id"], "cells": {title_field: "Created by the SDK"}})
    print(f'Created record {created["id"]}')

    matches = client.search({"workspace": workspace["id"], "q": "Created by the SDK", "kind": "row"})
    print(f"Search found {len(matches)} match(es)")

    client.command({"action": "row.delete", "pageId": database["id"], "rowId": created["id"]})
except FlowplanError as error:
    print(f"Flowplan answered {error.status}: {error.message}")
