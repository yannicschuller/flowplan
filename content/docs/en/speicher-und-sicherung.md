# Storage, S3 and backups

All data lives in one directory. With S3 storage, files are mirrored and the database is backed up continuously – the container then holds nothing irreplaceable anymore.

## What is where

| Path in `/app/data` | Content |
| --- | --- |
| `flowplan.sqlite` (+ `-wal`, `-shm`) | All content, accounts, sessions, settings |
| `uploads/` | Uploaded files |
| `web-push-keys.json` | Push keys, unless set via the environment |
| `ocr/` | Language data for text recognition, recreated when needed |

## Turn on S3 storage

With `S3_BUCKET` and credentials (see [Configuration](/docs/konfiguration#s3-and-database-backup)):

- **Files**: every uploaded file goes into the bucket right after saving, and deleted files are removed there. `uploads/` stays the working copy. If a file is missing there – a new host, a lost volume –, Flowplan fetches it from the bucket: right away when requested, all others in the background.
- **Database**: [Litestream](https://litestream.io) transfers changes to the SQLite file to `<prefix>/db` about every second. If the container starts without a database, Litestream first restores it from the bucket.

On the first start with S3, Flowplan uploads all existing files. `/api/health` shows the progress under `objectStorage.pending`, and **Administration → Operations** shows the connection and the split between local and S3.

MinIO, Garage, SeaweedFS, AWS S3 and other S3-compatible services are suitable.

### Garage

Garage creates neither the bucket nor the keys by itself:

```bash
garage status                                  # read the node ID
garage layout assign -z dc1 -c 10G <node ID>
garage layout apply --version 1
garage bucket create flowplan
garage key create flowplan
garage bucket allow --read --write --owner flowplan --key flowplan
garage key info flowplan --show-secret         # key ID and secret
```

`S3_REGION` must match the value `s3_region` in `garage.toml`.

### SeaweedFS

Start the S3 service so that it listens on all interfaces (`-ip.bind=0.0.0.0`), otherwise other containers cannot reach it. The endpoint is the S3 port, `8333` by default.

> [!NOTE]
> Why no Postgres and no Redis? Flowplan works in one process directly on SQLite – faster and simpler for one instance per organisation. Sessions, presence and live sync run through the database and the process itself; Redis would have nothing to do.

## Backups

1. **Instance backup in Flowplan** (recommended): **Administration → Instance → Backup of the whole instance** downloads the database and files consistently while running.
2. **S3 with Litestream**: a continuous backup; an earlier point in time can be restored (below).
3. A **volume backup** on the host or in Coolify. For a consistent copy, stop the container first.
4. **By hand** while running:

```bash
sqlite3 /app/data/flowplan.sqlite "VACUUM INTO '/backup/flowplan.sqlite'"
```

Back up `uploads/` and `web-push-keys.json` as well.

The content archive under **Settings → Data** backs up a workspace but does not replace an instance backup with accounts and permissions.

## Restore

- **From an instance backup**: upload it in **Administration → Instance**. Flowplan checks it and applies it on the next restart; the previous state stays as `pre-restore-…` in the data directory.
- **On a new host with S3**: start a new installation with **the same** `S3_*` variables and an empty volume. Litestream restores the database, the files follow in the background.
- **An earlier point in time**, with the app stopped:

```bash
litestream restore -config /etc/litestream.yml \
  -timestamp 2026-09-26T12:00:00Z -o /app/data/flowplan.sqlite
```

Move the existing `flowplan.sqlite` with `-wal` and `-shm` aside first.

## Quotas

`FLOWPLAN_WORKSPACE_QUOTA_MB` or **Administration → Instance** sets a default quota per workspace; under **Administration → Workspaces** it can be overridden per workspace. Uploads, copies, templates and imports beyond the quota are refused.
