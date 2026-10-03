# Import, export and versions

Content comes in as Markdown, CSV or an archive and goes out again as Markdown, PDF or a complete archive. The version history brings back earlier states.

## Export

**Page actions → Export**:

| Format | Content |
| --- | --- |
| **Markdown (.md)** | One file with the page content; databases with an overview, properties and the documents of all records. |
| **Markdown with files (.zip)** | `index.md`, sub-pages under `pages/`, record documents under `records/`, databases also as CSV under `tables/`, attachments under `assets/` – all linked relatively. |
| **HTML / JSON** | The older format for documents and databases. |

**Print / PDF** opens the browser's print view; save as PDF there.

The export respects read permissions and contains all records regardless of view filters. Formulas and Mermaid are kept as source. Limits per export: 500 pages, 5,000 records, 250 MB of content.

### Print and PDF

**Page actions → Print** (or `> print` in the quick search) prints the page as a clean A4 document – in the print dialog it can also be **saved as PDF**. The sidebar, toolbars, handles, comment bars and notices disappear; colours are always light, blocks are not split in the middle of a page, long code lines wrap and external links are written out with their address.

## Import

- **Markdown, text or HTML**: **Settings → Data → Import Markdown or text**. Headings, lists, tasks, tables, code (also `mermaid`) and formulas become blocks.
- **Notion, AppFlowy or Markdown export**: **Settings → Data** accepts a ZIP with Markdown and CSV files. Markdown becomes pages, CSV databases, folders sub-pages; linked images and files are uploaded, and Notion record pages are matched to their records. Up to 100 MB, 500 pages and 5,000 records per table; you choose the target space beforehand.
- **CSV**: in a database, choose **Import CSV**; the rows become records.
- **Content archive** (see below).

## Content archive

Under **Settings → Data** you download a ZIP of your workspace and import it elsewhere – also into another Flowplan instance.

It contains: accessible pages including the trash, databases with views and records, document content, relations, templates, comments, versions, favourites and form options, plus all files with checksums.

- Importing creates new IDs; internal links and relations are rewritten.
- Imported spaces and templates are private, shares and forms are not active.
- A failed import is rolled back completely.
- Limits: 2 GB ZIP, 500 pages, 20,000 files, 5,000 records per database.

Accounts, sessions and sign-in are not part of it – operations back them up every day with the whole instance.

## Version history

**Page actions → Version history**:

- Documents save automatically at most every five minutes, databases before the first change after ten quiet minutes.
- **Save current version** creates a state at any time; manually saved versions are kept permanently.
- **Changes** compares a version with the current state: added and removed text, for databases new, changed and removed records and properties.
- **Restore** sets the page back to that state.

Automatic versions are thinned out to one per day after seven days and deleted after 180 days (adjustable in the administration).
