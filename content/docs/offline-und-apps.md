# Offline, Web-App und Desktop

Flowplan läuft im Browser, lässt sich als App installieren und funktioniert auch ohne Verbindung weiter.

## Ohne Verbindung arbeiten

Dokumente speichert Flowplan immer zuerst lokal im Browser (IndexedDB) und gleicht sie mit dem Server ab, sobald er erreichbar ist. Bricht die Verbindung ab, schreibst du einfach weiter; Änderungen anderer werden beim Wiederverbinden zusammengeführt.

### Offline-Nutzung einschalten

Unter **Einstellungen → Daten → Offline-Nutzung** speichert das Gerät zusätzlich die App, den Arbeitsbereich, alle lesbaren Seiten und später geöffnete Dateien. Dann lassen sich auch ohne Verbindung Seiten öffnen, Dokumente und Datenbanken lesen und Text bearbeiten.

- Online kommt immer der aktuelle Stand vom Server; die Kopie dient nur ohne Verbindung.
- Die Kopien enthalten private Inhalte. Sie werden beim Abmelden, beim Ausschalten und bei der Anmeldung einer anderen Person entfernt.

### Datenbank-Einträge offline

Änderungen an Einträgen ohne Verbindung erscheinen sofort in den Ansichten und werden auf dem Gerät gesammelt. Sobald die Verbindung zurück ist, gehen sie der Reihe nach an den Server. Hat jemand denselben Eintrag inzwischen geändert, führt Flowplan die Änderungen Feld für Feld zusammen; wurde dasselbe Feld auf beiden Seiten geändert oder der Eintrag gelöscht, entscheidest du im Konfliktdialog.

> [!NOTE]
> Das Schema einer Datenbank – Eigenschaften und Ansichten – lässt sich nur mit Verbindung ändern.

## Als App installieren

- **Chrome, Edge**: Installieren-Symbol in der Adressleiste.
- **Safari auf dem Mac**: **Ablage → Zum Dock hinzufügen**.
- **iPhone, iPad**: Teilen → **Zum Home-Bildschirm**. Nur so sind dort Push-Nachrichten möglich.
- **Android**: Menü → **App installieren**.

Die installierte App öffnet in einem eigenen Fenster ohne Browserleisten.

## Desktop-App für macOS und Windows

Eine schlanke Desktop-App umschließt deine Flowplan-Instanz. Beim ersten Start fragt sie nach der Adresse (z. B. `https://flowplan.example.com`); **Server wechseln …** im Menü ändert sie später.

- Alle Daten bleiben auf dem Server.
- Die App merkt sich Fenstergröße und -position, bietet deutsche Menüs und öffnet externe Links im Standardbrowser.
- Ohne Verbindung zeigt sie eine eigene Offline-Seite; die Offline-Nutzung der Web-App funktioniert wie im Browser.

Gebaut wird die App aus dem Ordner `desktop/` im Quellcode (`npm run dist:mac`, `npm run dist:win`). Ohne Zertifikate sind die Builds unsigniert: macOS fragt beim ersten Öffnen nach (Rechtsklick → Öffnen), Windows zeigt SmartScreen.

## Hell und dunkel

Unter **Einstellungen → Allgemein → Erscheinungsbild** wählst du hell oder dunkel. Die Startseite und diese Dokumentation folgen der Einstellung deines Systems.
