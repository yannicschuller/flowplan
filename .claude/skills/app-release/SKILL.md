---
name: app-release
description: Bring a new version of the Flowplan iPhone/iPad and Android app to everyone – write the store release notes from the commits (de, en, fr, zh-Hans), build and upload with flowplan-app's Release workflow, submit the version for App Store review (released automatically once Apple approves), and list the Play Console step for the maintainer. Use when the user types /app-release or asks for "ein App-Update für alle", "neue App-Version in den Store".
---

# /app-release – a new app version in the stores

The maintainer is Yannic Schuller. Talk to him in **German**. Repo: `/home/user/flowplan-app` (`yannicschuller/flowplan-app`). The user invoking `/app-release` is the OK for this one upload and submission.

## 1. Which version, which build

- `git fetch -q origin --tags`; `package.json` holds the version. Version code = ((major·100+minor)·100+patch)·100+build.
- Ask Yannic only if unclear: **is the newest tagged version already live in the App Store?**
  - Not live yet, and its build is in TestFlight → no new build; go to step 3 with that version.
  - Live, or no build of it uploaded → new version (step 2).
- Nothing changed in the app since the live version (only README etc.) → say so; an update without changes gets rejected or is pointless.

## 2. Release notes and build

1. Write the release notes from `git log v<live>..HEAD` (user-facing changes only, short bullets, no internals):
   - `store/app-store/{de-DE,en-US,fr-FR,zh-Hans}/release_notes.txt` (≤ 4000 chars, Apple's wording style; Simplified Chinese with Apple's official terms);
   - `store/google-play/<locale>/changelogs/<versionCode>.txt` (≤ 500 chars) for the locales that exist.
   `npm test` checks the limits. Commit and push (`main` + session branch).
2. Dispatch **`release.yml`** on `main`: `bump: patch` (or as asked), `upload: true`, `confirm: <the new version>`. For a failed build: `rebuild: <version>`, `build: <n+1>`, same `confirm`.
3. Watch with **Monitor**. Red → job log, root-cause (e.g. the Gradle heap). Never force-move a tag; release the next patch instead.

The workflow builds iOS and Android, attaches IPA/APK/AAB to the GitHub release (the website's APK link and the Android in-app update follow it) and uploads to **TestFlight** and **Play internal testing**.

## 3. Submit to Apple

Dispatch **`ios-setup.yml`** on `main` with `identifiers=false`, `signing=false`, `force_profiles=false`, `listing=true`, `screenshots=false` (true only if the screenshots changed), `creative=false`, `submit=true`. It uploads texts and release notes, waits until the build is processed, selects the newest build of `package.json`'s version and submits it for review. `automatic_release` is on: the version goes to everyone as soon as Apple approves (usually 1–2 days).

Check the job log for "Successfully submitted the app for review!". Precheck problems or a missing build → fix and run again.

## 4. Report (German, short)

Version, what's new (the release notes in German), run results, and what Yannic does by hand:
- **Play Console:** promote the build from internal testing to **production** (not automated).
- App Store Connect: nothing, unless Apple asks questions in review.
- Issues waiting for this app version (`status: needs reporter info`): tell the reporters which version/track has the fix, in English, with the footer.

## Rules

- Mainland China stays excluded in App Store Connect (no ICP filing) – never add it.
- Tokens, the review demo account and signing secrets are never written anywhere.
