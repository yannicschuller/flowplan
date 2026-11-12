// Workspace looks of the marketplace (see ./types.ts): an accent, one of
// the curated background tints and typefaces Flowplan bundles – never
// uploaded fonts. Every accent is readable as picked in light mode; dark
// mode derives its lighter variant (lib/workspace-theme.ts, checked in
// tests/marketplace-official-extra.test.ts).
import type { ExtraAppearance } from "./types";

const note = {
  de: "Hell oder dunkel bleibt die Wahl jeder Person; die Akzentfarbe wird für beide Modi lesbar abgeleitet. Nur Schriften, die Flowplan mitbringt – nichts wird hochgeladen. Beim Import ersetzt das Erscheinungsbild das bisherige des Arbeitsbereichs (nur Besitzer).",
  en: "Light or dark stays each person's choice; the accent is derived readable for both modes. Only typefaces Flowplan bundles – nothing is uploaded. On import the look replaces the workspace's current one (owners only).",
};
const describe = (de: string, en: string) => ({ de: `${de}\n\n${note.de}`, en: `${en}\n\n${note.en}` });

export const extraAppearances: ExtraAppearance[] = [
  {
    kind: "appearance",
    id: "reading-nook",
    category: "personal",
    language: "multi",
    title: { de: "Leseecke", en: "Reading nook" },
    tags: ["Erscheinungsbild", "Serif", "Warm", "Lesen"],
    summary: {
      de: "Warmes Sepia, ein rostbrauner Akzent und Literata für Überschriften – angenehm für lange Texte, Journal und Notizen.",
      en: "Warm sepia, a rust-brown accent and Literata for headings – pleasant for long texts, journals and notes.",
    },
    description: describe(
      "- **Akzent**: Rostbraun `#9a4a24`\n- **Hintergrund**: Sepia\n- **Schriften**: Source Sans 3 (Oberfläche), Literata (Überschriften), JetBrains Mono (Code)",
      "- **accent**: rust brown `#9a4a24`\n- **background**: sepia\n- **typefaces**: Source Sans 3 (interface), Literata (headings), JetBrains Mono (code)",
    ),
    theme: { accent: "#9a4a24", background: "sepia", fonts: { ui: "source-sans-3", display: "literata" } },
  },
  {
    kind: "appearance",
    id: "calm-focus",
    category: "personal",
    language: "multi",
    title: { de: "Ruhiger Fokus", en: "Calm focus" },
    tags: ["Erscheinungsbild", "Ruhig", "Grün", "Lesbarkeit"],
    summary: {
      de: "Neutrales Grau, ein gedecktes Salbeigrün und die besonders gut lesbare Atkinson Hyperlegible Next – wenig Ablenkung.",
      en: "Neutral grey, a muted sage green and the highly legible Atkinson Hyperlegible Next – few distractions.",
    },
    description: describe(
      "- **Akzent**: Salbeigrün `#3d6b58`\n- **Hintergrund**: Neutral\n- **Schriften**: Atkinson Hyperlegible Next (Oberfläche), Lora (Überschriften)",
      "- **accent**: sage green `#3d6b58`\n- **background**: neutral\n- **typefaces**: Atkinson Hyperlegible Next (interface), Lora (headings)",
    ),
    theme: { accent: "#3d6b58", background: "neutral", fonts: { ui: "atkinson-hyperlegible-next", display: "lora" } },
  },
  {
    kind: "appearance",
    id: "night-owl",
    category: "personal",
    language: "multi",
    title: { de: "Nachteule", en: "Night owl" },
    tags: ["Erscheinungsbild", "Violett", "Kühl", "Modern"],
    summary: {
      de: "Kühle Flächen, ein tiefes Indigo und Lexend als Oberflächenschrift – modern, klar und auch dunkel angenehm.",
      en: "Cool surfaces, a deep indigo and Lexend as the interface face – modern, clear and pleasant in dark mode as well.",
    },
    description: describe(
      "- **Akzent**: Indigo `#4f46c8`\n- **Hintergrund**: Kühl\n- **Schriften**: Lexend (Oberfläche und Überschriften)",
      "- **accent**: indigo `#4f46c8`\n- **background**: cool\n- **typefaces**: Lexend (interface and headings)",
    ),
    theme: { accent: "#4f46c8", background: "cool", fonts: { ui: "lexend", display: "lexend" } },
  },
  {
    kind: "appearance",
    id: "clear-business",
    category: "other",
    language: "multi",
    title: { de: "Klar und sachlich", en: "Clear and businesslike" },
    tags: ["Erscheinungsbild", "Blau", "Business", "Sans"],
    summary: {
      de: "Kühle Flächen, ein klares Blau und IBM Plex für Text, Überschriften und Code – nüchtern und gut für Teams und Kundenportale.",
      en: "Cool surfaces, a clear blue and IBM Plex for text, headings and code – sober and good for teams and customer portals.",
    },
    description: describe(
      "- **Akzent**: Blau `#1f5fbf`\n- **Hintergrund**: Kühl\n- **Schriften**: IBM Plex Sans (Oberfläche und Überschriften), IBM Plex Mono (Code)",
      "- **accent**: blue `#1f5fbf`\n- **background**: cool\n- **typefaces**: IBM Plex Sans (interface and headings), IBM Plex Mono (code)",
    ),
    theme: { accent: "#1f5fbf", background: "cool", fonts: { ui: "ibm-plex-sans", display: "ibm-plex-sans", mono: "ibm-plex-mono" } },
  },
  {
    kind: "appearance",
    id: "editorial",
    category: "other",
    language: "multi",
    title: { de: "Redaktion", en: "Editorial" },
    tags: ["Erscheinungsbild", "Rot", "Serif", "Magazin"],
    summary: {
      de: "Ein kräftiges Dunkelrot, Inter für die Oberfläche und Source Serif 4 für Überschriften – wie ein gut gesetztes Magazin.",
      en: "A strong dark red, Inter for the interface and Source Serif 4 for headings – like a well-set magazine.",
    },
    description: describe(
      "- **Akzent**: Dunkelrot `#b02a24`\n- **Hintergrund**: Standard\n- **Schriften**: Inter (Oberfläche), Source Serif 4 (Überschriften)",
      "- **accent**: dark red `#b02a24`\n- **background**: standard\n- **typefaces**: Inter (interface), Source Serif 4 (headings)",
    ),
    theme: { accent: "#b02a24", fonts: { ui: "inter", display: "source-serif-4" } },
  },
  {
    kind: "appearance",
    id: "workshop-dev",
    category: "other",
    language: "multi",
    title: { de: "Werkstatt", en: "Workshop" },
    tags: ["Erscheinungsbild", "Entwicklung", "Code", "Petrol"],
    summary: {
      de: "Neutrale Flächen, ein Petrol-Akzent, Work Sans und Fira Code mit Ligaturen – für Entwicklungs- und Technikteams.",
      en: "Neutral surfaces, a petrol accent, Work Sans and Fira Code with ligatures – for development and engineering teams.",
    },
    description: describe(
      "- **Akzent**: Petrol `#0f6670`\n- **Hintergrund**: Neutral\n- **Schriften**: Work Sans (Oberfläche und Überschriften), Fira Code (Code)",
      "- **accent**: petrol `#0f6670`\n- **background**: neutral\n- **typefaces**: Work Sans (interface and headings), Fira Code (code)",
    ),
    theme: { accent: "#0f6670", background: "neutral", fonts: { ui: "work-sans", display: "work-sans", mono: "fira-code" } },
  },
  {
    kind: "appearance",
    id: "forest",
    category: "other",
    language: "multi",
    title: { de: "Wald", en: "Forest" },
    tags: ["Erscheinungsbild", "Grün", "Natur", "Serif"],
    summary: {
      de: "Sepia, ein tiefes Waldgrün, Nunito Sans und Merriweather – freundlich und natürlich, etwa für Vereine und Bildung.",
      en: "Sepia, a deep forest green, Nunito Sans and Merriweather – friendly and natural, e.g. for associations and education.",
    },
    description: describe(
      "- **Akzent**: Waldgrün `#2f6b3a`\n- **Hintergrund**: Sepia\n- **Schriften**: Nunito Sans (Oberfläche), Merriweather (Überschriften)",
      "- **accent**: forest green `#2f6b3a`\n- **background**: sepia\n- **typefaces**: Nunito Sans (interface), Merriweather (headings)",
    ),
    theme: { accent: "#2f6b3a", background: "sepia", fonts: { ui: "nunito-sans", display: "merriweather" } },
  },
];
