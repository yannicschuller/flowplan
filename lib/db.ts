import { setupStorage, stopStorage } from "./storage";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, statSync, unlinkSync } from "node:fs";
import { applyPendingRestore } from "./instance-restore-apply";
import { restorePendingIntoPostgres } from "./db-restore";
import { ensureCurrentPostgresSchema } from "./db-driver/pg-current";
import { clusterMode } from "./cluster/config";
import { deferRestoreToLeader } from "./cluster/duties";
import { restoreAtThisStart } from "./cluster/processes";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { flushRelationChanges } from "./relation-sync";
import type { Identity } from "./types";
import { notificationDefaults, notificationOn } from "./notification-kinds";
import { noteStatement, noteTransaction as noteTransactionMetric, runtimeMetricsOn } from "./runtime-metrics";
import { currentTx, dbContext, postgresUrl, readerThread } from "./db-driver/context";
import { closeDatabase, database } from "./db-driver";
// SQL that differs between SQLite and PostgreSQL (lib/db-driver/dialect.ts):
// `sql` is the dialect of this process, `nowText()` the CURRENT_TIMESTAMP text.
export { sql, nowText, daysAgoText } from "./db-driver/dialect";
const globalDb = globalThis as unknown as {
  flowplanDb?: DatabaseSync;
  flowplanSchema?: number;
  flowplanRollback?: (() => void)[];
  flowplanWrites?: number;
};
// While an asynchronous transaction (lib/db-driver/sqlite.ts) holds the one
// SQLite connection, synchronous writes from elsewhere would land in it
// (and be rolled back with it): they are refused. Reads are allowed.
function outsideAsyncTransaction(write: boolean) {
  const active = dbContext.sqliteActive;
  if (!active || !write) return;
  const scope = dbContext.als.getStore();
  if (scope?.root === active && !scope.root.ended) return;
  throw new Error(
    "A synchronous database write ran while an asynchronous transaction holds the database. Use the asynchronous db (lib/db-driver) or keep the write out of the transaction.",
  );
}
// The schema this version of Flowplan writes, kept in the database file as
// PRAGMA user_version: a restore refuses a backup from a newer version
// (lib/setup-restore.ts); older ones are brought up to date by migrate().
// Raise it together with the "Schema NN" step at the end of migrate().
export const SCHEMA_VERSION = 125;
// Tables with an explicit insertion order (schema 94): `ORDER BY …,seq`
// (pages have one as well, filled by the trigger pages_created_at).
// Schema 97 (workflows): tables created with their seq column (and its
// trigger) in migrateWorkflows.
const WORKFLOW_SEQ_TABLES = ["workflow_events", "workflow_runs", "workflow_steps"] as const;
export const SEQ_TABLES = [
  "snapshots",
  "row_snapshots",
  "notifications",
  "favorites",
  "row_favorites",
  "capture_targets",
  "inline_messages",
  "files",
  "collections",
  "scim_users",
  "scim_groups",
  "mail_queue",
  "webhook_deliveries",
  "spaces",
] as const;
function migrate(d: DatabaseSync) {
  if (globalDb.flowplanSchema === SCHEMA_VERSION) return;
  // Columns change below: cached `SELECT *` statements would keep the old ones.
  forgetStatements(d);
  // One-time data steps done (lib/data-steps.ts).
  d.exec("CREATE TABLE IF NOT EXISTS data_migrations(name TEXT PRIMARY KEY,at INTEGER NOT NULL)");
  d.exec(`
    CREATE TABLE IF NOT EXISTS publications(page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,include_children INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS publication_pages(root_id TEXT REFERENCES pages(id) ON DELETE CASCADE,page_id TEXT REFERENCES pages(id) ON DELETE CASCADE,PRIMARY KEY(root_id,page_id));
    CREATE TABLE IF NOT EXISTS row_documents(row_id TEXT PRIMARY KEY REFERENCES rows(id) ON DELETE CASCADE,state BLOB NOT NULL,html TEXT NOT NULL,generation TEXT NOT NULL,updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS row_snapshots(id TEXT PRIMARY KEY,row_id TEXT REFERENCES rows(id) ON DELETE CASCADE,state BLOB NOT NULL,html TEXT NOT NULL,created_by TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS row_templates(id TEXT PRIMARY KEY,page_id TEXT REFERENCES pages(id) ON DELETE CASCADE,name TEXT NOT NULL,cells TEXT NOT NULL,html TEXT NOT NULL,is_default INTEGER DEFAULT 0,created_by TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE INDEX IF NOT EXISTS row_templates_page ON row_templates(page_id);
    CREATE INDEX IF NOT EXISTS row_snapshots_row ON row_snapshots(row_id);
  `);
  const templateColumns = d.prepare("PRAGMA table_info(templates)").all() as {
    name: string;
  }[];
  if (!templateColumns.some((c) => c.name === "visibility"))
    d.exec(
      "ALTER TABLE templates ADD COLUMN visibility TEXT NOT NULL DEFAULT 'workspace'",
    );
  const formColumns = d.prepare("PRAGMA table_info(forms)").all() as {
    name: string;
  }[];
  if (!formColumns.some((c) => c.name === "config"))
    d.exec("ALTER TABLE forms ADD COLUMN config TEXT NOT NULL DEFAULT '{}'");
  if (!templateColumns.some((c) => c.name === "version"))
    d.exec(
      "ALTER TABLE templates ADD COLUMN version INTEGER NOT NULL DEFAULT 1",
    );
  if (!templateColumns.some((c) => c.name === "deleted_at"))
    d.exec("ALTER TABLE templates ADD COLUMN deleted_at TEXT");
  d.exec(
    "CREATE TABLE IF NOT EXISTS template_files(id TEXT PRIMARY KEY,template_id TEXT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,original_id TEXT NOT NULL,name TEXT NOT NULL,mime TEXT NOT NULL,data BLOB NOT NULL,UNIQUE(template_id,original_id))",
  );
  d.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,session_token TEXT NOT NULL REFERENCES sessions(token) ON DELETE CASCADE,endpoint TEXT UNIQUE NOT NULL,p256dh TEXT NOT NULL,auth TEXT NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS push_deliveries(id INTEGER PRIMARY KEY AUTOINCREMENT,notification_id TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,attempts INTEGER DEFAULT 0,available_at INTEGER DEFAULT 0,delivered_at INTEGER,last_error TEXT,UNIQUE(notification_id,subscription_id));
    CREATE TRIGGER IF NOT EXISTS queue_notification_push AFTER INSERT ON notifications BEGIN
      INSERT INTO push_deliveries(notification_id,subscription_id) SELECT NEW.id,s.id FROM push_subscriptions s JOIN sessions se ON se.token=s.session_token WHERE s.user_id=NEW.user_id AND se.expires>unixepoch()*1000;
    END;
  `);
  d.exec(`
    CREATE TABLE IF NOT EXISTS share_links(token TEXT PRIMARY KEY,root_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,name TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('viewer','commenter','editor')),include_children INTEGER DEFAULT 0,created_by TEXT REFERENCES users(id),created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS share_link_pages(token TEXT NOT NULL REFERENCES share_links(token) ON DELETE CASCADE,page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,PRIMARY KEY(token,page_id));
    CREATE TABLE IF NOT EXISTS shared_comments(id TEXT PRIMARY KEY,page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,row_id TEXT REFERENCES rows(id) ON DELETE CASCADE,name TEXT NOT NULL,body TEXT NOT NULL,resolved INTEGER DEFAULT 0,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS share_requests(token TEXT NOT NULL REFERENCES share_links(token) ON DELETE CASCADE,created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS share_requests_token ON share_requests(token,created_at);
  `);
  d.exec(`
    CREATE TABLE IF NOT EXISTS two_way_relations(id TEXT PRIMARY KEY,left_page TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,left_field TEXT NOT NULL,right_page TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,right_field TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS relation_endpoints(page_id TEXT NOT NULL,field_id TEXT NOT NULL,pair_id TEXT NOT NULL REFERENCES two_way_relations(id) ON DELETE CASCADE,PRIMARY KEY(page_id,field_id));
    CREATE TABLE IF NOT EXISTS relation_initializations(pair_id TEXT PRIMARY KEY REFERENCES two_way_relations(id) ON DELETE CASCADE,reversed INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS relation_changes(row_id TEXT PRIMARY KEY,page_id TEXT NOT NULL,old_cells TEXT,new_cells TEXT,old_version INTEGER);
    CREATE TABLE IF NOT EXISTS relation_sync_control(id INTEGER PRIMARY KEY CHECK(id=1),syncing INTEGER NOT NULL DEFAULT 0);
    INSERT OR IGNORE INTO relation_sync_control(id) VALUES(1);
    CREATE TRIGGER IF NOT EXISTS relation_row_insert AFTER INSERT ON rows WHEN (SELECT syncing FROM relation_sync_control WHERE id=1)=0 AND EXISTS(SELECT 1 FROM relation_endpoints WHERE page_id=NEW.page_id) BEGIN
      INSERT INTO relation_changes VALUES(NEW.id,NEW.page_id,NULL,NEW.cells,NULL) ON CONFLICT(row_id) DO UPDATE SET new_cells=NEW.cells;
    END;
    CREATE TRIGGER IF NOT EXISTS relation_row_update AFTER UPDATE OF cells ON rows WHEN OLD.cells!=NEW.cells AND (SELECT syncing FROM relation_sync_control WHERE id=1)=0 AND EXISTS(SELECT 1 FROM relation_endpoints WHERE page_id=NEW.page_id) BEGIN
      INSERT INTO relation_changes VALUES(NEW.id,NEW.page_id,OLD.cells,NEW.cells,OLD.version) ON CONFLICT(row_id) DO UPDATE SET new_cells=NEW.cells;
    END;
    CREATE TRIGGER IF NOT EXISTS relation_row_delete AFTER DELETE ON rows WHEN (SELECT syncing FROM relation_sync_control WHERE id=1)=0 AND EXISTS(SELECT 1 FROM relation_endpoints WHERE page_id=OLD.page_id) BEGIN
      INSERT INTO relation_changes VALUES(OLD.id,OLD.page_id,OLD.cells,NULL,OLD.version) ON CONFLICT(row_id) DO UPDATE SET new_cells=NULL;
    END;
  `);
  const pageColumns = d.prepare("PRAGMA table_info(pages)").all() as {
    name: string;
  }[];
  if (!pageColumns.some((column) => column.name === "cover_position"))
    d.exec(
      "ALTER TABLE pages ADD COLUMN cover_position REAL NOT NULL DEFAULT 50",
    );
  if (!pageColumns.some((column) => column.name === "icon_size"))
    d.exec("ALTER TABLE pages ADD COLUMN icon_size TEXT NOT NULL DEFAULT ''");
  if (!pageColumns.some((column) => column.name === "journal_date"))
    d.exec("ALTER TABLE pages ADD COLUMN journal_date TEXT");
  d.exec(
    "CREATE INDEX IF NOT EXISTS pages_journal_days ON pages(parent_id,journal_date) WHERE journal_date IS NOT NULL",
  );
  const snapshotColumns = d.prepare("PRAGMA table_info(snapshots)").all() as {
    name: string;
  }[];
  if (!snapshotColumns.some((column) => column.name === "appearance"))
    d.exec("ALTER TABLE snapshots ADD COLUMN appearance TEXT");
  d.exec(`CREATE TRIGGER IF NOT EXISTS capture_snapshot_appearance AFTER INSERT ON snapshots WHEN NEW.appearance IS NULL BEGIN
    UPDATE snapshots SET appearance=(SELECT json_object('cover',cover,'coverPosition',cover_position) FROM pages WHERE id=NEW.page_id) WHERE id=NEW.id;
  END;`);
  const spaceColumns = d.prepare("PRAGMA table_info(spaces)").all() as {
    name: string;
  }[];
  if (!spaceColumns.some((column) => column.name === "deleted_at"))
    d.exec("ALTER TABLE spaces ADD COLUMN deleted_at TEXT");
  if (!spaceColumns.some((column) => column.name === "version"))
    d.exec("ALTER TABLE spaces ADD COLUMN version INTEGER NOT NULL DEFAULT 1");
  d.exec(`CREATE TABLE IF NOT EXISTS space_trash_pages(space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,PRIMARY KEY(space_id,page_id));
    CREATE TABLE IF NOT EXISTS pending_file_deletions(id TEXT PRIMARY KEY);`);
  if (!spaceColumns.some((column) => column.name === "icon_color"))
    d.exec(
      "ALTER TABLE spaces ADD COLUMN icon_color TEXT NOT NULL DEFAULT 'none'",
    );
  d.exec(`CREATE TABLE IF NOT EXISTS editor_presence(
    id TEXT UNIQUE NOT NULL,session_token TEXT NOT NULL REFERENCES sessions(token) ON DELETE CASCADE,
    client_id TEXT NOT NULL,page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    row_id TEXT REFERENCES rows(id) ON DELETE CASCADE,generation TEXT NOT NULL,
    sequence INTEGER NOT NULL,cursor TEXT,seen INTEGER NOT NULL,PRIMARY KEY(session_token,client_id));
    CREATE INDEX IF NOT EXISTS editor_presence_scope ON editor_presence(page_id,row_id,generation,seen);`);
  d.exec(`CREATE TABLE IF NOT EXISTS inline_threads(
    id TEXT PRIMARY KEY,page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    row_id TEXT REFERENCES rows(id) ON DELETE CASCADE,author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    anchor TEXT NOT NULL,resolved INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 1,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE INDEX IF NOT EXISTS inline_threads_document ON inline_threads(page_id,row_id);
    CREATE TABLE IF NOT EXISTS inline_messages(
    id TEXT PRIMARY KEY,thread_id TEXT NOT NULL REFERENCES inline_threads(id) ON DELETE CASCADE,
    author_id TEXT REFERENCES users(id) ON DELETE SET NULL,author_name TEXT NOT NULL,body TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,deleted INTEGER NOT NULL DEFAULT 0,created_at TEXT DEFAULT CURRENT_TIMESTAMP,edited_at TEXT);
    CREATE INDEX IF NOT EXISTS inline_messages_thread ON inline_messages(thread_id,created_at);
    CREATE TABLE IF NOT EXISTS inline_reactions(
    message_id TEXT NOT NULL REFERENCES inline_messages(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji TEXT NOT NULL,PRIMARY KEY(message_id,user_id,emoji));
    CREATE INDEX IF NOT EXISTS editor_presence_seen ON editor_presence(seen);`);
  if (
    !(
      d.prepare("PRAGMA table_info(inline_messages)").all() as {
        name: string;
      }[]
    ).some((c) => c.name === "imported_reactions")
  )
    d.exec(
      "ALTER TABLE inline_messages ADD COLUMN imported_reactions TEXT NOT NULL DEFAULT '[]'",
    );
  // Full-text search: triggers only queue changed pages/rows (see search-index.ts).
  // NOT EXISTS instead of OR IGNORE: an outer upsert would override the trigger's conflict policy.
  d.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(page_id UNINDEXED,row_id UNINDEXED,title,body,tokenize='trigram remove_diacritics 1');
    CREATE TABLE IF NOT EXISTS search_dirty(page_id TEXT NOT NULL,row_id TEXT NOT NULL DEFAULT '',PRIMARY KEY(page_id,row_id));
    CREATE TABLE IF NOT EXISTS search_state(id INTEGER PRIMARY KEY CHECK(id=1),built INTEGER NOT NULL);
    CREATE TRIGGER IF NOT EXISTS search_page_insert AFTER INSERT ON pages BEGIN INSERT INTO search_dirty SELECT NEW.id,'' WHERE NOT EXISTS(SELECT 1 FROM search_dirty WHERE page_id=NEW.id AND row_id=''); END;
    CREATE TRIGGER IF NOT EXISTS search_page_update AFTER UPDATE OF title,deleted_at ON pages BEGIN INSERT INTO search_dirty SELECT NEW.id,'' WHERE NOT EXISTS(SELECT 1 FROM search_dirty WHERE page_id=NEW.id AND row_id=''); END;
    CREATE TRIGGER IF NOT EXISTS search_page_delete AFTER DELETE ON pages BEGIN INSERT INTO search_dirty SELECT OLD.id,'' WHERE NOT EXISTS(SELECT 1 FROM search_dirty WHERE page_id=OLD.id AND row_id=''); END;
    CREATE TRIGGER IF NOT EXISTS search_document_insert AFTER INSERT ON documents BEGIN INSERT INTO search_dirty SELECT NEW.page_id,'' WHERE NOT EXISTS(SELECT 1 FROM search_dirty WHERE page_id=NEW.page_id AND row_id=''); END;
    CREATE TRIGGER IF NOT EXISTS search_document_update AFTER UPDATE OF html ON documents BEGIN INSERT INTO search_dirty SELECT NEW.page_id,'' WHERE NOT EXISTS(SELECT 1 FROM search_dirty WHERE page_id=NEW.page_id AND row_id=''); END;
    CREATE TRIGGER IF NOT EXISTS search_row_insert AFTER INSERT ON rows BEGIN INSERT INTO search_dirty SELECT NEW.page_id,NEW.id WHERE NOT EXISTS(SELECT 1 FROM search_dirty WHERE page_id=NEW.page_id AND row_id=NEW.id); END;
    CREATE TRIGGER IF NOT EXISTS search_row_update AFTER UPDATE OF cells,content,page_id ON rows BEGIN INSERT INTO search_dirty SELECT OLD.page_id,OLD.id WHERE NOT EXISTS(SELECT 1 FROM search_dirty WHERE page_id=OLD.page_id AND row_id=OLD.id); INSERT INTO search_dirty SELECT NEW.page_id,NEW.id WHERE NOT EXISTS(SELECT 1 FROM search_dirty WHERE page_id=NEW.page_id AND row_id=NEW.id); END;
    CREATE TRIGGER IF NOT EXISTS search_row_delete AFTER DELETE ON rows BEGIN INSERT INTO search_dirty SELECT OLD.page_id,OLD.id WHERE NOT EXISTS(SELECT 1 FROM search_dirty WHERE page_id=OLD.page_id AND row_id=OLD.id); END;
    CREATE TRIGGER IF NOT EXISTS search_row_document_insert AFTER INSERT ON row_documents BEGIN INSERT INTO search_dirty SELECT r.page_id,r.id FROM rows r WHERE r.id=NEW.row_id AND NOT EXISTS(SELECT 1 FROM search_dirty WHERE page_id=r.page_id AND row_id=r.id); END;
    CREATE TRIGGER IF NOT EXISTS search_row_document_update AFTER UPDATE OF html ON row_documents BEGIN INSERT INTO search_dirty SELECT r.page_id,r.id FROM rows r WHERE r.id=NEW.row_id AND NOT EXISTS(SELECT 1 FROM search_dirty WHERE page_id=r.page_id AND row_id=r.id); END;
    CREATE TABLE IF NOT EXISTS search_meta(key TEXT PRIMARY KEY);
    CREATE TRIGGER IF NOT EXISTS search_comment_insert AFTER INSERT ON comments BEGIN INSERT INTO search_dirty SELECT NEW.page_id,'c:'||NEW.id WHERE NOT EXISTS(SELECT 1 FROM search_dirty WHERE page_id=NEW.page_id AND row_id='c:'||NEW.id); END;
    CREATE TRIGGER IF NOT EXISTS search_comment_update AFTER UPDATE OF body ON comments BEGIN INSERT INTO search_dirty SELECT NEW.page_id,'c:'||NEW.id WHERE NOT EXISTS(SELECT 1 FROM search_dirty WHERE page_id=NEW.page_id AND row_id='c:'||NEW.id); END;
    CREATE TRIGGER IF NOT EXISTS search_comment_delete AFTER DELETE ON comments BEGIN INSERT INTO search_dirty SELECT OLD.page_id,'c:'||OLD.id WHERE NOT EXISTS(SELECT 1 FROM search_dirty WHERE page_id=OLD.page_id AND row_id='c:'||OLD.id); END;
    CREATE TRIGGER IF NOT EXISTS search_message_insert AFTER INSERT ON inline_messages BEGIN INSERT INTO search_dirty SELECT t.page_id,'m:'||NEW.id FROM inline_threads t WHERE t.id=NEW.thread_id AND NOT EXISTS(SELECT 1 FROM search_dirty WHERE page_id=t.page_id AND row_id='m:'||NEW.id); END;
    CREATE TRIGGER IF NOT EXISTS search_message_update AFTER UPDATE OF body,deleted ON inline_messages BEGIN INSERT INTO search_dirty SELECT t.page_id,'m:'||NEW.id FROM inline_threads t WHERE t.id=NEW.thread_id AND NOT EXISTS(SELECT 1 FROM search_dirty WHERE page_id=t.page_id AND row_id='m:'||NEW.id); END;
    CREATE TRIGGER IF NOT EXISTS search_file_insert AFTER INSERT ON files BEGIN INSERT INTO search_dirty SELECT NEW.page_id,'f:'||NEW.id WHERE NOT EXISTS(SELECT 1 FROM search_dirty WHERE page_id=NEW.page_id AND row_id='f:'||NEW.id); END;
    CREATE TRIGGER IF NOT EXISTS search_file_delete AFTER DELETE ON files BEGIN INSERT INTO search_dirty SELECT OLD.page_id,'f:'||OLD.id WHERE NOT EXISTS(SELECT 1 FROM search_dirty WHERE page_id=OLD.page_id AND row_id='f:'||OLD.id); END;`);
  // The index finds an entry by page and key only by reading every entry
  // (both columns are UNINDEXED), which made refreshing N entries cost N
  // full scans. An index on its content table (c0 = page_id, c1 = row_id)
  // finds them directly; SQLite keeps it current with every change of the
  // index, also by older versions. Optional: a connection that forbids
  // changes to shadow tables (SQLITE_DBCONFIG_DEFENSIVE) falls back to the scan.
  try {
    d.exec("CREATE INDEX IF NOT EXISTS search_index_key ON search_index_content(c0,c1)");
  } catch {}
  // Personal reminders on date cells. The cell value stays untouched; the
  // worker re-arms a reminder whenever the observed date value changes.
  d.exec(`CREATE TABLE IF NOT EXISTS date_reminders(
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    row_id TEXT NOT NULL REFERENCES rows(id) ON DELETE CASCADE,
    field_id TEXT NOT NULL,offset_minutes INTEGER NOT NULL,time_zone TEXT NOT NULL,
    observed_value TEXT,armed_at INTEGER NOT NULL,fired_value TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(user_id,row_id,field_id));
    CREATE INDEX IF NOT EXISTS date_reminders_page ON date_reminders(page_id,user_id);`);
  if (
    !(
      d.prepare("PRAGMA table_info(workspaces)").all() as { name: string }[]
    ).some((c) => c.name === "quota_mb")
  )
    d.exec("ALTER TABLE workspaces ADD COLUMN quota_mb INTEGER");
  // Limits per account (JSON, see lib/user-limits.ts).
  if (!(d.prepare("PRAGMA table_info(users)").all() as { name: string }[]).some((c) => c.name === "limits"))
    d.exec("ALTER TABLE users ADD COLUMN limits TEXT");
  // The language chosen in the profile (NULL = from the browser).
  if (!(d.prepare("PRAGMA table_info(users)").all() as { name: string }[]).some((c) => c.name === "language"))
    d.exec("ALTER TABLE users ADD COLUMN language TEXT");
  d.exec(`CREATE TABLE IF NOT EXISTS row_trash(
    id TEXT PRIMARY KEY,page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL,title TEXT NOT NULL,payload TEXT NOT NULL,deleted_by TEXT,
    deleted_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE INDEX IF NOT EXISTS row_trash_workspace ON row_trash(workspace_id,deleted_at);
    CREATE TABLE IF NOT EXISTS row_favorites(
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    row_id TEXT NOT NULL REFERENCES rows(id) ON DELETE CASCADE,
    page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    PRIMARY KEY(user_id,row_id));`);
  // Extracted text of PDF attachments for the search index.
  d.exec(`CREATE TABLE IF NOT EXISTS file_texts(
    file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    status TEXT NOT NULL,
    extracted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TRIGGER IF NOT EXISTS search_file_text AFTER INSERT ON file_texts BEGIN INSERT INTO search_dirty SELECT f.page_id,'f:'||f.id FROM files f WHERE f.id=NEW.file_id AND f.page_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM search_dirty WHERE page_id=f.page_id AND row_id='f:'||f.id); END;`);
  // Files uploaded by guests through an editing share link.
  d.exec(`CREATE TABLE IF NOT EXISTS share_uploads(
    file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
    token TEXT NOT NULL,
    created_at INTEGER NOT NULL);`);
  // Template gallery category; visibility may also be 'instance' (admins).
  if (
    !(
      d.prepare("PRAGMA table_info(templates)").all() as { name: string }[]
    ).some((c) => c.name === "category")
  )
    d.exec(
      "ALTER TABLE templates ADD COLUMN category TEXT NOT NULL DEFAULT ''",
    );
  // Guests are members who only see pages and spaces shared with them.
  d.exec(`CREATE TABLE IF NOT EXISTS workspace_guests(
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY(workspace_id,user_id));`);
  if (
    !(d.prepare("PRAGMA table_info(invites)").all() as { name: string }[]).some(
      (c) => c.name === "guest",
    )
  )
    d.exec("ALTER TABLE invites ADD COLUMN guest INTEGER NOT NULL DEFAULT 0");
  // Whether an account's address is proven (confirmation link, an
  // administrator, the SSO provider): only then do invitations and shared
  // pages for that address reach it. Invitations also carry a secret link.
  if (!(d.prepare("PRAGMA table_info(users)").all() as { name: string }[]).some((c) => c.name === "email_verified")) {
    d.exec("ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0");
    if (d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='local_accounts'").get())
      d.exec("UPDATE users SET email_verified=1 WHERE id IN (SELECT user_id FROM local_accounts WHERE email_verified=1)");
  }
  if (!(d.prepare("PRAGMA table_info(invites)").all() as { name: string }[]).some((c) => c.name === "token")) {
    d.exec("ALTER TABLE invites ADD COLUMN token TEXT");
    d.exec("CREATE UNIQUE INDEX IF NOT EXISTS invites_token ON invites(token)");
  }
  // When an invitation went out (shown in Settings → Members).
  if (!(d.prepare("PRAGMA table_info(invites)").all() as { name: string }[]).some((c) => c.name === "created_at"))
    d.exec("ALTER TABLE invites ADD COLUMN created_at INTEGER");
  // Pages shared with an e-mail address that has no account yet; applied
  // when the invitation is accepted (lib/page-share.ts, lib/auth.ts).
  d.exec(`CREATE TABLE IF NOT EXISTS invite_grants(workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,email TEXT NOT NULL,resource_id TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('viewer','editor')),PRIMARY KEY(email,resource_id))`);
  d.exec(
    "CREATE TABLE IF NOT EXISTS instance_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)",
  );
  // Personal saved searches per workspace.
  d.exec(`CREATE TABLE IF NOT EXISTS saved_searches(
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    query TEXT NOT NULL,
    kind TEXT NOT NULL,
    space_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE INDEX IF NOT EXISTS saved_searches_user ON saved_searches(user_id,workspace_id);`);
  // Publication metadata and whether visitors may copy the publication.
  const publicationColumns = d
    .prepare("PRAGMA table_info(publications)")
    .all() as { name: string }[];
  for (const [column, type] of [
    ["published_at", "TEXT"],
    ["published_by", "TEXT"],
    ["allow_copy", "INTEGER NOT NULL DEFAULT 1"],
    // New sub-pages join the publication by themselves (lib/publication.ts).
    // Off for existing publications; an older version ignores the column
    // and only publishes the stored list (the safe side), so the schema
    // number stays.
    ["auto_children", "INTEGER NOT NULL DEFAULT 0"],
    // "Pfeil ↗ hinter Links zeigen" (#217, lib/external-link-icon-pref.ts):
    // the publisher's choice, taken at publishing and changeable in the
    // dialog. Existing publications keep the arrow they always showed; an
    // older version ignores the column, so the schema number stays.
    ["external_link_icon", "INTEGER NOT NULL DEFAULT 1"],
  ])
    if (!publicationColumns.some((c) => c.name === column))
      d.exec(`ALTER TABLE publications ADD COLUMN ${column} ${type}`);
  // Manual versions are kept; automatic ones follow the retention rules.
  if (
    !(
      d.prepare("PRAGMA table_info(snapshots)").all() as { name: string }[]
    ).some((c) => c.name === "kind")
  )
    d.exec(
      "ALTER TABLE snapshots ADD COLUMN kind TEXT NOT NULL DEFAULT 'auto'",
    );
  if (
    !(
      d.prepare("PRAGMA table_info(row_snapshots)").all() as { name: string }[]
    ).some((c) => c.name === "kind")
  )
    d.exec(
      "ALTER TABLE row_snapshots ADD COLUMN kind TEXT NOT NULL DEFAULT 'auto'",
    );
  const rowColumns = d.prepare("PRAGMA table_info(rows)").all() as {
    name: string;
  }[];
  // Record pages have their own icon and cover (image of the database page or color).
  for (const column of ["icon", "cover", "recurrence"])
    if (!rowColumns.some((c) => c.name === column))
      d.exec(`ALTER TABLE rows ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`);
  // Ticket numbers: every record gets the next number of its database when
  // it is created (any insert path), shown by an "ID" property as WEB-123.
  if (!rowColumns.some((c) => c.name === "number")) {
    d.exec("ALTER TABLE rows ADD COLUMN number INTEGER");
    d.exec(
      "UPDATE rows SET number=(SELECT count(*) FROM rows r2 WHERE r2.page_id=rows.page_id AND (r2.created_at<rows.created_at OR (r2.created_at=rows.created_at AND r2.rowid<=rows.rowid)))",
    );
  }
  // A counter per database, so numbers of deleted records are never reused.
  d.exec(`CREATE INDEX IF NOT EXISTS rows_number ON rows(page_id,number);
    CREATE TABLE IF NOT EXISTS row_counters(page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,last INTEGER NOT NULL);
    CREATE TRIGGER IF NOT EXISTS rows_number_counter AFTER INSERT ON rows WHEN NEW.number IS NULL BEGIN
      INSERT INTO row_counters(page_id,last) VALUES(NEW.page_id,(SELECT COALESCE(MAX(number),0) FROM rows WHERE page_id=NEW.page_id)) ON CONFLICT(page_id) DO NOTHING;
      UPDATE row_counters SET last=last+1 WHERE page_id=NEW.page_id;
      UPDATE rows SET number=(SELECT last FROM row_counters WHERE page_id=NEW.page_id) WHERE id=NEW.id;
    END;`);
  // Per record access: inherited, read-only or private, plus grants.
  if (!rowColumns.some((c) => c.name === "access"))
    d.exec(
      "ALTER TABLE rows ADD COLUMN access TEXT NOT NULL DEFAULT 'inherit'",
    );
  // Automations: overdue rules fire once per record and due date; the
  // status log records when records became done (sprint charts).
  d.exec(`CREATE TABLE IF NOT EXISTS automation_runs(automation_id TEXT NOT NULL,row_id TEXT NOT NULL,key TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(automation_id,row_id,key));
    CREATE TABLE IF NOT EXISTS row_status_log(id TEXT PRIMARY KEY,page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,row_id TEXT NOT NULL,done INTEGER NOT NULL,at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS row_status_log_page ON row_status_log(page_id,at);`);
  // Time tracking: entries per record and person; a running timer has no end.
  d.exec(`CREATE TABLE IF NOT EXISTS time_entries(id TEXT PRIMARY KEY,page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,row_id TEXT NOT NULL,field_id TEXT NOT NULL,user_id TEXT NOT NULL,start INTEGER NOT NULL,end INTEGER,note TEXT NOT NULL DEFAULT '');
    CREATE INDEX IF NOT EXISTS time_entries_row ON time_entries(row_id,start);
    CREATE INDEX IF NOT EXISTS time_entries_page ON time_entries(page_id,start);
    CREATE INDEX IF NOT EXISTS time_entries_running ON time_entries(user_id) WHERE end IS NULL;`);
  // CalDAV: two-way calendar sync per person and calendar view.
  d.exec(`CREATE TABLE IF NOT EXISTS caldav_accesses(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,view_id TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,created_at INTEGER NOT NULL);`);
  // Saved filters over all databases ("My tasks" → records).
  d.exec(`CREATE TABLE IF NOT EXISTS record_views(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,name TEXT NOT NULL,config TEXT NOT NULL,created_at INTEGER NOT NULL);`);
  // Where a person captures into per workspace (share, web clipper, quick capture).
  d.exec(`CREATE TABLE IF NOT EXISTS capture_targets(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,PRIMARY KEY(user_id,workspace_id));`);
  // Git connection: commits and pull requests linked to records.
  d.exec(`CREATE TABLE IF NOT EXISTS git_links(id TEXT PRIMARY KEY,page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,row_id TEXT NOT NULL,kind TEXT NOT NULL,ref TEXT NOT NULL,title TEXT NOT NULL,url TEXT NOT NULL,author TEXT NOT NULL DEFAULT '',state TEXT NOT NULL DEFAULT '',at INTEGER NOT NULL,UNIQUE(row_id,url));`);
  // Optional database settings: done rule, workflow, automations, sprints,
  // time tracking, Git (lib/database-settings.ts).
  if (!(d.prepare("PRAGMA table_info(databases)").all() as { name: string }[]).some((c) => c.name === "settings"))
    d.exec("ALTER TABLE databases ADD COLUMN settings TEXT NOT NULL DEFAULT '{}'");
  if (
    !(
      d.prepare("PRAGMA table_info(databases)").all() as { name: string }[]
    ).some((c) => c.name === "record_layout")
  )
    d.exec(
      "ALTER TABLE databases ADD COLUMN record_layout TEXT NOT NULL DEFAULT '{}'",
    );
  // Whiteboards: the board as Yjs state, plus who is looking at it where.
  d.exec(`CREATE TABLE IF NOT EXISTS whiteboards(
    page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
    state BLOB NOT NULL,
    generation TEXT NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS whiteboard_presence(
    page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    x REAL NOT NULL,
    y REAL NOT NULL,
    seen INTEGER NOT NULL,
    PRIMARY KEY(page_id,user_id));`);
  // Customer portal: a private link per form request, and the conversation
  // between the customer and the team. No foreign key on the record, so a
  // ticket comes back when its record is restored from the trash.
  d.exec(`CREATE TABLE IF NOT EXISTS tickets(token TEXT PRIMARY KEY,row_id TEXT NOT NULL UNIQUE,page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,email TEXT,locale TEXT NOT NULL DEFAULT 'de',created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS ticket_messages(id TEXT PRIMARY KEY,row_id TEXT NOT NULL,author_id TEXT,author_name TEXT NOT NULL DEFAULT '',body TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS ticket_messages_row ON ticket_messages(row_id,created_at);`);
  d.exec(`CREATE TABLE IF NOT EXISTS share_live_requests(token TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS share_live_requests_token ON share_live_requests(token,created_at);`);
  // Per share link and document: the guest projection for live editing.
  d.exec(`CREATE TABLE IF NOT EXISTS share_live(
    key TEXT PRIMARY KEY,
    state BLOB NOT NULL,
    source_html TEXT NOT NULL,
    generation TEXT NOT NULL,
    pgen TEXT NOT NULL,
    updated_at INTEGER NOT NULL)`);
  d.exec(`CREATE TABLE IF NOT EXISTS row_grants(
    row_id TEXT NOT NULL REFERENCES rows(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL DEFAULT '',
    group_id TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL CHECK(role IN ('viewer','editor')),
    PRIMARY KEY(row_id,user_id,group_id))`);
  const notificationColumns = d
    .prepare("PRAGMA table_info(notifications)")
    .all() as { name: string }[];
  for (const column of ["row_id", "thread_id", "kind"])
    if (!notificationColumns.some((c) => c.name === column))
      d.exec(`ALTER TABLE notifications ADD COLUMN ${column} TEXT`);
  // Per person and kind: whether notifications reach the inbox and push.
  d.exec(`CREATE TABLE IF NOT EXISTS notification_prefs(
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    inbox INTEGER NOT NULL DEFAULT 1,
    push INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY(user_id,kind));
    -- Defaults per kind (lib/notification-kinds.ts), refreshed below.
    CREATE TABLE IF NOT EXISTS notification_defaults(kind TEXT PRIMARY KEY,inbox INTEGER NOT NULL,push INTEGER NOT NULL,email INTEGER NOT NULL);
    -- A notification for push only (notifications.push_only, added in
    -- migrateStudyReminders before anything is inserted) passes.
    DROP TRIGGER IF EXISTS notification_inbox_pref;
    CREATE TRIGGER notification_inbox_pref BEFORE INSERT ON notifications
    WHEN NOT (${notificationOn("inbox", "NEW.user_id", "NEW.kind")}) AND NEW.push_only IS NOT 1
    BEGIN SELECT RAISE(IGNORE); END;
    DROP TRIGGER IF EXISTS queue_notification_push;
    CREATE TRIGGER queue_notification_push AFTER INSERT ON notifications BEGIN
      INSERT INTO push_deliveries(notification_id,subscription_id) SELECT NEW.id,s.id FROM push_subscriptions s JOIN sessions se ON se.token=s.session_token WHERE s.user_id=NEW.user_id AND se.expires>unixepoch()*1000
      AND ${notificationOn("push", "NEW.user_id", "NEW.kind")};
    END;`);
  // Chat apps (lib/messengers.ts): a fourth channel per kind. A person's
  // rows saved before it existed keep NULL there, i.e. the default.
  if (!(d.prepare("PRAGMA table_info(notification_defaults)").all() as { name: string }[]).some((c) => c.name === "messenger"))
    d.exec("ALTER TABLE notification_defaults ADD COLUMN messenger INTEGER NOT NULL DEFAULT 0");
  if (!(d.prepare("PRAGMA table_info(notification_prefs)").all() as { name: string }[]).some((c) => c.name === "messenger"))
    d.exec("ALTER TABLE notification_prefs ADD COLUMN messenger INTEGER");
  for (const [kind, on] of Object.entries(notificationDefaults))
    d.prepare(
      "INSERT INTO notification_defaults(kind,inbox,push,email,messenger) VALUES(?,?,?,?,?) ON CONFLICT(kind) DO UPDATE SET inbox=excluded.inbox,push=excluded.push,email=excluded.email,messenger=excluded.messenger",
    ).run(kind, on.inbox ? 1 : 0, on.push ? 1 : 0, on.email ? 1 : 0, on.messenger ? 1 : 0);
  const flowColumns = d.prepare("PRAGMA table_info(oidc_flows)").all() as {
    name: string;
  }[];
  if (!flowColumns.some((c) => c.name === "return_to"))
    d.exec("ALTER TABLE oidc_flows ADD COLUMN return_to TEXT");
  // "Stay signed in on this device" through SSO: remembered for the callback.
  if (!flowColumns.some((c) => c.name === "remember"))
    d.exec("ALTER TABLE oidc_flows ADD COLUMN remember INTEGER NOT NULL DEFAULT 0");
  // Sessions: when they began, whether they slide while used ("stay signed
  // in"), whether SSO groups came with them, and the device for the list of
  // one's own sessions.
  const sessionColumns = (d.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map((c) => c.name);
  for (const [name, type] of [
    ["created_at", "INTEGER"],
    ["remember", "INTEGER NOT NULL DEFAULT 0"],
    ["sso", "INTEGER NOT NULL DEFAULT 0"],
    ["last_seen", "INTEGER"],
    ["agent", "TEXT NOT NULL DEFAULT ''"],
    // When the person last proved who they are for this session (step-up,
    // lib/step-up.ts); an app hand-off carries the browser session's time.
    ["authenticated_at", "INTEGER"],
    // Sessions the sign-in through a reverse proxy created (lib/proxy-auth.ts):
    // the user name the proxy named, lowercase; NULL for every other session.
    // An older version ignores it (the session then lasts its normal time),
    // so the schema number stays.
    ["proxy_user", "TEXT"],
  ])
    if (!sessionColumns.includes(name)) d.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${type}`);
  // Sessions of the desktop and mobile apps (#133): they stay signed in by
  // the app's own rules (lib/session-policy.ts). Sessions the apps signed in
  // with before are recognised by their user agent.
  if (!sessionColumns.includes("app")) {
    d.exec("ALTER TABLE sessions ADD COLUMN app INTEGER NOT NULL DEFAULT 0");
    d.exec("UPDATE sessions SET app=1,remember=1 WHERE agent LIKE '%FlowplanMobile/%' OR agent LIKE '%FlowplanDesktop/%'");
  }
  if (
    !(
      d.prepare("PRAGMA table_info(inline_messages)").all() as {
        name: string;
      }[]
    ).some((c) => c.name === "rich_body")
  )
    d.exec("ALTER TABLE inline_messages ADD COLUMN rich_body TEXT");
  const userColumns = d.prepare("PRAGMA table_info(users)").all() as {
    name: string;
  }[];
  if (!userColumns.some((c) => c.name === "avatar"))
    d.exec("ALTER TABLE users ADD COLUMN avatar TEXT");
  // Public demo accounts: when they end at the latest (null for real ones).
  if (!userColumns.some((c) => c.name === "demo_until"))
    d.exec("ALTER TABLE users ADD COLUMN demo_until INTEGER");
  d.exec(
    "CREATE TABLE IF NOT EXISTS demo_starts(address TEXT NOT NULL,at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS demo_starts_address ON demo_starts(address,at);",
  );
  // Instance-wide counters that outlive the rows they count (e.g. demos).
  d.exec(
    "CREATE TABLE IF NOT EXISTS counters(name TEXT PRIMARY KEY,value INTEGER NOT NULL DEFAULT 0); INSERT OR IGNORE INTO counters(name,value) SELECT 'demos_started',COUNT(*) FROM demo_starts;",
  );
  d.exec(
    "CREATE TABLE IF NOT EXISTS user_avatars(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,mime TEXT NOT NULL,data BLOB NOT NULL)",
  );
  // E-mail: queue, digest marker on notifications, e-mail channel per kind.
  d.exec(
    "CREATE TABLE IF NOT EXISTS mail_queue(id TEXT PRIMARY KEY,recipient TEXT NOT NULL,subject TEXT NOT NULL,text TEXT NOT NULL,html TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL,sent_at INTEGER,error TEXT); CREATE INDEX IF NOT EXISTS mail_queue_due ON mail_queue(sent_at,next_at);",
  );
  if (!(d.prepare("PRAGMA table_info(notifications)").all() as { name: string }[]).some((c) => c.name === "emailed_at"))
    d.exec("ALTER TABLE notifications ADD COLUMN emailed_at TEXT");
  if (!(d.prepare("PRAGMA table_info(notification_prefs)").all() as { name: string }[]).some((c) => c.name === "email"))
    d.exec("ALTER TABLE notification_prefs ADD COLUMN email INTEGER NOT NULL DEFAULT 1");
  // Calendar subscriptions, API tokens, webhooks, instance state.
  d.exec(`CREATE TABLE IF NOT EXISTS calendar_feeds(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,view_id TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS api_tokens(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,name TEXT NOT NULL,scope TEXT NOT NULL CHECK(scope IN ('read','write','clipper')),token_hash TEXT NOT NULL UNIQUE,prefix TEXT NOT NULL,created_at INTEGER NOT NULL,last_used_at INTEGER,expires_at INTEGER);
    CREATE TABLE IF NOT EXISTS webhooks(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,url TEXT NOT NULL,events TEXT NOT NULL,page_id TEXT,secret TEXT NOT NULL,created_by TEXT,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS webhook_deliveries(id TEXT PRIMARY KEY,webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,body TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL,created_at INTEGER NOT NULL,delivered_at INTEGER,status INTEGER,error TEXT);
    CREATE INDEX IF NOT EXISTS webhook_deliveries_due ON webhook_deliveries(delivered_at,next_at);
    CREATE TABLE IF NOT EXISTS instance_state(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
  // Last sign-in, for inactive accounts in the administration.
  if (!(d.prepare("PRAGMA table_info(users)").all() as { name: string }[]).some((c) => c.name === "last_login_at"))
    d.exec("ALTER TABLE users ADD COLUMN last_login_at INTEGER");
  // Language of the last visit, for e-mails and push notifications.
  if (!(d.prepare("PRAGMA table_info(users)").all() as { name: string }[]).some((c) => c.name === "locale"))
    d.exec("ALTER TABLE users ADD COLUMN locale TEXT");
  // The short introduction after creating an account. Accounts that existed
  // before it was added count as introduced.
  if (!(d.prepare("PRAGMA table_info(users)").all() as { name: string }[]).some((c) => c.name === "onboarded_at")) {
    d.exec("ALTER TABLE users ADD COLUMN onboarded_at INTEGER");
    d.prepare("UPDATE users SET onboarded_at=?").run(Date.now());
  }
  // Journals: template, trackers, calendar link and PIN; values per day.
  d.exec(`CREATE TABLE IF NOT EXISTS journal_settings(page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,template TEXT NOT NULL DEFAULT '',trackers TEXT NOT NULL DEFAULT '[]',lock_hash TEXT,ics_url TEXT);
    CREATE TABLE IF NOT EXISTS journal_entries(page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,data TEXT NOT NULL DEFAULT '{}',place TEXT NOT NULL DEFAULT '',lat REAL,lon REAL,updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS journal_unlocks(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,until INTEGER NOT NULL,PRIMARY KEY(user_id,page_id));`);
  // Visits (with the text at that time), edits per person, followers.
  d.exec(`CREATE TABLE IF NOT EXISTS page_visits(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,seen_at INTEGER NOT NULL,html TEXT,PRIMARY KEY(user_id,page_id));
    CREATE INDEX IF NOT EXISTS page_visits_page ON page_visits(page_id,seen_at);
    CREATE TABLE IF NOT EXISTS page_edits(page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,at INTEGER NOT NULL,PRIMARY KEY(page_id,user_id));
    CREATE TABLE IF NOT EXISTS page_follows(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,created_at INTEGER NOT NULL,PRIMARY KEY(user_id,page_id));`);
  // Tasks in documents (assignee, due date) and their morning reminders.
  d.exec(`CREATE TABLE IF NOT EXISTS doc_tasks(id TEXT PRIMARY KEY,page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,row_id TEXT NOT NULL DEFAULT '',idx INTEGER NOT NULL,text TEXT NOT NULL,checked INTEGER NOT NULL DEFAULT 0,assignee TEXT,due TEXT,workspace_id TEXT NOT NULL,updated_by TEXT,updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS doc_tasks_document ON doc_tasks(page_id,row_id);
    CREATE INDEX IF NOT EXISTS doc_tasks_assignee ON doc_tasks(workspace_id,assignee,checked);
    CREATE INDEX IF NOT EXISTS doc_tasks_due ON doc_tasks(due,checked);
    CREATE TABLE IF NOT EXISTS task_reminders(user_id TEXT NOT NULL,page_id TEXT NOT NULL,text TEXT NOT NULL,due TEXT NOT NULL,PRIMARY KEY(user_id,page_id,text,due));`);
  // Emoji reactions on page and record comments.
  d.exec(`CREATE TABLE IF NOT EXISTS comment_reactions(comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,emoji TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(comment_id,user_id,emoji));`);
  // Synced blocks: document pages outside the page tree, embedded elsewhere.
  if (!(d.prepare("PRAGMA table_info(pages)").all() as { name: string }[]).some((c) => c.name === "synced"))
    d.exec("ALTER TABLE pages ADD COLUMN synced INTEGER NOT NULL DEFAULT 0");
  // Journals: which parts the bar above a day shows (place, appointments).
  if (!(d.prepare("PRAGMA table_info(journal_settings)").all() as { name: string }[]).some((c) => c.name === "options"))
    d.exec("ALTER TABLE journal_settings ADD COLUMN options TEXT NOT NULL DEFAULT '{}'");
  // Sign-in without an identity provider: e-mail and password, passkeys.
  d.exec(`CREATE TABLE IF NOT EXISTS local_accounts(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,email TEXT NOT NULL UNIQUE COLLATE NOCASE,password_hash TEXT NOT NULL,is_admin INTEGER NOT NULL DEFAULT 0,email_verified INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS passkeys(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,public_key BLOB NOT NULL,counter INTEGER NOT NULL DEFAULT 0,transports TEXT NOT NULL DEFAULT '[]',name TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,last_used_at INTEGER);
    CREATE INDEX IF NOT EXISTS passkeys_user ON passkeys(user_id);
    CREATE TABLE IF NOT EXISTS auth_challenges(id TEXT PRIMARY KEY,challenge TEXT NOT NULL,user_id TEXT,kind TEXT NOT NULL,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS login_failures(key TEXT NOT NULL,at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS login_failures_key ON login_failures(key,at);
    CREATE TABLE IF NOT EXISTS auth_tokens(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,kind TEXT NOT NULL,expires INTEGER NOT NULL);`);
  // Accounts registered while the instance sends e-mail confirm their
  // address before the first sign-in (older accounts are not affected).
  if (!(d.prepare("PRAGMA table_info(local_accounts)").all() as { name: string }[]).some((c) => c.name === "verify_required"))
    d.exec("ALTER TABLE local_accounts ADD COLUMN verify_required INTEGER NOT NULL DEFAULT 0");
  // The apps for iPhone, iPad and Android: one entry per installation and
  // account, bound to the sign-in session (signing out removes it). Its token
  // only reads the widget summary; push goes through push_subscriptions with
  // an "expo:" endpoint (lib/mobile-devices.ts).
  d.exec(`CREATE TABLE IF NOT EXISTS mobile_devices(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,installation_id TEXT NOT NULL,session_token TEXT NOT NULL REFERENCES sessions(token) ON DELETE CASCADE,platform TEXT NOT NULL,name TEXT NOT NULL DEFAULT '',app_version TEXT NOT NULL DEFAULT '',token_hash TEXT NOT NULL UNIQUE,push_subscription_id TEXT REFERENCES push_subscriptions(id) ON DELETE SET NULL,created_at INTEGER NOT NULL,last_seen_at INTEGER NOT NULL,UNIQUE(user_id,installation_id));`);
  // The device keys of the desktop and mobile apps (lib/app-devices.ts): a
  // password sign-in in the app lasts as long as the app's only with the key
  // its device registered at the first one (only the hash is kept).
  d.exec(`CREATE TABLE IF NOT EXISTS app_devices(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,device_id TEXT NOT NULL,secret_hash BLOB NOT NULL,created_at INTEGER NOT NULL,last_used_at INTEGER NOT NULL,PRIMARY KEY(user_id,device_id));`);
  // AI (lib/ai): settings of the instance and of each person, who may use
  // it, what the AI may read. API keys only sealed (lib/ai/secrets.ts).
  d.exec(`CREATE TABLE IF NOT EXISTS ai_instance(id INTEGER PRIMARY KEY CHECK(id=1),config TEXT NOT NULL DEFAULT '{}',key_cipher TEXT,key_hint TEXT NOT NULL DEFAULT '',updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS ai_user_settings(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,config TEXT NOT NULL DEFAULT '{}',key_cipher TEXT,key_hint TEXT NOT NULL DEFAULT '',updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS ai_user_policy(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,allowed INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS ai_access_rules(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,target_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('workspace','space','page')),workspace_id TEXT NOT NULL,mode TEXT NOT NULL CHECK(mode IN ('include','exclude')),PRIMARY KEY(user_id,target_id));
    CREATE TABLE IF NOT EXISTS ai_blocks(target_id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('space','page')),workspace_id TEXT NOT NULL,created_by TEXT,created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS ai_blocks_workspace ON ai_blocks(workspace_id);`);
  // Semantic search (lib/ai/semantic.ts): one vector per text chunk of a
  // page or record, made with the instance's embedding model. Only the hash
  // of the chunk is kept, never its text; changed pages and records are
  // marked like for the full-text index and embedded in the background.
  d.exec(`CREATE TABLE IF NOT EXISTS ai_embeddings(page_id TEXT NOT NULL,row_id TEXT NOT NULL DEFAULT '',chunk INTEGER NOT NULL,workspace_id TEXT NOT NULL,hash TEXT NOT NULL,model TEXT NOT NULL,vector BLOB NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(page_id,row_id,chunk));
    CREATE INDEX IF NOT EXISTS ai_embeddings_workspace ON ai_embeddings(workspace_id);
    CREATE TABLE IF NOT EXISTS ai_embed_dirty(page_id TEXT NOT NULL,row_id TEXT NOT NULL DEFAULT '',PRIMARY KEY(page_id,row_id));
    CREATE TABLE IF NOT EXISTS ai_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS ai_embed_page_update AFTER UPDATE OF title,deleted_at,parent_id,space_id ON pages BEGIN INSERT INTO ai_embed_dirty SELECT NEW.id,'' WHERE NOT EXISTS(SELECT 1 FROM ai_embed_dirty WHERE page_id=NEW.id AND row_id=''); END;
    CREATE TRIGGER IF NOT EXISTS ai_embed_page_delete AFTER DELETE ON pages BEGIN INSERT INTO ai_embed_dirty SELECT OLD.id,'' WHERE NOT EXISTS(SELECT 1 FROM ai_embed_dirty WHERE page_id=OLD.id AND row_id=''); END;
    CREATE TRIGGER IF NOT EXISTS ai_embed_document_insert AFTER INSERT ON documents BEGIN INSERT INTO ai_embed_dirty SELECT NEW.page_id,'' WHERE NOT EXISTS(SELECT 1 FROM ai_embed_dirty WHERE page_id=NEW.page_id AND row_id=''); END;
    CREATE TRIGGER IF NOT EXISTS ai_embed_document_update AFTER UPDATE OF html ON documents BEGIN INSERT INTO ai_embed_dirty SELECT NEW.page_id,'' WHERE NOT EXISTS(SELECT 1 FROM ai_embed_dirty WHERE page_id=NEW.page_id AND row_id=''); END;
    CREATE TRIGGER IF NOT EXISTS ai_embed_row_insert AFTER INSERT ON rows BEGIN INSERT INTO ai_embed_dirty SELECT NEW.page_id,NEW.id WHERE NOT EXISTS(SELECT 1 FROM ai_embed_dirty WHERE page_id=NEW.page_id AND row_id=NEW.id); END;
    CREATE TRIGGER IF NOT EXISTS ai_embed_row_update AFTER UPDATE OF cells,content,page_id ON rows BEGIN INSERT INTO ai_embed_dirty SELECT OLD.page_id,OLD.id WHERE NOT EXISTS(SELECT 1 FROM ai_embed_dirty WHERE page_id=OLD.page_id AND row_id=OLD.id); INSERT INTO ai_embed_dirty SELECT NEW.page_id,NEW.id WHERE NOT EXISTS(SELECT 1 FROM ai_embed_dirty WHERE page_id=NEW.page_id AND row_id=NEW.id); END;
    CREATE TRIGGER IF NOT EXISTS ai_embed_row_delete AFTER DELETE ON rows BEGIN INSERT INTO ai_embed_dirty SELECT OLD.page_id,OLD.id WHERE NOT EXISTS(SELECT 1 FROM ai_embed_dirty WHERE page_id=OLD.page_id AND row_id=OLD.id); END;
    CREATE TRIGGER IF NOT EXISTS ai_embed_row_document AFTER UPDATE OF html ON row_documents BEGIN INSERT INTO ai_embed_dirty SELECT r.page_id,r.id FROM rows r WHERE r.id=NEW.row_id AND NOT EXISTS(SELECT 1 FROM ai_embed_dirty d WHERE d.page_id=r.page_id AND d.row_id=r.id); END;
    CREATE TRIGGER IF NOT EXISTS ai_embed_row_document_insert AFTER INSERT ON row_documents BEGIN INSERT INTO ai_embed_dirty SELECT r.page_id,r.id FROM rows r WHERE r.id=NEW.row_id AND NOT EXISTS(SELECT 1 FROM ai_embed_dirty d WHERE d.page_id=r.page_id AND d.row_id=r.id); END;`);
  // AI properties of databases (lib/ai/database.ts): when and with which
  // model a value was computed, the queue of cells to compute (by the person
  // who asked, or who switched on automatic updates) and records whose
  // inputs changed (only in databases with automatic AI properties).
  d.exec(`CREATE TABLE IF NOT EXISTS ai_cell_meta(row_id TEXT NOT NULL REFERENCES rows(id) ON DELETE CASCADE,field_id TEXT NOT NULL,page_id TEXT NOT NULL,model TEXT NOT NULL DEFAULT '',provider TEXT NOT NULL DEFAULT '',computed_at INTEGER NOT NULL,computed_by TEXT,input_hash TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'ok',PRIMARY KEY(row_id,field_id));
    CREATE INDEX IF NOT EXISTS ai_cell_meta_page ON ai_cell_meta(page_id);
    CREATE TABLE IF NOT EXISTS ai_cell_jobs(row_id TEXT NOT NULL REFERENCES rows(id) ON DELETE CASCADE,field_id TEXT NOT NULL,page_id TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,mode TEXT NOT NULL CHECK(mode IN ('compute','fill','auto')),queued_at INTEGER NOT NULL,next_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(row_id,field_id));
    CREATE INDEX IF NOT EXISTS ai_cell_jobs_next ON ai_cell_jobs(next_at);
    CREATE INDEX IF NOT EXISTS ai_cell_jobs_page ON ai_cell_jobs(page_id);
    CREATE TABLE IF NOT EXISTS ai_auto_dirty(row_id TEXT PRIMARY KEY,page_id TEXT NOT NULL,changed_at INTEGER NOT NULL);
    CREATE TRIGGER IF NOT EXISTS ai_auto_row_insert AFTER INSERT ON rows WHEN EXISTS(SELECT 1 FROM databases WHERE page_id=NEW.page_id AND instr(fields,'"auto":true')>0) BEGIN DELETE FROM ai_auto_dirty WHERE row_id=NEW.id; INSERT INTO ai_auto_dirty VALUES(NEW.id,NEW.page_id,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)); END;
    CREATE TRIGGER IF NOT EXISTS ai_auto_row_update AFTER UPDATE OF cells,content ON rows WHEN EXISTS(SELECT 1 FROM databases WHERE page_id=NEW.page_id AND instr(fields,'"auto":true')>0) BEGIN DELETE FROM ai_auto_dirty WHERE row_id=NEW.id; INSERT INTO ai_auto_dirty VALUES(NEW.id,NEW.page_id,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)); END;
    CREATE TRIGGER IF NOT EXISTS ai_auto_row_document AFTER UPDATE OF html ON row_documents WHEN EXISTS(SELECT 1 FROM rows r JOIN databases d ON d.page_id=r.page_id WHERE r.id=NEW.row_id AND instr(d.fields,'"auto":true')>0) BEGIN DELETE FROM ai_auto_dirty WHERE row_id=NEW.row_id; INSERT INTO ai_auto_dirty SELECT r.id,r.page_id,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER) FROM rows r WHERE r.id=NEW.row_id; END;`);
  // SSO groups mapped to workspace membership and workspace groups, and what
  // a mapping granted (target '' = membership, else the group's id), so that
  // memberships added by hand are never removed (lib/sso-mappings.ts).
  d.exec(`CREATE TABLE IF NOT EXISTS sso_mappings(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,sso_group TEXT NOT NULL,role TEXT CHECK(role IS NULL OR role IN ('owner','editor','viewer')),group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS sso_mappings_workspace ON sso_mappings(workspace_id);
    CREATE TABLE IF NOT EXISTS sso_sources(workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,target TEXT NOT NULL,sso_group TEXT NOT NULL,PRIMARY KEY(workspace_id,user_id,target,sso_group));
    CREATE INDEX IF NOT EXISTS sso_sources_user ON sso_sources(user_id);`);
  // Links with their own permissions and publications: optional password
  // (scrypt hash) and end (ms since epoch).
  for (const table of ["share_links", "publications"]) {
    const columns = d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!columns.some((c) => c.name === "password_hash")) d.exec(`ALTER TABLE ${table} ADD COLUMN password_hash TEXT`);
    if (!columns.some((c) => c.name === "expires_at")) d.exec(`ALTER TABLE ${table} ADD COLUMN expires_at INTEGER`);
  }
  // Two-factor sign-in with an authenticator app (lib/two-factor.ts): the
  // secret sealed with lib/secret-box.ts, the last accepted time step (no
  // code twice) and one-time recovery codes, stored as hashes.
  d.exec(`CREATE TABLE IF NOT EXISTS user_totp(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,secret TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 0,last_step INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,enabled_at INTEGER);
    CREATE TABLE IF NOT EXISTS recovery_codes(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,code_hash TEXT NOT NULL,used_at INTEGER,PRIMARY KEY(user_id,code_hash));`);
  // Passkeys sign in on their own; a code from the app after the passkey
  // only when the person turned that on.
  if (!(d.prepare("PRAGMA table_info(user_totp)").all() as { name: string }[]).some((c) => c.name === "after_passkey"))
    d.exec("ALTER TABLE user_totp ADD COLUMN after_passkey INTEGER NOT NULL DEFAULT 0");
  // Who wrote what: the person behind each editor session (Yjs client) of
  // a document, noted as their changes arrive (lib/document-authors.ts).
  d.exec(`CREATE TABLE IF NOT EXISTS document_authors(page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,row_id TEXT NOT NULL DEFAULT '',generation TEXT NOT NULL,client_id INTEGER NOT NULL,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,at INTEGER NOT NULL,PRIMARY KEY(page_id,row_id,client_id));
    CREATE INDEX IF NOT EXISTS document_authors_user ON document_authors(user_id);`);
  // Citations: the workspace's bibliography (CSL-JSON items by citation
  // key) and resolved DOIs (lib/citations-server.ts).
  d.exec(`CREATE TABLE IF NOT EXISTS bibliography(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,key TEXT NOT NULL,item TEXT NOT NULL,created_by TEXT,created_at INTEGER NOT NULL,UNIQUE(workspace_id,key));
    CREATE TABLE IF NOT EXISTS doi_cache(doi TEXT PRIMARY KEY,item TEXT NOT NULL,fetched_at INTEGER NOT NULL);`);
  // Git export of a space, set up by its owner (lib/space-git-export.ts):
  // the access token sealed with lib/secret-box.ts, the last run as JSON.
  // It ends with the owner's role: a new owner, a space in the trash, the
  // owner leaving the workspace or becoming a guest remove the row.
  d.exec(`CREATE TABLE IF NOT EXISTS space_git_exports(space_id TEXT PRIMARY KEY REFERENCES spaces(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,url TEXT NOT NULL,branch TEXT NOT NULL,username TEXT NOT NULL,token TEXT NOT NULL,frequency TEXT NOT NULL CHECK(frequency IN ('daily','weekly')),history INTEGER NOT NULL DEFAULT 0,last_run TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS space_git_exports_user ON space_git_exports(user_id);
    CREATE TRIGGER IF NOT EXISTS space_git_owner AFTER UPDATE OF owner_id ON spaces WHEN OLD.owner_id IS NOT NEW.owner_id BEGIN DELETE FROM space_git_exports WHERE space_id=NEW.id; END;
    CREATE TRIGGER IF NOT EXISTS space_git_trash AFTER UPDATE OF deleted_at ON spaces WHEN NEW.deleted_at IS NOT NULL BEGIN DELETE FROM space_git_exports WHERE space_id=NEW.id; END;
    CREATE TRIGGER IF NOT EXISTS space_git_member AFTER DELETE ON members BEGIN DELETE FROM space_git_exports WHERE user_id=OLD.user_id AND space_id IN (SELECT id FROM spaces WHERE workspace_id=OLD.workspace_id); END;
    CREATE TRIGGER IF NOT EXISTS space_git_guest AFTER INSERT ON workspace_guests BEGIN DELETE FROM space_git_exports WHERE user_id=NEW.user_id AND space_id IN (SELECT id FROM spaces WHERE workspace_id=NEW.workspace_id); END;`);
  // Daily byte budgets of anonymous visitors (lib/anonymous-budget.ts).
  d.exec(`CREATE TABLE IF NOT EXISTS anonymous_uploads(scope TEXT NOT NULL,bytes INTEGER NOT NULL,at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS anonymous_uploads_scope ON anonymous_uploads(scope,at);`);
  // Page owners and review dates (lib/page-review.ts): who looks after a
  // page, when it is due for a review, how often, and which due date was
  // already announced to the owner. Repeating records (lib/repeat-records.ts):
  // the rule that creates the next record once this one is done.
  {
    const columns = (d.prepare("PRAGMA table_info(pages)").all() as { name: string }[]).map((c) => c.name);
    if (!columns.includes("owner_id")) d.exec("ALTER TABLE pages ADD COLUMN owner_id TEXT");
    if (!columns.includes("review_at")) d.exec("ALTER TABLE pages ADD COLUMN review_at TEXT");
    if (!columns.includes("review_every_days")) d.exec("ALTER TABLE pages ADD COLUMN review_every_days INTEGER");
    if (!columns.includes("review_notified")) d.exec("ALTER TABLE pages ADD COLUMN review_notified TEXT");
    if (!(d.prepare("PRAGMA table_info(rows)").all() as { name: string }[]).some((c) => c.name === "repeat"))
      d.exec("ALTER TABLE rows ADD COLUMN repeat TEXT NOT NULL DEFAULT ''");
    d.exec("CREATE INDEX IF NOT EXISTS pages_review ON pages(review_at) WHERE review_at IS NOT NULL");
  }
  // Dashboard pages: their tiles as JSON (lib/dashboard-schema.ts).
  d.exec(`CREATE TABLE IF NOT EXISTS dashboards(page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,tiles TEXT NOT NULL DEFAULT '[]',updated_at TEXT DEFAULT CURRENT_TIMESTAMP);`);
  // Form answers saved to continue later, per signed-in person (lib/forms.ts).
  d.exec(`CREATE TABLE IF NOT EXISTS form_drafts(page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,cells TEXT NOT NULL,page INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL,PRIMARY KEY(page_id,user_id));
    CREATE INDEX IF NOT EXISTS form_drafts_user ON form_drafts(user_id);`);
  // E-mail inbound capture (lib/inbound-mail.ts): addresses with their
  // target and allowed senders, the Message-IDs already stored, and the
  // deliveries of the last hour for the rate limit.
  d.exec(`CREATE TABLE IF NOT EXISTS inbound_addresses(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,label TEXT NOT NULL DEFAULT '',token TEXT UNIQUE NOT NULL,secret TEXT NOT NULL DEFAULT '',senders TEXT NOT NULL DEFAULT '[]',created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,created_at INTEGER NOT NULL,last_received_at INTEGER,last_error TEXT,received INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS inbound_addresses_workspace ON inbound_addresses(workspace_id);
    CREATE TABLE IF NOT EXISTS inbound_messages(address_id TEXT NOT NULL REFERENCES inbound_addresses(id) ON DELETE CASCADE,message_id TEXT NOT NULL,page_id TEXT,row_id TEXT,received_at INTEGER NOT NULL,PRIMARY KEY(address_id,message_id));
    CREATE TABLE IF NOT EXISTS inbound_deliveries(address_id TEXT NOT NULL,at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS inbound_deliveries_address ON inbound_deliveries(address_id,at);`);
  // Chat notifications of webhooks (lib/notification-templates.ts): the
  // format, message templates per event, settings (language, digest time,
  // Matrix room, Slack channel), sealed credentials (Matrix access token,
  // Slack bot token and signing secret), the local day of the last digest,
  // and Slack messages by ts so thread replies become record comments.
  {
    const columns = (d.prepare("PRAGMA table_info(webhooks)").all() as { name: string }[]).map((c) => c.name);
    if (!columns.includes("format")) d.exec("ALTER TABLE webhooks ADD COLUMN format TEXT NOT NULL DEFAULT 'json'");
    if (!columns.includes("templates")) d.exec("ALTER TABLE webhooks ADD COLUMN templates TEXT NOT NULL DEFAULT '{}'");
    if (!columns.includes("config")) d.exec("ALTER TABLE webhooks ADD COLUMN config TEXT NOT NULL DEFAULT '{}'");
    if (!columns.includes("credentials")) d.exec("ALTER TABLE webhooks ADD COLUMN credentials TEXT");
    if (!columns.includes("digest_day")) d.exec("ALTER TABLE webhooks ADD COLUMN digest_day TEXT");
    d.exec(`CREATE TABLE IF NOT EXISTS webhook_messages(webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,ts TEXT NOT NULL,page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,row_id TEXT,created_at INTEGER NOT NULL,PRIMARY KEY(webhook_id,ts));`);
  }
  // GitHub/GitLab/Forgejo issue sync (lib/issue-sync.ts): connections of a
  // workspace (token and webhook secret sealed with lib/secret-box.ts), the
  // database ↔ repository mapping, one link per record and issue, pulled or
  // pushed comments and records waiting for a push.
  d.exec(`CREATE TABLE IF NOT EXISTS issue_connections(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,provider TEXT NOT NULL CHECK(provider IN ('github','gitlab','forgejo')),base_url TEXT NOT NULL DEFAULT '',repo TEXT NOT NULL DEFAULT '',token TEXT NOT NULL,hook_token TEXT NOT NULL UNIQUE,hook_secret TEXT NOT NULL,people TEXT NOT NULL DEFAULT '[]',state TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS issue_connections_workspace ON issue_connections(workspace_id);
    CREATE TABLE IF NOT EXISTS issue_sync_maps(page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,connection_id TEXT NOT NULL REFERENCES issue_connections(id) ON DELETE CASCADE,repo TEXT NOT NULL,config TEXT NOT NULL,state TEXT NOT NULL DEFAULT '{}',created_by TEXT,created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS issue_sync_maps_connection ON issue_sync_maps(connection_id);
    CREATE TABLE IF NOT EXISTS issue_links(id TEXT PRIMARY KEY,page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,row_id TEXT NOT NULL UNIQUE,provider TEXT NOT NULL,repo TEXT NOT NULL,issue_id TEXT NOT NULL,number INTEGER NOT NULL,url TEXT NOT NULL,remote TEXT NOT NULL DEFAULT '{}',local_hash TEXT NOT NULL DEFAULT '',remote_updated INTEGER NOT NULL DEFAULT 0,synced_at INTEGER NOT NULL,UNIQUE(provider,repo,issue_id));
    CREATE INDEX IF NOT EXISTS issue_links_page ON issue_links(page_id);
    CREATE TABLE IF NOT EXISTS issue_comment_links(comment_id TEXT PRIMARY KEY,page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,provider TEXT NOT NULL,repo TEXT NOT NULL,remote_id TEXT NOT NULL,UNIQUE(provider,repo,remote_id));
    CREATE TABLE IF NOT EXISTS issue_sync_queue(row_id TEXT PRIMARY KEY,page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,at INTEGER NOT NULL);`);
  migrateIssueProviders(d);
  // Aliases of pages (lib/aliases.ts): a JSON array of other names, kept in
  // the search index next to the title.
  if (!(d.prepare("PRAGMA table_info(pages)").all() as { name: string }[]).some((c) => c.name === "aliases"))
    d.exec("ALTER TABLE pages ADD COLUMN aliases TEXT");
  d.exec(
    "CREATE TRIGGER IF NOT EXISTS search_page_aliases AFTER UPDATE OF aliases ON pages BEGIN INSERT INTO search_dirty SELECT NEW.id,'' WHERE NOT EXISTS(SELECT 1 FROM search_dirty WHERE page_id=NEW.id AND row_id=''); END;",
  );
  // Weekly digest e-mail (lib/weekly-digest.ts): opt-in, AI summary opt-in,
  // the person's time zone and the local Monday last sent.
  d.exec(`CREATE TABLE IF NOT EXISTS weekly_digests(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,enabled INTEGER NOT NULL DEFAULT 0,ai_summary INTEGER NOT NULL DEFAULT 0,time_zone TEXT NOT NULL DEFAULT 'UTC',last_week TEXT,updated_at INTEGER NOT NULL);`);
  // Directory provisioning (lib/scim.ts, lib/ldap-auth.ts): SCIM bearer
  // tokens (hashes only), provisioned users and groups with their members,
  // the last SCIM requests, LDAP-linked accounts with their directory groups,
  // and status values such as the last LDAP sync.
  d.exec(`CREATE TABLE IF NOT EXISTS scim_tokens(id TEXT PRIMARY KEY,name TEXT NOT NULL,scope TEXT NOT NULL DEFAULT 'scim',token_hash TEXT UNIQUE NOT NULL,prefix TEXT NOT NULL,created_by TEXT,created_at INTEGER NOT NULL,last_used_at INTEGER);
    CREATE TABLE IF NOT EXISTS scim_users(id TEXT PRIMARY KEY,user_id TEXT UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,user_name TEXT NOT NULL COLLATE NOCASE UNIQUE,external_id TEXT,given_name TEXT,family_name TEXT,display_name TEXT,version INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS scim_groups(id TEXT PRIMARY KEY,display_name TEXT NOT NULL COLLATE NOCASE UNIQUE,external_id TEXT,version INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS scim_group_members(group_id TEXT NOT NULL REFERENCES scim_groups(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,PRIMARY KEY(group_id,user_id));
    CREATE INDEX IF NOT EXISTS scim_group_members_user ON scim_group_members(user_id);
    CREATE TABLE IF NOT EXISTS scim_requests(id INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER NOT NULL,method TEXT NOT NULL,path TEXT NOT NULL,status INTEGER NOT NULL,token_id TEXT,detail TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS ldap_accounts(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,dn TEXT NOT NULL COLLATE NOCASE UNIQUE,username TEXT NOT NULL DEFAULT '',groups_json TEXT NOT NULL DEFAULT '[]',is_admin INTEGER NOT NULL DEFAULT 0,locked INTEGER NOT NULL DEFAULT 0,synced_at INTEGER,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS directory_status(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL);`);
  // Two-way sync with Google Calendar and Microsoft 365 (lib/calendar-sync.ts):
  // OAuth connections per person (sealed refresh token), sign-in flows in
  // progress, calendar ↔ database view mappings with their sync token or
  // delta link, and the event behind each synced record. Meeting notes
  // created from an appointment of a journal day (lib/meeting-notes.ts).
  d.exec(`CREATE TABLE IF NOT EXISTS calendar_connections(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,provider TEXT NOT NULL,account TEXT NOT NULL DEFAULT '',refresh_token TEXT NOT NULL,access_token TEXT,access_expires INTEGER NOT NULL DEFAULT 0,last_error TEXT,created_at INTEGER NOT NULL,UNIQUE(user_id,provider,account));
    CREATE TABLE IF NOT EXISTS calendar_oauth_flows(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,provider TEXT NOT NULL,state TEXT NOT NULL,verifier TEXT NOT NULL,nonce TEXT NOT NULL,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS calendar_sync_mappings(id TEXT PRIMARY KEY,connection_id TEXT NOT NULL REFERENCES calendar_connections(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,view_id TEXT NOT NULL,calendar_id TEXT NOT NULL,calendar_name TEXT NOT NULL DEFAULT '',sync_token TEXT,last_sync_at INTEGER,last_error TEXT,failures INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,UNIQUE(user_id,page_id,view_id),UNIQUE(connection_id,calendar_id));
    CREATE INDEX IF NOT EXISTS calendar_sync_mappings_due ON calendar_sync_mappings(next_at);
    CREATE TABLE IF NOT EXISTS calendar_sync_items(mapping_id TEXT NOT NULL REFERENCES calendar_sync_mappings(id) ON DELETE CASCADE,row_id TEXT NOT NULL,event_id TEXT NOT NULL,hash TEXT NOT NULL,attendees TEXT NOT NULL DEFAULT '[]',synced_at INTEGER NOT NULL,PRIMARY KEY(mapping_id,row_id),UNIQUE(mapping_id,event_id));
    CREATE INDEX IF NOT EXISTS calendar_sync_items_row ON calendar_sync_items(row_id);
    CREATE TABLE IF NOT EXISTS meeting_notes(journal_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,event_key TEXT NOT NULL,page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,created_by TEXT,created_at INTEGER NOT NULL,PRIMARY KEY(journal_id,event_key));`);
  {
    // Columns added after the first version of these tables.
    const columns = (d.prepare("PRAGMA table_info(calendar_sync_items)").all() as { name: string }[]).map((c) => c.name);
    if (!columns.includes("attendees")) d.exec("ALTER TABLE calendar_sync_items ADD COLUMN attendees TEXT NOT NULL DEFAULT '[]'");
  }
  // Time reports (lib/time-reports.ts): the billing status of each entry
  // (open, billed, unbillable), who billed it and when, hourly rates per
  // person or project of a workspace and the workspace's currency.
  {
    const columns = (d.prepare("PRAGMA table_info(time_entries)").all() as { name: string }[]).map((c) => c.name);
    if (!columns.includes("billing")) d.exec("ALTER TABLE time_entries ADD COLUMN billing TEXT NOT NULL DEFAULT 'open'");
    if (!columns.includes("billed_at")) d.exec("ALTER TABLE time_entries ADD COLUMN billed_at INTEGER");
    if (!columns.includes("billed_by")) d.exec("ALTER TABLE time_entries ADD COLUMN billed_by TEXT");
    d.exec(`CREATE INDEX IF NOT EXISTS time_entries_user ON time_entries(user_id,start);
      CREATE TABLE IF NOT EXISTS time_rates(workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,kind TEXT NOT NULL CHECK(kind IN ('person','project')),target_id TEXT NOT NULL,rate REAL NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(workspace_id,kind,target_id));
      CREATE TABLE IF NOT EXISTS time_billing(workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,currency TEXT NOT NULL DEFAULT 'EUR');`);
  }
  // Operations dashboard (lib/admin-ops.ts): refused requests by kind (swept
  // daily), the last run of background workers and the health alerts already
  // sent per event and day.
  d.exec(`CREATE TABLE IF NOT EXISTS ops_events(kind TEXT NOT NULL,at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS ops_events_kind ON ops_events(kind,at);
    CREATE TABLE IF NOT EXISTS ops_workers(name TEXT PRIMARY KEY,last_run INTEGER NOT NULL,last_error TEXT,error_at INTEGER);
    CREATE TABLE IF NOT EXISTS ops_alerts(event TEXT NOT NULL,day TEXT NOT NULL,sent_at INTEGER NOT NULL,status INTEGER,error TEXT,PRIMARY KEY(event,day));`);
  // Offline copies (lib/offline-changes.ts): when a page's content, a
  // record or its document last changed, so devices refresh only those.
  // Row '' stands for the page itself; offline_log notes when the log began.
  d.exec(`CREATE TABLE IF NOT EXISTS offline_changes(page_id TEXT NOT NULL,row_id TEXT NOT NULL DEFAULT '',at INTEGER NOT NULL,PRIMARY KEY(page_id,row_id));
    CREATE INDEX IF NOT EXISTS offline_changes_at ON offline_changes(at);
    CREATE TABLE IF NOT EXISTS offline_log(id INTEGER PRIMARY KEY CHECK(id=1),started INTEGER NOT NULL);
    INSERT OR IGNORE INTO offline_log VALUES(1,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER));
    CREATE TRIGGER IF NOT EXISTS offline_page_insert AFTER INSERT ON pages BEGIN DELETE FROM offline_changes WHERE page_id=NEW.id AND row_id=''; INSERT INTO offline_changes VALUES(NEW.id,'',CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)); END;
    CREATE TRIGGER IF NOT EXISTS offline_page_update AFTER UPDATE ON pages BEGIN DELETE FROM offline_changes WHERE page_id=NEW.id AND row_id=''; INSERT INTO offline_changes VALUES(NEW.id,'',CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)); END;
    CREATE TRIGGER IF NOT EXISTS offline_page_delete AFTER DELETE ON pages BEGIN DELETE FROM offline_changes WHERE page_id=OLD.id; END;
    CREATE TRIGGER IF NOT EXISTS offline_document_insert AFTER INSERT ON documents BEGIN DELETE FROM offline_changes WHERE page_id=NEW.page_id AND row_id=''; INSERT INTO offline_changes VALUES(NEW.page_id,'',CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)); END;
    CREATE TRIGGER IF NOT EXISTS offline_document_update AFTER UPDATE OF state,html ON documents BEGIN DELETE FROM offline_changes WHERE page_id=NEW.page_id AND row_id=''; INSERT INTO offline_changes VALUES(NEW.page_id,'',CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)); END;
    CREATE TRIGGER IF NOT EXISTS offline_database_update AFTER UPDATE ON databases BEGIN DELETE FROM offline_changes WHERE page_id=NEW.page_id AND row_id=''; INSERT INTO offline_changes VALUES(NEW.page_id,'',CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)); END;
    CREATE TRIGGER IF NOT EXISTS offline_dashboard_update AFTER UPDATE ON dashboards BEGIN DELETE FROM offline_changes WHERE page_id=NEW.page_id AND row_id=''; INSERT INTO offline_changes VALUES(NEW.page_id,'',CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)); END;
    CREATE TRIGGER IF NOT EXISTS offline_row_insert AFTER INSERT ON rows BEGIN DELETE FROM offline_changes WHERE page_id=NEW.page_id AND row_id=NEW.id; INSERT INTO offline_changes VALUES(NEW.page_id,NEW.id,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)); END;
    CREATE TRIGGER IF NOT EXISTS offline_row_update AFTER UPDATE ON rows BEGIN DELETE FROM offline_changes WHERE page_id=NEW.page_id AND row_id=NEW.id; INSERT INTO offline_changes VALUES(NEW.page_id,NEW.id,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)); END;
    CREATE TRIGGER IF NOT EXISTS offline_row_move AFTER UPDATE OF page_id ON rows WHEN OLD.page_id IS NOT NEW.page_id BEGIN DELETE FROM offline_changes WHERE page_id=OLD.page_id AND row_id=OLD.id; DELETE FROM offline_changes WHERE page_id=OLD.page_id AND row_id=''; INSERT INTO offline_changes VALUES(OLD.page_id,'',CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)); END;
    CREATE TRIGGER IF NOT EXISTS offline_row_delete AFTER DELETE ON rows BEGIN DELETE FROM offline_changes WHERE page_id=OLD.page_id AND row_id=OLD.id; DELETE FROM offline_changes WHERE page_id=OLD.page_id AND row_id=''; INSERT INTO offline_changes VALUES(OLD.page_id,'',CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)); END;
    CREATE TRIGGER IF NOT EXISTS offline_row_document_insert AFTER INSERT ON row_documents BEGIN DELETE FROM offline_changes WHERE page_id=(SELECT page_id FROM rows WHERE id=NEW.row_id) AND row_id=NEW.row_id; INSERT INTO offline_changes SELECT r.page_id,r.id,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER) FROM rows r WHERE r.id=NEW.row_id; END;
    CREATE TRIGGER IF NOT EXISTS offline_row_document_update AFTER UPDATE OF state,html ON row_documents BEGIN DELETE FROM offline_changes WHERE page_id=(SELECT page_id FROM rows WHERE id=NEW.row_id) AND row_id=NEW.row_id; INSERT INTO offline_changes SELECT r.page_id,r.id,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER) FROM rows r WHERE r.id=NEW.row_id; END;
    CREATE TRIGGER IF NOT EXISTS offline_file_insert AFTER INSERT ON files WHEN NEW.page_id IS NOT NULL BEGIN DELETE FROM offline_changes WHERE page_id=NEW.page_id AND row_id=''; INSERT INTO offline_changes VALUES(NEW.page_id,'',CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)); END;
    CREATE TRIGGER IF NOT EXISTS offline_file_delete AFTER DELETE ON files WHEN OLD.page_id IS NOT NULL BEGIN DELETE FROM offline_changes WHERE page_id=OLD.page_id AND row_id=''; INSERT INTO offline_changes VALUES(OLD.page_id,'',CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)); END;
    CREATE TRIGGER IF NOT EXISTS offline_comment_insert AFTER INSERT ON comments BEGIN DELETE FROM offline_changes WHERE page_id=NEW.page_id AND row_id=''; INSERT INTO offline_changes VALUES(NEW.page_id,'',CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)); END;
    CREATE TRIGGER IF NOT EXISTS offline_comment_update AFTER UPDATE ON comments BEGIN DELETE FROM offline_changes WHERE page_id=NEW.page_id AND row_id=''; INSERT INTO offline_changes VALUES(NEW.page_id,'',CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)); END;
    CREATE TRIGGER IF NOT EXISTS offline_comment_delete AFTER DELETE ON comments BEGIN DELETE FROM offline_changes WHERE page_id=OLD.page_id AND row_id=''; INSERT INTO offline_changes VALUES(OLD.page_id,'',CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)); END;`);
  // Own keyboard shortcuts per person (lib/user-shortcuts.ts): the actions
  // that differ from the defaults, as JSON.
  d.exec(`CREATE TABLE IF NOT EXISTS user_shortcuts(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,bindings TEXT NOT NULL DEFAULT '{}',updated_at INTEGER NOT NULL);`);
  // Block extensions (lib/plugins.ts): registered per workspace with their
  // manifest, the permissions an owner granted and whether published pages
  // may show them. Custom domains for publications (lib/custom-domains.ts)
  // with their verification token, and the look of a publication.
  d.exec(`CREATE TABLE IF NOT EXISTS plugins(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,url TEXT NOT NULL,origin TEXT NOT NULL,manifest TEXT NOT NULL,permissions TEXT NOT NULL DEFAULT '[]',settings TEXT NOT NULL DEFAULT '{}',enabled INTEGER NOT NULL DEFAULT 1,public INTEGER NOT NULL DEFAULT 0,created_by TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(workspace_id,url));
    CREATE INDEX IF NOT EXISTS plugins_origin ON plugins(origin);
    CREATE TABLE IF NOT EXISTS custom_domains(host TEXT PRIMARY KEY,page_id TEXT NOT NULL UNIQUE REFERENCES pages(id) ON DELETE CASCADE,token TEXT NOT NULL,verified_at INTEGER,checked_at INTEGER,last_error TEXT,created_by TEXT,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS publication_themes(page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,theme TEXT NOT NULL DEFAULT '{}',updated_at INTEGER NOT NULL);`);
  // End-to-end encrypted spaces (lib/e2ee-server.ts, docs/e2ee-design.md):
  // per person a key pair whose private key is wrapped by passphrase and
  // recovery key (opaque blobs), per space and key version the space key
  // sealed for each member, and documents as an append-only log of
  // encrypted Yjs updates plus one encrypted snapshot.
  {
    const spaces = (d.prepare("PRAGMA table_info(spaces)").all() as { name: string }[]).map((c) => c.name);
    if (!spaces.includes("encrypted")) d.exec("ALTER TABLE spaces ADD COLUMN encrypted INTEGER NOT NULL DEFAULT 0");
    if (!spaces.includes("key_version")) d.exec("ALTER TABLE spaces ADD COLUMN key_version INTEGER NOT NULL DEFAULT 0");
    if (!spaces.includes("encrypt_titles")) d.exec("ALTER TABLE spaces ADD COLUMN encrypt_titles INTEGER NOT NULL DEFAULT 0");
    if (!spaces.includes("rotate_pending")) d.exec("ALTER TABLE spaces ADD COLUMN rotate_pending INTEGER NOT NULL DEFAULT 0");
    if (!(d.prepare("PRAGMA table_info(pages)").all() as { name: string }[]).some((c) => c.name === "title_cipher"))
      d.exec("ALTER TABLE pages ADD COLUMN title_cipher TEXT");
  }
  // The triggers are the last line of defence: whatever code path tries to
  // store plaintext for a page of an encrypted space, the write fails.
  d.exec(`CREATE TABLE IF NOT EXISTS e2ee_identities(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,public_key TEXT NOT NULL,wrapped_private TEXT NOT NULL,recovery_wrapped TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS e2ee_space_keys(space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,key_version INTEGER NOT NULL,sealed TEXT NOT NULL,sealed_by TEXT,created_at INTEGER NOT NULL,PRIMARY KEY(space_id,user_id,key_version));
    CREATE INDEX IF NOT EXISTS e2ee_space_keys_user ON e2ee_space_keys(user_id);
    CREATE TABLE IF NOT EXISTS e2ee_updates(seq INTEGER PRIMARY KEY AUTOINCREMENT,page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,key_version INTEGER NOT NULL,data BLOB NOT NULL,created_by TEXT,created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS e2ee_updates_page ON e2ee_updates(page_id,seq);
    CREATE TABLE IF NOT EXISTS e2ee_snapshots(page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,upto INTEGER NOT NULL,key_version INTEGER NOT NULL,data BLOB NOT NULL,created_by TEXT,created_at INTEGER NOT NULL);
    CREATE TRIGGER IF NOT EXISTS e2ee_documents_insert BEFORE INSERT ON documents WHEN (COALESCE(NEW.html,'')!='' OR NEW.state IS NOT NULL) AND EXISTS(SELECT 1 FROM pages p JOIN spaces s ON s.id=p.space_id WHERE p.id=NEW.page_id AND s.encrypted=1) BEGIN SELECT RAISE(ABORT,'e2ee: plaintext refused'); END;
    CREATE TRIGGER IF NOT EXISTS e2ee_documents_update BEFORE UPDATE OF html,state ON documents WHEN (COALESCE(NEW.html,'')!='' OR NEW.state IS NOT NULL) AND EXISTS(SELECT 1 FROM pages p JOIN spaces s ON s.id=p.space_id WHERE p.id=NEW.page_id AND s.encrypted=1) BEGIN SELECT RAISE(ABORT,'e2ee: plaintext refused'); END;
    CREATE TRIGGER IF NOT EXISTS e2ee_snapshots_insert BEFORE INSERT ON snapshots WHEN (COALESCE(NEW.html,'')!='' OR NEW.state IS NOT NULL) AND EXISTS(SELECT 1 FROM pages p JOIN spaces s ON s.id=p.space_id WHERE p.id=NEW.page_id AND s.encrypted=1) BEGIN SELECT RAISE(ABORT,'e2ee: plaintext refused'); END;
    CREATE TRIGGER IF NOT EXISTS e2ee_comments_insert BEFORE INSERT ON comments WHEN EXISTS(SELECT 1 FROM pages p JOIN spaces s ON s.id=p.space_id WHERE p.id=NEW.page_id AND s.encrypted=1) BEGIN SELECT RAISE(ABORT,'e2ee: plaintext refused'); END;
    CREATE TRIGGER IF NOT EXISTS e2ee_threads_insert BEFORE INSERT ON inline_threads WHEN EXISTS(SELECT 1 FROM pages p JOIN spaces s ON s.id=p.space_id WHERE p.id=NEW.page_id AND s.encrypted=1) BEGIN SELECT RAISE(ABORT,'e2ee: plaintext refused'); END;
    CREATE TRIGGER IF NOT EXISTS e2ee_rows_insert BEFORE INSERT ON rows WHEN EXISTS(SELECT 1 FROM pages p JOIN spaces s ON s.id=p.space_id WHERE p.id=NEW.page_id AND s.encrypted=1) BEGIN SELECT RAISE(ABORT,'e2ee: plaintext refused'); END;
    CREATE TRIGGER IF NOT EXISTS e2ee_share_links_insert BEFORE INSERT ON share_links WHEN EXISTS(SELECT 1 FROM pages p JOIN spaces s ON s.id=p.space_id WHERE p.id=NEW.root_id AND s.encrypted=1) BEGIN SELECT RAISE(ABORT,'e2ee: plaintext refused'); END;
    CREATE TRIGGER IF NOT EXISTS e2ee_publications_insert BEFORE INSERT ON publications WHEN EXISTS(SELECT 1 FROM pages p JOIN spaces s ON s.id=p.space_id WHERE p.id=NEW.page_id AND s.encrypted=1) BEGIN SELECT RAISE(ABORT,'e2ee: plaintext refused'); END;
    CREATE TRIGGER IF NOT EXISTS e2ee_page_public BEFORE UPDATE OF public_token ON pages WHEN NEW.public_token IS NOT NULL AND EXISTS(SELECT 1 FROM spaces s WHERE s.id=NEW.space_id AND s.encrypted=1) BEGIN SELECT RAISE(ABORT,'e2ee: plaintext refused'); END;
    CREATE TRIGGER IF NOT EXISTS e2ee_page_move BEFORE UPDATE OF space_id ON pages WHEN NEW.space_id IS NOT OLD.space_id AND (COALESCE((SELECT encrypted FROM spaces WHERE id=OLD.space_id),0)=1 OR COALESCE((SELECT encrypted FROM spaces WHERE id=NEW.space_id),0)=1) BEGIN SELECT RAISE(ABORT,'e2ee: plaintext refused'); END;
    CREATE TRIGGER IF NOT EXISTS e2ee_page_kind BEFORE INSERT ON pages WHEN NEW.kind!='document' AND EXISTS(SELECT 1 FROM spaces s WHERE s.id=NEW.space_id AND s.encrypted=1) BEGIN SELECT RAISE(ABORT,'e2ee: plaintext refused'); END;
    CREATE TRIGGER IF NOT EXISTS e2ee_grant_removed AFTER DELETE ON grants WHEN COALESCE(OLD.user_id,'')!='' AND EXISTS(SELECT 1 FROM spaces WHERE id=OLD.resource_id AND encrypted=1) BEGIN
      DELETE FROM e2ee_space_keys WHERE space_id=OLD.resource_id AND user_id=OLD.user_id;
      UPDATE spaces SET rotate_pending=1 WHERE id=OLD.resource_id;
    END;
    CREATE TRIGGER IF NOT EXISTS e2ee_member_removed AFTER DELETE ON members BEGIN
      UPDATE spaces SET rotate_pending=1 WHERE workspace_id=OLD.workspace_id AND encrypted=1 AND id IN (SELECT space_id FROM e2ee_space_keys WHERE user_id=OLD.user_id);
      DELETE FROM e2ee_space_keys WHERE user_id=OLD.user_id AND space_id IN (SELECT id FROM spaces WHERE workspace_id=OLD.workspace_id);
    END;`);
  // Browser extension tokens (lib/clipper.ts): the scope "clipper" only
  // reaches the clipper endpoints. Older databases get the wider CHECK.
  {
    const table = d.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='api_tokens'").get() as { sql?: string } | undefined;
    if (table?.sql && !table.sql.includes("'clipper'"))
      d.exec(`SAVEPOINT api_token_scopes;
        CREATE TABLE api_tokens_scoped(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,name TEXT NOT NULL,scope TEXT NOT NULL CHECK(scope IN ('read','write','clipper')),token_hash TEXT NOT NULL UNIQUE,prefix TEXT NOT NULL,created_at INTEGER NOT NULL,last_used_at INTEGER,expires_at INTEGER);
        INSERT INTO api_tokens_scoped(id,user_id,name,scope,token_hash,prefix,created_at,last_used_at,expires_at) SELECT id,user_id,name,scope,token_hash,prefix,created_at,last_used_at,expires_at FROM api_tokens;
        DROP TABLE api_tokens;
        ALTER TABLE api_tokens_scoped RENAME TO api_tokens;
        RELEASE api_token_scopes;`);
  }
  // Usage statistics of the instance (lib/metrics.ts): requests, 5xx and
  // latency per minute (kept 48 hours) and per hour with the people active
  // in it (35 days), storage and disk per day, AI tokens per day and feature.
  // Counts only – no addresses, paths or people are stored.
  d.exec(`CREATE TABLE IF NOT EXISTS metrics_minute(at INTEGER PRIMARY KEY,requests INTEGER NOT NULL,errors INTEGER NOT NULL,hist TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS metrics_hour(at INTEGER PRIMARY KEY,requests INTEGER NOT NULL DEFAULT 0,errors INTEGER NOT NULL DEFAULT 0,hist TEXT NOT NULL DEFAULT '',active INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS metrics_day(day TEXT PRIMARY KEY,database_bytes INTEGER NOT NULL,upload_bytes INTEGER NOT NULL,files INTEGER NOT NULL,disk_total INTEGER,disk_free INTEGER,at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS metrics_ai(day TEXT NOT NULL,feature TEXT NOT NULL,requests INTEGER NOT NULL DEFAULT 0,tokens_in INTEGER NOT NULL DEFAULT 0,tokens_out INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(day,feature));`);
  // Comment reactions with a redundant U+FE0F: a data step (lib/data-steps.ts).
  // Ink on PDFs (lib/ink-store.ts, lib/ink/README.md): the markings of a file
  // next to the untouched original, with the text typed on it (search) and
  // every saved state as a version. Never for pages of encrypted spaces.
  d.exec(`CREATE TABLE IF NOT EXISTS file_ink(file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,data TEXT NOT NULL,text TEXT NOT NULL DEFAULT '',version INTEGER NOT NULL,updated_by TEXT,updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS file_ink_versions(file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,version INTEGER NOT NULL,data TEXT NOT NULL,created_by TEXT,created_at INTEGER NOT NULL,PRIMARY KEY(file_id,version));
    CREATE TRIGGER IF NOT EXISTS e2ee_file_ink_insert BEFORE INSERT ON file_ink WHEN EXISTS(SELECT 1 FROM files f JOIN pages p ON p.id=f.page_id JOIN spaces s ON s.id=p.space_id WHERE f.id=NEW.file_id AND s.encrypted=1) BEGIN SELECT RAISE(ABORT,'e2ee: plaintext refused'); END;
    CREATE TRIGGER IF NOT EXISTS e2ee_file_ink_update BEFORE UPDATE ON file_ink WHEN EXISTS(SELECT 1 FROM files f JOIN pages p ON p.id=f.page_id JOIN spaces s ON s.id=p.space_id WHERE f.id=NEW.file_id AND s.encrypted=1) BEGIN SELECT RAISE(ABORT,'e2ee: plaintext refused'); END;
    CREATE TRIGGER IF NOT EXISTS search_file_ink AFTER UPDATE OF text ON file_ink BEGIN INSERT INTO search_dirty SELECT f.page_id,'f:'||f.id FROM files f WHERE f.id=NEW.file_id AND f.page_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM search_dirty WHERE page_id=f.page_id AND row_id='f:'||f.id); END;
    CREATE TRIGGER IF NOT EXISTS search_file_ink_insert AFTER INSERT ON file_ink WHEN NEW.text!='' BEGIN INSERT INTO search_dirty SELECT f.page_id,'f:'||f.id FROM files f WHERE f.id=NEW.file_id AND f.page_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM search_dirty WHERE page_id=f.page_id AND row_id='f:'||f.id); END;`);
  // Notebooks and handwriting (lib/notebook.ts, lib/page-ink-store.ts):
  // - file_ink gains the text recognised in the handwriting on the device
  //   (JSON: PDF page → text), searched like typed text;
  // - notebooks hold the default paper, notebook_sheets the sheets in order
  //   (paper override, imported PDF page as background);
  // - page_ink keeps the ink of a page's surfaces – a notebook sheet or a
  //   drawing block in a document – with every save as a version.
  if (!(d.prepare("PRAGMA table_info(file_ink)").all() as { name: string }[]).some((c) => c.name === "recognized"))
    d.exec("ALTER TABLE file_ink ADD COLUMN recognized TEXT NOT NULL DEFAULT ''");
  d.exec(`DROP TRIGGER IF EXISTS search_file_ink;
    CREATE TRIGGER search_file_ink AFTER UPDATE OF text,recognized ON file_ink BEGIN INSERT INTO search_dirty SELECT f.page_id,'f:'||f.id FROM files f WHERE f.id=NEW.file_id AND f.page_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM search_dirty WHERE page_id=f.page_id AND row_id='f:'||f.id); END;
    CREATE TABLE IF NOT EXISTS notebooks(page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,paper TEXT NOT NULL DEFAULT '{}',updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS notebook_sheets(id TEXT PRIMARY KEY,page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,position INTEGER NOT NULL,paper TEXT NOT NULL DEFAULT '{}',background TEXT,created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS notebook_sheets_page ON notebook_sheets(page_id,position);
    CREATE TABLE IF NOT EXISTS page_ink(page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,surface TEXT NOT NULL,data TEXT NOT NULL,text TEXT NOT NULL DEFAULT '',recognized TEXT NOT NULL DEFAULT '',version INTEGER NOT NULL,updated_by TEXT,updated_at INTEGER NOT NULL,PRIMARY KEY(page_id,surface));
    CREATE TABLE IF NOT EXISTS page_ink_versions(page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,surface TEXT NOT NULL,version INTEGER NOT NULL,data TEXT NOT NULL,created_by TEXT,created_at INTEGER NOT NULL,PRIMARY KEY(page_id,surface,version));
    CREATE TRIGGER IF NOT EXISTS e2ee_page_ink_insert BEFORE INSERT ON page_ink WHEN EXISTS(SELECT 1 FROM pages p JOIN spaces s ON s.id=p.space_id WHERE p.id=NEW.page_id AND s.encrypted=1) BEGIN SELECT RAISE(ABORT,'e2ee: plaintext refused'); END;
    CREATE TRIGGER IF NOT EXISTS e2ee_page_ink_update BEFORE UPDATE ON page_ink WHEN EXISTS(SELECT 1 FROM pages p JOIN spaces s ON s.id=p.space_id WHERE p.id=NEW.page_id AND s.encrypted=1) BEGIN SELECT RAISE(ABORT,'e2ee: plaintext refused'); END;
    CREATE TRIGGER IF NOT EXISTS search_page_ink_insert AFTER INSERT ON page_ink BEGIN INSERT INTO search_dirty SELECT NEW.page_id,'' WHERE NOT EXISTS(SELECT 1 FROM search_dirty WHERE page_id=NEW.page_id AND row_id=''); END;
    CREATE TRIGGER IF NOT EXISTS search_page_ink_update AFTER UPDATE OF text,recognized ON page_ink BEGIN INSERT INTO search_dirty SELECT NEW.page_id,'' WHERE NOT EXISTS(SELECT 1 FROM search_dirty WHERE page_id=NEW.page_id AND row_id=''); END;
    CREATE TRIGGER IF NOT EXISTS search_page_ink_delete AFTER DELETE ON page_ink BEGIN INSERT INTO search_dirty SELECT OLD.page_id,'' WHERE NOT EXISTS(SELECT 1 FROM search_dirty WHERE page_id=OLD.page_id AND row_id=''); END;
    CREATE TRIGGER IF NOT EXISTS search_notebook_sheet_delete AFTER DELETE ON notebook_sheets BEGIN INSERT INTO search_dirty SELECT OLD.page_id,'' WHERE NOT EXISTS(SELECT 1 FROM search_dirty WHERE page_id=OLD.page_id AND row_id=''); END;`);
  // Organising notebooks (lib/notebook-organize.ts): a sheet's own title,
  // its bookmark and its links (JSON: areas that jump to another sheet or a
  // page), the notebook's table of contents (JSON), and deleted sheets kept
  // with their ink for 30 days (undo, restore). Older versions ignore the
  // columns and keep them as they are.
  {
    const sheetColumns = (d.prepare("PRAGMA table_info(notebook_sheets)").all() as { name: string }[]).map((c) => c.name);
    for (const [column, type] of [["title", "TEXT NOT NULL DEFAULT ''"], ["bookmark", "INTEGER NOT NULL DEFAULT 0"], ["links", "TEXT NOT NULL DEFAULT '[]'"]])
      if (!sheetColumns.includes(column)) d.exec(`ALTER TABLE notebook_sheets ADD COLUMN ${column} ${type}`);
    if (!(d.prepare("PRAGMA table_info(notebooks)").all() as { name: string }[]).some((c) => c.name === "outline"))
      d.exec("ALTER TABLE notebooks ADD COLUMN outline TEXT NOT NULL DEFAULT '[]'");
    d.exec(`CREATE TABLE IF NOT EXISTS notebook_sheet_trash(id TEXT PRIMARY KEY,page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,position INTEGER NOT NULL,sheet TEXT NOT NULL,deleted_by TEXT,deleted_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS notebook_sheet_trash_page ON notebook_sheet_trash(page_id,deleted_at);`);
  }
  // Schema 61 – the push relay (lib/push-relay.ts, PROTOCOL.md of
  // flowplan-push): the instance's Ed25519 signing keys (private key only
  // sealed, lib/ai/secrets.ts), per app installation the relay token (sealed)
  // and the X25519 public key notifications are encrypted to, the relay
  // tokens of its Live Activities and the queue of their updates.
  d.exec(`CREATE TABLE IF NOT EXISTS push_identity_keys(kid TEXT PRIMARY KEY,public_key TEXT NOT NULL,private_key TEXT NOT NULL,created_at INTEGER NOT NULL,active_from INTEGER NOT NULL,retire_at INTEGER);
    CREATE TABLE IF NOT EXISTS mobile_push_relay(device_id TEXT PRIMARY KEY REFERENCES mobile_devices(id) ON DELETE CASCADE,relay_token TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,public_key TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS mobile_live_activities(device_id TEXT NOT NULL REFERENCES mobile_devices(id) ON DELETE CASCADE,kind TEXT NOT NULL CHECK(kind IN ('focus','timer')),relay_token TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,created_at INTEGER NOT NULL,labels TEXT,PRIMARY KEY(device_id,kind));
    CREATE TABLE IF NOT EXISTS push_live_queue(device_id TEXT NOT NULL REFERENCES mobile_devices(id) ON DELETE CASCADE,kind TEXT NOT NULL,available_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(device_id,kind,available_at));`);
  // The app's texts for its Live Activity views (language, time zone, the
  // labels – lib/live-activity-push.ts); databases from before had none.
  if (!(d.prepare("PRAGMA table_info(mobile_live_activities)").all() as { name: string }[]).some((c) => c.name === "labels"))
    d.exec("ALTER TABLE mobile_live_activities ADD COLUMN labels TEXT");
  // Schema 62 – the personal start page (lib/home-layout.ts): a layout per
  // person and workspace ('' = the person's default for every workspace)
  // and a workspace's default for its members. Leaving a workspace or its
  // deletion removes the layouts for it.
  d.exec(`CREATE TABLE IF NOT EXISTS home_layouts(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,workspace_id TEXT NOT NULL DEFAULT '',layout TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(user_id,workspace_id));
    CREATE TABLE IF NOT EXISTS home_defaults(workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,layout TEXT NOT NULL,updated_by TEXT,updated_at INTEGER NOT NULL);
    CREATE TRIGGER IF NOT EXISTS home_layouts_member_gone AFTER DELETE ON members BEGIN DELETE FROM home_layouts WHERE user_id=OLD.user_id AND workspace_id=OLD.workspace_id; END;
    CREATE TRIGGER IF NOT EXISTS home_layouts_workspace_gone AFTER DELETE ON workspaces BEGIN DELETE FROM home_layouts WHERE workspace_id=OLD.id; END;`);
  // Schema 63 – test notifications from the settings (lib/push-test.ts):
  // one row per push target of a test, sent by the push worker like any
  // other delivery (lib/push.ts), with its outcome. Never an inbox entry;
  // rows go once the result was read, at the latest after an hour.
  d.exec(`CREATE TABLE IF NOT EXISTS push_tests(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,subscription_id TEXT NOT NULL,created_at INTEGER NOT NULL,status TEXT,channel TEXT,detail TEXT,note TEXT);
    CREATE INDEX IF NOT EXISTS push_tests_run ON push_tests(run_id);`);
  // Schema 64 – push deliveries per hour, channel (relay, expo, web) and
  // result (ok, gone, forbidden, invalid, rate_limited, error) for the push
  // status in the administration (lib/metrics.ts, lib/push-status.ts).
  // Counts only, kept as long as metrics_hour.
  d.exec(`CREATE TABLE IF NOT EXISTS metrics_push(at INTEGER NOT NULL,channel TEXT NOT NULL,result TEXT NOT NULL,count INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(at,channel,result));`);
  // Schema 65 – idempotency keys of state-changing requests (lib/idempotency.ts):
  // per principal (scope "u:<user>", "t:<API token>", "d:<device>") and key
  // the hash of the request, its state and the answer (JSON up to 64 KB;
  // 'secret' and 'large' keep only the status). Kept 24 hours.
  d.exec(`CREATE TABLE IF NOT EXISTS idempotency_keys(scope TEXT NOT NULL,key TEXT NOT NULL,user_id TEXT REFERENCES users(id) ON DELETE CASCADE,request_hash TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('processing','done')),http_status INTEGER,response TEXT,stored TEXT NOT NULL DEFAULT 'body' CHECK(stored IN ('body','secret','large')),created_at INTEGER NOT NULL,PRIMARY KEY(scope,key));
    CREATE INDEX IF NOT EXISTS idempotency_keys_created ON idempotency_keys(created_at);
    CREATE INDEX IF NOT EXISTS idempotency_keys_user ON idempotency_keys(user_id);`);
  // Schema 66 – placeholders of uploaded images (lib/image-placeholders.ts):
  // the size they are shown in and a ThumbHash (base64), for files and
  // profile pictures. thumbhash NULL: not computed yet (filled in when first
  // asked for); '': nothing to show (no image we read, encrypted space).
  for (const table of ["files", "user_avatars"]) {
    const columns = (d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    for (const [column, type] of [["width", "INTEGER"], ["height", "INTEGER"], ["thumbhash", "TEXT"]])
      if (!columns.includes(column)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
  // Schema 67 – order of spaces (lib/space-order.ts): spaces.position, a
  // fractional sort key per workspace like pages.position. Filled once in
  // the order so far (creation, rowid); every list of spaces shown to people
  // sorts by position, rowid.
  if (!(d.prepare("PRAGMA table_info(spaces)").all() as { name: string }[]).some((c) => c.name === "position")) {
    d.exec("ALTER TABLE spaces ADD COLUMN position REAL");
    d.exec("UPDATE spaces SET position=(SELECT COUNT(*) FROM spaces o WHERE o.workspace_id IS spaces.workspace_id AND o.rowid<spaces.rowid)+1");
  }
  // New spaces (created, imported, duplicated, seeded) go to the end.
  d.exec(`CREATE INDEX IF NOT EXISTS spaces_order ON spaces(workspace_id,position);
    CREATE TRIGGER IF NOT EXISTS spaces_position_insert AFTER INSERT ON spaces WHEN NEW.position IS NULL BEGIN
      UPDATE spaces SET position=COALESCE((SELECT MAX(position) FROM spaces WHERE workspace_id IS NEW.workspace_id AND rowid!=NEW.rowid),0)+1 WHERE rowid=NEW.rowid;
    END;`);
  // Schema 68 – journal days created on first write (lib/journal-days.ts):
  // the draft id a day gets before it exists (one per journal and date, so
  // every device writes into the same page), which template version a day
  // was created from and the template versions themselves (by hash).
  d.exec(`CREATE TABLE IF NOT EXISTS journal_drafts(id TEXT PRIMARY KEY,journal_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,date TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(journal_id,date));
    CREATE TABLE IF NOT EXISTS journal_day_meta(page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,journal_id TEXT NOT NULL,template_hash TEXT NOT NULL DEFAULT '',base_hash TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS journal_templates(journal_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,hash TEXT NOT NULL,html TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(journal_id,hash));`);
  // Schema 71 – own whiteboard templates (lib/whiteboard-user-templates.ts):
  // a board or a selection as template elements (JSON), for the workspace
  // or only for the person who saved it.
  d.exec(`CREATE TABLE IF NOT EXISTS whiteboard_templates(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,name TEXT NOT NULL,items TEXT NOT NULL,created_by TEXT REFERENCES users(id) ON DELETE SET NULL,visibility TEXT NOT NULL DEFAULT 'workspace' CHECK(visibility IN ('workspace','private')),created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS whiteboard_templates_workspace ON whiteboard_templates(workspace_id);`);
  // Schema 72 – workshop facilitation on whiteboards (lib/whiteboard-
  // facilitation.ts): private mode sessions (optionally one frame), each
  // person's private changes until they are revealed (Yjs updates, never
  // part of the board) and the private writer ids of their browser tabs;
  // planning poker per board with the hidden votes of the current round.
  d.exec(`CREATE TABLE IF NOT EXISTS whiteboard_private(id TEXT PRIMARY KEY,page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,frame_id TEXT,started_by TEXT,started_name TEXT NOT NULL DEFAULT '',started_at INTEGER NOT NULL,revealed_at INTEGER,revealed_count INTEGER);
    CREATE INDEX IF NOT EXISTS whiteboard_private_page ON whiteboard_private(page_id,revealed_at);
    CREATE TABLE IF NOT EXISTS whiteboard_private_parts(session_id TEXT NOT NULL REFERENCES whiteboard_private(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,state BLOB,items INTEGER NOT NULL DEFAULT 0,rev INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(session_id,user_id));
    CREATE TABLE IF NOT EXISTS whiteboard_private_clients(page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,client INTEGER NOT NULL,session_id TEXT NOT NULL REFERENCES whiteboard_private(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,PRIMARY KEY(page_id,client));
    CREATE TABLE IF NOT EXISTS whiteboard_estimation(page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,data TEXT NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS whiteboard_estimate_votes(page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,round TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,name TEXT NOT NULL,value TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(page_id,round,user_id));`);
  // Schema 73 – who is here right now (lib/user-activity.ts): when the app
  // was last open and when someone last used it.
  {
    const columns = (d.prepare("PRAGMA table_info(users)").all() as { name: string }[]).map((c) => c.name);
    if (!columns.includes("last_open_at")) d.exec("ALTER TABLE users ADD COLUMN last_open_at INTEGER");
    if (!columns.includes("last_active_at")) d.exec("ALTER TABLE users ADD COLUMN last_active_at INTEGER");
  }
  // Schema 74 – deleting inactive accounts (lib/inactive-accounts.ts):
  // when the notice and the reminder went out and the day of deletion.
  {
    const columns = (d.prepare("PRAGMA table_info(users)").all() as { name: string }[]).map((c) => c.name);
    for (const column of ["deletion_notice_at", "deletion_reminder_at", "deletion_due_at"])
      if (!columns.includes(column)) d.exec(`ALTER TABLE users ADD COLUMN ${column} INTEGER`);
  }
  // Schema 75 – banners people click away once (lib/instance-banners.ts):
  // the banners of the administration and who closed or followed which.
  d.exec(`CREATE TABLE IF NOT EXISTS instance_banners(id TEXT PRIMARY KEY,title TEXT NOT NULL DEFAULT '',message TEXT NOT NULL,link_url TEXT,link_label TEXT,tone TEXT NOT NULL DEFAULT 'info',audience TEXT NOT NULL DEFAULT 'all',surface TEXT NOT NULL DEFAULT 'everywhere',starts_at INTEGER,ends_at INTEGER,paused INTEGER NOT NULL DEFAULT 0,created_by TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS instance_banner_seen(banner_id TEXT NOT NULL REFERENCES instance_banners(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,dismissed_at INTEGER NOT NULL,clicked INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(banner_id,user_id));`);
  // Schema 76 – tasks of a deleted record go with it (#53): doc_tasks has
  // no reference to rows, so a trigger removes them on every path that
  // deletes records (trash, version restore, templates, sync); the ones
  // left behind before are removed once.
  d.exec(`CREATE TRIGGER IF NOT EXISTS doc_tasks_row_delete AFTER DELETE ON rows BEGIN
      DELETE FROM doc_tasks WHERE page_id=OLD.page_id AND row_id=OLD.id;
    END;
    DELETE FROM doc_tasks WHERE row_id<>'' AND NOT EXISTS (SELECT 1 FROM rows r WHERE r.id=doc_tasks.row_id AND r.page_id=doc_tasks.page_id);`);
  // Schema 77 – security observability (lib/security-events.ts): events with
  // the network of the address and a keyed hash of it (never the address
  // itself), incidents of the detection rules (lib/security-detect.ts) and
  // addresses or networks the administrators blocked.
  d.exec(`CREATE TABLE IF NOT EXISTS security_events(id INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER NOT NULL,kind TEXT NOT NULL,severity TEXT NOT NULL,actor_id TEXT,subject TEXT NOT NULL DEFAULT '',subject_key TEXT NOT NULL DEFAULT '',network TEXT NOT NULL DEFAULT '',address_key TEXT NOT NULL DEFAULT '',country TEXT NOT NULL DEFAULT '',device TEXT NOT NULL DEFAULT '',detail TEXT NOT NULL DEFAULT '');
    CREATE INDEX IF NOT EXISTS security_events_at ON security_events(at);
    CREATE INDEX IF NOT EXISTS security_events_kind ON security_events(kind,at);
    CREATE INDEX IF NOT EXISTS security_events_address ON security_events(address_key,at);
    CREATE INDEX IF NOT EXISTS security_events_subject ON security_events(subject_key,at);
    CREATE INDEX IF NOT EXISTS security_events_actor ON security_events(actor_id,at);
    CREATE TABLE IF NOT EXISTS security_incidents(id TEXT PRIMARY KEY,rule TEXT NOT NULL,key TEXT NOT NULL,severity TEXT NOT NULL,actor_id TEXT,network TEXT NOT NULL DEFAULT '',address_key TEXT NOT NULL DEFAULT '',detail TEXT NOT NULL DEFAULT '',first_at INTEGER NOT NULL,last_at INTEGER NOT NULL,count INTEGER NOT NULL DEFAULT 1,resolved_at INTEGER,resolved_by TEXT);
    CREATE INDEX IF NOT EXISTS security_incidents_rule ON security_incidents(rule,key,resolved_at);
    CREATE INDEX IF NOT EXISTS security_incidents_last ON security_incidents(last_at);
    CREATE TABLE IF NOT EXISTS security_blocks(id TEXT PRIMARY KEY,kind TEXT NOT NULL,value TEXT NOT NULL,label TEXT NOT NULL DEFAULT '',reason TEXT NOT NULL DEFAULT '',created_by TEXT,created_at INTEGER NOT NULL,until INTEGER,UNIQUE(kind,value));`);
  // Schema 78 – what a detection rule saw beyond its events (JSON), e.g. the
  // refused paths of probing.
  const incidentColumns = d.prepare("PRAGMA table_info(security_incidents)").all() as { name: string }[];
  if (!incidentColumns.some((c) => c.name === "evidence")) d.exec("ALTER TABLE security_incidents ADD COLUMN evidence TEXT NOT NULL DEFAULT ''");
  // Schema 79 – notifications to chat apps (#63, lib/messengers.ts): one
  // connection per person and service (Telegram, Gotify, ntfy, Matrix) with
  // its credentials sealed, the person's choices (text or only a hint,
  // operations alerts for administrators), a queue like push_deliveries,
  // filled by a trigger for every notification that reaches the inbox, and
  // the one-time codes that bind a Telegram chat to the instance's bot.
  d.exec(`CREATE TABLE IF NOT EXISTS messenger_targets(
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      service TEXT NOT NULL CHECK(service IN ('telegram','gotify','ntfy','matrix')),
      mode TEXT NOT NULL DEFAULT '',
      config TEXT NOT NULL DEFAULT '{}',
      secret TEXT,
      secret_hint TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      disabled_reason TEXT,
      failures INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      last_ok_at INTEGER,
      created_at INTEGER NOT NULL,
      UNIQUE(user_id,service));
    CREATE TABLE IF NOT EXISTS messenger_settings(
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      preview INTEGER NOT NULL DEFAULT 1,
      ops INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS messenger_deliveries(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_id TEXT NOT NULL REFERENCES messenger_targets(id) ON DELETE CASCADE,
      notification_id TEXT REFERENCES notifications(id) ON DELETE CASCADE,
      title TEXT,
      body TEXT,
      url TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      available_at INTEGER NOT NULL DEFAULT 0,
      delivered_at INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS messenger_deliveries_due ON messenger_deliveries(delivered_at,available_at);
    CREATE INDEX IF NOT EXISTS messenger_deliveries_target ON messenger_deliveries(target_id,delivered_at);
    CREATE TABLE IF NOT EXISTS telegram_links(
      code_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires INTEGER NOT NULL,
      used_at INTEGER,
      chat_id TEXT);
    DROP TRIGGER IF EXISTS queue_notification_messenger;
    CREATE TRIGGER queue_notification_messenger AFTER INSERT ON notifications BEGIN
      INSERT INTO messenger_deliveries(target_id,notification_id,available_at,created_at)
      SELECT t.id,NEW.id,unixepoch()*1000,unixepoch()*1000 FROM messenger_targets t JOIN users u ON u.id=t.user_id
      WHERE t.user_id=NEW.user_id AND t.enabled=1 AND u.disabled=0 AND u.demo_until IS NULL
      AND ${notificationOn("messenger", "NEW.user_id", "COALESCE(NEW.kind,'comment')")};
    END;`);
  // Schema 80 – contacts databases (lib/contacts.ts, lib/contacts-ldap.ts,
  // lib/carddav.ts): the LDAP source of a contacts database (its OUs, the
  // property ↔ attribute mapping, the last sync), the record ↔ directory
  // entry links (DN, entryUUID/objectGUID, hash of the last values) and the
  // CardDAV accesses (only the password's hash).
  d.exec(`CREATE TABLE IF NOT EXISTS contact_ldap_sources(page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,ous TEXT NOT NULL DEFAULT '[]',mapping TEXT NOT NULL DEFAULT '{}',fields TEXT NOT NULL DEFAULT '[]',created_by TEXT,created_at INTEGER NOT NULL,last_sync_at INTEGER,last_result TEXT);
    CREATE TABLE IF NOT EXISTS contact_ldap_links(row_id TEXT PRIMARY KEY REFERENCES rows(id) ON DELETE CASCADE,page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,dn TEXT NOT NULL,uuid TEXT NOT NULL DEFAULT '',ou TEXT NOT NULL DEFAULT '',hash TEXT NOT NULL DEFAULT '',photo_hash TEXT NOT NULL DEFAULT '',missing_at INTEGER,synced_at INTEGER);
    CREATE INDEX IF NOT EXISTS contact_ldap_links_page ON contact_ldap_links(page_id,uuid);
    CREATE INDEX IF NOT EXISTS contact_ldap_links_dn ON contact_ldap_links(page_id,dn);
    CREATE TABLE IF NOT EXISTS carddav_accesses(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,token_hash TEXT NOT NULL UNIQUE,created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS carddav_accesses_user ON carddav_accesses(user_id,page_id);
    CREATE TABLE IF NOT EXISTS carddav_profile_links(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,expires INTEGER NOT NULL);`);
  // Schema 81 – incidents of the instance as their own notification kind
  // "incident" (lib/notification-kinds.ts), for administrators: where a
  // notification leads beyond pages (notifications.link, e.g.
  // "#admin/threats/incident/<id>") and from which severity an
  // administrator wants them (notification_prefs.min_severity of the
  // "incident" row). Until now incidents came as "security"; whoever
  // switched channels off there keeps them off for incidents – copied once,
  // together with adding the column.
  if (!(d.prepare("PRAGMA table_info(notifications)").all() as { name: string }[]).some((c) => c.name === "link"))
    d.exec("ALTER TABLE notifications ADD COLUMN link TEXT");
  if (!(d.prepare("PRAGMA table_info(notification_prefs)").all() as { name: string }[]).some((c) => c.name === "min_severity"))
    d.exec(`ALTER TABLE notification_prefs ADD COLUMN min_severity TEXT;
      INSERT OR IGNORE INTO notification_prefs(user_id,kind,inbox,push,email,messenger)
        SELECT user_id,'incident',inbox,push,email,messenger FROM notification_prefs WHERE kind='security';`);
  // Schema 82 – tags and custom properties of pages (#70,
  // lib/page-properties-server.ts): tags and property definitions of the
  // workspace, the tags and values of each page (gone with the page, the tag
  // or the definition), the page's creation time (for "Erstellt am"; pages
  // from before read their first version or last change, without rewriting
  // every page here) and search entries that follow tags and values.
  d.exec(`CREATE TABLE IF NOT EXISTS page_tags(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,name TEXT NOT NULL,color TEXT NOT NULL DEFAULT 'gray',position REAL NOT NULL DEFAULT 0,created_by TEXT,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS page_tag_links(page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,tag_id TEXT NOT NULL REFERENCES page_tags(id) ON DELETE CASCADE,position INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(page_id,tag_id));
    CREATE INDEX IF NOT EXISTS page_tag_links_tag ON page_tag_links(tag_id);
    CREATE TABLE IF NOT EXISTS page_property_defs(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,name TEXT NOT NULL,type TEXT NOT NULL,options TEXT NOT NULL DEFAULT '[]',position REAL NOT NULL DEFAULT 0,created_by TEXT,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS page_property_values(page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,property_id TEXT NOT NULL REFERENCES page_property_defs(id) ON DELETE CASCADE,value TEXT NOT NULL,PRIMARY KEY(page_id,property_id));
    CREATE INDEX IF NOT EXISTS page_property_values_property ON page_property_values(property_id);
    CREATE TRIGGER IF NOT EXISTS search_page_tag_add AFTER INSERT ON page_tag_links BEGIN INSERT INTO search_dirty SELECT NEW.page_id,'' WHERE NOT EXISTS(SELECT 1 FROM search_dirty WHERE page_id=NEW.page_id AND row_id=''); END;
    CREATE TRIGGER IF NOT EXISTS search_page_tag_remove AFTER DELETE ON page_tag_links BEGIN INSERT INTO search_dirty SELECT OLD.page_id,'' WHERE EXISTS(SELECT 1 FROM pages WHERE id=OLD.page_id) AND NOT EXISTS(SELECT 1 FROM search_dirty WHERE page_id=OLD.page_id AND row_id=''); END;
    CREATE TRIGGER IF NOT EXISTS search_page_tag_rename AFTER UPDATE OF name ON page_tags BEGIN INSERT INTO search_dirty SELECT l.page_id,'' FROM page_tag_links l WHERE l.tag_id=NEW.id AND NOT EXISTS(SELECT 1 FROM search_dirty WHERE page_id=l.page_id AND row_id=''); END;
    CREATE TRIGGER IF NOT EXISTS search_page_value_add AFTER INSERT ON page_property_values BEGIN INSERT INTO search_dirty SELECT NEW.page_id,'' WHERE NOT EXISTS(SELECT 1 FROM search_dirty WHERE page_id=NEW.page_id AND row_id=''); END;
    CREATE TRIGGER IF NOT EXISTS search_page_value_change AFTER UPDATE ON page_property_values BEGIN INSERT INTO search_dirty SELECT NEW.page_id,'' WHERE NOT EXISTS(SELECT 1 FROM search_dirty WHERE page_id=NEW.page_id AND row_id=''); END;
    CREATE TRIGGER IF NOT EXISTS search_page_value_remove AFTER DELETE ON page_property_values BEGIN INSERT INTO search_dirty SELECT OLD.page_id,'' WHERE EXISTS(SELECT 1 FROM pages WHERE id=OLD.page_id) AND NOT EXISTS(SELECT 1 FROM search_dirty WHERE page_id=OLD.page_id AND row_id=''); END;`);
  if (!(d.prepare("PRAGMA table_info(pages)").all() as { name: string }[]).some((c) => c.name === "created_at"))
    d.exec("ALTER TABLE pages ADD COLUMN created_at TEXT");
  d.exec(`CREATE TRIGGER IF NOT EXISTS pages_created_at AFTER INSERT ON pages WHEN NEW.created_at IS NULL BEGIN
      UPDATE pages SET created_at=CURRENT_TIMESTAMP WHERE id=NEW.id;
    END;`);
  // Schema 83 – how a person looks at a page, stored in their account and
  // so the same on all their devices (#83, lib/page-view-prefs.ts): whether
  // the bar with tags and properties is collapsed (NULL: never chosen, the
  // default applies). Gone with the person or the page.
  d.exec(`CREATE TABLE IF NOT EXISTS page_view_prefs(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,properties_collapsed INTEGER,updated_at INTEGER NOT NULL,PRIMARY KEY(user_id,page_id));
    CREATE INDEX IF NOT EXISTS page_view_prefs_page ON page_view_prefs(page_id);`);
  // Schema 84 – numbered captions of images, tables and code blocks (#84,
  // lib/block-captions.ts), switched on per page.
  if (!(d.prepare("PRAGMA table_info(pages)").all() as { name: string }[]).some((c) => c.name === "caption_numbers"))
    d.exec("ALTER TABLE pages ADD COLUMN caption_numbers INTEGER NOT NULL DEFAULT 0");
  // Schema 85 – collections (#86, lib/collections.ts): saved queries in
  // the sidebar, private or shared with the workspace, each person's order
  // of them. The personal saved searches become collections once (their
  // kind and space as type: and in: in the query) and leave saved_searches.
  d.exec(`CREATE TABLE IF NOT EXISTS collections(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,name TEXT NOT NULL,icon TEXT NOT NULL DEFAULT '',query TEXT NOT NULL,shared INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,deleted_at INTEGER);
    CREATE INDEX IF NOT EXISTS collections_workspace ON collections(workspace_id,owner_id);
    CREATE TABLE IF NOT EXISTS collection_order(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,position REAL NOT NULL,PRIMARY KEY(user_id,collection_id));
    CREATE INDEX IF NOT EXISTS collection_order_collection ON collection_order(collection_id);`);
  // The saved searches become collections in a data step (lib/data-steps.ts).
  // Schema 86 – rack planning on whiteboards (#90,
  // lib/whiteboard-rack-server.ts): own devices of a workspace for the
  // device library (the device as JSON, its colour). Racks, devices and
  // cables themselves are elements of the board.
  d.exec(`CREATE TABLE IF NOT EXISTS rack_device_templates(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,name TEXT NOT NULL,device TEXT NOT NULL,fill TEXT,created_by TEXT REFERENCES users(id) ON DELETE SET NULL,created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS rack_device_templates_workspace ON rack_device_templates(workspace_id);`);
  // Schema 87 – what each person folded or unfolded in the sidebar, per
  // workspace and the same on all their devices (#97, lib/sidebar-state.ts):
  // a short list of keys (unfolded pages, folded spaces and groups, journal
  // folders). Gone with the person or the workspace; deleted pages drop out
  // whenever the list is read or saved.
  d.exec(`CREATE TABLE IF NOT EXISTS sidebar_state(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,keys TEXT NOT NULL DEFAULT '[]',updated_at INTEGER NOT NULL,PRIMARY KEY(user_id,workspace_id));
    CREATE INDEX IF NOT EXISTS sidebar_state_workspace ON sidebar_state(workspace_id);`);
  migrateIdentities(d);
  // Schema 89 – "My activity" on the start page (#114, lib/my-activity.ts)
  // reads one person's pages, versions, activity log entries and last
  // edits of a period: by person and time instead of scanning the tables.
  // Nothing new is recorded.
  d.exec(`CREATE INDEX IF NOT EXISTS pages_creator ON pages(created_by,created_at);
    CREATE INDEX IF NOT EXISTS snapshots_author ON snapshots(created_by,created_at);
    CREATE INDEX IF NOT EXISTS audit_actor ON audit(actor_id,created_at);
    CREATE INDEX IF NOT EXISTS page_edits_user ON page_edits(user_id,at);`);
  // Schema 90 – formatted text properties (#126, lib/formatted-text.ts):
  // the existing values of text properties (not titles) are escaped once
  // so they show as before; data_migrations remembers one-time steps.
  // Their values are escaped in a data step (lib/data-steps.ts).
  migrateMetaScopes(d);
  // Used one-time values of signed deliveries (Mailgun's token, Slack's
  // event_id), kept a short while against replays (lib/replay-guard.ts).
  d.exec(`CREATE TABLE IF NOT EXISTS replay_guard(key TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,expires INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS replay_guard_expires ON replay_guard(expires);`);
  // Schema 92 – integration secrets at rest (lib/sealed-values.ts): webhook
  // signing secrets and addresses and the Git connections of databases are
  // sealed once. An older version cannot read them, hence the new number.
  // Sealed in a data step (lib/data-steps.ts).
  // Schema 93 – files in the trash (#164, lib/file-trash.ts): a file deleted
  // in the media library keeps its row, upload and derived data with
  // deleted_at set; it is no longer served and goes for good with the trash.
  // An older version would serve such files again, hence the new number.
  migrateFileTrash(d);
  // Notification retention (lib/notification-retention.ts) deletes old
  // notifications: their chat app deliveries go with them by notification,
  // and the inbox reads one person's newest.
  d.exec(`CREATE INDEX IF NOT EXISTS messenger_deliveries_notification ON messenger_deliveries(notification_id);
    CREATE INDEX IF NOT EXISTS notifications_user_created ON notifications(user_id,created_at);`);
  // Tables that features used to create on first use: in the migrations,
  // so the PostgreSQL schema (translated from this one) has them too.
  d.exec(`CREATE TABLE IF NOT EXISTS caldav_profile_links(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,calendars TEXT NOT NULL,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS mobile_focus(device_id TEXT PRIMARY KEY REFERENCES mobile_devices(id) ON DELETE CASCADE,workspace_id TEXT,until INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS background_jobs(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,kind TEXT NOT NULL,label TEXT NOT NULL DEFAULT '',progress REAL,status TEXT NOT NULL CHECK(status IN ('running','done','failed')),error TEXT,boot TEXT NOT NULL,started_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,finished_at INTEGER);
    CREATE INDEX IF NOT EXISTS background_jobs_user ON background_jobs(user_id,started_at);
    CREATE TABLE IF NOT EXISTS widget_counter_days(key TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,day TEXT NOT NULL,value REAL,at INTEGER NOT NULL,PRIMARY KEY(key,day));
    CREATE INDEX IF NOT EXISTS widget_counter_days_at ON widget_counter_days(at);
    CREATE TABLE IF NOT EXISTS widget_focus(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,started_at INTEGER NOT NULL,focus_ms INTEGER NOT NULL,break_ms INTEGER NOT NULL,page_id TEXT,row_id TEXT,field_id TEXT,timer INTEGER NOT NULL DEFAULT 0,stopped_at INTEGER);
    CREATE TABLE IF NOT EXISTS notification_targets(notification_id TEXT PRIMARY KEY REFERENCES notifications(id) ON DELETE CASCADE,target TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS storage_queue(key TEXT PRIMARY KEY,op TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS storage_state(name TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS storage_sealed(key TEXT PRIMARY KEY,key_id TEXT NOT NULL);`);
  // Schema 94 – PostgreSQL support (#127, docs/architecture/database.md):
  // queries no longer order by SQLite's implicit rowid. Where the order of
  // insertion matters (newest notification, version or message first,
  // favourites in the order they were added, a queue), the table has an
  // explicit `seq`: SQLite fills it with the rowid (existing rows once, new
  // ones by a trigger), PostgreSQL makes it an identity column.
  for (const table of SEQ_TABLES)
    if (!(d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === "seq"))
      d.exec(`ALTER TABLE ${table} ADD COLUMN seq INTEGER; UPDATE ${table} SET seq=rowid;`);
  for (const table of SEQ_TABLES)
    d.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_seq AFTER INSERT ON ${table} WHEN NEW.seq IS NULL BEGIN UPDATE ${table} SET seq=NEW.rowid WHERE rowid=NEW.rowid; END;`);
  // Pages too, in the update that already gives a new page its created_at
  // (one statement per insert, as before).
  if (!(d.prepare("PRAGMA table_info(pages)").all() as { name: string }[]).some((c) => c.name === "seq"))
    d.exec("ALTER TABLE pages ADD COLUMN seq INTEGER; UPDATE pages SET seq=rowid;");
  if (!/seq/.test((d.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='pages_created_at'").get() as { sql: string } | undefined)?.sql || ""))
    d.exec(`DROP TRIGGER IF EXISTS pages_created_at;
      CREATE TRIGGER pages_created_at AFTER INSERT ON pages WHEN NEW.created_at IS NULL OR NEW.seq IS NULL BEGIN
        UPDATE pages SET created_at=COALESCE(NEW.created_at,CURRENT_TIMESTAMP),seq=COALESCE(NEW.seq,NEW.rowid) WHERE rowid=NEW.rowid;
      END;`);
  // Schema 95 – Forgejo/Gitea as a third provider of the issue sync (#162):
  // issue_connections.provider allows 'forgejo' (migrateIssueProviders; on
  // PostgreSQL the data step "issue-providers-95", lib/data-steps.ts). An
  // older version could not read such a connection, hence the new number.
  // Schema 96 – "Nur meine" below a journal day (#169, lib/journal-completed.ts):
  // the status log records who made a record done or open again
  // (row_status_log.user_id; NULL for share links, the Git connection,
  // rules nobody set up and every entry written before). The choice
  // "Alle / Nur meine" is the person's, per journal
  // (page_view_prefs.completed_mine of the journal page; NULL: never
  // chosen, "Nur meine").
  migrateStatusLogUser(d);
  // Schema 97 – workflows (#168, below).
  migrateWorkflows(d);
  // Schema 98 – back-link comments of the Git connection (#184,
  // lib/git-backlinks.ts): per database and pull/merge request the one
  // comment Flowplan wrote there (updated instead of posting another), the
  // hash of its text and the outcome of the last attempt (the status shown
  // in the connection's settings).
  d.exec(`CREATE TABLE IF NOT EXISTS git_backlinks(page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,url TEXT NOT NULL,comment_id TEXT,body_hash TEXT NOT NULL DEFAULT '',status INTEGER,error TEXT,at INTEGER NOT NULL,PRIMARY KEY(page_id,url));
    CREATE INDEX IF NOT EXISTS git_backlinks_at ON git_backlinks(page_id,at);`);
  // Schema 99 – the record properties folded or open (#186,
  // lib/page-view-prefs.ts): the person's choice per database, separately
  // for phones and larger screens (page_view_prefs of the database page;
  // NULL: never chosen, the default applies).
  migrateRecordPropertyPrefs(d);
  // Schema 100 – grants bound to their resource (lib/permissions.ts): the
  // kind ('page' or 'space') and the workspace of the resource a grant was
  // written for. Pages and spaces could share an id (an encrypted space
  // chose its own), so a space's grant counted for the page with that id.
  // Existing grants are filled in a data step (lib/data-steps.ts,
  // "grant-kinds-100"); an older version would not write them, hence the
  // new number.
  migrateGrantKinds(d);
  // Notebook stickers and own paper templates (lib/notebook-library.ts):
  // new tables only – an older version leaves them alone – so the schema
  // number stays.
  migrateNotebookLibrary(d);
  // Schema 101 – audio recordings of notebooks (lib/notebook-audio.ts): per
  // notebook its recordings, each an uploaded file of the page (counted in
  // the storage, in the trash with it) with its length; the id is the one
  // the ink written meanwhile refers to (`rec` of an item, lib/ink/model.ts),
  // kept in copies. `transcript` is left for a transcription (not filled yet).
  // An older version would keep the files as plain attachments.
  d.exec(`CREATE TABLE IF NOT EXISTS notebook_recordings(page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,id TEXT NOT NULL,file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,name TEXT NOT NULL,duration_ms INTEGER NOT NULL,created_by TEXT,created_at INTEGER NOT NULL,transcript TEXT,PRIMARY KEY(page_id,id));
    CREATE INDEX IF NOT EXISTS notebook_recordings_file ON notebook_recordings(file_id);`);
  // Schema 102 – a workspace's own look (#196, lib/workspace-theme.ts).
  migrateWorkspaceTheme(d);
  // Schema 103 – meeting notes (#199, lib/meetings.ts).
  migrateMeetings(d);
  // "Menü bei Textauswahl" per person (#200, lib/text-menu-pref.ts):
  // users.text_menu, NULL = the default. An older version ignores the
  // column, so the schema number stays.
  if (!(d.prepare("PRAGMA table_info(users)").all() as { name: string }[]).some((c) => c.name === "text_menu"))
    d.exec("ALTER TABLE users ADD COLUMN text_menu TEXT");
  // "Seitensymbol" per person (#214, lib/page-icon-pref.ts): users.page_icon,
  // NULL = the default (above the title). An older version ignores the
  // column, so the schema number stays.
  if (!(d.prepare("PRAGMA table_info(users)").all() as { name: string }[]).some((c) => c.name === "page_icon"))
    d.exec("ALTER TABLE users ADD COLUMN page_icon TEXT");
  // "Symbol bei externen Links" per person (#217,
  // lib/external-link-icon-pref.ts): users.external_link_icon, NULL = the
  // default (on), 0 = off, 1 = on. An older version ignores the column, so
  // the schema number stays.
  if (!(d.prepare("PRAGMA table_info(users)").all() as { name: string }[]).some((c) => c.name === "external_link_icon"))
    d.exec("ALTER TABLE users ADD COLUMN external_link_icon INTEGER");
  // "`>` erzeugt" per person (#230, lib/quote-shortcut-pref.ts):
  // users.quote_shortcut, NULL = the default ('toggle'), or 'quote'. An
  // older version ignores the column, so the schema number stays.
  if (!(d.prepare("PRAGMA table_info(users)").all() as { name: string }[]).some((c) => c.name === "quote_shortcut"))
    d.exec("ALTER TABLE users ADD COLUMN quote_shortcut TEXT");
  // "Formatierungsleiste" per person (#235, lib/toolbar-pref.ts):
  // users.formatting_toolbar, NULL = the default ('show'), or 'hide'. An
  // older version ignores the column, so the schema number stays.
  if (!(d.prepare("PRAGMA table_info(users)").all() as { name: string }[]).some((c) => c.name === "formatting_toolbar"))
    d.exec("ALTER TABLE users ADD COLUMN formatting_toolbar TEXT");
  // "Formatierungsleiste anpassen" per person (#292, lib/toolbar-layout.ts):
  // users.toolbar_layout, NULL = the default, or the layout as JSON. An
  // older version ignores the column, so the schema number stays.
  if (!(d.prepare("PRAGMA table_info(users)").all() as { name: string }[]).some((c) => c.name === "toolbar_layout"))
    d.exec("ALTER TABLE users ADD COLUMN toolbar_layout TEXT");
  // "Animationen" per person (#260, lib/motion-pref.ts): users.motion,
  // NULL = the default ('normal'), 'reduced' or 'off'. An older version
  // ignores the column, so the schema number stays.
  if (!(d.prepare("PRAGMA table_info(users)").all() as { name: string }[]).some((c) => c.name === "motion"))
    d.exec("ALTER TABLE users ADD COLUMN motion TEXT");
  // "Seiten in voller Breite anzeigen" per person (#257,
  // lib/page-width-pref.ts): users.full_width_pages, NULL = the default
  // (off), 0 or 1. An older version ignores the column, so the schema number
  // stays.
  if (!(d.prepare("PRAGMA table_info(users)").all() as { name: string }[]).some((c) => c.name === "full_width_pages"))
    d.exec("ALTER TABLE users ADD COLUMN full_width_pages INTEGER");
  // "Textkommentare: am Rand / unter dem Dokument" per person (#387,
  // lib/comment-margin-pref.ts): users.comment_margin, NULL = the default
  // (the margin), 0 or 1. An older version ignores the column, so the
  // schema number stays.
  if (!(d.prepare("PRAGMA table_info(users)").all() as { name: string }[]).some((c) => c.name === "comment_margin"))
    d.exec("ALTER TABLE users ADD COLUMN comment_margin INTEGER");
  // "Whiteboard-Fläche" per person (#399, lib/whiteboard-canvas-pref.ts):
  // users.whiteboard_canvas, NULL = the default (the canvas follows the
  // colour scheme) or 'light'. Only the interface reads it – an older
  // version ignores the column – so the schema number stays.
  if (!(d.prepare("PRAGMA table_info(users)").all() as { name: string }[]).some((c) => c.name === "whiteboard_canvas"))
    d.exec("ALTER TABLE users ADD COLUMN whiteboard_canvas TEXT");
  // "Ton bei neuen Benachrichtigungen" per person (#401,
  // lib/notification-sound.ts): users.notification_sound, NULL = the default
  // ('soft'), 'off', 'clear' or 'bell'. Only the interface reads it – an
  // older version ignores the column – so the schema number stays.
  if (!(d.prepare("PRAGMA table_info(users)").all() as { name: string }[]).some((c) => c.name === "notification_sound"))
    d.exec("ALTER TABLE users ADD COLUMN notification_sound TEXT");
  // "Beim Öffnen auf dem Handy" per person (lib/start-screen.ts):
  // users.start_screen, NULL = the default ('home') or 'capture'. An older
  // version ignores the column, so the schema number stays.
  if (!(d.prepare("PRAGMA table_info(users)").all() as { name: string }[]).some((c) => c.name === "start_screen"))
    d.exec("ALTER TABLE users ADD COLUMN start_screen TEXT");
  // The settings level per person (#294, lib/settings-level.ts):
  // users.settings_level, NULL = the instance's default, or 'beginner',
  // 'normal', 'expert'. Accounts from before get 'expert' once
  // (lib/data-steps.ts). An older version ignores the column, so the schema
  // number stays.
  if (!(d.prepare("PRAGMA table_info(users)").all() as { name: string }[]).some((c) => c.name === "settings_level"))
    d.exec("ALTER TABLE users ADD COLUMN settings_level TEXT");
  // Switched-off features per person (#378, lib/feature-modules.ts):
  // users.modules, NULL = the instance's default, or the hidden features as
  // JSON. Accounts from before get "[]" once (lib/data-steps.ts). Only the
  // interface reads it – an older version ignores the column – so the
  // schema number stays.
  if (!(d.prepare("PRAGMA table_info(users)").all() as { name: string }[]).some((c) => c.name === "modules"))
    d.exec("ALTER TABLE users ADD COLUMN modules TEXT");
  // "Bei dieser Datei immer zulassen" per person (#425,
  // lib/html-scripts-trust.ts): users.html_scripts, NULL = none, or the
  // HTML files whose scripts run on opening as JSON (file id and content
  // hash, at most 500). Only the viewer reads it – an older version
  // ignores the column and asks every time – so the schema number stays.
  if (!(d.prepare("PRAGMA table_info(users)").all() as { name: string }[]).some((c) => c.name === "html_scripts"))
    d.exec("ALTER TABLE users ADD COLUMN html_scripts TEXT");
  // "Neuigkeiten nach Updates" per person (#223, lib/user-update-notes.ts):
  // users.update_notes (the level, NULL = all) and users.seen_version (the
  // last version whose notes were seen, NULL = not tracked yet). An older
  // version ignores the columns, so the schema number stays.
  {
    const columns = (d.prepare("PRAGMA table_info(users)").all() as { name: string }[]).map((c) => c.name);
    if (!columns.includes("update_notes")) d.exec("ALTER TABLE users ADD COLUMN update_notes TEXT");
    if (!columns.includes("seen_version")) d.exec("ALTER TABLE users ADD COLUMN seen_version TEXT");
  }
  // The state of a document task (#201, lib/task-status.ts): 'progress',
  // 'cancelled' or 'deferred', NULL for open and done (`checked` says
  // which; cancelled counts as checked). An older version writes NULL and
  // reads `checked` as before, so the schema number stays.
  if (!(d.prepare("PRAGMA table_info(doc_tasks)").all() as { name: string }[]).some((c) => c.name === "status"))
    d.exec("ALTER TABLE doc_tasks ADD COLUMN status TEXT");
  // Automatic link rules of a workspace (#202, lib/auto-link-rules.ts):
  // workspaces.link_rules (JSON, NULL = none). An older version ignores the
  // column (nothing is linked automatically), so the schema number stays.
  if (!(d.prepare("PRAGMA table_info(workspaces)").all() as { name: string }[]).some((c) => c.name === "link_rules"))
    d.exec("ALTER TABLE workspaces ADD COLUMN link_rules TEXT");
  // Print options and presets (#215, lib/print-settings.ts): a person's
  // last choice and own presets (users.print_settings), a workspace's
  // presets (workspaces.print_presets), JSON, NULL = none. An older version
  // ignores the columns (prints as before), so the schema number stays.
  if (!(d.prepare("PRAGMA table_info(users)").all() as { name: string }[]).some((c) => c.name === "print_settings"))
    d.exec("ALTER TABLE users ADD COLUMN print_settings TEXT");
  if (!(d.prepare("PRAGMA table_info(workspaces)").all() as { name: string }[]).some((c) => c.name === "print_presets"))
    d.exec("ALTER TABLE workspaces ADD COLUMN print_presets TEXT");
  // Personal tasks (#208, lib/personal-tasks.ts): the person's own task
  // page per workspace ("Aufgabe hinzufügen" in My tasks), when a task was
  // given to someone by another person (doc_tasks.assigned_at, NULL for
  // tasks from before and the person's own), when the person last opened
  // My tasks (users.tasks_seen_at; the badge counts what came since) and
  // which document tasks were ticked off when and by whom (task_done_log,
  // "An diesem Tag erledigt" below a journal day). New tables and columns
  // only – an older version leaves them alone – so the schema number stays.
  d.exec(`CREATE TABLE IF NOT EXISTS personal_task_pages(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,created_at INTEGER NOT NULL,PRIMARY KEY(user_id,workspace_id));
    CREATE INDEX IF NOT EXISTS personal_task_pages_page ON personal_task_pages(page_id);
    CREATE TABLE IF NOT EXISTS task_done_log(id TEXT PRIMARY KEY,page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,row_id TEXT NOT NULL DEFAULT '',text TEXT NOT NULL,user_id TEXT,workspace_id TEXT NOT NULL,at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS task_done_log_at ON task_done_log(workspace_id,at);`);
  if (!(d.prepare("PRAGMA table_info(doc_tasks)").all() as { name: string }[]).some((c) => c.name === "assigned_at"))
    d.exec("ALTER TABLE doc_tasks ADD COLUMN assigned_at INTEGER");
  if (!(d.prepare("PRAGMA table_info(users)").all() as { name: string }[]).some((c) => c.name === "tasks_seen_at"))
    d.exec("ALTER TABLE users ADD COLUMN tasks_seen_at INTEGER");
  // Why a meeting's processing failed, for administrators (#225,
  // lib/meetings.ts): meetings.error_detail next to the message people
  // see. An older version ignores the column, so the schema number stays.
  if (!(d.prepare("PRAGMA table_info(meetings)").all() as { name: string }[]).some((c) => c.name === "error_detail"))
    d.exec("ALTER TABLE meetings ADD COLUMN error_detail TEXT");
  // The people the AI summary gave a task to and nobody has told yet
  // (lib/meetings.ts confirmMeetingAssignees): JSON ids, NULL = none. Tasks
  // from the summary notify only once a person confirms. An older version
  // ignores the column (and notifies at once, as before), so the schema
  // number stays.
  if (!(d.prepare("PRAGMA table_info(meetings)").all() as { name: string }[]).some((c) => c.name === "assignees_pending"))
    d.exec("ALTER TABLE meetings ADD COLUMN assignees_pending TEXT");
  // The "Marketplace-Prüfung" permission of an API token (lib/api-tokens.ts,
  // lib/marketplace-check.ts): 1 = the token may run the import check of
  // marketplace packages. An older version ignores the column (its tokens
  // just can't run the check), so the schema number stays.
  if (!(d.prepare("PRAGMA table_info(api_tokens)").all() as { name: string }[]).some((c) => c.name === "marketplace_check"))
    d.exec("ALTER TABLE api_tokens ADD COLUMN marketplace_check INTEGER NOT NULL DEFAULT 0");
  // Sharing and publishing a single record (#231, lib/record-share.ts):
  // record_shares holds the record's links (kind 'link', with role,
  // password and end date like share_links) and its publication (kind
  // 'publication', at most one, viewer only). include_children is the
  // extension point for sub-pages under records and stays 0 for now.
  // record_share_fields: the properties visitors see, chosen per record
  // (no row: the default); record_share_requests the guest writes per
  // link and minute, as share_requests for page links. New tables only – an older version leaves them
  // alone (its links simply do not open) – so the schema number stays.
  d.exec(`CREATE TABLE IF NOT EXISTS record_shares(token TEXT PRIMARY KEY,page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,row_id TEXT NOT NULL REFERENCES rows(id) ON DELETE CASCADE,kind TEXT NOT NULL CHECK(kind IN ('link','publication')),name TEXT NOT NULL DEFAULT '',role TEXT NOT NULL CHECK(role IN ('viewer','commenter','editor')),include_children INTEGER NOT NULL DEFAULT 0,password_hash TEXT,expires_at INTEGER,created_by TEXT REFERENCES users(id),created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS record_shares_row ON record_shares(row_id,kind);
    CREATE INDEX IF NOT EXISTS record_shares_page ON record_shares(page_id);
    CREATE TABLE IF NOT EXISTS record_share_fields(row_id TEXT PRIMARY KEY REFERENCES rows(id) ON DELETE CASCADE,fields TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS record_share_requests(token TEXT NOT NULL REFERENCES record_shares(token) ON DELETE CASCADE,created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS record_share_requests_token ON record_share_requests(token,created_at);`);
  // The quick search's personal visit history (#243, lib/search-visits.ts):
  // per person and page (row_id '') or record the last visit minutes,
  // newest first, comma-separated. Private to the person; bounded in
  // number and age. A new table only – the schema number stays.
  d.exec(`CREATE TABLE IF NOT EXISTS search_visits(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,row_id TEXT NOT NULL DEFAULT '',visits TEXT NOT NULL,last_at INTEGER NOT NULL,PRIMARY KEY(user_id,page_id,row_id));
    CREATE INDEX IF NOT EXISTS search_visits_recent ON search_visits(user_id,last_at);
    CREATE INDEX IF NOT EXISTS search_visits_age ON search_visits(last_at);`);
  // The block id of a document task (#249, lib/doc-tasks.ts): a done task
  // whose text changes keeps its entry in task_done_log ("An diesem Tag
  // erledigt"), found by this id. NULL for tasks without an id and those
  // stored before. An older version ignores the column, so the schema
  // number stays.
  if (!(d.prepare("PRAGMA table_info(doc_tasks)").all() as { name: string }[]).some((c) => c.name === "block_id"))
    d.exec("ALTER TABLE doc_tasks ADD COLUMN block_id TEXT");
  // Schema 104 – sub-pages under records (#231, part 3): a page whose
  // parent is a database page may name one of its records in
  // pages.parent_row_id; it then sits under that record (sidebar,
  // breadcrumb, the record's "Unterseiten") and inherits the record's
  // access (lib/permissions.ts). parent_id stays the database page, so
  // every walk of the page tree (trash, moves, spaces, exports, sharing a
  // database) still finds these pages below the database. No foreign key:
  // a record in the trash is not in rows, its sub-pages wait in the trash
  // with it (lib/row-trash.ts). An older version would show them as
  // sub-pages of the database, hence the new number.
  if (!(d.prepare("PRAGMA table_info(pages)").all() as { name: string }[]).some((c) => c.name === "parent_row_id"))
    d.exec("ALTER TABLE pages ADD COLUMN parent_row_id TEXT");
  d.exec("CREATE INDEX IF NOT EXISTS pages_parent_row ON pages(parent_row_id) WHERE parent_row_id IS NOT NULL");
  // Emergency access for trusted contacts (#281, lib/emergency-access.ts):
  // emergency_contacts holds who named whom (holder → contact), the
  // waiting period, an optional length of the access and where a request
  // stands ('invited' until the contact accepts, 'accepted', 'requested'
  // with the end of the waiting period in grant_at, 'granted');
  // emergency_keys the space keys of the holder's encrypted spaces, sealed
  // in the holder's browser for the contact's public key (public_key: the
  // key they were sealed for) and handed out only while access is granted.
  // New tables only – an older version leaves them alone (no access is
  // given there) – so the schema number stays.
  d.exec(`CREATE TABLE IF NOT EXISTS emergency_contacts(id TEXT PRIMARY KEY,holder_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,contact_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,wait_days INTEGER NOT NULL,access_days INTEGER,status TEXT NOT NULL CHECK(status IN ('invited','accepted','requested','granted')),created_at INTEGER NOT NULL,accepted_at INTEGER,requested_at INTEGER,grant_at INTEGER,granted_at INTEGER,expires_at INTEGER,denied_at INTEGER,reminded INTEGER NOT NULL DEFAULT 0,keys_released INTEGER NOT NULL DEFAULT 0,UNIQUE(holder_id,contact_id));
    CREATE INDEX IF NOT EXISTS emergency_contacts_contact ON emergency_contacts(contact_id);
    CREATE INDEX IF NOT EXISTS emergency_contacts_due ON emergency_contacts(status,grant_at);
    CREATE TABLE IF NOT EXISTS emergency_keys(link_id TEXT NOT NULL REFERENCES emergency_contacts(id) ON DELETE CASCADE,space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,key_version INTEGER NOT NULL,sealed TEXT NOT NULL,public_key TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(link_id,space_id,key_version));
    CREATE INDEX IF NOT EXISTS emergency_keys_space ON emergency_keys(space_id);`);
  // Inactivity message per workspace ("dead man's switch", #282,
  // lib/dead-man-switch.ts): deadman_switches holds one switch per person
  // and workspace (gone with the membership: the foreign key on members) –
  // period, note, recipients (JSON), what counts as a sign of life, the
  // coupling to emergency access, and its state: checkin_at the last
  // explicit sign of life (arming, "Ich bin da", saving), warned the bits of
  // the warnings sent (7, 3, 1 days before) with the time of the last,
  // fired_at/fired_to the last sending. workspace_activity the last use of
  // a workspace per person (written at most hourly). mail_queue.from_name
  // the sender's display name of a message. New tables and a nullable
  // column only – an older version leaves them alone – so the schema
  // number stays.
  d.exec(`CREATE TABLE IF NOT EXISTS deadman_switches(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,enabled INTEGER NOT NULL DEFAULT 0,period_days INTEGER NOT NULL,note TEXT NOT NULL DEFAULT '',recipients TEXT NOT NULL DEFAULT '[]',source TEXT NOT NULL DEFAULT 'account' CHECK(source IN ('account','workspace')),grant_emergency INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL DEFAULT 'armed' CHECK(state IN ('armed','fired')),checkin_at INTEGER NOT NULL,warned INTEGER NOT NULL DEFAULT 0,warned_at INTEGER,fired_at INTEGER,fired_to TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(user_id,workspace_id),FOREIGN KEY(workspace_id,user_id) REFERENCES members(workspace_id,user_id) ON DELETE CASCADE);
    CREATE INDEX IF NOT EXISTS deadman_switches_due ON deadman_switches(enabled,state);
    CREATE INDEX IF NOT EXISTS deadman_switches_workspace ON deadman_switches(workspace_id);
    CREATE TABLE IF NOT EXISTS workspace_activity(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,at INTEGER NOT NULL,PRIMARY KEY(user_id,workspace_id));
    CREATE INDEX IF NOT EXISTS workspace_activity_workspace ON workspace_activity(workspace_id);`);
  if (!(d.prepare("PRAGMA table_info(mail_queue)").all() as { name: string }[]).some((c) => c.name === "from_name"))
    d.exec("ALTER TABLE mail_queue ADD COLUMN from_name TEXT");
  // The groups an SSO provider sent at a person's latest OpenID Connect
  // sign-in (#289, lib/sso-group-report.ts), for Administration → Users:
  // the claim read (OIDC_GROUPS_CLAIM), whether it was missing (NULL:
  // unknown), the groups (bounded), the admin group then and whether it was
  // among them. One row per account. A new table only – the schema number
  // stays.
  d.exec("CREATE TABLE IF NOT EXISTS sso_group_reports(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,at INTEGER NOT NULL,claim TEXT NOT NULL,claim_missing INTEGER,groups_json TEXT NOT NULL DEFAULT '[]',group_count INTEGER NOT NULL DEFAULT 0,admin_group TEXT NOT NULL,has_admin INTEGER NOT NULL DEFAULT 0)");
  // The introduction's follow-up (lib/getting-started.ts, lib/sample-space.ts):
  // getting_started holds per person and workspace the checklist "Erste
  // Schritte" – when it started (the introduction ended), whether it is
  // hidden, what the person said they use Flowplan for and where they come
  // from, and which items are done when (JSON {item: ms}). sample_spaces
  // names the "Beispielbereich" a person created from the introduction and
  // the pages created in it (JSON ids), so removing it removes exactly
  // those. New tables only – an older version leaves them alone (no
  // checklist, the sample is an ordinary space) – so the schema number stays.
  d.exec(`CREATE TABLE IF NOT EXISTS getting_started(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,started_at INTEGER NOT NULL,hidden_at INTEGER,goal TEXT,source TEXT,done TEXT NOT NULL DEFAULT '{}',PRIMARY KEY(user_id,workspace_id));
    CREATE INDEX IF NOT EXISTS getting_started_workspace ON getting_started(workspace_id);
    CREATE TABLE IF NOT EXISTS sample_spaces(space_id TEXT PRIMARY KEY REFERENCES spaces(id) ON DELETE CASCADE,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,page_ids TEXT NOT NULL DEFAULT '[]',created_at INTEGER NOT NULL,UNIQUE(workspace_id,user_id));
    CREATE INDEX IF NOT EXISTS sample_spaces_user ON sample_spaces(user_id);`);
  // Invitation links for several people (#320, lib/invite-links.ts): per
  // link the SHA-256 of its token (the lookup; the token itself is never
  // stored in the clear), a sealed copy for "Copy" (AES-GCM, bound to the
  // link's id), role and guest flag, an optional limit of joins with the
  // count, the expiry and when it was revoked. A new table only – an older
  // version leaves it alone (its links simply do not open) – so the schema
  // number stays.
  d.exec(`CREATE TABLE IF NOT EXISTS invite_links(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,token_hash TEXT NOT NULL UNIQUE,token_sealed TEXT,role TEXT NOT NULL CHECK(role IN ('editor','viewer')),guest INTEGER NOT NULL DEFAULT 0,max_uses INTEGER,uses INTEGER NOT NULL DEFAULT 0,expires_at INTEGER NOT NULL,created_by TEXT REFERENCES users(id),created_at INTEGER NOT NULL,revoked_at INTEGER);
    CREATE INDEX IF NOT EXISTS invite_links_workspace ON invite_links(workspace_id,expires_at);`);
  // "Als Bibliothek anzeigen" per space (#329, lib/library.ts): 1 shows the
  // space as a library of books instead of its whole tree in the sidebar.
  // An older version ignores the column (the space shows as before), so
  // the schema number stays.
  if (!(d.prepare("PRAGMA table_info(spaces)").all() as { name: string }[]).some((c) => c.name === "library"))
    d.exec("ALTER TABLE spaces ADD COLUMN library INTEGER NOT NULL DEFAULT 0");
  // Formatted notification messages (#330, lib/notify-text.ts):
  // notifications.markup holds the inline Markdown of a workflow's or a
  // rule's message (with the title) when it has formatting; `body` stays
  // its plain text for every other channel. A nullable column only – an
  // older version reads the plain body – so the schema number stays.
  if (!(d.prepare("PRAGMA table_info(notifications)").all() as { name: string }[]).some((c) => c.name === "markup"))
    d.exec("ALTER TABLE notifications ADD COLUMN markup TEXT");
  migrateFlashcards(d);
  migrateStudyReminders(d);
  migrateServerMetrics(d);
  migrateErrorDetails(d);
  migrateSharedJobState(d);
  migrateRestartEvents(d);
  // Schema 105 – suspended new cards (#341, docs/specs/flashcards.md §8.1).
  migrateSuspendedNewCards(d);
  // FSRS weights per part of a deck (#344, lib/study-params.ts):
  // study_prefs.group_params of the deck's row holds the person's weights
  // per sub-deck and card type (JSON). A nullable column only – an older
  // version ignores it (those cards then use the deck's weights) – so the
  // schema number stays.
  if (!(d.prepare("PRAGMA table_info(study_prefs)").all() as { name: string }[]).some((c) => c.name === "group_params"))
    d.exec("ALTER TABLE study_prefs ADD COLUMN group_params TEXT");
  // Schema 106 – indexes for the permission checks and the page tree
  // (#383): the groups and workspaces of a person (every grant check asks
  // for the groups, the sidebar for the memberships), the pages below a
  // page, and the records with their own access (most records inherit, so
  // this index stays small; the checks of record permissions read only
  // these). Indexes only – an older version uses them as well – but the
  // number tells PostgreSQL to add them (lib/db-driver/pg-current.ts).
  d.exec(`CREATE INDEX IF NOT EXISTS group_members_user ON group_members(user_id);
    CREATE INDEX IF NOT EXISTS members_user ON members(user_id);
    CREATE INDEX IF NOT EXISTS pages_parent ON pages(parent_id);
    CREATE INDEX IF NOT EXISTS rows_restricted ON rows(page_id) WHERE access<>'inherit';`);
  // Schema 107 – AI quotas (#382, lib/ai/quota.ts).
  migrateAiQuotas(d);
  // Schema 108 – the links in the text of pages and records (#383,
  // lib/text-links.ts) for the backlinks, instead of a LIKE over all HTML
  // on every page GET. The triggers mark changed sources (also when an
  // older version writes); the data step "text-links-107" marks all once.
  migrateTextLinks(d);
  // Schema 109 – version counters for what the bootstrap caches across
  // requests (#383, lib/cache-versions.ts): the roles of pages and the page
  // list of a workspace. Triggers move them with every write that can
  // change them, also by an older version or another instance.
  migrateCacheVersions(d);
  // Schema 110 – the previews of record texts kept (#383,
  // lib/record-previews.ts) instead of sanitising every record's HTML on
  // every opening of its database.
  migrateRecordPreviews(d);
  // Schema 115 – widget pushes (iOS) and profiles whose app keeps its
  // registration without notifications (lib/widget-push.ts).
  migrateWidgetPush(d);
  // Schema 116 – a notebook's attachments (lib/notebook.ts, #392).
  migrateNotebookAttachments(d);
  // Schema 117 – the AI model per person, group and role (lib/ai/model-policy.ts).
  migrateAiModelRules(d);
  // Schema 118 – a change of a space (order, name, icon) moves its
  // workspace's "pages:" version: the live signal tells the other tabs.
  migrateSpaceVersions(d);
  // Schema 119 – a pending change of the e-mail address (#405,
  // lib/email-change.ts): the new address on its links in auth_tokens.
  migrateEmailChange(d);
  // Schema 120 – limits per group (lib/user-limits.ts) and the model after
  // a used-up AI quota (lib/ai/quota.ts).
  migrateGroupLimits(d);
  // Schema 121 – accounts with an unconfirmed address marked for deletion
  // (#436, lib/unconfirmed-deletion.ts).
  migrateUnconfirmedDeletions(d);
  // Schema 122 – a limit for going on after a used-up AI quota
  // (lib/ai/quota.ts): after_limits and the usage of the continuation.
  migrateAiAfterLimits(d);
  // Schema 123 – directory group memberships made by hand (#451,
  // lib/directory-groups.ts).
  migrateDirectoryGroupMembers(d);
  // Schema 124 – the highlight colour of a text comment thread (#450).
  migrateInlineThreadColor(d);
  // Schema 125 – formatted page and record comments with attachments,
  // page mentions and link previews (#450, lib/comment-extras.ts).
  migrateCommentRichBody(d);
  // A database from a newer version keeps its number.
  if (Number((d.prepare("PRAGMA user_version").get() as { user_version: number }).user_version) < SCHEMA_VERSION)
    d.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
  forgetStatements(d);
  globalDb.flowplanSchema = SCHEMA_VERSION;
}
// Schema 124 – the highlight colour of a text comment thread (#450,
// lib/comment-colors.ts): inline_threads.color holds a palette name of the
// text background colours ("blue", "green", …); NULL is the default yellow,
// so every older thread stays as it was. An older version would show every
// thread yellow and drop the colour on its next write, hence the number.
function migrateInlineThreadColor(d: DatabaseSync) {
  if (!(d.prepare("PRAGMA table_info(inline_threads)").all() as { name: string }[]).some((c) => c.name === "color"))
    d.exec("ALTER TABLE inline_threads ADD COLUMN color TEXT");
}
// Schema 123 – directory group memberships made by hand by an administrator
// (#451, lib/directory-groups.ts, Administration → Benutzer and Grenzen pro
// Gruppe):
// - scim_group_members.added_by/added_at: who added this member of a SCIM
//   group by hand and when (NULL: the SCIM client did). Such members are
//   ordinary members of the SCIM group – SCIM clients see them in GET
//   /Groups when the person is a SCIM user – and a SCIM DELETE /Users
//   keeps them.
// - directory_group_members: hand-made memberships of directory groups that
//   come from LDAP or the SSO sign-in (no SCIM group of that name). Those
//   sources are recomputed on every sync and sign-in, so the hand-made
//   membership is kept apart and merged in by lib/person-groups.ts. The
//   name is the exact group name (the key "dir:<name>").
// An older version would ignore both (the hand-made members of LDAP/SSO
// groups would lose their limits, SCIM ones would lose their marker),
// hence the number.
function migrateDirectoryGroupMembers(d: DatabaseSync) {
  const columns = (d.prepare("PRAGMA table_info(scim_group_members)").all() as { name: string }[]).map((c) => c.name);
  if (!columns.includes("added_by")) d.exec("ALTER TABLE scim_group_members ADD COLUMN added_by TEXT");
  if (!columns.includes("added_at")) d.exec("ALTER TABLE scim_group_members ADD COLUMN added_at INTEGER");
  d.exec(`CREATE TABLE IF NOT EXISTS directory_group_members(name TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,added_by TEXT,added_at INTEGER NOT NULL,PRIMARY KEY(name,user_id));
    CREATE INDEX IF NOT EXISTS directory_group_members_user ON directory_group_members(user_id);`);
}
// Schema 122 – a limit for the continuation after a used-up AI quota
// ("Danach: weiter mit <Modell>", after_model):
// - ai_quota_rules.after_limits: per period (JSON like limits, in the
//   quota's unit) how much a person may use with that model once the
//   rule's own limits are used up; NULL or {}: unlimited, as before.
// - ai_quota_after_usage: the tokens of the requests sent with the model
//   after the quota, per day in the quota's time zone, person and model –
//   besides ai_quota_usage, where they count as before (the person, the
//   instance ceiling). Kept 400 days like ai_quota_usage. An older version
//   would neither stop at the limit nor count the continuation, hence the
//   number.
// Schema 125 – page and record comments like text comments (#450):
// comments.rich_body holds the formatted comment (lib/comment-content.ts)
// with its attachments, page mentions and link previews, as
// inline_messages.rich_body does; `body` stays its plain text (search,
// exports, older versions). NULL for every comment written before. An
// older version shows such a comment as its plain text without the files,
// hence the number.
function migrateCommentRichBody(d: DatabaseSync) {
  if (!(d.prepare("PRAGMA table_info(comments)").all() as { name: string }[]).some((c) => c.name === "rich_body"))
    d.exec("ALTER TABLE comments ADD COLUMN rich_body TEXT");
}
function migrateAiAfterLimits(d: DatabaseSync) {
  if (!(d.prepare("PRAGMA table_info(ai_quota_rules)").all() as { name: string }[]).some((c) => c.name === "after_limits"))
    d.exec("ALTER TABLE ai_quota_rules ADD COLUMN after_limits TEXT");
  d.exec(`CREATE TABLE IF NOT EXISTS ai_quota_after_usage(day TEXT NOT NULL,user_id TEXT NOT NULL,model TEXT NOT NULL DEFAULT '',requests INTEGER NOT NULL DEFAULT 0,tokens_in INTEGER NOT NULL DEFAULT 0,tokens_out INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(day,user_id,model));
    CREATE INDEX IF NOT EXISTS ai_quota_after_usage_user ON ai_quota_after_usage(user_id,day);`);
}
// Schema 121 – deleting accounts whose e-mail address was never confirmed
// (#436, lib/unconfirmed-deletion.ts): one row per marked account with the
// day of deletion, when the reminder went out, who marked it (NULL: the
// automatic rule) and, once an administrator cancelled it, when – the
// automatic rule does not mark such an account again. Confirming the
// address removes the row. An older version would neither delete nor
// remind, hence the number.
function migrateUnconfirmedDeletions(d: DatabaseSync) {
  d.exec("CREATE TABLE IF NOT EXISTS unconfirmed_deletions(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,due_at INTEGER NOT NULL,marked_at INTEGER NOT NULL,marked_by TEXT,reminder_at INTEGER,cancelled_at INTEGER)");
}
// Schema 120 – limits per group and the model after a used-up AI quota:
// - group_limits: storage, own workspaces and the largest upload (JSON, the
//   fields of users.limits) for the members of a group – target a
//   workspace group's id or "dir:<name>" for a directory group (SCIM, LDAP
//   or the groups of an SSO sign-in, lib/person-groups.ts). A person gets
//   their own value, else the most generous of their groups', else the
//   instance's default (lib/user-limits.ts).
// - ai_quota_rules.after_model/after_kind: once the personal limit of a
//   rule is used up, requests continue with this model of the instance's
//   provider (chosen for that provider kind) instead of being refused –
//   counted, not limited; the instance ceiling still applies. NULL: AI
//   stops (as before). An older version would ignore both, hence the
//   number.
function migrateGroupLimits(d: DatabaseSync) {
  d.exec("CREATE TABLE IF NOT EXISTS group_limits(target TEXT PRIMARY KEY,limits TEXT NOT NULL DEFAULT '{}',updated_at INTEGER NOT NULL)");
  const columns = (d.prepare("PRAGMA table_info(ai_quota_rules)").all() as { name: string }[]).map((c) => c.name);
  if (!columns.includes("after_model")) d.exec("ALTER TABLE ai_quota_rules ADD COLUMN after_model TEXT");
  if (!columns.includes("after_kind")) d.exec("ALTER TABLE ai_quota_rules ADD COLUMN after_kind TEXT");
}
// Schema 119 – changing one's own e-mail address (#405, lib/email-change.ts):
// auth_tokens.email, the new address a pending change waits for. Its two
// links (kinds 'email-change' to the new address, 'email-cancel' to the
// old one) carry it; the account's address changes only when the first is
// opened. An older version ignores the column (and the kinds), but its
// link would then confirm nothing – hence the number.
function migrateEmailChange(d: DatabaseSync) {
  if (!(d.prepare("PRAGMA table_info(auth_tokens)").all() as { name: string }[]).some((c) => c.name === "email"))
    d.exec("ALTER TABLE auth_tokens ADD COLUMN email TEXT");
}
// Schema 118 – what the sidebar shows of a space (its place in the order,
// name, icon, colour, …) moves "pages:<workspace>" (lib/cache-versions.ts)
// like a page does: the workspace's live signal (lib/workspace-live.ts) then
// tells the other members' tabs to fetch the sidebar again. Before, a space
// moved or renamed by someone else showed up only with the minute's safety
// refresh. An older version does not move the version (the others then wait
// for that refresh), hence the number.
function migrateSpaceVersions(d: DatabaseSync) {
  const pages = (workspace: string) =>
    `INSERT INTO cache_versions(name,version) SELECT 'pages:'||COALESCE(${workspace},''),0 WHERE NOT EXISTS(SELECT 1 FROM cache_versions WHERE name='pages:'||COALESCE(${workspace},'')); UPDATE cache_versions SET version=(random() % 9007199254740991) WHERE name='pages:'||COALESCE(${workspace},'');`;
  d.exec(`CREATE TRIGGER IF NOT EXISTS cache_spaces_list_insert AFTER INSERT ON spaces BEGIN ${pages("NEW.workspace_id")} END;
    CREATE TRIGGER IF NOT EXISTS cache_spaces_list_update AFTER UPDATE ON spaces BEGIN ${pages("NEW.workspace_id")} END;
    CREATE TRIGGER IF NOT EXISTS cache_spaces_list_delete AFTER DELETE ON spaces BEGIN ${pages("OLD.workspace_id")} END;`);
}
// Schema 117 – the AI model per person, workspace group and role
// (lib/ai/model-policy.ts): ai_model_rules holds, per level (scope 'role',
// 'group', 'user'; target the role, group or account), the model of the
// instance's provider these people use instead of the instance's default
// ('' on a person: the instance's default, whatever their groups say), and
// the provider kind it was chosen for – a rule for another kind than the
// instance's current one does not apply. An older version would send every
// request with the instance's model, hence the number.
export function migrateAiModelRules(d: DatabaseSync) {
  d.exec(`CREATE TABLE IF NOT EXISTS ai_model_rules(scope TEXT NOT NULL CHECK(scope IN ('role','group','user')),target TEXT NOT NULL,model TEXT NOT NULL DEFAULT '',kind TEXT NOT NULL DEFAULT '',updated_at INTEGER NOT NULL,PRIMARY KEY(scope,target));`);
}
// Schema 116 – PDFs attached to a notebook without becoming sheets (#392,
// lib/notebook.ts): notebooks.attachments, a JSON list of the files (of the
// notebook page) in their order. They open in the side panel beside the
// sheets. An older version ignores the column, but would drop the list
// when it copies or restores a notebook – hence the new number.
function migrateNotebookAttachments(d: DatabaseSync) {
  if (!(d.prepare("PRAGMA table_info(notebooks)").all() as { name: string }[]).some((c) => c.name === "attachments"))
    d.exec("ALTER TABLE notebooks ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'");
}
// Schema 115 – widget pushes (lib/widget-push.ts, iOS 26 WidgetKit push
// through the relay, type "widgets") and app profiles that stay registered
// while another one is active:
// - mobile_devices.push_enabled: 0 for an installation whose profile is not
//   the active one in the app (registered with `push: false`, or switched by
//   POST /api/mobile/device): it keeps its device token for the summary and
//   widgets, but gets no notifications (lib/push.ts drops its deliveries).
// - mobile_widget_push: the relay token of the app's widget push
//   registration (sealed, bound to the device), with when changes are
//   waiting (pending_since) and when the last push went (sent_at, the
//   budget: at most one per device every 5 minutes). Several profiles of
//   one app share the phone's widget token: one push reaches them all.
// - widget_push_dirty: what changed since the last round – a person ('u')
//   or a workspace ('w', for its members) – with the time of the first
//   change (the debounce). The triggers below only mark (one row per
//   person or workspace, never updated), and only while some app has a
//   widget push registration; the push worker expands and sends.
// An older version would send notifications to `push: false` installations,
// hence the new number.
function migrateWidgetPush(d: DatabaseSync) {
  if (!(d.prepare("PRAGMA table_info(mobile_devices)").all() as { name: string }[]).some((c) => c.name === "push_enabled"))
    d.exec("ALTER TABLE mobile_devices ADD COLUMN push_enabled INTEGER NOT NULL DEFAULT 1");
  const guard = "EXISTS(SELECT 1 FROM mobile_widget_push)";
  const person = (user: string) =>
    `INSERT INTO widget_push_dirty(scope,key,at) SELECT 'u',${user},unixepoch()*1000 WHERE ${user} IS NOT NULL AND NOT EXISTS(SELECT 1 FROM widget_push_dirty x WHERE x.scope='u' AND x.key=${user});`;
  const workspace = (wid: string) =>
    `INSERT INTO widget_push_dirty(scope,key,at) SELECT 'w',${wid},unixepoch()*1000 WHERE ${wid} IS NOT NULL AND NOT EXISTS(SELECT 1 FROM widget_push_dirty x WHERE x.scope='w' AND x.key=${wid});`;
  const ofPage = (page: string) =>
    `INSERT INTO widget_push_dirty(scope,key,at) SELECT 'w',p.workspace_id,unixepoch()*1000 FROM pages p WHERE p.id=${page} AND p.workspace_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM widget_push_dirty x WHERE x.scope='w' AND x.key=p.workspace_id);`;
  d.exec(`CREATE TABLE IF NOT EXISTS mobile_widget_push(device_id TEXT PRIMARY KEY REFERENCES mobile_devices(id) ON DELETE CASCADE,relay_token TEXT NOT NULL,token_hash TEXT NOT NULL,created_at INTEGER NOT NULL,pending_since INTEGER,sent_at INTEGER);
    CREATE INDEX IF NOT EXISTS mobile_widget_push_token ON mobile_widget_push(token_hash);
    CREATE INDEX IF NOT EXISTS mobile_widget_push_pending ON mobile_widget_push(pending_since) WHERE pending_since IS NOT NULL;
    CREATE TABLE IF NOT EXISTS widget_push_dirty(scope TEXT NOT NULL CHECK(scope IN ('u','w')),key TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(scope,key));
    CREATE INDEX IF NOT EXISTS widget_push_dirty_at ON widget_push_dirty(at);
    CREATE TRIGGER IF NOT EXISTS widget_push_notification_insert AFTER INSERT ON notifications WHEN ${guard} BEGIN ${person("NEW.user_id")} END;
    CREATE TRIGGER IF NOT EXISTS widget_push_notification_read AFTER UPDATE OF read_at ON notifications WHEN ${guard} AND NEW.read_at IS NOT OLD.read_at BEGIN ${person("NEW.user_id")} END;
    CREATE TRIGGER IF NOT EXISTS widget_push_row_insert AFTER INSERT ON rows WHEN ${guard} BEGIN ${ofPage("NEW.page_id")} END;
    CREATE TRIGGER IF NOT EXISTS widget_push_row_update AFTER UPDATE OF cells,page_id ON rows WHEN ${guard} BEGIN ${ofPage("NEW.page_id")} END;
    CREATE TRIGGER IF NOT EXISTS widget_push_row_delete AFTER DELETE ON rows WHEN ${guard} BEGIN ${ofPage("OLD.page_id")} END;
    CREATE TRIGGER IF NOT EXISTS widget_push_page_insert AFTER INSERT ON pages WHEN ${guard} BEGIN ${workspace("NEW.workspace_id")} END;
    CREATE TRIGGER IF NOT EXISTS widget_push_page_update AFTER UPDATE OF title,icon,deleted_at,parent_id ON pages WHEN ${guard} BEGIN ${workspace("NEW.workspace_id")} END;
    CREATE TRIGGER IF NOT EXISTS widget_push_task_insert AFTER INSERT ON doc_tasks WHEN ${guard} BEGIN ${workspace("NEW.workspace_id")} END;
    CREATE TRIGGER IF NOT EXISTS widget_push_task_update AFTER UPDATE OF checked,text,due,assignee ON doc_tasks WHEN ${guard} BEGIN ${workspace("NEW.workspace_id")} END;
    CREATE TRIGGER IF NOT EXISTS widget_push_task_delete AFTER DELETE ON doc_tasks WHEN ${guard} BEGIN ${workspace("OLD.workspace_id")} END;
    CREATE TRIGGER IF NOT EXISTS widget_push_time_insert AFTER INSERT ON time_entries WHEN ${guard} BEGIN ${person("NEW.user_id")} END;
    CREATE TRIGGER IF NOT EXISTS widget_push_time_update AFTER UPDATE ON time_entries WHEN ${guard} BEGIN ${person("NEW.user_id")} END;
    CREATE TRIGGER IF NOT EXISTS widget_push_focus_insert AFTER INSERT ON widget_focus WHEN ${guard} BEGIN ${person("NEW.user_id")} END;
    CREATE TRIGGER IF NOT EXISTS widget_push_focus_update AFTER UPDATE ON widget_focus WHEN ${guard} BEGIN ${person("NEW.user_id")} END;
    CREATE TRIGGER IF NOT EXISTS widget_push_review_insert AFTER INSERT ON review_log WHEN ${guard} BEGIN ${person("NEW.user_id")} END;
    CREATE TRIGGER IF NOT EXISTS widget_push_dashboard_update AFTER UPDATE OF tiles ON dashboards WHEN ${guard} BEGIN ${ofPage("NEW.page_id")} END;`);
}
// Schema 108 – text links (lib/text-links.ts): text_links per source (a
// page's document: page_id, row_id ''; a record's text: page_id '',
// row_id) and target ('p:<page id>', 'r:<record id>'), text_link_dirty the
// sources to read again. No foreign keys (page_id or row_id is ''): the
// delete triggers drop the links of a source that is gone.
function migrateTextLinks(d: DatabaseSync) {
  const mark = (page: string, row: string) =>
    `INSERT INTO text_link_dirty(page_id,row_id) SELECT ${page},${row} WHERE NOT EXISTS(SELECT 1 FROM text_link_dirty WHERE page_id=${page} AND row_id=${row});`;
  d.exec(`CREATE TABLE IF NOT EXISTS text_links(page_id TEXT NOT NULL DEFAULT '',row_id TEXT NOT NULL DEFAULT '',target TEXT NOT NULL,PRIMARY KEY(target,page_id,row_id));
    CREATE INDEX IF NOT EXISTS text_links_source ON text_links(page_id,row_id);
    CREATE TABLE IF NOT EXISTS text_link_dirty(page_id TEXT NOT NULL DEFAULT '',row_id TEXT NOT NULL DEFAULT '',PRIMARY KEY(page_id,row_id));
    CREATE TRIGGER IF NOT EXISTS text_links_document_insert AFTER INSERT ON documents BEGIN ${mark("NEW.page_id", "''")} END;
    CREATE TRIGGER IF NOT EXISTS text_links_document_update AFTER UPDATE OF html ON documents WHEN NEW.html IS NOT OLD.html BEGIN ${mark("NEW.page_id", "''")} END;
    CREATE TRIGGER IF NOT EXISTS text_links_document_delete AFTER DELETE ON documents BEGIN DELETE FROM text_links WHERE page_id=OLD.page_id AND row_id=''; DELETE FROM text_link_dirty WHERE page_id=OLD.page_id AND row_id=''; END;
    CREATE TRIGGER IF NOT EXISTS text_links_row_insert AFTER INSERT ON rows WHEN COALESCE(NEW.content,'')<>'' BEGIN ${mark("''", "NEW.id")} END;
    CREATE TRIGGER IF NOT EXISTS text_links_row_update AFTER UPDATE OF content ON rows WHEN NEW.content IS NOT OLD.content BEGIN ${mark("''", "NEW.id")} END;
    CREATE TRIGGER IF NOT EXISTS text_links_row_delete AFTER DELETE ON rows BEGIN DELETE FROM text_links WHERE page_id='' AND row_id=OLD.id; DELETE FROM text_link_dirty WHERE page_id='' AND row_id=OLD.id; END;
    CREATE TRIGGER IF NOT EXISTS text_links_row_document_insert AFTER INSERT ON row_documents BEGIN ${mark("''", "NEW.row_id")} END;
    CREATE TRIGGER IF NOT EXISTS text_links_row_document_update AFTER UPDATE OF html ON row_documents WHEN NEW.html IS NOT OLD.html BEGIN ${mark("''", "NEW.row_id")} END;
    CREATE TRIGGER IF NOT EXISTS text_links_row_document_delete AFTER DELETE ON row_documents BEGIN ${mark("''", "OLD.row_id")} END;`);
}
// Schema 109 – cache_versions (lib/cache-versions.ts): a version per name,
// set to a new random value by the triggers below with every change – not
// a count, so a rolled back transaction or a restored backup never brings
// back a value that stood for another state.
// - "roles": everything pageRole() reads (lib/permissions.ts): the place
//   of pages (workspace, space, parent, record), grants, memberships,
//   guests, groups, spaces (owner, visibility, trash), the access of
//   records and their grants, the record trash. Records that inherit their
//   database's access do not count (pageRole() gives them the database's
//   role, whatever else changes), unless the record trash knows them.
// - "pages:<workspace>": any change of a page of that workspace.
// - "people": what the member lists show of accounts (name, address,
//   avatar, disabled); memberships themselves move "roles".
// A missing row counts as 0.
function migrateCacheVersions(d: DatabaseSync) {
  const bump = (name: string) =>
    `INSERT INTO cache_versions(name,version) SELECT ${name},0 WHERE NOT EXISTS(SELECT 1 FROM cache_versions WHERE name=${name}); UPDATE cache_versions SET version=(random() % 9007199254740991) WHERE name=${name};`;
  const roles = bump("'roles'");
  const pages = (workspace: string) => bump(`'pages:'||COALESCE(${workspace},'')`);
  const always = (name: string, table: string) =>
    ["INSERT", "UPDATE", "DELETE"]
      .map((event) => `CREATE TRIGGER IF NOT EXISTS cache_${name}_${event.toLowerCase()} AFTER ${event} ON ${table} BEGIN ${roles} END;`)
      .join("\n    ");
  d.exec(`CREATE TABLE IF NOT EXISTS cache_versions(name TEXT PRIMARY KEY,version INTEGER NOT NULL DEFAULT 0);
    CREATE TRIGGER IF NOT EXISTS cache_pages_insert AFTER INSERT ON pages BEGIN ${roles} ${pages("NEW.workspace_id")} END;
    CREATE TRIGGER IF NOT EXISTS cache_pages_delete AFTER DELETE ON pages BEGIN ${roles} ${pages("OLD.workspace_id")} END;
    CREATE TRIGGER IF NOT EXISTS cache_pages_update AFTER UPDATE ON pages BEGIN ${pages("NEW.workspace_id")} END;
    CREATE TRIGGER IF NOT EXISTS cache_pages_moved AFTER UPDATE OF workspace_id ON pages WHEN NEW.workspace_id IS NOT OLD.workspace_id BEGIN ${pages("OLD.workspace_id")} END;
    CREATE TRIGGER IF NOT EXISTS cache_pages_place AFTER UPDATE OF workspace_id,space_id,parent_id,parent_row_id ON pages
      WHEN NEW.workspace_id IS NOT OLD.workspace_id OR NEW.space_id IS NOT OLD.space_id OR NEW.parent_id IS NOT OLD.parent_id OR NEW.parent_row_id IS NOT OLD.parent_row_id BEGIN ${roles} END;
    ${always("grants", "grants")}
    ${always("members", "members")}
    ${always("guests", "workspace_guests")}
    ${always("group_members", "group_members")}
    ${always("row_grants", "row_grants")}
    ${always("row_trash", "row_trash")}
    CREATE TRIGGER IF NOT EXISTS cache_spaces_insert AFTER INSERT ON spaces BEGIN ${roles} END;
    CREATE TRIGGER IF NOT EXISTS cache_spaces_delete AFTER DELETE ON spaces BEGIN ${roles} END;
    CREATE TRIGGER IF NOT EXISTS cache_spaces_update AFTER UPDATE OF workspace_id,visibility,owner_id,deleted_at ON spaces
      WHEN NEW.workspace_id IS NOT OLD.workspace_id OR NEW.visibility IS NOT OLD.visibility OR NEW.owner_id IS NOT OLD.owner_id OR NEW.deleted_at IS NOT OLD.deleted_at BEGIN ${roles} END;
    CREATE TRIGGER IF NOT EXISTS cache_rows_insert AFTER INSERT ON rows WHEN COALESCE(NEW.access,'inherit')<>'inherit' OR EXISTS(SELECT 1 FROM row_trash WHERE id=NEW.id) BEGIN ${roles} END;
    CREATE TRIGGER IF NOT EXISTS cache_rows_delete AFTER DELETE ON rows WHEN COALESCE(OLD.access,'inherit')<>'inherit' OR EXISTS(SELECT 1 FROM row_trash WHERE id=OLD.id) BEGIN ${roles} END;
    CREATE TRIGGER IF NOT EXISTS cache_rows_update AFTER UPDATE OF access,created_by,page_id ON rows
      WHEN NEW.access IS NOT OLD.access OR NEW.page_id IS NOT OLD.page_id OR (COALESCE(NEW.access,'inherit')<>'inherit' AND NEW.created_by IS NOT OLD.created_by) BEGIN ${roles} END;
    CREATE TRIGGER IF NOT EXISTS cache_users_update AFTER UPDATE OF name,email,avatar,disabled ON users
      WHEN NEW.name IS NOT OLD.name OR NEW.email IS NOT OLD.email OR NEW.avatar IS NOT OLD.avatar OR NEW.disabled IS NOT OLD.disabled BEGIN ${bump("'people'")} END;
    CREATE TRIGGER IF NOT EXISTS cache_users_delete AFTER DELETE ON users BEGIN ${bump("'people'")} END;`);
}
// Schema 110 – row_previews: a record's preview (lib/document-preview.ts)
// as JSON, with the format it was made in; row_preview_dirty the records
// whose text changed since (their record document or legacy content) –
// marked by the triggers, whatever writes them, and made anew when their
// database is opened next.
function migrateRecordPreviews(d: DatabaseSync) {
  const mark = (row: string) => `INSERT INTO row_preview_dirty(row_id) SELECT ${row} WHERE NOT EXISTS(SELECT 1 FROM row_preview_dirty WHERE row_id=${row});`;
  d.exec(`CREATE TABLE IF NOT EXISTS row_previews(row_id TEXT PRIMARY KEY REFERENCES rows(id) ON DELETE CASCADE,preview TEXT NOT NULL,format INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS row_preview_dirty(row_id TEXT PRIMARY KEY REFERENCES rows(id) ON DELETE CASCADE);
    CREATE TRIGGER IF NOT EXISTS row_previews_document_insert AFTER INSERT ON row_documents BEGIN ${mark("NEW.row_id")} END;
    CREATE TRIGGER IF NOT EXISTS row_previews_document_update AFTER UPDATE OF html ON row_documents WHEN NEW.html IS NOT OLD.html BEGIN ${mark("NEW.row_id")} END;
    CREATE TRIGGER IF NOT EXISTS row_previews_document_delete AFTER DELETE ON row_documents WHEN EXISTS(SELECT 1 FROM rows WHERE id=OLD.row_id) BEGIN ${mark("OLD.row_id")} END;
    CREATE TRIGGER IF NOT EXISTS row_previews_content_update AFTER UPDATE OF content ON rows WHEN NEW.content IS NOT OLD.content BEGIN ${mark("NEW.id")} END;`);
}
// Flashcards (docs/specs/flashcards.md §3.3, lib/study.ts):
// - study_cards: the derived index of cards (record × sub: '' the card, 'r'
//   its reverse) of every database with a card mapping
//   (databases.settings.study), rebuilt from rows/row_documents at any time.
//   study_dirty is its queue, filled by the triggers below only for
//   databases with a mapping (row_id '' = the whole database: the mapping
//   changed) and drained before a deck is read (lib/study.ts).
// - card_states: the learning state per person and card (no row = new;
//   state 0 since schema 105: a suspended new card);
//   gone with the membership (foreign key on members – guests of a shared
//   page are members too, lib/page-share.ts) and with the page.
// - review_log: every rating, never changed but for undone_at; the id comes
//   from the client (idempotent). No foreign key on the page: a person's own
//   statistics outlive the trash. zone: the person's time zone then, for
//   replaying the log (lib/fsrs replay).
// - study_prefs: a person's own limits and retention per deck, and with
//   page_id '' their time zone and day start.
// Private to the person: no view for owners or admins (§13.3). New tables
// only – an older version leaves them alone and ignores views of type
// "study" as it ignored "sprint" and "feed" before (lib/database-schema.ts)
// – so the schema number stays.
function migrateFlashcards(d: DatabaseSync) {
  const has = `EXISTS(SELECT 1 FROM databases d WHERE d.page_id=%PAGE% AND instr(d.settings,'"study"')>0)`;
  const deck = (page: string) => has.replace("%PAGE%", page);
  const dirty = (page: string, row: string) => `INSERT INTO study_dirty SELECT ${page},${row} WHERE NOT EXISTS(SELECT 1 FROM study_dirty WHERE page_id=${page} AND row_id=${row});`;
  d.exec(`CREATE TABLE IF NOT EXISTS study_cards(page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,row_id TEXT NOT NULL,sub TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('basic','cloze','typed','choice','occlusion')),position REAL NOT NULL,content_hash TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(page_id,row_id,sub));
    CREATE INDEX IF NOT EXISTS study_cards_row ON study_cards(row_id);
    CREATE TABLE IF NOT EXISTS study_dirty(page_id TEXT NOT NULL,row_id TEXT NOT NULL,PRIMARY KEY(page_id,row_id));
    CREATE TABLE IF NOT EXISTS card_states(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,row_id TEXT NOT NULL,sub TEXT NOT NULL,state INTEGER NOT NULL CHECK(state IN (0,1,2,3)),step INTEGER NOT NULL DEFAULT 0,due INTEGER NOT NULL,due_day TEXT,stability REAL NOT NULL,difficulty REAL NOT NULL,reps INTEGER NOT NULL DEFAULT 0,lapses INTEGER NOT NULL DEFAULT 0,last_review INTEGER NOT NULL,suspended INTEGER NOT NULL DEFAULT 0,buried_day TEXT,orphaned_at INTEGER,version INTEGER NOT NULL DEFAULT 1,updated_at INTEGER NOT NULL,PRIMARY KEY(user_id,row_id,sub),FOREIGN KEY(workspace_id,user_id) REFERENCES members(workspace_id,user_id) ON DELETE CASCADE);
    CREATE INDEX IF NOT EXISTS card_states_due ON card_states(user_id,page_id,due) WHERE suspended=0 AND orphaned_at IS NULL;
    CREATE INDEX IF NOT EXISTS card_states_user_due ON card_states(user_id,due) WHERE suspended=0 AND orphaned_at IS NULL;
    CREATE INDEX IF NOT EXISTS card_states_row ON card_states(row_id);
    CREATE INDEX IF NOT EXISTS card_states_member ON card_states(workspace_id,user_id);
    CREATE TABLE IF NOT EXISTS review_log(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,page_id TEXT NOT NULL,row_id TEXT NOT NULL,sub TEXT NOT NULL,rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 4),state_before INTEGER NOT NULL,reviewed_at INTEGER NOT NULL,day TEXT NOT NULL,zone TEXT NOT NULL,elapsed_days REAL NOT NULL,scheduled_days REAL NOT NULL,duration_ms INTEGER,stability REAL NOT NULL,difficulty REAL NOT NULL,due INTEGER NOT NULL,source TEXT NOT NULL CHECK(source IN ('web','app','offline','import','api')),undone_at INTEGER,received_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS review_log_user_day ON review_log(user_id,day);
    CREATE INDEX IF NOT EXISTS review_log_card ON review_log(user_id,row_id,sub,reviewed_at);
    CREATE INDEX IF NOT EXISTS review_log_page ON review_log(page_id,user_id,day);
    CREATE INDEX IF NOT EXISTS review_log_workspace ON review_log(workspace_id);
    CREATE TABLE IF NOT EXISTS study_prefs(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,page_id TEXT NOT NULL,new_per_day INTEGER,reviews_per_day INTEGER,retention REAL,params TEXT,params_at INTEGER,extra TEXT NOT NULL DEFAULT '{}',time_zone TEXT,day_start INTEGER NOT NULL DEFAULT 4,remind_at TEXT,reminded_day TEXT,updated_at INTEGER NOT NULL,PRIMARY KEY(user_id,page_id));
    CREATE TRIGGER IF NOT EXISTS study_row_insert AFTER INSERT ON rows WHEN ${deck("NEW.page_id")} BEGIN ${dirty("NEW.page_id", "NEW.id")} END;
    CREATE TRIGGER IF NOT EXISTS study_row_update AFTER UPDATE OF cells,content,page_id ON rows WHEN ${deck("NEW.page_id")} OR ${deck("OLD.page_id")} BEGIN ${dirty("OLD.page_id", "OLD.id")} ${dirty("NEW.page_id", "NEW.id")} END;
    CREATE TRIGGER IF NOT EXISTS study_row_delete AFTER DELETE ON rows WHEN ${deck("OLD.page_id")} BEGIN ${dirty("OLD.page_id", "OLD.id")} END;
    CREATE TRIGGER IF NOT EXISTS study_row_document_insert AFTER INSERT ON row_documents WHEN EXISTS(SELECT 1 FROM rows r JOIN databases d ON d.page_id=r.page_id WHERE r.id=NEW.row_id AND instr(d.settings,'"study"')>0) BEGIN INSERT INTO study_dirty SELECT r.page_id,r.id FROM rows r WHERE r.id=NEW.row_id AND NOT EXISTS(SELECT 1 FROM study_dirty WHERE page_id=r.page_id AND row_id=r.id); END;
    CREATE TRIGGER IF NOT EXISTS study_row_document_update AFTER UPDATE OF html ON row_documents WHEN EXISTS(SELECT 1 FROM rows r JOIN databases d ON d.page_id=r.page_id WHERE r.id=NEW.row_id AND instr(d.settings,'"study"')>0) BEGIN INSERT INTO study_dirty SELECT r.page_id,r.id FROM rows r WHERE r.id=NEW.row_id AND NOT EXISTS(SELECT 1 FROM study_dirty WHERE page_id=r.page_id AND row_id=r.id); END;
    CREATE TRIGGER IF NOT EXISTS study_database_insert AFTER INSERT ON databases WHEN instr(NEW.settings,'"study"')>0 BEGIN ${dirty("NEW.page_id", "''")} END;
    CREATE TRIGGER IF NOT EXISTS study_database_settings AFTER UPDATE OF settings ON databases WHEN (instr(NEW.settings,'"study"')>0 OR instr(OLD.settings,'"study"')>0) AND NEW.settings IS NOT OLD.settings BEGIN ${dirty("NEW.page_id", "''")} END;`);
}
// Schema 105 – suspended new cards (#341): card_states allows state 0, a
// new card with a row of its own – only ever suspended (the Anki import
// keeps a suspended card that was never studied suspended; a card whose
// only rating is undone stays suspended the same way). Everything that
// counts new cards counts cards without a row, and every query of due or
// learning cards leaves suspended ones out, so a state-0 row is a
// suspended card and nothing else. SQLite copies the table (its CHECK);
// PostgreSQL gets the wider CHECK in a data step (lib/data-steps.ts,
// "card-states-new-105"). An older version would refuse to write such a
// row back after a rating, hence the new number.
export function migrateSuspendedNewCards(d: DatabaseSync) {
  const table = d.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='card_states'").get() as { sql?: string } | undefined;
  if (!table?.sql || table.sql.includes("state IN (0,1,2,3)")) return;
  const columns = "user_id,workspace_id,page_id,row_id,sub,state,step,due,due_day,stability,difficulty,reps,lapses,last_review,suspended,buried_day,orphaned_at,version,updated_at";
  d.exec("SAVEPOINT card_states_new");
  try {
    d.exec(`CREATE TABLE card_states_105(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,row_id TEXT NOT NULL,sub TEXT NOT NULL,state INTEGER NOT NULL CHECK(state IN (0,1,2,3)),step INTEGER NOT NULL DEFAULT 0,due INTEGER NOT NULL,due_day TEXT,stability REAL NOT NULL,difficulty REAL NOT NULL,reps INTEGER NOT NULL DEFAULT 0,lapses INTEGER NOT NULL DEFAULT 0,last_review INTEGER NOT NULL,suspended INTEGER NOT NULL DEFAULT 0,buried_day TEXT,orphaned_at INTEGER,version INTEGER NOT NULL DEFAULT 1,updated_at INTEGER NOT NULL,PRIMARY KEY(user_id,row_id,sub),FOREIGN KEY(workspace_id,user_id) REFERENCES members(workspace_id,user_id) ON DELETE CASCADE);
      INSERT INTO card_states_105(${columns}) SELECT ${columns} FROM card_states;
      DROP TABLE card_states;
      ALTER TABLE card_states_105 RENAME TO card_states;
      CREATE INDEX IF NOT EXISTS card_states_due ON card_states(user_id,page_id,due) WHERE suspended=0 AND orphaned_at IS NULL;
      CREATE INDEX IF NOT EXISTS card_states_user_due ON card_states(user_id,due) WHERE suspended=0 AND orphaned_at IS NULL;
      CREATE INDEX IF NOT EXISTS card_states_row ON card_states(row_id);
      CREATE INDEX IF NOT EXISTS card_states_member ON card_states(workspace_id,user_id);`);
  } catch (error) {
    d.exec("ROLLBACK TO card_states_new; RELEASE card_states_new");
    throw error;
  }
  d.exec("RELEASE card_states_new");
}
// Study reminders (docs/specs/flashcards.md §10.3, lib/study-reminders.ts):
// - notifications.push_only: 1 for a notification that goes to push (and
//   the other channels a person turned on) but not into the inbox – a
//   study reminder while its inbox channel is off (the default). The
//   inbox, its unread count and the desktop app's feed leave such rows
//   out; the trigger notification_inbox_pref lets them pass.
// - study_prefs.reminder_paused_at: when the one "Lernerinnerungen
//   pausiert" notice went out after 30 days without studying; a rating
//   after it starts the reminders again (remind_at and reminded_day are
//   there since migrateFlashcards).
// Nullable columns and an index only – an older version ignores them (it
// would list a push-only reminder in its inbox, nothing worse) – so the
// schema number stays.
function migrateStudyReminders(d: DatabaseSync) {
  if (!(d.prepare("PRAGMA table_info(notifications)").all() as { name: string }[]).some((c) => c.name === "push_only"))
    d.exec("ALTER TABLE notifications ADD COLUMN push_only INTEGER");
  if (!(d.prepare("PRAGMA table_info(study_prefs)").all() as { name: string }[]).some((c) => c.name === "reminder_paused_at"))
    d.exec("ALTER TABLE study_prefs ADD COLUMN reminder_paused_at INTEGER");
  d.exec("CREATE INDEX IF NOT EXISTS study_prefs_reminders ON study_prefs(remind_at) WHERE page_id='' AND remind_at IS NOT NULL");
}
// Server metrics and detailed AI statistics (lib/server-metrics.ts,
// lib/metrics.ts, Administration → Überwachung → Server and → KI):
// - metrics_server: one row per minute (and instance in cluster mode,
//   '' otherwise) with the process's CPU time and memory, the limits of its
//   container (cgroup) or host, the parts of the memory (V8 heap, external
//   buffers), live documents and connections, the volume of the data and
//   the CPU time per area (JSON, µs). Kept 7 days.
// - metrics_routes: per hour and API route (a pattern, ids replaced; no
//   path a person typed) requests, 5xx, total time and the latency
//   histogram. Kept 7 days.
// - metrics_minute/metrics_hour.client_errors: answers 400–499.
// - metrics_ai_usage: AI requests per day, model, provider (instance or the
//   person's own), workspace, person and feature, with errors, timeouts and
//   response times – counts only, never a prompt or an answer. Kept 90
//   days (metrics_ai keeps the totals per feature longer). Existing
//   metrics_ai rows are copied once with an unknown model (lib/data-steps.ts
//   AI_DETAIL_STEP, both databases), so the detailed view starts with what
//   was counted before.
// New tables and columns with defaults only – an older version leaves them
// alone – so the schema number stays.
function migrateServerMetrics(d: DatabaseSync) {
  d.exec(`CREATE TABLE IF NOT EXISTS metrics_server(at INTEGER NOT NULL,instance TEXT NOT NULL DEFAULT '',wall_ms INTEGER NOT NULL,cpu_us INTEGER NOT NULL,cpu_limit INTEGER NOT NULL,cpu_limited INTEGER NOT NULL DEFAULT 0,rss INTEGER NOT NULL,mem_limit INTEGER NOT NULL,mem_limited INTEGER NOT NULL DEFAULT 0,cgroup_mem INTEGER,heap_used INTEGER NOT NULL DEFAULT 0,heap_total INTEGER NOT NULL DEFAULT 0,external_mem INTEGER NOT NULL DEFAULT 0,array_buffers INTEGER NOT NULL DEFAULT 0,documents INTEGER NOT NULL DEFAULT 0,connections INTEGER NOT NULL DEFAULT 0,streams INTEGER NOT NULL DEFAULT 0,elu INTEGER NOT NULL DEFAULT 0,disk_total INTEGER,disk_free INTEGER,database_bytes INTEGER,upload_bytes INTEGER,active INTEGER,areas TEXT NOT NULL DEFAULT '{}',PRIMARY KEY(at,instance));
    CREATE TABLE IF NOT EXISTS metrics_routes(at INTEGER NOT NULL,route TEXT NOT NULL,requests INTEGER NOT NULL DEFAULT 0,errors INTEGER NOT NULL DEFAULT 0,ms_total INTEGER NOT NULL DEFAULT 0,hist TEXT NOT NULL DEFAULT '',PRIMARY KEY(at,route));`);
  for (const table of ["metrics_minute", "metrics_hour"])
    if (!(d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === "client_errors"))
      d.exec(`ALTER TABLE ${table} ADD COLUMN client_errors INTEGER NOT NULL DEFAULT 0`);
  d.exec(`CREATE TABLE IF NOT EXISTS metrics_ai_usage(day TEXT NOT NULL,model TEXT NOT NULL DEFAULT '',source TEXT NOT NULL DEFAULT '',workspace_id TEXT NOT NULL DEFAULT '',user_id TEXT NOT NULL DEFAULT '',feature TEXT NOT NULL,requests INTEGER NOT NULL DEFAULT 0,tokens_in INTEGER NOT NULL DEFAULT 0,tokens_out INTEGER NOT NULL DEFAULT 0,errors INTEGER NOT NULL DEFAULT 0,timeouts INTEGER NOT NULL DEFAULT 0,ms_total INTEGER NOT NULL DEFAULT 0,hist TEXT NOT NULL DEFAULT '',PRIMARY KEY(day,model,source,workspace_id,user_id,feature));
    CREATE INDEX IF NOT EXISTS metrics_ai_usage_user ON metrics_ai_usage(user_id);`);
}
// AI quotas (#382, lib/ai/quota.ts):
// - ai_quota_usage: tokens of the answered requests with the instance's
//   provider per calendar day (in the quota's time zone), person ('' for the
//   search index and deleted accounts), model and kind ('person',
//   'workflow', 'system'). Written at once – the counts a request is refused
//   on – and kept 400 days. Counts only, never a prompt.
// - ai_quota_rules: the limits per level (scope 'instance', 'default',
//   'role', 'group', 'user'; target '' or the role, group or account) as
//   JSON per period, or exempt.
// - ai_quota_alerts: the highest level per period of the instance ceiling
//   the administrators were told about (warning, then 100 %).
// New tables only; an older version would not keep to the limits, hence
// the number.
export function migrateAiQuotas(d: DatabaseSync) {
  d.exec(`CREATE TABLE IF NOT EXISTS ai_quota_usage(day TEXT NOT NULL,user_id TEXT NOT NULL DEFAULT '',model TEXT NOT NULL DEFAULT '',kind TEXT NOT NULL CHECK(kind IN ('person','workflow','system')),requests INTEGER NOT NULL DEFAULT 0,tokens_in INTEGER NOT NULL DEFAULT 0,tokens_out INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(day,user_id,model,kind));
    CREATE INDEX IF NOT EXISTS ai_quota_usage_user ON ai_quota_usage(user_id,day);
    CREATE TABLE IF NOT EXISTS ai_quota_rules(scope TEXT NOT NULL CHECK(scope IN ('instance','default','role','group','user')),target TEXT NOT NULL DEFAULT '',exempt INTEGER NOT NULL DEFAULT 0,limits TEXT NOT NULL DEFAULT '{}',updated_at INTEGER NOT NULL,PRIMARY KEY(scope,target));
    CREATE TABLE IF NOT EXISTS ai_quota_alerts(period_key TEXT PRIMARY KEY,level INTEGER NOT NULL,at INTEGER NOT NULL);`);
}
// Error details of the monitoring (lib/error-details.ts): one row per kind
// of 5xx (fingerprint: route, command, error name, top stack frame) with
// the scrubbed message, the frames, the database's code, count, first and
// last time, counts per 5 minutes and per hour (JSON) and the last 20
// occurrences (time, request id, status, instance, version, role – JSON).
// No address, body or person. Kept 14 days, at most 500 rows. A new table
// only – an older version leaves it alone – so the schema number stays.
function migrateErrorDetails(d: DatabaseSync) {
  d.exec(`CREATE TABLE IF NOT EXISTS error_groups(fingerprint TEXT PRIMARY KEY,kind TEXT NOT NULL DEFAULT 'request',route TEXT NOT NULL,action TEXT NOT NULL DEFAULT '',name TEXT NOT NULL,message TEXT NOT NULL DEFAULT '',status INTEGER NOT NULL DEFAULT 500,frames TEXT NOT NULL DEFAULT '[]',db_code TEXT NOT NULL DEFAULT '',count INTEGER NOT NULL DEFAULT 0,first_seen INTEGER NOT NULL,last_seen INTEGER NOT NULL,slots TEXT NOT NULL DEFAULT '{}',occurrences TEXT NOT NULL DEFAULT '[]');
    CREATE INDEX IF NOT EXISTS error_groups_last ON error_groups(last_seen);`);
}
// State every instance must see (cluster mode, docs/architecture/database.md
// §14c), on both databases alike:
// - background_jobs.launched: 1 for work started with launchJob (the import
//   page polls its outcome; "an import is already running" counts these),
//   .instance the instance running it, .outcome the result or the error as
//   JSON once it ended, kept until .expires_at (an hour). The running
//   instance marks the row alive (updated_at); a job of another process not
//   marked for a minute counts as interrupted.
// - print_snapshots: a print view opened in Safari (lib/print-snapshots.ts):
//   the SHA-256 of its secret token, the person, its size, the cleaned view
//   itself – or, when large, NULL and the view in the staging area (data
//   folder, the bucket in cluster mode) – and when it expires (15 minutes).
// New columns with defaults and a new table only – an older version leaves
// them alone – so the schema number stays.
function migrateSharedJobState(d: DatabaseSync) {
  const jobColumns = new Set((d.prepare("PRAGMA table_info(background_jobs)").all() as { name: string }[]).map((c) => c.name));
  if (!jobColumns.has("launched")) d.exec("ALTER TABLE background_jobs ADD COLUMN launched INTEGER NOT NULL DEFAULT 0");
  if (!jobColumns.has("instance")) d.exec("ALTER TABLE background_jobs ADD COLUMN instance TEXT NOT NULL DEFAULT ''");
  if (!jobColumns.has("outcome")) d.exec("ALTER TABLE background_jobs ADD COLUMN outcome TEXT");
  if (!jobColumns.has("expires_at")) d.exec("ALTER TABLE background_jobs ADD COLUMN expires_at INTEGER");
  d.exec(`CREATE INDEX IF NOT EXISTS background_jobs_launched ON background_jobs(user_id,kind,status,launched);
    CREATE TABLE IF NOT EXISTS print_snapshots(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,html TEXT,bytes INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS print_snapshots_user ON print_snapshots(user_id);
    CREATE INDEX IF NOT EXISTS print_snapshots_expires ON print_snapshots(expires_at);`);
}
// The restart history of the monitoring (lib/restarts/history.ts): one row
// per previous run that ended – when it was noticed, when the run started
// and ended, its uptime, the reason (clean, crash, oom, killed), signal or
// exit code, the version, its last heartbeat (memory, JSON), the error
// (redacted) and, for an unexpected one, its last 200 log lines (redacted,
// JSON) with their count; `incident` names the alert it belongs to. No
// address, no person. Kept 30 days. A new table only – an older version
// leaves it alone – so the schema number stays.
function migrateRestartEvents(d: DatabaseSync) {
  d.exec(`CREATE TABLE IF NOT EXISTS restart_events(id TEXT PRIMARY KEY,at INTEGER NOT NULL,ended_at INTEGER NOT NULL,instance TEXT NOT NULL DEFAULT '',host TEXT NOT NULL DEFAULT '',previous_start INTEGER NOT NULL,uptime_ms INTEGER NOT NULL DEFAULT 0,reason TEXT NOT NULL,signal TEXT,exit_code INTEGER,version TEXT,heartbeat TEXT,error TEXT,line_count INTEGER NOT NULL DEFAULT 0,log_lines TEXT,incident TEXT);
    CREATE INDEX IF NOT EXISTS restart_events_at ON restart_events(at);
    CREATE INDEX IF NOT EXISTS restart_events_incident ON restart_events(incident);`);
}
// Schema 102 – a workspace's look (#196): workspaces.theme (JSON, NULL =
// Flowplan's own: accent, background tint, typefaces; lib/workspace-theme.ts),
// the faces its owners uploaded (blobs like notebook_templates, counted in
// workspaceBytes and removed with the workspace; lib/workspace-fonts.ts)
// and per person users.plain_look (1 = Flowplan's own look everywhere).
// An older version would ignore the look, hence the new number.
function migrateWorkspaceTheme(d: DatabaseSync) {
  if (!(d.prepare("PRAGMA table_info(workspaces)").all() as { name: string }[]).some((c) => c.name === "theme"))
    d.exec("ALTER TABLE workspaces ADD COLUMN theme TEXT");
  if (!(d.prepare("PRAGMA table_info(users)").all() as { name: string }[]).some((c) => c.name === "plain_look"))
    d.exec("ALTER TABLE users ADD COLUMN plain_look INTEGER NOT NULL DEFAULT 0");
  d.exec(`CREATE TABLE IF NOT EXISTS workspace_fonts(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,name TEXT NOT NULL,mime TEXT NOT NULL,format TEXT NOT NULL CHECK(format IN ('woff2','woff','truetype','opentype')),variable INTEGER NOT NULL DEFAULT 0,data BLOB NOT NULL,created_by TEXT REFERENCES users(id) ON DELETE SET NULL,created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS workspace_fonts_workspace ON workspace_fonts(workspace_id);`);
}
// Schema 103 – meeting notes (#199, lib/meetings.ts): the "/meet" block
// keeps its title, attendees, agenda, summary and transcript in the
// document itself (lib/meeting-schema.ts) – so versions, exports, archives
// and share links carry them. meetings holds what the document cannot: the
// state of the recording and its processing, the sessions ("continue
// later") with their offsets and tracks, the audio kept as files of the
// page (removed after the workspace's retention, audio_until) and who
// confirmed the consent; meeting_reminders the reminder when the block's
// calendar event starts. workspaces.meeting_settings (JSON, NULL = the
// defaults): instructions, retention, consent. api_tokens.ai: the token's
// "KI und Transkription" permission (off unless chosen). An older version
// would not know the block, hence the new number.
function migrateMeetings(d: DatabaseSync) {
  d.exec(`CREATE TABLE IF NOT EXISTS meetings(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,row_id TEXT,created_by TEXT REFERENCES users(id) ON DELETE SET NULL,status TEXT NOT NULL DEFAULT 'new',error TEXT,sessions TEXT NOT NULL DEFAULT '[]',duration_ms INTEGER NOT NULL DEFAULT 0,audio TEXT NOT NULL DEFAULT '[]',audio_until INTEGER,consent_by TEXT REFERENCES users(id) ON DELETE SET NULL,consent_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,summarized_at INTEGER);
    CREATE INDEX IF NOT EXISTS meetings_page ON meetings(page_id);
    CREATE INDEX IF NOT EXISTS meetings_audio_until ON meetings(audio_until);`);
  if (!(d.prepare("PRAGMA table_info(workspaces)").all() as { name: string }[]).some((c) => c.name === "meeting_settings"))
    d.exec("ALTER TABLE workspaces ADD COLUMN meeting_settings TEXT");
  if (!(d.prepare("PRAGMA table_info(api_tokens)").all() as { name: string }[]).some((c) => c.name === "ai"))
    d.exec("ALTER TABLE api_tokens ADD COLUMN ai INTEGER NOT NULL DEFAULT 0");
  // The reminder when the calendar event of a meeting block starts
  // (lib/meeting-reminders.ts): one per block, for whoever linked the event;
  // fired_at makes it fire once per event occurrence (event_key names it).
  d.exec(`CREATE TABLE IF NOT EXISTS meeting_reminders(meeting_id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,row_id TEXT,event_key TEXT NOT NULL,title TEXT NOT NULL DEFAULT '',remind_at INTEGER NOT NULL,fired_at INTEGER,created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS meeting_reminders_due ON meeting_reminders(fired_at,remind_at);`);
}
// A person's stickers per workspace (a picture, or ink items) and a
// workspace's paper templates (a picture or one PDF page), as blobs like
// template_files: counted in workspaceBytes (lib/instance-ops.ts).
function migrateNotebookLibrary(d: DatabaseSync) {
  d.exec(`CREATE TABLE IF NOT EXISTS notebook_stickers(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,name TEXT NOT NULL,mime TEXT NOT NULL,data BLOB,items TEXT,width REAL NOT NULL,height REAL NOT NULL,created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS notebook_stickers_owner ON notebook_stickers(workspace_id,user_id);
    CREATE TABLE IF NOT EXISTS notebook_templates(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,name TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('image','pdf')),mime TEXT NOT NULL,data BLOB NOT NULL,width REAL NOT NULL,height REAL NOT NULL,fit TEXT NOT NULL DEFAULT 'stretch' CHECK(fit IN ('stretch','tile')),created_by TEXT REFERENCES users(id) ON DELETE SET NULL,created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS notebook_templates_workspace ON notebook_templates(workspace_id);`);
}
// Schema 97 – Workflows (#168, renumbered at the final merge, docs/specs/workflows.md §4): one workflow
// per page of kind "workflow" (state, who runs it), its draft as a Yjs
// document, the activated versions (immutable), the triggers of the active
// version for a quick lookup, the event outbox, runs and their steps (the
// queue and the history at once), approvals, inbound hook addresses,
// credentials of HTTP nodes, the AI and e-mail use per day and the
// throttled notices to the people responsible. One block, all
// IF NOT EXISTS: test databases of earlier waves of the branch catch up.
export function migrateWorkflows(d: DatabaseSync) {
  d.exec(`CREATE TABLE IF NOT EXISTS workflows(page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','paused','auto_paused')),active_version_id TEXT,runner_id TEXT REFERENCES users(id) ON DELETE SET NULL,activated_at INTEGER,paused_at INTEGER,paused_by TEXT,pause_reason TEXT NOT NULL DEFAULT '',settings TEXT NOT NULL DEFAULT '{}',failure_streak INTEGER NOT NULL DEFAULT 0,throttled INTEGER NOT NULL DEFAULT 0,last_events TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS workflows_workspace ON workflows(workspace_id,status);
    CREATE INDEX IF NOT EXISTS workflows_runner ON workflows(runner_id);
    CREATE TABLE IF NOT EXISTS workflow_drafts(page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,state BLOB NOT NULL,generation TEXT NOT NULL,updated_by TEXT,updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS workflow_versions(id TEXT PRIMARY KEY,page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,number INTEGER NOT NULL,graph TEXT NOT NULL,graph_hash TEXT NOT NULL,activated_by TEXT,activated_at INTEGER NOT NULL,note TEXT NOT NULL DEFAULT '',UNIQUE(page_id,number));
    CREATE TABLE IF NOT EXISTS workflow_triggers(page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,node_id TEXT NOT NULL,version_id TEXT NOT NULL,workspace_id TEXT NOT NULL,kind TEXT NOT NULL,scope_id TEXT NOT NULL DEFAULT '',config TEXT NOT NULL,inline INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(page_id,node_id));
    CREATE INDEX IF NOT EXISTS workflow_triggers_lookup ON workflow_triggers(workspace_id,kind,scope_id);
    CREATE INDEX IF NOT EXISTS workflow_triggers_kind ON workflow_triggers(kind);
    CREATE TABLE IF NOT EXISTS workflow_events(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,kind TEXT NOT NULL,scope_id TEXT NOT NULL DEFAULT '',page_id TEXT,row_id TEXT,payload TEXT NOT NULL,actor_id TEXT,origin_run_id TEXT,depth INTEGER NOT NULL DEFAULT 0,dedupe_key TEXT UNIQUE,due_at INTEGER NOT NULL,lease_until INTEGER NOT NULL DEFAULT 0,dispatched_at INTEGER,created_at INTEGER NOT NULL,seq INTEGER);
    CREATE INDEX IF NOT EXISTS workflow_events_due ON workflow_events(dispatched_at,due_at,lease_until);
    CREATE TABLE IF NOT EXISTS workflow_runs(id TEXT PRIMARY KEY,page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,workspace_id TEXT NOT NULL,version_id TEXT NOT NULL,runner_id TEXT,mode TEXT NOT NULL DEFAULT 'live' CHECK(mode IN ('live','test','dry')),trigger_node_id TEXT NOT NULL,event_id TEXT,status TEXT NOT NULL CHECK(status IN ('queued','running','waiting','held','succeeded','failed','cancelled')),depth INTEGER NOT NULL DEFAULT 0,origin_run_id TEXT,steps INTEGER NOT NULL DEFAULT 0,ai_tokens INTEGER NOT NULL DEFAULT 0,failed_node_id TEXT,error TEXT,created_at INTEGER NOT NULL,started_at INTEGER,finished_at INTEGER,seq INTEGER);
    CREATE INDEX IF NOT EXISTS workflow_runs_page ON workflow_runs(page_id,created_at);
    CREATE INDEX IF NOT EXISTS workflow_runs_status ON workflow_runs(status,finished_at);
    CREATE INDEX IF NOT EXISTS workflow_runs_origin ON workflow_runs(origin_run_id);
    CREATE INDEX IF NOT EXISTS workflow_runs_workspace ON workflow_runs(workspace_id,created_at);
    CREATE TABLE IF NOT EXISTS workflow_steps(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,node_id TEXT NOT NULL,iteration TEXT NOT NULL DEFAULT '',via TEXT NOT NULL DEFAULT '',status TEXT NOT NULL CHECK(status IN ('queued','running','waiting','succeeded','failed','skipped','cancelled')),attempt INTEGER NOT NULL DEFAULT 0,due_at INTEGER NOT NULL,lease_until INTEGER NOT NULL DEFAULT 0,lease_token TEXT,claimed_by TEXT,open_children INTEGER NOT NULL DEFAULT 0,port TEXT,input TEXT,output TEXT,error TEXT,error_kind TEXT,started_at INTEGER,finished_at INTEGER,created_at INTEGER NOT NULL,seq INTEGER,UNIQUE(run_id,node_id,iteration,via));
    CREATE INDEX IF NOT EXISTS workflow_steps_claim ON workflow_steps(status,due_at);
    CREATE INDEX IF NOT EXISTS workflow_steps_run ON workflow_steps(run_id,seq);
    CREATE TABLE IF NOT EXISTS workflow_approvals(id TEXT PRIMARY KEY,step_id TEXT NOT NULL UNIQUE REFERENCES workflow_steps(id) ON DELETE CASCADE,run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,page_id TEXT NOT NULL,approvers TEXT NOT NULL,message TEXT NOT NULL,decision TEXT CHECK(decision IN ('approved','rejected','timeout','cancelled')),decided_by TEXT,comment TEXT NOT NULL DEFAULT '',expires_at INTEGER,created_at INTEGER NOT NULL,decided_at INTEGER);
    CREATE INDEX IF NOT EXISTS workflow_approvals_open ON workflow_approvals(decision,expires_at);
    CREATE INDEX IF NOT EXISTS workflow_approvals_page ON workflow_approvals(page_id,created_at);
    CREATE TABLE IF NOT EXISTS workflow_hooks(id TEXT PRIMARY KEY,page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,node_id TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,sealed TEXT NOT NULL,mode TEXT NOT NULL DEFAULT 'signed' CHECK(mode IN ('signed','token')),created_at INTEGER NOT NULL,rotated_at INTEGER,last_used_at INTEGER,last_error TEXT,UNIQUE(page_id,node_id));
    CREATE TABLE IF NOT EXISTS workflow_credentials(id TEXT PRIMARY KEY,page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,name TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('bearer','basic','header','query')),host TEXT NOT NULL,sealed TEXT NOT NULL,created_by TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS workflow_credentials_page ON workflow_credentials(page_id);
    CREATE TABLE IF NOT EXISTS workflow_ai_usage(page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,day TEXT NOT NULL,tokens INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(page_id,day));
    CREATE TABLE IF NOT EXISTS workflow_mail_usage(page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,day TEXT NOT NULL,mails INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(page_id,day));
    CREATE TABLE IF NOT EXISTS workflow_notices(page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,kind TEXT NOT NULL,sent_at INTEGER NOT NULL DEFAULT 0,pending INTEGER NOT NULL DEFAULT 0,detail TEXT NOT NULL DEFAULT '',PRIMARY KEY(page_id,kind));`);
  // Wave 2: the kind of a run's failure (limit failures do not count towards the auto-pause).
  if (!(d.prepare("PRAGMA table_info(workflow_runs)").all() as { name: string }[]).some((c) => c.name === "error_kind"))
    d.exec("ALTER TABLE workflow_runs ADD COLUMN error_kind TEXT");
  // "Approve" on the apps' push notifications (§11.8): the verifier of the
  // installation's confirmation key – SHA-256 of a secret that only Face ID
  // / Touch ID / the fingerprint opens on the phone (lib/mobile-devices.ts).
  if (!(d.prepare("PRAGMA table_info(mobile_devices)").all() as { name: string }[]).some((c) => c.name === "approval_key"))
    d.exec("ALTER TABLE mobile_devices ADD COLUMN approval_key TEXT");
  // Insertion order (schema 94): created with seq above; databases from
  // before seq existed on these tables get it like the others.
  for (const table of WORKFLOW_SEQ_TABLES) {
    if (!(d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === "seq"))
      d.exec(`ALTER TABLE ${table} ADD COLUMN seq INTEGER; UPDATE ${table} SET seq=rowid;`);
    d.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_seq AFTER INSERT ON ${table} WHEN NEW.seq IS NULL BEGIN UPDATE ${table} SET seq=NEW.rowid WHERE rowid=NEW.rowid; END;`);
  }
}
// Schema 95: the wider CHECK of issue_connections.provider. SQLite changes
// a CHECK only by copying the table; dropping the old one would delete the
// mappings that reference it (ON DELETE CASCADE), so they are kept aside
// and put back.
export function migrateIssueProviders(d: DatabaseSync) {
  const table = d.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='issue_connections'").get() as { sql?: string } | undefined;
  if (!table?.sql || table.sql.includes("'forgejo'")) return;
  const columns = "id,workspace_id,provider,base_url,repo,token,hook_token,hook_secret,people,state,created_by,created_at";
  const maps = "page_id,connection_id,repo,config,state,created_by,created_at";
  d.exec("SAVEPOINT issue_providers");
  try {
    d.exec(`CREATE TABLE issue_connections_95(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,provider TEXT NOT NULL CHECK(provider IN ('github','gitlab','forgejo')),base_url TEXT NOT NULL DEFAULT '',repo TEXT NOT NULL DEFAULT '',token TEXT NOT NULL,hook_token TEXT NOT NULL UNIQUE,hook_secret TEXT NOT NULL,people TEXT NOT NULL DEFAULT '[]',state TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,created_at INTEGER NOT NULL);
    INSERT INTO issue_connections_95(${columns}) SELECT ${columns} FROM issue_connections;
    CREATE TEMP TABLE issue_sync_maps_95 AS SELECT ${maps} FROM issue_sync_maps;
    DROP TABLE issue_connections;
    ALTER TABLE issue_connections_95 RENAME TO issue_connections;
    CREATE INDEX IF NOT EXISTS issue_connections_workspace ON issue_connections(workspace_id);
    INSERT OR IGNORE INTO issue_sync_maps(${maps}) SELECT ${maps} FROM temp.issue_sync_maps_95;
    DROP TABLE temp.issue_sync_maps_95;`);
  } catch (error) {
    d.exec("ROLLBACK TO issue_providers; RELEASE issue_providers");
    throw error;
  }
  d.exec("RELEASE issue_providers");
}
export function migrateStatusLogUser(d: DatabaseSync) {
  if (!(d.prepare("PRAGMA table_info(row_status_log)").all() as { name: string }[]).some((c) => c.name === "user_id"))
    d.exec("ALTER TABLE row_status_log ADD COLUMN user_id TEXT");
  if (!(d.prepare("PRAGMA table_info(page_view_prefs)").all() as { name: string }[]).some((c) => c.name === "completed_mine"))
    d.exec("ALTER TABLE page_view_prefs ADD COLUMN completed_mine INTEGER");
}
export function migrateRecordPropertyPrefs(d: DatabaseSync) {
  const columns = (d.prepare("PRAGMA table_info(page_view_prefs)").all() as { name: string }[]).map((c) => c.name);
  if (!columns.includes("record_properties_phone")) d.exec("ALTER TABLE page_view_prefs ADD COLUMN record_properties_phone INTEGER");
  if (!columns.includes("record_properties_desktop")) d.exec("ALTER TABLE page_view_prefs ADD COLUMN record_properties_desktop INTEGER");
}
export function migrateGrantKinds(d: DatabaseSync) {
  const columns = (d.prepare("PRAGMA table_info(grants)").all() as { name: string }[]).map((c) => c.name);
  if (!columns.includes("resource_kind")) d.exec("ALTER TABLE grants ADD COLUMN resource_kind TEXT");
  if (!columns.includes("workspace_id")) d.exec("ALTER TABLE grants ADD COLUMN workspace_id TEXT");
  // A grant written without them (an older instance during a rolling
  // update, a direct insert) gets them from its resource – only when the id
  // is a page's or a space's, not both: such a grant counts for nothing.
  d.exec(`CREATE INDEX IF NOT EXISTS grants_workspace ON grants(workspace_id,resource_kind);
    CREATE TRIGGER IF NOT EXISTS grants_resource_kind AFTER INSERT ON grants WHEN NEW.resource_kind IS NULL BEGIN
      UPDATE grants SET resource_kind=CASE WHEN EXISTS(SELECT 1 FROM pages WHERE id=NEW.resource_id) THEN 'page' ELSE 'space' END,workspace_id=COALESCE((SELECT workspace_id FROM pages WHERE id=NEW.resource_id),(SELECT workspace_id FROM spaces WHERE id=NEW.resource_id)) WHERE resource_id IS NEW.resource_id AND user_id IS NEW.user_id AND group_id IS NEW.group_id AND resource_kind IS NULL AND EXISTS(SELECT 1 FROM pages WHERE id=NEW.resource_id)!=EXISTS(SELECT 1 FROM spaces WHERE id=NEW.resource_id);
    END;`);
}
export function migrateFileTrash(d: DatabaseSync) {
  const columns = (d.prepare("PRAGMA table_info(files)").all() as { name: string }[]).map((c) => c.name);
  if (!columns.includes("deleted_at")) d.exec("ALTER TABLE files ADD COLUMN deleted_at TEXT");
  if (!columns.includes("deleted_by")) d.exec("ALTER TABLE files ADD COLUMN deleted_by TEXT");
  d.exec(`CREATE INDEX IF NOT EXISTS files_trashed ON files(page_id) WHERE deleted_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS files_trashed_at ON files(deleted_at) WHERE deleted_at IS NOT NULL;`);
}
// Schema 91 – scopes of tags, property definitions and saved templates
// (#136, lib/meta-scope-server.ts): `space_id` NULL means the whole
// workspace (everything that existed before keeps that scope), otherwise
// the space ("Bereich") it belongs to. Names are
// unique per scope (the workspace, or one space) ignoring case – the rule
// across scopes (a space's names differ from the workspace's) is checked by
// the commands. The unique indexes of schema 82 (per workspace) give way.
export function migrateMetaScopes(d: DatabaseSync) {
  for (const table of ["page_tags", "page_property_defs", "templates"])
    if (!(d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === "space_id"))
      // A deleted space takes its tags and definitions along (its pages are
      // gone); its templates stay as their creators' private ones
      // (keepSpaceTemplates in lib/workspace-lifecycle.ts, SET NULL as the
      // fallback).
      d.exec(`ALTER TABLE ${table} ADD COLUMN space_id TEXT REFERENCES spaces(id) ON DELETE ${table === "templates" ? "SET NULL" : "CASCADE"}`);
  // Schema 94: lower(name) instead of `name COLLATE NOCASE` (the same for
  // SQLite, which folds ASCII in both; PostgreSQL has no NOCASE): queries
  // compare `lower(name)=lower(?)` and use the index.
  for (const index of ["page_tags_scope_name", "page_property_defs_scope_name"])
    if (/NOCASE/i.test((d.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?").get(index) as { sql: string } | undefined)?.sql || ""))
      d.exec(`DROP INDEX ${index}`);
  d.exec(`DROP INDEX IF EXISTS page_tags_name;
    DROP INDEX IF EXISTS page_property_defs_name;
    CREATE UNIQUE INDEX IF NOT EXISTS page_tags_scope_name ON page_tags(workspace_id,ifnull(space_id,''),lower(name));
    CREATE UNIQUE INDEX IF NOT EXISTS page_property_defs_scope_name ON page_property_defs(workspace_id,ifnull(space_id,''),lower(name));
    CREATE INDEX IF NOT EXISTS page_tags_space ON page_tags(space_id);
    CREATE INDEX IF NOT EXISTS page_property_defs_space ON page_property_defs(space_id);
    CREATE INDEX IF NOT EXISTS templates_space ON templates(space_id);`);
}
// Schema 88 – sign-in identities of an account (#101, lib/identities.ts):
// every OpenID Connect identity (issuer and subject) an account signs in
// with, so one account can have several and a local account can be linked
// to SSO. users.subject stays the account's own stable key (local:…,
// ldap:…, scim:…, or issuer|subject of the identity it was created with);
// which account an SSO sign-in belongs to is decided here. The identities
// of existing SSO accounts are copied from their subject once, when the
// table is created. oidc_flows carry the account and session of a "Connect
// SSO" flow; oidc_pending_links hold a first SSO sign-in that waits for the
// person to prove the existing account with the same address.
export function migrateIdentities(d: DatabaseSync) {
  const fresh = !d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='user_identities'").get();
  d.exec(`CREATE TABLE IF NOT EXISTS user_identities(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,provider TEXT NOT NULL DEFAULT 'oidc',issuer TEXT NOT NULL,subject TEXT NOT NULL,email TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,last_used_at INTEGER,UNIQUE(issuer,subject));
    CREATE INDEX IF NOT EXISTS user_identities_user ON user_identities(user_id);
    CREATE TABLE IF NOT EXISTS oidc_pending_links(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,issuer TEXT NOT NULL,subject TEXT NOT NULL,email TEXT NOT NULL,name TEXT NOT NULL,picture TEXT,groups_json TEXT NOT NULL DEFAULT '[]',remember INTEGER NOT NULL DEFAULT 0,return_to TEXT,second_factor TEXT,expires INTEGER NOT NULL,created_at INTEGER NOT NULL);`);
  const flows = (d.prepare("PRAGMA table_info(oidc_flows)").all() as { name: string }[]).map((c) => c.name);
  if (!flows.includes("link_user_id")) d.exec("ALTER TABLE oidc_flows ADD COLUMN link_user_id TEXT REFERENCES users(id) ON DELETE CASCADE");
  if (!flows.includes("link_session")) d.exec("ALTER TABLE oidc_flows ADD COLUMN link_session TEXT");
  // Existing SSO accounts get their identity in a data step
  // (lib/data-steps.ts) – only where the table is new: a disconnected
  // identity of an older database must not come back.
  if (!fresh) {
    d.exec("CREATE TABLE IF NOT EXISTS data_migrations(name TEXT PRIMARY KEY,at INTEGER NOT NULL)");
    d.prepare("INSERT OR IGNORE INTO data_migrations(name,at) VALUES('identities-88',?)").run(Date.now());
  }
}
// Through one/all/run: the same on SQLite and on PostgreSQL.
async function cleanDeletedFiles() {
  let cursor = "";
  while (true) {
    const batch = await all<{ id: string }>(
      "SELECT id FROM pending_file_deletions WHERE id>? ORDER BY id LIMIT 1000",
      cursor,
    );
    if (!batch.length) return;
    for (const row of batch) {
      const fileId = String(row.id);
      cursor = fileId;
      if (
        !/^[a-f0-9-]{36}$/i.test(fileId) ||
        (await one("SELECT 1 FROM files WHERE id=?", fileId))
      )
        continue;
      try {
        unlinkSync(
          resolve(/*turbopackIgnore: true*/ process.env.FLOWPLAN_DATA_DIR || "./data", "uploads", fileId),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
      }
      await run("DELETE FROM pending_file_deletions WHERE id=?", fileId);
    }
  }
}

// What every transaction of both drivers does besides its own statements
// (lib/db-driver/context.ts): the relation sync before the commit, the
// upload cleanup after it; on PostgreSQL's first use what opening the
// SQLite file does.
dbContext.hooks.beforeCommit = (actor) => flushRelationChanges(actor as Identity | undefined);
dbContext.hooks.afterCommit = () => cleanDeletedFiles();
dbContext.hooks.open = async (backend) => {
  if (backend === "postgres") {
    // A new or older database gets this version's schema first.
    await ensureCurrentPostgresSchema(database());
    // A failed restore leaves the previous state (lib/db-restore.ts) and
    // must not keep the remaining steps from running. Cluster mode: only
    // the leader restores (lib/cluster/duties.ts) – later, once elected.
    if (clusterMode()) deferRestoreToLeader();
    else if (restoreAtThisStart()) await restorePendingIntoPostgres().catch((error) => console.error("Wiederherstellung fehlgeschlagen", error));
    await setupStorage();
    // The search's trigram indexes and the vector index (when the server has
    // pg_trgm and pgvector): what the translated schema leaves to them.
    // Neither stops the opening: the search works without them, slower.
    await (await import("./search-store")).ensureSearchStore().catch((error) => console.error("Search: indexes not made", error));
    await (await import("./ai/vector-store")).ensureVectorStore().catch((error) => console.error("pgvector: not used", error));
  }
  // Loaded here, not at the top: the steps' modules import this one.
  await (await import("./data-steps")).runDataSteps();
};

// How the SQLite file is used (#383, docs/architecture/database.md
// "Pragmas"), on top of WAL, foreign keys and the busy timeout:
// - synchronous=NORMAL: in WAL mode a commit no longer waits for the disk
//   (fsync at checkpoints only) – SQLite's and Litestream's recommendation
//   for WAL. A crash of the process loses nothing; a power loss or a crash
//   of the machine can lose the last commits, never the file's consistency.
// - cache_size: 64 MiB of page cache instead of 2 MiB (an upper bound,
//   taken as pages are read).
// - mmap_size: reads through 256 MiB of memory-mapped file instead of
//   copies (address space, not memory; WAL frames still go through read()).
// - temp_store=MEMORY: sorts and temporary indexes in memory, not in files.
const SQLITE_TUNING =
  "PRAGMA synchronous=NORMAL; PRAGMA cache_size=-65536; PRAGMA mmap_size=268435456; PRAGMA temp_store=MEMORY; PRAGMA analysis_limit=400;";
const OPTIMIZE_EVERY = 6 * 3600_000;
// `PRAGMA optimize` on the open connection every OPTIMIZE_EVERY ms, through
// the asynchronous driver (it waits for a transaction that holds the
// connection). Once per process; SQLite only.
function scheduleOptimize() {
  const runtime = globalThis as { flowplanOptimizeTimer?: NodeJS.Timeout };
  if (runtime.flowplanOptimizeTimer) return;
  runtime.flowplanOptimizeTimer = setInterval(() => {
    if (!globalDb.flowplanDb || database().backend !== "sqlite") return;
    void database()
      .exec("PRAGMA optimize") // sqlite-only
      .catch((error) => console.error("PRAGMA optimize failed", error));
  }, OPTIMIZE_EVERY);
  runtime.flowplanOptimizeTimer.unref();
}

export function db() {
  if (globalDb.flowplanDb) {
    if (!readerThread()) migrate(globalDb.flowplanDb);
    return globalDb.flowplanDb;
  }
  if (readerThread()) return (globalDb.flowplanDb = readerConnection());
  const dir = resolve(
    /* turbopackIgnore: true */ process.env.FLOWPLAN_DATA_DIR || "./data",
  );
  mkdirSync(dir, { recursive: true });
  // Several processes on the host: only process 1 at the host's start
  // (lib/cluster/processes.ts) – the others have the file open otherwise.
  const restored = restoreAtThisStart() ? applyPendingRestore(dir, { dumps: false }) : null;
  if (restored)
    console.log(`Instanz wiederhergestellt; vorheriger Stand in ${restored}`);
  const d = new DatabaseSync(resolve(dir, "flowplan.sqlite"));
  d.exec(
    "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
  );
  d.exec(SQLITE_TUNING);
  d.exec(`
 CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,subject TEXT UNIQUE NOT NULL,name TEXT NOT NULL,email TEXT NOT NULL,disabled INTEGER DEFAULT 0,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
 CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id) ON DELETE CASCADE,groups_json TEXT NOT NULL,expires INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS oidc_flows(id TEXT PRIMARY KEY,state TEXT,verifier TEXT,nonce TEXT,expires INTEGER);
 CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY,name TEXT NOT NULL,icon TEXT DEFAULT 'F',created_by TEXT REFERENCES users(id),created_at TEXT DEFAULT CURRENT_TIMESTAMP);
 CREATE TABLE IF NOT EXISTS members(workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,user_id TEXT REFERENCES users(id) ON DELETE CASCADE,role TEXT NOT NULL CHECK(role IN ('owner','editor','viewer')),PRIMARY KEY(workspace_id,user_id));
 CREATE TABLE IF NOT EXISTS spaces(id TEXT PRIMARY KEY,workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,name TEXT NOT NULL,icon TEXT DEFAULT 'folder',visibility TEXT DEFAULT 'team',owner_id TEXT REFERENCES users(id));
 CREATE TABLE IF NOT EXISTS pages(id TEXT PRIMARY KEY,workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,space_id TEXT REFERENCES spaces(id),parent_id TEXT REFERENCES pages(id),title TEXT NOT NULL,icon TEXT DEFAULT 'file',cover TEXT DEFAULT '',kind TEXT DEFAULT 'document',position REAL DEFAULT 0,deleted_at TEXT,created_by TEXT REFERENCES users(id),updated_at TEXT DEFAULT CURRENT_TIMESTAMP,locked INTEGER DEFAULT 0,public_token TEXT UNIQUE,full_width INTEGER DEFAULT 0,font TEXT DEFAULT 'sans');
 CREATE TABLE IF NOT EXISTS grants(resource_id TEXT,user_id TEXT,group_id TEXT,role TEXT NOT NULL,UNIQUE(resource_id,user_id,group_id));
 CREATE TABLE IF NOT EXISTS groups(id TEXT PRIMARY KEY,workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,name TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS group_members(group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,user_id TEXT REFERENCES users(id) ON DELETE CASCADE,PRIMARY KEY(group_id,user_id));
 CREATE TABLE IF NOT EXISTS documents(page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,state BLOB,html TEXT DEFAULT '',updated_at TEXT DEFAULT CURRENT_TIMESTAMP,generation TEXT DEFAULT '1');
 CREATE TABLE IF NOT EXISTS databases(page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,fields TEXT NOT NULL,views TEXT NOT NULL,version INTEGER DEFAULT 1);
 CREATE TABLE IF NOT EXISTS rows(id TEXT PRIMARY KEY,page_id TEXT REFERENCES pages(id) ON DELETE CASCADE,cells TEXT NOT NULL,position REAL DEFAULT 0,created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP,created_by TEXT REFERENCES users(id),updated_by TEXT REFERENCES users(id),version INTEGER DEFAULT 1,content TEXT DEFAULT '');
 CREATE TABLE IF NOT EXISTS favorites(user_id TEXT REFERENCES users(id),page_id TEXT REFERENCES pages(id) ON DELETE CASCADE,PRIMARY KEY(user_id,page_id));
 CREATE TABLE IF NOT EXISTS comments(id TEXT PRIMARY KEY,page_id TEXT REFERENCES pages(id) ON DELETE CASCADE,row_id TEXT,author_id TEXT REFERENCES users(id),body TEXT NOT NULL,resolved INTEGER DEFAULT 0,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
 CREATE TABLE IF NOT EXISTS notifications(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),body TEXT,page_id TEXT,read_at TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
 CREATE TABLE IF NOT EXISTS snapshots(id TEXT PRIMARY KEY,page_id TEXT REFERENCES pages(id) ON DELETE CASCADE,state BLOB,html TEXT,title TEXT,created_by TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
 CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY,page_id TEXT REFERENCES pages(id) ON DELETE CASCADE,name TEXT,mime TEXT,size INTEGER,created_by TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
 CREATE TABLE IF NOT EXISTS forms(page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,token TEXT UNIQUE,enabled INTEGER DEFAULT 0,internal INTEGER DEFAULT 1,anonymous INTEGER DEFAULT 0);
 CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,actor_id TEXT,action TEXT,resource_id TEXT,detail TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
 CREATE TABLE IF NOT EXISTS presence(page_id TEXT,user_id TEXT,seen INTEGER,PRIMARY KEY(page_id,user_id));
 CREATE TABLE IF NOT EXISTS templates(id TEXT PRIMARY KEY,workspace_id TEXT REFERENCES workspaces(id),name TEXT,kind TEXT,payload TEXT,created_by TEXT);
 CREATE TABLE IF NOT EXISTS form_submissions(id TEXT PRIMARY KEY,form_token TEXT,fingerprint TEXT,created_at INTEGER);
 CREATE TABLE IF NOT EXISTS invites(id TEXT PRIMARY KEY,workspace_id TEXT REFERENCES workspaces(id),email TEXT,role TEXT,created_by TEXT,UNIQUE(workspace_id,email));
 CREATE INDEX IF NOT EXISTS pages_workspace ON pages(workspace_id);
 CREATE INDEX IF NOT EXISTS rows_page ON rows(page_id);
 CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id);
 `);
  globalDb.flowplanDb = d;
  migrate(d);
  // Statistics for the query planner (#383): the tables whose numbers are
  // missing or outdated, with a bounded analysis, then every few hours.
  d.exec("PRAGMA optimize=0x10002");
  scheduleOptimize();
  // After the open, through the asynchronous helpers (also on PostgreSQL,
  // dbContext.hooks.openPostgres below): uploads whose deletion was queued,
  // the object storage queue.
  void (async () => {
    await cleanDeletedFiles();
    await setupStorage(d);
  })().catch((error) => console.error("Dateispeicher: Einrichtung fehlgeschlagen", error));
  return d;
}
// A worker thread's connection (lib/worker-pool.ts, #383): the file the
// main thread opened and migrated, read-only – a WAL reader with snapshots
// of its own, which never waits for the main thread's transactions and
// never holds them up. Nothing is created, migrated or cleaned up here.
function readerConnection() {
  const d = new DatabaseSync(resolve(/* turbopackIgnore: true */ process.env.FLOWPLAN_DATA_DIR || "./data", "flowplan.sqlite"), { readOnly: true });
  d.exec("PRAGMA busy_timeout=5000; PRAGMA cache_size=-16384; PRAGMA mmap_size=268435456; PRAGMA temp_store=MEMORY;");
  return d;
}
// The migrations on another SQLite file (a restored backup that is loaded
// into PostgreSQL, lib/db-restore.ts).
export function migrateFile(d: DatabaseSync) {
  const saved = globalDb.flowplanSchema;
  globalDb.flowplanSchema = undefined;
  try {
    migrate(d);
  } finally {
    globalDb.flowplanSchema = saved;
  }
}
// Closes the database and opens it again; a staged restore
// (<data>/restore-pending) is swapped in between. Only for the restore while
// the instance has no accounts yet (lib/setup-restore.ts): nothing else holds
// the old handle then.
export async function reopenDatabase() {
  await stopStorage();
  // PostgreSQL: the next use connects anew – to the schema configured now
  // (tests: another instance) – and loads a staged restore
  // (dbContext.hooks.openPostgres, lib/db-restore.ts).
  if (postgresUrl()) {
    await closeDatabase();
    noteWrite();
    return null;
  }
  // The data steps run again for the file opened next (dbContext.hooks.open).
  await closeDatabase();
  if (globalDb.flowplanDb) forgetStatements(globalDb.flowplanDb);
  try {
    globalDb.flowplanDb?.close();
  } catch {}
  globalDb.flowplanDb = undefined;
  globalDb.flowplanSchema = undefined;
  noteWrite();
  return db();
}
// Prepared statements of the SQLite helpers, per connection, least recently
// used first. Preparing is a good part of a short query's cost; the SQL texts
// are a fixed set (values go in as parameters), so a few hundred cover
// them. Keyed by the connection: a reopened database (restore, tests)
// starts with an empty cache, and the closed one's statements go with it.
// On globalThis because bundles may hold this module more than once.
const STATEMENT_CACHE_SIZE = 500;
// `tables`: the tables the statement names (what a read depends on),
// `writes`: what a write changes, with what its triggers and foreign keys
// change in turn; null: not known (counts as everything). Both worked out
// once per statement, when first needed (lib/kept-answers.ts).
type Cached = { statement: StatementSync; reads: boolean; names: string[] | null; tables?: readonly string[]; writes?: readonly string[] | null };
function statementCaches() {
  return ((globalThis as { flowplanStatements?: WeakMap<DatabaseSync, Map<string, Cached>> }).flowplanStatements ??= new WeakMap());
}
// Only reads: a SELECT, or a WITH … SELECT without INSERT/UPDATE/DELETE.
const READ_ONLY = /^\s*(SELECT\b|WITH\b(?![\s\S]*\b(INSERT|UPDATE|DELETE|REPLACE)\b))/i;
function statement(sql: string): Cached {
  const d = db();
  const caches = statementCaches();
  let cache = caches.get(d);
  if (!cache) caches.set(d, (cache = new Map()));
  let cached = cache.get(sql);
  if (cached) {
    // Most recently used last, so the first key is the one to drop.
    cache.delete(sql);
    cache.set(sql, cached);
    return cached;
  }
  const prepared = d.prepare(sql);
  // Rows come as arrays and are built into objects here (rowObject below);
  // not for a column called __proto__ (an assignment would not make it a
  // property).
  const arrays = typeof (prepared as { setReturnArrays?: unknown }).setReturnArrays === "function" && !columnNames(prepared).includes("__proto__");
  if (arrays) (prepared as StatementSync & { setReturnArrays(on: boolean): void }).setReturnArrays(true);
  cached = { statement: prepared, reads: READ_ONLY.test(sql), names: arrays ? columnNames(prepared) : null };
  cache.set(sql, cached);
  if (cache.size > STATEMENT_CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return cached;
}
// Forgets the cached statements of a connection: before it is closed, and
// after the schema changed (a cached `SELECT *` keeps the columns it was
// prepared with, see migrate()).
function forgetStatements(d: DatabaseSync) {
  statementCaches().delete(d);
  schemaShapes.delete(d);
}
// Moves with every write (run(), statements that are not plain reads, a
// rolled back transaction, a reopened database): what was read before may
// be outdated (lib/read-memo.ts).
export function writeGeneration() {
  return globalDb.flowplanWrites ?? 0;
}

// ---- Which tables were written when (lib/kept-answers.ts, #383) ----
//
// A clock that moves with every write, the clock reading of the last write
// per table, and of the last write whose tables are not known (a rollback,
// exec(), a reopened database: everything counts as written). A kept
// answer read from some tables is still current while none of them was
// written after it was computed. Only for SQLite, where every write of this
// process goes through the helpers below; writes of other processes on the
// same file show in PRAGMA data_version (sqliteDataVersion()).
type TableClock = { now: number; unknown: number; at: Map<string, number> };
const tableClock = (): TableClock => ((globalDb as { flowplanTableClock?: TableClock }).flowplanTableClock ??= { now: 0, unknown: 0, at: new Map() });
function noteTablesWritten(tables: readonly string[] | null | undefined) {
  const clock = tableClock();
  clock.now++;
  if (!tables) clock.unknown = clock.now;
  else for (const table of tables) clock.at.set(table, clock.now);
}
// The clock reading now: take it before reading what is to be kept.
export function tableClockNow() {
  return tableClock().now;
}
// Whether none of `tables` (nor anything unknown) was written after `stamp`.
export function tablesUnchangedSince(tables: Iterable<string>, stamp: number) {
  const clock = tableClock();
  if (clock.unknown > stamp) return false;
  for (const table of tables) if ((clock.at.get(table) ?? 0) > stamp) return false;
  return true;
}
// Something not tracked by table changed (in memory, e.g. who has a page
// open): a name of its own, read with noteNamesRead().
export function noteNamesWritten(names: readonly string[]) {
  noteTablesWritten(names);
}
export function noteNamesRead(names: readonly string[]) {
  const into = readTracker();
  if (into) for (const name of names) into.add(name);
}
// The tables read by the code running now, when it is being tracked
// (lib/read-memo.ts withTrackedReads; the store is on globalThis there).
const readTracker = () =>
  (globalThis as { flowplanReadMemo?: { getStore(): { tables?: Set<string> } | undefined } }).flowplanReadMemo?.getStore()?.tables;
// Writes of other connections to the SQLite file (scripts, the command
// line): PRAGMA data_version moves when one of them commits.
const dataVersions = new WeakMap<DatabaseSync, StatementSync>();
export function sqliteDataVersion(): number {
  const d = db();
  let statement = dataVersions.get(d);
  if (!statement) dataVersions.set(d, (statement = d.prepare("PRAGMA data_version")));
  return Number((statement.get() as { data_version: number }).data_version);
}

// The tables of the schema, and per table what a write to it changes as
// well, transitively: the tables its triggers write, and – for a delete
// (DELETE, REPLACE) – the tables whose foreign keys point at it with an
// ON DELETE action (CASCADE, SET NULL, SET DEFAULT); for any write those
// with an ON UPDATE action. Keyed "d:<table>" (rows deleted) and
// "w:<table>" (inserted or updated).
type SchemaShape = { tables: Set<string>; closure: Map<string, string[]> };
const schemaShapes = new WeakMap<DatabaseSync, SchemaShape>();
const WRITE_TARGET = /\b(INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+["`[]?([A-Za-z_][A-Za-z0-9_]*)/gi;
// The tables a statement writes, with "d:" when it may delete rows.
const writeTargets = (sqlText: string) =>
  [...sqlText.matchAll(WRITE_TARGET)].map((m) => `${/DELETE|REPLACE/i.test(m[1]) ? "d" : "w"}:${m[2].toLowerCase()}`);
const NO_ACTION = new Set(["NO ACTION", "RESTRICT"]);
function schemaShape(d: DatabaseSync): SchemaShape {
  let shape = schemaShapes.get(d);
  if (shape) return shape;
  const tables = new Set(
    (d.prepare("SELECT lower(name) name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((t) => t.name),
  );
  const edges = new Map<string, Set<string>>();
  const add = (from: string, to: string) => (edges.get(from) ?? edges.set(from, new Set()).get(from)!).add(to);
  for (const t of d.prepare("SELECT lower(tbl_name) tbl, sql FROM sqlite_master WHERE type='trigger' AND sql IS NOT NULL").all() as { tbl: string; sql: string }[]) {
    // What the trigger's body writes (after its BEGIN: "AFTER UPDATE OF x ON t" is no write).
    const begin = t.sql.search(/\bBEGIN\b/i);
    for (const target of writeTargets(begin >= 0 ? t.sql.slice(begin) : t.sql))
      if (tables.has(target.slice(2))) {
        add(`w:${t.tbl}`, target);
        add(`d:${t.tbl}`, target);
      }
  }
  for (const table of tables)
    for (const fk of d.prepare(`PRAGMA foreign_key_list("${table}")`).all() as { table: string; on_update: string; on_delete: string }[]) {
      const parent = fk.table.toLowerCase();
      if (!NO_ACTION.has(fk.on_delete.toUpperCase())) add(`d:${parent}`, `${fk.on_delete.toUpperCase() === "CASCADE" ? "d" : "w"}:${table}`);
      if (!NO_ACTION.has(fk.on_update.toUpperCase())) {
        add(`w:${parent}`, `w:${table}`);
        add(`d:${parent}`, `w:${table}`);
      }
    }
  const closure = new Map<string, string[]>();
  for (const table of tables)
    for (const start of [`w:${table}`, `d:${table}`]) {
      const seen = new Set([start]);
      const stack = [start];
      while (stack.length) for (const next of edges.get(stack.pop()!) ?? []) if (!seen.has(next)) seen.add(next), stack.push(next);
      closure.set(start, [...new Set([...seen].map((n) => n.slice(2)))]);
    }
  schemaShapes.set(d, (shape = { tables, closure }));
  return shape;
}
const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/g;
// PRAGMA statements that only report (table_info, data_version, …) or
// tune the connection change no table.
const QUIET_PRAGMA = /^\s*PRAGMA\s+[\w.]+\s*(\([^)]*\))?\s*;?\s*$/i;
function statementTables(cached: Cached, sqlText: string): readonly string[] {
  if (cached.tables) return cached.tables;
  const { tables } = schemaShape(db());
  return (cached.tables = [...new Set((sqlText.match(IDENTIFIER) ?? []).map((w) => w.toLowerCase()).filter((w) => tables.has(w)))]);
}
function statementWrites(cached: Cached, sqlText: string): readonly string[] | null {
  if (cached.writes !== undefined) return cached.writes;
  if (QUIET_PRAGMA.test(sqlText)) return (cached.writes = []);
  const { tables, closure } = schemaShape(db());
  const targets = writeTargets(sqlText);
  if (!targets.length || targets.some((t) => !tables.has(t.slice(2)))) return (cached.writes = null);
  return (cached.writes = [...new Set(targets.flatMap((t) => closure.get(t) ?? [t.slice(2)]))]);
}
// Reads of the statement for the tracking in place, if any.
function noteStatementRead(cached: Cached, sqlText: string) {
  const into = readTracker();
  if (into) for (const table of statementTables(cached, sqlText)) into.add(table);
}
// For the Postgres driver: what it writes outdates memoized reads
// (lib/read-memo.ts) as SQLite writes do.
export function noteWriteOf(sql: string, params: readonly Param[] = []) {
  if (READ_ONLY.test(sql)) return false;
  noteWrite();
  noteNotificationInsert(sql, params);
  return true;
}
// For the Postgres driver: a transaction that wrote is committed. Its writes
// were noted when they ran, but other connections only see them now – a read
// on another connection in between (a memoized read, the workspace live
// signal's version check, lib/workspace-live.ts) saw the old rows under the
// new write generation and would keep them. Noting the commit as a write
// again outdates those.
export function noteCommitted() {
  noteWrite();
}
// A new notification, whoever inserts it (some thirty places): the
// recipient's open tabs are told to fetch their notifications
// (lib/workspace-live.ts registers the hook). Found from the statement –
// `INSERT INTO notifications(…,user_id,…) VALUES(…)` with the recipient as
// a parameter; anything else (a SELECT as the source) is not followed and
// left to the timed refresh.
const NOTIFICATION_INSERT = /^\s*INSERT\s+INTO\s+notifications\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/i;
const notificationParams = new Map<string, number>();
export function notificationParamIndex(sqlText: string): number {
  let index = notificationParams.get(sqlText);
  if (index !== undefined) return index;
  index = -1;
  const m = NOTIFICATION_INSERT.exec(sqlText);
  if (m) {
    const column = m[1].split(",").map((c) => c.trim().toLowerCase()).indexOf("user_id");
    const values = m[2].split(",").map((v) => v.trim());
    if (column >= 0 && values[column] === "?") index = values.slice(0, column).filter((v) => v === "?").length;
  }
  if (notificationParams.size > 500) notificationParams.clear();
  notificationParams.set(sqlText, index);
  return index;
}
function noteNotificationInsert(sqlText: string, params: readonly Param[]) {
  if (!/^\s*INSERT\s+INTO\s+notifications\b/i.test(sqlText)) return;
  const hook = (globalThis as { flowplanNotificationHook?: (userId: string) => void }).flowplanNotificationHook;
  const index = hook ? notificationParamIndex(sqlText) : -1;
  const userId = index >= 0 ? params[index] : null;
  if (hook && typeof userId === "string") hook(userId);
}
function noteWrite(tables?: readonly string[] | null) {
  globalDb.flowplanWrites = (globalDb.flowplanWrites ?? 0) + 1;
  noteTablesWritten(tables);
}
// A write whose tables are not known (exec() of the SQLite driver).
export function noteUnknownWrite() {
  noteWrite();
}
// Schema changes through run() (tests, one-time steps) outdate cached statements.
const SCHEMA_CHANGE = /^\s*(ALTER|DROP|CREATE)\s/i;

// node:sqlite returns each row as a fresh object without a prototype; it
// gets Object's prototype in place (#383), as the copy `{ ...row }` did
// before at more than twice the cost: plain objects for the rest of the code
// (React's serialisation to the client, deepStrictEqual, hasOwnProperty),
// still one object per row and call, owned by the caller.
//
// Faster still (#383, wave 3): the statement returns each row as an array
// and the object is built here, one property after the other in the order
// of the columns. Every row of a statement then has the same shape (V8's
// fast properties), where an object without a prototype and one whose
// prototype was set afterwards are dictionaries: reading their properties,
// copying them (`{ ...row }`) and JSON.stringify() cost two to three times
// as much. A column name that comes twice keeps its last value, as
// node:sqlite's own objects do.
const asPlain = (row: object) => Object.setPrototypeOf(row, Object.prototype) as object;
function columnNames(statement: StatementSync): string[] {
  return (statement as StatementSync & { columns(): { name: string }[] }).columns().map((c) => c.name);
}
function rowObject(cached: Cached, row: unknown): object {
  if (!cached.names) return asPlain(row as object);
  const values = row as unknown[];
  // The columns of a statement changed with the schema (SQLite prepares it
  // anew by itself): their names once more.
  if (values.length !== cached.names.length) cached.names = columnNames(cached.statement);
  const names = cached.names;
  const out: Record<string, unknown> = {};
  for (let i = 0; i < names.length; i++) out[names[i]] = values[i];
  return out;
}
// The synchronous SQLite statements behind the asynchronous SQLite driver
// (lib/db-driver/sqlite.ts) – only for it and SQLite-only code (the
// migrations, the file checks). Everything else uses one/all/run below.
export function sqliteOne<T = Record<string, unknown>>(sql: string, ...params: Param[]): T | undefined {
  const start = runtimeMetricsOn ? performance.now() : 0;
  const cached = statement(sql);
  if (dbContext.sqliteActive) outsideAsyncTransaction(!cached.reads);
  const row = cached.statement.get(...params);
  noteStatementRead(cached, sql);
  if (!cached.reads) {
    noteWrite(statementWrites(cached, sql));
    noteNotificationInsert(sql, params);
  }
  if (runtimeMetricsOn) noteStatement(start);
  return row ? (rowObject(cached, row) as T) : undefined;
}
export function sqliteAll<T = Record<string, unknown>>(sql: string, ...params: Param[]): T[] {
  const start = runtimeMetricsOn ? performance.now() : 0;
  const cached = statement(sql);
  if (dbContext.sqliteActive) outsideAsyncTransaction(!cached.reads);
  const rows = cached.statement.all(...params) as unknown[];
  for (let i = 0; i < rows.length; i++) rows[i] = rowObject(cached, rows[i]);
  noteStatementRead(cached, sql);
  if (!cached.reads) {
    noteWrite(statementWrites(cached, sql));
    noteNotificationInsert(sql, params);
  }
  if (runtimeMetricsOn) noteStatement(start);
  return rows as T[];
}
export function sqliteRun(sql: string, ...params: Param[]) {
  const start = runtimeMetricsOn ? performance.now() : 0;
  if (dbContext.sqliteActive) outsideAsyncTransaction(true);
  let result;
  const cached = statement(sql);
  try {
    result = cached.statement.run(...params);
  } finally {
    noteWrite(SCHEMA_CHANGE.test(sql) ? null : statementWrites(cached, sql));
  }
  noteNotificationInsert(sql, params);
  if (SCHEMA_CHANGE.test(sql)) forgetStatements(db());
  if (runtimeMetricsOn) noteStatement(start);
  return result;
}

// The database of this instance (lib/db-driver): SQLite, or PostgreSQL with
// DATABASE_URL=postgres://…. The first row, or undefined.
export function one<T = Record<string, unknown>>(sql: string, ...params: Param[]): Promise<T | undefined> {
  return database().one<T>(sql, ...params);
}
export function all<T = Record<string, unknown>>(sql: string, ...params: Param[]): Promise<T[]> {
  return database().all<T>(sql, ...params);
}
// A write; `changes` is the number of rows it touched.
export function run(sql: string, ...params: Param[]): Promise<{ changes: number }> {
  return database().run(sql, ...params);
}
const isPostgres = () => database().backend === "postgres";
// The schema as it is, read the same way on both databases (SQLite:
// sqlite_master and PRAGMA; PostgreSQL: the catalogue of the current schema).
export async function tableNames(): Promise<string[]> {
  if (isPostgres())
    return (
      await all<{ name: string }>(
        "SELECT table_name AS name FROM information_schema.tables WHERE table_schema=current_schema() AND table_type='BASE TABLE' AND table_name<>'flowplan_meta' ORDER BY table_name",
      )
    ).map((t) => t.name);
  return (
    await all<{ name: string }>(
      // sqlite-only
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE 'CREATE VIRTUAL%' ORDER BY name",
    )
  )
    .map((t) => t.name)
    .filter((name) => !/^search_index_/.test(name));
}
export async function tableColumns(table: string): Promise<string[]> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error(`Not a table name: ${table}`);
  if (isPostgres())
    return (
      await all<{ name: string }>(
        "SELECT column_name AS name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=? ORDER BY ordinal_position",
        table,
      )
    ).map((c) => c.name);
  return (await all<{ name: string }>(`PRAGMA table_info("${table}")`)).map((c) => c.name); // sqlite-only
}
// The columns of `table` with a foreign key to `target`.
export async function foreignKeyColumns(table: string, target: string): Promise<string[]> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error(`Not a table name: ${table}`);
  if (isPostgres())
    return (
      await all<{ name: string }>(
        `SELECT a.attname AS name FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=ANY(c.conkey)
       WHERE c.contype='f' AND c.conrelid=to_regclass(?) AND c.confrelid=to_regclass(?)`,
        table,
        target,
      )
    ).map((c) => c.name);
  return (await all<{ table: string; from: string }>(`PRAGMA foreign_key_list("${table}")`)) // sqlite-only
    .filter((f) => f.table === target)
    .map((f) => f.from);
}
// The bytes each table takes, indexes included (SQLite: dbstat, when the
// build has it; PostgreSQL: pg_total_relation_size).
export async function tableSizes(): Promise<{ table: string; bytes: number }[]> {
  if (isPostgres())
    return all<{ table: string; bytes: number }>(
      `SELECT c.relname AS "table",pg_total_relation_size(c.oid) AS bytes FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname=current_schema() AND c.relkind='r'`,
    );
  try {
    return await all<{ table: string; bytes: number }>(
      // sqlite-only
      `SELECT s.tbl_name AS "table", SUM(d.pgsize) AS bytes
       FROM dbstat d JOIN sqlite_schema s ON s.name=d.name
       GROUP BY s.tbl_name`,
    );
  } catch {
    // dbstat missing: no breakdown.
    return [];
  }
}
// The most memory SQLite's page cache of this connection may take (its
// cache_size: negative = KiB, positive = pages) – node:sqlite does not say
// how much of it is in use. Null on PostgreSQL (the cache lives in the
// database server, not in this process).
export async function sqliteCacheBytes(): Promise<number | null> {
  if (isPostgres()) return null;
  try {
    const size = Number((await one<{ cache_size: number }>("PRAGMA cache_size"))?.cache_size); // sqlite-only
    if (!Number.isFinite(size)) return null;
    if (size < 0) return -size * 1024;
    return size * Number((await one<{ page_size: number }>("PRAGMA page_size"))?.page_size || 4096); // sqlite-only
  } catch {
    return null;
  }
}
// The size of the database (SQLite: the file and its write-ahead log;
// PostgreSQL: the tables of this instance's schema).
export async function databaseBytes(): Promise<number> {
  if (isPostgres()) return (await tableSizes()).reduce((n, t) => n + Number(t.bytes), 0);
  const dir = resolve(/* turbopackIgnore: true */ process.env.FLOWPLAN_DATA_DIR || "./data");
  let bytes = 0;
  for (const name of ["flowplan.sqlite", "flowplan.sqlite-wal"])
    try {
      bytes += statSync(resolve(/*turbopackIgnore: true*/ dir, name)).size;
    } catch {}
  return bytes;
}
// The primary key's columns of a table (none: []).
export async function tableKey(table: string): Promise<string[]> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error(`Not a table name: ${table}`);
  if (isPostgres())
    return (
      await all<{ name: string }>(
        `SELECT a.attname AS name FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey)
       WHERE i.indrelid=to_regclass(?) AND i.indisprimary ORDER BY array_position(i.indkey::int2[],a.attnum)`,
        table,
      )
    ).map((c) => c.name);
  return (await all<{ name: string; pk: number }>(`PRAGMA table_info("${table}")`)) // sqlite-only
    .filter((c) => c.pk)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);
}
// Serialises a check-then-write section with every other one of the same
// key until the transaction ends (docs/architecture/database.md,
// "Isolation"): SQLite has one writer at a time anyway; PostgreSQL runs
// READ COMMITTED and takes a transaction-scoped advisory lock. Keys name
// what is checked, e.g. `tags:<workspace>`. The same as tx(fn, { lock }).
export async function lockFor(key: string) {
  if (isPostgres() && inTransaction()) await one("SELECT pg_advisory_xact_lock(hashtextextended(?,0))", key);
}
// Changes to who belongs to a workspace (members, guests, grants, accepted
// invitations) read and then write: they take turns per workspace. Inside a
// transaction; nothing to do on SQLite.
export const lockMembership = (workspaceId: string) => lockFor(`membership:${workspaceId}`);
// Lifts the per-connection limits (statement_timeout, lock_timeout,
// lib/db-driver/postgres.ts) for the rest of the current transaction: for
// work that is long by nature – data steps, snapshots, restores. Nothing
// to do on SQLite or outside a transaction.
export async function untimed() {
  if (!isPostgres() || !inTransaction()) return;
  await run("SET LOCAL statement_timeout=0");
  await run("SET LOCAL lock_timeout=0");
}
// The schema version of the database in use: SQLite's migrations (as run
// in this process), on PostgreSQL the version its schema was made for
// (flowplan_meta, written by ensurePostgresSchema). 0 when unknown.
export async function schemaVersion(): Promise<number> {
  if (isPostgres()) return Number((await one<{ value: string }>("SELECT value FROM flowplan_meta WHERE key='sqlite_schema'"))?.value || 0);
  db();
  return Number(globalDb.flowplanSchema || 0);
}
// Whether the caller runs inside a transaction.
export function inTransaction() {
  return !!currentTx();
}
// Runs `fn` in a savepoint of the current transaction (both databases:
// a failed statement on PostgreSQL spoils the transaction unless it ran in
// one); a throw rolls back to it and is passed on. Outside a transaction
// `fn` just runs. For writes whose failure is caught and ignored.
export async function inSavepoint<T>(fn: () => T | Promise<T>): Promise<T> {
  if (!inTransaction()) return fn();
  return database().tx(async () => fn());
}
const isUniqueViolation = (e: unknown) => {
  const error = e as { code?: string; message?: string } | null;
  return !!error && (error.code === "23505" || /UNIQUE constraint failed/.test(error.message || ""));
};
// `UPDATE <table> SET <set> WHERE <where>` that leaves the rows a unique
// key refuses as they are – what SQLite's UPDATE OR IGNORE does, on both
// databases: all rows at once, and only if that collides, row by row.
// Inside a transaction.
export async function updateIgnoringConflicts(table: string, set: string, where: string, setParams: Param[], whereParams: Param[]) {
  try {
    return Number((await inSavepoint(() => run(`UPDATE "${table}" SET ${set} WHERE ${where}`, ...setParams, ...whereParams))).changes);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
  const primary = await tableKey(table);
  const key = primary.length ? primary : await tableColumns(table);
  const list = key.map((k) => `"${k}"`).join(",");
  let changed = 0;
  for (const row of await all<Record<string, Param>>(`SELECT ${list} FROM "${table}" WHERE ${where}`, ...whereParams))
    try {
      changed += Number(
        (
          await inSavepoint(() =>
            run(`UPDATE "${table}" SET ${set} WHERE ${key.map((k) => `"${k}" IS NOT DISTINCT FROM ?`).join(" AND ")}`, ...setParams, ...key.map((k) => row[k])),
          )
        ).changes,
      );
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  return changed;
}
type Param = string | number | null | Uint8Array;
export const id = () => randomUUID();
// Listeners of the activity log (lib/security-events.ts turns the
// security-relevant entries into security events); a listener never
// disturbs the write.
type AuditListener = (actor: string, action: string, resource: string, detail: string) => void;
// A function, not a constant: modules may register while this one is
// still being evaluated (import cycles). Keyed by name: the production
// build evaluates a module once per route bundle that includes it, and each
// copy registers again – the last one replaces the others, so an entry is
// handled once (not once per bundle: duplicated security events).
export function auditListeners() {
  const holder = globalThis as { flowplanAuditHandlers?: Map<string, AuditListener> };
  return (holder.flowplanAuditHandlers ??= new Map());
}
export function onAudit(name: string, listener: AuditListener) {
  auditListeners().set(name, listener);
}
// A worker thread (lib/worker-pool.ts) does not write: the audit entries
// of its job go back with the result, and the main thread writes them
// once the job has succeeded (writeAudits).
export type AuditEntry = [actor: string, action: string, resource: string, detail: string];
const auditHolder = globalThis as { flowplanAuditCollector?: AsyncLocalStorage<AuditEntry[]> };
const auditCollector = (auditHolder.flowplanAuditCollector ??= new AsyncLocalStorage<AuditEntry[]>());
export async function collectingAudits<T>(fn: () => Promise<T>): Promise<{ value: T; audits: AuditEntry[] }> {
  const audits: AuditEntry[] = [];
  const value = await auditCollector.run(audits, fn);
  return { value, audits };
}
export async function writeAudits(entries: readonly AuditEntry[]) {
  for (const [actor, action, resource, detail] of entries) await audit(actor, action, resource, detail);
}
export async function audit(
  actor: string,
  action: string,
  resource: string,
  detail = "",
) {
  const collected = readerThread() ? auditCollector.getStore() : undefined;
  if (collected) {
    collected.push([actor, action, resource, detail]);
    return;
  }
  await run(
    "INSERT INTO audit(id,actor_id,action,resource_id,detail) VALUES(?,?,?,?,?)",
    id(),
    actor,
    action,
    resource,
    detail,
  );
  for (const listener of auditListeners().values())
    try {
      listener(actor, action, resource, detail);
    } catch {}
}
// Runs `fn` in a transaction of the database (lib/db-driver: BEGIN
// IMMEDIATE on SQLite, READ COMMITTED on PostgreSQL); inside another one a
// savepoint. Every call made inside – also in helpers – takes part in it.
// The relation sync runs before the commit (with `actor`), the upload
// cleanup after it, onTransactionRollback() callbacks after a rollback.
export function transaction<T>(fn: () => T | Promise<T>, actor?: Identity): Promise<T> {
  return database().tx(async () => fn(), { actor });
}
// The bookkeeping of the drivers (lib/db-driver): a rollback outdates
// memoized reads and runs the rollback callbacks of the transaction; a
// transaction's time goes to the runtime metrics.
export function noteRollback(root?: { rollback?: (() => void)[] }) {
  noteWrite();
  if (!root) return;
  for (const cleanup of root.rollback ?? [])
    try {
      cleanup();
    } catch {
      /* preserve the original failure */
    }
  root.rollback = undefined;
}
export function noteTransaction(start: number) {
  if (runtimeMetricsOn) noteTransactionMetric(start);
}
// ---- Refusals that keep their bookkeeping ----
//
// A wrong PIN checked inside a command throws, and the throw rolls the
// command's transaction back – with the row that counted the failure and
// the alert to the owner, so the limit never filled up. Such a check throws
// refuseKeeping(error, writes) instead: inside transactionKeepingRefusals
// the work done so far is undone (a savepoint), the writes are made and
// committed, and then the error is passed on. The check's own lock goes
// with the savepoint (PostgreSQL releases locks of a rolled back
// subtransaction), so the caller names it in `locks`: taken before the
// savepoint, held until the writes are committed, parallel attempts see
// them. Outside a transaction the writes are made
// right away; inside another one they take part in it (and go with a
// rollback, as before).
type KeptWrite = [sql: string, ...params: Param[]];
const keptWrites = new WeakMap<object, KeptWrite[]>();
const keepingRoots = new WeakSet<object>();
export async function refuseKeeping(error: Error, ...writes: KeptWrite[]): Promise<never> {
  const scope = currentTx();
  if (scope && keepingRoots.has(scope.root)) {
    keptWrites.set(error, [...(keptWrites.get(error) ?? []), ...writes]);
    throw error;
  }
  for (const [statement, ...params] of writes) await run(statement, ...params);
  throw error;
}
export async function transactionKeepingRefusals<T>(fn: () => T | Promise<T>, actor?: Identity, locks: string[] = []): Promise<T> {
  let refusal: { error: unknown } | null = null;
  const value = await transaction(async () => {
    const scope = currentTx();
    // Only the outermost transaction can commit the writes.
    if (scope && scope.depth === 0) keepingRoots.add(scope.root);
    for (const key of locks) await lockFor(key);
    try {
      return await database().tx(async () => fn());
    } catch (error) {
      const writes = error && typeof error === "object" ? keptWrites.get(error) : undefined;
      if (!writes) throw error;
      for (const [statement, ...params] of writes) await run(statement, ...params);
      refusal = { error };
      return undefined as T;
    }
  }, actor);
  if (refusal) throw (refusal as { error: unknown }).error;
  return value;
}
// Undoes something outside the database (a written upload) when the
// current transaction rolls back.
export function onTransactionRollback(cleanup: () => void) {
  const scope = currentTx();
  if (!scope) throw new Error("No active transaction");
  (scope.root.rollback ??= []).push(cleanup);
}
