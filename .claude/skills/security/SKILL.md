---
name: security
description: Triage security findings for Flowplan – a security export from Flowplan Admin (CodeQL, Dependabot, secret scanning), a Trivy table from the Docker build, or a single advisory. Every finding gets a verdict (real, hardening, false positive, test code) with the traced data flow; real ones are fixed with tests and shipped, and the rest get a one-line reason to paste when dismissing in GitHub. Use when the user types /security or pastes code-scanning alerts, a Trivy scan or a CVE.
---

# /security – real or not, and fix what is real

The maintainer is Yannic Schuller. Talk to him in **German**. Input: what he pasted (Markdown export from Flowplan Admin → Security → "Als Markdown kopieren", a Trivy table, a CVE) or, without input, fetch it yourself: Trivy from the latest `docker.yml` run's `scan` job log; code scanning via the GitHub tools if available.

## 1. Group

Group findings by rule/kind and file, so one agent or one pass handles a group (e.g. password-hash, XSS/sanitization, ReDoS/tests, image packages). Large exports → one subagent per group in its own worktree (`git worktree add .claude/worktrees/sec-<group> -b sec-<group>` + `cp -al node_modules`), briefed with the alert numbers, files and the questions below; "commit, don't push, report a table".

## 2. Judge each finding – trace, don't guess

- **Who controls the input?** Other users (shared pages, comments), external senders (inbound mail, calendar feeds, web clips, imports, API/MCP callers) are untrusted; the user's own paste in their own tab is low risk; constants are no risk.
- **Where does the output go?** innerHTML/dangerouslySetInnerHTML/HTML export/e-mail/SVG → must be escaped or sanitized; React text, search index, AI prompt, plain-text fields → tag-stripping is not a security step.
- **Hashing:** user and share passwords must be scrypt (they are: `lib/local-auth.ts`, `lib/share-access.ts`); SHA-256/HMAC of server-generated random tokens is correct.
- **ReDoS:** server-side regex on untrusted input is a real DoS on a one-container app – fix with a linear rewrite and a timing test (attack string ×50k < 100 ms).
- **Image (Trivy):** OS packages → `apt-get upgrade` in the runtime stage; Node packages not in `npm ls` → they come with the base image's npm/corepack (removed from the runtime stage); Go binaries (Litestream) → newer upstream release, else document why it doesn't reach Flowplan.
- **Test code:** only fix if it's trivial and keeps intent; otherwise "used in tests".

Verdicts: **real** (exploitable path) · **hardening** (not exploitable today, cheap to make robust) · **false positive** · **test code** · **won't fix** (reason).

## 3. Fix

Real and cheap hardening: minimal fix + regression test that fails without it (use the scanner's bypass input). No behaviour change beyond the fix; no data migrations that break existing tokens/passwords without asking. Then `/ship`.

## 4. Report (German)

A table per group: `#` · verdict · one-line reason. Then: what was fixed (commit), test/run results, and **the dismiss list** for GitHub – per alert the reason category ("False positive", "Used in tests", "Won't fix") and a one-line English justification to paste. Alerts that close by themselves after the next CodeQL run (fixed code) are named separately. A secret-scanning alert is always critical: tell Yannic to rotate the secret first, before anything else.

## Full audits

A full or end-to-end security audit / pen test of a repository (not triage of given findings) → use the `security-audit` skill (Cloudflare's methodology, `.claude/skills/security-audit/`), then fix what it confirms the way this skill does.
