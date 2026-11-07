// One-time data steps of the migrations, on both databases (#127, phase 2).
// The schema itself changes in lib/db.ts migrate() (SQLite) and from the
// translated schema (PostgreSQL, lib/db-driver/pg-schema.ts); what has to
// be done to the *data* – values escaped, secrets sealed, rows moved – is
// written here once, against the asynchronous helpers of lib/db.ts, and
// runs when the database is first used (dbContext.hooks.open, before any
// other statement). Each step runs in a transaction of its own and is
// remembered in data_migrations; a step that fails stays unmarked and is
// tried again at the next start. New data steps go here, never into
// migrate(): they must run on both databases.
import { randomUUID } from "node:crypto";
import { all, lockFor, one, run, sql, tableColumns, transaction, updateIgnoringConflicts } from "./db";
import { emojiPresentation } from "./emoji-presentation";
import { escapeFormattedCells, FORMATTED_TEXT_MIGRATION } from "./formatted-text";
import { isFormattedText } from "./inline-markdown";
import { isSealed, sealGit, sealWebhookSecret, sealWebhookUrl, SEALED_SECRETS_MIGRATION, type StoredGit } from "./sealed-values";
import type { Field } from "./types";

type Cells = Record<string, unknown>;
export type DataStep = { name: string; run: () => Promise<void> };

export const SAVED_SEARCHES_STEP = "saved-searches-85";
export const IDENTITIES_STEP = "identities-88";
export const REACTION_EMOJI_STEP = "reaction-emoji-fe0f";

// In the order the schema versions introduced them. A function: the
// modules of the steps import lib/db.ts, which may still be loading.
export const dataSteps = (): DataStep[] => [
  { name: SAVED_SEARCHES_STEP, run: savedSearchesToCollections },
  { name: IDENTITIES_STEP, run: identitiesFromSubjects },
  { name: FORMATTED_TEXT_MIGRATION, run: escapeFormattedText },
  { name: SEALED_SECRETS_MIGRATION, run: sealSecrets },
  { name: REACTION_EMOJI_STEP, run: reactionEmojiPresentation },
];

// Runs the steps not done yet (`only`: just these). Several instances on
// one PostgreSQL database take turns (advisory lock) and skip what another
// has done meanwhile.
export async function runDataSteps(only?: string[]) {
  for (const step of dataSteps()) {
    if (only && !only.includes(step.name)) continue;
    if (await one("SELECT 1 FROM data_migrations WHERE name=?", step.name)) continue;
    try {
      await transaction(async () => {
        await lockFor(`data-step:${step.name}`);
        if (await one("SELECT 1 FROM data_migrations WHERE name=?", step.name)) return;
        await step.run();
        await run("INSERT INTO data_migrations(name,at) VALUES(?,?) ON CONFLICT DO NOTHING", step.name, Date.now());
      });
    } catch (error) {
      console.error(`Datenschritt ${step.name} fehlgeschlagen`, error);
    }
  }
}

// Schema 85 – saved searches (before #86) become collections, keeping their
// id and order; the rows leave saved_searches.
async function savedSearchesToCollections() {
  if (!(await tableColumns("saved_searches")).length) return;
  const saved = await all<{ id: string; user_id: string; workspace_id: string; name: string; query: string; kind: string; created_at: string; space_name: string | null }>(
    "SELECT s.id,s.user_id,s.workspace_id,s.name,s.query,s.kind,s.created_at,sp.name space_name FROM saved_searches s LEFT JOIN spaces sp ON sp.id=s.space_id AND sp.deleted_at IS NULL ORDER BY s.created_at,s.id",
  );
  const kinds: Record<string, string> = { document: "document", database: "database", whiteboard: "whiteboard", row: "record" };
  const positions = new Map<string, number>();
  for (const s of saved) {
    const at = Date.parse(`${s.created_at.replace(" ", "T")}Z`) || Date.now();
    let query = s.query;
    if (kinds[s.kind]) query += ` type:${kinds[s.kind]}`;
    if (s.space_name) query += ` in:"${s.space_name.replace(/"/g, "")}"`;
    await run(
      "INSERT INTO collections(id,workspace_id,owner_id,name,icon,query,shared,created_at,updated_at) VALUES(?,?,?,?,'',?,0,?,?) ON CONFLICT DO NOTHING",
      s.id,
      s.workspace_id,
      s.user_id,
      s.name,
      query,
      at,
      at,
    );
    const key = `${s.user_id}:${s.workspace_id}`;
    const position = (positions.get(key) ?? 0) + 1;
    positions.set(key, position);
    await run("INSERT INTO collection_order(user_id,collection_id,position) VALUES(?,?,?) ON CONFLICT DO NOTHING", s.user_id, s.id, position);
    await run("DELETE FROM saved_searches WHERE id=?", s.id);
  }
}

// Schema 88 – the OpenID Connect identity of every SSO account from before,
// copied from its subject ("<issuer>|<subject>": the issuer is a URL without
// "|", the subject may contain one, so the first "|" separates them). Only
// for a database that got user_identities with schema 88: lib/db.ts marks
// the step done where the table existed before (a disconnected identity
// must not come back).
async function identitiesFromSubjects() {
  const now = Date.now();
  for (const u of await all<{ id: string; subject: string; email: string; last_login_at: number | null }>(
    `SELECT id,subject,email,last_login_at FROM users WHERE ${sql.instr("subject", "'|'")}>1 AND subject NOT LIKE 'local:%' AND subject NOT LIKE 'ldap:%' AND subject NOT LIKE 'scim:%' AND subject NOT LIKE 'deleted:%'`,
  )) {
    const cut = u.subject.indexOf("|");
    await run(
      "INSERT INTO user_identities(id,user_id,provider,issuer,subject,email,created_at,last_used_at) VALUES(?,?,'oidc',?,?,?,?,?) ON CONFLICT DO NOTHING",
      randomUUID(),
      u.id,
      u.subject.slice(0, cut),
      u.subject.slice(cut + 1),
      u.email || "",
      now,
      u.last_login_at ?? null,
    );
  }
}

// Schema 90 – formatted text properties (#126): the existing values of
// text properties (not titles) are escaped once so they show as before
// ("*stars*" keeps its stars): records, record templates, records in the
// trash, database versions and saved database templates.
async function escapeFormattedText() {
  // Relation sync, AI properties and embeddings need not see this: the
  // text people read stays the same.
  await run("UPDATE relation_sync_control SET syncing=1 WHERE id=1");
  const touched: string[] = [];
  const queued = new Set(
    (await all<{ row_id: string }>("SELECT row_id FROM ai_auto_dirty UNION SELECT row_id FROM ai_embed_dirty")).map((r) => r.row_id),
  );
  for (const db of await all<{ page_id: string; fields: string }>("SELECT page_id,fields FROM databases")) {
    let fields: Field[];
    try {
      fields = JSON.parse(db.fields);
    } catch {
      continue;
    }
    if (!Array.isArray(fields) || !fields.some((f) => isFormattedText(f, fields))) continue;
    for (const table of ["rows", "row_templates"] as const)
      for (const row of await all<{ id: string; cells: string }>(`SELECT id,cells FROM ${table} WHERE page_id=?`, db.page_id)) {
        const next = escapeFormattedCells(JSON.parse(row.cells), fields);
        if (!next.changed) continue;
        await run(`UPDATE ${table} SET cells=? WHERE id=?`, JSON.stringify(next.cells), row.id);
        if (table === "rows") touched.push(row.id);
      }
    for (const entry of await all<{ id: string; payload: string }>("SELECT id,payload FROM row_trash WHERE page_id=?", db.page_id)) {
      const payload = JSON.parse(entry.payload) as { row?: { cells?: unknown } };
      const raw = payload.row?.cells;
      const cells = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (!cells || typeof cells !== "object") continue;
      const next = escapeFormattedCells(cells as Cells, fields);
      if (!next.changed) continue;
      payload.row!.cells = typeof raw === "string" ? JSON.stringify(next.cells) : next.cells;
      await run("UPDATE row_trash SET payload=? WHERE id=?", JSON.stringify(payload), entry.id);
    }
  }
  // Database versions and saved database templates carry their own
  // properties next to their records.
  const escapeSnapshot = (json: string) => {
    const data = JSON.parse(json) as { database?: { fields?: Field[] }; rows?: { cells?: Cells }[]; rowTemplates?: { cells?: Cells }[] };
    const fields = data.database?.fields;
    if (!Array.isArray(fields)) return null;
    let changed = false;
    for (const list of [data.rows, data.rowTemplates])
      for (const item of Array.isArray(list) ? list : []) {
        if (!item?.cells || typeof item.cells !== "object") continue;
        const next = escapeFormattedCells(item.cells, fields);
        if (next.changed) {
          item.cells = next.cells;
          changed = true;
        }
      }
    return changed ? JSON.stringify(data) : null;
  };
  for (const snap of await all<{ id: string; html: string }>("SELECT s.id,s.html FROM snapshots s JOIN pages p ON p.id=s.page_id WHERE p.kind='database' AND s.html LIKE '{%'")) {
    let next: string | null = null;
    try {
      next = escapeSnapshot(snap.html);
    } catch {}
    if (next) await run("UPDATE snapshots SET html=? WHERE id=?", next, snap.id);
  }
  for (const template of await all<{ id: string; payload: string }>("SELECT id,payload FROM templates WHERE kind='database'")) {
    let next: string | null = null;
    try {
      next = escapeSnapshot(template.payload);
    } catch {}
    if (next) await run("UPDATE templates SET payload=? WHERE id=?", next, template.id);
  }
  // Leave out what the triggers queued for AI properties and embeddings
  // of the escaped records (search and offline copies do follow).
  for (const rowId of touched.filter((r) => !queued.has(r))) {
    await run("DELETE FROM ai_auto_dirty WHERE row_id=?", rowId);
    await run("DELETE FROM ai_embed_dirty WHERE row_id=?", rowId);
  }
  await run("UPDATE relation_sync_control SET syncing=0 WHERE id=1");
}

// Schema 92 – integration secrets at rest (lib/sealed-values.ts): webhook
// signing secrets and addresses and the Git connections of databases are
// sealed once. A value that cannot be sealed now (no key can be written)
// stays readable; the step fails and is tried at the next start.
async function sealSecrets() {
  for (const hook of await all<{ id: string; url: string; secret: string }>("SELECT id,url,secret FROM webhooks"))
    if (!isSealed(hook.url) || !isSealed(hook.secret))
      await run(
        "UPDATE webhooks SET url=?,secret=? WHERE id=?",
        isSealed(hook.url) ? hook.url : sealWebhookUrl(hook.id, hook.url),
        isSealed(hook.secret) ? hook.secret : sealWebhookSecret(hook.id, hook.secret),
        hook.id,
      );
  for (const row of await all<{ page_id: string; settings: string }>(`SELECT page_id,settings FROM databases WHERE settings LIKE '%"git"%'`)) {
    let settings: { git?: StoredGit } & Record<string, unknown>;
    try {
      settings = JSON.parse(row.settings || "{}");
    } catch {
      continue;
    }
    const git = settings.git;
    if (!git || git.sealed || !git.token || !git.secret) continue;
    await run("UPDATE databases SET settings=? WHERE page_id=?", JSON.stringify({ ...settings, git: sealGit(row.page_id, git) }), row.page_id);
  }
}

// Comment reactions picked from emojibase-data 17 may end in a redundant
// U+FE0F (👍️); version 18 offers 👍, so they move to that form (see
// emoji-presentation.ts). A duplicate of the same person is dropped.
async function reactionEmojiPresentation() {
  for (const r of await all<{ message_id: string; user_id: string; emoji: string }>(
    "SELECT message_id,user_id,emoji FROM inline_reactions WHERE emoji LIKE ?",
    `%${String.fromCodePoint(0xfe0f)}`,
  )) {
    const emoji = emojiPresentation(r.emoji);
    if (emoji === r.emoji) continue;
    const key = [r.message_id, r.user_id, r.emoji];
    await updateIgnoringConflicts("inline_reactions", "emoji=?", "message_id=? AND user_id=? AND emoji=?", [emoji], key);
    await run("DELETE FROM inline_reactions WHERE message_id=? AND user_id=? AND emoji=?", ...key);
  }
}
