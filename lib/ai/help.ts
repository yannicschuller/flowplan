// The Flowplan help as a source for "Ask AI" (lib/ai/ask.ts): the sections
// of docs.flowplan.org that come with the app (lib/ai/help-docs.json, made
// by `npm run help-docs`). Questions about using Flowplan ("How do I …",
// "Where do I set …") find their answer there; the sources link to the
// section on docs.flowplan.org.
import type { Locale } from "../i18n";
import { fold } from "./chunks";
import docs from "./help-docs.json" with { type: "json" };

export type HelpSection = {
  slug: string;
  page: string;
  heading: string;
  anchor: string;
  paragraphs: string[];
};
// Per section: how often each word stem occurs (heading words count four
// times, page title words three) and the section's length.
type Indexed = HelpSection & {
  tf: Map<string, number>;
  pageStems: Set<string>;
  headingStems: Set<string>;
  length: number;
};

export const HELP_URL = "https://docs.flowplan.org";
const helpLocale = (locale: Locale): "de" | "en" =>
  locale === "de" ? "de" : "en";

const runtime = globalThis as unknown as {
  flowplanHelp?: Partial<Record<"de" | "en", Indexed[]>>;
};
function sections(locale: Locale): Indexed[] {
  const lang = helpLocale(locale);
  const cache = (runtime.flowplanHelp ||= {});
  return (cache[lang] ||= (docs as Record<"de" | "en", HelpSection[]>)[
    lang
  ].map((s) => {
    const tf = new Map<string, number>();
    const count = (text: string, weight: number) => {
      for (const word of stems(text))
        tf.set(word, (tf.get(word) || 0) + weight);
    };
    count(s.paragraphs.join(" "), 1);
    count(s.heading, 4);
    count(s.page, 3);
    return {
      ...s,
      tf,
      pageStems: new Set(stems(s.page)),
      headingStems: new Set(stems(s.heading)),
      length: [...tf.values()].reduce((a, b) => a + b, 0),
    };
  }));
}

// Word stems, roughly: folded, without the common German and English
// endings ("exportieren", "exportiere", "Exports" → "export").
const ENDINGS =
  /(ungen|ung|heiten|heit|keiten|keit|ieren|iert|ierst|iere|ing|ern|em|en|er|es|et|st|e|n|s|t)$/;
// Five-letter words too, as long as four letters stay ("teile" → "teil",
// like "teilen"), so a question's short verb forms find the help's infinitives.
export const stem = (word: string) => {
  if (word.length < 5) return word;
  const cut = word.replace(ENDINGS, "");
  return word.length > 5 || cut.length >= 4 ? cut : word;
};
export function stems(text: string): string[] {
  return (fold(text).match(/[\p{L}\p{N}]+/gu) || [])
    .filter((w) => w.length >= 2)
    .map(stem);
}

export const helpUrl = (
  s: Pick<HelpSection, "slug" | "anchor">,
  locale: Locale,
) =>
  `${HELP_URL}/${helpLocale(locale)}/${s.slug}${s.anchor ? `#${s.anchor}` : ""}`;
export const helpTitle = (s: Pick<HelpSection, "page" | "heading">) =>
  s.heading ? `${s.page}: ${s.heading}` : s.page;

// Words of how a question is asked, not what it is about.
const HOW_WORDS = new Set(
  stems(
    "an auf aus bei im in mit für fur zu zum zur von vom der die das den dem des und oder ist sind " +
      "wie was wo wann warum kann konnen könnte muss mache machen lege legen richte richten erstelle erstellen funktioniert funktionieren nutze nutzen benutze benutzen stelle stellen finde finden gibt geht gehen bekomme bekommen ein eins eine einen mein meine meinen meinem meiner dein deine ich du man bitte etwas dort hier " +
      "the to of on in at for with and or is are an " +
      "how what where when why can could does do make create set setting setup use using find get work works there here please my your one",
  ),
);
// The help's words for what people often type.
const SYNONYMS: Record<string, string[]> = {
  "2fa": ["zwei-faktor", "two-factor", "authenticator"],
  mfa: ["zwei-faktor", "two-factor"],
  totp: ["authenticator"],
  login: ["anmeldung", "sign-in"],
  einloggen: ["anmeldung"],
  timeline: ["zeitleiste"],
  zeitleiste: ["timeline"],
  kanban: ["board"],
  backup: ["sicherung"],
  sicherung: ["backup"],
};

// "How do I create …": the question's verb says nothing about the topic, but
// the answer is in the sections that start things – "Erste Schritte",
// "Datenbank anlegen", "Wie ein Workflow beginnt". Their words count half,
// and only in headings.
const CREATE_WORDS = new Set(
  stems(
    "erstelle erstellen erstellt anlegen anlege lege neu neue neuen hinzufügen hinzufuegen create creating new add adding start",
  ),
);
const START_WORDS = stems(
  "anlegen erste schritte beginnt neue create creating first steps getting started new",
);

// The best sections for the question (BM25 over the stems): rare words
// weigh more, a word in the heading most; long sections do not win just by
// being long. Words that are in most sections ("Flowplan", "wie") hardly
// count. A topic word in the page title ("Workflows") leads to that page
// rather than to the "Workflows" paragraph of every other page.
export function helpCandidates(
  locale: Locale,
  terms: string[],
  limit = 6,
): HelpSection[] {
  const all = terms
    .flatMap((t) => [t, ...(SYNONYMS[t] || [])])
    .flatMap((t) =>
      stems(t.replace(/-/g, " ")).concat(
        t.includes("-") ? [stem(t.replace(/-/g, ""))] : [],
      ),
    );
  const words = [...new Set(all.filter((w) => !HOW_WORDS.has(w)))];
  if (!words.length) return [];
  const creating = all.some((w) => CREATE_WORDS.has(w));
  const weights = new Map<string, number>(words.map((w) => [w, 1]));
  if (creating)
    for (const w of START_WORDS) if (!weights.has(w)) weights.set(w, 0.5);
  const list = sections(locale);
  const avg = list.reduce((a, s) => a + s.length, 0) / list.length;
  const k1 = 1.2,
    b = 0.6;
  const idf = new Map(
    [...weights.keys()].map((w) => {
      const df = list.filter((s) => s.tf.has(w)).length;
      return [w, Math.log(1 + (list.length - df + 0.5) / (df + 0.5))];
    }),
  );
  return list
    .map((s) => {
      let score = 0,
        start = 0,
        topic = 0;
      for (const [w, weight] of weights) {
        const f = s.tf.get(w) || 0;
        const part = f
          ? idf.get(w)! *
            ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * s.length) / avg)))
          : 0;
        if (weight === 1) {
          score += part;
          if (s.pageStems.has(w)) topic += idf.get(w)!;
        } else if (s.headingStems.has(w)) start += weight * idf.get(w)!;
      }
      // Only sections about the question's topic get the page's bonus and
      // the "how to start" words.
      return { s, score: score > 0 ? score + topic + start : 0 };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.s);
}
