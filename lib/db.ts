import { setupStorage } from "./storage";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, unlinkSync } from "node:fs";
import { applyPendingRestore } from "./instance-restore-apply";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { flushRelationChanges } from "./relation-sync";
import type { Identity } from "./types";
import { notificationDefaults, notificationOn } from "./notification-kinds";
const globalDb = globalThis as unknown as {
  flowplanDb?: DatabaseSync;
  flowplanSchema?: number;
  flowplanRollback?: (() => void)[];
};
function migrate(d: DatabaseSync) {
  if (globalDb.flowplanSchema === 43) return;
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
    DROP TRIGGER IF EXISTS notification_inbox_pref;
    CREATE TRIGGER notification_inbox_pref BEFORE INSERT ON notifications
    WHEN NOT (${notificationOn("inbox", "NEW.user_id", "NEW.kind")})
    BEGIN SELECT RAISE(IGNORE); END;
    DROP TRIGGER IF EXISTS queue_notification_push;
    CREATE TRIGGER queue_notification_push AFTER INSERT ON notifications BEGIN
      INSERT INTO push_deliveries(notification_id,subscription_id) SELECT NEW.id,s.id FROM push_subscriptions s JOIN sessions se ON se.token=s.session_token WHERE s.user_id=NEW.user_id AND se.expires>unixepoch()*1000
      AND ${notificationOn("push", "NEW.user_id", "NEW.kind")};
    END;`);
  for (const [kind, on] of Object.entries(notificationDefaults))
    d.prepare(
      "INSERT INTO notification_defaults(kind,inbox,push,email) VALUES(?,?,?,?) ON CONFLICT(kind) DO UPDATE SET inbox=excluded.inbox,push=excluded.push,email=excluded.email",
    ).run(kind, on.inbox ? 1 : 0, on.push ? 1 : 0, on.email ? 1 : 0);
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
  ])
    if (!sessionColumns.includes(name)) d.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${type}`);
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
    CREATE TABLE IF NOT EXISTS api_tokens(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,name TEXT NOT NULL,scope TEXT NOT NULL CHECK(scope IN ('read','write')),token_hash TEXT NOT NULL UNIQUE,prefix TEXT NOT NULL,created_at INTEGER NOT NULL,last_used_at INTEGER,expires_at INTEGER);
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
  globalDb.flowplanSchema = 43;
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
