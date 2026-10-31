// A sample AFFiNE workspace with everything the importer handles: folders,
// tags, links between documents, a collection with rules, a database,
// images and attachments, an edgeless canvas, journal days, a document in
// the trash – and some hostile text.
import { boxed, list, note, page, para, PDF, PNG, raw, text, uid, type BlockSpec, type Workspace } from "./affine-fixture";

export const IDS = { plan: "docPlan01", notes: "docNotes02", sketch: "docSketch03", canvas: "docCanvas04", day1: "docDay05", day2: "docDay06", trash: "docTrash07" };

export function sampleWorkspace(): Workspace {
  const { plan, notes, sketch, canvas, day1, day2, trash } = IDS;
  const database: BlockSpec = {
    id: "db1",
    flavour: "affine:database",
    props: {
      title: text("Aufgaben"),
      views: [
        { id: "v1", name: "Alle", mode: "table", columns: [], filter: { type: "group", op: "and", conditions: [] } },
        { id: "v2", name: "Board", mode: "kanban", groupBy: { type: "groupBy", columnId: "cStatus", name: "select" } },
      ],
      columns: [
        { id: "cTitle", type: "title", name: "Aufgabe", data: {} },
        { id: "cNote", type: "rich-text", name: "Notiz", data: {} },
        { id: "cHours", type: "number", name: "Stunden", data: {} },
        { id: "cStatus", type: "select", name: "Status", data: { options: [{ id: "o1", value: "Offen", color: "x" }, { id: "o2", value: "Erledigt", color: "y" }] } },
        { id: "cLabels", type: "multi-select", name: "Labels", data: { options: [{ id: "m1", value: "A" }, { id: "m2", value: "B" }] } },
        { id: "cDue", type: "date", name: "Fällig", data: {} },
        { id: "cDone", type: "checkbox", name: "Fertig", data: {} },
        { id: "cLink", type: "link", name: "Link", data: {} },
        { id: "cProgress", type: "progress", name: "Fortschritt", data: {} },
        { id: "cPic", type: "image", name: "Bild", data: {} },
      ],
      cells: {
        r1: {
          cNote: { columnId: "cNote", value: text("wichtig <b>fett</b>") },
          cHours: { columnId: "cHours", value: 3.5 },
          cStatus: { columnId: "cStatus", value: "o2" },
          cLabels: { columnId: "cLabels", value: raw(["m1", "m2"]) },
          cDue: { columnId: "cDue", value: Date.UTC(2026, 9, 14, 22) },
          cDone: { columnId: "cDone", value: true },
          cLink: { columnId: "cLink", value: "javascript:alert(1)" },
          cProgress: { columnId: "cProgress", value: 40 },
        },
        r2: { cLink: { columnId: "cLink", value: "https://example.com/r2" }, cStatus: { columnId: "cStatus", value: "o1" } },
      },
    },
    children: [
      { id: "r1", flavour: "affine:paragraph", props: { type: "text", text: text("Erste Aufgabe") }, children: [para("Inhalt der ersten Aufgabe")] },
      { id: "r2", flavour: "affine:paragraph", props: { type: "text", text: text("Zweite Aufgabe") } },
    ],
  };
  const planDoc = page(plan, "Projektplan", [
    note([
      para("Ziele", "h1"),
      para([
        { insert: "Fett", attributes: { bold: true } },
        { insert: " und " },
        { insert: "kursiv", attributes: { italic: true } },
        { insert: " mit " },
        { insert: "Link", attributes: { link: "https://example.com/a" } },
        { insert: " und " },
        { insert: "böse", attributes: { link: "javascript:alert(1)" } },
        { insert: " siehe " },
        { insert: " ", attributes: { reference: { type: "LinkedPage", pageId: notes } } },
        { insert: " " },
        { insert: " ", attributes: { latex: "a^2+b^2" } },
        { insert: "rot", attributes: { color: "var(--affine-text-highlight-foreground-red)" } },
        { insert: "markiert", attributes: { background: "var(--affine-text-highlight-yellow)" } },
      ]),
      para('<img src=x onerror="alert(1)"><script>alert(1)</script>'),
      list("bulleted", "Punkt eins", {}, [list("bulleted", "Unterpunkt")]),
      list("bulleted", "Punkt zwei"),
      list("numbered", "Erstens"),
      list("todo", "Erledigt", { checked: true }),
      list("todo", "Offen", { checked: false }),
      list("toggle", "Mehr", {}, [para("Versteckt")]),
      para("Zitat", "quote"),
      { id: uid(), flavour: "affine:code", props: { text: text("const x = '<script>';"), language: "typescript" } },
      { id: uid(), flavour: "affine:divider", props: {} },
      { id: uid(), flavour: "affine:callout", props: { icon: { type: "emoji", unicode: "💡" }, backgroundColorName: "red", text: text("") }, children: [para("Achtung")] },
      { id: uid(), flavour: "affine:latex", props: { latex: "\\int_0^1 x\\,dx" } },
      {
        id: uid(),
        flavour: "affine:table",
        flat: true,
        props: {
          rows: { ra: { rowId: "ra", order: "a0" }, rb: { rowId: "rb", order: "a1" } },
          columns: { ca: { columnId: "ca", order: "a0" }, cb: { columnId: "cb", order: "a1" } },
          cells: { "ra:ca": { text: text("A1") }, "ra:cb": { text: text("B1") }, "rb:ca": { text: text("A2") }, "rb:cb": { text: text("B2") } },
        },
      },
      { id: uid(), flavour: "affine:image", props: { sourceId: "blobPng", caption: "Ein Bild", width: 1, height: 1 } },
      { id: uid(), flavour: "affine:attachment", props: { sourceId: "blobPdf", name: "Bericht.pdf", type: "application/pdf", size: PDF.length } },
      { id: uid(), flavour: "affine:attachment", props: { sourceId: "blobMissing", name: "Fehlt.pdf", type: "application/pdf" } },
      { id: uid(), flavour: "affine:bookmark", props: { url: "https://example.org/artikel", title: "Artikel" } },
      { id: uid(), flavour: "affine:bookmark", props: { url: "javascript:alert(2)", title: "Böse" } },
      { id: uid(), flavour: "affine:embed-linked-doc", props: { pageId: notes } },
      { id: uid(), flavour: "affine:embed-html", props: { html: "<script>alert(3)</script>" } },
      database,
    ]),
  ]);
  const notesDoc = page(notes, "Notizen", [
    note([para([{ insert: "Zurück zum " }, { insert: " ", attributes: { reference: { type: "LinkedPage", pageId: plan } } }, { insert: " und " }, { insert: "App-Link", attributes: { link: `https://app.affine.pro/workspace/ws1/${sketch}` } }])]),
  ]);
  const sketchDoc = page(
    sketch,
    "Skizze",
    [
      note([para("Text der Skizze")], { xywh: "[0,0,400,200]", index: "a1" }),
      note([para("Nur auf dem Whiteboard")], { xywh: "[500,0,200,100]", displayMode: "edgeless", index: "a2", background: "--affine-note-background-yellow" }),
    ],
    {
      elements: {
        s1: { id: "s1", type: "shape", index: "a3", xywh: "[0,300,100,80]", shapeType: "rect", radius: 0.1, filled: true, fillColor: "--affine-palette-shape-yellow", strokeColor: "#000000", strokeWidth: 2, text: text("Start <b>") },
        s2: { id: "s2", type: "shape", index: "a4", xywh: "[300,300,100,80]", shapeType: "ellipse", filled: false, strokeColor: { light: "#ff0000", dark: "#00ff00" }, strokeWidth: 2 },
        c1: { id: "c1", type: "connector", index: "a5", source: { id: "s1", position: [1, 0.5] }, target: { id: "s2" }, mode: 1, rearEndpointStyle: "Arrow", frontEndpointStyle: "None", stroke: "#333333", strokeWidth: 2, text: text("weiter") },
        c2: { id: "c2", type: "connector", index: "a6", source: { position: [10, 500] }, target: { position: [200, 520] }, mode: 0, rearEndpointStyle: "None", frontEndpointStyle: "None" },
        t1: { id: "t1", type: "text", index: "a7", xywh: "[0,450,200,30]", text: text("Freier Text"), color: "#1e96eb", fontSize: 24, textAlign: "center" },
        b1: { id: "b1", type: "brush", index: "a8", xywh: "[600,300,50,50]", points: [[0, 0, 0.5], [25, 30, 0.5], [50, 50, 0.5]], color: "#000000", lineWidth: 4 },
        g1: { id: "g1", type: "group", index: "a9", children: { s1: true, s2: true }, title: text("Gruppe") },
        m1: { id: "m1", type: "mindmap", index: "b0", children: { mA: raw({ index: "a0" }), mB: raw({ index: "a1", parent: "mA" }) } },
        mA: { id: "mA", type: "shape", index: "b1", xywh: "[0,700,120,40]", shapeType: "rect", text: text("Idee") },
        mB: { id: "mB", type: "shape", index: "b2", xywh: "[200,700,120,40]", shapeType: "rect", text: text("Ast") },
        x1: { id: "x1", type: "latex-unknown", index: "b3", xywh: "[0,0,10,10]" },
      },
      children: [
        { id: "f1", flavour: "affine:frame", props: { title: text("Rahmen A"), xywh: "[-50,-50,900,900]", background: "transparent", index: "a0" } },
        { id: "i1", flavour: "affine:image", props: { sourceId: "blobPng", xywh: "[800,0,100,100]", index: "b4" } },
        { id: "i2", flavour: "affine:image", props: { sourceId: "blobPdf", xywh: "[800,200,100,100]", index: "b5" } },
      ],
    },
  );
  const canvasDoc = page(canvas, "Leinwand", [note([para("Nur Text, aber im Whiteboard-Modus")])]);
  const day1Doc = page(day1, "Tagebuch 1", [note([para("Heute: Import gebaut.")])]);
  const day2Doc = page(day2, "Tagebuch 2", [note([para("Nachtrag aus AFFiNE")])]);
  const trashDoc = page(trash, "Weg damit", [note([para("gelöscht")])]);
  return {
    id: "ws1",
    name: "Mein Wissen",
    tags: [
      { id: "t1", value: "projekt", color: "red" },
      { id: "t2", value: "idee" },
    ],
    docs: [
      { id: plan, title: "Projektplan", doc: planDoc, tags: ["t1"], createDate: Date.UTC(2026, 5, 1) },
      { id: notes, title: "Notizen", doc: notesDoc, tags: ["t2", "unknownTag"], createDate: Date.UTC(2026, 6, 1) },
      { id: sketch, title: "Skizze", doc: sketchDoc },
      { id: canvas, title: "Leinwand", doc: canvasDoc },
      { id: day1, title: "Oct 1, 2026", doc: day1Doc },
      { id: day2, title: "Oct 2, 2026", doc: day2Doc },
      { id: trash, title: "Weg damit", doc: trashDoc, trash: true },
    ],
    folders: [
      { id: "F1", parentId: null, type: "folder", data: "Projekte", index: "a0" },
      { id: "F2", parentId: "F1", type: "folder", data: "Archiv", index: "a2" },
      { id: "L1", parentId: "F1", type: "doc", data: plan, index: "a1" },
      { id: "L2", parentId: "F2", type: "doc", data: notes, index: "a0" },
      { id: "L3", parentId: "F2", type: "doc", data: plan, index: "a1" },
      { id: "L4", parentId: "F1", type: "collection", data: "coll1", index: "a3" },
      { id: "L5", parentId: "F2", type: "tag", data: "t1", index: "a2" },
      // A cycle in a crafted file must not hang the import.
      { id: "F3", parentId: "F4", type: "folder", data: "Kreis A", index: "a0" },
      { id: "F4", parentId: "F3", type: "folder", data: "Kreis B", index: "a0" },
    ],
    collections: [
      { id: "coll1", name: "Wichtig", rules: { filters: [{ type: "system", key: "tags", method: "include-any-of", value: "t1" }] }, allowList: [notes] },
      { id: "coll2", name: "Favoriten", rules: { filters: [{ type: "system", key: "favorite", method: "is", value: "true" }] }, allowList: [] },
      { id: "coll3", name: "Unklar", rules: { filters: [{ type: "property", key: "custom:xyz", method: "is", value: "1" }] }, allowList: [sketch] },
      // The older form with a filter list.
      { id: "coll4", name: "Alt", filterList: [{ left: { name: "Tags" }, funcName: "is not empty", args: [] }], allowList: [] },
    ],
    docProperties: {
      [canvas]: { primaryMode: "edgeless" },
      [day1]: { journal: "2026-10-01" },
      [day2]: { journal: "2026-10-02" },
    },
    favorites: [plan],
    blobs: [
      { key: "blobPng", data: PNG, mime: "image/png" },
      { key: "blobPdf", data: PDF, mime: "application/pdf" },
    ],
  };
}
export { boxed };
