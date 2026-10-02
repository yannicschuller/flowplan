# Collaboration and comments

Several people write on the same page at the same time without overwriting each other. Comments, mentions and the inbox keep conversations next to the content.

## Edit at the same time

- Documents and record contents are merged with Yjs (CRDT): every change is kept, even when two people type in the same paragraph.
- Changes reach the others within a fraction of a second: the server pushes every saved change right away to everyone who has the same document open (server-sent events). Only what changed is sent, not the whole document.
- **Coloured cursors and selections** with names show where others are writing; their movements arrive immediately too.
- Without a connection you keep working; changes are merged as soon as the network is back.
- Database changes are checked for version conflicts: if someone changed the same record in the meantime, your change is not silently written over it but refused, and you see the new state.
- Guests with an edit link also work live and see the members' cursors; members see the guests as "Guest · <link name>".
- Whiteboards also have [live cursors](/docs/whiteboards#work-together) as in Miro.

## Suggest changes

The pen button **Suggest** in the toolbar turns on suggestion mode. Typing then does not change the text directly:

- **Inserted text** appears underlined in green, **deleted text** stays in place, struck through in red. Typing over a selection creates both.
- Deleting your own suggestion removes it completely.
- Above the text, a bar shows the number of open suggestions. Expanded, it lists each one with person and text; a click jumps to the spot. **✓** accepts a suggestion (the insertion stays, the deleted text disappears), **✗** rejects it. **Accept all** and **Reject all** settle everything at once.
- Suggestions are part of the document: they appear for everyone right away and stay saved until someone accepts or rejects them. Everyone who may edit the page can accept and reject.
- Formatting, paragraph breaks and moved blocks are applied directly even in suggestion mode; other people's changes never become your suggestions.

## Reactions

- **Comments**: below every page and record comment, the smiley adds a reaction (👍 ❤️ 🎉 😄 👀 ✅ 🙏 🔥). A click on an existing reaction joins it or takes your own back; the tooltip shows who reacted. Everyone who may see the page can react.
- **Paragraphs and headings**: selecting text or right-clicking in the text opens the text menu. At the top are the reactions for the paragraph, below them formatting (bold, italic, underline, strikethrough, highlight, code, link), **Comment** and **Copy**, in tasks also **Due date**. The reactions sit as small pills on the block, are saved in the document and appear for everyone right away; a click on your own takes it back. This works for everyone who may edit the page. <kbd>Shift</kbd> + right-click brings up the browser's menu.
- Text comments have their own reactions in the thread.

## Follow pages

The bell at the top of a page turns **Follow** on or off. Whoever follows a page gets a notification as soon as someone else changes it – one per page, until you have looked at it again. With e-mail set up, it lands in the e-mail digest. Whoever creates a page follows it automatically. Under **Settings → Notifications**, the kind "Changes to pages you follow" can be switched off for inbox, push and e-mail separately.

## Who has seen the page?

The eye next to the bell shows who opened the page and when. A tick means the person has seen the latest state; "older" means the page has changed since. Only people who may still see the page are shown.

## Changes since your last visit

If someone else changed a page since you last opened it, a notice with their names appears at the top. For documents, **Show changes** shows the text changes since your last visit (inserted and deleted, as in the version history). For databases the notice gives the number of edited records.

On the home screen, **Recently viewed** lists the pages you opened last.

## Page comments

The speech bubble icon in the header opens the page's comments. Comments can be formatted (lists, links, quotes, code) and mention people with `@`. <kbd>⌘</kbd> <kbd>Enter</kbd> sends.

## Text comments

Select text and choose **Comment on text** or press <kbd>⌘</kbd> <kbd>⌥</kbd> <kbd>M</kbd>.

- The commented text is highlighted; a click on it opens the thread.
- Replies, emoji reactions, **Resolve** and **Reopen**.
- Your own posts can be edited and deleted.
- If the text is deleted later, the quote stays in the thread.
- Drafts stay saved until you send or discard them.

Text comments exist in documents and in the contents of database records, also in exports and content archives.

## Mentions

- `@Name` in text or a comment notifies the person. The person search only shows members who may read the page.

## Inbox

The **Inbox** in the sidebar collects mentions, comments and replies, date reminders as well as comments and records from guests. Unread items are marked; a click jumps to the spot – for text comments straight into the thread. You choose which events arrive as push notifications under **Settings → Notifications** (see [Search, inbox and push](/docs/suche-und-benachrichtigungen)).
