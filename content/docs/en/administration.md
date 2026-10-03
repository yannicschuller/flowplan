# Administering the instance

Whoever administers the instance sees **Administration** in the sidebar: the instance's first account and everyone it gives the admin right to – with single sign-on also the members of the group in `OIDC_ADMIN_GROUP`. There they manage accounts, workspaces, operations, the instance's settings and the activity log.

## Users

All accounts of the instance with their last sign-in.

- **End sessions** signs a person out on all devices.
- **Deactivate** locks an account immediately and ends all sessions; **Activate** releases it again.
- For accounts with e-mail and password: **Make admin** or **Remove admin** (someone always administers the instance) and **Reset link** – a link for a new password, valid for two hours, to hand over when the instance does not send e-mails.

Accounts with e-mail and password are created with **Create account** (see [Sign-in](/docs/sign-in)); SSO accounts on their first sign-in via OIDC, and their admin right comes from the group at the provider.

## Workspaces

All workspaces with their number of members, usage and storage quota. The quota can be overridden per workspace.

## Operations

The state of the instance: size of the database and uploads, queues, search index, versions and uptime, plus the storage overview with the S3 connection, database backup and content figures. Details under [Operations and troubleshooting](/docs/operations).

## Instance

| Setting | Effect |
| --- | --- |
| Name | Appears in the sidebar and on the start page next to the logo. |
| Notice | A banner for everyone, e.g. announced maintenance. |
| Default storage quota | For workspaces without a quota of their own. |
| Version retention | Days after which automatic versions are deleted. |
| Maximum upload size | The limit per file in MB. |
| Create workspaces | Whether everyone may create workspaces of their own. |
| Allow sign-ups with e-mail and password | Anyone may create an account. Without this setting only invited addresses (and the instance's first account). |
| Offer a demo on the start page | Only on flowplan.org, see below. |

Empty fields fall back to the [environment variables](/docs/configuration).

### E-mail and scheduled backup

- **E-mail delivery** shows the configured server, the queue and the last error; **Send test e-mail** checks the connection right away.
- **Daily database backup**: a consistent copy of the database per day, with S3 in the bucket under `backups/`, otherwise in the data folder. The newest *n* are kept; **Back up now** creates one immediately.
- **Lock accounts without sign-in after (days)**: locked accounts lose their sessions and their API tokens stop working; the lock appears in the activity log and can be lifted under **Users**.

### Backup of the whole instance

**Download backup** creates a verified copy of the database and files while running. An uploaded backup is checked and applied on the next restart; the previous state stays as `pre-restore-…` in the data directory.

## Demo

The demo belongs to the product website and only exists on the official instance flowplan.org (`FLOWPLAN_PUBLIC_SITE=true`); self-hosted instances do not show the setting.

With **Offer a demo on the start page**, the button **Try the demo** appears on the start page next to sign-up and sign-in. Without an account it creates a demo guest with an example workspace of its own. Every demo gets fresh example pages that show all features: a welcome page, an editor tour with all blocks, a project database with relation, rollup, formula, recurrence and all views (table, board, calendar, timeline, gallery, list, feed, chart, form), a whiteboard, a journal and a small wiki.

- The demo ends with **End demo**, on signing out, after 45 minutes without activity and after three hours at the latest. Then the account, workspace, pages and files are deleted completely.
- Demo guests cannot take anything outside: no publishing, no share links, no invitations, no further workspaces, no public forms, no administration.
- Every demo workspace has 25 MB of storage. New demos are limited to five per hour and address and 40 at the same time.

## Activity log

The latest changes with person, action and affected resource – such as shares, role changes, deletions and settings. **Export as CSV** downloads the complete log for spreadsheet programs.
