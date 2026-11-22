// How "Print / PDF" prints here (components/print-page.ts, #424):
//
// - "app": the iPhone/iPad and Android app (flowplan-app) prints itself –
//   their web views ignore window.print() (Android's WebView never prints,
//   a WKWebView only through the app). The page hands the lean copy to
//   FlowplanApp.print, and the app opens the system's print dialog (a
//   printer or "Save as PDF"). Apps before that keep the ways below.
// - "browser": apps on the iPhone and iPad home screen cannot print at all,
//   the print view opens in the browser instead.
// - "in-page": Safari on iPhone and iPad prints the page itself (not a
//   frame), and only while the tap still counts.
// - "frame": everywhere else a hidden frame with the app's styles.
export type PrintWay = "app" | "browser" | "in-page" | "frame";

export function printWay(input: { app?: { print?: unknown } | null; ios: boolean; standalone: boolean }): PrintWay {
  if (typeof input.app?.print === "function") return "app";
  if (input.ios && input.standalone) return "browser";
  if (input.ios) return "in-page";
  return "frame";
}

// The most the app takes in one print request (flowplan-app src/print.ts
// has the same limit): the HTML as characters, pictures included as data.
export const APP_PRINT_MAX_CHARS = 25 * 1024 * 1024;
// Pictures as data for the app: their bytes grow by a third as base64, so
// this leaves room for the text and the styles below the limit.
export const APP_PRINT_IMAGE_BUDGET = 16 * 1024 * 1024;

// What the app's print request carries (FlowplanApp.print).
export type AppPrintRequest = { html: string; title: string; paper: "a4" | "letter" | null };

// A style sheet's text inside the print document, which has no address of
// its own: relative url(…) (fonts, pictures) made absolute against the
// sheet's address. data:, absolute addresses and fragments stay.
export function absoluteCssUrls(css: string, sheetUrl: string): string {
  return css.replace(/url\(\s*(['"]?)([^'")]*?)\1\s*\)/gi, (whole, quote: string, ref: string) => {
    const target = ref.trim();
    if (!target || /^(?:data:|[a-z][a-z0-9+.-]*:|#)/i.test(target)) return whole;
    try {
      return `url(${quote}${new URL(target, sheetUrl).href}${quote})`;
    } catch {
      return whole;
    }
  });
}

// A style sheet's text inside a <style> element: no "</style" can end it early.
export const styleText = (css: string) => css.replace(/<\/(style)/gi, "<\\/$1");
