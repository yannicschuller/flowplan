// Stored documents with page links as link marks (before #466) get chips
// when they are opened (lib/page-chip.ts): on the server, in one locked
// transaction, as a change to the Yjs state that open editors merge – never
// by two editors at once, which would insert each chip twice. Only the form
// changes: the text, the addresses and the page's "changed" time stay.
// Encrypted documents (the server cannot read them) keep their links.
import { transaction } from "./db";
import { rewriteDocument } from "./document-rewrite";
import { chipsFromLinks, hasLinkMarkChips } from "./page-chip";

// Documents whose links stay links (formatting inside a link): not tried
// again until their HTML changes. Bounded; forgetting only costs a try.
const unchanged = new Map<string, string>();
const MAX_REMEMBERED = 500;

export async function upgradePageChips(pageId: string, rowId: string | null, html: string | null | undefined) {
  if (!hasLinkMarkChips(html)) return false;
  const key = `${pageId}:${rowId || ""}`;
  if (unchanged.get(key) === html) return false;
  try {
    const result = await transaction(() => rewriteDocument(pageId, rowId, "", chipsFromLinks, { touch: false }));
    if (!result) {
      if (unchanged.size >= MAX_REMEMBERED) unchanged.delete(unchanged.keys().next().value!);
      unchanged.set(key, html!);
      return false;
    }
    result.publish();
    return true;
  } catch {
    // The document opens as it is; its links keep working as links.
    return false;
  }
}
