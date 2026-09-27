import { scheduleRow } from "./row-schedule";
import { validateCalculations } from "./database-summary";
import * as Y from "yjs";
import { z } from "zod";
import { one, run } from "./db";
import { requirePage, pageRole } from "./permissions";
import { HttpError } from "./auth";
import { htmlState, stateHtml } from "./document-server";
import {
  availableLinkedViews,
  linkedViewsSchema,
  parseLinkedAttributes,
} from "./linked-views";
import { pageData, database, command } from "./api";
import { moveRow, validateViewRowOrders } from "./row-order-server";
import { transformFilterGroup } from "./database-filters";
import { ensureRowDocument, requireRow } from "./row-documents";
import type { Identity, Filter, View } from "./types";
import { documentChanged } from "./document-live";
// The host is a page document or, with `rowId`, a record document.
function hostDocument(
  user: Identity,
  hostId: string,
  rowId: string | undefined,
  write: boolean,
) {
  if (rowId) {
    const { page, row } = requireRow(user, hostId, rowId, write);
    return { host: page, rowId: row.id, stored: ensureRowDocument(row) };
  }
  const host = requirePage(user, hostId, write);
  if (host.kind !== "document")
    throw new HttpError(400, "Einbettung benötigt ein Dokument.");
  if (write && host.locked)
    throw new HttpError(409, "Das Dokument ist gesperrt.");
  const stored = one<{
    state: Uint8Array | null;
    html: string;
    generation: string;
  }>("SELECT * FROM documents WHERE page_id=?", hostId);
  if (!stored) throw new HttpError(404, "Dokument fehlt.");
  return { host, rowId: undefined, stored };
}
function open(
  user: Identity,
  hostId: string,
  blockId: string,
  write = false,
  rowId?: string,
) {
  const { host, stored } = hostDocument(user, hostId, rowId, write);
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, stored.state || htmlState(stored.html));
    const matches: Y.XmlElement[] = [];
    const visit = (parent: Y.XmlFragment) => {
      for (const child of parent.toArray())
        if (child instanceof Y.XmlElement) {
          if (
            child.nodeName === "linkedDatabase" &&
            child.getAttribute("id") === blockId
          )
            matches.push(child);
          visit(child);
        }
    };
    visit(doc.getXmlFragment("default"));
    if (matches.length !== 1)
      throw new HttpError(
        409,
        "Die Einbettung fehlt oder wurde verändert. Bitte das Dokument neu laden.",
      );
    const node = matches[0],
      attrs = parseLinkedAttributes(node.getAttributes());
    const source = requirePage(user, attrs.source);
    if (source.kind !== "database" || source.workspace_id !== host.workspace_id)
      throw new HttpError(403, "Datenquelle nicht verfügbar.");
    return {
      host,
      rowId,
      source,
      doc,
      node,
      attrs,
      generation: stored.generation,
    };
  } catch (error) {
    doc.destroy();
    throw error;
  }
}
export function linkedDatabaseData(
  user: Identity,
  hostId: string,
  blockId: string,
  rowId?: string,
) {
  const context = open(user, hostId, blockId, false, rowId);
  try {
    const source = pageData(user, context.source.id);
    if (!("database" in source)) throw new HttpError(400, "Keine Datenbank.");
    return {
      ...source,
      sourceVersion: source.database.version,
      hostRole: pageRole(user, context.host),
      hostLocked: !!context.host.locked,
      database: {
        ...source.database,
        version: context.attrs.version,
        views: availableLinkedViews(
          context.attrs.views,
          source.database.fields,
          source.rows,
        ),
      },
    };
  } finally {
    context.doc.destroy();
  }
}
function writeViews(context: ReturnType<typeof open>, views: View[]) {
  context.doc.transact(() => {
    context.node.setAttribute("views", JSON.stringify(views));
    context.node.setAttribute("version", String(context.attrs.version + 1));
  });
  const state = Y.encodeStateAsUpdate(context.doc),
    html = stateHtml(context.doc);
  if (context.rowId) {
    run(
      "UPDATE row_documents SET state=?,html=?,updated_at=CURRENT_TIMESTAMP WHERE row_id=?",
      state,
      html,
      context.rowId,
    );
    run(
      "UPDATE rows SET content=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",
      html,
      context.rowId,
    );
  } else
    run(
      "UPDATE documents SET state=?,html=?,updated_at=CURRENT_TIMESTAMP WHERE page_id=?",
      state,
      html,
      context.host.id,
    );
  run(
    "UPDATE pages SET updated_at=CURRENT_TIMESTAMP WHERE id=?",
    context.host.id,
  );
  documentChanged(context.host.id, context.rowId);
}
// Runs inside the command transaction. Any failed source mutation also rolls back the merged document update.
export function mutateLinkedDatabase(
  user: Identity,
  input: Record<string, unknown>,
) {
  const hostId = z.string().uuid().parse(input.pageId),
    blockId = z.string().uuid().parse(input.blockId),
    rowId = z
      .string()
      .uuid()
      .optional()
      .parse(input.rowId ?? undefined);
  const mutation = z
    .object({ action: z.string() })
    .passthrough()
    .parse(input.mutation);
  const host = requirePage(user, hostId);
  const hostWritable = pageRole(user, host) !== "viewer" && !host.locked;
  if (hostWritable && input.update)
    command(
      user,
      {
        action: rowId ? "row.document.sync" : "document.sync",
        pageId: hostId,
        rowId,
        generation: input.generation,
        update: input.update,
      },
      true,
    );
  const context = open(
    user,
    hostId,
    blockId,
    ["database.update", "row.move"].includes(mutation.action),
    rowId,
  );
  try {
    if (input.generation !== context.generation)
      throw new HttpError(
        409,
        "Die Dokumentversion wurde geändert. Bitte neu laden.",
      );
    let result: unknown = { ok: true };
    const d = database(context.source.id);
    if (
      ["database.update", "row.move", "row.schedule"].includes(mutation.action)
    ) {
      if (input.sourceVersion !== d.version)
        throw new HttpError(
          409,
          "Die Datenquelle wurde geändert. Bitte die Ansicht aktualisieren.",
        );
      if (mutation.version !== context.attrs.version)
        throw new HttpError(
          409,
          "Diese Einbettung wurde geändert. Bitte die Ansicht aktualisieren.",
        );
    }
    if (mutation.action === "database.update") {
      if (JSON.stringify(mutation.fields) !== JSON.stringify(d.fields))
        throw new HttpError(
          400,
          "Eigenschaften bitte in der Quelldatenbank ändern.",
        );
      const views = linkedViewsSchema.parse(mutation.views);
      const fields = new Set(d.fields.map((f) => f.id));
      const check = (condition: Filter) => {
        if (!fields.has(condition.field))
          throw new HttpError(
            400,
            "Filter verweist auf eine unbekannte Eigenschaft.",
          );
        return condition;
      };
      for (const view of views) {
        try {
          if (view.calculations)
            view.calculations = validateCalculations(
              view.calculations,
              d.fields,
            );
        } catch (error) {
          throw new HttpError(400, (error as Error).message);
        }
        view.filters.forEach(check);
        if (view.filterGroup) transformFilterGroup(view.filterGroup, check);
        if (
          view.gallery?.cover === "field" &&
          !d.fields.some(
            (f) => f.id === view.gallery!.fieldId && f.type === "files",
          )
        )
          throw new HttpError(
            400,
            "Galerie verweist auf eine unbekannte Bildeigenschaft.",
          );
      }
      validateViewRowOrders(context.source.id, views);
      writeViews(context, views);
    } else if (mutation.action === "row.schedule") {
      result = scheduleRow(user, context.source.id, mutation, {
        fields: d.fields,
        views: context.attrs.views,
        version: context.attrs.version,
      });
    } else if (mutation.action === "row.move") {
      result = moveRow(user, context.source.id, mutation, {
        fields: d.fields,
        views: context.attrs.views,
        version: context.attrs.version,
        save: (views) => writeViews(context, views),
      });
    } else {
      const actions = [
        "rows.bulk",
        "row.create",
        "row.update",
        "row.delete",
        "rows.import",
        "row.template.save",
        "row.template.default",
        "row.template.delete",
        "row.snapshot",
        "row.snapshot.restore",
        "comment.create",
        "comment.resolve",
        "form.update",
        "form.submit",
      ];
      if (!actions.includes(mutation.action))
        throw new HttpError(
          400,
          "Diese Aktion ist in einer Einbettung nicht verfügbar.",
        );
      result = command(user, { ...mutation, pageId: context.source.id }, true);
    }
    const stored = rowId
      ? one<{ state: Uint8Array }>(
          "SELECT state FROM row_documents WHERE row_id=?",
          rowId,
        )
      : one<{ state: Uint8Array }>(
          "SELECT state FROM documents WHERE page_id=?",
          hostId,
        );
    return {
      result,
      state: Buffer.from(
        stored?.state || Y.encodeStateAsUpdate(context.doc),
      ).toString("base64"),
      data: linkedDatabaseData(user, hostId, blockId, rowId),
    };
  } finally {
    context.doc.destroy();
  }
}
