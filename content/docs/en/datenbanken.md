# Databases

A database is a collection of records with properties. The same records can be shown as a table, board, calendar, timeline, gallery, list, feed, chart or form.

## Create a database

**New page → Database** creates a database with a table view. Alternatively use a [template](/docs/vorlagen), such as "Tasks" or "Projects", or import a CSV file (see [Import, export and versions](/docs/import-export-versionen)).

## Records

- **New** at the bottom of the table or at the top right creates a record and opens it with the title selected – just start typing, <kbd>Enter</kbd> saves.
- A click on the title opens the record as a page: the title at the top to edit directly, the properties below it, and below them a full document with the same editor as every other page – including comments, version history and editing together.
- At the top right of a record: how it opens (as a dialog, in the side panel or as a full page – the choice applies to you in this browser; the database's default is marked "default"), the star for favourites, the lock for the record's permissions and the sliders for the layout of all records. **Icon** and **Cover** appear when the pointer is over the title.
- **Record templates** give new records properties and content. One template can be the default for new records.
- Select several records (checkboxes on the left) and edit, duplicate or delete them together – up to 500 at once. Flowplan saves a state beforehand that can be restored from the version history.
- Deleted records sit in the database's trash and can be brought back.

## Properties

| Type | Content |
| --- | --- |
| Text, number | Numbers with a format: currency, percent, decimal places, thousands separators |
| Date | With or without time and end date, time zone, personal reminders, recurrence |
| Select, multi-select | Coloured options, e.g. for status or tags |
| Checkbox, checklist | Tick off; checklists with several items and progress |
| URL, e-mail, phone | Clickable |
| Person | Members of the workspace; assigning someone notifies them |
| Files | Attachments and images right on the record |
| Relation, rollup | A link to records of another database and calculations over them |
| Formula | A value calculated from other properties |
| Created time/by, edited time/by | Maintained automatically |

Relations, rollups and formulas are described under [Properties, formulas and rollups](/docs/eigenschaften-und-formeln).

## Large databases

Tables, lists and galleries first show 100 records; the next 100 follow as you scroll, and groups and board columns have **Show more**. Search, filters, sorting and column calculations still always apply to all records. This way even databases with thousands of records open in a fraction of a second.

## Filter, sort, group

Every view has its own settings:

- **Filters** with AND/OR groups; for date fields also relative periods ("this week", "last 30 days") that update themselves every day.
- **Sorting** by several properties.
- **Grouping** by almost any property (except files and checklists), with up to five levels in tables and lists; boards show the second level as rows (swimlanes).
- **Search** within the database, also in the text of the record documents.
- **Column calculations** below table columns: sum, average, median, minimum, maximum, percentages, earliest and latest dates and more.

## Recurring records

Date fields can repeat daily, weekly, monthly or yearly. Calendar and timeline show the occurrences; it remains a single record. If needed, a single occurrence can be detached as a record of its own.

## Date reminders

In a record, everyone can set a personal reminder for every filled date field – for times at the appointment or 5 minutes to 1 week before, for all-day dates on the day or 1, 2 or 7 days before at 09:00. Reminders appear in the inbox and as a push notification and do not change the record.

## Permissions per record

The permissions icon at the top of a record restricts a record beyond the permissions of the database:

- **Same as database**: the default.
- **Read-only record**: only its managers (page owners and the person who created the record) and people it is explicitly shared with may change it.
- **Private record**: only its managers and people it is shared with see it.

Shares with people or groups never go beyond their role on the database page.
