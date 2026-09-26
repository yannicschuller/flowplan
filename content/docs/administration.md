# Administration der Instanz

Mitglieder der Admin-Gruppe aus `OIDC_ADMIN_GROUP` sehen **Administration** in der Seitenleiste. Dort verwalten sie Konten, Arbeitsbereiche, Betrieb, Einstellungen der Instanz und das Aktivitätsprotokoll.

## Benutzer

Alle Konten der Instanz mit ihren aktiven Sitzungen.

- **Sitzungen beenden** meldet eine Person auf allen Geräten ab.
- **Deaktivieren** sperrt ein Konto sofort und beendet alle Sitzungen; **Aktivieren** gibt es wieder frei.

Konten selbst entstehen beim ersten Anmelden über OIDC und werden dort verwaltet.

## Arbeitsbereiche

Alle Arbeitsbereiche mit Mitgliederzahl, Belegung und Speicherkontingent. Das Kontingent lässt sich je Arbeitsbereich überschreiben.

## Betrieb

Zustand der Instanz: Größe von Datenbank und Uploads, Warteschlangen, Suchindex, Versionen und Laufzeit, dazu die Speicherübersicht mit S3-Verbindung, Datenbanksicherung und Inhaltszahlen. Details unter [Betrieb und Fehlersuche](/docs/betrieb).

## Instanz

| Einstellung | Wirkung |
| --- | --- |
| Name | Erscheint in der Seitenleiste und auf der Startseite neben dem Logo. |
| Hinweis | Banner für alle, z. B. eine angekündigte Wartung. |
| Standard-Speicherkontingent | Für Arbeitsbereiche ohne eigenes Kontingent. |
| Aufbewahrung von Versionen | Tage, nach denen automatische Versionen gelöscht werden. |
| Maximale Uploadgröße | Grenze je Datei in MB. |
| Arbeitsbereiche anlegen | Ob alle Personen eigene Arbeitsbereiche erstellen dürfen. |
| Demo auf der Startseite anbieten | Siehe unten. |

Leere Felder fallen auf die [Umgebungsvariablen](/docs/konfiguration) zurück.

### Sicherung der gesamten Instanz

**Sicherung herunterladen** erzeugt im laufenden Betrieb eine geprüfte Kopie von Datenbank und Dateien. Eine hochgeladene Sicherung wird geprüft und beim nächsten Neustart übernommen; der vorherige Stand bleibt als `pre-restore-…` im Datenverzeichnis.

## Demo

Mit **Demo auf der Startseite anbieten** erscheint auf der Startseite neben Registrieren und Anmelden der Knopf **Demo ausprobieren**. Er legt ohne Konto einen Demo-Gast mit eigenem Beispiel-Arbeitsbereich an.

- Die Demo endet mit **Demo beenden**, beim Abmelden, nach 45 Minuten ohne Aktivität, spätestens nach drei Stunden. Dann werden Konto, Arbeitsbereich, Seiten und Dateien vollständig gelöscht.
- Demo-Gäste können nichts nach außen tragen: nicht veröffentlichen, keine Freigabelinks, keine Einladungen, keine weiteren Arbeitsbereiche, keine öffentlichen Formulare, keine Administration.
- Jeder Demo-Arbeitsbereich hat 25 MB Speicher. Neue Demos sind auf fünf pro Stunde und Adresse sowie 40 gleichzeitig begrenzt.

## Aktivitätsprotokoll

Die letzten Änderungen mit Person, Aktion und betroffener Ressource – etwa Freigaben, Rollenwechsel, Löschungen und Einstellungen.
