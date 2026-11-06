---
name: issue
description: Triage and work through new GitHub issues, pull requests and new comments across all Flowplan repositories – ask the maintainer design questions first, judge feasibility and sense, implement with subagents in worktrees, test, document (DE + EN), push, build the beta image, answer the reporter in English, set the status labels and report back in one short German message. Use when the user types /issue or asks to "work through the issues like always".
---

# /issue – Flowplan issues and PRs, the usual way

The maintainer is Yannic Schuller (GitHub `yannicschuller`). Talk to him in **German**; write on GitHub in **English**. Optional argument: issue/PR numbers or a repo name to limit the run (e.g. `/issue 112`, `/issue flowplan-app`). Without one, sweep everything.

## Repositories

All under `yannicschuller`. Clone or add (`add_repo`) any that are missing in the session:

| Repo | What | Checks | Build / deploy |
|---|---|---|---|
| `flowplan` | Next.js 16 server (read `node_modules/next/dist/docs/` before Next APIs, see AGENTS.md) | `npx tsc --noEmit`, `npm test`, relevant `npx playwright test …` | `docker.yml` (dispatch, empty version → `:beta`), `ci.yml`, `visual.yml` |
| `flowplan-docs` | Docs DE (`content/docs/*.md`) + EN (`content/docs/en/*.md`) | `ci.yml` | `deploy.yml`, `docker.yml` |
| `flowplan-app` | Expo app iOS/Android | `npm test` (imports without `.ts`) | `build.yml` (platform both/ios/android, build number, upload) |
| `flowplan-desktop` | Desktop app | `ci.yml` | `release.yml` |
| `flowplan-website` | Website | `ci.yml` | `docker.yml` |
| `flowplan-admin` | Admin dashboard (CSP `style-src 'self'`: no inline styles) | `npm test`, demo `DEMO_PORT=4123 npm run -s demo` | – |
| `flowplan-push` | Push relay | `ci.yml` | – |
| `CasaOS-AppStore` | Fork, branch `add-flowplan` | its validator | – |

Use the GitHub MCP tools (`mcp__github__*`, load via ToolSearch), never `gh`.

## Labels – the state machine

Every issue/PR always carries exactly one `status:` label plus one type label. When switching, **remove the old `status:` label** (pass the full label list). Mirror the labels on PRs that belong to an issue.

- Type: `bug`, `enhancement`, `documentation`, `question` (create the label in a repo where it is missing).
- `status: triage` – new, not looked at yet
- `status: needs maintainer input` – waiting for Yannic's decision
- `status: needs reporter info` – waiting for the reporter (keep the issue open)
- `status: in progress` – being worked on
- `status: awaiting approval` – done on our side, waiting for Yannic's OK (e.g. a PR to merge)
- `status: done` – fixed and answered; close the issue (`state_reason: completed`)
- `status: wontfix` – **only with Yannic's explicit OK**; close as `not_planned`

## Step 1 – Collect (all repos, in parallel)

1. Open issues and open PRs per repo (`list_issues` state OPEN, `list_pull_requests`), sorted by update.
2. **New comments on handled issues:** issues updated recently (closed ones too, `orderBy UPDATED_AT`) – read the comments and find any whose last comment is **not** ours (ours end with the Claude Code footer or come from `yannicschuller`). A reporter saying "it still happens" reopens the work.
3. Skip: our own comments, duplicates of things already handled, Dependabot PRs unless asked (list them in the summary).
4. Read every new item fully, including screenshots (images in the body) and linked issues. Look at the relevant code before judging.

## Step 2 – Judge and ask (before any code)

For each item decide, in a few words:
- **Feasibility:** how big, which repos, risks (security, data, CSP, migrations, app store builds).
- **Sense:** does it fit Flowplan (open source, self-hosted, privacy, no tracking, one container with SQLite)? Is it a real bug or a misunderstanding / config question? Duplicate of an existing feature?
- **Design decisions** that are Yannic's to make.

Then ask Yannic **one** `AskUserQuestion` round (max 4 questions, recommended option first with "(Recommended)", each question self-contained with the issue number and the cause you found). Small, clear bugs with an obvious fix need no question – just say you'll fix them. Never ask about `wontfix` silently: propose it as an option.

Set labels now: being worked → `status: in progress`; question to Yannic still open → `status: needs maintainer input`; needs info from reporter → `status: needs reporter info` and post an English question to the reporter.

## Step 3 – Implement

- Independent items → **subagents in worktrees** (`Agent` with `isolation: "worktree"`, run in background), one per issue or coherent group. Brief each like a peer: the issue, the decided design, the files to look at, the checks to run, "commit, don't push, report branch/hash/files/tests". For a second repo the agent creates its own `git worktree` there.
- Small fixes you do yourself in the main checkout meanwhile.
- Don't overstate causes: if a cause is likely but unproven, say so in commit messages and replies.

## Step 4 – Merge, test, document

1. Merge the agents' branches (merge commit if `main` moved; never rewrite others' history). Resolve conflicts properly.
2. Run the checks of every touched repo (table above). Restore `next-env.d.ts` after Next tooling. UI changes: look at them (Playwright screenshot with `executablePath: '/opt/pw-browsers/chromium'`).
3. **Docs** in `flowplan-docs`, German **and** English, natural wording, the matching existing page. Then in `flowplan` run `npm run help-docs` and commit the result.
4. Visual tests that change on purpose: run `visual.yml` with `update=true`, then fast-forward `origin/visual-baselines` into main.

Commit messages end with the trailers from CLAUDE.md (`Co-Authored-By: Yannic Schuller …`, `Co-Authored-By: Claude …`) plus the attribution lines the session's system prompt gives.

## Step 5 – Push and build

1. Per repo: `git push -q origin HEAD:main`, then force-push the session's designated branch (`git push -q -f origin HEAD:<session-branch>`). Do this in **every** repo you changed, docs included.
2. Server changes → dispatch `docker.yml` in `flowplan` without a version (**one beta build at the end**, not per issue).
3. App changes → ask Yannic before building. iOS testers: `build.yml` with upload (TestFlight; raise the build number). **Android users only get fixes through the APK on flowplan.org/download, i.e. a new GitHub release via `release.yml`** (`/app-release`) – Google Play is not used. Desktop changes → mention, release only on request.
4. Wait for **CI, Visual and Docker** to be green (watch the runs; don't poll with sleep loops – use Monitor or check back). Red → root-cause and fix before answering anyone.
5. Never create PRs, merge PRs, or publish releases without Yannic's explicit OK.

## Step 6 – Answer and label

For each finished item, an **English** comment to the reporter:
- thank them (with @mention), what the cause was, what changed (short bullets), how it was tested, link to the docs page (`https://docs.flowplan.org/en/...`), "It's in the `:beta` image now and will be in the next release." (app: which build/track).
- End with the footer, exactly:

```

---
_Generated by [Claude Code](https://claude.ai/code)_
```

Then labels → `status: done` and close (completed). Issues waiting on a device test/app update by the reporter → `status: needs reporter info`, keep open.

## Step 7 – Report to Yannic (one short German message)

- Per item: number, title, one line what was done or why not, status label.
- New comments found and how they were handled.
- Builds/runs and their result; anything he must do himself (set an env var in Coolify, approve a PR, answer a question).
- Open decisions.

Keep it short: no file dumps, no process narration.

## Standing rules

- Tokens, passwords and secrets are never written in chat or code; Yannic enters them himself.
- Never `pkill -f`; kill only by exact PID.
- awesome-selfhosted and similar lists: Yannic submits personally (no LLM submissions).
- The scheduled triage task `trig_01W6FU6RnkGpH9vrXmwJWxLg` is disabled on purpose – don't re-enable it.
