# Konfiguration

Alle Umgebungsvariablen auf einen Blick. Viele Werte lassen sich zusätzlich in der Oberfläche unter **Administration → Instanz** setzen; dort gesetzte Werte haben Vorrang.

## Pflicht

| Variable | Beispiel | Bedeutung |
| --- | --- | --- |
| `APP_URL` | `https://flowplan.example.com` | Öffentliche Adresse genau so, wie sie im Browser steht – Schema, Host, ggf. Port, ohne Schrägstrich am Ende. Grundlage für Login-Weiterleitung, Cookies, Passkeys, Links in E-Mails und Push-Nachrichten und die Origin-Prüfung. |

## Anmeldung

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `FLOWPLAN_LOCAL_LOGIN` | an | `false` schaltet E-Mail, Passwort und Passkeys ab; dann bleibt nur Single Sign-on. |
| `OIDC_ISSUER` | *leer* | Login-Anbieter für Single Sign-on. Ohne ihn gibt es nur E-Mail, Passwort und Passkeys. |
| `OIDC_CLIENT_ID` | – | Client-ID. |
| `OIDC_CLIENT_SECRET` | – | Client-Secret. Nie ins Image oder ins Git. |
| `SESSION_HOURS` | `8` | Dauer einer Sitzung in Stunden (1–24). |

Die übrigen OIDC-Variablen und alles zu Passwörtern und Passkeys stehen unter [Anmeldung](/docs/sign-in).

## Betrieb

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `FLOWPLAN_DATA_DIR` | `/app/data` im Image, sonst `./data` | Datenverzeichnis für SQLite, Uploads, Push-Schlüssel und Texterkennungsdaten. |
| `FLOWPLAN_WORKSPACE_QUOTA_MB` | unbegrenzt | Standard-Speicherkontingent je Arbeitsbereich in MB (`0` = unbegrenzt). |
| `FLOWPLAN_SNAPSHOT_RETENTION_DAYS` | `180` | Aufbewahrung automatischer Versionen in Tagen (`0` = unbegrenzt). |
| `FLOWPLAN_OCR` | an | `0` schaltet die Texterkennung für gescannte PDFs und Bilder ab. |
| `FLOWPLAN_METRICS_TOKEN` | *leer* | Mindestens 16 Zeichen; aktiviert `/api/metrics` im Prometheus-Format. |
| `FLOWPLAN_TRUSTED_PROXIES` | `1` | Anzahl der Proxys vor Flowplan (Traefik allein: `1`, Pangolin vor Traefik: `2`). Bestimmt, welcher Eintrag in `X-Forwarded-For` die echte Adresse ist – für die Begrenzung von Demo-Starts und anonymen Formularantworten. Frei erfundene Einträge des Browsers werden so ignoriert. |
| `FLOWPLAN_PUBLIC_SITE` | *leer* | Nur für die offizielle Instanz flowplan.org: `true` zeigt Besuchern die Produkt-Webseite und erlaubt die öffentliche Demo. Selbst gehostete Instanzen lassen sie leer und öffnen mit der Anmeldung. |

## S3 und Datenbanksicherung

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `S3_BUCKET` | *leer* | Schaltet S3 ein. Ohne diese Variable bleibt alles lokal. |
| `S3_ENDPOINT` | AWS | API-Adresse des Speichers, z. B. `http://minio:9000`. |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | – | Zugangsschlüssel mit Lese- und Schreibrecht auf den Bucket. |
| `S3_REGION` | `us-east-1` | Region. Garage verlangt seinen eigenen Wert (oft `garage`). |
| `S3_PREFIX` | `flowplan` | Ordner im Bucket; Dateien unter `<Präfix>/uploads/`, Datenbank unter `<Präfix>/db/`. |
| `FLOWPLAN_LITESTREAM` | an | `off`: nur Dateien spiegeln, Datenbank nicht sichern. |

Details: [Speicher, S3 und Sicherung](/docs/storage-and-backups).

## E-Mail (SMTP)

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `SMTP_HOST` | *leer* | Schaltet den E-Mail-Versand ein: Einladungen und Zusammenfassungen ungelesener Benachrichtigungen. |
| `SMTP_PORT` | `587` | Port. Bei `465` spricht Flowplan direkt TLS, sonst STARTTLS. |
| `SMTP_SECURE` | nach Port | `true`/`false` erzwingt TLS ab Verbindungsbeginn. |
| `SMTP_USER` / `SMTP_PASSWORD` | *leer* | Anmeldung am Mailserver. |
| `SMTP_FROM` | `Flowplan <SMTP_USER>` | Absender, z. B. `Flowplan <flowplan@example.com>`. |

Den Versand prüfst du unter **Administration → Instanz → Test-E-Mail senden**.

## Integrationen

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `FLOWPLAN_WEBHOOK_ALLOW_PRIVATE` | *leer* | `true` erlaubt Webhooks an interne Adressen und `http://` – etwa Home Assistant oder n8n im selben Netz. Ohne diese Variable sind nur öffentliche HTTPS-Adressen erlaubt. |

## Sprachnotizen (Whisper)

Sprachnotizen im Editor werden immer als Audio gespeichert. Mit einem Whisper-Dienst im eigenen Netz macht Flowplan daraus zusätzlich Text; die Aufnahme verlässt dabei deinen Server nicht.

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `WHISPER_URL` | *leer* | Adresse eines OpenAI-kompatiblen Whisper-Servers (`POST /v1/audio/transcriptions`), z. B. `http://whisper:8000`. Schaltet die Transkription ein. |
| `WHISPER_MODEL` | `Systran/faster-whisper-small` | Modellname, wie ihn der Dienst erwartet. |
| `WHISPER_LANGUAGE` | `de` | Sprache der Aufnahmen. |
| `WHISPER_API_KEY` | *leer* | Nur falls der Dienst einen Schlüssel verlangt. |

Beispiel mit [speaches](https://github.com/speaches-ai/speaches) (früher faster-whisper-server) im selben Compose-Projekt:

```yaml
  whisper:
    image: ghcr.io/speaches-ai/speaches:latest-cpu
    volumes:
      - whisper-models:/home/ubuntu/.cache/huggingface/hub
    restart: unless-stopped
```

Bei Flowplan dann `WHISPER_URL=http://whisper:8000` setzen. Neuere speaches-Versionen laden Modelle nicht selbst; einmalig herunterladen, etwa aus dem Flowplan-Container:

```sh
node -e "fetch('http://whisper:8000/v1/models/Systran/faster-whisper-small',{method:'POST'}).then(r=>console.log(r.status))"
```

`small` braucht rund 1 GB Arbeitsspeicher und transkribiert auf einer normalen CPU etwa in Echtzeit; `base` ist schneller und ungenauer, `medium` genauer und deutlich langsamer. Den Whisper-Dienst nicht öffentlich erreichbar machen – nur Flowplan spricht mit ihm.

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
- ob sich jede Person mit E-Mail und Passwort registrieren darf,
- tägliche Datenbanksicherung und wie viele Kopien bleiben,
- nach wie vielen Tagen ohne Anmeldung Konten gesperrt werden,
- auf flowplan.org: ob die Startseite eine **Demo** anbietet (laufende und insgesamt gestartete Demos zeigt **Administration → Betrieb**).

Leere Felder fallen auf die Umgebungsvariablen zurück.
