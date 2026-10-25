// A PDF chosen with "New notebook from PDF" in the new-page dialog: the
// notebook view imports it once the new page opens. Kept apart from the
// view so the dialog does not load the notebook code.
const pending = new Map<string, File>();
export const queueNotebookImport = (pageId: string, file: File) => void pending.set(pageId, file);
export function takeNotebookImport(pageId: string) {
  const file = pending.get(pageId);
  pending.delete(pageId);
  return file;
}
