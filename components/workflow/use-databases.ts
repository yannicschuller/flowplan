"use client";
// Properties, record templates and records of the databases a workflow
// names, loaded once per database while the editor is open (GET
// /api/pages/{id}); the pickers of the side panel and the names of the
// placeholders come from them.
import { useEffect, useMemo, useState } from "react";
import { api } from "../ui";
import type { Field } from "@/lib/types";
import type { WorkflowGraph } from "@/lib/workflows/graph";

export type DatabaseInfo = { fields: Field[]; templates: { id: string; name: string }[]; rows: { id: string; title: string }[] };
const cache = new Map<string, Promise<DatabaseInfo | null>>();

function load(pageId: string) {
  let p = cache.get(pageId);
  if (!p) {
    p = api<{ database?: { fields: Field[] }; rows?: { id: string; cells: Record<string, unknown> }[]; rowTemplates?: { id: string; name: string }[] }>(`/api/pages/${pageId}`)
      .then((d) => {
        if (!d.database) return null;
        const title = d.database.fields[0]?.id || "title";
        return {
          fields: d.database.fields,
          templates: (d.rowTemplates || []).map((x) => ({ id: x.id, name: x.name })),
          rows: (d.rows || []).slice(0, 500).map((r) => ({ id: r.id, title: String(r.cells[title] ?? "") })),
        };
      })
      .catch(() => {
        cache.delete(pageId);
        return null;
      });
    cache.set(pageId, p);
  }
  return p;
}

export function databasesOf(graph: WorkflowGraph) {
  const ids = new Set<string>();
  for (const n of graph.nodes) if (typeof n.config.database === "string" && n.config.database) ids.add(n.config.database);
  return [...ids].sort();
}

export function useDatabases(ids: string[]) {
  const [info, setInfo] = useState<Map<string, DatabaseInfo>>(new Map());
  const key = ids.join(",");
  useEffect(() => {
    let live = true;
    void Promise.all(ids.map(async (id) => [id, await load(id)] as const)).then((pairs) => {
      if (!live) return;
      setInfo((before) => {
        const next = new Map(before);
        for (const [id, d] of pairs) if (d) next.set(id, d);
        return next;
      });
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const fields = useMemo(() => new Map([...info].map(([id, d]) => [id, d.fields])), [info]);
  return { info, fields };
}
