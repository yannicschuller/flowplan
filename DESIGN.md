# Flowplan – Designsystem „Papier und Tinte“

Verbindliche Gestaltungsregeln für Flowplan. Produktkontext steht in
[PRODUCT.md](PRODUCT.md). Die Tokens leben in `app/globals.css` (`:root` und
`[data-theme="dark"]`); diese Datei erklärt, was sie bedeuten und wann man
sie nimmt.

## Idee

Flowplan ist ein Werkzeug, in dem man stundenlang arbeitet. Die Oberfläche
ist deshalb **warmes Papier mit dunkler Tinte**: ruhige, leicht gelbliche
Neutraltöne statt kaltem Weiß und Grau, ein einziger kräftiger
**Ultramarin**-Akzent für Handlungen und Auswahl, und ein kleiner
**Signalton** (Orange) für seltene, persönliche Momente. Ausdruck entsteht an
den Eingängen (Anmeldung, Startseite) und in präzisen Details – nicht in
Dekoration, die beim Arbeiten stört.

## Farben

| Token | Hell | Dunkel | Verwendung |
| --- | --- | --- | --- |
| `--bg` | `#fcfbf8` | `#16151b` | Seitenfläche, Karten, Editor |
| `--surface` | `#f6f4ef` | `#1d1c23` | abgesetzte Flächen, Tabellenköpfe, Anmeldung |
| `--sidebar` | `#f3f1eb` | `#121117` | Seitenleiste |
| `--hover` | `#ebe8e0` | `#29272f` | Hover- und gedrückte Zustände |
| `--border` | `#e4e0d6` | `#2e2c35` | Linien, Rahmen |
| `--text` | `#1d1c22` | `#ecebf1` | Fließtext, Titel |
| `--secondary` | `#5e5a66` | `#b3afbd` | Beschreibungen, sekundäre Beschriftung |
| `--muted` | `#8a8691` | `#8e8a98` | Metadaten, Platzhalter |
| `--blue` (Akzent) | `#3b3fd8` | `#959bff` | Hauptknöpfe, Auswahl, Links, Fokus |
| `--blue-light` | `#ecebfc` | `#2a2a55` | aktive Einträge, Hinweisflächen |
| `--accent-strong` | `#2c2fb5` | `#b9bcff` | Akzent auf Akzentflächen, Hover des Hauptknopfs |
| `--on-accent` | `#ffffff` | `#121117` | Schrift/Symbol auf `--blue` |
| `--signal` | `#f0663a` | `#ff8a5c` | nur Markenmomente (Punkt der Begrüßung) |

Regeln:

- **Ein Akzent.** Ultramarin ist die einzige Handlungsfarbe. Der Tokenname
  `--blue` bleibt aus Kompatibilitätsgründen.
- Schrift auf Akzentflächen immer `--on-accent` – nie fest `white`, sonst
  kippt der Kontrast im Dunkelmodus (heller Akzent).
- Farben für Inhalte (Auswahloptionen, Whiteboard-Notizen, Diagramme) sind
  Nutzerdaten und folgen nicht dem Markenakzent.
- Keine Farbe fest im Code, wenn ein Token passt. Ausnahmen sind Illustrationen
  mit eigenen Hell/Dunkel-Werten (z. B. `.recent-illustration`).

## Schrift

Alle Schriften stehen unter der SIL Open Font License, liegen in
`public/fonts/` (mit Lizenztexten) und werden über `public/fonts.css`
geladen – keine externen Dienste, offline über den Service Worker verfügbar.

| Token | Schrift | Rolle |
| --- | --- | --- |
| `--font-ui` | **Instrument Sans** (400–700, variable Breite) | gesamte Oberfläche und Dokumente |
| `--font-display` | **Instrument Serif** (400, kursiv) | nur Markenmomente: Anmeldung, Begrüßung der Startseite |
| `--font-mono` | **JetBrains Mono** (100–800) | Code, Tastenkürzel, Monospace-Seiten |

Regeln:

- Grundgröße 14 px, Überschriften mit leicht negativer Laufweite
  (`-0.018em`, Seitentitel `-0.028em`, Gewicht 650).
- Die Serifenschrift erscheint **nur an Eingängen**, nie in Menüs, Tabellen
  oder Dialogen. Sie ist Stimme, keine Arbeitsschrift.
- Zahlen, die verglichen werden (Tabellen, Zähler, Timer, Statistiken),
  nutzen `font-variant-numeric: tabular-nums`.
- Die Seitenoption „Serif“ im Editor bleibt Georgia (Lesetext des Nutzers,
  kein Markenelement).

## Logo

- **Bildmarke:** eine massive Planfläche oben, darunter zwei Ebenen, die
  nach unten „auslaufen“ (Deckkraft 100 % → 72 % → 42 %), weiß auf einer
  abgerundeten Kachel mit Verlauf `#4146e6 → #6a3fe0`. Weiterentwicklung der
  bisherigen Ebenen-Marke.
- **Wortmarke:** `flowplan` klein geschrieben, Instrument Sans, Gewicht
  ~620, Laufweite `-0.035em`.
- Quelle: `components/brand-mark.tsx` (React), `app/icon.svg` und
  `public/icon.svg` (identisch). Die PNGs (`public/icons/*`,
  `desktop/build/icon.png`) werden aus derselben SVG gerendert; das
  Apple-Touch-Icon ist randlos (iOS rundet selbst), das Desktop-Icon hat
  100 px Rand auf 1024 px.
- Mindestgröße 16 px; keine Umfärbung, keine Schatten außer dem
  eingebauten weichen Kachelschatten (`.brand-mark`).

## Form und Tiefe

- `--radius: 10px` für Knöpfe, Felder, Karten; Dialoge und die
  Anmeldekarte runder (16–17 px), Chips und Tags kleiner (4–6 px).
- Linien vor Schatten. Schatten (`--shadow`) nur für schwebende Ebenen:
  Menüs, Dialoge, Popover, gezogene Elemente. Warm getönt, nie grau-blau.

## Bewegung

- Tokens `--ease-out` (Standard) und `--ease-spring` (leichtes Nachfedern
  bei Erscheinen und Markenmomenten).
- Dauer: 120–180 ms für Hover/Zustände, 200–320 ms für Ebenen und
  Seitenwechsel, Gleiten nach dem Verschieben bis 280 ms.
- **Board-Karten** heben sich beim Ziehen ab: eine leicht gekippte Kopie
  (3°, weicher Schatten) folgt dem Zeiger, das Original bleibt als blasser
  Platzhalter stehen, und die Zielspalte öffnet gleitend eine Lücke. Beim
  Loslassen setzt sich die Kopie in die Lücke, die echte Karte übernimmt
  nahtlos. Das Layout ändert sich während des Ziehens nicht (nur
  Verschiebungen per `translate`), Treffer werden gegen die Positionen vom
  Ziehbeginn gerechnet – so springt nichts (`components/board-card-drag.ts`).
- **Blöcke, Listen und Tabellen** zeigen beim Ziehen eine Einfügelinie;
  erst nach dem Loslassen gleitet das Element an die neue Stelle, die
  Blockgriffe gleiten in derselben Animation mit.
- Animationen mit `fill-mode: both` und `transform` nie auf Vorfahren von
  `position: fixed`-Elementen (Vollbild, Popover) – dafür `backwards`.
- `prefers-reduced-motion` schaltet Bewegung ab; Zustandswechsel bleiben
  sichtbar.

## Komponentenregeln (Kurzform)

- **Knöpfe:** `.button` neutral mit Rahmen; `.button.primary` Akzentfläche
  mit `--on-accent`. Pro Bereich höchstens ein Hauptknopf.
- **Auswahllisten:** `components/select.tsx` – natives `<select>` bleibt
  als unsichtbare Basis (Tastatur, Screenreader, Tests), die Liste wird
  gestaltet darüber gerendert.
- **Symbole:** Phosphor Icons, Stärke „regular“, 16–20 px in der
  Oberfläche.
- **Aktiver Eintrag** in Navigation und Tabs: `--blue-light`-Fläche plus
  Akzentschrift.
- **Leere Zustände und Skelette** nutzen `--surface`/`--hover`, keine
  eigenen Grautöne.
