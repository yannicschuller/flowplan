# Views

A database can have as many views as you like. Every view shows the same records with its own layout, filters, sorting and groups.

New view: **+** next to the view tabs, then choose the layout. **View and properties** controls which properties are visible and in which order.

## Table

- Edit cells directly; open records as a page via their title.
- Move columns by drag and drop, resize them at their edges.
- Choose a calculation below every column.
- Grouped tables fold groups and show summaries per group.

## Board

The kanban view groups cards into columns, for example by status, select, person or relation.

- Move cards between and within columns by drag and drop: the card lifts, the target column opens a gap, and on release the card settles in. This changes the grouping property.
- **New** at the foot of a column creates a record right in that group.
- Reorder, hide or collapse columns; "No group" collects records without a value.
- **Add group** to the right of the columns creates your own status, such as "Waiting for customer": it is saved as a new option of the grouping select property and appears right away as a column of its own.
- Sub-groups also split the board into rows (swimlanes).
- With multi-select and relations, a card can appear in several columns; moving it only replaces the respective assignment.
- Cards can be dragged on touch devices too.

## Calendar

Month, week and day view by a date field.

- Week and day show an hourly grid with an all-day row and overlaps placed side by side.
- Move appointments in 15-minute steps, extend or shorten them at their edges.
- A click on an hour creates an appointment, **All day +** an all-day record.
- Every view has its own time zone; without a setting the browser's applies.
- Keyboard: <kbd>Alt</kbd> + <kbd>↑</kbd>/<kbd>↓</kbd> moves by 15 minutes, <kbd>Alt</kbd> + <kbd>←</kbd>/<kbd>→</kbd> by one day.

### Subscribe to a calendar

**Subscribe** in the calendar view creates your personal link for Apple Calendar, Google Calendar or Outlook. It shows the records of this view with its filters – only what you may see – and recurrences as series. The link is secret and shown only once; **Create new link** invalidates the old one, **End subscription** switches it off. If you lose access to the database, the link returns nothing anymore.

## Timeline

Bars from a start to an end date field, on a scale of week, month, quarter or year.

- Move bars or drag their edges; the calendar icon opens a date dialog, also for unscheduled records.
- **Today** jumps to the current date; weekends can be highlighted.
- Keyboard: <kbd>Alt</kbd> + <kbd>←</kbd>/<kbd>→</kbd> moves by one day, with <kbd>⇧</kbd> it changes the end, with <kbd>Ctrl</kbd> the start.

## Gallery

Cards with a preview image and selected properties. The image comes from the record's content, its cover or a files property, filling the card or fitted in.

## List

Compact rows with the title and a few properties, good for long collections.

## Feed

Records including their document content one below the other, like a blog or a log. The title, **Open record** or the comment count opens the full record. More records load in steps of 20.

## Chart

**Configure chart** chooses columns, bars, line or donut, the grouping and the calculation – count, sum, average, minimum, maximum. Date values can be summarised by day, week, month or year. A click on a data point shows the records behind it; **Export as CSV** exports all values.

- **Series** split every group by another property, side by side or stacked.
- **More values** put up to four additional calculations next to the main value, such as "sum of costs" next to "sum of revenue" per month. Every value becomes a series of its own with a legend; series and more values cannot be combined.

## Form

Collects records through a form, also from people without an account. See [Forms](/docs/formulare).

## Linked databases

In a document, `/db` shows a view of an existing database. The embed has its own views, filters and sorting; records and their changes still belong to the source. The source name in the header opens the full database.

Reading it requires access to both the document and the source. The embed grants no additional permissions; **Remove** only deletes the block.
