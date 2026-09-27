# Datenbanken

Eine Datenbank ist eine Sammlung von Einträgen mit Eigenschaften. Dieselben Einträge lassen sich als Tabelle, Board, Kalender, Timeline, Galerie, Liste, Feed, Diagramm oder Formular zeigen.

## Datenbank anlegen

**Neue Seite → Datenbank** legt eine Datenbank mit einer Tabellenansicht an. Alternativ eine [Vorlage](/docs/vorlagen) verwenden, etwa „Aufgaben“ oder „Projekte“, oder eine CSV-Datei importieren (siehe [Import, Export und Versionen](/docs/import-export-versionen)).

## Einträge

- **Neu** unten in der Tabelle oder oben rechts legt einen Eintrag an und öffnet ihn mit markiertem Titel – einfach lostippen, <kbd>Enter</kbd> speichert.
- Ein Klick auf den Titel öffnet den Eintrag als Seite: oben der Titel zum direkten Bearbeiten, darunter die Eigenschaften, darunter ein vollständiges Dokument mit demselben Editor wie jede andere Seite – samt Kommentaren, Versionsverlauf und gemeinsamer Bearbeitung.
- **Datensatzvorlagen** geben neuen Einträgen Eigenschaften und Inhalt vor. Eine Vorlage kann Standard für neue Einträge sein.
- Mehrere Einträge auswählen (Kästchen links) und gemeinsam bearbeiten, duplizieren oder löschen – bis zu 500 auf einmal. Vorher sichert Flowplan einen Stand, der sich über den Versionsverlauf wiederherstellen lässt.
- Gelöschte Einträge liegen im Papierkorb der Datenbank und lassen sich zurückholen.

## Eigenschaften

| Typ | Inhalt |
| --- | --- |
| Text, Zahl | Zahlen mit Format: Währung, Prozent, Dezimalstellen, Tausendertrennzeichen |
| Datum | Mit oder ohne Uhrzeit und Enddatum, Zeitzone, persönliche Erinnerungen, Wiederholung |
| Auswahl, Mehrfachauswahl | Farbige Optionen, z. B. für Status oder Schlagworte |
| Checkbox, Checkliste | Abhaken; Checklisten mit mehreren Punkten und Fortschritt |
| URL, E-Mail, Telefon | Anklickbar |
| Person | Mitglieder des Arbeitsbereichs; Zuweisung benachrichtigt |
| Dateien | Anhänge und Bilder direkt am Eintrag |
| Relation, Rollup | Verknüpfung mit Einträgen einer anderen Datenbank und Berechnungen darüber |
| Formel | Berechneter Wert aus anderen Eigenschaften |
| Erstellt am/von, Bearbeitet am/von | Werden automatisch gepflegt |

Relationen, Rollups und Formeln sind unter [Eigenschaften, Formeln und Rollups](/docs/eigenschaften-und-formeln) beschrieben.

## Große Datenbanken

Tabellen, Listen und Galerien zeigen zuerst 100 Einträge; beim Scrollen folgen die nächsten 100, Gruppen und Board-Spalten haben **Weitere anzeigen**. Suche, Filter, Sortierung und Spaltenberechnungen gelten trotzdem immer für alle Einträge. So öffnen sich auch Datenbanken mit Tausenden Einträgen in Sekundenbruchteilen.

## Filtern, sortieren, gruppieren

Jede Ansicht hat eigene Einstellungen:

- **Filter** mit UND/ODER-Gruppen, für Datumsfelder auch relative Zeiträume („diese Woche“, „letzte 30 Tage“), die sich täglich selbst aktualisieren.
- **Sortierung** nach mehreren Eigenschaften.
- **Gruppierung** nach fast jeder Eigenschaft (außer Dateien und Checklisten), mit bis zu fünf Ebenen in Tabellen und Listen; Boards zeigen die zweite Ebene als Zeilen (Swimlanes).
- **Suche** innerhalb der Datenbank, auch im Text der Eintragsdokumente.
- **Spaltenberechnungen** unter Tabellenspalten: Summe, Durchschnitt, Median, Minimum, Maximum, Anteile, früheste und späteste Daten und mehr.

## Wiederkehrende Einträge

Datumsfelder lassen sich täglich, wöchentlich, monatlich oder jährlich wiederholen. Kalender und Timeline zeigen die Wiederholungen; es bleibt ein einziger Eintrag. Eine einzelne Wiederholung lässt sich bei Bedarf als eigener Eintrag lösen.

## Datums-Erinnerungen

Im Eintrag kann jede Person für jedes gefüllte Datumsfeld eine persönliche Erinnerung setzen – bei Uhrzeiten zum Termin oder 5 Minuten bis 1 Woche vorher, bei ganztägigen Daten am Tag oder 1, 2 bzw. 7 Tage vorher um 09:00. Erinnerungen erscheinen im Posteingang und als Push-Nachricht und ändern den Eintrag nicht.

## Rechte pro Eintrag

Unter **Eintragsrechte** lässt sich ein Eintrag über die Rechte der Datenbank hinaus einschränken:

- **Rechte wie Datenbank**: Standard.
- **Schreibgeschützter Eintrag**: nur die Verwaltenden (Seiteneigentümer und die Person, die den Eintrag angelegt hat) und ausdrücklich Freigegebene ändern ihn.
- **Privater Eintrag**: nur Verwaltende und Freigegebene sehen ihn.

Freigaben an Personen oder Gruppen gehen nie über die Rolle an der Datenbankseite hinaus.
