import { setupStorage } from "./storage";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, unlinkSync } from "node:fs";
import { applyPendingRestore } from "./instance-restore-apply";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { flushRelationChanges } from "./relation-sync";
import type { Identity } from "./types";
import { notificationDefaults, notificationOn } from "./notification-kinds";
import { emojiPresentation } from "./emoji-presentation";
const globalDb = globalThis as unknown as {
  flowplanDb?: DatabaseSync;
  flowplanSchema?: number;
  flowplanRollback?: (() => void)[];
};
function migrate(d: DatabaseSync) {
  if (globalDb.flowplanSchema === 68) return;
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
  // GitHub/GitLab issue sync (lib/issue-sync.ts): connections of a
  // workspace (token and webhook secret sealed with lib/secret-box.ts), the
  // database ↔ repository mapping, one link per record and issue, pulled or
  // pushed comments and records waiting for a push.
  d.exec(`CREATE TABLE IF NOT EXISTS issue_connections(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,provider TEXT NOT NULL CHECK(provider IN ('github','gitlab')),base_url TEXT NOT NULL DEFAULT '',repo TEXT NOT NULL DEFAULT '',token TEXT NOT NULL,hook_token TEXT NOT NULL UNIQUE,hook_secret TEXT NOT NULL,people TEXT NOT NULL DEFAULT '[]',state TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS issue_connections_workspace ON issue_connections(workspace_id);
    CREATE TABLE IF NOT EXISTS issue_sync_maps(page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,connection_id TEXT NOT NULL REFERENCES issue_connections(id) ON DELETE CASCADE,repo TEXT NOT NULL,config TEXT NOT NULL,state TEXT NOT NULL DEFAULT '{}',created_by TEXT,created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS issue_sync_maps_connection ON issue_sync_maps(connection_id);
    CREATE TABLE IF NOT EXISTS issue_links(id TEXT PRIMARY KEY,page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,row_id TEXT NOT NULL UNIQUE,provider TEXT NOT NULL,repo TEXT NOT NULL,issue_id TEXT NOT NULL,number INTEGER NOT NULL,url TEXT NOT NULL,remote TEXT NOT NULL DEFAULT '{}',local_hash TEXT NOT NULL DEFAULT '',remote_updated INTEGER NOT NULL DEFAULT 0,synced_at INTEGER NOT NULL,UNIQUE(provider,repo,issue_id));
    CREATE INDEX IF NOT EXISTS issue_links_page ON issue_links(page_id);
    CREATE TABLE IF NOT EXISTS issue_comment_links(comment_id TEXT PRIMARY KEY,page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,provider TEXT NOT NULL,repo TEXT NOT NULL,remote_id TEXT NOT NULL,UNIQUE(provider,repo,remote_id));
    CREATE TABLE IF NOT EXISTS issue_sync_queue(row_id TEXT PRIMARY KEY,page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,at INTEGER NOT NULL);`);
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
  // Comment reactions picked from emojibase-data 17 may end in a redundant
  // U+FE0F (👍️); version 18 offers 👍, so they move to that form (see
  // emoji-presentation.ts). A duplicate of the same person is dropped.
  for (const r of d
    .prepare("SELECT rowid,emoji FROM inline_reactions WHERE emoji LIKE '%'||char(65039)")
    .all() as { rowid: number; emoji: string }[]) {
    const emoji = emojiPresentation(r.emoji);
    if (emoji === r.emoji) continue;
    d.prepare("UPDATE OR IGNORE inline_reactions SET emoji=? WHERE rowid=?").run(emoji, r.rowid);
    d.prepare("DELETE FROM inline_reactions WHERE rowid=? AND emoji=?").run(r.rowid, r.emoji);
  }
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
  // Schema 68 – journal days created on first write (lib/journal-days.ts):
  // the draft id a day gets before it exists (one per journal and date, so
  // every device writes into the same page), which template version a day
  // was created from and the template versions themselves (by hash).
  d.exec(`CREATE TABLE IF NOT EXISTS journal_drafts(id TEXT PRIMARY KEY,journal_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,date TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(journal_id,date));
    CREATE TABLE IF NOT EXISTS journal_day_meta(page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,journal_id TEXT NOT NULL,template_hash TEXT NOT NULL DEFAULT '',base_hash TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS journal_templates(journal_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,hash TEXT NOT NULL,html TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(journal_id,hash));`);
  globalDb.flowplanSchema = 68;
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
