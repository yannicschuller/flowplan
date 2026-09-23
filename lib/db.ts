import { DatabaseSync } from "node:sqlite";
import { mkdirSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { flushRelationChanges } from "./relation-sync";
import type { Identity } from "./types";
const globalDb = globalThis as unknown as {
  flowplanDb?: DatabaseSync;
  flowplanSchema?: number;
  flowplanRollback?: (() => void)[];
};
function migrate(d: DatabaseSync) {
  if (globalDb.flowplanSchema === 18) return;
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
  const notificationColumns = d
    .prepare("PRAGMA table_info(notifications)")
    .all() as { name: string }[];
  for (const column of ["row_id", "thread_id"])
    if (!notificationColumns.some((c) => c.name === column))
      d.exec(`ALTER TABLE notifications ADD COLUMN ${column} TEXT`);
  const flowColumns = d.prepare("PRAGMA table_info(oidc_flows)").all() as {
    name: string;
  }[];
  if (!flowColumns.some((c) => c.name === "return_to"))
    d.exec("ALTER TABLE oidc_flows ADD COLUMN return_to TEXT");
  if (
    !(
      d.prepare("PRAGMA table_info(inline_messages)").all() as {
        name: string;
      }[]
    ).some((c) => c.name === "rich_body")
  )
    d.exec("ALTER TABLE inline_messages ADD COLUMN rich_body TEXT");
  globalDb.flowplanSchema = 18;
}
function cleanDeletedFiles(d: DatabaseSync) {
  let cursor = "";
  while (true) {
    const batch = d
      .prepare(
        "SELECT id FROM pending_file_deletions WHERE id>? ORDER BY id LIMIT 1000",
      )
      .all(cursor);
    if (!batch.length) return;
    for (const row of batch) {
      const fileId = String(row.id);
      cursor = fileId;
      if (
        !/^[a-f0-9-]{36}$/i.test(fileId) ||
        d.prepare("SELECT 1 FROM files WHERE id=?").get(fileId)
      )
        continue;
      try {
        unlinkSync(
          resolve(process.env.FLOWPLAN_DATA_DIR || "./data", "uploads", fileId),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
      }
      d.prepare("DELETE FROM pending_file_deletions WHERE id=?").run(fileId);
    }
  }
}

export function db() {
  if (globalDb.flowplanDb) {
    migrate(globalDb.flowplanDb);
    return globalDb.flowplanDb;
  }
  const dir = resolve(
    /* turbopackIgnore: true */ process.env.FLOWPLAN_DATA_DIR || "./data",
  );
  mkdirSync(dir, { recursive: true });
  const d = new DatabaseSync(resolve(dir, "flowplan.sqlite"));
  d.exec(
    "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
  );
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
  cleanDeletedFiles(d);
  return d;
}
export function one<T = Record<string, unknown>>(
  sql: string,
  ...params: (string | number | null | Uint8Array)[]
): T | undefined {
  const row = db()
    .prepare(sql)
    .get(...params);
  return row ? ({ ...row } as T) : undefined;
}
export function all<T = Record<string, unknown>>(
  sql: string,
  ...params: (string | number | null | Uint8Array)[]
): T[] {
  return db()
    .prepare(sql)
    .all(...params)
    .map((row) => ({ ...row })) as T[];
}
export function run(
  sql: string,
  ...params: (string | number | null | Uint8Array)[]
) {
  return db()
    .prepare(sql)
    .run(...params);
}
export const id = () => randomUUID();
export function audit(
  actor: string,
  action: string,
  resource: string,
  detail = "",
) {
  run(
    "INSERT INTO audit(id,actor_id,action,resource_id,detail) VALUES(?,?,?,?,?)",
    id(),
    actor,
    action,
    resource,
    detail,
  );
}
export function transaction<T>(fn: () => T, actor?: Identity): T {
  db().exec("BEGIN IMMEDIATE");
  globalDb.flowplanRollback = [];
  try {
    const value = fn();
    flushRelationChanges(actor);
    db().exec("COMMIT");
    // SQL remains authoritative even if an upload cannot be unlinked yet.
    // The durable queue retries on the next commit or process start.
    try {
      cleanDeletedFiles(db());
    } catch (error) {
      console.error("Upload cleanup failed", error);
    }
    return value;
  } catch (e) {
    db().exec("ROLLBACK");
    for (const cleanup of globalDb.flowplanRollback || []) {
      try {
        cleanup();
      } catch {
        /* preserve the original failure */
      }
    }
    throw e;
  } finally {
    globalDb.flowplanRollback = undefined;
  }
}
export function onTransactionRollback(cleanup: () => void) {
  if (!globalDb.flowplanRollback) throw new Error("No active transaction");
  globalDb.flowplanRollback.push(cleanup);
}
