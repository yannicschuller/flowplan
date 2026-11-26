// Small presentations and text documents for the Office preview (#562),
// built in memory from minimal XML (yazl, no Office): .pptx and .odp with
// slides, titles, bullets, tables, pictures and notes; .docx and .odt with
// headings, lists, tables and pictures.
import { ZipFile } from "yazl";

export async function zip(entries: Record<string, string | Buffer>) {
  const z = new ZipFile();
  for (const [name, content] of Object.entries(entries)) z.addBuffer(typeof content === "string" ? Buffer.from(content) : content, name);
  z.end();
  const chunks: Buffer[] = [];
  for await (const chunk of z.outputStream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
const esc = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/* ---------- PowerPoint ---------- */

const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG = "http://schemas.openxmlformats.org/package/2006/relationships";
const PML = `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${REL}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"`;
export type PptParagraph = string | { text: string; level?: number; bullet?: "none" | "char" | "num" };
export type PptSlide = {
  title?: string;
  // The body placeholder's paragraphs (bulleted unless they say otherwise).
  body?: PptParagraph[];
  // A text box's paragraphs (no bullets unless they say so).
  box?: PptParagraph[];
  table?: string[][];
  // Names under ppt/media/ the slide shows.
  pictures?: string[];
  notes?: string[];
  hidden?: boolean;
};
const pptPara = (p: PptParagraph) => {
  const { text, level = 0, bullet } = typeof p === "string" ? { text: p } : p;
  const bu = bullet === "none" ? "<a:buNone/>" : bullet === "char" ? `<a:buChar char="•"/>` : bullet === "num" ? `<a:buAutoNum type="arabicPeriod"/>` : "";
  const runs = text
    .split("\n")
    .map((line) => `<a:r><a:rPr lang="de-DE"/><a:t>${esc(line)}</a:t></a:r>`)
    .join("<a:br/>");
  return `<a:p><a:pPr lvl="${level}">${bu}</a:pPr>${runs}</a:p>`;
};
const shape = (id: number, ph: string, paras: PptParagraph[]) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Shape ${id}"/><p:cNvSpPr/><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/>${paras.map(pptPara).join("")}</p:txBody></p:sp>`;

// `order`: the slides' order in presentation.xml (indices into `slides`),
// so that it differs from the order of the part names.
export async function pptx(slides: PptSlide[], options: { order?: number[]; media?: Record<string, Buffer>; extra?: Record<string, string | Buffer> } = {}) {
  const order = options.order ?? slides.map((_, i) => i);
  const entries: Record<string, string | Buffer> = {
    "[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
    "_rels/.rels": `<?xml version="1.0"?><Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
    "ppt/presentation.xml": `<?xml version="1.0"?><p:presentation ${PML}><p:sldIdLst>${order.map((i, n) => `<p:sldId id="${256 + n}" r:id="rId${i + 10}"/>`).join("")}</p:sldIdLst></p:presentation>`,
    "ppt/_rels/presentation.xml.rels": `<?xml version="1.0"?><Relationships xmlns="${PKG}">${slides
      .map((_, i) => `<Relationship Id="rId${i + 10}" Type="${REL}/slide" Target="slides/slide${i + 1}.xml"/>`)
      .join("")}<Relationship Id="rId1" Type="${REL}/slideMaster" Target="slideMasters/slideMaster1.xml"/></Relationships>`,
    ...options.media,
    ...options.extra,
  };
  for (const [name, data] of Object.entries(options.media ?? {})) entries[name] = data;
  slides.forEach((s, i) => {
    const n = i + 1;
    let id = 2;
    const tree = [
      s.title !== undefined ? shape(id++, `<p:ph type="title"/>`, [s.title]) : "",
      s.body ? shape(id++, `<p:ph idx="1"/>`, s.body) : "",
      s.box ? shape(id++, "", s.box) : "",
      s.table
        ? `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id++}" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblGrid/>${s.table
            .map((row) => `<a:tr h="0">${row.map((cell) => `<a:tc><a:txBody><a:bodyPr/>${pptPara(cell)}</a:txBody></a:tc>`).join("")}</a:tr>`)
            .join("")}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`
        : "",
      ...(s.pictures ?? []).map(
        (_, k) => `<p:pic><p:nvPicPr><p:cNvPr id="${id++}" name="Picture"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rImg${k}"/></p:blipFill><p:spPr/></p:pic>`,
      ),
      // The slide number placeholder: layout, never content.
      shape(id++, `<p:ph type="sldNum" idx="12"/>`, [String(n)]),
    ].join("");
    entries[`ppt/slides/slide${n}.xml`] =
      `<?xml version="1.0"?><p:sld ${PML}${s.hidden ? ` show="0"` : ""}><p:cSld><p:bg><p:bgPr><a:blipFill><a:blip r:embed="rBg"/></a:blipFill></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${tree}</p:spTree></p:cSld></p:sld>`;
    entries[`ppt/slides/_rels/slide${n}.xml.rels`] = `<?xml version="1.0"?><Relationships xmlns="${PKG}"><Relationship Id="rLayout" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rBg" Type="${REL}/image" Target="../media/background.png"/>${(s.pictures ?? [])
      .map((p, k) => `<Relationship Id="rImg${k}" Type="${REL}/image" Target="../media/${p}"/>`)
      .join("")}${s.notes ? `<Relationship Id="rNotes" Type="${REL}/notesSlide" Target="../notesSlides/notesSlide${n}.xml"/>` : ""}</Relationships>`;
    if (s.notes)
      entries[`ppt/notesSlides/notesSlide${n}.xml`] =
        `<?xml version="1.0"?><p:notes ${PML}><p:cSld><p:spTree>${shape(2, `<p:ph type="sldImg"/>`, [])}${shape(3, `<p:ph type="body" idx="1"/>`, s.notes)}${shape(4, `<p:ph type="sldNum" idx="5"/>`, [String(n)])}</p:spTree></p:cSld></p:notes>`;
  });
  return await zip(entries);
}

/* ---------- Word ---------- */

const WML = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="${REL}" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"`;
export type WordBlock =
  | { heading: number; text: string }
  | { text: string; style?: string }
  | { bullet: string; level?: number }
  | { number: string; level?: number }
  | { table: string[][] }
  | { picture: string }
  | { raw: string };
const run = (text: string) => `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
export const wordPicture = (rId: string) =>
  `<w:r><w:drawing><wp:inline><wp:docPr id="1" name="Bild"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip r:embed="${rId}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;

// Headings by the German style ids Word writes ("berschrift1", named
// "heading 1"), bullets (numId 1) and numbers (numId 2) from numbering.xml.
export async function docx(blocks: WordBlock[], options: { media?: Record<string, Buffer> } = {}) {
  const pictures: string[] = [];
  const body = blocks
    .map((b) => {
      if ("heading" in b) return `<w:p><w:pPr><w:pStyle w:val="berschrift${b.heading}"/></w:pPr>${run(b.text)}</w:p>`;
      if ("bullet" in b) return `<w:p><w:pPr><w:pStyle w:val="Listenabsatz"/><w:numPr><w:ilvl w:val="${b.level ?? 0}"/><w:numId w:val="1"/></w:numPr></w:pPr>${run(b.bullet)}</w:p>`;
      if ("number" in b) return `<w:p><w:pPr><w:numPr><w:ilvl w:val="${b.level ?? 0}"/><w:numId w:val="2"/></w:numPr></w:pPr>${run(b.number)}</w:p>`;
      if ("table" in b)
        return `<w:tbl><w:tblPr/><w:tblGrid/>${b.table.map((row) => `<w:tr>${row.map((cell) => `<w:tc><w:tcPr/><w:p>${run(cell)}</w:p></w:tc>`).join("")}</w:tr>`).join("")}</w:tbl>`;
      if ("picture" in b) {
        pictures.push(b.picture);
        return `<w:p>${wordPicture(`rPic${pictures.length - 1}`)}</w:p>`;
      }
      if ("raw" in b) return b.raw;
      return `<w:p>${b.style ? `<w:pPr><w:pStyle w:val="${b.style}"/></w:pPr>` : ""}${b.text
        .split("\n")
        .map(run)
        .join("<w:r><w:br/></w:r>")}</w:p>`;
    })
    .join("");
  const level = (ilvl: number, fmt: string) => `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="%1."/></w:lvl>`;
  return await zip({
    "[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
    "_rels/.rels": `<?xml version="1.0"?><Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`,
    "word/document.xml": `<?xml version="1.0"?><w:document ${WML}><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`,
    "word/_rels/document.xml.rels": `<?xml version="1.0"?><Relationships xmlns="${PKG}"><Relationship Id="rS" Type="${REL}/styles" Target="styles.xml"/><Relationship Id="rN" Type="${REL}/numbering" Target="numbering.xml"/>${pictures
      .map((p, k) => `<Relationship Id="rPic${k}" Type="${REL}/image" Target="media/${p}"/>`)
      .join("")}<Relationship Id="rUnused" Type="${REL}/image" Target="media/unused.png"/></Relationships>`,
    "word/styles.xml": `<?xml version="1.0"?><w:styles ${WML}><w:style w:type="paragraph" w:styleId="Standard"><w:name w:val="Normal"/></w:style>${[1, 2, 3]
      .map((n) => `<w:style w:type="paragraph" w:styleId="berschrift${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Standard"/><w:pPr><w:outlineLvl w:val="${n - 1}"/></w:pPr></w:style>`)
      .join("")}<w:style w:type="paragraph" w:styleId="Titel"><w:name w:val="Title"/></w:style><w:style w:type="paragraph" w:styleId="Listenabsatz"><w:name w:val="List Paragraph"/></w:style></w:styles>`,
    "word/numbering.xml": `<?xml version="1.0"?><w:numbering ${WML}><w:abstractNum w:abstractNumId="0">${level(0, "bullet")}${level(1, "bullet")}</w:abstractNum><w:abstractNum w:abstractNumId="1">${level(0, "decimal")}${level(1, "lowerLetter")}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`,
    ...Object.fromEntries(Object.entries(options.media ?? {}).map(([name, data]) => [`word/media/${name}`, data])),
  });
}

/* ---------- OpenDocument ---------- */

const ODF = `xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" office:version="1.3"`;
const LIST_STYLES = `<office:automatic-styles><text:list-style style:name="LB"><text:list-level-style-bullet text:level="1" text:bullet-char="•"/><text:list-level-style-bullet text:level="2" text:bullet-char="◦"/></text:list-style><text:list-style style:name="LN"><text:list-level-style-number text:level="1" style:num-format="1"/><text:list-level-style-number text:level="2" style:num-format="a"/></text:list-style></office:automatic-styles>`;
export type Outline = (string | Outline)[];
const odfList = (items: Outline, style: string): string =>
  `<text:list text:style-name="${style}">${items
    .map((item) => (Array.isArray(item) ? `<text:list-item>${odfList(item, style).replace(/ text:style-name="[^"]*"/, "")}</text:list-item>` : `<text:list-item><text:p>${esc(item)}</text:p></text:list-item>`))
    .join("")}</text:list>`;
const odfTable = (rows: string[][]) =>
  `<table:table table:name="T"><table:table-column table:number-columns-repeated="${rows[0]?.length ?? 1}"/>${rows
    .map((row) => `<table:table-row>${row.map((cell) => `<table:table-cell><text:p>${esc(cell)}</text:p></table:table-cell>`).join("")}</table:table-row>`)
    .join("")}</table:table>`;
const odfPicture = (name: string) =>
  `<draw:frame draw:name="Bild"><draw:image xlink:href="Pictures/${name}.svg" xlink:type="simple"/><draw:image xlink:href="Pictures/${name}" xlink:type="simple"><text:p/></draw:image><svg:title>Alternativtext</svg:title></draw:frame>`;

export type OdpSlide = { title?: string; outline?: Outline; text?: string[]; table?: string[][]; pictures?: string[]; notes?: string[] };
export async function odp(slides: OdpSlide[], options: { media?: Record<string, Buffer> } = {}) {
  const pages = slides
    .map(
      (s, i) =>
        `<draw:page draw:name="page${i + 1}">${s.title !== undefined ? `<draw:frame presentation:class="title"><draw:text-box><text:p>${esc(s.title)}</text:p></draw:text-box></draw:frame>` : ""}${
          s.outline ? `<draw:frame presentation:class="outline"><draw:text-box>${odfList(s.outline, "LB")}</draw:text-box></draw:frame>` : ""
        }${s.text ? `<draw:frame><draw:text-box>${s.text.map((t) => `<text:p>${esc(t)}</text:p>`).join("")}</draw:text-box></draw:frame>` : ""}${s.table ? `<draw:frame>${odfTable(s.table)}</draw:frame>` : ""}${(s.pictures ?? [])
          .map(odfPicture)
          .join("")}<draw:frame presentation:class="page-number"><draw:text-box><text:p>${i + 1}</text:p></draw:text-box></draw:frame>${
          s.notes
            ? `<presentation:notes><draw:page-thumbnail draw:page-number="${i + 1}"/><draw:frame presentation:class="notes"><draw:text-box>${s.notes.map((n) => `<text:p>${esc(n)}</text:p>`).join("")}</draw:text-box></draw:frame></presentation:notes>`
            : ""
        }</draw:page>`,
    )
    .join("");
  return await zip({
    mimetype: "application/vnd.oasis.opendocument.presentation",
    "content.xml": `<?xml version="1.0"?><office:document-content ${ODF}>${LIST_STYLES}<office:body><office:presentation>${pages}</office:presentation></office:body></office:document-content>`,
    ...Object.fromEntries(Object.entries(options.media ?? {}).map(([name, data]) => [`Pictures/${name}`, data])),
  });
}

export type OdtBlock = { heading: number; text: string } | { text: string } | { bullets: Outline } | { numbers: Outline } | { table: string[][] } | { picture: string } | { raw: string };
export async function odt(blocks: OdtBlock[], options: { media?: Record<string, Buffer> } = {}) {
  const body = blocks
    .map((b) => {
      if ("heading" in b) return `<text:h text:outline-level="${b.heading}">${esc(b.text)}</text:h>`;
      if ("bullets" in b) return odfList(b.bullets, "LB");
      if ("numbers" in b) return odfList(b.numbers, "LN");
      if ("table" in b) return odfTable(b.table);
      if ("picture" in b) return `<text:p>${odfPicture(b.picture)}</text:p>`;
      if ("raw" in b) return b.raw;
      return `<text:p>${esc(b.text)}</text:p>`;
    })
    .join("");
  return await zip({
    mimetype: "application/vnd.oasis.opendocument.text",
    "content.xml": `<?xml version="1.0"?><office:document-content ${ODF}>${LIST_STYLES}<office:body><office:text><text:sequence-decls><text:sequence-decl text:name="Illustration"/></text:sequence-decls>${body}</office:text></office:body></office:document-content>`,
    ...Object.fromEntries(Object.entries(options.media ?? {}).map(([name, data]) => [`Pictures/${name}`, data])),
  });
}
