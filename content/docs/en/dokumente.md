# Documents and the editor

The editor works with blocks: every paragraph, list, table or embed is a block you can insert, format, indent and move. Everything is saved continuously, even without a connection.

## The block menu with /

At the start of a line or after a space, `/` opens the block menu right at the cursor. Keep typing to filter: `/h2`, `/todo`, `/code`, `/tab`. Arrow keys choose, <kbd>Enter</kbd> or <kbd>Tab</kbd> inserts, <kbd>Esc</kbd> closes.

> [!TIP]
> To type a plain slash, type a space after `/` or close the menu with <kbd>Esc</kbd>. In code blocks `/` is always an ordinary character.

| Block | Shortcut in the menu | What for |
| --- | --- | --- |
| Text | `/text` | A normal paragraph |
| Heading 1–3 | `/h1`, `/h2`, `/h3` | Structure; they appear in the table of contents |
| Task list | `/todo` | Tasks to tick off |
| Bulleted list, numbered list | `/ul`, `/ol` | Lists, nested as deep as you like |
| Quote | `/quote` | A highlighted quotation |
| Callout | `/callout` | A coloured box with an icon |
| Toggle | `/toggle` | Content that folds in and out |
| Code | `/code` | Syntax highlighting for 192 languages |
| Table | `/table` | A simple table in the text |
| Image or file | `/image`, `/file` | Upload or pick from the media library |
| Mermaid diagram | `/mermaid` | Flowcharts, sequence and class diagrams as text |
| Formula, inline formula | `/math`, `/inlinemath` | LaTeX, rendered with KaTeX |
| Mention a page or person | `/mention` or `@` | A reference to a page or person |
| Whiteboard | `/board` | Embed a whiteboard in the document |
| Linked database | `/db` | A view of an existing database |
| Two columns | `/columns` | Content side by side |
| Embed | `/embed` | Players for YouTube, Vimeo, Loom, Spotify, Figma, CodePen; a link card otherwise |
| Spoiler | `/spoiler` | Hidden text, revealed by a click |
| Voice note | `/voice` | Record and insert as audio, optionally also as text |
| Synced block | `/sync` | Content that stays the same on several pages |
| Insert synced block | `/sync` | Show an existing synced block |
| Divider | `/hr` | A horizontal line |

## Voice notes

`/voice` opens the recorder: tap the microphone, speak, **Stop recording** (at most ten minutes). You can listen to the recording or discard it; **Insert** puts it into the page as audio. If speech recognition is set up, the spoken words follow below as text; otherwise the dialog only offers the audio.

## Focus mode

**Focus mode** (quick search → `> focus`) hides the sidebar, toolbar and page margins; the top bar only appears on hover. At the bottom, a bar counts the words of the page and those added in this session. With a **goal** (e.g. 500 words) a bar shows the progress; the device remembers the goal per page. <kbd>Esc</kbd> ends the mode.

## Synced blocks

A synced block (`/sync` → **Synced block**) is content that is the same in several places – such as contact details, a checklist or a status notice. **Insert synced block** shows it on another page. You can edit it everywhere; the change appears on all pages, live on pages that are open.

- An orange frame marks the block; at the top it shows the number of pages and the page it was created on.
- The trash icon in the frame removes the block only in this place; it stays in the others.
- Permissions come from the page the block was created on: whoever may not read that page sees a notice instead of the content.
- The search finds the text on the original page. The block does not appear on published pages.

## Tasks with assignee and date

A task (`/todo` or `[]` + space) with a mention such as `@Anna` is assigned to Anna: she gets a notification and finds the task under **My tasks** in the sidebar. You set a date while the cursor is in the task, with the calendar button in the toolbar or through the text menu (select text or right-click → **Due date**). The date appears as a chip at the right of the line (highlighted today, red when overdue); a click on it changes the date or removes it with **Remove date**. A new task made with <kbd>Enter</kbd> starts without a date.

**My tasks** collects all tasks given to you, your own tasks with a date and all tasks from your journals (even without @name and without a date) – grouped into Overdue, Today, Next 7 days, Later and No date. Below, **From other workspaces** lists your tasks from your other workspaces, per workspace; clicking the page switches there. Ticking off and changing the date take effect right in the document, also for others who have it open. On the due date a reminder arrives in the morning; the number next to "My tasks" shows how many are due today or overdue.

## Markdown shortcuts

While you type, the editor converts:

| Type | Result |
| --- | --- |
| `#`, `##`, `###` + space | Heading 1–3 |
| `-` or `*` + space | Bulleted list |
| `1.` + space | Numbered list |
| `[]` + space | Task |
| `>` + space | Quote |
| ` ``` ` | Code block |
| `---` | Divider |
| `**bold**`, `*italic*`, `` `code` ``, `~~strike~~` | Formatting in the text |

## Format text

Selecting text – or right-clicking it – opens the text menu: reactions for the paragraph, **bold**, *italic*, underline, strikethrough, highlight, code, link, **Comment** and **Copy**, in tasks also **Due date**. The toolbar above the text adds headings, colour and background colour, superscript and subscript, inline formulas and **Hide (spoiler)**.

- Formatting only applies to the current line. After <kbd>Enter</kbd> the new line starts as normal text – only lists and tasks continue with a new item, and a heading is followed by a paragraph.

### Spoiler

Hidden text stays hidden while you write. A click on the area reveals it, another one hides it again. <kbd>⌘</kbd> <kbd>⌥</kbd> <kbd>H</kbd> hides the selection. Sticky notes and text on whiteboards can be hidden too.

## Indent

- <kbd>Tab</kbd> at the start of a paragraph or heading indents it (up to eight levels), <kbd>⇧</kbd> <kbd>Tab</kbd> outdents it.
- <kbd>Backspace</kbd> at the start of an indented line first removes one level.
- In lists <kbd>Tab</kbd> nests the item below the previous one; in code blocks it inserts two spaces.

## Move blocks

A handle (`⋮⋮`) appears to the left of every block on hover. Dragging shows an insertion line in the middle of the gap between two blocks; when you let go, the block glides to its new place. A click on the handle opens **Manage blocks**: move – also into callouts or columns –, duplicate or delete, one block or several neighbouring ones.

List items and tasks stay what they are when moved: outside their list they form a list of the same kind of their own, and a numbered item keeps its number. Right next to a matching list they become part of it; in another kind of list they adapt.

<kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>↑</kbd>/<kbd>↓</kbd> moves the current block past its neighbour. Every block action can be undone on its own.

## Images, files and embeds

- **Pasting from the clipboard** (<kbd>⌘</kbd> <kbd>V</kbd>) or dragging in uploads images and files. Images can be resized at their edges.
- **Photos are scaled down before uploading**: at most 2560 px on the longer side, stored as WebP. The camera rotation is kept, metadata such as the location is removed. GIFs, SVGs and files that would hardly get smaller stay unchanged. Attachments in file properties and forms are stored as they are.
- **Media** in the sidebar collects all uploads of the workspace for reuse.
- **Embed** (`/embed`) takes an address: YouTube, Vimeo, Loom, Spotify, Figma and CodePen appear as players with an adjustable width, other sites as a link card with title and preview image.
- Links to pages and mentions of people show a preview on hover.
- The administrators set the maximum file size (10 MB by default).

## Formulas, diagrams and code

- **Formulas** in LaTeX: as a block with `/math`, inside the text with `/inlinemath`. The preview appears while you type.
- **Mermaid diagrams**: a click or <kbd>Enter</kbd> opens the source and preview. Up to 20,000 characters and 500 edges.
- **Code blocks**: choose the language in the header; **Wrap lines** and **Copy** are at hand. <kbd>Tab</kbd> indents by two spaces.

## Page links and mentions

`@` searches pages and people. Mentioning a person notifies them in the inbox. Links to pages stay valid even if the page is renamed or moved; the target page lists them under **Linked from**.

## More blocks

- **Table of contents**: lists the headings of the page and jumps there on click.
- **Two columns**: blocks side by side; stacked on a phone.
- **Linked database**: a view of an existing database with its own filters and sorting; changes to records go to the source. See [Views](/docs/ansichten#linked-databases).
- **Whiteboard**: a whiteboard right in the document; the button at the top right opens it large.
