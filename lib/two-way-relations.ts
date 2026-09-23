import { z } from "zod";
import { id, one, run } from "./db";
import { requirePage } from "./permissions";
import { HttpError } from "./auth";
import {
  initializeRelationPair,
  insertRelationPair,
  relationFields,
  relationPairs,
} from "./relation-sync";
import type { Identity } from "./types";
export function configureRelation(
  user: Identity,
  pageId: string,
  previousVersion: number,
  input: unknown,
) {
  if (input === undefined) return;
  const config = z
    .object({
      fieldId: z.string().min(1).max(500),
      enabled: z.boolean(),
      name: z.string().trim().min(1).max(100).optional(),
      targetVersion: z.number().int().positive().optional(),
    })
    .parse(input);
  const source = requirePage(user, pageId, true),
    field = relationFields(pageId).find((f) => f.id === config.fieldId);
  if (!field || field.type !== "relation" || !field.relationPage)
    throw new HttpError(400, "Relation fehlt.");
  const target = requirePage(user, field.relationPage, true);
  if (source.locked || target.locked)
    throw new HttpError(409, "Eine verknüpfte Datenbank ist gesperrt.");
  if (source.workspace_id !== target.workspace_id || target.kind !== "database")
    throw new HttpError(400, "Ungültige Zieldatenbank.");
  const current = relationPairs(pageId).find(
    (p) =>
      (p.left_page === pageId && p.left_field === field.id) ||
      (p.right_page === pageId && p.right_field === field.id),
  );
  if (!config.enabled) {
    if (current) run("DELETE FROM two_way_relations WHERE id=?", current.id);
    return;
  }
  if (current) return;
  const targetVersion = Number(
    one("SELECT version FROM databases WHERE page_id=?", target.id)?.version,
  );
  if (
    config.targetVersion !==
    (target.id === pageId ? previousVersion : targetVersion)
  )
    throw new HttpError(
      409,
      "Die Zieldatenbank wurde geändert. Bitte den Eigenschaftsdialog erneut öffnen.",
    );
  const targetFields = relationFields(target.id);
  if (targetFields.length >= 80)
    throw new HttpError(400, "Die Zieldatenbank hat bereits 80 Eigenschaften.");
  const inverseId = id();
  targetFields.push({
    id: inverseId,
    name: config.name || source.title.slice(0, 100),
    type: "relation",
    relationPage: pageId,
  });
  run(
    "UPDATE databases SET fields=?,version=version+1 WHERE page_id=?",
    JSON.stringify(targetFields),
    target.id,
  );
  const pair = {
    id: id(),
    left_page: pageId,
    left_field: field.id,
    right_page: target.id,
    right_field: inverseId,
  };
  insertRelationPair(pair);
  initializeRelationPair(pair);
}
