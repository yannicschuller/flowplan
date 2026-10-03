# Betrieb und Fehlersuche

Healthcheck, Kennzahlen, Speicherübersicht und die häufigsten Ursachen, wenn etwas nicht läuft.

## Healthcheck

`GET /api/health` antwortet ohne Anmeldung mit `200` oder bei Problemen mit `503`. Er meldet nur Zustände, keine Inhalte:

- Datenbank erreichbar und beschreibbar,
- Upload-Verzeichnis beschreibbar,
- Rückstand des Suchindex,
- fehlgeschlagene Push-Zustellungen,
- mit S3: `objectStorage.pending` (noch hochzuladende Dateien) und `retrying`.

## Administration → Betrieb

Admins sehen dort Größe von Datenbank und Uploads, Warteschlangen, Suchindex, Versionen und Laufzeit. Die **Speicherübersicht** zeigt:

- ob der S3-Speicher erreichbar ist, wie lange die Prüfung dauerte und wie viele Dateien noch warten,
- was lokal und was im Bucket liegt: Dateien nach Art (Bilder, Videos, Dokumente …) und die Aufteilung der Datenbank,
- wie viele Arbeitsbereiche, Seiten, Datenbanken, Einträge, Whiteboards, Dateien, Konten und Kommentare es gibt.

## Prometheus

Mit `FLOWPLAN_METRICS_TOKEN` (mindestens 16 Zeichen) liefert `/api/metrics` Kennzahlen: Größen, Warteschlangen, Suchrückstand, Speicher und Kontingent je Arbeitsbereich, `flowplan_object_storage_pending`.

```yaml
scrape_configs:
  - job_name: flowplan
    metrics_path: /api/metrics
    authorization:
      credentials: <FLOWPLAN_METRICS_TOKEN>
    static_configs:
      - targets: ["flowplan:3000"]
```

Ohne gesetztes Token ist der Endpunkt abgeschaltet.

## Nach dem ersten Start prüfen

- `/api/health` liefert `200`.
- Die Anmeldung funktioniert und landet wieder in Flowplan.
- Das erste Konto (bei SSO: ein Mitglied der Admin-Gruppe) sieht **Administration**.
- Eine Datei hochladen, den Container neu starten, die Datei wieder öffnen – dann ist das Volume richtig eingebunden.
- Mit S3: `objectStorage.pending` sinkt auf `0`; im Bucket liegen `flowplan/uploads/` und `flowplan/db/`; das Log zeigt beim Start Zeilen von `litestream`.

## Fehlersuche

| Symptom | Ursache und Lösung |
| --- | --- |
| Login endet mit Fehler zur Redirect-URI | URI beim Anbieter ≠ `APP_URL` + `/api/auth/callback`. |
| „Ungültiger Anfrageursprung“ beim Speichern | `APP_URL` weicht von der aufgerufenen Adresse ab. |
| Keine Administration sichtbar | Bei SSO fehlt die Gruppe im Token: `OIDC_SCOPES`, `OIDC_GROUPS_CLAIM`, `OIDC_ADMIN_GROUP` prüfen und neu anmelden. Bei E-Mail-Konten gibt ein Admin das Recht unter **Benutzer**. |
| Nach Neustart ist alles leer | Volume ist nicht auf `/app/data` eingehängt. |
| `SQLITE_READONLY` oder `EACCES` im Log | Host-Ordner gehört nicht UID 1000. |
| Container „degraded“ in Coolify | Healthcheck-Port leer (= 80); `3000` eintragen. |
| 404 über den vorderen Proxy | Keine Route beim inneren Proxy: Host-Header setzen, TLS zum Ziel ausschalten, Container muss gesund sein. |
| `objectStorage.retrying: true` | Bucket nicht erreichbar oder Schlüssel falsch. Uploads werden mit wachsendem Abstand wiederholt, lokal geht nichts verloren. Endpoint vom Container aus prüfen (Tippfehler, Dienst nur an interne IP gebunden). |
| Container startet nicht, Log zeigt `litestream` | Endpoint, Bucket oder Schlüssel für die Datenbanksicherung falsch; zum Eingrenzen `FLOWPLAN_LITESTREAM=off`. |
| Push kommt nicht an | `WEB_PUSH_SUBJECT` fehlt, Schlüssel haben sich geändert oder ausgehendes HTTPS ist gesperrt. |
| Hohe CPU-Last nach Uploads | Texterkennung gescannter PDFs; bei Bedarf `FLOWPLAN_OCR=0`. |
| Änderungen anderer oder Live-Cursor kommen nur verzögert an | Proxy puffert Server-Sent Events (`/api/documents/live`, `/api/whiteboards/…/cursors`); Pufferung abschalten. Ohne den Kanal gleicht Flowplan weiter im Abstand von Sekunden ab. |

## Desktop-App bauen

Die Desktop-App für macOS und Windows entsteht aus dem Ordner `desktop/` im Quellcode: `npm run dist:mac` bzw. `npm run dist:win`. Ohne Zertifikate sind die Builds unsigniert – macOS fragt beim ersten Öffnen nach (Rechtsklick → Öffnen), Windows zeigt SmartScreen. Die Dateien gibst du an die Mitglieder weiter.

