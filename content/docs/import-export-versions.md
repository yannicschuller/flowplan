# Import, Export und Versionen

Inhalte kommen als Markdown, CSV oder Archiv herein und gehen als Markdown, PDF oder vollständiges Archiv wieder hinaus. Der Versionsverlauf holt frühere Stände zurück.

## Exportieren

**Seitenaktionen → Exportieren**:

| Format | Inhalt |
| --- | --- |
| **Markdown (.md)** | Eine Datei mit dem Seiteninhalt; Datenbanken mit Übersicht, Eigenschaften und den Dokumenten aller Einträge. |
| **Markdown mit Dateien (.zip)** | `index.md`, Unterseiten unter `pages/`, Eintragsdokumente unter `records/`, Datenbanken zusätzlich als CSV unter `tables/`, Anhänge unter `assets/` – alles relativ verlinkt. |
| **HTML / JSON** | Das ältere Format für Dokumente und Datenbanken. |

**Drucken / PDF** öffnet die Druckansicht des Browsers; dort als PDF sichern.

Der Export berücksichtigt Leserechte und enthält alle Einträge unabhängig von Ansichtsfiltern. Formeln und Mermaid bleiben als Quelltext erhalten. Grenzen je Export: 500 Seiten, 5.000 Einträge, 250 MB Inhalt.

### Drucken und PDF

**Seitenaktionen → Drucken** (oder `> drucken` in der Schnellsuche) druckt die Seite als sauberes Dokument auf A4 – im Druckdialog lässt sie sich auch **als PDF sichern**. Dabei verschwinden Seitenleiste, Werkzeugleisten, Griffe, Kommentarleisten und Hinweise; die Farben sind immer hell, Blöcke werden nicht mitten auf der Seite getrennt, lange Codezeilen umbrochen und externe Links mit ihrer Adresse ausgeschrieben.

## Importieren

- **Markdown, Text oder HTML**: **Einstellungen → Daten → Markdown oder Text importieren**. Überschriften, Listen, Aufgaben, Tabellen, Code (auch `mermaid`) und Formeln werden zu Blöcken.
- **Notion-, AppFlowy- oder Markdown-Export**: **Einstellungen → Daten** nimmt ein ZIP mit Markdown- und CSV-Dateien an. Markdown wird zu Seiten, CSV zu Datenbanken, Ordner zu Unterseiten; verlinkte Bilder und Dateien werden hochgeladen, Datensatzseiten aus Notion den Einträgen zugeordnet. Bis 100 MB, 500 Seiten und 5.000 Einträge je Tabelle; den Zielbereich wählst du vorher.
- **CSV**: in einer Datenbank **CSV importieren** wählen; die Zeilen werden zu Einträgen.
- **Inhaltsarchiv** (siehe unten).

## Inhaltsarchiv

Unter **Einstellungen → Daten** lädst du ein ZIP deines Arbeitsbereichs herunter und importierst es an anderer Stelle – auch in eine andere Flowplan-Instanz.

Enthalten: zugängliche Seiten samt Papierkorb, Datenbanken mit Ansichten und Einträgen, Dokumentinhalte, Relationen, Vorlagen, Kommentare, Versionen, Favoriten und Formularoptionen, dazu alle Dateien mit Prüfsummen.

- Beim Import entstehen neue IDs; interne Links und Relationen werden umgeschrieben.
- Importierte Bereiche und Vorlagen sind privat, Freigaben und Formulare nicht aktiv.
- Ein fehlerhafter Import wird vollständig zurückgerollt.
- Grenzen: 2 GB ZIP, 500 Seiten, 20.000 Dateien, 5.000 Einträge je Datenbank.

Konten, Sitzungen und Anmeldung gehören nicht dazu – die sichert der Betrieb täglich mit der gesamten Instanz.

## Versionsverlauf

**Seitenaktionen → Versionsverlauf**:

- Dokumente sichern automatisch höchstens alle fünf Minuten, Datenbanken vor der ersten Änderung nach zehn Minuten Ruhe.
- **Aktuelle Version sichern** legt jederzeit einen Stand an; manuell gesicherte Versionen bleiben dauerhaft.
- **Änderungen** vergleicht eine Version mit dem aktuellen Stand: hinzugefügter und entfernter Text, bei Datenbanken neue, geänderte und entfernte Einträge und Eigenschaften.
- **Wiederherstellen** setzt die Seite auf diesen Stand zurück.

Automatische Versionen werden nach sieben Tagen auf eine je Tag verdichtet und nach 180 Tagen gelöscht (einstellbar in der Administration).
