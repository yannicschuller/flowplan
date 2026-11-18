---
name: announce
description: Write a lively Discord announcement for a Flowplan release – server (vX.Y.Z), iPhone/Android app or desktop app – from the curated release notes, the changelog and the commits, in English and German, ready to paste into #announcements or #releases. Only writes the text; never posts. Use when the user types /announce (e.g. "/announce 0.9.9", "/announce app 1.0.16", "/announce desktop 1.3.10") or asks for "Changelog-Text für Discord", "Ankündigung für die neue Version".
---

# /announce – a Discord announcement for a release

The maintainer is Yannic Schuller. Talk to him in **German**. The announcement itself is written in **English** (the community server's language) plus a **German** version for #deutsch, unless he asks for only one. This skill only **writes** text – it never posts to Discord, GitHub or anywhere else.

## 1. Which release

Argument forms:
- `0.9.9` / `v0.9.9` / nothing → **server** (`/home/user/flowplan`). Nothing given: the newest `vX.Y.Z` tag (`git fetch -q origin --tags`, `git tag --sort=-v:refname | head -1`). `beta` → what is on `main` since the newest tag (say clearly it's a beta preview).
- `app 1.0.16` → **flowplan-app**; `desktop 1.3.10` → **flowplan-desktop**.
- A range like `0.9.7..0.9.9` → one announcement covering both releases.

Pull the repo first (`git fetch -q origin --tags`). If the version has no tag yet, say so and ask whether to announce the upcoming release from `main`.

## 2. Sources, in this order (never invent features)

| Product | Curated notes (main source) | Extra context |
|---|---|---|
| Server | `release-notes/<version>.json` (`security`, `features`, `improvements`, `fixes` … with `de`/`en` and `issues`) and the version's section in `CHANGELOG.md` | `git log v<prev>..v<version> --no-merges --format='%s%n%b'`, the GitHub release (`mcp__github__get_release_by_tag`), docs pages marked `{since=<version>}` in `/home/user/flowplan-docs/content/docs/en/` |
| App | `store/app-store/{en-US,de-DE}/release_notes.txt` | `git log v<prev>..v<version>`, the GitHub release (APK link) |
| Desktop | `release-notes/<version>.json` | `git log`, the GitHub release |

Rules:
- Only what is in these sources. A commit you don't understand stays out rather than being guessed.
- Issue numbers come from the notes (`issues`); link them as `<https://github.com/yannicschuller/flowplan/issues/N>` only where it adds something (usually leave them out in the short version).
- Credit people: reporters of the linked issues (`mcp__github__issue_read` → `user.login`) get a thank-you line by GitHub name – never Discord @mentions (you don't know their Discord names), never e-mail addresses.
- Security fixes: say *that* something was fixed and that updating is recommended, without exploit details.

## 3. Pick the highlights

Read everything, then choose **3–5 highlights**: what most people will notice or have asked for (new capabilities > visible improvements > fixes). Group the rest into short bullets. Translate developer wording into what a user sees ("PATCH /rows batch endpoint" → "Change many records at once through the API").

## 4. Write it

Discord Markdown: `#`/`##` headings, `**bold**`, `-` bullets, `> ` quotes, emoji sparingly as section markers. Links in `<…>` so Discord doesn't unfurl previews (except one main link that should preview, if Yannic wants it). Keep each message **under 2,000 characters** (Discord's limit); if it's longer, split into numbered parts (`1/2`, `2/2`) at a section boundary and say so.

Tone: warm, energetic, concrete – like a maintainer who is happy to ship, not marketing fluff. No superlatives without substance, no "revolutionary", no exclamation-mark storms (one or two are fine). Use "you". German version with "du", natural German, not a word-for-word translation; French/Chinese only on request.

Template (adapt freely):

```
# 🚀 Flowplan 0.9.9 is out!

<one or two sentences: the theme of this release>

## ✨ Highlights
- **<Feature>** – <what you can do now, one line>
- …

## 🛠️ Also new & improved
- …

## 🐛 Fixed
- …

## 🔒 Security
- <only if present; "update recommended">

**Update:** `docker compose pull && docker compose up -d` · full notes: <https://github.com/yannicschuller/flowplan/releases/tag/v0.9.9>
📖 Docs: <https://docs.flowplan.org/en/…>  (the one or two most relevant pages)

Thanks to <GitHub names of reporters> for the ideas and bug reports 💜
```

Product-specific endings:
- **Server:** the Docker update line; mention the `:beta` image only for beta previews.
- **App:** "iPhone/iPad: App Store (rolling out after Apple's review) · Android: APK on <https://flowplan.org/download> or the in-app update". Never mention Google Play.
- **Desktop:** "The app updates itself; or download from <https://flowplan.org/download>".

Optional extras on request: a one-line teaser for #general, a short version (≤ 500 characters), a German-only version, or the role ping line `@Release Ping` at the top (Yannic adds the actual ping himself).

## 5. Deliver

1. Show the English text, then the German text, each in its own code block (so Yannic can copy it with formatting intact), with the character count under each.
2. Below, in German, list in 2–4 lines which highlights you chose and why, and anything you left out or weren't sure about.
3. Also save both versions to the scratchpad (`announce-<product>-<version>.md`) and give the full path.
4. Offer: shorter version, different highlights, other tone. Don't post anything.
