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
| `lib/ink/geometry.ts` | Pressure outline, bounds, hit tests, stroke and partial eraser (a shape cut by it becomes freehand), lasso, move/resize/recolour/copy, shape snapping (`snapShape`, `withShape`, `toFreehand`, `pageAnchors`), `heldStill` |
| `lib/ink/shapes.ts` | Shapes (`InkShape`): checking (`cleanShape`), outline and parts (fill, dashes, arrow heads), moving/scaling/rotating (`affineShape` for the lasso's transform), handles and dragging them, snapping (15° angles, squares/circles within 8 %, magnet to other shapes' corners) |
| `lib/ink/shape-recognize.ts` | Recognising a hand-drawn stroke (`recognizeShape`), the shape tool's drag (`dragShape`), resizing while the pen rests (`followPen`) |
| `lib/ink/ruler.ts` | Ruler, set square (protractor) and compass: edges, straightening along them, scale ticks in cm/in, angle snapping, angles between lines, arcs |
| `lib/ink/selection.ts` | The lasso's selection over every item type: tap to pick (`itemAt`, also the shape tool's pick with `isShape`), affine move/scale/turn (corners, 15° snap, pinch; shapes through `affineShape`, turning into their box's rotation), front/back, width steps, text next to it, pastes kept on the page |
| `lib/ink/clipboard.ts` | The ink clipboard of the tab, shared by all editors (sheet → sheet, notebook → drawing block) |
| `lib/ink/history.ts` | Undo/redo of whole states |
| `lib/ink/presets.ts` | Tools, colours, widths and the free width ranges, the 3 favourite pens of earlier versions, text style, recent own colours, Pencil double-tap setting, snap setting (per device, `localStorage`) |
| `lib/ink/favorites.ts` | Favourite pens: up to 8 of tool (pen, highlighter, text) + colour + width (+ face), add/move/remove, the one in hand; per device (`flowplan-ink-favorites`; taken over once from `flowplan-ink-presets`, which stays for older versions) |
| `lib/ink/eraser.ts` | Eraser kinds – whole strokes, parts (`erasePartial` splits strokes), highlighter only – and the partial eraser's size (screen px); per device |
| `lib/ink/fonts.ts` | Typefaces of text: CSS families with fallbacks, rough advance per face, nearest standard PDF font |
| `lib/ink/color.ts` | Hex ↔ hue/saturation/value for the colour picker |
| `lib/ink/pdf-export.ts` | `flattenInk(pdfBytes, doc)` → new PDF with the ink as vectors (pdf-lib); `drawInk` for any page |
| `lib/ink/notebook-pdf.ts` | `notebookPdf(sheets, load)`: a notebook as PDF (paper as vectors or the imported PDF page, ink on top) |
| `lib/ink/merge.ts` | `mergeInk(base, ours, theirs)`: three-way merge by item id (concurrent saves) |
| `lib/ink/svg.ts` | `inkSvg(items, size, { paper })`: ink as an SVG document (published pages, exports) |
| `lib/ink/image.ts` | Pictures and stickers: bounds and hits (turned), the frame's resize/rotate/crop, order front/back, placing a new one |
| `lib/ink/stickers.ts` | Built-in stickers (paths in a 100 × 100 box, CC0; `public/stickers/*.svg` are written from them), date/time stamps as ink |
| `components/ink/ink-picture.tsx` | `<InkImageItem>` (drawing) and `<ImageFrame>` (move, resize, rotate, crop, order, opacity, duplicate, delete, save as sticker) |
| `lib/ink/recognition.ts` | Handwriting recognition in the iPhone/iPad app (contract below) |
| `lib/ink/recognized.ts` | Cleaning and capping recognised text |
| `lib/ink/audio-sync.ts` | Notebook audio: limits, recording format, time marks (`rec`) on new items, what playback has not reached |
| `lib/ink-store.ts` | Server: ink of PDF files (`file_ink`, `file_ink_versions`, `recognized`) |
| `lib/page-ink-store.ts` | Server: ink of a page's surfaces – notebook sheets, drawing blocks (`page_ink`, `page_ink_versions`) |
| `lib/ink-export.ts` | Server: pictures of drawing blocks and sheets for published pages and exports |
| `components/ink/use-surface-sync.ts` | Saving surfaces while drawing, merging, following others, recognition for search |
| `components/ink/convert.ts` | "Convert to text" of a lasso selection on the device (iPhone/iPad app) |
| `components/ink/ai-convert.tsx` | "Convert to text" with the instance's AI (`lib/ai/handwriting.ts`): dialog with the picture, the recognised text to edit, insert in place / next to it / copy |
| `components/ink/ink-selection-bar.tsx` | The bar over a selection: colour (palette, own colours, picker) and width, cut, copy, duplicate, front, back, convert, save as sticker (notebooks), delete |
| `components/ink/ink-image.ts` | Items as an SVG/PNG of just their area (system clipboard, AI recognition) |
| `components/ink/system-clipboard.ts` | Copied ink also on the system clipboard (PNG, SVG where supported, typed text) |
| `components/ink/use-ink-editor.ts` | `useInkEditor(initial)`: the editing session; `useInkShortcuts(editor, on)` |
| `components/ink/ink-layer.tsx` | `<InkLayer>`: renders and takes input for one page |
| `components/ink/ink-shape.tsx` | Drawing a shape item, the draft while drawing |
| `components/ink/shape-editor.tsx` | `<ShapeEditor>`: handles and bar of one selected shape (several selected: the lasso's box and `<InkSelectionBar>`) |
| `components/ink/ink-ruler.tsx` | `<InkRuler>` on its page, `rulerGuide` (strokes along it) |
| `components/ink/shape-panel.tsx` | The shape tool's panel sections (preview, kind grid, line style, fill on/off + colour), `<RulerSection>` (off, ruler, set square, compass; shape and gear panel), `<RulerToggle>` (the ruler's button in the toolbar row) |
| `components/ink/ink-stores.ts` | The ruler's place and the shape tool's choices (per device, outside React state) |
| `components/ink/ink-toolbar.tsx` | `<InkToolbar editor page?>`: tools, favourites, colours, widths, ruler button, undo/redo, paste, gear; tapping the tool in hand again (or the gear) opens its panel; children go at the end |
| `components/ink/ink-panel.tsx` | `<InkPanel>`: a tool's panel – favourites, live preview, width (presets + slider), text face, colour (picker beside the panel), eraser kinds and size, "clear page", the shape tool's sections, input settings (switches) |
| `components/ink/ink-style-picker.tsx` | `<InkCustomColor editor>` ("+" after the colours in the toolbar row: colour picker in a menu) |
| `components/ink/color-picker.tsx` | `<ColorPicker value onChange onCommit recent>`: saturation/brightness area, hue slider, hex field, eyedropper (EyeDropper API, hidden where missing), recent colours (pointer, Pencil, keyboard) |
| `components/ink/panel-parts.tsx` | Building blocks of the panels: segmented radio buttons, slider, section head, setting switch |

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
      { "id": "k3x9a03ef", "type": "text", "color": "#e03131", "size": 14, "x": 72, "y": 300, "text": "Geprüft" },
      { "id": "k3x9a04gh", "type": "text", "color": "#1f1f1f", "size": 28, "x": 72, "y": 340, "text": "Notiz", "font": "caveat" }
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
  `1.25·size` apart. Optional `font`: `sans` (Instrument Sans), `serif`
  (Instrument Serif), `mono` (JetBrains Mono), `caveat`, `patrick`
  (Patrick Hand); without it Helvetica, as before. Faces are in
  `public/fonts.css` (the browser fetches one only when shown). Exports:
  SVG names the face with fallbacks (inside Flowplan the face shows; a
  standalone SVG, EPUB or Word file shows the fallback); PDFs (notebook
  export, "Download with annotations") use the nearest standard PDF font –
  Times for `serif`, Courier for `mono`, Helvetica for the rest, no
  embedding. Versions before `font` read such text in Helvetica and drop
  the field when they save that surface.
- Optional `rec: { id, t }` on any item: written during the notebook
  audio recording `id`, `t` milliseconds into it (pauses not counted;
  `lib/ink/audio-sync.ts`, `lib/notebook-audio.ts`). Set by the editor for
  items new in a change while recording (`editor.stampRef`); pieces of a
  partly erased stroke, lasso moves/turns/duplicates and pasted copies keep
  their original's mark; text converted from handwriting takes the first
  mark of the strokes it replaces. Shapes, pictures and stickers are marked
  like strokes. Sheets copied or moved into **another** notebook (page
  overview) and ink saved as a sticker lose their marks (the recordings stay
  with the source notebook); deleting a sheet leaves the recordings alone,
  duplicating a whole notebook copies them with the same ids. Playback dims
  items of the playing recording with `t` later than its position
  (`<InkLayer playback>`). Versions before `rec` read such ink and drop the
  field when they save that surface: those items then simply show during
  playback.
- Shapes: a `pen` stroke may carry `shape` (`lib/ink/shapes.ts`), e.g.
  `"shape": { "kind": "rect", "box": [cx, cy, w, h, rotation°], "radius": 6, "fill": "#1c5fd6", "dash": "dash" }`.
  Kinds: `line` (`pts` x1, y1, x2, y2; `arrow` `"end"`/`"both"`),
  `polygon` (`pts`, 3–8 corners: triangles, diamonds, …), `rect`
  (`radius` for rounded corners), `ellipse`, `star` (`n` points, `inner`
  radius share) – the last three with `box`. `fill` is drawn at 25 %
  opacity, `dash` is `dash` or `dot`. The stroke's `points` are always the
  shape's outline (pressure kept even; arrow heads drawn there and back),
  rewritten whenever the shape changes. **Older versions** drop the
  `shape` field when they read the ink and show `points`: the same outline
  as a plain line, without fill and dashes. When such a version saves the
  surface, the server gives every stroke that came back unchanged (same id,
  colour, width, points) its shape again (`keepShapes`, `lib/ink/merge.ts`);
  a shape it moved or erased stays a plain stroke there. No version bump.
  The partial eraser leaves the pieces of a shape as freehand strokes, the
  stroke eraser takes it whole, "highlighter only" leaves it alone;
  "convert to text" skips shapes.
- Optional `rotation` of text: degrees clockwise (−180…180, two
  decimals) around `(x, y)`, set by turning a lasso selection; left out
  when upright. SVG draws it as `rotate(r x y)`, PDFs turn the text
  matrix. Versions before `rotation` show such text upright and drop the
  field when they save that surface (the text itself stays).
- Pictures and stickers (`type: "image"`):
  `{ id, type: "image", x, y, w, h, file?, sticker?, color?, rotation?, crop?, opacity? }`.
  `file` is a file attached to the same page (the server drops pictures of
  any other file when the ink is saved; page copies, archives and imports
  point them to the copied files), `sticker` a built-in sticker
  (`lib/ink/stickers.ts`; `color` tints one-colour ones). `(x, y, w, h)` is
  the box shown before `rotation` (degrees clockwise around its centre);
  `crop` the shown part of the whole picture in fractions (0–1). Drawn in
  item order among the ink, so a picture can lie under the ink or over it;
  highlighter strokes above a picture are drawn multiplied over it. Erasers
  leave pictures alone (they are deleted from their frame); the lasso takes
  them by their centre. At most 200 per page. In exports: SVG `<image>`
  (published pages: the share link's file address; exports leaving
  Flowplan: data: addresses), PDF: PNG/JPEG embedded once per file (the
  browser converts other types through a canvas; the server's Markdown
  export embeds PNG/JPEG with their EXIF orientation, others as grey boxes).
- Older versions drop `image` items when they read ink. So that they do not
  delete pictures when they save, a save carries `knows: ["image"]`; a save
  without it keeps the stored pictures it did not carry (lib/page-ink-store.ts
  `keepUnknownItems`), at their place in the stored order.
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
`.paper`, `notebook.paper`, `notebook.import` (`lib/notebook.ts`). New
sheets and inserted PDFs go after the sheet `after`, at the end (`after`
null) or before the first sheet (`at: "start"`), see `placeSheets`.
Organising (page overview, `lib/notebook-organize.ts`, model and pure
helpers in `lib/notebook-organize-model.ts`): `notebook.sheet.meta`
(title, bookmark), `.sheet.links` (areas linking to a sheet or page – kept
outside the ink, so older clients never drop them), `notebook.outline` /
`.outline.add` (table of contents), `.sheets.duplicate`, `.sheets.delete`
(into `notebook_sheet_trash`, 30 days, with the ink), `.trash.restore`,
`.sheets.transfer` (copy/move into another notebook). Presenting and
follow mode share the whiteboards' cursor channel
(`components/notebook/use-notebook-live.ts`).

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

Where the instance's AI may run for the page (feature `handwriting`,
`lib/ai/handwriting.ts`), notebooks and drawing blocks use it instead: the
selected pen strokes as a PNG (drawn in the browser) go to
`POST /api/ai/handwriting { pageId, image }` → `{ text }` – a vision model
is needed. Editors of unlocked pages only; PIN journals, encrypted spaces,
pages closed to the AI and the person's rules refuse, rate limits and
usage statistics as for every prompt. The text is shown to edit and then
placed as a text box (the text tool's colour, size, face) in the strokes'
place or next to them, or copied; one undo step.

## Lasso selection

Tap an item to pick it (the top one; a highlighter only where nothing is
drawn over it), or draw a loop around items. The selection moves by its
body, scales by its four corners (around the opposite one; free with the
mouse or pen, Shift or a finger keeps the aspect), turns by the handle
above it (snaps to 15° within 4°, Shift always in 15° steps) and – held by
a finger – scales and turns with a second finger. Strokes and text turn
with it (text keeps its turn in `rotation`). The bar recolours (palette,
recent own colours, picker), sets the width (fine/medium/bold for pen,
highlighter and text), cuts, copies, duplicates, brings to the front or
back, converts and deletes; keys: ⌘X/⌘C/⌘V/⌘D, ⌘] / ⌘[, arrows nudge
(Shift: 10 pt), ⌘A on a notebook, Delete, Escape. Every action is one undo
step and a normal ink change (saved, merged by item id; an order changed
only by one side survives a merge). The clipboard is shared by every ink
editor of the tab, so a cut on one sheet pastes onto another (the sheet
last touched; moved onto the page if it would stick out), and copies also
go to the system clipboard as a picture.

Pictures and stickers: a tap on one (or a loop around it alone) opens its
own frame (`components/ink/ink-picture.tsx`: crop, opacity, eight resize
handles, "save as sticker"); in a selection with other items they move,
scale and turn with them (`transformItem`: the centre goes through the
transform, the sides scale along their own direction, the turn adds up),
keep their colours (one-colour built-in stickers take a new colour) and
have no width. In notebooks the bar also saves the selection as a sticker
(`saveSelectionAsSticker`; pictures of files are left out of an ink sticker).

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
  line, arrow, rectangle/square (also rounded), ellipse/circle, triangle,
  diamond, polygon (up to 8 corners) or star (setting in the input
  settings of the panels);
  moving on without lifting resizes it (lines follow with their end). The
  stroke as drawn is one undo step before the shape: undo goes back to
  freehand. The shape tool (S) recognises at once or drags a chosen shape
  from corner to corner; a tap with it (or the lasso) on a shape selects it
  for editing. Its panel (tap the tool again) holds the kind, width, line
  style, colour and fill of new shapes and the ruler's instrument. One
  selected shape gets its own handles and bar; in a selection of several
  the lasso's box moves, scales and turns shapes with the rest.
- Ruler (its button in the toolbar row; set square and compass in the
  shape tool's and the gear's panel): lies on one page in its real scale; one finger moves it,
  two turn it (snapping to multiples of 15°); a stroke beginning within
  ~26 px of an edge follows it, with its length shown. The set square
  shows the angles between straight lines through its zero point and
  snaps onto where two lines cross; the compass draws arcs of its radius
  (a full turn becomes a circle shape). Fingers always move the ruler, the
  pen draws (pen-only drawing unchanged).
