## What and why

<!-- What does this change, and why? Link the issue it fixes. -->

Fixes #

## How to test

<!-- Steps a reviewer can follow, and what they should see. -->

## Screenshots

<!-- For UI changes: before/after, light and dark, desktop and phone width. Delete if not relevant. -->

## Checklist

- [ ] `npm run typecheck` and `npm test` pass; for UI changes I ran the relevant browser tests
- [ ] New UI texts use `t("Deutsch", "English")`, and I ran `npm run i18n`
- [ ] It works in light and dark mode and at phone width (if UI)
- [ ] Docs are updated in [flowplan-docs](https://github.com/yannicschuller/flowplan-docs), or nothing user-visible changed
- [ ] API changes: `npm run sdk` was run and the OpenAPI document is up to date
- [ ] Database changes come with a migration and don't break existing data
- [ ] No secrets, personal data, symlinks or unrelated files (e.g. `node_modules`) are included
- [ ] This PR fits Flowplan's idea (open source, self-hostable, privacy-friendly, everything in one page tree) and follows the [contributing guide](../CONTRIBUTING.md) and [code of conduct](../CODE_OF_CONDUCT.md)

## Notes for the reviewer

<!-- Anything you're unsure about, trade-offs, follow-ups. Mention if parts were generated with AI tools. -->
