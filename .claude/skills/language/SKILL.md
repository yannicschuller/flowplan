---
name: language
description: Add a UI language to Flowplan or complete one across every repository – web app catalogues, iOS/Android app (UI, widgets, permission texts), desktop app, store listings, website and docs hints, OCR – with official platform terminology and checks that every catalogue is complete. Use when the user types /language (e.g. "/language es") or asks for a new language or missing translations.
---

# /language – one language everywhere

The maintainer is Yannic Schuller. Talk to him in **German**. Argument: the language (`es`, `it`, `zh` …) and optionally which parts. Languages today: German (source), English, French, Simplified Chinese (web app, apps, desktop, store); OCR deu/eng/fra/chi_sim.

## 1. Decide first (one question round)

Ask only what isn't clear: script/variant (e.g. zh-Hans vs zh-Hant, pt-BR vs pt-PT), which parts (web app only, or apps/desktop/store too), store availability limits (e.g. mainland China needs an ICP filing → excluded), OCR data (≈ +7–22 MB image per language, opt-in via `FLOWPLAN_OCR_LANGS`).

## 2. Where the strings live

| Part | Where | How to check |
|---|---|---|
| Web app | `flowplan/locales/<lang>.json` (keys are the English strings of `t(de, en)` pairs); language list and switcher | `npm run i18n` reports coverage; must be 100 % |
| Server texts (e-mails, push, errors) | `lib/i18n-errors.ts`, `translate(locale)` calls | grep for locale unions like `"de" \| "en" \| "fr"` and APIs that validate locales (e.g. `lib/desktop-capture.ts`) |
| iOS/Android app | `flowplan-app`: `app.config.ts` (`locales`, `CFBundleLocalizations`), `locales/*.json` (permission texts), `src/i18n*.ts`, native widget/Live Activity/intent strings in `plugins/**` | `npm test` |
| Desktop | `flowplan-desktop/strings.js` (one entry per language), locale mapping, spell-check list `settings.js` (only languages Chromium has a Hunspell dictionary for) | `npm test` (string-table test) |
| Store listings | `flowplan-app/store/app-store/<locale>/`, `store/google-play/<locale>/`, screenshots via `npm run screenshots` + `npm run store:images` | `npm test` (store limits) |
| Website | `flowplan-website` copy files | its checks |
| Docs | `flowplan-docs` is DE + EN only – mention the new language where languages are listed (`languages.md` DE/EN) |  |
| OCR | `flowplan/lib/ocr.ts` `OCR_LANGUAGES`, `@tesseract.js-data/<code>`, `next.config.ts` `outputFileTracingIncludes` | `tests/ocr-*.test.ts` |

## 3. Translate well

- Natural, short UI wording; consistent with the existing catalogue of that language (read it first).
- Platform terms in the platform's official wording (Apple/Google/Microsoft glossaries: widgets, Live Activities, Shortcuts, Control Center, notification area …).
- Placeholders (`{0}`), product names, keyboard keys and code stay as they are; formats (dates, numbers) via `Intl`.
- Fallbacks: decide which device locales map to the language and what other variants fall back to (usually English), and say so.

## 4. Work and ship

Independent repos → one subagent per repo in a worktree (brief: language, variant, files above, terms, checks, "commit, don't push"). Merge, run every touched repo's checks, docs, then `/ship`. App store text/screenshot changes go out with the next `/app-release`.

## 5. Report (German, short)

Per repo what is translated and what deliberately isn't (with the reason), coverage numbers, fallbacks, and the manual steps (App Store Connect availability, Play Console listing).
