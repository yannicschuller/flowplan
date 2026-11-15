---
name: fr
description: Turn a brief (plus optional screenshots or logs) into a Flowplan feature request that follows .github/ISSUE_TEMPLATE/feature_request.yml, show the draft, wait for the submitter's OK, then create the issue in yannicschuller/flowplan with submitter GitHub credentials. Use when the user types /fr or asks to file a feature request or change request.
---

# /fr – Feature request for Flowplan

Create one feature request in `yannicschuller/flowplan`. Never create it before the submitter approves the draft.

## Input

- The brief (free text), optional screenshots and logs. Optional argument: a title hint.
- Template: [feature_request.yml](../../../.github/ISSUE_TEMPLATE/feature_request.yml). Its field labels and order are the source of truth. Step 0 checks that this skill still matches it.

## Step 0 – Check the template is still current

The snapshot at the end of this file is the template this skill was written for. Before anything else:

1. Fetch the template from the default branch: `git fetch origin main`, then `git show origin/main:.github/ISSUE_TEMPLATE/feature_request.yml`. If offline, use the local file and say so.
2. Compare it with the snapshot: field order, `id`s, `label`s, `required` and `multiple` flags, the checkbox text, the labels, and every dropdown option text, exactly. Ignore wording changes in the intro markdown.
3. Identical → continue with Step 1 without comment.
4. Different → stop before Step 1. Tell the user what changed (added, removed, renamed or reordered fields, changed options or required flags) and propose a skill update with `ask_user`:
   - **Update the skill now** (recommended): update the snapshot and every step that depends on it (Step 2 mandatory fields, Step 3 headings and dropdown values, Rules), show the diff of `SKILL.md`, and continue once the user confirms it.
   - **Use the new template for this run only**: draft from the new template and leave the skill unchanged. Mention that the skill is still outdated.
   - **Cancel**.

   Create nothing until the user has chosen.

## Step 1 – Read and check

1. Read the brief and every attachment. Describe what each screenshot shows in one line; don't guess at unreadable parts.
2. **Check the documentation first**, before searching issues or drafting. Use the procedure of [/rtfm](../rtfm/SKILL.md): `search_docs` with the brief's key terms (English and German) and `get_page` for the best one or two results via the docs MCP server; if the tools are not available, fall back to `https://docs.flowplan.org/llms.txt` and the Markdown pages. Then:
   - If the docs already describe the requested feature, tell the user which pages cover it (as links) and ask whether they still want a request. Draft nothing until they confirm.
   - If the docs cover only part of it, name what exists and what is missing, and keep the request focused on the missing part.
   - If the docs do not mention it, say so in one line and continue.
3. Logs: remove secrets, tokens, passwords, emails, IPs and personal data before quoting them. Show the redacted version.
4. Search for duplicates in `yannicschuller/flowplan` (open and closed issues) with the brief's key terms. Report the closest matches. If one clearly covers the request, stop and tell the user.
5. Make sure the generated markdown descriptions do not include garbage characters like `[span_2](start_span)"[span_2](end_span)` or other things typically found in AI generated content (emoticons, extra quotes, etc.).
6. The issue title and body must never contain the em dash character `—` (U+2014). Rewrite every sentence with plain punctuation (`-`, `,`, `:` or `;`) so the text reads like a normal user wrote it.

## Step 2 – Ask for missing mandatory input

Ask only for what you cannot deduce. Mandatory:
- **Question order exception:** the template's field order governs the draft in Step 3 only. In every question, including the ask_user form, list the "How do you use Flowplan?" options in this order: `Self-hosted`, `flowplan.org (hosted)`, `Not yet – evaluating`. Do not copy the template's dropdown order (flowplan.org first) into the question.
- **What would you like to do?** The problem or use case (the form requires it).
- **Area** (one or more of the template's dropdown options).
- **How do you use Flowplan?** Offer self-hosted first, then flowplan.org (hosted), then not yet / evaluating. Use the exact option text of the template's dropdown.
- Confirmation that you searched for existing issues (the form's required checkbox). Step 1 already does this; tell the user the result.

Optional, ask only if relevant: your idea, alternatives or workarounds, extra context, and device details if the request concerns a specific platform (e.g. the device model and OS version such as iPadOS, Android or macOS version).

Ask all questions in one batch. Every answer the submitter does not give is left out of the issue completely (see Rules). Never ask the submitter about the agent or the tooling.

## Step 3 – Draft

Dropdown values (e.g. `### How do you use Flowplan?`) are submitted as the template's option text, exactly as written in `feature_request.yml`, for example `Self-hosted`. Never submit the position in the question list, a number, or a reworded label. The order in which options are offered in Step 2 does not change the template's options or their numbering.

Write the draft in English, using the template's headings in this order, so it reads like the form:

1. `### Before you start` – one checkbox line: `- [x] I searched the existing issues (open and closed) and the documentation, and this does not exist yet.`
2. `### What would you like to do?`
3. `### Your idea`
4. `### Alternatives and workarounds`
5. `### Area`
6. `### How do you use Flowplan?`
7. `### Anything else?`

Omit optional sections the user left empty, but keep the required ones. Keep the problem first. Do not invent facts, numbers or quotes.

Before showing the draft, scan the title and body and remove anything that reveals who wrote it or what is missing. Remove any note or parenthetical such as "not provided", "not specified", "unknown", "to be confirmed", "n/a", "(assumed)", or a reference to the agent, AI, Claude, Copilot, a skill, or a tool. Also replace every em dash (`—`) with plain punctuation. If a required field has no answer from the submitter, go back to Step 2 and ask, do not write a placeholder.

Show the draft as rendered markdown in your reply: the headings, lists and checkboxes as normal markdown, not wrapped in a code block (a code block forces horizontal scrolling and is harder to read). Above it, show the title and the labels that will be applied: `enhancement` and `status: triage`. These are set explicitly, since creating through the API doesn't apply the template's labels.

Screenshots: the available tool (GitKraken `issues_create`) can't upload images. The issue body must not mention this: no placeholders or notes such as "to be attached by hand after creation" or "screenshots to follow". Leave the "Screenshots or recordings" section out of the body entirely. The attachment reminder is only for the user, in Step 5. If the user wants automated uploads, a tool with attachment support must be enabled first.

## Step 4 – Wait for the ack

Stop and wait for the user's explicit OK (e.g. "ok", "create it"). Changes → redraft and show again. No OK → do not create anything.

## Step 5 – Create

1. Create the issue with GitKraken MCP `issues_create`: `provider` `github`, `repository_organization` `yannicschuller`, `repository_name` `flowplan`, approved `title`, `body` and `labels` (`enhancement`, `status: triage`). Labels must be set through this GitKraken call (do not rely on template defaults). Use the account the user has authorised in GitKraken. Don't store or print credentials.
2. Verify the created issue labels with GitKraken MCP `issues_get_detail`. If either required label is missing, report it and stop; do not continue as if submission was complete.
3. If a tool call fails, report the error and stop. Don't retry with a different account.
4. Report back in one short message: issue number and URL. Then always add a reminder: "Attach the screenshots to issue #N by drag and drop" (list the files), or "No screenshots to attach" if there are none. Do not edit the issue afterwards to add this reminder.

## Rules

- One feature request per run. Several ideas → ask whether to split them.
- Never tick the "searched" checkbox on the user's behalf without the search in Step 1.
- Never close, relabel or comment on other issues in this run.
- The issue title and body must read as a finished request, written by the submitter. Never include notes about the process, AI generation, the agent or tooling, manual steps (e.g. "to be attached by hand after creation"), or missing information (e.g. "(model and iPadOS version not provided)"). If a detail is missing and the submitter does not give it, leave it out entirely. The maintainer may see the initial text as a notification, so it must be clean from the start.
- Never use the em dash character `—` in the issue title or body.
- Reply to the user in the language they wrote in; the issue text is always English.
- Never create the issue from a skill that fails the Step 0 check without the user's choice.

## Template snapshot (feature_request.yml)

Checked against the template in Step 0. Update this section whenever the skill is updated for a template change.

- Labels: `enhancement`, `status: triage`
- Markdown intro (no input, ignored)
- `searched` · checkboxes · "Before you start" · required · one option: "I searched the [existing issues](…) (open and closed) and the [documentation](…), and this does not exist yet."
- `problem` · textarea · "What would you like to do?" · required
- `solution` · textarea · "Your idea" · optional
- `alternatives` · textarea · "Alternatives and workarounds" · optional
- `area` · dropdown · "Area" · multiple · options: Documents and editor; Databases and views; Whiteboards; Journal; Projects and sprints; Forms and surveys; Workflows; AI; Search and notifications; Import and export; Apps (mobile, desktop, offline); Sign-in, permissions and security; Self-hosting and administration; Something else
- `hosting` · dropdown · "How do you use Flowplan?" · single · options: flowplan.org (hosted); Self-hosted; Not yet – evaluating
- `context` · textarea · "Anything else?" · optional
