// The editor's quote node with its typing shortcuts (#230): "> " at the start
// of a line makes a toggle (lib/toggle-commands.ts) or, as the person chose
// ("`>` erzeugt", lib/quote-shortcut-pref.ts), a quote as in Markdown; '" '
// (also „ “ ” as typed or as Typography turned " into) always makes a quote.
// Where no toggle can stand "> " makes a quote, where neither can (the
// first line of a list item) it stays text. Only typing: pasted and imported Markdown "> text" stays a quote, exports
// and stored documents do not change.
import Blockquote from "@tiptap/extension-blockquote";
import { InputRule, wrappingInputRule } from "@tiptap/core";
import { toggleFromMarker } from "./toggle-commands";
import { withTitleFocus } from "./toggle-view";
import { DEFAULT_QUOTE_SHORTCUT, type QuoteShortcutPref } from "./quote-shortcut-pref";

export const MARKER_RULE = /^\s*>\s$/;
export const QUOTE_MARK_RULE = /^\s*["„“”]\s$/;

export const ShortcutBlockquote = Blockquote.extend<{ HTMLAttributes: Record<string, unknown>; creates: () => QuoteShortcutPref }>({
  addOptions() {
    return { HTMLAttributes: {}, creates: () => DEFAULT_QUOTE_SHORTCUT };
  },
  addInputRules() {
    const quote = wrappingInputRule({ find: MARKER_RULE, type: this.type });
    const options = this.options;
    return [
      new InputRule({
        find: MARKER_RULE,
        handler: (props) => {
          if (options.creates() === "quote") return quote.handler(props);
          const { state, range } = props;
          const pos = toggleFromMarker(state.tr, range.from, range.to);
          // Where a toggle cannot stand: a quote, if one can.
          if (pos === null) return quote.handler(props);
          withTitleFocus(state.tr, pos);
        },
      }),
      wrappingInputRule({ find: QUOTE_MARK_RULE, type: this.type }),
    ];
  },
});
