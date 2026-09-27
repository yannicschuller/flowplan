# Eigenschaften, Formeln und Rollups

Relationen verbinden Datenbanken, Rollups rechnen über verknüpfte Einträge, Formeln berechnen Werte aus Eigenschaften desselben Eintrags.

## Eigenschaften bearbeiten

Ein Klick auf den Spaltenkopf oder **Ansicht und Eigenschaften** öffnet den Eigenschaftsdialog: Name, Typ, Optionen und Format. Typwechsel übernehmen vorhandene Werte, soweit sie passen. Formate für Zahlen umfassen Währungen, Prozent, Dezimalstellen und Tausendertrennzeichen und gelten auch für Formeln mit Zahlenergebnis; Datumsfelder zeigen kurz, lang oder ISO und optional Uhrzeiten; **Datum entfernen** unter dem Feld leert es wieder.

## Relationen

1. **Eigenschaft hinzufügen → Relation** und die Zieldatenbank wählen.
2. Optional **in beide Richtungen**: Die Zieldatenbank erhält eine Gegen-Eigenschaft, Änderungen werden auf beiden Seiten gepflegt.
3. In der Zelle Einträge suchen und verknüpfen; mehrere Verknüpfungen lassen sich einzeln entfernen oder gemeinsam leeren.

Relationen erscheinen im Eintrag als Links. Die Datenbanksuche findet Einträge auch über die Namen verknüpfter Einträge, Relationsfilter bieten diese Namen direkt an.

## Rollups

1. Zuerst eine Relation anlegen.
2. **Eigenschaft hinzufügen → Rollup**, dann Relation und Eigenschaft der Zieldatenbank wählen.
3. Berechnung wählen – 22 stehen zur Verfügung, passend zum Typ: Originalwerte, eindeutige Werte, Anzahl, leer/gefüllt (auch als Anteil), Summe, Mittelwert, Median, Minimum, Maximum, Spannweite, abgehakt/nicht abgehakt, frühestes und spätestes Datum, Zeitraum.

Zahlen-Rollups erscheinen als Zahl, Fortschrittsbalken, Fortschrittsring oder Bewertung, mit einstellbarem Zielwert. Werte aus Datenbanken, die jemand nicht lesen darf, werden für diese Person nicht geladen.

## Formeln

Im Eigenschaftsdialog den Typ **Formel** wählen. Der Editor bietet 58 Funktionen mit Suche, Kategorien, Signaturen und Beispielen, Vorschläge beim Tippen und eine Live-Vorschau an einem wählbaren Eintrag.

```
round(prop("Aufwand") * prop("Stundensatz"), 2)
```

```
if(prop("Erledigt"), "✓", concat(format(dateBetween(prop("Fällig"), today(), "days")), " Tage"))
```

- Bezüge mit `prop("Name")` bleiben beim Umbenennen der Eigenschaft gültig.
- Syntaxfehler zeigen ihre Position und verhindern das Speichern.
- Zahlenergebnisse stehen in Filtern, Sortierungen, Diagrammen und Spaltenberechnungen zur Verfügung.
- Datumsfunktionen rechnen ohne ausdrückliche Zone in UTC; `now()` und `today()` aktualisieren sich minütlich.
- Formeln führen kein JavaScript aus; Länge, Verschachtelung und Ergebnisgröße sind begrenzt.

### Funktionsgruppen

| Gruppe | Beispiele |
| --- | --- |
| Logik | `if`, `ifs`, `coalesce`, `and`, `or`, `not`, `empty` |
| Zahlen | `sum`, `average`, `min`, `max`, `round`, `ceil`, `floor`, `abs`, `mod`, `pow`, `sqrt` |
| Text | `concat`, `length`, `contains`, `replace`, `replaceAll`, `trim`, `slice`, `lower`, `upper`, `format`, `toNumber` |
| Datum | `now`, `today`, `parseDate`, `formatDate`, `dateAdd`, `dateSubtract`, `dateBetween`, `year`, `month`, `day`, `hour`, `timestamp` |
| Listen | `list`, `count`, `at`, `first`, `last`, `join`, `split`, `unique`, `sort`, `reverse` |

Die vollständige Liste zeigt der Formeleditor.
