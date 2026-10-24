# Ink engine

Handwriting, highlighter and text on a page surface. The PDF viewer
(`components/pdf-viewer.tsx`) is the first consumer; notebooks or a
handwriting block can reuse everything below without PDF code.

## Files

| File | What |
| --- | --- |
| `lib/ink/model.ts` | Types, limits, `parseInk` (strict, drops junk), `serializeInk`, `inkText` (search), `withPage` |
| `lib/ink/coords.ts` | Page units ↔ screen, ↔ device pixels (zoom, DPR), page as shown → PDF user space (rotation, crop box) |
| `lib/ink/geometry.ts` | Pressure outline, bounds, hit tests, stroke and partial eraser, lasso, move/resize/recolour/copy, shape snapping (uses `recognizeStroke` from `lib/whiteboard-tools.ts`), `heldStill` |
| `lib/ink/history.ts` | Undo/redo of whole states |
| `lib/ink/presets.ts` | Tools, colours, widths, 3 favourite pens, Pencil double-tap setting, snap setting (per device, `localStorage`) |
| `lib/ink/pdf-export.ts` | `flattenInk(pdfBytes, doc)` → new PDF with the ink as vectors (pdf-lib) |
| `lib/ink-store.ts` | Server: ink of PDF files (`file_ink`, `file_ink_versions`) |
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
