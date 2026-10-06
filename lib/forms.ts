import { visibleRows } from "./row-access";
import { all, one, run, id } from "./db";
import { HttpError } from "./auth";
import { pageRole, requireMember, requirePage } from "./permissions";
import { cellText } from "./cell-text";
import {
  formConfigSchema,
  orderedFormFields,
  validateFormValues,
} from "./form-settings";
import type { Identity, Field, Page } from "./types";
import { emitWebhook } from "./webhooks";
import { rowCreated } from "./automations";
import { ct } from "./content-locale";
export function formSettings(pageId: string) {
  const raw = one<{
    token: string;
    enabled: number;
    internal: number;
    anonymous: number;
    config: string;
  }>("SELECT * FROM forms WHERE page_id=?", pageId);
  return raw
    ? { ...raw, config: formConfigSchema.parse(JSON.parse(raw.config)) }
    : null;
}
export function getForm(token: string, user: Identity | null) {
  const f = one<{
    page_id: string;
    title: string;
    workspace_id: string;
    internal: number;
    anonymous: number;
    config: string;
  }>(
    "SELECT f.*,p.title,p.workspace_id FROM forms f JOIN pages p ON p.id=f.page_id WHERE f.token=? AND f.enabled=1 AND p.deleted_at IS NULL",
    token,
  );
  if (!f) throw new HttpError(404, "Formular nicht gefunden.");
  if (f.internal) {
    if (!user)
      throw new HttpError(
        401,
        "Bitte melde dich an, um dieses Formular auszufüllen.",
      );
    requireMember(user, f.workspace_id);
  }
  if (!f.anonymous && !user)
    throw new HttpError(401, "Dieses Formular erfordert eine Anmeldung.");
  const fields: Field[] = JSON.parse(
      one<{ fields: string }>(
        "SELECT fields FROM databases WHERE page_id=?",
        f.page_id,
      )!.fields,
    ),
    config = formConfigSchema.parse(JSON.parse(f.config));
  const internal = !!f.internal && !!user;
  const questions = orderedFormFields(fields, config, internal);
  return {
    ...f,
    config,
    title: config.title || f.title,
    fields: questions,
    // Choices for people and relations, only for signed-in members.
    members: internal
      ? all<{ id: string; name: string }>(
          "SELECT u.id,u.name FROM users u JOIN members m ON m.user_id=u.id WHERE m.workspace_id=? AND u.disabled=0 ORDER BY u.name",
          f.workspace_id,
        )
      : [],
    related: internal ? relationChoices(user!, questions) : {},
  };
}
function relationChoices(user: Identity, fields: Field[]) {
  const related: Record<string, { id: string; cells: { title: string } }[]> =
    {};
  for (const f of fields) {
    if (f.type !== "relation" || !f.relationPage || related[f.relationPage])
      continue;
    const target = one<Page>(
      "SELECT * FROM pages WHERE id=? AND deleted_at IS NULL",
      f.relationPage,
    );
    if (!target || !pageRole(user, target)) continue;
    const title =
      (
        JSON.parse(
          one<{ fields: string }>(
            "SELECT fields FROM databases WHERE page_id=?",
            target.id,
          )?.fields || "[]",
        ) as Field[]
      )[0]?.id || "title";
    related[target.id] = visibleRows(
      user,
      target,
      all<{ id: string; cells: string; access: string; created_by: string }>(
        "SELECT id,cells,access,created_by FROM rows WHERE page_id=? ORDER BY position LIMIT 1000",
        target.id,
      ),
    ).map((r) => ({
      id: r.id,
      cells: { title: cellText(JSON.parse(r.cells)[title]) },
    }));
  }
  return related;
}
export function saveFormSubmission(
  pageId: string,
  user: Identity | null,
  values: Record<string, unknown>,
  memberSubmission = false,
) {
  const form = formSettings(pageId),
    config = form?.config || formConfigSchema.parse({});
  const internal = memberSubmission || (!!form?.internal && !!user);
  const fields: Field[] = JSON.parse(
    one<{ fields: string }>(
      "SELECT fields FROM databases WHERE page_id=?",
      pageId,
    )!.fields,
  );
  const result = validateFormValues(fields, config, values, internal);
  if (Object.keys(result.errors).length)
    throw new HttpError(400, Object.values(result.errors).join(" "));
  const page = one<Page>("SELECT * FROM pages WHERE id=?", pageId)!;
  for (const f of fields) {
    const value = result.cells[f.id];
    if (value === undefined || value === null || value === "") continue;
    if (
      f.type === "person" &&
      !one(
        "SELECT 1 FROM members WHERE workspace_id=? AND user_id=?",
        page.workspace_id,
        String(value),
      )
    )
      throw new HttpError(400, `${f.name}: Mitglied nicht gefunden.`);
    if (f.type === "relation" && Array.isArray(value) && value.length) {
      if (!f.relationPage || !user)
        throw new HttpError(400, `${f.name}: Verknüpfung nicht möglich.`);
      requirePage(user, f.relationPage);
      for (const rid of value)
        if (
          !one(
            "SELECT 1 FROM rows WHERE id=? AND page_id=?",
            rid,
            f.relationPage,
          )
        )
          throw new HttpError(400, `${f.name}: Eintrag nicht gefunden.`);
    }
    // Attached files must belong to this database.
    if (f.type === "files" && Array.isArray(value))
      for (const url of value)
        if (
          !one(
            "SELECT 1 FROM files WHERE id=? AND page_id=?",
            String(url).split("/").pop() || "",
            pageId,
          )
        )
          throw new HttpError(400, `${f.name}: Datei nicht gefunden.`);
  }
  const rid = id();
  run(
    "INSERT INTO rows(id,page_id,cells,position,created_by,updated_by) VALUES(?,?,?,?,?,?)",
    rid,
    pageId,
    JSON.stringify(result.cells),
    Date.now(),
    form?.anonymous ? null : user?.id || null,
    form?.anonymous ? null : user?.id || null,
  );
  run("UPDATE pages SET updated_at=CURRENT_TIMESTAMP WHERE id=?", pageId);
  // Survey answers without a title get a running one ("Antwort 12").
  const titleField = fields[0];
  if (config.survey?.enabled && titleField?.type === "text" && !result.cells[titleField.id]) {
    const number = one<{ number: number }>("SELECT number FROM rows WHERE id=?", rid)?.number;
    if (number) run("UPDATE rows SET cells=? WHERE id=?", JSON.stringify({ ...result.cells, [titleField.id]: `${ct("Antwort", "Response")} ${number}` }), rid);
  }
  // Automations: "a new record arrives through a form".
  rowCreated(user, page, rid, true);
  const workspace = one<{ workspace_id: string }>("SELECT workspace_id FROM pages WHERE id=?", pageId);
  if (workspace) {
    const payload = { pageId, rowId: rid, cells: result.cells, anonymous: !!form?.anonymous };
    emitWebhook(workspace.workspace_id, "form.submitted", payload);
    emitWebhook(workspace.workspace_id, "row.created", payload);
  }
  return { id: rid };
}
