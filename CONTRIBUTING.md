# Contributing to Flowplan

Thanks for your interest! Bug reports, ideas and pull requests are welcome.

## Before you start

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
- The user interface is German and English; add both texts for new UI strings.

By contributing you agree that your contributions are licensed under the [AGPL-3.0](LICENSE).

## Releases

Maintainers release from GitHub: **Actions → Release → Run workflow**, then choose `patch`, `minor` or `major`. The workflow raises the version in `package.json`, tags `v1.2.3`, writes the release notes and `CHANGELOG.md` from the commit messages since the last release (so write them as clear English sentences) and publishes the image as `latest`, `1.2.3`, `1.2` and `1`. Every other push builds `beta`.
