# Flowplan

Next.js-Arbeitsbereich für Dokumente, Wissen und Projekte. AppFlowy-inspirierte Oberfläche, ohne AI-Funktionen. OIDC-Anmeldung, gruppenbasierte Administration und responsive Bedienung sind integriert.

**Status:** Lauffähige Implementierung mit umfangreichem Kernumfang. Noch keine vollständig nachgewiesene AppFlowy-Parität. Der genaue Stand und verbleibende Lücken stehen in [docs/FEATURE-PARITY.md](docs/FEATURE-PARITY.md).

Text markieren und **Text kommentieren** oder **Strg/⌘ + Alt + M** wählen: Dokumente und Datensatzseiten unterstützen interne Threads mit Antworten, Emoji-Reaktionen, Erledigen/Wiederöffnen sowie Bearbeiten/Löschen eigener Beiträge. Zitate bleiben nach Textlöschung erreichbar; ZIP-Inhaltsarchive erhalten die Diskussionen. Rechte, Entwürfe und verbleibende Unterschiede stehen in [docs/INLINE-COMMENTS.md](docs/INLINE-COMMENTS.md).

## Lokal starten

Node.js 22.13 oder neuer (Node 24 LTS empfohlen).

```sh
npm ci
cp .env.example .env.local
npm run dev
```

`APP_URL` muss der tatsächlich verwendeten URL entsprechen, einschließlich Host und Port. Für `http://127.0.0.1:3000` muss genau dieser Wert eingetragen werden. Die lokale Vorschau in dieser Arbeitsumgebung verwendet diese Adresse.

Ohne OIDC-Konfiguration steht ausschließlich im Entwicklungsmodus die Schaltfläche **Lokalen Arbeitsbereich öffnen** bereit. Sie öffnet ein gemeinsames lokales Beispielkonto mit normalen Rechten. Im Produktionsmodus existiert kein Demo-Zugang. Testdaten sind Beispiele und keine echten Teamaktivitäten.

```sh
npm run build
npm start
```

## Markdown exportieren

Über **Seitenaktionen → Exportieren** stehen Markdown, Markdown mit Dateien als ZIP und das bisherige HTML-/Datenbank-JSON-Format zur Verfügung. Offene Dokumentänderungen werden vor dem Download gespeichert; ein Speicherfehler verhindert den Export.

- **Markdown (.md):** eine Datei mit dem Seiteninhalt. Datenbanken enthalten eine Übersicht, Eigenschaften und die Dokumente aller Einträge. Anhänge und andere Seiten bleiben Links zu Flowplan und benötigen die jeweiligen Zugriffsrechte.
- **Markdown mit Dateien (.zip):** `index.md` als Einstieg, optional zugängliche Unterseiten unter `pages/`, Eintragsdokumente unter `records/`, Datenbanken zusätzlich als CSV unter `tables/` und referenzierte lokale Anhänge unter `assets/`. Enthaltene Seiten und Dateien sind relativ verlinkt. Externe Medien werden nicht heruntergeladen.

Der Export berücksichtigt Leserechte und enthält bei Datenbanken alle Einträge und Eigenschaften unabhängig von Ansichtfiltern. Private Relationsziele und unzugängliche Dateien werden nicht aufgelöst. Fehlende referenzierte lokale Dateien brechen den ZIP-Export mit einer Fehlermeldung ab.

Markdown erhält Textformatierung, Listen, Aufgaben, Tabellen und Code. Mathematische Ausdrücke und Mermaid-Diagramme bleiben als Quelltext erhalten; die Darstellung hängt vom verwendeten Markdown-Programm ab. Spalten erscheinen nacheinander, verbundene Tabellenzellen werden in ein rechteckiges Raster überführt. Unterstreichungen, Hervorhebungen und aufklappbare Bereiche verwenden HTML-Erweiterungen. Grundlage sind [GitHub Flavored Markdown](https://github.github.com/gfm/) und [GitHubs Mathematiknotation](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/writing-mathematical-expressions).

Pro Export gelten 500 Seiten, 5.000 Einträge, 250 MB Inhalt einschließlich Anhängen, davon 30 MB Text, sowie 100 MB komprimiertes ZIP. CSV-Textwerte, die wie Tabellenkalkulationsformeln beginnen, erhalten ein führendes Apostroph. Kommentare, Versionen, Berechtigungen und Ansichtseinstellungen gehören nicht zu diesem Inhaltsformat; für die Wiederherstellung gibt es weiterhin das Flowplan-Inhaltsarchiv unter **Einstellungen → Daten**.

## OIDC einrichten

Beim Anbieter einen vertraulichen OIDC-Webclient registrieren:

- Redirect URI: `https://flowplan.example.com/api/auth/callback`
- Authorization Code Flow mit PKCE (S256)
- Scopes: `openid profile email`, zusätzlich der anbieterspezifische Scope für Gruppen
- Die Gruppen müssen im signierten ID-Token oder in der UserInfo-Antwort enthalten sein.

In `.env.local` beziehungsweise in der Serverumgebung:

```dotenv
APP_URL=https://flowplan.example.com
OIDC_ISSUER=https://identity.example.com/realms/company
OIDC_CLIENT_ID=flowplan
OIDC_CLIENT_SECRET=YOUR_CLIENT_SECRET
OIDC_SCOPES=openid profile email groups
OIDC_GROUPS_CLAIM=groups
OIDC_ADMIN_GROUP=flowplan-admins
SESSION_HOURS=8
```

`OIDC_GROUPS_CLAIM` kann einen verschachtelten Pfad wie `realm_access.roles` enthalten. Der Admin-Gruppenname wird exakt verglichen; `flowplan-admins-extra` reicht nicht. `OIDC_ALLOWED_GROUP` kann die Anmeldung auf eine Gruppe beschränken. Keine Gruppennamen oder Rollen werden aus Browserdaten übernommen.

Der Login prüft Discovery, Issuer, Audience, Token-Signatur, PKCE, State und Nonce. Opaque Sitzungen werden gehasht in SQLite gespeichert; Cookies sind HttpOnly, SameSite=Lax und bei HTTPS Secure. Deaktivieren eines Kontos widerruft dessen Sitzungen. Gruppenänderungen beim Anbieter werden bei der nächsten Anmeldung wirksam, spätestens nach Ablauf der konfigurierten Sitzung. Sitzungen lassen sich im Admin-Dashboard gezielt widerrufen.

Einladungen sind ausstehende Freigaben für eine E-Mail-Adresse. Die Zuordnung erfolgt nur nach Anmeldung mit `email_verified=true`; Flowplan versendet derzeit keine E-Mails. Der erste Arbeitsbereich jedes neuen Benutzers ist privat im Sinne der Mitgliedschaft, Team-Bereiche sind nur für seine Mitglieder zugänglich.

## Dokumente und Vorlagen

Seiten können einschließlich Unterseiten, Datenbanken, hochgeladenen Dateien und Datensatzvorlagen dupliziert werden. Interne Seitenlinks und Relationen innerhalb des kopierten Baums werden auf neue IDs umgestellt. Die Kopie erhält unabhängige Dokumente und keine öffentlichen Freigaben.

Datenbankeinträge besitzen denselben Rich-Text-Editor wie Dokumentseiten, mit Zusammenarbeit, Versionsverlauf und Wiederherstellung. Datensatzvorlagen übernehmen Eigenschaften und Inhalt; eine Vorlage kann Standard für neue Einträge sein. Die Startervorlagen für Meetings, Wikis, Projekte und Aufgaben enthalten direkt verwendbare Strukturen.

Angemeldete Personen sehen beim gemeinsamen Arbeiten farbige Cursor und Textauswahlen mit Namen – sowohl in Dokumenten als auch in Datensatzinhalten. Die Positionen folgen gemeinsamen Yjs-Textelementen, sodass Einfügungen vor einer fremden Auswahl diese nicht verschieben. Der Cursorabgleich erfolgt ungefähr jede Sekunde; Inhalte werden weiterhin alle 1,8 Sekunden synchronisiert. Verborgene Tabs und verlassene Editoren ziehen ihren Cursor zurück. Bei einem vollständigen Verbindungsabbruch läuft er spätestens nach 15 Sekunden plus Abfrageintervall aus. Seitenrechte, gültige Sitzungen und Dokumentversionen werden bei jeder Abfrage geprüft. Cursor sind kein gespeicherter Dokumentinhalt und erscheinen weder im Export noch im Versionsverlauf. Öffentliche Gasteditoren besitzen noch keine gemeinsamen Live-Cursor.

Gespeicherte Datenbank-Seitenvorlagen enthalten Ansichten, Einträge mit Rich Text, Datensatzvorlagen und die Formulargestaltung. Beim Verwenden entstehen neue Datensatz- und Dokumentidentitäten; Selbstrelationen werden auf die Kopie umgestellt. Externe Relationen werden nur übernommen, wenn die verwendende Person das Ziel im selben Arbeitsbereich lesen darf. Kopierte Formulare starten deaktiviert und nur für Mitglieder. Das Anlegen einer Seite aus einer Vorlage ist atomar; ein Fehler hinterlässt keine leere Seite. Die API sichert vor dem Ersetzen einer vorhandenen Seite deren bisherigen Inhalt; bei Datenbanken wird zusätzlich der aktuelle Schema-Versionsstand verlangt.

Neue Seitenvorlagen speichern eigene Dateikopien und bleiben nach dem Löschen der Quellseite verwendbar. Jede Verwendung erzeugt unabhängige Uploads mit den Rechten der Zielseite. Bereits vor dieser Erweiterung gespeicherte Vorlagen bitte erneut aus der noch zugänglichen Quelle speichern, um ihre Anhänge ebenfalls zu übernehmen. Vorlagen lassen sich umbenennen, privat/geteilt schalten, in den Papierkorb verschieben und wiederherstellen.

Seiten-Icons bieten 3.979 Unicode-17-Emojis einschließlich Hauttönen und Flaggen. Die Auswahl unterstützt deutsche und englische Suchbegriffe, Kategorien und Hauttöne; vorhandene Symbol-Icons bleiben verfügbar. Die Darstellung neuer Emojis hängt von den Schriftarten des Geräts ab.

## Timeline und Datumsplanung

Die Timeline bietet Wochen-, Monats-, Quartals- und Jahresmaßstab, Datumsnavigation, „Heute“, optional markierte Wochenenden und einen Sprung zu Einträgen außerhalb des Ausschnitts. Maßstab und Wochenendmarkierung werden je Ansicht gespeichert; Leser können ihren Ausschnitt lokal ändern. Suche, Filter und Sortierung gelten auch für die Timeline.

In den Ansichtseinstellungen lassen sich ein Datumsfeld für den Beginn und ein separates Datumsfeld für das Ende auswählen. Balken können mit Maus oder Touch verschoben und an ihren Rändern verlängert oder verkürzt werden. Das Kalendersymbol je Eintrag öffnet einen Datumsdialog, auch für bislang ungeplante Einträge. Alt + Links/Rechts verschiebt den Zeitraum um einen Tag; zusätzlich Umschalt ändert das Ende, Strg den Beginn. Die Randgriffe unterstützen Links/Rechts direkt. Beide Grenzen werden gemeinsam gespeichert. Ungültige Zeiträume, fehlende Rechte, Seitensperren oder veraltete Zeilen-/Ansichtsversionen verhindern die Änderung; Dialogentwürfe bleiben bei einem Fehler erhalten.

Die Timeline plant in Kalendertagen und erhält dabei vorhandene Uhrzeiten und gespeicherte UTC-Offsets. Ein leeres Enddatum bedeutet in der Timeline einen einzelnen Tag. Verknüpfte Timeline-Ansichten behalten ihren eigenen Maßstab und ändern mit den Rechten der Quelle dieselben Datensätze. Die Einstellungen bleiben in Kopien, Vorlagen, Inhaltsarchiven und Versionswiederherstellung erhalten.

## Kalender mit Uhrzeiten

Kalender bieten Monats-, Wochen- und Tagesansicht. Woche und Tag zeigen ein Stundenraster mit Ganztagszeile, nebeneinander angeordneten überlappenden Terminen und gespeicherter IANA-Zeitzone. Ohne gespeicherte Einstellung gilt zunächst die Browser-Zeitzone. Leser können die Ansicht lokal wechseln. Über das Kalendersymbol am Termin lassen sich Beginn und Ende gemeinsam bearbeiten; auch ungeplante oder ungültige Zeiträume sind dort korrigierbar. Ein Klick auf eine Stunde legt einen Termin an, ein Klick auf „Ganztägig +“ einen Ganztagseintrag.

Termine mit Uhrzeit lassen sich im Stundenraster mit Maus oder Touch in 15-Minuten-Schritten verschieben. Bei ausgewähltem Enddatumsfeld ändern obere und untere Randgriffe den Zeitraum. Alt + Auf/Ab verschiebt um 15 Minuten, Alt + Links/Rechts um einen Kalendertag; zusätzlich Umschalt bei Auf/Ab ändert das Ende. Die Randgriffe unterstützen Auf/Ab direkt. Bei parallelen Änderungen wird die Geste abgebrochen; veraltete Datensatz- oder Ansichtsversionen werden serverseitig abgewiesen und Dialogentwürfe bleiben erhalten.

Datumsfelder in Tabellen, Einträgen und Formularen besitzen einen Schalter für Uhrzeiten. Sie zeigen die verwendete Zeitzone; Zeitpunkte werden als ISO-Zeitstempel gespeichert. Ganztägige Werte bleiben reine Datumsangaben. Nicht existierende Uhrzeiten bei der Zeitumstellung werden abgewiesen; bei doppelt vorkommenden Uhrzeiten lässt sich das erste oder zweite Vorkommen auswählen. Das Stundenraster zeigt die tatsächliche Tageslänge, auch 23-, 25- oder halbstündig verkürzte Tage. Eine Zeitzonenänderung ändert die Darstellung, nicht den gespeicherten Zeitpunkt. In Tabellen gilt die Browser-Zeitzone, im Kalender dessen ausgewählte Zeitzone. Ältere importierte Uhrzeiten ohne UTC-Offset werden in dieser Zeitzone interpretiert und beim Speichern in einen eindeutigen Zeitstempel umgewandelt.

Ein fehlendes Ende wird bei zeitgebundenen Terminen als eine Stunde dargestellt. Das Verschieben erhält diese leere Eigenschaft; das Ziehen eines Randgriffs setzt ein ausdrückliches Ende. Zeitgebundene Enden sind exklusiv: ein Termin bis Mitternacht erscheint nicht zusätzlich am Folgetag. Ganztägige Enddaten schließen den letzten Tag ein. Monats-Drag-and-drop am Desktop erhält die Dauer; im Stundenraster bleiben reale Zeitdauern auch über Zeitumstellungen erhalten. Ganztags-Touch-DnD, Erinnerungen, wiederkehrende Termine und weitere Kalenderoptionen sind noch offen.

## Bereiche und Arbeitsbereiche verwalten

Über das Menü neben einem Bereich oder **Einstellungen → Bereiche** lassen sich eigene Bereiche umbenennen, ihre Sichtbarkeit ändern und sie in den Papierkorb verschieben. Arbeitsbereichseigentümer können auch Bereiche anderer Mitglieder verwalten; das gewährt ihnen noch keinen Lesezugriff auf private Seiten. Offene Dokumentänderungen werden vor dem Verschieben in den Papierkorb gespeichert; Speicherfehler verhindern den Vorgang. Der letzte aktive Bereich bleibt erhalten, bis ein weiterer angelegt wurde.

Bereiche können beim Anlegen und später unter **Bereich verwalten** ein Emoji oder Symbol sowie eine von neun Hintergrundfarben erhalten. Die Emoji-Auswahl bietet dieselbe deutsche/englische Suche, Kategorien und Hauttöne wie Seiten-Icons. Symbole und Farben erscheinen in der Navigation, Verwaltung und im Papierkorb und bleiben im ZIP-Inhaltsarchiv erhalten.

**Bereich verwalten → Bereich duplizieren** erstellt eine unabhängige Kopie aller aktiven Seiten, Unterseiten, Datenbanken, Einträge, Eintragsvorlagen und Anhänge. Der Name und die Sichtbarkeit der Kopie sind wählbar; voreingestellt ist ein privater Bereich. Interne Links, verknüpfte Datenbanken und Relationen zwischen kopierten Seiten verweisen auf die Kopien. Bezüge außerhalb des Bereichs bleiben an ihr bisheriges Ziel und dessen Zugriffsrechte gebunden. Kommentare, Versionsverläufe, Freigaben und Papierkorbinhalte werden nicht übernommen; Formulargestaltung bleibt erhalten, kopierte Formulare sind deaktiviert. Vor dem Kopieren werden offene Dokumentänderungen gespeichert. Verwaltungsrechte ohne Lesezugriff auf einen privaten Bereich erlauben keine Inhaltskopie. Fehler brechen die gesamte Kopie ab und entfernen bereits angelegte Kopiedateien.

Im **Papierkorb** können Berechtigte einen Bereich samt seinen zuvor aktiven Seiten wiederherstellen oder endgültig löschen. Seiten, die schon vorher im Papierkorb lagen, bleiben dort. Veröffentlichungen, Freigabelinks und Formulare werden beim Löschen deaktiviert und bei der Wiederherstellung nicht automatisch reaktiviert. Endgültiges Löschen entfernt auch Datensätze, Versionsverläufe und zugehörige Uploads. Unabhängig gespeicherte Seitenvorlagen bleiben erhalten.

Unter **Einstellungen → Allgemein** kann man einen Arbeitsbereich verlassen. Ein letzter aktiver Eigentümer muss zuvor ein anderes aktives Mitglied zum Eigentümer machen. Eigene Bereiche – einschließlich privater und gelöschter Bereiche – werden beim Verlassen ausdrücklich an einen ausgewählten verbleibenden Eigentümer übergeben. Mitgliedschaft, persönliche Gruppen-/Seitenfreigaben und offene eigene Einladungen dieses Arbeitsbereichs werden entfernt; andere Arbeitsbereiche und die Anmeldung bleiben erhalten.

Eigentümer können einen Arbeitsbereich nach Eingabe seines aktuellen Namens **endgültig löschen**. Das umfasst alle privaten und geteilten Inhalte, Vorlagen, Papierkorbinhalte, Anhänge und Freigaben für sämtliche Mitglieder. Diese Aktion lässt sich nicht rückgängig machen. Ein weiterer eigener oder zugänglicher Arbeitsbereich muss vorhanden sein. Die Oberfläche wechselt anschließend in einen verbleibenden Arbeitsbereich.

Dateien werden erst nach erfolgreicher Datenbanktransaktion physisch entfernt. Falls das Dateisystem die Entfernung vorübergehend verhindert, bleibt der Auftrag gespeichert und wird beim nächsten Schreibvorgang oder Serverstart erneut versucht; der Zugriff über die Anwendung ist bereits entzogen.

## Freigabelinks

Unter **Teilen → Links mit eigenen Berechtigungen** lassen sich mehrere benannte Links pro Seite erstellen: **Lesen**, **Kommentieren** und **Bearbeiten**. Jeder Link ist unabhängig widerrufbar und funktioniert ohne Benutzerkonto. Optional werden die derzeit vorhandenen Unterseiten ausdrücklich eingeschlossen; neue Unterseiten werden nicht automatisch hinzugefügt. Der bisherige öffentliche Leselink bleibt separat nutzbar.

Bearbeitungslinks erlauben Änderungen an Seitentiteln, Rich-Text-Inhalten und sichtbaren Eigenschaften bestehender Datensätze. Verwaltungsrechte, Mitgliederangaben, private Relationen, Dateien- und abgeleitete Eigenschaften werden darüber nicht freigegeben. Bearbeitungen werden serverseitig autorisiert und gegen konkurrierende Änderungen geprüft; Dokument- und Datensatzinhalte werden vorher gesichert. Gastkommentare sind für alle Links derselben Seite sowie im internen Kommentarbereich sichtbar und tragen einen Gastvermerk. Interne Kommentare bleiben privat. Inhaltsarchive übernehmen Gastkommentare beim Import als interne Kommentare mit Namensvermerk; sie aktivieren keine Freigaben.

## iOS-Web-App-Benachrichtigungen

Unter **Einstellungen → Benachrichtigungen** kann Push pro Gerät aktiviert, getestet und deaktiviert werden. Auf iOS/iPadOS ab 16.4 Flowplan über HTTPS aufrufen, zum Home-Bildschirm hinzufügen und aus dieser Web-App öffnen. Die Berechtigungsabfrage erscheint erst nach **Push aktivieren**. Hinweise öffnen die betroffene Seite, bei Datensatz- und Textkommentaren den zugehörigen Eintrag beziehungsweise Thread; Testhinweise öffnen den Posteingang. Auf dem Sperrbildschirm erscheinen keine Dokumentinhalte. Kommentarlinks lassen sich direkt im Thread kopieren und gewähren keine zusätzlichen Zugriffsrechte.

**Datums-Erinnerungen:** Im Eintragsdialog lässt sich für jede gefüllte Datumseigenschaft eine persönliche Erinnerung wählen, bei Uhrzeiten zum Termin oder 5 Minuten bis 1 Woche vorher, bei ganztägigen Daten am Tag selbst oder 1, 2 bzw. 7 Tage vorher jeweils um 09:00 in der beim Einrichten verwendeten Zeitzone. Erinnerungen ändern den Eintrag nicht und stehen auch Lesern zur Verfügung. Der Server prüft alle 30 Sekunden, legt fällige Erinnerungen in den Posteingang und stellt sie über Push zu. Jede Erinnerung löst pro Datumswert einmal aus; nach einer Datumsänderung ist sie erneut aktiv. Bereits vergangene Zeitpunkte lösen nicht nachträglich aus. Ohne Lesezugriff wird nichts gesendet.

Der laufende Node-Server verarbeitet eine persistente Versandwarteschlange mit Wiederholungen. Ausgehendes HTTPS zu den Push-Diensten muss erreichbar sein. Für VAPID einen erreichbaren Kontakt als `WEB_PUSH_SUBJECT=mailto:admin@deine-domain.de` konfigurieren. `WEB_PUSH_PUBLIC_KEY` und `WEB_PUSH_PRIVATE_KEY` können gemeinsam vorgegeben werden; andernfalls werden sie einmalig unter `FLOWPLAN_DATA_DIR/web-push-keys.json` erstellt. Diese Datei dauerhaft sichern und aufbewahren. Sitzungsende, Abmeldung oder Kontosperre beenden das Abonnement; nach erneuter Anmeldung Push bei Bedarf wieder aktivieren.

Protokoll, Sitzungsrechte, Warteschlange, Wiederholungen, Manifest, Service Worker und Bedienoberfläche sind automatisiert geprüft. Tatsächliche Zustellung auf einem physischen iPhone ist noch nicht nachgewiesen. Die Web-App besitzt noch keinen vollständigen Offlinebetrieb. Grundlage: [WebKit Web Push für iOS und iPadOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/).

## Tabellen und Formulare

Tabellen unterstützen Mehrfachauswahl zum gemeinsamen Bearbeiten, Duplizieren und Löschen von bis zu 500 Einträgen. Vor jeder Sammeländerung wird ein Datenbankstand einschließlich Inhalten und Kommentaren gesichert. Hat jemand einen ausgewählten Eintrag zwischenzeitlich verändert, wird die gesamte Aktion abgewiesen. Der Versionsverlauf kann den vorherigen Stand wiederherstellen.

Spaltenreihenfolge und -breite werden je Ansicht gespeichert. Am Desktop lassen sich Spaltenköpfe verschieben und Ränder ziehen; unter **Ansicht und Eigenschaften** stehen Reihenfolge-Schaltflächen und Breitenfelder auch auf Mobilgeräten zur Verfügung.

In der Formularansicht öffnet **Formular gestalten** den Editor für Titel, Beschreibung, Reihenfolge, Sichtbarkeit, Pflichtfelder, Hilfetexte und Bestätigung nach dem Absenden. Pflichtfelder und Eingabetypen werden im Browser und auf dem Server geprüft. Die Freigabe kann auf Mitglieder begrenzt werden; anonyme Antworten sind separat konfigurierbar. Diese Einstellungen sind im Inhaltsarchiv enthalten.

## Blöcke verschieben und verwalten

Links neben Dokumentblöcken erscheinen Griffe. Mit Maus oder Touch lassen sich Blöcke an eine angezeigte Einfügelinie ziehen. Ein Klick auf den Griff öffnet **Blöcke verwalten**. Dort können einzelne oder mehrere benachbarte Blöcke derselben Ebene verschoben, dupliziert oder gelöscht werden. Die Zielauswahl erlaubt auch den Wechsel in passende Container, etwa Hinweise oder Spalten. Listen werden als ganze Liste oder als einzelne Listeneinträge behandelt; Tabellen bleiben beim Verschieben zusammen.

**Cmd/Strg + Shift + Pfeil nach oben/unten** verschiebt den aktuellen Block unter seinen Geschwistern. Jede Blockaktion hat im Arbeitsbereich einen eigenen Rückgängig-Schritt. Duplizierte verknüpfte Datenbankblöcke erhalten unabhängige Ansichtseinstellungen; ihre Datenquelle bleibt gemeinsam. Gasteditoren können vorhandene Blöcke verschieben und löschen sowie gewöhnliche Blöcke duplizieren. Kopien verknüpfter Datenbankblöcke sind dem Arbeitsbereich vorbehalten.

Bei eintreffenden Dokumentänderungen wird ein laufender Ziehvorgang abgebrochen. Eine offene Auswahl folgt bestehenden Yjs-Blöcken und verliert gelöschte Blöcke. Auf gesperrten oder nur lesbaren Seiten stehen keine Blockaktionen bereit. Ziehen zwischen Dokumenten und das Erzeugen neuer Spalten durch seitliches Ablegen sind noch nicht implementiert.

## Mermaid-Diagramme

Unter **Block hinzufügen → Mermaid-Diagramm** lassen sich Ablauf-, Sequenz-, Klassen-, Kreisdiagramme und weitere Mermaid-Typen als Block einfügen. Ein Klick oder Enter öffnet den Quelltext mit Vorschau. Ungültige Eingaben bleiben im Dialog; Abbrechen verwirft den Entwurf, Rückgängig/Wiederholen funktioniert nach dem Speichern. Änderungen anderer Personen am selben Diagramm überschreiben einen offenen Entwurf nicht.

Diagramme funktionieren auch in Datensatzdokumenten, Feed-Vorschauen und öffentlichen Seiten. Bearbeitungslinks erlauben ihren Gästen das Ändern und Einfügen. Markdown-Import erkennt `mermaid`-Codezäune. Kopien, Vorlagen, Archive und Versionen erhalten den Quelltext.

Die Darstellung entsteht lokal im Browser mit Mermaid 11.17.2. Diagramme sind auf 20.000 Zeichen und 500 Kanten begrenzt. HTML-Beschriftungen, externe Bild-/CSS-Ressourcen sowie Mermaid-Konfigurationsdirektiven/YAML-Kopfbereiche werden nicht unterstützt. Ungültig importierter Quelltext bleibt erhalten und kann im Editor korrigiert werden. Generierte SVGs werden als Bild angezeigt und gehören nicht zum gespeicherten Dokument; die Diagrammfläche bleibt für gut lesbare Farben auch im Dunkelmodus weiß.

## Codeblöcke

Über **Block hinzufügen → Code** einen Codeblock anlegen und seine Sprache im Kopf auswählen. **Zeilenumbruch** wird mit dem Dokument gespeichert; **Kopieren** übernimmt den reinen Quelltext. Tab rückt mit zwei Leerzeichen ein, Shift-Tab rückt zurück. `/` und `@` sind innerhalb von Code gewöhnliche Zeichen. Codeblöcke funktionieren auch in Datensatzdokumenten und bei freigegebener Gastbearbeitung; Feed und öffentliche Seiten zeigen Syntaxfarben und eine Kopierfunktion.

192 Sprachformate sind verfügbar. Unbekannte importierte Sprachen und Codeblöcke über 50.000 Zeichen werden ohne Hervorhebung vollständig angezeigt. Markdown-Codezäune übernehmen ihre Sprachangabe. Die gespeicherten Inhalte enthalten keine Darstellungs-Spans.

## Verknüpfte Datenbankansichten

Auf einer Dokumentseite **Block hinzufügen → Verknüpfte Datenbank** wählen und die Datenquelle suchen. Jede Einbettung kann eigene Ansichten, Filter, Sortierungen, Gruppen und Reihenfolgen erhalten. Änderungen an Einträgen oder ihren Dokumenten sind sofort Teil der Quelldatenbank. Über den Quellnamen im Kopf der Einbettung öffnest du die vollständige Datenbank und bearbeitest dort ihr Eigenschaftsschema.

Zum Lesen brauchst du Zugriff auf das Dokument und die Quelle. Änderungen an der Darstellung benötigen Bearbeitungsrechte am Dokument; Änderungen an Einträgen benötigen Bearbeitungsrechte an der Quelle. Eine Einbettung erteilt selbst keine zusätzlichen Zugriffsrechte. **Entfernen** löscht nur den Block aus dem Dokument.

Seitenkopien, Vorlagen, Versionen und Inhaltsarchive erhalten die Einstellungen. Wird eine Quelle im selben Seitenbaum mitkopiert oder im Archiv mit importiert, zeigt die neue Einbettung auf deren Kopie. Öffentliche Freigaben und Vorschauen zeigen derzeit einen Platzhalter; aktive Einbettungen in Datensatzdokumenten und vollständige Offline-Datenbankbearbeitung sind noch offen.

## Relative Datumsfilter

Im Filterdialog bei einer Datums-, Erstellungs- oder Änderungs-Eigenschaft **liegt im relativen Zeitraum** wählen. Zeiträume wie heute, diese Woche oder letzte 30 Tage aktualisieren sich automatisch. Die gespeicherte Zeitzone macht das Ergebnis für alle Beteiligten einheitlich. Rollierende Tagesbereiche enthalten heute; Wochen beginnen montags. Leere oder ungültige Datumswerte werden auch bei **liegt außerhalb des relativen Zeitraums** ausgeschlossen. Mit einer ODER-Gruppe und **ist leer** lassen sie sich ausdrücklich einschließen.

## Feed-Ansichten

**Ansicht hinzufügen → Darstellung → feed** zeigt Einträge samt Dokumentinhalt untereinander. Aufgaben sind in der Vorschau schreibgeschützt; über den Titel, **Eintrag öffnen** oder die Kommentaranzahl öffnest du den vollständigen Datensatz. **Ansicht und Eigenschaften** steuert Textvorschau, sichtbare Eigenschaften, Verfasser, Datum und Kommentare. Weitere Einträge werden in Schritten von 20 angezeigt. Suche, Filter und Sortierung gelten auch hier; die Datenbanksuche findet außerdem den Text innerhalb von Datensatzdokumenten.

## Diagramme

Unter **Ansicht hinzufügen → Darstellung → chart** entsteht eine Diagrammansicht derselben Datenbank. **Diagramm konfigurieren** legt Säulen, Balken, Linie oder Donut, Gruppierung und Berechnung fest. Für Summen, Mittelwerte, Minima und Maxima eignen sich Zahlen, numerische Formeln und Rollups; Datumswerte lassen sich nach Tag, Woche, Monat oder Jahr zusammenfassen.

Filter und Suche gelten auch im Diagramm. Ein Klick auf einen Datenpunkt oder eine Gruppe in der Wertetabelle zeigt die zugrunde liegenden Einträge und öffnet deren Datensatzseiten. **Auswertung als CSV** exportiert sämtliche Gruppenergebnisse. Bei mehr als 100 Gruppen zeigt die Grafik die ersten 100; Wertetabelle und Export bleiben vollständig. Mehrfachzuordnungen zählen in jeder ihrer Gruppen. Negative Werte werden in Balken/Linien angezeigt; Donuts benötigen positive Werte.

## Relationen und Rollups

Relationswerte sind nach Eintragsnamen durchsuchbar. Die Auswahl bleibt während des Speicherns sichtbar; mehrere Verknüpfungen lassen sich einzeln ändern oder gemeinsam leeren. Die Datenbanksuche berücksichtigt die Namen zugänglicher verknüpfter Einträge, und Relationsfilter bieten diese Namen direkt zur Auswahl an.

Für einen Rollup zuerst eine Relation anlegen. Anschließend **Eigenschaft hinzufügen → Rollup** wählen, die Relation und eine benannte Eigenschaft der Zieldatenbank auswählen. Es stehen 22 Berechnungen zur Verfügung, passend zum Eigenschaftstyp: Original-/eindeutige Werte, Anzahlen, Leer-/Gefüllt-Anteile, Summe, Mittelwert, Median, Minimum/Maximum/Spannweite, Checkbox-Anteile sowie frühestes/spätestes Datum und Datumsabstand. Leere Zahlenwerte werden beim Mittelwert nicht als Null gezählt.

Numerische Rollups können als Zahl, Fortschrittsbalken oder Fortschrittsring erscheinen. Für Zahlen ist ein positiver Zielwert konfigurierbar; Prozentberechnungen verwenden automatisch 100 Prozent. Verknüpfte Formeln und Rollups werden rekursiv berechnet. Fehlende Rechte, entfernte Eigenschaften, Zyklen und Berechnungsgrenzen werden sichtbar gemeldet. Werte aus nicht zugänglichen Datenbanken werden nicht geladen. Die Konfiguration bleibt in Vorlagen und ZIP-Inhaltsarchiven erhalten.

Boards können nach Relations- und Mehrfachauswahlwerten gruppiert werden. Ein Eintrag kann in mehreren Gruppen erscheinen; beim Verschieben aus einer Gruppe wird nur diese Zuordnung ersetzt. Die Gruppe „Ohne Gruppe“ leert die Zuordnung. Auf Mobilgeräten wird dieselbe Auswahl über den Eintragsdialog geändert. Automatisch synchronisierte bidirektionale Relationen sind noch nicht implementiert.



## Spaltenberechnungen

Unter jeder sichtbaren Tabellenspalte öffnet **Berechnen** beziehungsweise der aktuelle Ergebniswert die Berechnungsauswahl mit Vorschau. Die Einstellung gilt unabhängig pro Ansicht, auch in verknüpften Datenbanken. Zur Auswahl stehen 20 Berechnungen: Einträge/Werte/eindeutige Werte, leere/gefüllte Zellen und deren Anteile; Summe, Durchschnitt, Median, Minimum, Maximum und Spannweite; abgehakte/nicht abgehakte Werte und deren Anteile; frühestes/spätestes Datum und Zeitraum in Tagen. Angeboten werden jeweils die zum Eigenschaftstyp passenden Berechnungen.

**Automatisch** zeigt wie bisher Summen für Zahlenspalten und numerische Formeln/Rollups; **Keine Berechnung** blendet das Ergebnis aus. Suche und Filter bestimmen die berechneten Einträge. Eingeklappte Gruppen bleiben enthalten. Gruppenzusammenfassungen verwenden dieselbe Auswahl; Einträge in mehreren Gruppen werden für das Gesamtergebnis nur einmal gezählt. Verborgene Spalten zeigen keine Zusammenfassung, behalten aber ihre Einstellung.

Leerwerte beeinflussen numerische Durchschnitte nicht, Nullwerte hingegen schon. Fehlerhafte berechnete Werte werden ausgeschlossen und gezählt. Die Berechnung **Einträge zählen** zählt weiterhin sämtliche gefilterten Einträge. Wertbezogene Prozentberechnungen beziehen sich auf die nach Ausschluss fehlerhafter Werte verbleibenden Einträge. Datumswerte werden in UTC verglichen; Datum ohne Uhrzeit entspricht Mitternacht, der Zeitraum misst tatsächlich verstrichene Tage. Zahlen erscheinen mit bis zu vier Nachkommastellen; intern bleibt die volle Zahl erhalten.

Konkurrierende Änderungen überschreiben keine offene Auswahl. Nach einem Konflikt den Dialog schließen und erneut öffnen, um den aktuellen Stand zu bearbeiten. Gesperrte Seiten erlauben nur die Vorschau. Eigenschaftslöschung oder ein ungeeigneter Typwechsel entfernt die zugehörige Berechnung. Kopien, Vorlagen, Versionen und ZIP-Inhaltsarchive erhalten alle gültigen Einstellungen. Details und Prüfnachweise stehen im [Berechnungsabgleich](docs/CALCULATIONS-PARITY.md).

## Datenbankformeln

Im Eigenschaftsdialog den Typ **Formel** wählen. Der Editor bietet 58 Funktionen mit Suche, Kategorien, Signaturen und einfügbaren Beispielen. Vorschläge lassen sich mit Pfeiltasten/Enter oder per Klick übernehmen; die Live-Vorschau verwendet einen auswählbaren lesbaren Datensatz. Beispiel: `round(prop("Aufwand") * prop("Stundensatz"), 2)`.

Statische Eigenschaftsbezüge werden beim Speichern an IDs gebunden und bleiben beim Umbenennen erhalten; im Editor erscheinen weiterhin die lesbaren Namen. Syntaxfehler zeigen ihre Position und verhindern das Speichern. Datensatzabhängige Fehler erscheinen in der Vorschau. Bei konkurrierenden Änderungen bleibt der Entwurf erhalten. Numerische Ergebnisse stehen in Filtern, Sortierung, Diagrammen und der Summe der gefilterten Tabellenzeilen zur Verfügung; fehlerhafte Summenwerte werden ausgewiesen.

Datumsfunktionen verwenden ohne ausdrückliche Zone UTC. `now()` und `today()` aktualisieren sich in Ansichten und Vorschauen im Minutentakt und beim Zurückkehren zur App. Der Interpreter führt kein JavaScript aus und begrenzt Ausdruckslänge, Verschachtelung und Ergebnisgrößen. Der [vollständige Flowplan-Funktionskatalog](docs/FORMULA-PARITY.md) beschreibt Semantik, Beispiele, Grenzen und noch nicht verifizierte AppFlowy-Kompatibilität.

## Inhaltsarchive

**Healthcheck und Backups:** `GET /api/health` meldet ohne Anmeldung nur Zustände (Datenbank, Schreibzugriff auf Uploads, Suchrückstand, fehlgeschlagene Push-Zustellungen) und antwortet bei Fehlern mit 503; Dockerfile und `compose.yaml` nutzen ihn als Healthcheck. Für ein konsistentes Instanz-Backup im laufenden Betrieb `sqlite3 /app/data/flowplan.sqlite "VACUUM INTO '/backup/flowplan.sqlite'"` ausführen und `/app/data/uploads` sowie `web-push-keys.json` mitsichern; zur Wiederherstellung diese Dateien in einen leeren Datenordner legen. `npm run build && npm run check:standalone` startet den Produktions-Server wie im Container mit leerem Datenordner und prüft Healthcheck, Sicherheitsvorgaben, Neustart-Persistenz und eine Wiederherstellung aus einem solchen Backup.

**Betrieb und Speicher:** Admins sehen unter **Administration → Betrieb** Datenbank- und Upload-Größe, Warteschlangen, Suchindex-Rückstand, Versionen und Laufzeit. `FLOWPLAN_WORKSPACE_QUOTA_MB` legt ein Standard-Speicherkontingent je Arbeitsbereich fest (leer oder `0` = unbegrenzt); unter **Administration → Arbeitsbereiche** lässt es sich je Arbeitsbereich überschreiben. Uploads, Seitenkopien, Vorlagen, Veröffentlichungskopien und Importe über dem Kontingent werden abgelehnt.

**Monitoring:** Mit `FLOWPLAN_METRICS_TOKEN` (mindestens 16 Zeichen) liefert `/api/metrics` Kennzahlen im Prometheus-Format (Größen, Warteschlangen, Suchindex-Rückstand, Speicher und Kontingent je Arbeitsbereichs-ID). Der Scraper sendet `Authorization: Bearer <Token>`; ohne gesetztes Token ist der Endpunkt abgeschaltet.

```yaml
scrape_configs:
  - job_name: flowplan
    metrics_path: /api/metrics
    authorization:
      credentials: <FLOWPLAN_METRICS_TOKEN>
    static_configs:
      - targets: ["flowplan:3000"]
```

**Versionsverlauf:** Über **Seitenaktionen → Versionsverlauf** lassen sich Versionen sichern, mit dem aktuellen Stand vergleichen (**Änderungen**) und wiederherstellen. Dokumente sichern automatisch höchstens alle fünf Minuten, Datenbanken vor der ersten Änderung nach zehn Minuten Ruhe. Manuell gesicherte und aus Archiven importierte Versionen bleiben erhalten; automatische Versionen werden nach sieben Tagen auf eine je Tag reduziert und nach `FLOWPLAN_SNAPSHOT_RETENTION_DAYS` Tagen gelöscht (Standard 180, `0` = unbegrenzt).

Unter **Einstellungen → Daten** lässt sich ein ZIP herunterladen und wieder importieren. Das Format `flowplan-2` enthält `flowplan.json` und unverändert gespeicherte Dateien unter `files/<id>` sowie unabhängige Vorlagenanhänge unter `template-files/<id>`. SHA-256-Prüfsummen erkennen fehlende oder beschädigte Anhänge.

Enthalten sind zugängliche Seiten einschließlich Papierkorb, Datenbankansichten und Datensätze, Rich-Text-Inhalte, interne Relationen, Seiten- und Datensatzvorlagen, Kommentare, Versionsstände, eigene Favoriten und Formularoptionen. Beim Import entstehen neue IDs und unabhängige Dokumente; interne Referenzen werden umgeschrieben. Personenfelder bleiben nur für im Zielarbeitsbereich vorhandene Mitglieder zugeordnet. Verweise auf nicht enthaltene Datensätze werden ausgelassen und gemeldet. Importierte Kommentare tragen den ursprünglichen Namen als Importvermerk.

Importierte Bereiche und Seitenvorlagen sind privat. Öffentliche Links, Formulare und alte Zugriffsrechte werden nicht aktiviert. Formulare können nach Prüfung erneut freigegeben werden. Konten, Sitzungen, OIDC-Konfiguration und administrative Auditdaten gehören zur Instanzsicherung, nicht zum Inhaltsarchiv.

Grenzen pro Archiv: 100 MB ZIP, 250 MB entpackt, 30 MB Manifest, 500 Seiten und 2.000 Dateien; je Datenbank 5.000 Einträge, je Anhang 10 MB. Ein ungültiger Import wird vollständig zurückgerollt, einschließlich bereits abgelegter Dateien. ZIP-Dateien aus Notion/AppFlowy sind noch kein unterstütztes Importformat.

Private Seitenvorlagen können beim Speichern mit **Nur für mich sichtbar** erstellt werden. Andere Mitglieder können sie weder auflisten noch anwenden. Der JSON-Import `flowplan-1` bleibt verfügbar und erhält jetzt ebenfalls interne Seitenlinks und Datensatzrelationen.

## Daten & Betrieb

- SQLite mit WAL liegt unter `FLOWPLAN_DATA_DIR` (Standard `./data`). Uploads liegen im Unterordner `uploads`.
- Dokumente und Datensatzinhalte: Yjs-CRDT, lokaler IndexedDB-Speicher pro Benutzer/Seite/Datensatz/Generation, Zusammenführung über authentifizierte HTTP-Synchronisierung etwa alle 1,8 Sekunden.
- Datenbanken: serverseitige Datensätze mit Versionsprüfung gegen verlorene parallele Änderungen. Aktuell online erforderlich.
- Dokument-Snapshots werden bei Änderungen höchstens alle fünf Minuten angelegt; manuelle Sicherungen sind zusätzlich möglich. Wiederherstellung wechselt die Dokumentgeneration, damit alte Clients die wiederhergestellte Fassung nicht überschreiben.
- Die Anwendung ist für **eine Serverinstanz mit persistentem Datenträger** ausgelegt. Für mehrere Instanzen sind gemeinsamer Speicher und eine entsprechend angepasste Persistenz nötig.
- HTTPS über einen Reverse Proxy verwenden. Den internen Node-Port nicht zusätzlich öffentlich exponieren.
- Backups: SQLite konsistent per `.backup` sichern oder die Anwendung anhalten und den gesamten Datenordner kopieren. Für die Wiederherstellung werden Datenbank **und** Uploads benötigt. Der ZIP-Export unter **Einstellungen → Daten** sichert Inhalte einschließlich Uploads; er ersetzt keine vollständige Instanzsicherung mit Konten und Berechtigungen. Der ältere JSON-Export enthält keine Binärdateien.
- Upload-Limit: 10 MB je Datei. Öffentliche Freigaben enthalten die Seite und auf Wunsch die beim Veröffentlichen ausgewählten Unterseiten. Neu angelegte Unterseiten müssen ausdrücklich ergänzt werden. Verlinkte Uploads und Datensatzdokumente der veröffentlichten Seiten sind öffentlich; ungenutzte Uploads, interne Kommentare, Personenfelder, Relationen und abgeleitete Formel-/Rollup-Felder bleiben privat. Aus dem Baum verschobene Seiten sind über den bisherigen übergeordneten Link nicht mehr zugänglich. Löschen oder Widerrufen entzieht auch den Dateizugriff. Externe Bilder/YouTube-Einbettungen können beim Anzeigen Verbindungen zum jeweiligen Anbieter aufbauen.

Docker:

```sh
docker compose --env-file .env.local up --build -d
```

Das Volume `flowplan-data` speichert Inhalte unabhängig vom Container. Die Produktionsanmeldung setzt OIDC voraus; Zugangsdaten nicht in Images oder Git speichern.

## Prüfen

```sh
npm run typecheck
npm test
npm run build
npm run test:e2e
```

Für die Browserprüfungen muss der Entwicklungsserver erreichbar sein. Standard: `http://127.0.0.1:3000`, überschreibbar mit `TEST_BASE_URL`. Die Tests erzeugen Beispielseiten im lokalen Demo-Konto. Chromium wird über Playwright benötigt (`npx playwright install chromium`). OIDC-Tests starten einen kurzlebigen lokalen Testanbieter, benötigen aber keine echten Zugangsdaten. Eine Anmeldung gegen deinen tatsächlichen Anbieter ist erst nach dessen Konfiguration prüfbar.

Bei langsamen lokalen Dateizugriffen können Browserprüfungen mit `TEST_EXPECT_TIMEOUT_MS=30000 npm run test:e2e -- --timeout=180000` ausgeführt werden. Das erhöht ausschließlich die Wartefristen; alle fachlichen Assertions bleiben aktiv. Standardmäßig warten Assertions weiterhin fünf Sekunden.

## Projektaufbau

- `app/`: Next.js App Router, Login, API, öffentliche Seiten und Formulare
- `components/`: Arbeitsoberfläche, Editor, Datenbankansichten, Einstellungen, Admin
- `lib/`: Rechteprüfung, OIDC, Datenmodell, Transaktionen, CRDT, Formeln und Importe
- `tests/`: Rechte-, Daten-, OIDC- und Browserprüfungen

Flowplan ist eine eigenständige Implementierung. AppFlowy-Marken und -Assets wurden nicht übernommen.

Textkommentare unterstützen jetzt Formatierung, Listen, Links, Zitate, Code und Personen-Erwähnungen über `@`. Die Personensuche zeigt nur aktive Mitglieder mit Seitenzugriff; beim Absenden werden die Rechte erneut geprüft. **Strg/⌘ + Enter** sendet den Beitrag. Formatierte Entwürfe, ZIP-Archive und Datenbank-Snapshots erhalten den Inhalt; importierte Erwähnungen bleiben historische Namensmarkierungen. Details: [Textkommentare](docs/INLINE-COMMENTS.md).
