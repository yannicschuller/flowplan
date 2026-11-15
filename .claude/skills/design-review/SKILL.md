---
name: design-review
description: Look at Flowplan's UI the way a user sees it – screenshots of one area (desktop and phone, light and dark) from the UI gallery or, for the marketplace, website and admin, from Playwright – and review them for layout and design problems. Small fixes are made right away; bigger redesigns are only proposed. Use when the user types /design-review or asks to "die Oberfläche durchsehen", "Verbesserungsvorschläge fürs Design", "schau, was nicht gut aussieht".
---

# /design-review – look at the screens, fix what doesn't fit

The maintainer is Yannic Schuller. Talk to him in **German**. Optional argument: a gallery group or text filter (`/design-review settings`, `/design-review dialogs`), a repo (`/design-review flowplan-marketplace`), or a page path (`/design-review flowplan-marketplace /me`).

Judge from **screenshots**, not from code: overflow, floating buttons, lines running across the whole screen and uneven spacing only show on the image.

## 1. Pick what to look at

- **One area per run.** All of the gallery at once is 200+ images – too many to look at carefully. With an argument, use it.
- **Without an argument (server):** rotate through the gallery groups in `scripts/gallery/types.ts` (`GROUPS`: Pages, Documents & editor, Databases, Whiteboard, Journal, Dialogs, Settings, Admin, Auth, Public, Errors, Mobile-only). Take the group reviewed least recently: `git log --grep "Design review:" --format="%ad %s" --date=short` in `/home/user/flowplan` – commits of this skill name the group as `Design review: <group> …`. A group never reviewed comes first. Say in one line which group and why.

## 2. Take the screenshots

**Server (`/home/user/flowplan`) – the UI gallery** (details: CONTRIBUTING.md, "UI gallery"):

```sh
export PATH=/opt/node22/bin:$PATH
npm run gallery -- --only "<group or text>" --out <scratch>/gallery-<group>
```

- It builds once (`npm run build`) if there is no build, seeds example content and writes `<out>/index.html` plus one PNG per scene and variant (desktop/phone × light/dark).
- `--url http://127.0.0.1:PORT` uses a running dev server instead (faster while fixing; sign-up must be open on it).
- A scene that fails shows a red tile with the error – that's a finding too (a broken scene or a broken screen).
- Look at every PNG of the area with the Read tool. Start with phone and dark: most problems show there.

**Marketplace, website, admin** (no gallery):

- Start the repo's dev server (`npx next dev --hostname 127.0.0.1 -p PORT`, the admin's `DEMO_PORT=4123 npm run -s demo`), with a scratch data directory.
- Pages behind sign-in: create a session directly (marketplace: `createUser` + `createSession` from `lib/auth.ts` via `node --import tsx` with `MARKETPLACE_DATA_DIR` set, cookie `mp_session`), never a real account or real credentials.
- Take full-page screenshots with Playwright (`executablePath: '/opt/pw-browsers/chromium'`; from a scratch script use `NODE_PATH=/home/user/flowplan/node_modules`) at 1440×1000 and 390×844, `colorScheme` light and dark, `locale` de-DE (and en-US for one variant to catch untranslated text). Seed enough content that lists aren't empty, and also look at the empty state.
- Pick the pages from the repo's `app/` routes; for a whole repo, start with the pages people see most.

## 3. Review – the checklist

For every screenshot, check and note what fails:

1. **Width and line length:** content running across the whole screen, text lines far beyond ~90 characters, cards much wider than their content.
2. **Alignment:** buttons floating away from what they belong to, edges that don't line up between sections, icons not centred on their line.
3. **Spacing:** uneven gaps between sections, cramped controls, large empty areas without reason.
4. **Overflow:** text cut off or overlapping, horizontal scrolling on the phone, elements outside the window, badges or counters off-centre.
5. **Consistency:** similar sections styled differently (one a card, the next bare text), buttons of different heights in one row, mixed icon sizes, differing corner radii.
6. **Hierarchy:** headings that don't stand out, a primary action that isn't recognisable, a destructive action as prominent as the main one.
7. **Empty and error states:** a bare grey line instead of an explanation with a way forward; error messages without what to do.
8. **Dark mode:** low contrast, light boxes on dark backgrounds, invisible borders, images or icons that disappear.
9. **Phone:** touch targets under ~40 px, toolbars covering content, things that only work with hover.
10. **Language:** German text in the English variant or the other way round, truncated translations, English and German mixed.

Don't report taste – only what a user would notice as broken, inconsistent or hard to use.

## 4. Report and fix

Write a short German list, most important first: screen (scene id or path, variant), problem, proposal. Then:

- **Small and clear** (spacing, alignment, width, an empty state, a missing translation, a dark-mode colour): fix it right away in the matching repo. Follow its rules (no inline styles – strict CSP; texts German + English via `t()`; French with "vous"). Take the screenshot again and look at it before/after. Run the repo's checks (`/ship` lists them).
- **Bigger** (a page laid out anew, a different navigation, new components): only propose it, with a short sketch of the new layout, and ask Yannic with `AskUserQuestion` before building. Never redesign a whole page unasked.
- **Visual tests:** a fix that changes screens covered by `tests/visual` needs new baselines – run `visual.yml` with `update=true` after pushing, then fast-forward `origin/visual-baselines` into main (as in `/issue`).
- Commit fixes with the subject `Design review: <group or page> – <what>` (that's what the rotation in step 1 looks for) and the trailers from CLAUDE.md, then ship them (`/ship`).

## 5. Report (German, short)

Area reviewed, the findings with what was fixed and what is only proposed, before/after for the fixes (one line each), checks and runs, open decisions for Yannic.

## Rules

- One area per run; say which area comes next time.
- Screenshots and gallery output go to the scratchpad, never into the repo (`gallery-out/` is git-ignored).
- Kill dev servers only by exact PID (never `pkill -f`), delete scratch data and build output afterwards, `git checkout next-env.d.ts tsconfig.json` after Next tooling.
- No real accounts, tokens or personal data in screenshots or seed content.
