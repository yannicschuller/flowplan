# Dokumente und Editor

Der Editor arbeitet mit Blöcken: Jeder Absatz, jede Liste, Tabelle oder Einbettung ist ein Block, den du einfügen, formatieren, einrücken und verschieben kannst. Gespeichert wird laufend, auch ohne Verbindung.

## Das Blockmenü mit /

Am Zeilenanfang oder nach einem Leerzeichen öffnet `/` das Blockmenü direkt an der Schreibmarke. Weitertippen filtert: `/h2`, `/todo`, `/code`, `/tab`. Pfeiltasten wählen, <kbd>Enter</kbd> oder <kbd>Tab</kbd> fügt ein, <kbd>Esc</kbd> schließt.

> [!TIP]
> Einen normalen Schrägstrich schreibst du, indem du nach `/` ein Leerzeichen tippst oder das Menü mit <kbd>Esc</kbd> schließt. In Codeblöcken ist `/` immer ein gewöhnliches Zeichen.

| Block | Kürzel im Menü | Wofür |
| --- | --- | --- |
| Text | `/text` | Normaler Absatz |
| Überschrift 1–3 | `/h1`, `/h2`, `/h3` | Gliederung; erscheinen im Inhaltsverzeichnis |
| Aufgabenliste | `/todo` | Abhakbare Aufgaben |
| Aufzählung, Nummerierte Liste | `/ul`, `/ol` | Listen, beliebig verschachtelt |
| Zitat | `/quote` | Hervorgehobenes Zitat |
| Hinweis | `/callout` | Farbiger Kasten mit Symbol |
| Aufklappbarer Block | `/toggle` | Inhalt, der sich ein- und ausklappen lässt |
| Code | `/code` | Syntaxhervorhebung für 192 Sprachen |
| Tabelle | `/table` | Einfache Tabelle im Text |
| Bild oder Datei | `/bild`, `/datei` | Upload oder Auswahl aus der Mediathek |
| Mermaid-Diagramm | `/mermaid` | Ablauf-, Sequenz-, Klassendiagramme als Text |
| Formel, Inline-Formel | `/math`, `/inlinemath` | LaTeX, dargestellt mit KaTeX |
| Seite oder Person erwähnen | `/mention` oder `@` | Verweis auf Seite oder Person |
| Whiteboard | `/board` | Whiteboard im Dokument einbetten |
| Verknüpfte Datenbank | `/db` | Ansicht einer vorhandenen Datenbank |
| Zwei Spalten | `/spalten` | Inhalte nebeneinander |
| Einbetten | `/embed` | Player für YouTube, Vimeo, Loom, Spotify, Figma, CodePen; sonst Linkkarte |
| Spoiler | `/spoiler` | Verdeckter Text, per Klick sichtbar |
| Trennlinie | `/hr` | Horizontale Linie |

## Markdown-Kürzel

Beim Tippen wandelt der Editor um:

| Tippen | Ergebnis |
| --- | --- |
| `#`, `##`, `###` + Leerzeichen | Überschrift 1–3 |
| `-` oder `*` + Leerzeichen | Aufzählung |
| `1.` + Leerzeichen | Nummerierte Liste |
| `[]` + Leerzeichen | Aufgabe |
| `>` + Leerzeichen | Zitat |
| ` ``` ` | Codeblock |
| `---` | Trennlinie |
| `**fett**`, `*kursiv*`, `` `code` ``, `~~durch~~` | Formatierung im Text |

## Text formatieren

Text markieren öffnet die Formatierungsleiste: Überschrift, **Fett**, *Kursiv*, Unterstrichen, Durchgestrichen, Code, Link, Farbe und Hintergrundfarbe, Hoch- und Tiefgestellt, Inline-Formel, **Verdecken (Spoiler)** und **Text kommentieren**.

- Formatierungen gelten nur für die aktuelle Zeile. Nach <kbd>Enter</kbd> beginnt die neue Zeile als normaler Text – nur Listen und Aufgaben setzen sich mit einem neuen Eintrag fort, nach einer Überschrift folgt ein Absatz.

### Spoiler

Verdeckter Text bleibt auch beim Schreiben verdeckt. Ein Klick auf die Fläche deckt ihn auf, ein weiterer verdeckt ihn wieder. <kbd>⌘</kbd> <kbd>⌥</kbd> <kbd>H</kbd> verdeckt die Auswahl. Auch auf Whiteboards lassen sich Zettel und Texte verdecken.

## Einrücken

- <kbd>Tab</kbd> am Anfang eines Absatzes oder einer Überschrift rückt ein (bis zu acht Stufen), <kbd>⇧</kbd> <kbd>Tab</kbd> rückt zurück.
- <kbd>Backspace</kbd> am Anfang einer eingerückten Zeile nimmt zuerst eine Stufe weg.
- In Listen verschachtelt <kbd>Tab</kbd> den Eintrag unter den vorigen, in Codeblöcken fügt es zwei Leerzeichen ein.

## Blöcke verschieben

Links neben jedem Block erscheint beim Überfahren ein Griff (`⋮⋮`). Ziehen zeigt eine Einfügelinie; nach dem Loslassen gleitet der Block an die neue Stelle. Ein Klick auf den Griff öffnet **Blöcke verwalten**: verschieben – auch in Hinweise oder Spalten –, duplizieren oder löschen, einzeln oder mehrere benachbarte Blöcke.

<kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>↑</kbd>/<kbd>↓</kbd> verschiebt den aktuellen Block unter seinen Nachbarn. Jede Blockaktion lässt sich einzeln rückgängig machen.

## Bilder, Dateien und Einbettungen

- **Einfügen aus der Zwischenablage** (<kbd>⌘</kbd> <kbd>V</kbd>) oder Hineinziehen lädt Bilder und Dateien hoch. Bilder lassen sich an den Rändern in der Größe ändern.
- **Fotos werden vor dem Hochladen verkleinert**: höchstens 2560 px an der längeren Seite, gespeichert als WebP. Die Kameradrehung bleibt erhalten, Metadaten wie der Aufnahmeort werden entfernt. GIFs, SVGs und Dateien, die kaum kleiner würden, bleiben unverändert. Anhänge in Dateien-Eigenschaften und Formularen werden im Original gespeichert.
- Die **Medien** in der Seitenleiste sammeln alle Uploads des Arbeitsbereichs zum Wiederverwenden.
- **Einbetten** (`/embed`) nimmt eine Adresse entgegen: YouTube, Vimeo, Loom, Spotify, Figma und CodePen erscheinen als Player mit wählbarer Breite, andere Seiten als Linkkarte mit Titel und Vorschaubild.
- Links auf Seiten und Erwähnungen von Personen zeigen beim Überfahren eine Vorschau.
- Die maximale Dateigröße legt die Administration fest (Standard 10 MB).

## Formeln, Diagramme und Code

- **Formeln** in LaTeX: Block mit `/math`, im Text mit `/inlinemath`. Die Vorschau erscheint beim Tippen.
- **Mermaid-Diagramme**: Klick oder <kbd>Enter</kbd> öffnet Quelltext und Vorschau. Bis 20.000 Zeichen und 500 Kanten.
- **Codeblöcke**: Sprache im Kopf wählen, **Zeilenumbruch** und **Kopieren** stehen bereit. <kbd>Tab</kbd> rückt um zwei Leerzeichen ein.

## Seitenlinks und Erwähnungen

`@` sucht Seiten und Personen. Eine Erwähnung einer Person benachrichtigt sie im Posteingang. Links auf Seiten bleiben gültig, auch wenn die Seite umbenannt oder verschoben wird; die Zielseite zeigt sie unter **Verlinkt von**.

## Weitere Blöcke

- **Inhaltsverzeichnis**: listet die Überschriften der Seite und springt per Klick dorthin.
- **Zwei Spalten**: Blöcke nebeneinander; auf dem Smartphone untereinander.
- **Verknüpfte Datenbank**: eine Ansicht einer vorhandenen Datenbank mit eigenen Filtern und Sortierungen; Änderungen an Einträgen landen in der Quelle. Siehe [Ansichten](/docs/ansichten#verknuepfte-datenbanken).
- **Whiteboard**: ein Whiteboard direkt im Dokument; der Knopf oben rechts öffnet es groß.
