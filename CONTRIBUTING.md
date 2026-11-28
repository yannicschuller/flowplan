# Contributing to Flowplan

Thanks for your interest! Bug reports, ideas and pull requests are welcome. Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).

## Before you start

- **Questions and ideas:** ask in the [Flowplan Discord](https://discord.gg/bCEdB6MPrR).
- **Bugs:** open an issue with steps to reproduce, what you expected and what happened. Include your browser, whether you self-host (and how) and the Flowplan version or image tag.
- **Larger changes:** open an issue first so we can agree on the approach before you invest time.
- **Security issues:** do not open a public issue – see [SECURITY.md](SECURITY.md).

## Development setup

```sh
npm ci
cp .env.example .env.local
npm run dev
```

Node.js 24 or newer. Without OIDC settings the development server offers a local example account.

## Pull requests

- Keep changes focused; one topic per pull request.
- Match the surrounding code: naming, comment density, no new dependencies without a reason.
- Add or update tests: core logic in `tests/*.test.ts`, user-facing behaviour in `tests/browser/*.spec.ts` (desktop and mobile).
- Run `npm run typecheck`, `npm test` and, for UI changes, the relevant browser tests. Never point tests at a data directory you care about – browser tests need a server with its own `FLOWPLAN_DATA_DIR`.
- Update the documentation ([flowplan-docs](https://github.com/yannicschuller/flowplan-docs)) when behaviour changes.
- New UI strings are written in German and English side by side (`t("Anmelden", "Sign in")`). Run `npm run i18n` afterwards: it adds them to the catalogues in `locales/`, where further languages (French and Simplified Chinese so far) translate the English text; missing translations show in English.

## Browser tests

`npm run test:browser -- tests/browser/journal.spec.ts` runs one or more browser specs against a server of their own: a fresh data folder and build directory, a free port, `APP_URL` and `FLOWPLAN_DATA_DIR` set, Playwright pointed at it (with `/opt/pw-browsers/chromium` when that exists). It waits for `/api/health`, and at the end stops only the server it started.

| Option | |
| --- | --- |
| `--repeat <n>` | Every test n times, to find flaky ones |
| `--build` | The production build of the browser specs (`npm run build:e2e`, as in CI) instead of the development server: longer to start, several times faster per test |
| anything else | Passed to Playwright, e.g. `--project=desktop`, `-g "title"` |

CI runs all specs against that production build (Actions → Browser specs; also nightly): `npm run build:e2e`, then `TEST_SERVERS=2 FLOWPLAN_DATA_DIR=/tmp/flowplan-inline-e2e.local npm run test:e2e` starts two servers of it, one per Playwright worker, each with its own port and data folder.

## UI gallery

`npm run gallery` puts every page, dialog, menu and popover of the app on one HTML page – desktop and phone, light and dark – to spot quickly where something does not fit. The same page is published every night from main at **[gallery.flowplan.org](https://gallery.flowplan.org)** (see "The nightly site" below). It starts the production build with an empty data directory (built once with `npm run build` if there is none; `--build` rebuilds), seeds an account with example content like the visual tests (in English), clicks through the scenes in `scripts/gallery/scenes.ts` with Playwright and writes `gallery-out/index.html` (git-ignored; open it in the browser or pass `--open`) with the screenshots as PNG in `shots/`, WebP thumbnails in `thumbs/` and everything the page lists in `manifest.json`. Nothing of it is served by the app.

The gallery is recorded **in English only** – the interface (a browser with the process locale `en_US.UTF-8`, context locale `en-US`, `Accept-Language: en-US`) and the example content (`scripts/gallery/seed.ts`, the English half of `CONTENT` in `scripts/production-server.mjs`, the texts in the scenes) – so that everyone who looks at it can read it, voters on vote.flowplan.org included. The time zone is Europe/Berlin. Scenes click by the English text of the `t("Deutsch", "English")` pairs; a scene's own content is English too. The visual tests and quality budgets keep the German example content. To check a screen in German, see the design-review skill (`.claude/skills/design-review/SKILL.md`).

| Flag | |
| --- | --- |
| `--only <text>` | Scenes whose id, title or group contains the text (repeatable, comma-separated), e.g. `--only dialogs,record` |
| `--desktop`, `--phone`, `--light`, `--dark` | Only these variants (default all four) |
| `--concurrency <n>` | Scenes in parallel (default 4) |
| `--out <dir>` | Output directory (default `gallery-out/`) |
| `--url <origin>` (or `--dev`) | A running server, e.g. `npm run dev`, instead of the build; signs up a new account there (sign-up must be open; the admin scenes need the first account) |
| `--serve`, `--session <file>` | `--serve` starts and seeds a server and waits; other runs reuse it with `--session gallery-out/session.json` – quick while writing a scene |
| `--list` | List the scenes |
| `--webp` | Full screenshots as WebP (quality 80) instead of PNG – about a third of the size; the nightly site uses it |
| `--compare <site or dir>` | Compare with a previous run – a published site (`https://gallery.flowplan.org`) or an output directory – and fill the "Changed" view |
| `--cname <domain>` | Also write `CNAME` and a `robots.txt` that keeps search engines out (GitHub Pages) |

The page uses the app's own colours and type (the tokens of `app/globals.css`, light and dark – it follows the system, the button at the top right switches), filters by group, device, theme and text (`/` jumps to the search), shows the selected variants of a scene side by side and opens a screenshot full size: ← → step through, Space shows the actual size, Esc closes; `#<scene-id>` links to a scene, `#<scene-id>--phone-dark` opens one screenshot. The grid loads small WebP thumbnails (480 px wide for desktop, 240 for phone), the full image only in the viewer. A scene that fails does not stop the run: its card is red with the error and shows what was on screen. Each scene is `{ id, group, title, path, steps }` – `steps` clicks its way there with the same accessible locators as `tests/browser` – and names the component files it shows in `covers`. `tests/gallery-coverage.test.ts` fails when a component renders a dialog, menu or popover (`<Modal>`, `role="dialog"`/`"menu"`) that neither a scene covers nor `scripts/gallery/uncovered.json` lists: add a scene for a new dialog, or list it there.

### The nightly site

`.github/workflows/gallery.yml` runs the gallery every night at 03:47 UTC on main against a production build and publishes it with GitHub Pages at [gallery.flowplan.org](https://gallery.flowplan.org) (`--webp --compare https://gallery.flowplan.org --cname gallery.flowplan.org`): about 730 screenshots, roughly 40 MB (up to twice that on a night when everything changed: the previous images come along), in about 25 minutes. It shows only the seeded example content of a throwaway server – no real accounts, no secrets, nothing of the runner's environment – and needs no secret beyond the workflow's own token. Search engines are kept out (`robots.txt`, `noindex`). To rebuild it by hand: Actions → **UI gallery** → Run workflow (on main; a run on another branch builds the site as the artifact `github-pages` without publishing it).

**Changed since the night before.** Every screenshot gets a hash of its pixels in `manifest.json`. At the start the run fetches the published `manifest.json`; a screenshot with the same hash is unchanged. For the others it compares the thumbnails pixel by pixel (YIQ colour distance as in pixelmatch, threshold 0.1, so WebP noise and anti-aliasing do not count) and calls a screenshot changed when at least 12 pixels and more than 0.05 % of the thumbnail differ (`scripts/gallery/compare.ts`, tested in `tests/gallery-compare.test.ts`). The previous images of changed and removed screenshots are copied into the new site (`before/`), so the **Changed** tab still shows before and after – side by side, and in the viewer as a slider, before or after (B toggles) – once last night's site is replaced. New and removed scenes are listed there too. The first run, or one whose previous manifest cannot be read, says so and lists nothing. Locally: `npm run gallery -- --only settings --out /tmp/g1`, change something, then `npm run gallery -- --only settings --compare /tmp/g1 --out /tmp/g2`.

## Translations

Every language beyond German and English is a JSON catalogue in `locales/`, keyed by the English text. To add one, run `npm run i18n -- --add it`, translate `locales/it.json` (by hand or with any tool that reads JSON key-value files, using `locales/en.json` as the source) and register the language in `lib/i18n.ts` and `lib/i18n-catalogs.ts`. Keep placeholders like `{0}` and HTML tags unchanged; `npm run i18n -- --check` reports progress and broken placeholders. Details: [Languages and translations](https://docs.flowplan.org/languages).

## Shared facts

The website and the documentation quote counts – "ten views", "23 property types", "19 question types", the languages – that must not drift from the code. `lib/facts.ts` counts them from the sources themselves (the view and property enums in `lib/database-schema.ts`, `surveyTypes` in `lib/survey.ts`, `LANGUAGES` in `lib/i18n.ts`, the callout kinds, the export formats, the template catalogue) and `npm run facts` writes them to `facts.json` in the repository root. Commit that file with the change that moved a number: `tests/facts.test.ts` fails when it is out of date. The two sites ([flowplan-website](https://github.com/yannicschuller/flowplan-website), [flowplan-docs](https://github.com/yannicschuller/flowplan-docs)) fetch the raw file from the main branch at build time (`https://raw.githubusercontent.com/yannicschuller/flowplan/main/facts.json`) and read the top-level numbers (`views`, `fieldTypes`, `questionTypes`, `languages`, …); `names` lists the members behind each count, for texts that enumerate them.

By contributing you agree that your contributions are licensed under the [AGPL-3.0](LICENSE).

## Releases

Maintainers release from GitHub: **Actions → Release → Run workflow**, then choose `patch`, `minor` or `major`. The workflow raises the version in `package.json`, tags `v1.2.3`, writes the release notes and `CHANGELOG.md` from the commit messages since the last release (so write them as clear English sentences) and publishes the image as `latest`, `1.2.3`, `1.2` and `1`. **Actions → Docker image → Run workflow** builds `beta` by hand.

## Continuous integration

CI, image builds and releases run on GitHub's own runners. Only the maintainer can build images or publish releases; the visual regression tests run on GitHub's `ubuntu-latest`, where their baselines are made (Actions → Visual regression → Run workflow with “update” makes new ones). Changes to `.github/` (workflows, settings) need the maintainer's review.
