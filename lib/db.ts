import { setupStorage } from "./storage";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, unlinkSync } from "node:fs";
import { applyPendingRestore } from "./instance-restore-apply";
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
  if (globalDb.flowplanSchema === 22) return;
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
  // Per record access: inherited, read-only or private, plus grants.
  if (!rowColumns.some((c) => c.name === "access"))
    d.exec(
      "ALTER TABLE rows ADD COLUMN access TEXT NOT NULL DEFAULT 'inherit'",
    );
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
    CREATE TRIGGER IF NOT EXISTS notification_inbox_pref BEFORE INSERT ON notifications
    WHEN EXISTS(SELECT 1 FROM notification_prefs p WHERE p.user_id=NEW.user_id AND p.kind=NEW.kind AND p.inbox=0)
    BEGIN SELECT RAISE(IGNORE); END;
    DROP TRIGGER IF EXISTS queue_notification_push;
    CREATE TRIGGER queue_notification_push AFTER INSERT ON notifications BEGIN
      INSERT INTO push_deliveries(notification_id,subscription_id) SELECT NEW.id,s.id FROM push_subscriptions s JOIN sessions se ON se.token=s.session_token WHERE s.user_id=NEW.user_id AND se.expires>unixepoch()*1000
      AND NOT EXISTS(SELECT 1 FROM notification_prefs p WHERE p.user_id=NEW.user_id AND p.kind=NEW.kind AND p.push=0);
    END;`);
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
  globalDb.flowplanSchema = 22;
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
  const restored = applyPendingRestore(dir);
  if (restored)
    console.log(`Instanz wiederhergestellt; vorheriger Stand in ${restored}`);
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
  setupStorage(d);
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
