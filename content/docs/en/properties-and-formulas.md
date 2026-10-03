# Properties, formulas and rollups

Relations connect databases, rollups calculate across linked records, formulas calculate values from the properties of the same record.

## Edit properties

A click on the column header or **View and properties** opens the property dialog: name, type, options and format. Changing the type keeps existing values as far as they fit. Number formats cover currencies, percent, decimal places and thousands separators and also apply to formulas with a numeric result; date fields show short, long or ISO dates and optionally times; **Remove date** below the field clears it again.

## Relations

1. **Add property → Relation** and choose the target database.
2. Optionally **in both directions**: the target database gets a counterpart property, and changes are kept in sync on both sides.
3. In the cell, search for records and link them; several links can be removed one by one or cleared together.

Relations appear as links in the record. The database search also finds records by the names of linked records, and relation filters offer these names directly.

## Rollups

1. Create a relation first.
2. **Add property → Rollup**, then choose the relation and a property of the target database.
3. Choose a calculation – 22 are available, depending on the type: original values, unique values, count, empty/not empty (also as a percentage), sum, average, median, minimum, maximum, range, checked/unchecked, earliest and latest date, date range.

Number rollups appear as a number, progress bar, progress ring or rating, with an adjustable target value. Values from databases someone may not read are not loaded for that person.

## Formulas

Choose the type **Formula** in the property dialog. The editor offers 58 functions with search, categories, signatures and examples, suggestions while you type and a live preview on a record of your choice.

```
round(prop("Effort") * prop("Hourly rate"), 2)
```

```
if(prop("Done"), "✓", concat(format(dateBetween(prop("Due"), today(), "days")), " days"))
```

- References with `prop("Name")` stay valid when the property is renamed.
- Syntax errors show their position and prevent saving.
- Numeric results are available in filters, sorting, charts and column calculations.
- Date functions calculate in UTC unless a zone is given; `now()` and `today()` update every minute.
- Formulas do not run JavaScript; length, nesting and result size are limited.

### Function groups

| Group | Examples |
| --- | --- |
| Logic | `if`, `ifs`, `coalesce`, `and`, `or`, `not`, `empty` |
| Numbers | `sum`, `average`, `min`, `max`, `round`, `ceil`, `floor`, `abs`, `mod`, `pow`, `sqrt` |
| Text | `concat`, `length`, `contains`, `replace`, `replaceAll`, `trim`, `slice`, `lower`, `upper`, `format`, `toNumber` |
| Date | `now`, `today`, `parseDate`, `formatDate`, `dateAdd`, `dateSubtract`, `dateBetween`, `year`, `month`, `day`, `hour`, `timestamp` |
| Lists | `list`, `count`, `at`, `first`, `last`, `join`, `split`, `unique`, `sort`, `reverse` |

The formula editor shows the complete list.
