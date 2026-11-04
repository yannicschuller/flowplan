// The research paper for "Annotate PDFs": a two-page PDF made with pdf-lib
// and the annotations on it (highlighter, a circled number, handwritten
// notes) in Flowplan's ink format, placed on the words they mark.
import { createRequire } from "node:module";
import { handwriting, penPath, loop } from "./handwriting.mjs";

const require = createRequire(new URL("../../package.json", import.meta.url));
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");

const W = 595;
const H = 842;

export async function paper() {
  const pdf = await PDFDocument.create();
  pdf.setTitle("Spaced repetition and long-term retention in adult learners");
  pdf.setAuthor("R. Okafor, L. Brandt, S. Yamada");
  // Fixed dates: the same bytes on every run.
  pdf.setCreationDate(new Date("2026-09-14T09:00:00Z"));
  pdf.setModificationDate(new Date("2026-09-14T09:00:00Z"));
  const serif = await pdf.embedFont(StandardFonts.TimesRoman);
  const bold = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const italic = await pdf.embedFont(StandardFonts.TimesRomanItalic);
  const ink = [];
  // Every line drawn on page 1, to place the ink on its words.
  const lines = [];
  let p = pdf.addPage([W, H]);
  let y = 790;
  let pageNo = 1;
  const ink1 = (item) => ink.push(item);
  const text = (s, { font = serif, size = 10.5, x = 60, gap = 14, color = rgb(0.1, 0.1, 0.12) } = {}) => {
    const words = s.split(" ");
    let line = "";
    const out = [];
    for (const word of words) {
      const next = line ? line + " " + word : word;
      if (font.widthOfTextAtSize(next, size) > 475) {
        out.push(line);
        line = word;
      } else line = next;
    }
    if (line) out.push(line);
    for (const l of out) {
      p.drawText(l, { x, y, size, font, color });
      if (pageNo === 1) lines.push({ text: l, x, y, size, font });
      y -= gap;
    }
    y -= 4;
  };
  // Ink coordinates: points from the top left.
  const top = (yy) => H - yy;
  // A highlighter stroke over `phrase` (which may run over two lines).
  const highlight = (phrase, id) => {
    for (const l of lines) {
      const at = l.text.indexOf(phrase.split(" ")[0]);
      const words = phrase.split(" ");
      // The longest start of the phrase that sits on this line.
      for (let n = words.length; n > 0; n--) {
        const part = words.slice(0, n).join(" ");
        const i = l.text.indexOf(part);
        if (i < 0 || (at < 0 && i !== 0)) continue;
        if (n < words.length && i + part.length !== l.text.length) continue;
        const x0 = l.x + l.font.widthOfTextAtSize(l.text.slice(0, i), l.size);
        const x1 = x0 + l.font.widthOfTextAtSize(part, l.size);
        // Round caps reach half the width past both ends.
        const cap = (l.size * 1.25) / 2;
        ink1(penPath([[x0 + cap - 1, top(l.y) - l.size * 0.32], [x1 - cap + 1, top(l.y) - l.size * 0.3]], { id: `${id}-${lines.indexOf(l)}`, color: "#ffd43b", width: l.size * 1.25, type: "highlighter" }));
        const rest = words.slice(n).join(" ");
        if (rest) {
          const next = lines[lines.indexOf(l) + 1];
          if (next && next.text.startsWith(rest.split(" ")[0])) {
            const x2 = next.x + next.font.widthOfTextAtSize(rest, next.size);
            const cap2 = (next.size * 1.25) / 2;
            ink1(penPath([[next.x + cap2 - 1, top(next.y) - next.size * 0.32], [x2 - cap2 + 1, top(next.y) - next.size * 0.3]], { id: `${id}-b`, color: "#ffd43b", width: next.size * 1.25, type: "highlighter" }));
          }
        }
        return;
      }
    }
  };

  text("WORKING PAPER · LEARNING SCIENCE", { font: bold, size: 7.5, gap: 12, color: rgb(0.4, 0.4, 0.45) });
  text("Spaced repetition and long-term retention in adult learners", { font: bold, size: 18, gap: 22 });
  text("R. Okafor, L. Brandt and S. Yamada · Northwind Institute", { size: 9.5 });
  y -= 6;
  text("ABSTRACT — We followed 412 adults who learned vocabulary in a second language for twelve weeks. Learners who reviewed on an expanding schedule recalled 38 % more words after six months than those who reviewed the same number of times in massed sessions. The effect held across age groups and was largest for words first answered wrongly.", { size: 10 });
  text("1 Introduction", { font: bold, size: 12, gap: 16 });
  text("Most people study the way they were taught at school: in long sessions shortly before they need the material. This feels efficient, because recall during the session is high, yet much of it is gone within weeks. Spacing the same reviews over time slows forgetting, an effect first described by Ebbinghaus and replicated many times since.");
  text("Less is known about how adults use spacing on their own, outside a laboratory, and whether the benefit survives irregular schedules, missed days and the noise of everyday life. This paper reports a field study with an app that scheduled reviews for half of the participants.");
  text("2 Method", { font: bold, size: 12, gap: 16 });
  text("Participants were assigned at random to an expanding group (reviews after 1, 3, 7, 14 and 30 days) or a massed group (five reviews within the first week). Both groups saw each word exactly five times. Retention was measured after one, three and six months with a cued-recall test that neither group had practised.");
  const cols = [60, 200, 280, 370, 460];
  const row = (cells, font = serif) => {
    cells.forEach((c, i) => p.drawText(c, { x: cols[i], y, size: 9.5, font, color: rgb(0.1, 0.1, 0.12) }));
    y -= 15;
  };
  y -= 4;
  p.drawLine({ start: { x: 60, y: y + 13 }, end: { x: 535, y: y + 13 }, thickness: 0.6 });
  row(["Group", "n", "1 month", "3 months", "6 months"], bold);
  row(["Expanding", "206", "71 %", "63 %", "58 %"]);
  const expandingY = y + 15;
  row(["Massed", "206", "62 %", "49 %", "42 %"]);
  p.drawLine({ start: { x: 60, y: y + 10 }, end: { x: 535, y: y + 10 }, thickness: 0.6 });
  y -= 4;
  text("Table 1. Share of words recalled, by group and delay.", { font: italic, size: 8.5, gap: 12 });
  const tableEnd = y;
  y -= 18;
  text("3 Results", { font: bold, size: 12, gap: 16 });
  text("The groups did not differ after the first week. From the first month on, the expanding group recalled more, and the gap widened with time. Missed reviews reduced the benefit only slightly as long as the next review followed within a few days.");
  text("4 Discussion", { font: bold, size: 12, gap: 16 });
  text("For onboarding this suggests short, repeated touches rather than one long tutorial: a hint on the first day, a reminder after three days and a recap after a week.");
  const end = y;
  pageNo = 2;
  p = pdf.addPage([W, H]);
  y = 790;
  text("References", { font: bold, size: 12, gap: 16 });
  text("Ebbinghaus, H. (1885). Über das Gedächtnis. Leipzig: Duncker & Humblot.", { size: 9.5 });
  text("Cepeda, N. J. et al. (2006). Distributed practice in verbal recall tasks. Psychological Bulletin, 132(3).", { size: 9.5 });

  // ---- The annotations (page 1) ----
  highlight("recalled 38 % more words after six months", "h1");
  highlight("Spacing the same reviews over time slows forgetting", "h2");
  highlight("Missed reviews reduced the benefit only slightly", "h3");
  const cx = cols[4] + serif.widthOfTextAtSize("58 %", 9.5) / 2;
  ink1(penPath(loop(cx, top(expandingY) - 3.5, 20, 9, 5), { id: "c1", color: "#1971c2", width: 1.3, seed: 5 }));
  const note = handwriting("+16 points after 6 months !", { x: 360, y: top(tableEnd) + 14, size: 15, seed: 61, color: "#1971c2" });
  ink.push(...note.strokes);
  ink1(penPath([[cx + 8, top(expandingY) + 6], [cx + 2, top(tableEnd) - 2]], { id: "c2", color: "#1971c2", width: 1.1 }));
  const memo = handwriting("good news for our onboarding plan", { x: 300, y: top(end) + 16, size: 15, seed: 62, color: "#1971c2" });
  ink.push(...memo.strokes);
  ink1(penPath([[300, top(end) + 21], [memo.right - 4, top(end) + 22]], { id: "u1", color: "#1971c2", width: 1 }));

  const bytes = await pdf.save();
  return { bytes: Buffer.from(bytes), ink: { format: "flowplan-ink", version: 1, unit: "pt", pages: { 1: ink } } };
}
