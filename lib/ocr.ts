import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

// Text recognition for scanned PDFs and images. The language data ships
// with the app and is never downloaded at runtime: German, English, French
// and Simplified Chinese. FLOWPLAN_OCR_LANGS chooses the languages that are
// loaded, e.g. "fra,eng" or "chi_sim,eng"; the first one is the main
// language. Every extra language costs memory and time per page (Chinese
// most: about 100 MB more), so the default stays German and English.
export const OCR_LANGUAGES = ["deu", "eng", "fra", "chi_sim"] as const;
type Language = (typeof OCR_LANGUAGES)[number];
const DEFAULT_LANGUAGES: Language[] = ["deu", "eng"];
const isLanguage = (value: string): value is Language =>
  (OCR_LANGUAGES as readonly string[]).includes(value);
// Unknown codes are ignored (they also name files); nothing valid left
// means the default.
export function ocrLanguages(setting = process.env.FLOWPLAN_OCR_LANGS): Language[] {
  const chosen = [
    ...new Set(
      (setting || "")
        .split(/[,+\s]+/)
        .map((code) => code.trim().toLowerCase())
        .filter(isLanguage),
    ),
  ];
  return chosen.length ? chosen : DEFAULT_LANGUAGES;
}
type Worker = Awaited<ReturnType<typeof import("tesseract.js").createWorker>>;
const runtime = globalThis as typeof globalThis & {
  flowplanOcr?: Promise<Worker>;
};
function languageDir(languages: Language[]) {
  const dir = resolve(/*turbopackIgnore: true*/ process.env.FLOWPLAN_DATA_DIR || "./data", "ocr");
  mkdirSync(dir, { recursive: true });
  // Bundlers rewrite require.resolve, so the packages are found through the
  // app's node_modules (the same layout in development and standalone).
  // Not traced from here (the tracing would take the packages' folders
  // whole, the unused 4.0.0_best_int models too): next.config.ts lists
  // the files.
  for (const lang of languages) {
    const target = join(dir, `${lang}.traineddata.gz`);
    if (existsSync(target)) continue;
    copyFileSync(
      join(
        /*turbopackIgnore: true*/ process.cwd(),
        "node_modules",
        "@tesseract.js-data",
        lang,
        "4.0.0",
        `${lang}.traineddata.gz`,
      ),
      target,
    );
  }
  return dir;
}
async function worker() {
  runtime.flowplanOcr ??= (async () => {
    const { createWorker } = await import("tesseract.js");
    const languages = ocrLanguages();
    const dir = languageDir(languages);
    const ocr = await createWorker(languages, 1, {
      langPath: dir,
      cachePath: dir,
      gzip: true,
      logger: () => undefined,
      errorHandler: () => undefined,
    });
    // Tesseract treats every Chinese character as a word and puts a space
    // between them ("发 票 编 号"); with this setting spaces only stand where
    // the page has a gap. Latin text is unchanged (ocrImage collapses runs
    // of spaces), but the default languages keep Tesseract's own behaviour.
    if (languages.includes("chi_sim"))
      await ocr.setParameters({ preserve_interword_spaces: "1" });
    return ocr;
  })();
  try {
    return await runtime.flowplanOcr;
  } catch (error) {
    runtime.flowplanOcr = undefined;
    throw error;
  }
}
export async function ocrImage(image: Buffer) {
  const { data } = await (await worker()).recognize(image);
  return data.text
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
export async function stopOcr() {
  const current = runtime.flowplanOcr;
  runtime.flowplanOcr = undefined;
  if (current) await (await current).terminate();
}
