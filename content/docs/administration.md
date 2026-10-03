# Administration der Instanz

Wer die Instanz verwaltet, sieht **Administration** in der Seitenleiste: das erste Konto der Instanz und alle, denen es das Admin-Recht gibt – bei Single Sign-on zusätzlich die Mitglieder der Gruppe aus `OIDC_ADMIN_GROUP`. Dort verwalten sie Konten, Arbeitsbereiche, Betrieb, Einstellungen der Instanz und das Aktivitätsprotokoll.

## Benutzer

Alle Konten der Instanz mit ihrer letzten Anmeldung.

- **Sitzungen beenden** meldet eine Person auf allen Geräten ab.
- **Deaktivieren** sperrt ein Konto sofort und beendet alle Sitzungen; **Aktivieren** gibt es wieder frei.

- Bei Konten mit E-Mail und Passwort: **Zum Admin machen** bzw. **Admin entziehen** (eine Person verwaltet die Instanz immer) und **Link zum Zurücksetzen** – ein zwei Stunden gültiger Link für ein neues Passwort, zum Weitergeben, wenn die Instanz keine E-Mails verschickt.

Konten mit E-Mail und Passwort entstehen über **Konto erstellen** (siehe [Anmeldung](/docs/sign-in)); SSO-Konten beim ersten Anmelden über OIDC, ihr Admin-Recht kommt aus der Gruppe beim Anbieter.

## Arbeitsbereiche

Alle Arbeitsbereiche mit Mitgliederzahl, Belegung und Speicherkontingent. Das Kontingent lässt sich je Arbeitsbereich überschreiben.

## Betrieb

Zustand der Instanz: Größe von Datenbank und Uploads, Warteschlangen, Suchindex, Versionen und Laufzeit, dazu die Speicherübersicht mit S3-Verbindung, Datenbanksicherung und Inhaltszahlen. Details unter [Betrieb und Fehlersuche](/docs/operations).

## Instanz

| Einstellung | Wirkung |
| --- | --- |
| Name | Erscheint in der Seitenleiste und auf der Startseite neben dem Logo. |
| Hinweis | Banner für alle, z. B. eine angekündigte Wartung. |
| Standard-Speicherkontingent | Für Arbeitsbereiche ohne eigenes Kontingent. |
| Aufbewahrung von Versionen | Tage, nach denen automatische Versionen gelöscht werden. |
| Maximale Uploadgröße | Grenze je Datei in MB. |
| Arbeitsbereiche anlegen | Ob alle Personen eigene Arbeitsbereiche erstellen dürfen. |
| Registrierung mit E-Mail und Passwort erlauben | Jede Person darf ein Konto anlegen. Ohne diese Einstellung nur eingeladene Adressen (und das erste Konto der Instanz). |
| Demo auf der Startseite anbieten | Nur auf flowplan.org, siehe unten. |

Leere Felder fallen auf die [Umgebungsvariablen](/docs/configuration) zurück.

### E-Mail-Versand und geplante Sicherung

- **E-Mail-Versand** zeigt den eingerichteten Server, die Warteschlange und den letzten Fehler; **Test-E-Mail senden** prüft die Verbindung sofort.
- **Tägliche Datenbanksicherung**: eine konsistente Kopie der Datenbank pro Tag, mit S3 in den Bucket unter `backups/`, sonst in den Datenordner. Die neuesten *n* bleiben erhalten; **Jetzt sichern** legt sofort eine an.
- **Konten ohne Anmeldung sperren nach (Tagen)**: gesperrte Konten verlieren ihre Sitzungen, ihre API-Tokens funktionieren nicht mehr; die Sperre steht im Aktivitätsprotokoll und lässt sich unter **Benutzer** aufheben.

### Sicherung der gesamten Instanz

**Sicherung herunterladen** erzeugt im laufenden Betrieb eine geprüfte Kopie von Datenbank und Dateien. Eine hochgeladene Sicherung wird geprüft und beim nächsten Neustart übernommen; der vorherige Stand bleibt als `pre-restore-…` im Datenverzeichnis.

## Demo

Die Demo gehört zur Produkt-Webseite und gibt es nur auf der offiziellen Instanz flowplan.org (`FLOWPLAN_PUBLIC_SITE=true`); selbst gehostete Instanzen zeigen die Einstellung nicht.

Mit **Demo auf der Startseite anbieten** erscheint auf der Startseite neben Registrieren und Anmelden der Knopf **Demo ausprobieren**. Er legt ohne Konto einen Demo-Gast mit eigenem Beispiel-Arbeitsbereich an. Jede Demo bekommt frische Beispielseiten, die alle Funktionen zeigen: eine Willkommensseite, einen Editor-Rundgang mit allen Blöcken, eine Projektdatenbank mit Beziehung, Rollup, Formel, Wiederholung und allen Ansichten (Tabelle, Board, Kalender, Zeitleiste, Galerie, Liste, Feed, Diagramm, Formular), ein Whiteboard, ein Journal und ein kleines Wiki.

- Die Demo endet mit **Demo beenden**, beim Abmelden, nach 45 Minuten ohne Aktivität, spätestens nach drei Stunden. Dann werden Konto, Arbeitsbereich, Seiten und Dateien vollständig gelöscht.
- Demo-Gäste können nichts nach außen tragen: nicht veröffentlichen, keine Freigabelinks, keine Einladungen, keine weiteren Arbeitsbereiche, keine öffentlichen Formulare, keine Administration.
- Jeder Demo-Arbeitsbereich hat 25 MB Speicher. Neue Demos sind auf fünf pro Stunde und Adresse sowie 40 gleichzeitig begrenzt.

## Aktivitätsprotokoll

Die letzten Änderungen mit Person, Aktion und betroffener Ressource – etwa Freigaben, Rollenwechsel, Löschungen und Einstellungen. **Als CSV exportieren** lädt das vollständige Protokoll für Tabellenprogramme herunter.
