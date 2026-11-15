---
name: br
description: Turn a bug description (plus optional screenshots or logs) into a Flowplan bug report that follows .github/ISSUE_TEMPLATE/bug_report.yml, show the draft, wait for the reporter's OK, then create the issue in yannicschuller/flowplan with reporter GitHub credentials. Use when the user types /br or asks to file a bug report.
---

# /br – Bug report for Flowplan

Create one bug report in `yannicschuller/flowplan`. Never create it before the reporter approves the draft.

## Input

- The bug description (free text), optional screenshots and logs. Optional argument: a title hint.
- Template: [bug_report.yml](../../../.github/ISSUE_TEMPLATE/bug_report.yml). Its field labels and order are the source of truth. Step 0 checks that this skill still matches it.

## Writing style and transparency

The issue is the reporter's own bug report: the skill does the research and drafting, the reporter reviews and approves every draft before it is created. Disclosure is explicit and fixed: every issue ends with `Drafted with the /br skill, reviewed by me.` That line also tells the maintainer the report went through the docs and duplicate checks.

The style rules below serve readability, not concealment. Readers tend to skim text that looks machine-generated and miss details. So the body stays focused on the bug itself: plain punctuation (no em dash), no process notes, no placeholders for missing answers, and no repeated mentions of the agent or tooling. The final attribution line is the single place where the tooling is mentioned.

## Step 0 – Check the template is still current

The snapshot at the end of this file is the template this skill was written for. Before anything else:

1. Fetch the template from the default branch: `git fetch origin main`, then `git show origin/main:.github/ISSUE_TEMPLATE/bug_report.yml`. If offline, use the local file and say so.
2. Compare it with the snapshot: field order, `id`s, `label`s, `required` and `multiple` flags, the checkbox text, the labels, and every dropdown option text, exactly. Ignore wording changes in the intro markdown and in field descriptions that don't change a field's meaning.
3. Identical → continue with Step 1 without comment.
4. Different → stop before Step 1. Tell the user what changed (added, removed, renamed or reordered fields, changed options or required flags) and ask the user, offering these options:
   - **Update the skill now** (recommended): update the snapshot and every step that depends on it (Step 2 mandatory fields, Step 3 headings and dropdown values, Rules), show the diff of `SKILL.md`, and continue once the user confirms it.
   - **Use the new template for this run only**: draft from the new template and leave the skill unchanged. Mention that the skill is still outdated.
   - **Cancel**.

   Create nothing until the user has chosen.

## Step 1 – Read and check

1. Read the description and every attachment. Describe what each screenshot shows in one line; don't guess at unreadable parts.
2. **Check the documentation first**, before searching issues or drafting. Follow [/rtfm](../rtfm/SKILL.md): search the docs MCP server for the feature's key terms (English and German), then read the best one or two matching pages. If those actions are not available, fetch `https://docs.flowplan.org/llms.txt` and the relevant Markdown pages. Then:
   - If the docs say the behaviour is intended or describe a different result, tell the user what the docs say (with links) and ask whether they still want to file a bug. Draft nothing until they confirm.
   - If the docs describe the feature and the report matches what they say is expected, continue and mention the documented behaviour in the draft's "What did you expect?" only if the reporter agrees.
   - If the docs do not cover the feature, say so in one line and continue.
3. Logs: remove secrets, tokens, passwords, emails, IPs and personal data before quoting them. Show the redacted version.
4. Security problems are not bug reports. If the description reads as a vulnerability, stop and point the user to the private reporting channel in [SECURITY.md](../../../SECURITY.md).
5. Bugs that only happen in the iPhone/Android app or the desktop app belong in `yannicschuller/flowplan-app` or `yannicschuller/flowplan-desktop`. If the report clearly targets one of them, tell the user and ask where to file it.
6. Search for duplicates in `yannicschuller/flowplan` (open and closed issues) with the key terms of the bug (feature name, error message, view). Report the closest matches. If one clearly covers the bug, stop and tell the user.
7. Make sure the generated markdown descriptions do not include garbage characters like `[span_2](start_span)"[span_2](end_span)` or other things typically found in AI generated content (emoticons, extra quotes, etc.).
8. The issue title and body must never contain the em dash character `—` (U+2014). Rewrite every sentence with plain punctuation (`-`, `,`, `:` or `;`) so the text reads naturally (see Writing style and transparency).

## Step 2 – Ask for missing mandatory input

Ask only for what you cannot deduce. Mandatory (the form requires them):
- **Question order exception:** the template's field order governs the draft in Step 3 only. In every question, list the "Where does it run?" options in this order: `Self-hosted with Docker / Docker Compose`, `Self-hosted on Kubernetes (Helm chart)`, `Self-hosted without Docker (Node.js)`, `Development (npm run dev)`, `flowplan.org (hosted)`. Do not copy the template's dropdown order (flowplan.org first) into the question.
- **What happened?** A clear description of the problem.
- **Steps to reproduce.** The shortest way to make it happen again.
- **What did you expect?**
- **Flowplan version.** Under **Settings → About Flowplan** (e.g. 0.9.0), or the image tag. On flowplan.org write "flowplan.org".
- **Where does it run?** Offer the self-hosted options first, starting with self-hosted with Docker / Docker Compose, then self-hosted on Kubernetes (Helm chart), self-hosted without Docker (Node.js), development (`npm run dev`), and flowplan.org (hosted) last. Use the exact option text of the template's dropdown.
- **Where do you see the problem?** One or more of: browser on a computer, browser on a phone or tablet, iPhone / iPad app, Android app, desktop app (macOS, Windows, Linux).
- Confirmation that you searched for existing issues (the form's required checkbox). Step 1 already does this; tell the user the result.

Optional, ask only if relevant: database (self-hosted only: SQLite, PostgreSQL, cluster, or unknown / hosted on flowplan.org), browser, device and operating system (device model and OS version, e.g. iPadOS, Android, macOS or Windows version), screenshots or recordings, and logs.

Ask all questions in one batch. Every answer the reporter does not give is left out of the issue completely (see Rules). Never ask the reporter about the agent or the tooling.

## Step 3 – Draft

Dropdown values (e.g. `### Where does it run?`) are submitted as the template's option text, exactly as written in `bug_report.yml`, for example `Self-hosted with Docker / Docker Compose`. Never submit the position in the question list, a number, or a reworded label. The order in which options are offered in Step 2 does not change the template's options or their numbering.

Write the draft in English, using the template's headings in this order, so it reads like the form:

1. `### Before you start` – one checkbox line: `- [x] I searched the existing issues (open and closed) and this has not been reported yet.`
2. `### What happened?`
3. `### Steps to reproduce` – numbered list
4. `### What did you expect?`
5. `### Flowplan version`
6. `### Where does it run?`
7. `### Database`
8. `### Where do you see the problem?`
9. `### Browser, device and operating system`
10. `### Screenshots or recordings` (omitted from the body, see below)
11. `### Logs` – the redacted log goes in its own fenced block, the only code block in the draft

Omit optional sections the reporter left empty, but keep the required ones. Keep the problem first. Do not invent facts, versions, numbers or quotes. Keep reproduction steps exactly as the reporter described them. Anything you had to infer is worded as the reporter's own description, not as a note about inference.

After all template sections, append this exact line as the final line of the issue body: `Drafted with the /br skill, reviewed by me.`

Before showing the draft, scan the title and body and remove process notes and placeholders, so the body contains only the reporter's content (see Writing style and transparency). Remove any note or parenthetical such as "not provided", "not specified", "unknown", "to be confirmed", "n/a", "(assumed)", or a reference to the agent, AI, Claude, Copilot, a skill, or a tool, except for the required final line above. Also replace every em dash (`—`) with plain punctuation. If a required field has no answer from the reporter, go back to Step 2 and ask, do not write a placeholder.

Show the draft as rendered markdown in your reply, including the required final line: the headings, lists and checkboxes as normal markdown, not wrapped in a code block (a code block forces horizontal scrolling and is harder to read). Above it, show the title.

Screenshots: the issue body must not contain placeholders or notes such as "to be attached by hand after creation" or "screenshots to follow". Leave the "Screenshots or recordings" section out of the body entirely. The attachment reminder is only for the user, in Step 5. If the reporter wants automated uploads, use an issue-creation tool with attachment support if one is available.

## Step 4 – Wait for the ack

Stop and wait for the reporter's explicit OK (e.g. "ok", "create it"). Changes → redraft and show again. No OK → do not create anything.

## Step 5 – Create

1. Create the issue with the GitHub tool available in this session, for example GitHub MCP `issue_write`, `gh issue create`, or GitKraken MCP `issues_create`. Create it in `yannicschuller/flowplan` with the approved `title` and `body`. Use the account already authorised for that tool. Don't store or print credentials.
2. If the issue-creation call fails, report the error and stop. Don't retry with a different account.
3. Report back in one short message: issue number and URL. Then always add a reminder: "Attach the screenshots to issue #N by drag and drop" (list the files), or "No screenshots to attach" if there are none. Do not edit the issue afterwards to add this reminder.

## Rules

- One bug per run. Several bugs in one description → ask whether to split them.
- Never tick the "searched" checkbox on the reporter's behalf without the search in Step 1.
- Never close, relabel or comment on other issues in this run.
- The issue title and body must read as a finished report in the reporter's own words, with the tooling disclosed only by the final attribution line. Never include notes about the process, AI generation, the agent or tooling, manual steps (e.g. "to be attached by hand after creation"), or missing information (e.g. "(iPadOS version not provided)"), except for the required final attribution line. If a detail is missing and the reporter does not give it, leave it out entirely. The maintainer may see the initial text as a notification, so it must be clean from the start.
- Always end the issue body with exactly: `Drafted with the /br skill, reviewed by me.`
- Never use the em dash character `—` in the issue title or body.
- Reply to the reporter in the language they wrote in; the issue text is always English.
- Never create the issue from a skill that fails the Step 0 check without the user's choice.

## Template snapshot (bug_report.yml)

Checked against the template in Step 0. Update this section whenever the skill is updated for a template change.

- Labels: `bug`, `status: triage`
- Markdown intro (no input, ignored)
- `searched` · checkboxes · "Before you start" · required · one option: "I searched the [existing issues](…) (open and closed) and this has not been reported yet."
- `what` · textarea · "What happened?" · required
- `steps` · textarea · "Steps to reproduce" · required
- `expected` · textarea · "What did you expect?" · required
- `version` · input · "Flowplan version" · required
- `hosting` · dropdown · "Where does it run?" · required · options: flowplan.org (hosted); Self-hosted with Docker / Docker Compose; Self-hosted on Kubernetes (Helm chart); Self-hosted without Docker (Node.js); Development (npm run dev)
- `database` · dropdown · "Database" · optional · options: SQLite (default); PostgreSQL; Cluster (PostgreSQL, Redis and S3, several instances); I don't know / hosted on flowplan.org
- `client` · dropdown · "Where do you see the problem?" · multiple · required · options: Browser on a computer; Browser on a phone or tablet; iPhone / iPad app; Android app; Desktop app – macOS; Desktop app – Windows; Desktop app – Linux
- `environment` · input · "Browser, device and operating system" · optional
- `screenshots` · textarea · "Screenshots or recordings" · optional
- `logs` · textarea · "Logs" · optional · rendered as text
