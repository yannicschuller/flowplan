---
name: release
description: Publish a Flowplan server release (patch by default, minor or major on request) with the repository's standard Release workflow – only from a green main, then check the release notes and the published image, and tell the reporters of issues that waited for the release. Use when the user types /release or asks for a "neues Release", "Patch Release", "Minor Release".
---

# /release – a Flowplan release, the standard way

The maintainer is Yannic Schuller (GitHub `yannicschuller`). Talk to him in **German**; write on GitHub in **English**. Argument: `patch` (default), `minor` or `major`. The user invoking `/release` is the OK to publish this one release – nothing more.

## 1. Preconditions

1. `cd /home/user/flowplan && git fetch -q origin main --tags` – **look at the remote tags**, local ones may be stale. The next version is what `release.yml` computes: a version already raised in `package.json` but never tagged is released as it is; otherwise `bump` raises it.
2. The head of `main` must be green: CI, Visual regression, Docker image (and CodeQL). Not green → `/ship` first (fix, push, wait), then come back. Uncommitted or unpushed work → ask whether it belongs in the release.
3. **Curated notes:** `release-notes/<next version>.json` must exist on `main` (#223) – it leads the GitHub release and `CHANGELOG.md` and is what "Neu in Flowplan" shows users after the update. Missing or stale → write/update it from `git log <last tag>..origin/main --no-merges` and the issues closed since: sections `breaking`, `security`, `features`, `improvements`, `fixes`, short user-facing lines with `de` and `en` (optional `fr`/`zh`, `issues: [n]`), no tests/CI/help-docs noise; `node --import tsx --test tests/release-notes.test.ts`, commit, push, wait for green. A minor/major bump: rename the file to that version. Without it the workflow only warns and lists the commits.
4. Show Yannic nothing for approval unless something is odd (a red run, a huge or surprising change list) – then ask once.

## 2. Run the standard workflow

Dispatch **`release.yml`** on `main` with `bump: <patch|minor|major>` (`mcp__github__actions_run_trigger`, method `run_workflow`). Never tag by hand, never create the GitHub release by hand, never force-move a tag (pushes of tags with force are refused anyway).

The workflow raises `package.json` and the Helm chart's `appVersion`, commits with `CHANGELOG.md`, tags `vX.Y.Z`, creates the GitHub release (notes from `scripts/release-notes.mjs`: the curated file first, the commits folded under "All commits") and publishes the image as `:latest`, `:X.Y.Z`, `:X.Y`, `:X` (it calls `docker.yml`).

Watch it with **Monitor** until it finishes. Red → read the job log, root-cause; re-dispatch only after the cause is fixed.

## 3. After the release

1. `mcp__github__get_latest_release` – check tag, notes (no internal noise that shouldn't be public), and that the Docker part of the run is green including the Trivy `scan` job.
2. `git pull --ff-only origin main` locally (the release commit), then force-push the session branch to it.
3. **Docs version markers:** the docs site turns "New in X.Y.Z · in the :beta image" into "Since X.Y.Z" by itself once the release exists (it reads the latest release tag at build time) – redeploy the docs (`deploy.yml` in flowplan-docs, or push any docs commit) so the badges update right away, and check one marked page.
4. Issues that are `status: done` and whose last comment said "will be in the next release": optional one-line note "Released in vX.Y.Z" only if Yannic asks for it – don't spam.

## 4. Report (German, short)

Version and link, the main changes in a few bullets (grouped: features, fixes, security), run results, and anything Yannic does by hand (e.g. watch Coolify pull `:latest` on stable instances).

## Not this skill

- App store versions → `/app-release`. Desktop app → its own `release.yml` in `flowplan-desktop`, only on explicit request.
