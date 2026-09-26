# Konfiguration

Alle Umgebungsvariablen auf einen Blick. Viele Werte lassen sich zusätzlich in der Oberfläche unter **Administration → Instanz** setzen; dort gesetzte Werte haben Vorrang.

## Pflicht

| Variable | Beispiel | Bedeutung |
| --- | --- | --- |
| `APP_URL` | `https://flowplan.example.com` | Öffentliche Adresse genau so, wie sie im Browser steht – Schema, Host, ggf. Port, ohne Schrägstrich am Ende. Grundlage für Login-Weiterleitung, Cookies, Links in Push-Nachrichten und die Origin-Prüfung. |
| `OIDC_ISSUER` | `https://id.example.com/realms/company` | Login-Anbieter. |
| `OIDC_CLIENT_ID` | `flowplan` | Client-ID. |
| `OIDC_CLIENT_SECRET` | *geheim* | Client-Secret. Nie ins Image oder ins Git. |

Die übrigen Anmelde-Variablen stehen unter [Anmeldung mit OIDC](/docs/anmeldung-oidc).

## Betrieb

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `FLOWPLAN_DATA_DIR` | `/app/data` im Image, sonst `./data` | Datenverzeichnis für SQLite, Uploads, Push-Schlüssel und Texterkennungsdaten. |
| `FLOWPLAN_WORKSPACE_QUOTA_MB` | unbegrenzt | Standard-Speicherkontingent je Arbeitsbereich in MB (`0` = unbegrenzt). |
| `FLOWPLAN_SNAPSHOT_RETENTION_DAYS` | `180` | Aufbewahrung automatischer Versionen in Tagen (`0` = unbegrenzt). |
| `FLOWPLAN_OCR` | an | `0` schaltet die Texterkennung für gescannte PDFs und Bilder ab. |
| `FLOWPLAN_METRICS_TOKEN` | *leer* | Mindestens 16 Zeichen; aktiviert `/api/metrics` im Prometheus-Format. |

## S3 und Datenbanksicherung

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `S3_BUCKET` | *leer* | Schaltet S3 ein. Ohne diese Variable bleibt alles lokal. |
| `S3_ENDPOINT` | AWS | API-Adresse des Speichers, z. B. `http://minio:9000`. |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | – | Zugangsschlüssel mit Lese- und Schreibrecht auf den Bucket. |
| `S3_REGION` | `us-east-1` | Region. Garage verlangt seinen eigenen Wert (oft `garage`). |
| `S3_PREFIX` | `flowplan` | Ordner im Bucket; Dateien unter `<Präfix>/uploads/`, Datenbank unter `<Präfix>/db/`. |
| `FLOWPLAN_LITESTREAM` | an | `off`: nur Dateien spiegeln, Datenbank nicht sichern. |

Details: [Speicher, S3 und Sicherung](/docs/speicher-und-sicherung).

## Push-Benachrichtigungen

| Variable | Bedeutung |
| --- | --- |
| `WEB_PUSH_SUBJECT` | Kontakt für die Push-Dienste, z. B. `mailto:admin@example.com`. |
| `WEB_PUSH_PUBLIC_KEY` / `WEB_PUSH_PRIVATE_KEY` | VAPID-Schlüsselpaar. Ohne Angabe erzeugt Flowplan eines unter `FLOWPLAN_DATA_DIR/web-push-keys.json`. |

Die Schlüssel dürfen sich nicht ändern, sonst verlieren alle Geräte ihr Abonnement. Ausgehendes HTTPS zu den Push-Diensten von Apple, Google und Mozilla muss möglich sein.

## Nicht setzen

`NODE_ENV`, `PORT`, `HOSTNAME` und `NEXT_TELEMETRY_DISABLED` setzt das Image selbst. `FLOWPLAN_DIST_DIR` ist nur für parallele Entwicklungsserver gedacht, `OIDC_ALLOW_LOCAL_HTTP` nur für Tests mit einem Anbieter auf `http://localhost`.

## In der Oberfläche

Unter **Administration → Instanz** stellen Admins ein:

- Instanzname und ein Hinweisbanner für alle,
- Standard-Speicherkontingent und Aufbewahrung von Versionen,
- maximale Uploadgröße,
- ob alle Personen eigene Arbeitsbereiche anlegen dürfen,
- ob die Startseite eine **Demo** anbietet.

Leere Felder fallen auf die Umgebungsvariablen zurück.
