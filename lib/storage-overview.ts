// Storage overview for admins: what lives in the local SQLite file (by kind
// of content), the uploads by media type, what is in the S3 bucket, and how
// many workspaces, pages, records … the instance holds.
import { AwsClient } from "aws4fetch";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { all, one } from "./db";
import { storageConfig, storageStatus } from "./storage";

const dataDir = () => resolve(process.env.FLOWPLAN_DATA_DIR || "./data");
function fileSize(path: string) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
const count = (sql: string) => {
  try {
    return Number(one<{ n: number }>(sql)?.n || 0);
  } catch {
    return 0;
  }
};

// Tables of the SQLite file grouped by what they hold.
const GROUPS: { key: string; label: string; match: (table: string) => boolean }[] = [
  { key: "documents", label: "Dokumente", match: (t) => t === "documents" || t === "row_documents" },
  {
    key: "databases",
    label: "Datenbanken und Einträge",
    match: (t) => t === "rows" || t === "databases" || t.startsWith("row_") || t.startsWith("relation"),
  },
  { key: "whiteboards", label: "Whiteboards", match: (t) => t.startsWith("whiteboard") },
  { key: "versions", label: "Versionen", match: (t) => t === "snapshots" || t === "row_snapshots" },
  { key: "comments", label: "Kommentare", match: (t) => t === "comments" || t.startsWith("inline_") },
  {
    key: "search",
    label: "Suchindex und Texterkennung",
    match: (t) => t.startsWith("search_") || t === "file_texts",
  },
  { key: "templates", label: "Vorlagen", match: (t) => t.startsWith("template") },
  { key: "avatars", label: "Profilbilder", match: (t) => t === "user_avatars" },
  {
    key: "log",
    label: "Protokoll und Benachrichtigungen",
    match: (t) => t === "audit" || t.startsWith("notification") || t.startsWith("push_"),
  },
];
// Snapshots are stored inside the version tables but are listed separately.
function databaseBreakdown() {
  let tables: { table: string; bytes: number }[] = [];
  try {
    tables = all<{ table: string; bytes: number }>(
      `SELECT s.tbl_name AS "table", SUM(d.pgsize) AS bytes
       FROM dbstat d JOIN sqlite_schema s ON s.name=d.name
       GROUP BY s.tbl_name`,
    );
  } catch {
    // dbstat missing: the file size stays, without breakdown.
  }
  const groups = GROUPS.map((g) => ({ key: g.key, label: g.label, bytes: 0 }));
  const other = { key: "other", label: "Konten, Rechte und Verwaltung", bytes: 0 };
  for (const row of tables) {
    const index = GROUPS.findIndex((g) => g.match(String(row.table)));
    if (index >= 0) groups[index].bytes += Number(row.bytes);
    else other.bytes += Number(row.bytes);
  }
  return [...groups, other].filter((g) => g.bytes > 0).sort((a, b) => b.bytes - a.bytes);
}

const MEDIA = [
  { key: "images", label: "Bilder", test: (m: string) => m.startsWith("image/") },
  { key: "video", label: "Videos", test: (m: string) => m.startsWith("video/") },
  { key: "audio", label: "Audio", test: (m: string) => m.startsWith("audio/") },
  {
    key: "documents",
    label: "Dokumente (PDF, Office, Text)",
    test: (m: string) =>
      m === "application/pdf" ||
      m.startsWith("text/") ||
      /officedocument|msword|ms-excel|ms-powerpoint|opendocument|rtf/.test(m),
  },
];
function mediaKind(mime: string) {
  return MEDIA.find((m) => m.test(mime || ""))?.key || "other";
}
function emptyMedia() {
  return [
    ...MEDIA.map((m) => ({ key: m.key, label: m.label, files: 0, bytes: 0 })),
    { key: "other", label: "Sonstige Dateien", files: 0, bytes: 0 },
  ];
}

// Lists the bucket (up to 50 000 objects) below the instance prefix.
async function bucketContents() {
  const config = storageConfig();
  if (!config) return null;
  const aws = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: "s3",
    region: config.region,
    retries: 0,
  });
  const prefix = config.prefix ? `${config.prefix}/` : "";
  const objects: { key: string; size: number; modified: string }[] = [];
  const started = Date.now();
  let token = "",
    partial = false;
  for (let page = 0; ; page++) {
    if (page >= 50) {
      partial = true;
      break;
    }
    const url = new URL(`${config.endpoint}/${encodeURIComponent(config.bucket)}`);
    url.searchParams.set("list-type", "2");
    url.searchParams.set("max-keys", "1000");
    if (prefix) url.searchParams.set("prefix", prefix);
    if (token) url.searchParams.set("continuation-token", token);
    const response = await aws.fetch(url, { signal: AbortSignal.timeout(8000) });
    const body = await response.text();
    if (!response.ok) {
      const code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1];
      throw new Error(code ? `${response.status} ${code}` : `HTTP ${response.status}`);
    }
    for (const match of body.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const part = match[1];
      objects.push({
        key: /<Key>([^<]*)<\/Key>/.exec(part)?.[1] || "",
        size: Number(/<Size>(\d+)<\/Size>/.exec(part)?.[1] || 0),
        modified: /<LastModified>([^<]+)<\/LastModified>/.exec(part)?.[1] || "",
      });
    }
    token = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(body)?.[1] || "";
    if (!token || !/<IsTruncated>true<\/IsTruncated>/.test(body)) break;
  }
  return { config, prefix, objects, partial, latencyMs: Date.now() - started };
}

export async function storageOverview() {
  const dir = dataDir();
  const files = all<{ id: string; mime: string; size: number }>(
    "SELECT id,mime,COALESCE(size,0) size FROM files",
  );
  const mimeById = new Map(files.map((f) => [f.id, f.mime || ""]));
  const local = emptyMedia();
  for (const f of files) {
    const bucket = local.find((m) => m.key === mediaKind(f.mime))!;
    bucket.files++;
    bucket.bytes += Number(f.size);
  }
  const pages = (kind: string) =>
    count(`SELECT COUNT(*) n FROM pages WHERE deleted_at IS NULL AND kind='${kind}'`);
  const counts = {
    users: count("SELECT COUNT(*) n FROM users WHERE disabled=0"),
    disabledUsers: count("SELECT COUNT(*) n FROM users WHERE disabled=1"),
    sessions: count(`SELECT COUNT(*) n FROM sessions WHERE expires>${Date.now()}`),
    workspaces: count("SELECT COUNT(*) n FROM workspaces"),
    spaces: count("SELECT COUNT(*) n FROM spaces WHERE deleted_at IS NULL"),
    documents: count(
      "SELECT COUNT(*) n FROM pages WHERE deleted_at IS NULL AND kind='document' AND journal_date IS NULL",
    ),
    databases: pages("database"),
    whiteboards: pages("whiteboard"),
    journals: pages("journal"),
    journalDays: count(
      "SELECT COUNT(*) n FROM pages WHERE deleted_at IS NULL AND journal_date IS NOT NULL",
    ),
    trashedPages: count("SELECT COUNT(*) n FROM pages WHERE deleted_at IS NOT NULL"),
    rows: count("SELECT COUNT(*) n FROM rows"),
    files: files.length,
    comments:
      count("SELECT COUNT(*) n FROM comments") +
      count("SELECT COUNT(*) n FROM inline_messages WHERE deleted=0"),
    versions:
      count("SELECT COUNT(*) n FROM snapshots") + count("SELECT COUNT(*) n FROM row_snapshots"),
    templates: count("SELECT COUNT(*) n FROM templates"),
    shareLinks: count("SELECT COUNT(*) n FROM share_links"),
    publications: count("SELECT COUNT(*) n FROM publications"),
    forms: count("SELECT COUNT(*) n FROM forms WHERE enabled=1"),
  };
  const databaseFile = fileSize(resolve(dir, "flowplan.sqlite")),
    wal = fileSize(resolve(dir, "flowplan.sqlite-wal"));

  let objectStorage:
    | { enabled: false }
    | {
        enabled: true;
        endpoint: string;
        bucket: string;
        prefix: string;
        reachable: boolean;
        error?: string;
        latencyMs?: number;
        pending: number;
        retrying: boolean;
        partial?: boolean;
        uploads?: { objects: number; bytes: number; byType: ReturnType<typeof emptyMedia> };
        missing?: number;
        orphans?: number;
        backup?: { objects: number; bytes: number; lastModified: string | null };
        other?: { objects: number; bytes: number };
      } = { enabled: false };
  const status = storageStatus();
  const config = storageConfig();
  if (config) {
    const base = {
      enabled: true as const,
      endpoint: (() => {
        try {
          return new URL(config.endpoint).host;
        } catch {
          return config.endpoint;
        }
      })(),
      bucket: config.bucket,
      prefix: config.prefix,
      pending: status.enabled ? status.pending : 0,
      retrying: status.enabled ? status.failing : false,
    };
    try {
      const listing = (await bucketContents())!;
      const uploadsPrefix = `${listing.prefix}uploads/`,
        dbPrefix = `${listing.prefix}db/`;
      const byType = emptyMedia();
      let uploadObjects = 0,
        uploadBytes = 0,
        orphans = 0;
      const stored = new Set<string>();
      const backup = { objects: 0, bytes: 0, lastModified: null as string | null },
        other = { objects: 0, bytes: 0 };
      for (const object of listing.objects) {
        if (object.key.startsWith(uploadsPrefix)) {
          const id = object.key.slice(uploadsPrefix.length);
          stored.add(id);
          uploadObjects++;
          uploadBytes += object.size;
          const mime = mimeById.get(id);
          if (mime === undefined) orphans++;
          const bucket = byType.find((m) => m.key === mediaKind(mime || ""))!;
          bucket.files++;
          bucket.bytes += object.size;
        } else if (object.key.startsWith(dbPrefix)) {
          backup.objects++;
          backup.bytes += object.size;
          if (!backup.lastModified || object.modified > backup.lastModified)
            backup.lastModified = object.modified;
        } else {
          other.objects++;
          other.bytes += object.size;
        }
      }
      objectStorage = {
        ...base,
        reachable: true,
        latencyMs: listing.latencyMs,
        partial: listing.partial,
        uploads: { objects: uploadObjects, bytes: uploadBytes, byType },
        // Known files not (yet) in the bucket, and objects no file refers to.
        missing: listing.partial ? undefined : files.filter((f) => !stored.has(f.id)).length,
        orphans,
        backup,
        other,
      };
    } catch (error) {
      objectStorage = {
        ...base,
        reachable: false,
        error: error instanceof Error ? error.message : "Nicht erreichbar",
      };
    }
  }
  return {
    checkedAt: new Date().toISOString(),
    local: {
      databaseBytes: databaseFile + wal,
      walBytes: wal,
      database: databaseBreakdown(),
      uploads: {
        files: files.length,
        bytes: files.reduce((sum, f) => sum + Number(f.size), 0),
        byType: local,
      },
    },
    objectStorage,
    counts,
  };
}
export type StorageOverview = Awaited<ReturnType<typeof storageOverview>>;
