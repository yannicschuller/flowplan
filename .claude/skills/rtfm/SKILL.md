---
name: rtfm
description: Answer a question about using Flowplan from the current public Flowplan documentation (docs.flowplan.org), with links to the pages it is based on. Prefers the docs MCP server for searching and reading pages, and falls back to docs.flowplan.org/llms.txt. Use when the user types /rtfm or asks how something works in Flowplan.
---

# /rtfm – Answer from the Flowplan documentation

Answer the user's question using only the current Flowplan documentation. Do not answer from memory of other tools (Notion, Obsidian, etc.) or from guesses about features.

## Sources

- **Docs MCP server (preferred):** `https://docs.flowplan.org/mcp` (Streamable HTTP, public, no sign-in). Use it to search the documentation and read relevant pages.
- **Fallback index:** `https://docs.flowplan.org/llms.txt`. It lists every page as Markdown (`https://docs.flowplan.org/en/<page>.md`; German under `https://docs.flowplan.org/de/<page>.md`).

## Step 1 – Check whether the MCP tools are available

1. Look for documentation search and page-reading actions available in this session.
2. If documentation search and page-reading actions are available, use them:
   - Search with the key terms of the question (try English and German terms if the first search finds little).
   - Read the most relevant one or two pages.
3. If they are not available, tell the user once, in one short sentence, that the Flowplan docs MCP server is not enabled in this session, and offer to help enable it: add `https://docs.flowplan.org/mcp` as a remote (Streamable HTTP) MCP server in the client's MCP settings, then restart or reload the session. Then continue with the fallback. Do not block on the answer.

## Step 2 – Fallback: read the index

1. Fetch `https://docs.flowplan.org/llms.txt`. It is longer than one page, so fetch additional sections as needed to read the whole list.
2. Pick the one or two pages whose title and description match the question.
3. Fetch those pages as Markdown (`https://docs.flowplan.org/en/<page>.md`). Use the German version only if the user asks in German and the German page exists, or if the user asks for it.

## Step 3 – Answer

- Answer in the language of the question. Keep it short and concrete: the steps, the menu path or the setting, and any limit or requirement the docs state.
- Cite every page you used as a Markdown link, for example [Pages and spaces](https://docs.flowplan.org/en/pages-and-spaces.md).
- If the docs do not cover the question, say so plainly. Name the closest page you checked. Do not invent a feature or a setting. If the answer depends on the version, say that the docs describe the current version.
- If the docs describe a feature but the user reports it not working, say what the docs expect and suggest checking the relevant settings. If it is a bug, offer `/br` to file a bug report.
- If the user asks for a feature that is not documented, offer `/fr` to file a feature request.

## Rules

- Read only the documentation at docs.flowplan.org. Do not read or change repository files for this skill.
- Do not write files. Do not store memories for this skill.
- Keep quotes from the docs short. Paraphrase the rest.
