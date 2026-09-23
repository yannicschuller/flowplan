import { one, run, id } from "./db";
import { HttpError } from "./auth";
import { requireMember } from "./permissions";
import {
  formConfigSchema,
  orderedFormFields,
  validateFormValues,
} from "./form-settings";
import type { Identity, Field } from "./types";
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
  return {
    ...f,
    config,
    title: config.title || f.title,
    fields: orderedFormFields(fields, config),
  };
}
export function saveFormSubmission(
  pageId: string,
  user: Identity | null,
  values: Record<string, unknown>,
) {
  const form = formSettings(pageId),
    config = form?.config || formConfigSchema.parse({});
  const fields: Field[] = JSON.parse(
    one<{ fields: string }>(
      "SELECT fields FROM databases WHERE page_id=?",
      pageId,
    )!.fields,
  );
  const result = validateFormValues(fields, config, values);
  if (Object.keys(result.errors).length)
    throw new HttpError(400, Object.values(result.errors).join(" "));
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
  return { id: rid };
}
