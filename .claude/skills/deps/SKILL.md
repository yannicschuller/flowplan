---
name: deps
description: Keep the Flowplan repositories' dependencies current – review open Dependabot pull requests in every repo (changelog, breaking changes, CI), merge the safe ones only with the maintainer's OK, update pinned tools and base images (Node image, Litestream, Trivy, actions) and re-check the image scan. Use when the user types /deps or asks to "Dependabot-PRs durchgehen", "Abhängigkeiten aktualisieren".
---

# /deps – Dependabot and pinned versions

The maintainer is Yannic Schuller. Talk to him in **German**; write on GitHub in **English**. **Merging a PR needs his explicit OK** – collect, judge, then ask once for the batch.

## 1. Collect

For every repo (`flowplan`, `flowplan-docs`, `flowplan-website`, `flowplan-app`, `flowplan-desktop`, `flowplan-admin`, `flowplan-push`): open PRs by `dependabot[bot]` (`mcp__github__list_pull_requests`), with their CI state on the head commit and mergeability.

## 2. Judge each PR

- **Patch/minor, CI green, no breaking notes** → safe.
- **Major** or a framework (Next.js, React, Expo SDK, Electron, TipTap/ProseMirror, Yjs, tesseract.js, sharp) → read the release notes/changelog; for Next.js also the version's guide in `node_modules/next/dist/docs/` after checkout. Check out the PR branch in a worktree, run the repo's checks (see `/ship`), and for UI-heavy updates a Playwright smoke run.
- **CI red** → find out whether the bump causes it or `main` is red too; a small fix can go onto the Dependabot branch only with Yannic's OK (or do the update in your own commit on main instead and let Dependabot close the PR).
- Expo/React Native in `flowplan-app`: native modules must match the Expo SDK (`npx expo install --check`); don't bump single native packages past the SDK.
- Grouped PRs with many packages: judge the risky ones inside.

## 3. Pinned versions Dependabot doesn't see

- `flowplan/Dockerfile`: `node:<major>-bookworm-slim`, `litestream/litestream:<x.y.z>` (Docker Hub tags), the Trivy image in `docker.yml`.
- Workflow actions pinned by major (`actions/checkout@vN` …) where Dependabot isn't configured.
- Prefer releases that are at least a few days old; note the date.

## 4. Ask, then do

One `AskUserQuestion` (or a short German list) with: merge these (safe), these need a look (why), these stay (why). After OK: merge with the default merge method (`mcp__github__merge_pull_request`), one at a time, waiting for the rebased next one's CI. Own updates (step 3) via `/ship`. Then check the next Docker run's Trivy `scan` job.

## 5. Report (German, short)

Merged · waiting · declined (reason), run results, Trivy result, and anything for Yannic (e.g. redeploy).
