# Flowplan – product context

Lasting context for design and product decisions. Backed by the README, the
documentation and the code; open points are marked as open.

## What Flowplan is

An open-source workspace for documents, knowledge, projects and thinking
together: documents, databases (table, board, calendar, timeline, gallery,
list, feed, chart, form), whiteboards and journals in one page tree. A
**journal** creates a page for every day (diary and tasks): open tasks move
on to the new day, days without an entry of their own disappear again.
Functionally it covers what AppFlowy and Notion offer for teams, plus
Miro-style whiteboards. **Deliberately without AI features.**

Pages can be **dashboards**: metric cards that count or add up records from
any database (optionally through a view's filters), next to linked chart
views. Forms can run a **customer portal**: senders get a private link to
their request with its status and a conversation with the team, who reply
from the record.

For teams that work with tickets there are optional project tools, each
switched on per database and invisible until then:
- ticket numbers (WEB-123, linked in text);
- subtasks and epics with rolled-up progress;
- workflows with allowed status changes and required fields;
- automations (when …, only if …, then …);
- WIP limits on boards;
- sprints with burndown and velocity;
- time tracking;
- a Git connection for GitHub, GitLab and Gitea;
- a Jira and Trello import;
- "My tasks" across all databases with saved views.

Calendar views also sync both ways over CalDAV, and the version history
restores single paragraphs.

Documents also calculate when asked: results after "=", reducing fractions,
expanding and factoring terms, solving equations, function graphs that are
edited live – and photos can be marked up with pen, arrows, shapes and
text.

## How it is offered

- **Open source under AGPL-3.0**: [github.com/yannicschuller/flowplan](https://github.com/yannicschuller/flowplan).
- **Hosted** at [app.flowplan.org](https://app.flowplan.org) on servers in
  Germany, or **self-hosted**: one container per organisation (Next.js,
  SQLite, optional S3 backup), image `ghcr.io/yannicschuller/flowplan`
  (`latest` for releases, `beta` for the newest state).
- Three repositories, three sites: the app (this repository,
  app.flowplan.org), the website ([flowplan-website](https://github.com/yannicschuller/flowplan-website),
  flowplan.org) and the documentation ([flowplan-docs](https://github.com/yannicschuller/flowplan-docs),
  docs.flowplan.org). The app contains nothing of the website.
- Sign-in with e-mail and password, passkeys or single sign-on (OIDC,
  optional). The first account administers the instance; sign-up is open or
  invitation-only (administration). A public demo can be switched on in the
  administration (off by default).
- Releases at the push of a button (GitHub Actions); release notes and
  `CHANGELOG.md` come from the commit messages, so these are written as
  clear English sentences.

## For whom

- **Teams and organisations** that want their content in their own hands –
  self-hosted, or hosted in Germany – and sign in with a password, a passkey
  or their existing identity provider.
- **Guests** with share links (read, comment, edit live) and anonymous
  visitors of published pages and forms.
- **Administrators** of an instance, who manage accounts, sign-up,
  workspaces, storage and backups.
- **People who self-host** and want one container they understand, with
  documentation for installation, configuration and operations.

Everything shipped with the app (fonts, icons, images, dependencies) must be
under licences that allow redistribution and commercial use.

## Surfaces and modes

| Surface | Mode | Success means |
| --- | --- | --- |
| Workspace: sidebar, home, search, inbox, my tasks | Operate | find things fast and carry on |
| Document editor, record pages | Operate | write and structure without distraction |
| Calculating, function graphs, image markup | Operate | get a result or a picture without leaving the text |
| Database views | Operate | capture, sort and plan data |
| Whiteboard | Operate | think together, run workshops, present |
| Journal and day pages | Operate | capture the day, lose nothing that is open |
| Settings, administration | Operate | find a setting and change it safely |
| Published pages, template gallery for visitors | Read | understand the content, copy it if wanted |
| Forms and the customer portal (request pages) | Operate | send a request, see where it stands, reply |
| Sign-in, sign-up, password reset, demo start | Operate | get in without detours |
| Desktop app (setup, offline page) | Operate | connect to the server, find the connection again |

The marketing surface (the one-page website) and the documentation live in
their own repositories; claims there must be backed by the app's code – no
sales phrases.

## Platforms

- Web, responsive: desktop and phone (from about 375 px), iOS as a web app
  with push.
- Desktop apps for macOS and Windows (Electron shell around an instance).
- Light and dark, offline use as an opt-in, reduced motion is respected.

## Language and tone

- The interface is complete in **German and English**: the browser's
  language decides, a switch changes it. German addresses people as **du**.
- Content the server creates (first workspace, templates, demo, e-mails,
  notifications) follows the language of the person it is for.
- Calm, concrete, action-oriented: buttons name the action ("Save
  permissions", "Mark as done"), errors say what happened and what to do.
- No sales language inside the app; short taglines only at entrances
  (sign-in, home greeting).

## Brand

Flowplan has a brand world of its own instead of the borrowed
AppFlowy/Notion look; functionally AppFlowy and Notion are references,
visually they are not. The brand has to

- hold up in a dense working interface (Operate): expression lives in
  precise details, colour, type and motion – not in decoration that gets in
  the way;
- work equally well in light and dark;
- need no external services (self-hosted, works offline);
- stand as an open-source project and as a hosted product.

Fonts ship with the app (no Google Fonts), under the SIL Open Font
License: Instrument Sans (interface), Instrument Serif (brand moments only),
JetBrains Mono (code). The name stays "Flowplan"; the logo is the layered
mark on an ultramarine tile. Details, colours and rules are in
[DESIGN.md](DESIGN.md).

## Visual direction

"Paper and ink": warm neutrals, one ultramarine accent, a rare signal
colour, our own fonts and mark. Binding description in [DESIGN.md](DESIGN.md).

## Quality bar

- Keyboard and screen readers: real roles, labels and focus; native form
  elements stay underneath custom controls (for example below the styled
  dropdowns).
- Permissions are checked on the server; the interface only hides what
  would be refused anyway.
- Security by default: uploads are checked against their content and
  served so that nothing can run, photos lose their location, sign-in
  attempts are rate-limited, a content security policy applies to every
  page.
- Every feature is covered by core and browser tests (desktop and phone);
  CI builds the image for amd64 and arm64.

## Non-goals

- No AI features.
- No tracking, no advertising, no sharing of data with third parties.
- No imitation of other brands in the look – not of AppFlowy, Notion or
  Miro either.
- No lock-in: everything can be exported (Markdown, ZIP, backups), and the
  hosted version runs the same code as a self-hosted one.

## Open questions

- Pricing and limits of the hosted version at app.flowplan.org.
- Which target group to address first in public (teams, schools and
  learners for the calculating features, self-hosters).
