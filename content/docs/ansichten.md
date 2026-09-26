# Ansichten

Eine Datenbank kann beliebig viele Ansichten haben. Jede Ansicht zeigt dieselben Einträge mit eigener Darstellung, eigenen Filtern, Sortierungen und Gruppen.

Neue Ansicht: **+** neben den Ansichtsreitern, dann die Darstellung wählen. **Ansicht und Eigenschaften** steuert, welche Eigenschaften sichtbar sind und in welcher Reihenfolge.

## Tabelle

- Zellen direkt bearbeiten, Einträge über den Titel als Seite öffnen.
- Spalten per Drag and Drop verschieben, an den Rändern in der Breite ändern.
- Unter jeder Spalte eine Berechnung wählen.
- Gruppierte Tabellen klappen Gruppen ein und zeigen Zusammenfassungen je Gruppe.

## Board

Die Kanban-Ansicht gruppiert Karten in Spalten, etwa nach Status, Auswahl, Person oder Relation.

- Karten per Drag and Drop zwischen und innerhalb von Spalten verschieben: Die Karte hebt sich ab, die Zielspalte öffnet eine Lücke, beim Loslassen setzt sich die Karte hinein. Das ändert die gruppierende Eigenschaft.
- **Neu** am Fuß einer Spalte legt einen Eintrag direkt in dieser Gruppe an.
- Spalten umsortieren, ausblenden oder einklappen; „Ohne Gruppe“ sammelt Einträge ohne Wert.
- Untergruppen teilen das Board zusätzlich in Zeilen (Swimlanes).
- Bei Mehrfachauswahl und Relationen kann eine Karte in mehreren Spalten erscheinen; Verschieben ersetzt nur die jeweilige Zuordnung.
- Auf Touchgeräten lassen sich Karten ebenfalls ziehen.

## Kalender

Monats-, Wochen- und Tagesansicht nach einem Datumsfeld.

- Woche und Tag zeigen ein Stundenraster mit Ganztagszeile und nebeneinander angeordneten Überschneidungen.
- Termine in 15-Minuten-Schritten verschieben, an den Rändern verlängern oder verkürzen.
- Klick auf eine Stunde legt einen Termin an, **Ganztägig +** einen Ganztagseintrag.
- Jede Ansicht hat eine eigene Zeitzone; ohne Einstellung gilt die des Browsers.
- Tastatur: <kbd>Alt</kbd> + <kbd>↑</kbd>/<kbd>↓</kbd> verschiebt um 15 Minuten, <kbd>Alt</kbd> + <kbd>←</kbd>/<kbd>→</kbd> um einen Tag.

## Timeline

Balken von einem Beginn- bis zu einem End-Datumsfeld, im Maßstab Woche, Monat, Quartal oder Jahr.

- Balken verschieben oder an den Rändern ziehen; das Kalendersymbol öffnet einen Datumsdialog, auch für ungeplante Einträge.
- **Heute** springt zum aktuellen Datum; Wochenenden lassen sich markieren.
- Tastatur: <kbd>Alt</kbd> + <kbd>←</kbd>/<kbd>→</kbd> verschiebt um einen Tag, mit <kbd>⇧</kbd> ändert es das Ende, mit <kbd>Strg</kbd> den Beginn.

## Galerie

Karten mit Vorschaubild und ausgewählten Eigenschaften. Das Bild kommt wahlweise aus dem Inhalt des Eintrags, seinem Cover oder einer Dateien-Eigenschaft, füllend oder eingepasst.

## Liste

Kompakte Zeilen mit Titel und wenigen Eigenschaften, gut für lange Sammlungen.

## Feed

Einträge samt Dokumentinhalt untereinander, wie ein Blog oder ein Protokoll. Titel, **Eintrag öffnen** oder die Kommentaranzahl öffnen den vollständigen Eintrag. Weitere Einträge laden in Schritten von 20.

## Diagramm

**Diagramm konfigurieren** wählt Säulen, Balken, Linie oder Donut, die Gruppierung und die Berechnung – Anzahl, Summe, Mittelwert, Minimum, Maximum. Datumswerte lassen sich nach Tag, Woche, Monat oder Jahr zusammenfassen. Ein Klick auf einen Datenpunkt zeigt die zugehörigen Einträge; **Auswertung als CSV** exportiert alle Werte.

## Formular

Sammelt Einträge über ein Formular, auch von Personen ohne Konto. Siehe [Formulare](/docs/formulare).

## Verknüpfte Datenbanken

In einem Dokument zeigt `/db` eine Ansicht einer vorhandenen Datenbank. Die Einbettung hat eigene Ansichten, Filter und Sortierungen; Einträge und ihre Änderungen gehören weiter zur Quelle. Der Quellname im Kopf öffnet die vollständige Datenbank.

Zum Lesen braucht man Zugriff auf Dokument und Quelle. Die Einbettung erteilt keine zusätzlichen Rechte, **Entfernen** löscht nur den Block.
