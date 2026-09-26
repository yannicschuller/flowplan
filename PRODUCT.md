# Flowplan – Produktkontext

Dauerhafter Kontext für Design- und Produktentscheidungen. Belegt aus
README, `docs/` und dem Code; Offenes ist als offen markiert.

## Was Flowplan ist

Ein selbst betriebener Arbeitsbereich für Dokumente, Wissen, Projekte und
gemeinsames Denken: Dokumente, Datenbanken (Tabelle, Board, Kalender,
Timeline, Galerie, Liste, Feed, Diagramm, Formular), Whiteboards und Journale
in einem Seitenbaum. Ein **Journal** legt jeden Tag eine Tagesseite an
(Tagebuch und Aufgaben): offene Aufgaben wandern in den neuen Tag, Tage ohne
eigenen Eintrag werden wieder entfernt. Orientierung ist der Funktionsumfang von AppFlowy (Referenz
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
| Journal und Tagesseiten | Operate | den Tag festhalten, Offenes nicht verlieren |
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
kleinen Größen der Oberfläche. Gewählt: Instrument Sans (Oberfläche),
Instrument Serif (nur Markenmomente), JetBrains Mono (Code).

**Entscheidung: Name und Logo.** Der Name „Flowplan“ bleibt. Das Logo wird
aus der bisherigen Ebenen-Marke weiterentwickelt (eigene Bildmarke statt
Phosphor-Symbol). Details, Farben und Regeln stehen in
[DESIGN.md](DESIGN.md).

Das bisherige Erscheinungsbild (unten) ist Ausgangspunkt und Beleg dafür, was
funktioniert, aber kein Maßstab für die neue Markenwelt.

## Visuelle Richtung

„Papier und Tinte“: warme Neutraltöne, ein Ultramarin-Akzent, ein seltener
Signalton, eigene Schriften und eine eigene Bildmarke. Verbindlich
beschrieben in [DESIGN.md](DESIGN.md). Die frühere AppFlowy/Notion-nahe
Anmutung (kühles Weiß, Blau `#3479e7`, Systemschrift, Phosphor-„Stack“ als
Logo) ist abgelöst.

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

- Konkrete Zielgruppe, sobald das Projekt veröffentlicht wird.
