---
name: ship
description: Ship finished work in the Flowplan repositories – run the repo's checks, commit with the right trailers, push main and the session branch in every changed repo, build the :beta image only when the maintainer asks for it, wait until CI, Visual regression (and Docker/CodeQL when built) are green, root-cause anything red, and report in one short German message. Use when the user types /ship or says "push das", "bau die Beta", "schick das raus".
---

# /ship – checks, push, beta, green

The maintainer is Yannic Schuller (GitHub `yannicschuller`). Talk to him in **German**. Optional argument: repo names to limit the run (`/ship flowplan-admin`). Without one, ship every repo under `/home/user` with changes.

## 1. Find what is to ship

For each repo (`flowplan`, `flowplan-docs`, `flowplan-website`, `flowplan-app`, `flowplan-desktop`, `flowplan-admin`, `flowplan-push`): `git status --short` and commits ahead of `origin/main`. Unmerged worktree branches under `.claude/worktrees/` are **not** shipped – mention them.

Tool noise is never committed: restore `next-env.d.ts` and a reformatted `tsconfig.json` (`git checkout`) – Next's dev server rewrites them.

## 2. Check before pushing

| Repo | Checks |
|---|---|
| `flowplan` | `npx tsc --noEmit -p .`, `npm test`, relevant `npx playwright test …` for UI changes (dev server: `FLOWPLAN_DATA_DIR=<scratch> APP_URL=http://127.0.0.1:<port> npx next dev --hostname 127.0.0.1 -p <port>`; Chromium `/opt/pw-browsers/chromium`) |
| `flowplan-docs` | `npm test`; docs changed → run `npm run help-docs` in `flowplan` and commit `lib/ai/help-docs.json` there too |
| `flowplan-admin` | `npm test`, `npm run -s lint` (biome; `npx biome check --write` formats), `npx tsc --noEmit -p .` |
| `flowplan-app` | `npm test` (imports without `.ts`) |
| `flowplan-desktop` | `npm run check`, `npm test` (needs `xvfb-run -a` without a display) |
| `flowplan-website` | its `package.json` scripts (lint, typecheck, test) |

Red locally → fix first. Never skip or disable a test.

## 3. Commit and push

Commit messages say what changed and why; they end with the trailers from CLAUDE.md plus the attribution lines the session's system prompt gives. Then per repo:

```sh
git push -q origin HEAD:main && git push -q -f origin HEAD:<session-branch>
```

(`flowplan`'s "Bypassed rule violations" remote message is expected.) Never force-push `main`, never rewrite pushed history.

## 4. Build

- **The `:beta` image is built only when Yannic explicitly asks for it** ("bau die Beta", "/ship mit Beta") **or starts `docker.yml` himself.** A push to `main` never builds or deploys it on its own (`docker.yml` runs on release tags and manual dispatch only – keep it that way). When asked: dispatch `docker.yml` on `main` **without** a version (→ `:beta`, deployed to Coolify by the workflow), one build at the end. Otherwise say in the report that server changes are on `main` and the beta can be built on request.
- `flowplan-website` and `flowplan-docs` build their images on push by themselves.
- `flowplan-app` / `flowplan-desktop`: no build here – that is `/app-release` or the desktop release (only on request).

## 5. Wait for green

Watch the runs of the pushed commit (`/repos/<owner>/<repo>/actions/runs?head_sha=<sha>`) with **Monitor** (one line per finished run, exit when CI and Visual regression – and the Docker image, if one was built – are done) – never `sleep` loops in the foreground. Red → read the failing job's log (`mcp__github__get_job_logs`), root-cause, fix, push again. A failure that is red on `main` before your change too: say so, don't hide it. Visual tests that changed on purpose: `visual.yml` with `update=true`, then fast-forward `origin/visual-baselines` into main.

The Docker run's `scan` job prints Trivy (HIGH/CRITICAL with a fix). New findings → `/security`.

## 6. Report (German, short)

Per repo: commit, what it does in one line, checks, run results (CI / Visual / Docker / CodeQL), anything Yannic must do (redeploy in Coolify for `flowplan-admin`/`flowplan-push`, …). No file dumps.

## Rules

- Tokens and secrets never in chat or code. Kill processes only by exact PID.
- No PRs, no merging PRs, no releases from this skill.
