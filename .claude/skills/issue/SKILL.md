---
name: issue
description: Triage and work through new GitHub issues, pull requests and new comments (also on old and closed issues) across all Flowplan repositories – ask the maintainer design questions first (proposing "won't implement" where it fits), judge feasibility and sense, implement with subagents in worktrees, test, document (DE + EN), push, build the beta image, answer the reporter in English, set the status labels and report back in one short German message. Use when the user types /issue or asks to "work through the issues like always".
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
  - **Categorise every item that has no type label yet** – by what it really is, not the reporter's template: something that worked or is documented and fails → `bug`; a new capability or a change of behaviour → `enhancement`; missing, wrong or unclear docs → `documentation`; a how-to, setup or configuration question → `question`. If the reporter picked the wrong one, correct it (e.g. a "bug" that is a feature request → `enhancement`) and say so in one line in the reply.
  - Several types in one issue: the main one; the rest goes into the reply or a separate issue only if Yannic wants it.
- `status: triage` – new, not looked at yet
- `status: needs maintainer input` – waiting for Yannic's decision
- `status: needs reporter info` – waiting for the reporter (keep the issue open)
- `status: in progress` – being worked on
- `status: awaiting approval` – done on our side, waiting for Yannic's OK (e.g. a PR to merge)
- `status: done` – fixed and answered; close the issue (`state_reason: completed`)
- `status: wontfix` – "won't implement": **only with Yannic's explicit OK**; close as `not_planned`. You may and should **propose** it yourself (see Step 2) – proposing is fine, setting it without his OK is not.

## Step 1 – Collect (all repos, in parallel)

1. Open issues and open PRs per repo (`list_issues` state OPEN, `list_pull_requests`), sorted by update.
2. **New comments on old issues – open and closed, any age:** a reporter often answers weeks after we closed or asked. Per repo, list issues **and PRs** with `state` ALL (open and closed), `orderBy UPDATED_AT`, `direction DESC`, and page through until `updated_at` is older than the last `/issue` run (unknown → 90 days). For every item in that window, read the comments and check the **last** one:
   - Ours (ends with the Claude Code footer, or from `yannicschuller`) → nothing new, skip. (Label changes also bump `updated_at` – that alone is not new activity.)
   - Someone else's → new activity; handle it like a new item:
     - "it still happens" / a new error / a regression → reopen (closed issues), `status: in progress`, back into Step 2.
     - The info we asked for (`status: needs reporter info`) → continue the work with it.
     - "works now" / confirmation → thank them briefly, `status: done`, close (completed).
     - Just "thanks" or an emoji → no reply needed, keep the state.
     - A new, unrelated request in an old thread → answer briefly and suggest a new issue (or open one if Yannic wants).
   - Also look at `status: needs reporter info` issues with **no** answer for more than 30 days and list them in the report (Yannic decides whether to close them as stale).
3. Skip: our own comments, duplicates of things already handled, Dependabot PRs unless asked (list them in the summary).
4. Read every new item fully, including screenshots (images in the body) and linked issues. Look at the relevant code before judging.
   - Images from `github.com/user-attachments/...` often can't be downloaded in the session (the download returns JSON or an error, not the image). Then **ask Yannic for the pictures**: name the issue number, say how many images and where they are (e.g. "#171, the screenshot under 'Describe the solution'"), and ask him to paste them into the chat. Don't guess what a screenshot shows; if it matters for judging the item, wait for it or ask the reporter.

## Step 2 – Judge and ask (before any code)

For each item decide, in a few words:
- **Feasibility:** how big, which repos, risks (security, data, CSP, migrations, app store builds).
- **Sense:** does it fit Flowplan (open source, self-hosted, privacy, no tracking, one container with SQLite)? Is it a real bug or a misunderstanding / config question? Duplicate of an existing feature?
- **Design decisions** that are Yannic's to make.

Then ask Yannic **one** `AskUserQuestion` round (max 4 questions, recommended option first with "(Recommended)", each question self-contained with the issue number and the cause you found). Small, clear bugs with an obvious fix need no question – just say you'll fix them.

**Proposing "won't implement" (`status: wontfix`)** – do this actively, whenever it is the honest recommendation:
- when to propose it: the request doesn't fit Flowplan (tracking, cloud lock-in, against privacy or self-hosting), the cost or risk is far out of proportion to the benefit for most users, it duplicates an existing feature, it belongs in another tool or an integration, or it can't be done well (platform limits).
- how: as an option in the `AskUserQuestion` round, with a one-line reason, e.g. "#123 Won't implement (Recommended) – reason". Make it the recommended option only if you really think so; otherwise list it as an alternative next to implementing it.
- set the label or close only after Yannic chose it. Until then the item stays `status: needs maintainer input`.

Set labels now – the type label (categorise if missing, see Labels) plus the status: being worked → `status: in progress`; question to Yannic still open → `status: needs maintainer input`; needs info from reporter → `status: needs reporter info` and post an English question to the reporter.

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

**Won't implement** (only after Yannic chose it): a friendly English comment that thanks the reporter. Give the reason honestly and briefly, plus an alternative if one exists (existing feature, workaround, integration, docs link), and say that a later change of plan stays possible. Then labels → type + `status: wontfix`, close with `state_reason: not_planned`.

## Step 7 – Report to Yannic (one short German message)

- Per item: number, title, one line what was done or why not, status label.
- New comments found on old/closed issues and how they were handled (reopened, closed after confirmation, answered, or nothing to do).
- `status: needs reporter info` issues without an answer for more than 30 days (stale – close or keep?).
- Proposed "won't implement" items and what he chose.
- Builds/runs and their result; anything he must do himself (set an env var in Coolify, approve a PR, answer a question).
- Open decisions.

Keep it short: no file dumps, no process narration.

## Standing rules

- Tokens, passwords and secrets are never written in chat or code; Yannic enters them himself.
- Never `pkill -f`; kill only by exact PID.
- awesome-selfhosted and similar lists: Yannic submits personally (no LLM submissions).
- The scheduled triage task `trig_01W6FU6RnkGpH9vrXmwJWxLg` is disabled on purpose – don't re-enable it.
