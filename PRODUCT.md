# Flowplan – Produktkontext

Dauerhafter Kontext für Design- und Produktentscheidungen. Belegt aus
README, `docs/` und dem Code; Offenes ist als offen markiert.

## Was Flowplan ist

Ein selbst betriebener Arbeitsbereich für Dokumente, Wissen, Projekte und
gemeinsames Denken: Dokumente, Datenbanken (Tabelle, Board, Kalender,
Timeline, Galerie, Liste, Feed, Diagramm, Formular) und Whiteboards in einem
Seitenbaum. Orientierung ist der Funktionsumfang von AppFlowy (Referenz
0.14.5), ergänzt um Whiteboards im Stil von Miro. **Bewusst ohne
AI-Funktionen.**

Betrieb: eine Instanz pro Organisation (Next.js, SQLite, ein Container),
Anmeldung über den eigenen OIDC-Anbieter, Administration über eine
Admin-Gruppe. Daten verlassen die eigene Infrastruktur nicht.

## Für wen

- **Teams einer Organisation**, die ihre Inhalte selbst hosten wollen und
  sich über ihren bestehenden Login-Anbieter anmelden.
- **Gäste** mit Freigabelinks (lesen, kommentieren, live mitbearbeiten) und
  anonyme Besucher öffentlicher Seiten und Formulare.
- **Admins** der Instanz, die Konten, Arbeitsbereiche, Speicher und
  Sicherungen verwalten.

**Entwicklungsphase:** vorerst ein eigenes Projekt. Später Open Source oder
ein eigenes Produkt. Daraus folgt: Alles, was mit der App ausgeliefert wird
(Schriften, Symbole, Bilder, Abhängigkeiten), muss unter Lizenzen stehen, die
Weitergabe und kommerzielle Nutzung erlauben.

## Oberflächen und Modus

| Oberfläche | Modus | Erfolg heißt |
| --- | --- | --- |
| Arbeitsbereich: Seitenleiste, Startseite, Suche, Posteingang | Operate | schnell finden und weitermachen |
| Dokument-Editor, Datensatzseiten | Operate | ungestört schreiben und strukturieren |
| Datenbankansichten | Operate | Daten erfassen, sortieren, planen |
| Whiteboard | Operate | gemeinsam denken, workshoppen, präsentieren |
| Einstellungen, Administration | Operate | eine Einstellung finden und sicher ändern |
| Öffentliche Seiten, Vorlagengalerie für Besucher | Read | Inhalt verstehen, ggf. kopieren |
| Anmeldung | Operate | ohne Umweg hinein |
| Desktop-App (Einrichtung, Offline-Seite) | Operate | Server verbinden, Verbindung wiederfinden |

Es gibt keine Marketing-Oberfläche im Projekt.

## Plattformen

- Web, responsiv: Desktop und Mobil (ab ca. 375 px), iOS als Web-App mit
  Push.
- Desktop-Apps für macOS und Windows (Electron-Hülle um die Instanz).
- Hell und Dunkel, Offline-Nutzung per Opt-in, reduzierte Bewegung wird
  respektiert.

## Sprache und Ton

- Oberfläche vollständig **Deutsch**, Anrede **du**.
- Ruhig, konkret, handlungsorientiert: Knöpfe benennen die Handlung
  („Rechte speichern“, „Als erledigt markieren“), Fehlermeldungen sagen, was
  passiert ist und was zu tun ist.
- Keine Werbesprache in der Anwendung; kurze Leitsätze nur an Einstiegen
  (Anmeldung, Startseite).

## Marke

**Entscheidung: Flowplan bekommt eine eigene, unverwechselbare Markenwelt**
statt der geliehenen AppFlowy/Notion-Anmutung. Funktional bleibt AppFlowy die
Referenz, visuell nicht. Die Marke muss

- in einer dichten Arbeitsoberfläche tragen (Operate): Ausdruck in präzisen
  Details, Farbe, Typografie und Bewegung – nicht in Dekoration, die beim
  Arbeiten stört;
- hell und dunkel gleich gut funktionieren;
- ohne externe Dienste auskommen (selbst gehostet, offline-fähig);
- später als Open-Source-Projekt oder Produkt bestehen können.

**Entscheidung: eigene Schrift** statt Systemschrift. Bedingungen: offene
Lizenz (z. B. SIL Open Font License), mit der App ausgeliefert (keine
Google-Fonts-Einbindung), deutsche Zeichen und Tabellenziffern, gut lesbar in
kleinen Größen der Oberfläche. Welche Schrift, ist noch zu entscheiden.

Das bisherige Erscheinungsbild (unten) ist Ausgangspunkt und Beleg dafür, was
funktioniert, aber kein Maßstab für die neue Markenwelt.

## Visuelle Richtung (Ist-Zustand)

- Ruhige, helle Werkzeug-Ästhetik nach dem Vorbild von AppFlowy/Notion:
  viel Weißraum, feine Linien (`--border`), ein Akzent Blau (`--blue`
  #3479e7, dunkel #609cef), abgerundete Ecken, zurückhaltende Schatten.
- Logo: gestapelte Ebenen (Phosphor „Stack“) weiß auf blauem, abgerundetem
  Quadrat.
- Symbole: Phosphor Icons. Schrift: Systemschrift (`public/fonts.css`);
  Seiten wahlweise Serif oder Mono.
- Bewegung: kurze, weiche Übergänge (`--ease-out`, `--ease-spring`),
  Verschieben gleitet nach dem Loslassen an die neue Stelle.
- Eine `DESIGN.md` mit Tokens und Komponentenregeln existiert noch nicht.

## Qualitätsansprüche

- Tastatur und Screenreader: echte Rollen, Beschriftungen, Fokus; native
  Formularelemente bleiben als Basis erhalten (z. B. unter den gestalteten
  Dropdowns).
- Rechte werden serverseitig geprüft; die Oberfläche blendet nur aus, was
  ohnehin verweigert würde.
- Jede Funktion ist mit Kern- und Browser-Tests (Desktop und Mobil)
  abgesichert.

## Nicht-Ziele

- Keine AI-Funktionen.
- Kein Cloud-Dienst des Herstellers; kein Tracking.
- Keine Imitation fremder Marken im Erscheinungsbild – auch nicht von
  AppFlowy, Notion oder Miro.

## Offene Fragen

- Name und Wortmarke: Bleibt es bei „Flowplan“ und dem Ebenen-Logo, oder wird
  beides Teil der neuen Markenwelt?
- Welche Schrift (siehe „Marke“)?
- Konkrete Zielgruppe, sobald das Projekt veröffentlicht wird.
