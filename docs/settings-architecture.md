# Settings and administration – architecture

Status: phase 1 (foundation) implemented. The settings (`#settings`) and the
administration (`#admin`) are a landing page of grouped tiles and one page
per section ("tiles → detail pages"). Every existing panel is wired in
unchanged; restyling the panels onto the building blocks below is phase 2.

Code: `lib/settings-sections.ts` (registry data, addresses, old links,
search), `components/settings/registry.tsx` (icons and components),
`components/settings/shell.tsx` (landing page, detail page, routing),
`components/settings-ui.tsx` (building blocks), `components/settings/user/*`
and `components/settings/admin/*` (one file per section),
`components/settings/user-context.tsx` / `admin-context.tsx` (shared data),
`lib/admin-summary.ts` + `app/api/admin/summary/route.ts` (tile facts),
`app/globals.css` ("Settings shell" block). Tests:
`tests/settings-sections.test.ts`, `tests/admin-summary.test.ts`, the browser
specs that open settings (they use the addresses below), `npm run quality`
(axe, overflow and JS budget of `#settings`, `#settings/account`, `#admin`).

## Addresses

| Address | Shows |
|---|---|
| `#settings` | landing page of the settings |
| `#settings/<section>` | one section, e.g. `#settings/account` |
| `#settings/<section>/<anchor>` | the section, scrolled to the element with id `<anchor>` |
| `#admin`, `#admin/<section>[/<anchor>]` | the same for the administration (admins only) |

- The hash is the state: reload, back, forward and links work. A tile is a
  real `<a href>`; opening a section pushes a history entry.
- The back button of a detail page (phones) goes back in the history when the
  section was opened from a tile, otherwise to the landing page.
- **Section ids are permanent** once released – links in docs, e-mails and
  bookmarks use them. Rename the title, never the id.
- Old tab ids are redirected in place (`LEGACY_SECTIONS`): `#settings/integrations`
  → `#settings/api`, `#admin/operations` → `#admin/monitoring`,
  `#admin/instance` → `#admin/general`. A removed or renamed section keeps an
  entry there.
- `components/workspace-app.tsx` only decides the screen (`settings`/`admin`)
  via `parseSettingsHash`; everything after the first `/` belongs to the shell.

## The registry

`lib/settings-sections.ts` is plain data (no React), used by routing, tests
and search:

```ts
{
  id: "account",               // the address, permanent
  area: "settings",            // or "admin"
  group: "personal",           // a SETTINGS_GROUPS id of the same area
  icon: "UserCircle",          // Phosphor name, mapped in registry.tsx ICONS
  title: { de, en },           // tile and page title
  description: { de, en },     // one line, shown under the title
  keywords: { de, en },        // extra search words (settings inside)
  entries: [{ title, keywords?, anchor? }], // optional search targets
}
```

Texts are `{ de, en }` objects: `npm run i18n` picks them up, French comes
from `locales/fr.json` (keep it at 100 %). The search matches every word in
the reader's language plus German and English, accents ignored.

`components/settings/registry.tsx` maps each id to its component
(`USER_COMPONENTS`, `ADMIN_COMPONENTS`) and the icon names to Phosphor icons.
A section without a component is not shown (useful while building one); the
test `every section is wired to a component` fails until it has one.

### Current sections

Settings (`#settings/…`):

| Group | Sections |
|---|---|
| Persönlich | `account` Konto & Sicherheit · `appearance` Darstellung & Sprache · `notifications` Benachrichtigungen · `ai` KI · `devices` Offline & Geräte |
| Verbindungen | `api` API & Webhooks · `connections` Kalender & Issues · `clipper` Web-Clipper |
| Arbeitsbereich „…“ | `workspace` Allgemein · `members` Mitglieder · `groups` Gruppen & Rechte · `spaces` Bereiche · `extensions` Block-Erweiterungen · `data` Import & Export · `time` Zeiten |

Administration (`#admin/…`):

| Group | Sections |
|---|---|
| Personen | `users` Benutzer · `signin` Anmeldung & SSO · `workspaces` Arbeitsbereiche |
| Daten | `storage` Speicher & Sicherung · `limits` Grenzen & Aufbewahrung · `export` Markdown- & Git-Export |
| Dienste | `mail` E-Mail · `ai` KI · `extensions` Erweiterungen & Domains |
| Sicherheit | `security` Verschlüsselung · `audit` Aktivitätsprotokoll |
| Betrieb | `monitoring` Überwachung · `maintenance` Wartung & Hinweise · `general` Instanz |

Every instance setting has one home: registration, two-factor and inactive
accounts in `signin`, quotas, uploads and versions in `limits`, backups in
`storage`, the notice in `maintenance`, plugins and domains in `extensions`,
name and demo in `general`. Administration sections start with
`<AdminStatus>` (components/settings/admin/parts.tsx: badges, one sentence,
a link to the fix) and save single instance settings with `InstanceSwitch`,
`InstanceSelect`, `InstanceNumber` and `InstanceText` (saved on change, the
state next to the control).

Planned: `settings/webhooks` (Webhooks out of `api`). `admin/overview` stays the landing page itself – the
live charts go above the tiles (`status` slot of the shell).

## Adding or moving a section

1. Add the metadata to `SETTINGS_SECTIONS` (group, icon, `{de,en}` texts,
   keywords). Choose a short English id.
2. Create `components/settings/<user|admin>/<id>.tsx` with a default export
   that takes no props. Read shared data from the context:
   - settings: `useUserSettings()` → `boot`, `mutate`, `onError`,
     `onRefresh`, `theme`/`setTheme`, `owner`, `workspace` (/api/settings,
     owners only), `reload`, `act(command)`.
   - administration: `useAdminData()` (fetches /api/admin when the section
     opens, showing the previous answer meanwhile) →
     `data` (null while loading: render `<AdminLoading />`), `load`,
     `act(command)`, `mutate`, `onError`. Panels that load their own data use
     `useAdmin()` instead and do not trigger /api/admin.
3. Register it in `USER_COMPONENTS` / `ADMIN_COMPONENTS` (and the icon in
   `ICONS` if new).
4. If it has something to say on its tile: settings – `user/tiles.ts` (from
   the bootstrap); administration – add the facts to `lib/admin-summary.ts`
   (numbers and states only, no texts; extend `tests/admin-summary.test.ts`)
   and word them in `admin/tiles.ts`.
5. If it replaces an old location, add the old id to `LEGACY_SECTIONS` and
   update texts that point there ("Einstellungen → …", e-mails, OpenAPI –
   `npm run sdk` afterwards) and the docs.
6. `npm run i18n` (French 100 %), `npx tsc --noEmit`, `npm test`, the
   browser specs that open the section (`page.goto("/#settings/<id>")`).

## Migrating a panel (phase 2)

A panel today is often a `<section className="settings-section">` with its
own headings, forms and CSS. Migrate it onto `components/settings-ui.tsx`:

- **Card** – `<SettingGroup title description id actions>`: a titled group
  of rows. One card per topic; no cards inside cards. `id` makes it an anchor
  (`#settings/account/passkeys`) – add the anchor to `entries` for search.
- **Row** – `<SettingRow label description id>`: label and one-line
  explanation left, control right; stacks on phones. Pass `id` = the
  control's id so the label belongs to it. `wide` puts lists and text areas
  under the text.
- **Controls** – `<Switch>`/`<SwitchRow>` for on/off, `<Select>` (existing),
  `<NumberField unit>`, text inputs. Width: `className={CONTROL.sm|md|lg}`
  (120 / 220 / 320 px, full width on phones). Every control has a visible
  label (the row label) – never a placeholder as the only label.
- **Saving** – settings that save on change: `const [status, run] =
  useSaveState()` and `<SaveState status={status} />` next to the control
  ("Speichert …" / "Gespeichert" / the error). Forms with several fields keep
  `<SaveBar>`. No toasts for "saved".
- **Status** – `<StatusBadge tone="ok|warn|error|off|info">Text</StatusBadge>`:
  dot and word, never colour alone.
- **Empty** – `<EmptyState icon title action>` instead of a grey "Noch
  keine …" line; the creation form comes after it or behind a button.
- **Danger** – `<DangerZone>` at the end of the section for what cannot be
  undone (delete, leave, restore); buttons with `className="button danger"`.
- **Tables** – `<ResponsiveTable columns rows rowKey label>`: a table on wide
  screens, a list of label/value pairs on phones (`primary` column = title,
  `hideOnPhone` for secondary columns).
- Remove the panel's own layout CSS once it uses the blocks; leave shared
  classes alone. `tests/stylesheet.test.ts` only checks the braces.
- Keep API calls, command names and test-visible labels unless the spec is
  updated in the same change.

## Mobile rules (≤ 860 px)

- The landing page is a full-width inset list (one tile per row, ≥ 60 px);
  the detail page has a sticky bar with "← Einstellungen"/"← Administration"
  (≥ 44 px) instead of the breadcrumb; the sibling rail is hidden (≤ 1100 px).
- No horizontal scrolling at 360 and 390 px in German, English and French.
  Tables scroll inside `.data-table-scroll` or become lists; long labels wrap
  (buttons in panels may wrap on phones).
- Touch targets ≥ 44 px: tiles, back, search, buttons, inputs and selects in
  panels (the shell enforces min-heights; don't undo them).
- Dialogs: use `Modal` from `components/ui.tsx`; it fits the screen. No fixed
  widths above 320 px inside panels.
- Check with screenshots at 390 px light and dark, and the overflow check of
  `npm run quality` (it covers `#settings`, `#settings/account`, `#admin` at
  1280 and 390 px).

## Naming

- Section ids: short English, lower case, hyphenated if needed (`signin`,
  `monitoring`). Component files are named like the id.
- Titles: German noun phrases with "&" for pairs ("Konto & Sicherheit"),
  English the same ("Account & security"), French in the catalogue ("Compte
  et sécurité"). Descriptions: one sentence, no "Hier kannst du …".
- References in texts: "Einstellungen → <Section>" / "Administration →
  <Section>", with the section title as on the tile – no third level.
- CSS: `settings-*` for the shell, `setting-*` for building blocks, panel
  classes stay with their panel.
