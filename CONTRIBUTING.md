# Contributing to Flowplan

Thanks for your interest! Bug reports, ideas and pull requests are welcome.

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

Node.js 22.13 or newer. Without OIDC settings the development server offers a local example account.

## Pull requests

- Keep changes focused; one topic per pull request.
- Match the surrounding code: naming, comment density, no new dependencies without a reason.
- Add or update tests: core logic in `tests/*.test.ts`, user-facing behaviour in `tests/browser/*.spec.ts` (desktop and mobile).
- Run `npm run typecheck`, `npm test` and, for UI changes, the relevant browser tests. Never point tests at a data directory you care about – browser tests need a server with its own `FLOWPLAN_DATA_DIR`.
- Update the documentation ([flowplan-docs](https://github.com/yannicschuller/flowplan-docs)) when behaviour changes.
- New UI strings are written in German and English side by side (`t("Anmelden", "Sign in")`). Run `npm run i18n` afterwards: it adds them to the catalogues in `locales/`, where further languages (French so far) translate the English text; missing translations show in English.

## Translations

Every language beyond German and English is a JSON catalogue in `locales/`, keyed by the English text. To add one, run `npm run i18n -- --add it`, translate `locales/it.json` (by hand or with any tool that reads JSON key-value files, using `locales/en.json` as the source) and register the language in `lib/i18n.ts` and `lib/i18n-catalogs.ts`. Keep placeholders like `{0}` and HTML tags unchanged; `npm run i18n -- --check` reports progress and broken placeholders. Details: [Languages and translations](https://docs.flowplan.org/languages).

By contributing you agree that your contributions are licensed under the [AGPL-3.0](LICENSE).

## Releases

Maintainers release from GitHub: **Actions → Release → Run workflow**, then choose `patch`, `minor` or `major`. The workflow raises the version in `package.json`, tags `v1.2.3`, writes the release notes and `CHANGELOG.md` from the commit messages since the last release (so write them as clear English sentences) and publishes the image as `latest`, `1.2.3`, `1.2` and `1`. **Actions → Docker image → Run workflow** builds `beta` by hand.

## Continuous integration

Pull requests from collaborators and forks are tested on GitHub's own runners. Only work started by the maintainer runs on the project's self-hosted runner, and only the maintainer can build images or publish releases. Changes to `.github/` (workflows, settings) need the maintainer's review.
