# Sign-in: password, passkeys and OIDC

Flowplan signs people in with e-mail and password, optionally with passkeys. In addition – or instead – sign-in can go through an OpenID Connect provider (single sign-on), whose groups decide who administers the instance.

## E-mail and password

Without further setup, the sign-in page shows a form for e-mail and password.

- **The first account** of a new instance administers it: the sign-in page then offers **Create account** right away. This account sees the **Administration**.
- **Further accounts** are created when the administrators open sign-ups under **Instance → Allow sign-ups with e-mail and password** – or for addresses with an [invitation](/docs/workspaces-and-permissions). Workspaces someone was invited to appear as soon as the address is confirmed via the e-mail link.
- **Passwords** have at least 10 characters and are stored with scrypt. After 8 failed attempts for an address (or 30 from one IP address) there is a 15-minute pause.
- **Forgot password**: with [e-mail delivery](/docs/configuration#e-mail-smtp) set up, the sign-in page sends a link that is valid for two hours. Without e-mail, the administrators create a link to hand over under **Users → Reset link**. After a reset all previous sessions are ended.
- **Admin right**: under **Users**, the administrators pass it on (**Make admin**) or take it away; someone always has to administer the instance.
- Everyone changes their name and password under **Settings → General → Your profile**.

`FLOWPLAN_LOCAL_LOGIN=false` turns off e-mail, password and passkeys – then only single sign-on remains.

## Passkeys

With a passkey you sign in with your fingerprint, face recognition or device PIN, without a password. Passkeys are created under **Settings → General → Your profile → Add a passkey**; afterwards **Sign in with a passkey** on the sign-in page is all it takes.

- Passkeys exist for accounts with e-mail and password. SSO accounts sign in with their provider, which may offer passkeys itself.
- Passkeys belong to the domain in `APP_URL`. They need HTTPS (or `http://localhost` during development); a bare IP address does not work. Whoever changes the domain creates the passkeys anew.
- A passkey can be removed in the settings at any time.

## Single sign-on with OIDC

Optional. With `OIDC_ISSUER` set, the sign-in page shows **Sign in with SSO**; new people are created on their first sign-in. E-mail accounts and SSO accounts can exist side by side.

### Create a client at the provider

Register a **confidential web client**:

| Setting | Value |
| --- | --- |
| Redirect URI | `https://flowplan.example.com/api/auth/callback` |
| Flow | Authorization code with PKCE (S256) |
| Scopes | `openid profile email` and the scope for groups (often `groups`) |
| Groups | must be in the signed ID token or in the UserInfo answer |

The redirect URI is always `APP_URL` plus `/api/auth/callback`.

### Variables

```dotenv
APP_URL=https://flowplan.example.com
OIDC_ISSUER=https://id.example.com/realms/company
OIDC_CLIENT_ID=flowplan
OIDC_CLIENT_SECRET=secret
OIDC_SCOPES=openid profile email groups
OIDC_GROUPS_CLAIM=groups
OIDC_ADMIN_GROUP=flowplan-admins
SESSION_HOURS=8
```

| Variable | Meaning |
| --- | --- |
| `OIDC_ISSUER` | The issuer URL; Flowplan reads the discovery from it (`/.well-known/openid-configuration`). |
| `OIDC_GROUPS_CLAIM` | The claim with the groups, also as a path such as `realm_access.roles`. |
| `OIDC_ADMIN_GROUP` | Members of this group see the **Administration**. The name is compared exactly. |
| `OIDC_ALLOWED_GROUP` | If set, only members of this group may sign in. |
| `OIDC_PROMPT_CREATE` | `true`: **Sign up** opens the provider's registration directly (`prompt=create`). |
| `OIDC_PICTURE` | Take the profile picture from the `picture` claim (on by default, `off` turns it off). The image must be at a public HTTPS address; internal addresses are not fetched – not even via redirects. |
| `SESSION_HOURS` | How long a session is valid in hours. Group changes take effect after that at the latest. |

### Group names with common providers

- **Keycloak**: add the "Group Membership" mapper to the client, token claim name `groups`, turn off "Full group path" – otherwise the group is called `/flowplan-admins`. For realm roles use `OIDC_GROUPS_CLAIM=realm_access.roles` instead.
- **Authentik**: the `profile` scope already delivers `groups` with the group names.
- **Zitadel**: roles are under `urn:zitadel:iam:org:project:roles`; create a claim of your own with an action or enter the path.
- **Entra ID**: configure the groups claim in the token. Entra delivers object IDs by default; then enter the admin group's ID as `OIDC_ADMIN_GROUP`.

## Security

With OIDC, Flowplan checks the discovery, issuer, audience, signature, PKCE, state and nonce. Sessions are random tokens, stored hashed in SQLite; cookies are `HttpOnly`, `SameSite=Lax` and `Secure` with HTTPS. Groups or roles are never taken from browser data.

- An account **deactivated** in the administration loses all sessions immediately; open live connections are closed within 15 seconds at the latest, as they are when read access is withdrawn.
- Every page carries a **content security policy**: scripts only run with a nonce that is new for every request, frames only come from the supported players (YouTube, Vimeo, Loom, Spotify, Figma, CodePen). The reverse proxy sets HSTS (usually active with Traefik/Coolify).
- Sessions can be revoked individually in the administration.
- Invitations to an e-mail address are only assigned after a sign-in with a confirmed address (`email_verified=true` with OIDC, the confirmation link for e-mail accounts).

## Common errors

| Symptom | Cause |
| --- | --- |
| An error about the redirect URI | The URI entered at the provider does not exactly match `APP_URL` + `/api/auth/callback`. |
| No administration visible | The group is missing in the token: check the scope, `OIDC_GROUPS_CLAIM` and the exact group name, then sign in again. |
| "Invalid request origin" | `APP_URL` differs from the address in use (e.g. `http` instead of `https`). |
| Sign-in refused | `OIDC_ALLOWED_GROUP` is set and the person is not a member. |
| "Create account" is missing | Sign-ups are closed: open them in the administration or invite the person. |
| A passkey cannot be created | `APP_URL` is not an HTTPS domain (an IP address or `http://` other than `localhost`). |
