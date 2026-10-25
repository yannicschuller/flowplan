# Ink engine

Handwriting, highlighter and text on a page surface. Consumers: the PDF
viewer (`components/pdf-viewer-dialog.tsx`), notebooks
(`components/notebook/notebook-view.tsx`, `lib/notebook.ts`) and the drawing
block of documents (`components/ink/draw-block*.tsx`,
`lib/draw-block-node.ts`).

## Files

| File | What |
| --- | --- |
| `lib/ink/model.ts` | Types, limits, `parseInk` (strict, drops junk), `serializeInk`, `inkText` (search), `withPage` |
| `lib/ink/coords.ts` | Page units ↔ screen, ↔ device pixels (zoom, DPR), page as shown → PDF user space (rotation, crop box) |
| `lib/ink/geometry.ts` | Pressure outline, bounds, hit tests, stroke and partial eraser, lasso, move/resize/recolour/copy, shape snapping (uses `recognizeStroke` from `lib/whiteboard-tools.ts`), `heldStill` |
| `lib/ink/history.ts` | Undo/redo of whole states |
| `lib/ink/presets.ts` | Tools, colours, widths, 3 favourite pens, Pencil double-tap setting, snap setting (per device, `localStorage`) |
| `lib/ink/pdf-export.ts` | `flattenInk(pdfBytes, doc)` → new PDF with the ink as vectors (pdf-lib); `drawInk` for any page |
| `lib/ink/notebook-pdf.ts` | `notebookPdf(sheets, load)`: a notebook as PDF (paper as vectors or the imported PDF page, ink on top) |
| `lib/ink/merge.ts` | `mergeInk(base, ours, theirs)`: three-way merge by item id (concurrent saves) |
| `lib/ink/svg.ts` | `inkSvg(items, size, { paper })`: ink as an SVG document (published pages, exports) |
| `lib/ink/recognition.ts` | Handwriting recognition in the iPhone/iPad app (contract below) |
| `lib/ink/recognized.ts` | Cleaning and capping recognised text |
| `lib/ink-store.ts` | Server: ink of PDF files (`file_ink`, `file_ink_versions`, `recognized`) |
| `lib/page-ink-store.ts` | Server: ink of a page's surfaces – notebook sheets, drawing blocks (`page_ink`, `page_ink_versions`) |
| `lib/ink-export.ts` | Server: pictures of drawing blocks and sheets for published pages and exports |
| `components/ink/use-surface-sync.ts` | Saving surfaces while drawing, merging, following others, recognition for search |
| `components/ink/convert.ts` | "Convert to text" of a lasso selection |
| `components/ink/use-ink-editor.ts` | `useInkEditor(initial)`: the editing session; `useInkShortcuts(editor, on)` |
| `components/ink/ink-layer.tsx` | `<InkLayer>`: renders and takes input for one page |
| `components/ink/ink-toolbar.tsx` | `<InkToolbar editor>`: tools, favourites, colours, widths, eraser kind, undo/redo, paste, pen settings; children go at the end |

## Storage format (version 1)

```json
{
  "format": "flowplan-ink",
  "version": 1,
  "unit": "pt",
  "pages": {
    "1": [
      { "id": "k3x9a01ab", "type": "highlighter", "color": "#ffd43b", "width": 14, "points": [72, 80, 0.5, 200, 80, 0.5] },
      { "id": "k3x9a02cd", "type": "pen", "color": "#1f1f1f", "width": 1.6, "points": [100, 100, 0.31, 101.5, 100.8, 0.42] },
      { "id": "k3x9a03ef", "type": "text", "color": "#e03131", "size": 14, "x": 72, "y": 300, "text": "Geprüft" }
    ]
  }
}
```

- Coordinates are **page units**: for PDFs PDF points (1/72 in) of the page
  *as shown* by pdf.js at scale 1 (rotation and crop box applied), origin top
  left, y down. Independent of zoom and device pixel ratio.
- `points` is flat `x, y, pressure` (pressure 0–1, 0.5 = no pressure
  sensor), two decimals. A pen whose pressures differ is drawn as a filled
  outline (`strokeOutline`), otherwise as a line of `penWidth(width, p)` with
  round caps and joins. Highlighters are lines of `width`, opacity 0.4,
  multiplied with the page, always behind the ink.
- Text: `(x, y)` is the top left, baseline at `y + 0.8·size`, lines
  `1.25·size` apart, Helvetica.
- Items are back to front. Page keys: PDF page numbers (`"1"`, `"2"`, …);
  other surfaces may use any key matching `[\w.-]{1,64}` (e.g. a notebook
  page id).
- Unknown item types and fields are dropped by `parseInk`; bump
  `INK_VERSION` and keep `parseInk` reading older versions when the format
  changes.
- Limits (`INK_LIMITS`): 4000 items per page, 6000 points per stroke, 1000
  characters per text, 6 MB per document.

## Server API (PDF files)

- `GET /api/files/{id}/ink` → `{ doc, version, canEdit, updatedAt, updatedBy }`
  (readers of the page; `canEdit` for editors of an unlocked page outside
  encrypted spaces).
- `GET /api/files/{id}/ink?versions=1` → `{ versions: [{ version, by, at, items }] }`
- `GET /api/files/{id}/ink?version=N` → `{ version, doc }`
- `PUT` or `POST /api/files/{id}/ink` with `{ base, doc }` → `{ version, conflict }`.
  Last write wins; `conflict` (`{ by, at, version }`) says someone saved after
  `base`. Every save is kept as a version (the last 50 per file).
- `GET /api/share/{token}/files/{fileId}/ink` → read-only, for share links
  and publications.
- Typed text goes into the search index with the file.

## Server API (page surfaces)

Notebook sheets (surface = sheet id) and drawing blocks (surface = block id)
of a page; same permissions as the page (not in encrypted spaces, not on
locked pages). The stored document has one page key: the surface.

- `GET /api/pages/{id}/ink` → `{ versions: { surface: version } }`
- `GET /api/pages/{id}/ink?surface=S[&from=P/S2]` → `{ doc, version, canEdit, updatedAt, updatedBy, recognized, copied? }`
  (`from`: a pasted drawing block without ink of its own starts with that one's)
- `GET …?surface=S&versions=1`, `GET …?surface=S&version=N` as for files
- `PUT` or `POST …?surface=S` with `{ base, doc, recognized? }` → `{ version, conflict, doc? }`.
  A save on an older `base` is merged three-way with what was saved in
  between (`lib/ink/merge.ts`); `doc` is then the merged ink.
- `PUT` or `POST …?surface=S` with `{ version, recognized }` stores text
  recognised for that version (dropped when the ink changed since).
  `/api/files/{id}/ink` takes `{ version, recognized: { page: text } }` the same way.
- `GET /api/share/{token}/ink?page=P&block=B&height=H&paper=X` → `{ svg, text }` (read-only).

Notebook structure (sheets, order, paper, PDF import) goes through the
command API: `notebook.sheet.add`, `.duplicate`, `.delete`, `.move`,
`.paper`, `notebook.paper`, `notebook.import` (`lib/notebook.ts`).

## Handwriting recognition (iPhone/iPad app)

Feature-detected: only when `window.FlowplanApp.recognizeInk` exists.

```ts
window.FlowplanApp.recognizeInk({
  id: string,                                   // e.g. "search-…" or "convert-…"
  width: number, height: number,                // the sheet, block or PDF page in pt
  strokes: [{ points: [[x, y], …] }, …],        // pen strokes only (no highlighter, no text), pt, top left
});
// the app answers:
window.dispatchEvent(new CustomEvent("flowplan:ink-recognized", {
  detail: { id, text: string, lines: [{ text: string, box: [x, y, w, h] }] },   // boxes in the same pt
}));
```

After a save (a moment later) the saved surface is recognised and its text
stored (`recognized`, at most 4000 characters per surface, 20000 per PDF;
control and direction characters removed) and searched like typed text. A
lasso selection with pen strokes offers **Convert to text**: the text
replaces the strokes as a text item (notebooks, PDFs) or becomes paragraphs
below the block (drawing blocks); one undo step of the ink.

## Components

```tsx
const editor = useInkEditor(emptyInk(), { active: editing }); // Pencil double-tap while active
useInkShortcuts(editor, editing); // ⌘Z, ⇧⌘Z, Delete, ⌘C/⌘V/⌘D, Escape
editor.reset(parseInk(loaded)); // after loading (clears undo)

<InkToolbar editor={editor}>{/* save, done … */}</InkToolbar>

// Inside a position: relative box exactly the size of the page surface:
<div style={{ position: "relative", width }}>
  <canvas … />  {/* or paper, an image … */}
  <InkLayer page="1" size={{ width: 612, height: 792 }} editor={editor} editing={editing} onPan={…} onZoom={…} />
</div>

// Read-only, without an editor:
<InkLayer page="1" size={size} doc={inkDoc} />
```

- `editor.doc` is the current `InkDoc`; `editor.dirty` compares with the last
  `editor.markSaved(doc)`; `editor.change(page, items => items)` is one undo
  step; `editor.commit(doc)` replaces all pages as one step.
- The layer is SVG in page units: no redraw for a new zoom. It needs a
  positioned parent without `z-index`/`opacity` (the highlighter layer
  multiplies with what is below).
- Input follows `lib/stylus.ts`: pen-only drawing (fingers scroll natively
  via `touch-action: pan-x pan-y pinch-zoom`; the pen's touches are
  cancelled so it never scrolls), palm rejection, coalesced points,
  pressure smoothing, eraser end of the pen, Scribble into the text field.
  With pen-only off, one finger draws and two fingers call `onPan` /
  `onZoom`.
- Holding the pen still for ~0.5 s at the end of a stroke snaps it to a
  line, rectangle, ellipse, triangle or diamond (setting in the toolbar).
