# Anmeldung: Passwort, Passkeys und OIDC

Flowplan meldet Personen mit E-Mail und Passwort an, auf Wunsch mit Passkeys. Zusätzlich – oder stattdessen – geht die Anmeldung über einen OpenID-Connect-Anbieter (Single Sign-on), dessen Gruppen bestimmen, wer die Instanz verwaltet.

## E-Mail und Passwort

Ohne weitere Einrichtung zeigt die Anmeldeseite ein Formular für E-Mail und Passwort.

- **Das erste Konto** einer neuen Instanz verwaltet sie: Die Anmeldeseite bietet dann direkt **Konto erstellen** an. Dieses Konto sieht die **Administration**.
- **Weitere Konten** entstehen, wenn die Administration unter **Instanz → Registrierung mit E-Mail und Passwort erlauben** die Registrierung öffnet – oder für Adressen mit einer [Einladung](/docs/workspaces-and-permissions). Eingeladene Arbeitsbereiche erscheinen, sobald die Adresse per E-Mail-Link bestätigt ist.
- **Passwörter** haben mindestens 10 Zeichen und werden mit scrypt gespeichert. Nach 8 Fehlversuchen für eine Adresse (oder 30 von einer IP-Adresse) ist für 15 Minuten Pause.
- **Passwort vergessen**: Mit eingerichtetem [E-Mail-Versand](/docs/configuration#e-mail-smtp) schickt die Anmeldeseite einen Link, der zwei Stunden gilt. Ohne E-Mail erzeugt die Administration unter **Benutzer → Link zum Zurücksetzen** einen Link zum Weitergeben. Nach dem Zurücksetzen sind alle bisherigen Sitzungen beendet.
- **Admin-Recht**: Unter **Benutzer** gibt die Administration es weiter (**Zum Admin machen**) oder entzieht es; eine Person muss die Instanz immer verwalten.
- Name und Passwort ändert jede Person unter **Einstellungen → Allgemein → Dein Profil**.

`FLOWPLAN_LOCAL_LOGIN=false` schaltet E-Mail, Passwort und Passkeys ab – dann gibt es nur Single Sign-on.

## Passkeys

Mit einem Passkey meldest du dich per Fingerabdruck, Gesichtserkennung oder Geräte-PIN an, ohne Passwort. Angelegt werden Passkeys unter **Einstellungen → Allgemein → Dein Profil → Passkey hinzufügen**; danach genügt auf der Anmeldeseite **Mit Passkey anmelden**.

- Passkeys gibt es für Konten mit E-Mail und Passwort. SSO-Konten melden sich beim Anbieter an, der seinerseits Passkeys anbieten kann.
- Passkeys gehören zur Domain aus `APP_URL`. Sie brauchen HTTPS (oder `http://localhost` beim Entwickeln); eine reine IP-Adresse funktioniert nicht. Wer die Domain wechselt, legt die Passkeys neu an.
- Ein Passkey lässt sich in den Einstellungen jederzeit wieder entfernen.

## Single Sign-on mit OIDC

Optional. Mit gesetztem `OIDC_ISSUER` zeigt die Anmeldeseite **Mit SSO anmelden**; neue Personen entstehen beim ersten Anmelden. E-Mail-Konten und SSO-Konten können nebeneinander bestehen.

### Client beim Anbieter anlegen

Einen **vertraulichen Web-Client** registrieren:

| Einstellung | Wert |
| --- | --- |
| Redirect-URI | `https://flowplan.example.com/api/auth/callback` |
| Flow | Authorization Code mit PKCE (S256) |
| Scopes | `openid profile email` und der Scope für Gruppen (oft `groups`) |
| Gruppen | müssen im signierten ID-Token oder in der UserInfo-Antwort stehen |

Die Redirect-URI ist immer `APP_URL` plus `/api/auth/callback`.

### Variablen

```dotenv
APP_URL=https://flowplan.example.com
OIDC_ISSUER=https://id.example.com/realms/company
OIDC_CLIENT_ID=flowplan
OIDC_CLIENT_SECRET=geheim
OIDC_SCOPES=openid profile email groups
OIDC_GROUPS_CLAIM=groups
OIDC_ADMIN_GROUP=flowplan-admins
SESSION_HOURS=8
```

| Variable | Bedeutung |
| --- | --- |
| `OIDC_ISSUER` | Issuer-URL; Flowplan liest daraus die Discovery (`/.well-known/openid-configuration`). |
| `OIDC_GROUPS_CLAIM` | Claim mit den Gruppen, auch als Pfad wie `realm_access.roles`. |
| `OIDC_ADMIN_GROUP` | Mitglieder dieser Gruppe sehen die **Administration**. Der Name wird exakt verglichen. |
| `OIDC_ALLOWED_GROUP` | Wenn gesetzt, dürfen sich nur Mitglieder dieser Gruppe anmelden. |
| `OIDC_PROMPT_CREATE` | `true`: **Registrieren** öffnet direkt die Registrierung des Anbieters (`prompt=create`). |
| `OIDC_PICTURE` | Profilbild aus dem Claim `picture` übernehmen (Standard an, `off` schaltet ab). Das Bild muss unter einer öffentlichen HTTPS-Adresse liegen; interne Adressen werden – auch über Weiterleitungen – nicht abgerufen. |
| `SESSION_HOURS` | Gültigkeit einer Sitzung in Stunden. Gruppenänderungen wirken spätestens danach. |

### Gruppennamen bei verbreiteten Anbietern

- **Keycloak**: Mapper „Group Membership“ zum Client hinzufügen, Token Claim Name `groups`, „Full group path“ ausschalten – sonst heißt die Gruppe `/flowplan-admins`. Für Realm-Rollen stattdessen `OIDC_GROUPS_CLAIM=realm_access.roles`.
- **Authentik**: Der Scope `profile` liefert `groups` bereits mit den Gruppennamen.
- **Zitadel**: Rollen stehen unter `urn:zitadel:iam:org:project:roles`; einen eigenen Claim per Action anlegen oder den Pfad eintragen.
- **Entra ID**: Gruppen-Claim im Token konfigurieren. Entra liefert standardmäßig Objekt-IDs; dann die ID der Admin-Gruppe als `OIDC_ADMIN_GROUP` eintragen.

## Sicherheit

Bei OIDC prüft Flowplan Discovery, Issuer, Audience, Signatur, PKCE, State und Nonce. Sitzungen sind zufällige Tokens, gehasht in SQLite gespeichert; Cookies sind `HttpOnly`, `SameSite=Lax` und bei HTTPS `Secure`. Gruppen oder Rollen werden nie aus Browserdaten übernommen.

- Ein in der Administration **deaktiviertes Konto** verliert sofort alle Sitzungen; offene Live-Verbindungen werden spätestens nach 15 Sekunden geschlossen, ebenso wenn Leserechte entzogen werden.
- Jede Seite trägt eine **Content-Security-Policy**: Skripte laufen nur mit einer pro Anfrage neuen Nonce, Frames nur von den unterstützten Playern (YouTube, Vimeo, Loom, Spotify, Figma, CodePen). HSTS setzt der Reverse Proxy (bei Traefik/Coolify in der Regel aktiv).
- Sitzungen lassen sich in der Administration gezielt widerrufen.
- Einladungen an eine E-Mail-Adresse werden erst nach einer Anmeldung mit `email_verified=true` zugeordnet.

## Häufige Fehler

| Symptom | Ursache |
| --- | --- |
| Fehler zur Redirect-URI | Beim Anbieter eingetragene URI passt nicht exakt zu `APP_URL` + `/api/auth/callback`. |
| Keine Administration sichtbar | Gruppe fehlt im Token: Scope, `OIDC_GROUPS_CLAIM` und exakten Gruppennamen prüfen, danach neu anmelden. |
| „Ungültiger Anfrageursprung“ | `APP_URL` weicht von der aufgerufenen Adresse ab (z. B. `http` statt `https`). |
| Anmeldung abgelehnt | `OIDC_ALLOWED_GROUP` gesetzt und die Person ist nicht Mitglied. |
| „Konto erstellen“ fehlt | Die Registrierung ist geschlossen: in der Administration öffnen oder die Person einladen. |
| Passkey lässt sich nicht anlegen | `APP_URL` ist keine HTTPS-Domain (IP-Adresse oder `http://` außer `localhost`). |
