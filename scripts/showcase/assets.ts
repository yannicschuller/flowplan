// Pictures and PDFs of the showcase workspace, generated locally: covers
// and illustrations as SVG rendered by sharp, PDFs with pdf-lib. Nothing is
// downloaded, so the workspace contains no third-party material.
import sharp from "sharp";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { random } from "./handwriting";

export const palette = {
  ink: "#1f2a44",
  clay: "#e0782c",
  sand: "#f4e9d8",
  sage: "#8fb39a",
  sky: "#9cc3e4",
  plum: "#7b5ea7",
  rose: "#e8a1a8",
  night: "#14213d",
  paper: "#fbf8f3",
};

const svgPng = async (svg: string, quality = 82) => sharp(Buffer.from(svg)).jpeg({ quality, mozjpeg: true }).toBuffer();

// A wide cover: soft blobs and lines in the given colours.
export async function cover(colors: string[], seed: number, width = 1600, height = 480) {
  const rnd = random(seed);
  const [bg, ...rest] = colors;
  let shapes = "";
  for (let i = 0; i < 9; i++) {
    const c = rest[i % rest.length];
    const cx = rnd() * width,
      cy = rnd() * height,
      r = 120 + rnd() * 320;
    shapes += `<circle cx="${cx.toFixed(0)}" cy="${cy.toFixed(0)}" r="${r.toFixed(0)}" fill="${c}" opacity="${(0.35 + rnd() * 0.45).toFixed(2)}"/>`;
  }
  let lines = "";
  for (let i = 0; i < 5; i++) {
    const y = (height / 6) * (i + 1) + (rnd() - 0.5) * 40;
    lines += `<path d="M -20 ${y.toFixed(0)} C ${width * 0.3} ${(y - 80 + rnd() * 160).toFixed(0)}, ${width * 0.7} ${(y - 80 + rnd() * 160).toFixed(0)}, ${width + 20} ${y.toFixed(0)}" stroke="#ffffff" stroke-opacity="0.35" stroke-width="2" fill="none"/>`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><filter id="b"><feGaussianBlur stdDeviation="${(40 + rnd() * 30).toFixed(0)}"/></filter></defs><rect width="100%" height="100%" fill="${bg}"/><g filter="url(#b)">${shapes}</g>${lines}</svg>`;
  return svgPng(svg);
}

// A square-ish illustration for gallery cards and documents: geometric
// still life in the given colours.
export async function illustration(colors: string[], seed: number, width = 800, height = 560) {
  const rnd = random(seed);
  const [bg, a, b, c] = colors;
  let shapes = "";
  for (let i = 0; i < 6; i++) {
    const kind = Math.floor(rnd() * 3);
    const col = [a, b, c][i % 3];
    const x = rnd() * width,
      y = rnd() * height,
      s = 60 + rnd() * 200;
    if (kind === 0) shapes += `<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${(s / 2).toFixed(0)}" fill="${col}"/>`;
    else if (kind === 1)
      shapes += `<rect x="${(x - s / 2).toFixed(0)}" y="${(y - s / 2).toFixed(0)}" width="${s.toFixed(0)}" height="${(s * 0.7).toFixed(0)}" rx="${(s * 0.12).toFixed(0)}" fill="${col}" transform="rotate(${((rnd() - 0.5) * 30).toFixed(0)} ${x.toFixed(0)} ${y.toFixed(0)})"/>`;
    else shapes += `<path d="M ${x.toFixed(0)} ${(y - s / 2).toFixed(0)} L ${(x + s / 2).toFixed(0)} ${(y + s / 2).toFixed(0)} L ${(x - s / 2).toFixed(0)} ${(y + s / 2).toFixed(0)} Z" fill="${col}"/>`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="${bg}"/>${shapes}<rect x="24" y="24" width="${width - 48}" height="${height - 48}" fill="none" stroke="#ffffff" stroke-opacity="0.6" stroke-width="3" rx="18"/></svg>`;
  return svgPng(svg);
}

// A round portrait placeholder: initials on a colour (no real person).
export async function avatar(initials: string, color: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320"><rect width="320" height="320" fill="${color}"/><circle cx="160" cy="128" r="62" fill="#ffffff" opacity="0.35"/><path d="M 52 320 C 60 220, 260 220, 268 320 Z" fill="#ffffff" opacity="0.35"/><text x="160" y="300" font-family="DejaVu Sans, Arial, sans-serif" font-size="44" font-weight="700" fill="#ffffff" text-anchor="middle">${initials}</text></svg>`;
  return svgPng(svg, 85);
}

// A product mock-up screen (for a release note or a gallery).
export async function screen(title: string, accent: string, seed: number) {
  const rnd = random(seed);
  let bars = "";
  for (let i = 0; i < 6; i++) {
    const h = 40 + rnd() * 160;
    bars += `<rect x="${460 + i * 52}" y="${420 - h}" width="34" height="${h.toFixed(0)}" rx="6" fill="${accent}" opacity="${(0.5 + rnd() * 0.5).toFixed(2)}"/>`;
  }
  let rows = "";
  for (let i = 0; i < 5; i++)
    rows += `<rect x="70" y="${190 + i * 46}" width="${(220 + rnd() * 100).toFixed(0)}" height="14" rx="7" fill="#d9dee7"/><circle cx="54" cy="${197 + i * 46}" r="7" fill="${i % 2 ? accent : "#c5ccd8"}"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="560"><rect width="900" height="560" fill="#eef1f6"/><rect x="20" y="20" width="860" height="520" rx="18" fill="#ffffff"/><rect x="20" y="20" width="860" height="56" rx="18" fill="${palette.night}"/><circle cx="52" cy="48" r="7" fill="#ff6b6b"/><circle cx="74" cy="48" r="7" fill="#ffd43b"/><circle cx="96" cy="48" r="7" fill="#51cf66"/><text x="40" y="140" font-family="DejaVu Sans, Arial, sans-serif" font-size="30" font-weight="700" fill="${palette.ink}">${title}</text>${rows}${bars}<line x1="440" y1="420" x2="800" y2="420" stroke="#c5ccd8" stroke-width="2"/></svg>`;
  return svgPng(svg);
}

type PdfText = { title: string; subtitle: string; sections: { heading: string; lines: string[] }[]; footer: string };
function wrap(text: string, font: PDFFont, size: number, width: number) {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) > width && line) {
      out.push(line);
      line = word;
    } else line = next;
  }
  if (line) out.push(line);
  return out;
}
// Where a line of body text landed: page (from 1), left edge and baseline
// in ink coordinates (points from the top left), and a measure for parts of
// it – to place annotations on the text.
export type PdfLine = { page: number; x: number; y: number; text: string; width: (part: string) => number };
// A short, designed PDF document (brief, style guide …) on A4.
export async function briefPdf(text: PdfText, accent = palette.clay, layout: PdfLine[] = []) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(text.title);
  pdf.setAuthor("Northwind Studio");
  pdf.setCreator("Flowplan showcase");
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const hex = (h: string) => rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);
  const [W, H] = [595.28, 841.89];
  let page: PDFPage = pdf.addPage([W, H]);
  let pageNo = 1;
  const header = (p: PDFPage) => {
    p.drawRectangle({ x: 0, y: H - 10, width: W, height: 10, color: hex(accent) });
    p.drawText("NORTHWIND STUDIO", { x: 56, y: H - 40, size: 9, font: bold, color: hex(palette.ink) });
    p.drawText(text.footer, { x: 56, y: 32, size: 8, font: regular, color: rgb(0.45, 0.47, 0.52) });
    p.drawText(String(pageNo), { x: W - 64, y: 32, size: 8, font: regular, color: rgb(0.45, 0.47, 0.52) });
  };
  header(page);
  page.drawText(text.title, { x: 56, y: H - 120, size: 30, font: bold, color: hex(palette.ink) });
  page.drawText(text.subtitle, { x: 56, y: H - 150, size: 13, font: regular, color: rgb(0.35, 0.37, 0.42) });
  page.drawRectangle({ x: 56, y: H - 172, width: 60, height: 4, color: hex(accent) });
  let y = H - 220;
  for (const section of text.sections) {
    if (y < 160) {
      page = pdf.addPage([W, H]);
      pageNo++;
      header(page);
      y = H - 100;
    }
    page.drawText(section.heading, { x: 56, y, size: 15, font: bold, color: hex(palette.ink) });
    y -= 24;
    for (const paragraph of section.lines)
      for (const line of wrap(paragraph, regular, 11, W - 112)) {
        page.drawText(line, { x: 56, y, size: 11, font: regular, color: rgb(0.2, 0.22, 0.27), lineHeight: 15 });
        layout.push({ page: pageNo, x: 56, y: H - y, text: line, width: (part) => regular.widthOfTextAtSize(part, 11) });
        y -= 16;
      }
    y -= 18;
  }
  return Buffer.from(await pdf.save());
}

// A printable worksheet (storyboard frames) for the PDF-backed notebook.
export async function storyboardPdf(title: string, labels: string[]) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  pdf.setCreator("Flowplan showcase");
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const [W, H] = [841.89, 595.28];
  for (let n = 0; n < 2; n++) {
    const page = pdf.addPage([W, H]);
    page.drawText(`${title} · ${n + 1}/2`, { x: 40, y: H - 50, size: 18, font: bold, color: rgb(0.12, 0.16, 0.27) });
    for (let i = 0; i < 6; i++) {
      const col = i % 3,
        row = Math.floor(i / 3);
      const x = 40 + col * 260,
        y = H - 120 - row * 230;
      page.drawRectangle({ x, y: y - 150, width: 240, height: 150, borderColor: rgb(0.55, 0.58, 0.64), borderWidth: 1.2 });
      page.drawText(`${labels[0]} ${n * 6 + i + 1}`, { x, y: y - 168, size: 9, font: bold, color: rgb(0.35, 0.37, 0.42) });
      for (let l = 0; l < 2; l++) page.drawLine({ start: { x, y: y - 186 - l * 16 }, end: { x: x + 240, y: y - 186 - l * 16 }, thickness: 0.5, color: rgb(0.75, 0.78, 0.82) });
    }
    page.drawText(labels[1], { x: 40, y: 24, size: 8, font: regular, color: rgb(0.45, 0.47, 0.52) });
  }
  return Buffer.from(await pdf.save());
}

// Sizes of PDF pages as shown (points), for notebook backgrounds.
export async function pdfPageSizes(bytes: Buffer) {
  const pdf = await PDFDocument.load(bytes);
  return pdf.getPages().map((p) => p.getSize());
}
