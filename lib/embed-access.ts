// What a linked database embedded in a document may change (issue #67).
//
// The records follow the rights on the data source, the view (filters,
// sorting, columns) the rights on the host page. A host page someone may
// edit but whose text is read-only right now – opened in reading mode – is a
// look-only page: then the embed is locked as well (no cell edits, no new or
// deleted records, no drag, no view changes). Reading mode is a preference
// on this device, not a permission; the server is not asked.
export type EmbedRole = "owner" | "editor" | "viewer" | string;
export function linkedDatabaseAccess(input: {
  // The document around the embed is editable right now.
  editorEditable: boolean;
  role: EmbedRole;
  locked: boolean;
  hostRole: EmbedRole;
  hostLocked: boolean;
}) {
  const hostWritable = input.hostRole !== "viewer" && !input.hostLocked;
  const reading = hostWritable && !input.editorEditable;
  return {
    reading,
    editable: !reading && input.role !== "viewer" && !input.locked,
    viewEditable: hostWritable && !reading,
  };
}
