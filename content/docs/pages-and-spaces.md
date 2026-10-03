# Seiten und Bereiche

Alles in Flowplan ist eine Seite in einem Baum. Bereiche gliedern den Baum, Arbeitsbereiche trennen Teams voneinander.

## Aufbau

| Ebene | Was sie ist |
| --- | --- |
| **Arbeitsbereich** | Getrennte Welt mit eigenen Mitgliedern, Gruppen, Vorlagen und Speicherkontingent. Wechsel über den Namen oben in der Seitenleiste. |
| **Bereich** | Abschnitt in der Seitenleiste, z. B. „Teamspace“ oder „Privat“. Öffentlich für alle Mitglieder oder privat. |
| **Seite** | Dokument, Datenbank, Whiteboard oder Journal. Seiten können beliebig tief Unterseiten haben. |

## Seitentypen

- **Dokument**: Text mit Blöcken – Überschriften, Listen, Aufgaben, Tabellen, Code, Formeln, Diagramme, Einbettungen. Siehe [Dokumente und Editor](/docs/documents).
- **Datenbank**: Einträge mit Eigenschaften, gezeigt als Tabelle, Board, Kalender, Timeline, Galerie, Liste, Feed, Diagramm oder Formular. Siehe [Datenbanken](/docs/databases).
- **Whiteboard**: unendliche Fläche mit Notizzetteln, Formen, Verbindungen, Stift und Rahmen. Siehe [Whiteboards](/docs/whiteboards).
- **Journal**: eine Seite pro Tag, offene Aufgaben wandern mit. Siehe [Journal](/docs/journal).

## Seitenaktionen

Das Menü `…` oben rechts auf jeder Seite bietet:

| Aktion | Wirkung |
| --- | --- |
| Icon ändern, Cover ändern | Emoji, Symbol oder eigenes Bild; Titelbild hochladen oder ein vorhandenes Bild wählen und die Position einstellen. |
| Volle Breite | Inhalt nutzt die ganze Fensterbreite. |
| Schrift wechseln | Standard, Serif oder Mono für diese Seite. |
| Seite sperren | Schützt vor versehentlichen Änderungen, bis jemand entsperrt. |
| Duplizieren | Kopie samt Unterseiten, Datenbanken und Dateien; interne Links zeigen auf die Kopien. |
| Verschieben | Unter eine andere Seite, in einen anderen Bereich oder Arbeitsbereich. |
| Als Vorlage speichern | Siehe [Vorlagen](/docs/templates). |
| Exportieren, Drucken / PDF | Siehe [Import, Export und Versionen](/docs/import-export-versions). |
| Versionsverlauf | Frühere Stände vergleichen und wiederherstellen. |
| In den Papierkorb | Seite samt Unterseiten entfernen, wiederherstellbar. |

### Rechtsklick in der Seitenleiste

Ein Rechtsklick auf eine Seite im Seitenbaum oder unter Favoriten – auf dem Smartphone langes Drücken – öffnet ihre Aktionen direkt: **In neuem Tab öffnen**, **Link kopieren**, **Zu Favoriten**, **Teilen**, **Unterseite hinzufügen**, **Icon ändern**, **Duplizieren**, **Verschieben**, **Exportieren**, **Seite sperren** und **In den Papierkorb**. Aktionen mit Dialog öffnen die Seite vorher.

### Seiten filtern

Das Feld **Seiten filtern** über dem Seitenbaum blendet alles aus, was nicht passt; übergeordnete Seiten der Treffer bleiben sichtbar und aufgeklappt. <kbd>Esc</kbd> leert den Filter. Vorlagen, Medien, Papierkorb, Einstellungen und Administration liegen als Symbolleiste unten in der Seitenleiste.

## Ordnen und verschieben

- In der Seitenleiste Seiten per Drag and Drop umsortieren oder auf eine andere Seite ziehen, um sie unterzuordnen.
- **Seiten auswählen** (Häkchen-Symbol am Bereich) markiert mehrere Seiten, die sich gemeinsam verschieben oder löschen lassen.
- **Verschieben** in einen anderen Arbeitsbereich nimmt Unterseiten, Datenbankeinträge und Dateien mit. Freigaben für Gruppen oder Personen, die dort nicht Mitglied sind, entfallen. Datenbanken mit Relationen zu zurückbleibenden Datenbanken müssen vorher gelöst werden.

> [!NOTE]
> Beim Verschieben behalten Seiten ihre Adresse. Links auf die Seite funktionieren weiter, sofern die lesende Person Zugriff im neuen Arbeitsbereich hat.

## Favoriten und „Verlinkt von“

Der Stern in der Kopfzeile legt eine Seite unter **Favoriten** in der Seitenleiste ab – persönlich, andere sehen deine Favoriten nicht. Unten auf jeder Seite zeigt **Verlinkt von**, welche Seiten auf diese verweisen.

## Bereiche verwalten

Über `…` neben einem Bereich oder **Einstellungen → Bereiche**:

- umbenennen, Emoji oder Symbol und eine von neun Farben vergeben,
- Sichtbarkeit zwischen öffentlich (alle Mitglieder) und privat wechseln,
- **Bereich duplizieren**: unabhängige Kopie aller aktiven Seiten, Einträge und Anhänge; Kommentare, Versionen und Freigaben werden nicht übernommen,
- in den Papierkorb verschieben. Der letzte aktive Bereich bleibt erhalten, bis ein weiterer existiert.

## Papierkorb

Gelöschte Seiten und Bereiche landen im **Papierkorb** unten in der Seitenleiste. Dort lassen sie sich wiederherstellen oder endgültig löschen. Veröffentlichungen, Freigabelinks und Formulare werden beim Löschen deaktiviert und bei der Wiederherstellung nicht automatisch wieder eingeschaltet.

## Graph der Verlinkungen

Das Netz-Symbol unten in der Seitenleiste (oder `> graph` in der Schnellsuche) zeigt alle Seiten als Punkte und ihre Links als Linien. Große Punkte haben viele Verbindungen; Farben unterscheiden Dokumente, Datenbanken, Whiteboards und Journale.

- Ziehen verschiebt, Mausrad oder zwei Finger zoomen, ein Klick öffnet die Seite.
- Überfahren hebt eine Seite und ihre Nachbarn hervor; **Hervorheben** markiert Seiten nach Titel.
- **Unterseiten verbinden** zeigt zusätzlich die Seitenhierarchie (gestrichelt), **Seiten ohne Verbindung** blendet einzelne Seiten ein oder aus.
- Als Verbindung zählen Links auf Seiten, eingebettete Whiteboards, verknüpfte Datenbanken und synchronisierte Blöcke. Der Graph zeigt nur, was du sehen darfst.

## Nicht verlinkte Erwähnungen

Unter **Verlinkt von** am Seitenende listet **Nicht verlinkte Erwähnungen** Dokumente, in denen der Titel dieser Seite vorkommt, ohne dass er verlinkt ist (Titel ab vier Zeichen). **Verlinken** macht die erste Erwähnung dort zu einem Link auf diese Seite.

