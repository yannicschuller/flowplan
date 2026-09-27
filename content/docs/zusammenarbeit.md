# Zusammenarbeit und Kommentare

Mehrere Personen schreiben gleichzeitig in derselben Seite, ohne sich zu überschreiben. Kommentare, Erwähnungen und der Posteingang halten Gespräche beim Inhalt.

## Gleichzeitig bearbeiten

- Dokumente und Eintragsinhalte werden über Yjs (CRDT) zusammengeführt: Jede Änderung bleibt erhalten, auch wenn zwei Personen im selben Absatz tippen.
- Änderungen erscheinen bei den anderen nach Sekundenbruchteilen: Der Server schiebt jede gespeicherte Änderung sofort an alle, die dasselbe Dokument offen haben (Server-Sent Events). Übertragen wird nur das Geänderte, nicht das ganze Dokument.
- **Farbige Cursor und Auswahlen** mit Namen zeigen, wo andere gerade schreiben; Bewegungen kommen ebenfalls sofort an.
- Ohne Verbindung arbeitest du weiter; die Änderungen werden abgeglichen, sobald das Netz zurück ist.
- Datenbank-Änderungen werden auf Versionskonflikte geprüft: Hat jemand denselben Eintrag inzwischen geändert, wird deine Änderung nicht stillschweigend darübergeschrieben, sondern abgelehnt, und du siehst den neuen Stand.
- Gäste mit Bearbeitungslink arbeiten ebenfalls live mit und sehen die Cursor der Mitglieder; Mitglieder sehen die Gäste als „Gast · <Linkname>“.
- Auf Whiteboards gibt es zusätzlich [Live-Cursor](/docs/whiteboards#gemeinsam-arbeiten) wie in Miro.

## Reaktionen

- **Kommentare**: Unter jedem Seiten- und Eintragskommentar fügt das Smiley eine Reaktion hinzu (👍 ❤️ 🎉 😄 👀 ✅ 🙏 🔥). Ein Klick auf eine vorhandene Reaktion schließt sich an oder nimmt die eigene zurück; der Tooltip zeigt, wer reagiert hat. Reagieren kann jeder, der die Seite sehen darf.
- **Absätze und Überschriften**: Steht der Cursor in einem Absatz, erscheint an seinem Ende ein Smiley. Die Reaktionen stehen als kleine Pillen am Block, werden im Dokument gespeichert und erscheinen bei allen sofort. Das geht für alle, die die Seite bearbeiten dürfen.
- Textkommentare haben ihre eigenen Reaktionen im Thread.

## Seiten folgen

Die Glocke oben auf einer Seite schaltet **Folgen** ein oder aus. Wer einer Seite folgt, bekommt eine Benachrichtigung, sobald jemand anderes sie ändert – eine pro Seite, bis du sie wieder angesehen hast. Mit E-Mail-Versand landet sie in der E-Mail-Zusammenfassung. Wer eine Seite anlegt, folgt ihr automatisch. Unter **Einstellungen → Benachrichtigungen** lässt sich die Art „Änderungen an Seiten, denen du folgst“ für Posteingang, Push und E-Mail einzeln abschalten.

## Wer hat die Seite gesehen?

Das Auge neben der Glocke zeigt, wer die Seite geöffnet hat und wann. Ein Haken bedeutet, dass die Person den neuesten Stand gesehen hat; „älter“, dass sich die Seite seitdem geändert hat. Angezeigt werden nur Personen, die die Seite noch sehen dürfen.

## Änderungen seit deinem letzten Besuch

Hat jemand anderes eine Seite geändert, seit du sie zuletzt geöffnet hast, erscheint oben ein Hinweis mit den Namen. Bei Dokumenten zeigt **Änderungen zeigen** die Textänderungen seit deinem letzten Besuch (eingefügt und gelöscht, wie im Versionsverlauf). Bei Datenbanken nennt der Hinweis die Zahl der bearbeiteten Einträge.

Die Startseite listet unter **Zuletzt angesehen** die Seiten, die du zuletzt geöffnet hast.

## Seitenkommentare

Das Sprechblasen-Symbol in der Kopfzeile öffnet die Kommentare der Seite. Kommentare können formatiert sein (Listen, Links, Zitate, Code) und Personen mit `@` erwähnen. <kbd>⌘</kbd> <kbd>Enter</kbd> sendet.

## Textkommentare

Text markieren und **Text kommentieren** wählen oder <kbd>⌘</kbd> <kbd>⌥</kbd> <kbd>M</kbd> drücken.

- Der kommentierte Text wird markiert; Klick darauf öffnet den Thread.
- Antworten, Emoji-Reaktionen, **Erledigen** und **Wieder öffnen**.
- Eigene Beiträge lassen sich bearbeiten und löschen.
- Wird der Text später gelöscht, bleibt das Zitat im Thread erhalten.
- Entwürfe bleiben gespeichert, bis du sie sendest oder verwirfst.

Textkommentare gibt es in Dokumenten und in den Inhalten von Datenbankeinträgen, auch in Exporten und Inhaltsarchiven.

## Erwähnungen

- `@Name` in Text oder Kommentar benachrichtigt die Person. Die Personensuche zeigt nur Mitglieder, die die Seite lesen dürfen.

## Posteingang

Der **Posteingang** in der Seitenleiste sammelt Erwähnungen, Kommentare und Antworten, Datums-Erinnerungen sowie Kommentare und Einträge von Gästen. Ungelesenes ist markiert; ein Klick springt zur Stelle – bei Textkommentaren direkt in den Thread. Welche Ereignisse als Push-Nachricht kommen, stellst du unter **Einstellungen → Benachrichtigungen** ein (siehe [Suche, Posteingang und Push](/docs/suche-und-benachrichtigungen)).
