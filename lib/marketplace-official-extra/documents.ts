// Document templates of the marketplace (see ./types.ts). HTML in the
// editor's schema, written with the catalog's helpers.
import { callout, table, task, tasks, toggle } from "../template-catalog";
import type { ExtraDocument } from "./types";

// Key/value rows: the key as a header cell on the left.
const facts = (rows: [string, string][]) => `<table><tbody>${rows.map(([k, v]) => `<tr><th><p>${k}</p></th><td><p>${v}</p></td></tr>`).join("")}</tbody></table>`;
const columns = (...cols: string[]) => `<div data-columns="true">${cols.map((c) => `<div data-column="true">${c}</div>`).join("")}</div>`;

export const extraDocuments: ExtraDocument[] = [
  // ---------------------------------------------------------------- Projekte
  {
    kind: "document",
    id: "project-kickoff",
    category: "projects",
    icon: "🏁",
    title: { de: "Projekt-Kickoff", en: "Project kickoff" },
    tags: ["Kickoff", "Projektstart", "Workshop"],
    summary: {
      de: "Ablauf und Ergebnisse des ersten Projekttreffens: Ziel, Rollen, Spielregeln, Risiken und die ersten Schritte.",
      en: "Agenda and outcomes of the first project meeting: goal, roles, ground rules, risks and the first steps.",
    },
    description: {
      de: "Ein Dokument für den Projektstart.\n\n- **Agenda** mit Zeiten für ein 90-minütiges Treffen\n- **Ziel und Erfolgskriterien**, **Rollen** als Tabelle, **Spielregeln** der Zusammenarbeit\n- **Risiken**, offene Fragen und die **ersten Aufgaben** zum Abhaken\n\nVor dem Termin Agenda und Ziel ausfüllen, im Termin gemeinsam ergänzen.",
      en: "A document for the start of a project.\n\n- an **agenda** with times for a 90-minute meeting\n- **goal and success criteria**, **roles** as a table, **ground rules** for working together\n- **risks**, open questions and the **first tasks** to tick off\n\nFill in the agenda and goal before the meeting, complete the rest together.",
    },
    html:
      "<h2>Kickoff: Projekt …</h2><p><strong>Datum:</strong> </p><p><strong>Teilnehmende:</strong> </p>" +
      "<h2>Agenda</h2>" +
      table([["Zeit", "Thema", "Wer"], ["0:00", "Begrüßung und Kennenlernen", ""], ["0:10", "Warum dieses Projekt? Ziel und Erfolgskriterien", ""], ["0:30", "Umfang: was dazugehört, was nicht", ""], ["0:45", "Rollen und Zusammenarbeit", ""], ["1:05", "Risiken und offene Fragen", ""], ["1:20", "Nächste Schritte", ""]]) +
      "<h2>Ziel</h2>" +
      callout("<p><strong>Am Ende des Projekts …</strong> (ein Satz). Woran merken wir, dass wir es geschafft haben?</p>") +
      "<ul><li><p>Erfolgskriterium 1</p></li><li><p>Erfolgskriterium 2</p></li></ul>" +
      "<h2>Rollen</h2>" +
      table([["Rolle", "Person", "Verantwortung"], ["Auftraggeber·in", "", "Gibt Ziel und Budget vor, nimmt ab"], ["Projektleitung", "", "Plant, koordiniert, berichtet"], ["Team", "", "Setzt um"], ["Beratend", "", "Wird bei Fachfragen einbezogen"]]) +
      "<h2>Spielregeln</h2><ul><li><p>Wo stimmen wir uns ab (Kanal, Termine)?</p></li><li><p>Wie schnell antworten wir?</p></li><li><p>Wo liegen Dokumente und Entscheidungen?</p></li></ul>" +
      "<h2>Risiken und offene Fragen</h2><ul><li><p></p></li></ul>" +
      "<h2>Nächste Schritte</h2>" +
      tasks(task("Projektplan mit Meilensteinen aufsetzen"), task("Regeltermin einladen"), task("Ablage und Kanäle anlegen")),
  },
  {
    kind: "document",
    id: "status-report",
    category: "projects",
    icon: "🚦",
    title: { de: "Projekt-Statusbericht", en: "Project status report" },
    tags: ["Status", "Bericht", "Ampel"],
    summary: {
      de: "Kurzer Statusbericht mit Ampel für Termine, Budget und Umfang, Erreichtem, nächsten Schritten und Entscheidungsbedarf.",
      en: "A short status report with traffic lights for schedule, budget and scope, progress, next steps and decisions needed.",
    },
    description: {
      de: "Für den wöchentlichen oder monatlichen Bericht an Auftraggeber und Lenkungskreis.\n\n- **Gesamtstatus** als Ampel mit einem Satz Begründung\n- Ampeln für **Termine, Budget, Umfang**\n- **Erreicht**, **Als Nächstes**, **Risiken** und **Entscheidungsbedarf**\n\nTipp: Seite je Berichtszeitraum duplizieren, dann bleibt der Verlauf erhalten.",
      en: "For the weekly or monthly report to sponsors and the steering committee.\n\n- **overall status** as a traffic light with a one-sentence reason\n- traffic lights for **schedule, budget, scope**\n- **done**, **next**, **risks** and **decisions needed**\n\nTip: duplicate the page for each reporting period to keep the history.",
    },
    html:
      "<h2>Statusbericht · Zeitraum …</h2>" +
      callout("<p><strong>Gesamtstatus: 🟢 im Plan</strong> – ein Satz, warum. (🟡 gefährdet · 🔴 kritisch)</p>") +
      table([["Bereich", "Status", "Kommentar"], ["Termine", "🟢", ""], ["Budget", "🟢", ""], ["Umfang", "🟡", ""], ["Team", "🟢", ""]]) +
      columns("<h3>Erreicht</h3><ul><li><p></p></li></ul>", "<h3>Als Nächstes</h3><ul><li><p></p></li></ul>") +
      "<h2>Risiken und Probleme</h2>" +
      table([["Risiko", "Auswirkung", "Maßnahme", "Verantwortlich"], ["", "", "", ""]]) +
      "<h2>Entscheidungsbedarf</h2><p>Was muss bis wann von wem entschieden werden?</p><ul><li><p></p></li></ul>" +
      "<h2>Meilensteine</h2>" +
      table([["Meilenstein", "Geplant", "Prognose", "Status"], ["", "", "", ""], ["", "", "", ""]]),
  },
  {
    kind: "document",
    id: "release-notes",
    category: "projects",
    icon: "📣",
    title: { de: "Release Notes", en: "Release notes" },
    tags: ["Release", "Changelog", "Produkt"],
    summary: {
      de: "Versionshinweise für Nutzerinnen und Nutzer: Highlights, Neu, Verbessert, Behoben, wichtige Hinweise und Upgrade-Schritte.",
      en: "Release notes for users: highlights, new, improved, fixed, important notes and upgrade steps.",
    },
    description: {
      de: "Eine Seite pro Version.\n\n- **Highlights** in zwei, drei Sätzen\n- Abschnitte **Neu**, **Verbessert**, **Behoben**\n- **Wichtig vor dem Update** (z. B. geänderte Einstellungen) und **Upgrade** mit Befehl\n- Interne **Checkliste** für die Veröffentlichung zum Aufklappen\n\nSchreibe aus Sicht der Nutzenden: was sie jetzt tun können, nicht was im Code geändert wurde.",
      en: "One page per version.\n\n- **highlights** in two or three sentences\n- sections **new**, **improved**, **fixed**\n- **before you update** (e.g. changed settings) and **upgrade** with a command\n- an internal publishing **checklist** to expand\n\nWrite from the users' point of view: what they can do now, not what changed in the code.",
    },
    html:
      "<h2>Version … – Datum …</h2>" +
      callout("<p><strong>Highlights:</strong> Das Wichtigste dieser Version in zwei, drei Sätzen.</p>") +
      "<h3>✨ Neu</h3><ul><li><p><strong>Funktion:</strong> was man damit jetzt tun kann.</p></li></ul>" +
      "<h3>🛠 Verbessert</h3><ul><li><p></p></li></ul>" +
      "<h3>🐞 Behoben</h3><ul><li><p>Beschreibung des Fehlers aus Sicht der Nutzenden.</p></li></ul>" +
      "<h3>⚠️ Wichtig vor dem Update</h3><p>Geänderte Einstellungen, entfernte Funktionen, nötige Schritte.</p>" +
      "<h3>Upgrade</h3>" +
      '<pre><code class="language-bash"># Beispiel\ndocker compose pull &amp;&amp; docker compose up -d</code></pre>' +
      toggle("Checkliste Veröffentlichung (intern)", tasks(task("Changelog geprüft"), task("Dokumentation aktualisiert"), task("Support informiert"), task("Ankündigung geplant"))),
  },
  // ---------------------------------------------------------------- Meetings
  {
    kind: "document",
    id: "formal-minutes",
    category: "meetings",
    icon: "🖋️",
    title: { de: "Sitzungsprotokoll mit Beschlüssen", en: "Minutes with resolutions" },
    tags: ["Protokoll", "Beschluss", "Verein", "Gremium"],
    summary: {
      de: "Förmliches Protokoll für Vorstand, Verein oder Gremium: Anwesenheit, Beschlussfähigkeit, Tagesordnung, Beschlüsse mit Abstimmungsergebnis.",
      en: "Formal minutes for a board, association or committee: attendance, quorum, agenda, resolutions with voting results.",
    },
    description: {
      de: "Für Sitzungen, deren Beschlüsse nachvollziehbar sein müssen.\n\n- **Kopf** mit Ort, Zeit, Sitzungsleitung und Protokoll\n- **Anwesenheit** und **Beschlussfähigkeit**\n- **Tagesordnung** mit je einem Abschnitt pro Punkt\n- **Beschlüsse** als Tabelle mit Ja/Nein/Enthaltung\n- **Unterschriften**\n\nDie Tagesordnungspunkte vorab eintragen, in der Sitzung nur Ergebnisse ergänzen.",
      en: "For meetings whose decisions must be traceable.\n\n- a **header** with place, time, chair and minute taker\n- **attendance** and **quorum**\n- the **agenda** with one section per item\n- **resolutions** as a table with yes/no/abstain\n- **signatures**\n\nEnter the agenda items beforehand and only add the results during the meeting.",
    },
    html:
      facts([["Sitzung", "…"], ["Datum, Uhrzeit", "… von … bis … Uhr"], ["Ort", ""], ["Sitzungsleitung", ""], ["Protokoll", ""]]) +
      "<h2>Anwesenheit</h2><p><strong>Anwesend:</strong> </p><p><strong>Entschuldigt:</strong> </p><p><strong>Gäste:</strong> </p>" +
      "<p>Die Sitzungsleitung stellt die ordnungsgemäße Einladung und die Beschlussfähigkeit fest.</p>" +
      "<h2>Tagesordnung</h2><ol><li><p>Genehmigung des letzten Protokolls</p></li><li><p>Bericht</p></li><li><p>Beschlussvorlage …</p></li><li><p>Verschiedenes</p></li></ol>" +
      "<h3>TOP 1 – Genehmigung des letzten Protokolls</h3><p></p>" +
      "<h3>TOP 2 – Bericht</h3><p></p>" +
      "<h3>TOP 3 – Beschlussvorlage …</h3><p>Antrag: …</p>" +
      "<h3>TOP 4 – Verschiedenes</h3><p></p>" +
      "<h2>Beschlüsse</h2>" +
      table([["Nr.", "Beschluss", "Ja", "Nein", "Enthaltung"], ["1", "", "", "", ""], ["2", "", "", "", ""]]) +
      "<h2>Aufgaben</h2>" +
      tasks(task("Aufgabe – verantwortlich – bis")) +
      "<p><strong>Nächste Sitzung:</strong> </p><p>Unterschrift Sitzungsleitung: ____________ · Unterschrift Protokoll: ____________</p>",
  },
  {
    kind: "document",
    id: "jour-fixe",
    category: "meetings",
    icon: "📆",
    title: { de: "Jour fixe", en: "Weekly team meeting" },
    tags: ["Jour fixe", "Weekly", "Team"],
    summary: {
      de: "Fortlaufendes Dokument für den wöchentlichen Teamtermin: feste Punkte, Themen zum Sammeln, Ergebnisse und offene Aufgaben.",
      en: "A running document for the weekly team meeting: fixed items, a topic backlog, outcomes and open tasks.",
    },
    description: {
      de: "Ein Dokument für alle Termine eines Teams.\n\n- **Themenspeicher**: alle tragen unter der Woche ein, was besprochen werden soll\n- Ein Abschnitt pro **Termin** mit festen Punkten (Kennzahlen, Blocker, Themen)\n- **Offene Aufgaben** über alle Termine\n\nNeue Termine oben einfügen, ältere in den aufklappbaren Bereich verschieben.",
      en: "One document for all of a team's meetings.\n\n- a **topic backlog** everyone adds to during the week\n- one section per **meeting** with fixed items (numbers, blockers, topics)\n- **open tasks** across meetings\n\nAdd new meetings at the top and move older ones into the collapsible section.",
    },
    html:
      callout("<p>Themen für den nächsten Termin bitte unter <strong>Themenspeicher</strong> eintragen – mit Namen und geschätzter Dauer.</p>") +
      "<h2>Themenspeicher</h2><ul><li><p>Thema (Name, 10 min)</p></li></ul>" +
      "<h2>Termin vom …</h2><p><strong>Moderation:</strong> · <strong>Protokoll:</strong> </p>" +
      "<h3>1. Kurzrunde (5 min)</h3><p>Was ist seit letzter Woche passiert? Wer braucht Hilfe?</p>" +
      "<h3>2. Kennzahlen</h3>" +
      table([["Kennzahl", "Letzte Woche", "Diese Woche", "Ziel"], ["", "", "", ""]]) +
      "<h3>3. Themen</h3><ul><li><p></p></li></ul>" +
      "<h3>Ergebnisse</h3><ul><li><p></p></li></ul>" +
      "<h2>Offene Aufgaben</h2>" +
      tasks(task("Aufgabe – Person – bis wann")) +
      toggle("Frühere Termine", "<p>Ältere Abschnitte hierher verschieben.</p>"),
  },
  {
    kind: "document",
    id: "workshop-plan",
    category: "meetings",
    icon: "🧑‍🏫",
    title: { de: "Workshop-Moderationsplan", en: "Workshop facilitation plan" },
    tags: ["Workshop", "Moderation", "Ablauf"],
    summary: {
      de: "Drehbuch für einen Workshop: Ziel, Ergebnisse, Ablauf mit Methoden und Material, Rollen, Vorbereitung und Nachbereitung.",
      en: "A script for a workshop: goal, outcomes, schedule with methods and materials, roles, preparation and follow-up.",
    },
    description: {
      de: "Plane Workshops so, dass die Zeit für Ergebnisse reicht.\n\n- **Ziel und erwartete Ergebnisse**, Teilnehmende\n- **Ablauf** als Tabelle mit Zeit, Methode, Ergebnis und Material\n- **Rollen** (Moderation, Zeit, Dokumentation)\n- Checklisten für **Vorbereitung** und **Nachbereitung**\n\nPasst gut zu den Whiteboard-Vorlagen für Brainstorming und Retrospektiven.",
      en: "Plan workshops so there is enough time for results.\n\n- **goal and expected outcomes**, participants\n- the **schedule** as a table with time, method, outcome and materials\n- **roles** (facilitation, time keeping, documentation)\n- checklists for **preparation** and **follow-up**\n\nGoes well with the whiteboard templates for brainstorming and retrospectives.",
    },
    html:
      "<h2>Workshop: …</h2><p><strong>Datum und Ort:</strong> · <strong>Dauer:</strong> </p>" +
      callout("<p><strong>Ziel:</strong> Nach dem Workshop haben wir … (konkretes Ergebnis).</p>") +
      "<h2>Teilnehmende</h2><ul><li><p></p></li></ul>" +
      "<h2>Ablauf</h2>" +
      table([["Zeit", "Programmpunkt", "Methode", "Ergebnis", "Material"], ["09:00", "Ankommen, Ziel und Ablauf", "Check-in-Frage", "Alle sind da", ""], ["09:15", "Ist-Stand verstehen", "Kurzvortrag, Fragen", "Gemeinsames Bild", "Folien"], ["09:45", "Ideen sammeln", "Stille Arbeit, dann Cluster", "Ideenliste", "Whiteboard"], ["10:30", "Pause", "", "", ""], ["10:45", "Bewerten und auswählen", "Punkte vergeben", "Top 3", ""], ["11:30", "Nächste Schritte", "Wer, was, bis wann", "Aufgaben", ""], ["11:50", "Abschluss", "Feedback-Runde", "", ""]]) +
      "<h2>Rollen</h2><ul><li><p><strong>Moderation:</strong> </p></li><li><p><strong>Zeit:</strong> </p></li><li><p><strong>Dokumentation:</strong> </p></li></ul>" +
      columns("<h3>Vorbereitung</h3>" + tasks(task("Raum oder Videolink"), task("Einladung mit Ziel und Agenda"), task("Whiteboard vorbereiten"), task("Material und Getränke")), "<h3>Nachbereitung</h3>" + tasks(task("Fotos und Ergebnisse sichern"), task("Protokoll verschicken"), task("Aufgaben eintragen"), task("Feedback auswerten"))),
  },
  {
    kind: "document",
    id: "interview-guide",
    category: "meetings",
    icon: "🎙️",
    title: { de: "Leitfaden Bewerbungsgespräch", en: "Job interview guide" },
    tags: ["Interview", "Recruiting", "Bewerbung"],
    summary: {
      de: "Strukturiertes Bewerbungsgespräch: Ablauf, gleiche Fragen für alle, Bewertung nach Kriterien und eine Empfehlung.",
      en: "A structured job interview: schedule, the same questions for everyone, scoring by criteria and a recommendation.",
    },
    description: {
      de: "Strukturierte Interviews sind fairer und besser vergleichbar.\n\n- **Ablauf** mit Zeiten\n- **Fragen** nach Kompetenz, mit Platz für Notizen\n- **Bewertung** von 1 bis 4 je Kriterium\n- **Empfehlung** und Begründung\n\nVor dem ersten Gespräch die Kriterien zur Stelle anpassen und für alle Bewerbungen beibehalten. Bewertung direkt nach dem Gespräch ausfüllen, bevor man sich mit anderen austauscht.",
      en: "Structured interviews are fairer and easier to compare.\n\n- a **schedule** with times\n- **questions** by competency, with room for notes\n- **scoring** from 1 to 4 per criterion\n- a **recommendation** with reasons\n\nAdapt the criteria to the role before the first interview and keep them for every candidate. Score right after the interview, before talking to others.",
    },
    html:
      "<p><strong>Stelle:</strong> · <strong>Bewerber·in:</strong> · <strong>Datum:</strong> · <strong>Interview:</strong> </p>" +
      "<h2>Ablauf (60 min)</h2><ol><li><p>Begrüßung, Vorstellung, Ablauf (5 min)</p></li><li><p>Werdegang aus Sicht der Person (10 min)</p></li><li><p>Fragen nach Kompetenzen (30 min)</p></li><li><p>Fragen der Person (10 min)</p></li><li><p>Nächste Schritte und Verabschiedung (5 min)</p></li></ol>" +
      "<h2>Fragen</h2>" +
      "<h3>Fachliches</h3><ul><li><p>Erzähl von einem Projekt, auf das du stolz bist. Was war dein Anteil?</p></li><li><p>Wie gehst du vor, wenn du ein Thema neu lernen musst?</p></li></ul><p>Notizen: </p>" +
      "<h3>Zusammenarbeit</h3><ul><li><p>Beschreibe eine Situation, in der du anderer Meinung warst als dein Team. Was hast du getan?</p></li><li><p>Wie gibst du Feedback, wie nimmst du es an?</p></li></ul><p>Notizen: </p>" +
      "<h3>Arbeitsweise</h3><ul><li><p>Wie planst du eine Woche mit mehr Aufgaben als Zeit?</p></li><li><p>Was brauchst du, um gut arbeiten zu können?</p></li></ul><p>Notizen: </p>" +
      "<h2>Bewertung</h2>" +
      table([["Kriterium", "1–4", "Beleg aus dem Gespräch"], ["Fachwissen", "", ""], ["Problemlösen", "", ""], ["Zusammenarbeit", "", ""], ["Kommunikation", "", ""], ["Motivation für die Stelle", "", ""]]) +
      callout("<p>1 = nicht erkennbar · 2 = teilweise · 3 = erfüllt · 4 = deutlich übertroffen. Nur bewerten, was im Gespräch gezeigt wurde.</p>") +
      "<h2>Empfehlung</h2><p>☐ Weiter im Prozess · ☐ Absage</p><p><strong>Begründung:</strong> </p>",
  },
  // ------------------------------------------------------------------ Wissen
  {
    kind: "document",
    id: "architecture-decision-record",
    category: "knowledge",
    icon: "🏛️",
    title: { de: "Architekturentscheidung (ADR)", en: "Architecture decision record (ADR)" },
    tags: ["ADR", "Architektur", "Entscheidung", "Technik"],
    summary: {
      de: "Eine technische Entscheidung im bewährten ADR-Format: Kontext, Entscheidung, betrachtete Alternativen und Konsequenzen.",
      en: "A technical decision in the proven ADR format: context, decision, options considered and consequences.",
    },
    description: {
      de: "Architecture Decision Records halten fest, *warum* etwas so gebaut wurde.\n\n- **Status** (vorgeschlagen, angenommen, abgelöst) und Datum\n- **Kontext**: Problem und Rahmenbedingungen\n- **Entscheidung** in einem Satz\n- **Alternativen** mit Vor- und Nachteilen\n- **Konsequenzen**, positiv wie negativ\n\nEin ADR pro Entscheidung, fortlaufend nummeriert. Wird eine Entscheidung ersetzt, das alte ADR nicht löschen, sondern auf „abgelöst durch …“ setzen.",
      en: "Architecture decision records capture *why* something was built this way.\n\n- **status** (proposed, accepted, superseded) and date\n- **context**: the problem and constraints\n- the **decision** in one sentence\n- **options** with pros and cons\n- **consequences**, good and bad\n\nOne ADR per decision, numbered. When a decision is replaced, do not delete the old ADR – set it to “superseded by …”.",
    },
    html:
      facts([["Nummer", "ADR-…"], ["Status", "Vorgeschlagen"], ["Datum", ""], ["Beteiligte", ""], ["Ersetzt / ersetzt durch", "–"]]) +
      "<h2>Kontext</h2><p>Welches Problem lösen wir? Welche Rahmenbedingungen (Anforderungen, Budget, Team, bestehende Systeme) gelten?</p>" +
      "<h2>Entscheidung</h2>" +
      callout("<p>Wir verwenden … für …, weil …</p>") +
      "<h2>Betrachtete Alternativen</h2>" +
      table([["Option", "Vorteile", "Nachteile"], ["A: …", "", ""], ["B: …", "", ""], ["C: nichts ändern", "", ""]]) +
      "<h2>Konsequenzen</h2><h3>Positiv</h3><ul><li><p></p></li></ul><h3>Negativ und Risiken</h3><ul><li><p></p></li></ul><h3>Folgearbeiten</h3>" +
      tasks(task("")),
  },
  {
    kind: "document",
    id: "rfc-design-doc",
    category: "knowledge",
    icon: "📐",
    title: { de: "RFC / Design-Dokument", en: "RFC / design document" },
    tags: ["RFC", "Design Doc", "Konzept", "Technik"],
    summary: {
      de: "Vorschlag zur Diskussion vor der Umsetzung: Problem, Ziele und Nicht-Ziele, Lösungsentwurf, Alternativen, Risiken, Rollout und offene Fragen.",
      en: "A proposal to discuss before building: problem, goals and non-goals, proposed design, alternatives, risks, rollout and open questions.",
    },
    description: {
      de: "Ein Request for Comments sammelt Feedback, *bevor* Zeit in die Umsetzung fließt.\n\n- **Zusammenfassung** in drei Sätzen\n- **Problem**, **Ziele** und ausdrücklich **Nicht-Ziele**\n- **Entwurf** mit Platz für Diagramme und Schnittstellen\n- **Alternativen**, **Risiken**, **Sicherheit und Datenschutz**\n- **Rollout**, **offene Fragen** und eine Tabelle für **Feedback**\n\nTeile die Seite früh und bitte um Kommentare direkt am Text.",
      en: "A request for comments collects feedback *before* time goes into building.\n\n- a **summary** in three sentences\n- the **problem**, **goals** and explicit **non-goals**\n- the **design**, with room for diagrams and interfaces\n- **alternatives**, **risks**, **security and privacy**\n- **rollout**, **open questions** and a table for **feedback**\n\nShare the page early and ask for comments right on the text.",
    },
    html:
      "<p><strong>Autor·in:</strong> · <strong>Status:</strong> Entwurf · <strong>Feedback bis:</strong> </p>" +
      callout("<p><strong>Zusammenfassung:</strong> Was schlagen wir vor, für wen, und was ändert sich? (höchstens drei Sätze)</p>") +
      "<h2>Problem</h2><p>Was ist heute schwierig? Belege: Zahlen, Rückmeldungen, Vorfälle.</p>" +
      columns("<h3>Ziele</h3><ul><li><p></p></li></ul>", "<h3>Nicht-Ziele</h3><ul><li><p>Was dieser Vorschlag bewusst nicht löst.</p></li></ul>") +
      "<h2>Entwurf</h2><p>Wie funktioniert die Lösung? Komponenten, Datenfluss, Schnittstellen.</p>" +
      '<pre><code class="language-json">{\n  "beispiel": "Schnittstelle oder Datenformat"\n}</code></pre>' +
      "<h2>Alternativen</h2><ul><li><p><strong>Alternative A:</strong> und warum nicht.</p></li></ul>" +
      "<h2>Risiken</h2><ul><li><p></p></li></ul>" +
      "<h2>Sicherheit und Datenschutz</h2><p>Welche Daten sind betroffen? Wer hat Zugriff?</p>" +
      "<h2>Rollout</h2><ol><li><p>Hinter einem Schalter für ein Team</p></li><li><p>Schrittweise für alle</p></li><li><p>Altes Verhalten entfernen</p></li></ol>" +
      "<h2>Offene Fragen</h2><ul><li><p></p></li></ul>" +
      "<h2>Feedback</h2>" +
      table([["Wer", "Einschätzung", "Anmerkung"], ["", "👍 / 🤔 / 👎", ""]]),
  },
  {
    kind: "document",
    id: "standard-operating-procedure",
    category: "knowledge",
    icon: "🧭",
    title: { de: "Standardarbeitsanweisung (SOP)", en: "Standard operating procedure (SOP)" },
    tags: ["SOP", "Prozess", "Arbeitsanweisung", "Qualität"],
    summary: {
      de: "Ein wiederkehrender Ablauf verbindlich beschrieben: Zweck, Geltungsbereich, Verantwortlichkeiten, Schritte, Prüfpunkte und Änderungshistorie.",
      en: "A recurring process described as the binding way to do it: purpose, scope, responsibilities, steps, checks and change history.",
    },
    description: {
      de: "Für Abläufe, die immer gleich und von verschiedenen Personen erledigt werden.\n\n- **Zweck** und **Geltungsbereich**\n- **Verantwortlichkeiten** als Tabelle\n- **Ablauf** als nummerierte Schritte mit Prüfpunkten\n- **Mitgeltende Unterlagen** und **Änderungshistorie**\n\nSchritte so schreiben, dass eine neue Person sie ohne Rückfrage ausführen kann. Mit Seitenverlauf und Freigabe ist jede Version nachvollziehbar.",
      en: "For processes that are always done the same way by different people.\n\n- **purpose** and **scope**\n- **responsibilities** as a table\n- the **procedure** as numbered steps with checks\n- **related documents** and **change history**\n\nWrite the steps so a new person can follow them without asking. Page history and approvals make every version traceable.",
    },
    html:
      facts([["Dokument", "SOP-…"], ["Version", "1.0"], ["Gültig ab", ""], ["Verantwortlich", ""], ["Freigegeben von", ""]]) +
      "<h2>1. Zweck</h2><p>Wozu dient dieser Ablauf?</p>" +
      "<h2>2. Geltungsbereich</h2><p>Für wen und in welchen Fällen gilt er – und wann nicht?</p>" +
      "<h2>3. Verantwortlichkeiten</h2>" +
      table([["Rolle", "Aufgabe"], ["Durchführung", ""], ["Prüfung", ""], ["Freigabe", ""]]) +
      "<h2>4. Ablauf</h2><ol><li><p><strong>Vorbereiten:</strong> Was muss bereitliegen?</p></li><li><p><strong>Durchführen:</strong> Schritt für Schritt, mit Werkzeugen und Werten.</p></li><li><p><strong>Prüfen:</strong> Woran erkenne ich, dass es richtig ist?</p></li><li><p><strong>Dokumentieren:</strong> Wo wird das Ergebnis festgehalten?</p></li></ol>" +
      callout("<p><strong>Prüfpunkt:</strong> Bei Abweichung nicht weitermachen, sondern … informieren.</p>") +
      "<h2>5. Mitgeltende Unterlagen</h2><ul><li><p></p></li></ul>" +
      "<h2>6. Änderungshistorie</h2>" +
      table([["Version", "Datum", "Änderung", "Von"], ["1.0", "", "Erstfassung", ""]]),
  },
  {
    kind: "document",
    id: "incident-postmortem",
    category: "knowledge",
    icon: "🧯",
    title: { de: "Störungsbericht (Postmortem)", en: "Incident postmortem" },
    tags: ["Postmortem", "Störung", "Incident", "Betrieb"],
    summary: {
      de: "Schuldfreie Nachbetrachtung einer Störung: Auswirkung, Zeitverlauf, Ursachen, was gut lief und Maßnahmen mit Verantwortlichen.",
      en: "A blameless review of an incident: impact, timeline, causes, what went well and actions with owners.",
    },
    description: {
      de: "Aus Störungen lernen, ohne Schuldige zu suchen.\n\n- **Zusammenfassung** und **Auswirkung** (wer, wie lange, wie stark)\n- **Zeitverlauf** von der Erkennung bis zur Lösung\n- **Ursachen** mit der Fünf-Warum-Methode\n- **Was lief gut / was nicht / wo hatten wir Glück**\n- **Maßnahmen** zum Abhaken\n\nInnerhalb weniger Tage nach der Störung schreiben, solange die Erinnerung frisch ist.",
      en: "Learn from incidents without looking for someone to blame.\n\n- **summary** and **impact** (who, how long, how badly)\n- the **timeline** from detection to resolution\n- **causes** with the five whys\n- **what went well / what didn't / where we got lucky**\n- **actions** to tick off\n\nWrite it within a few days, while memories are fresh.",
    },
    html:
      callout("<p>Dieser Bericht ist <strong>schuldfrei</strong>: Wir beschreiben Systeme und Abläufe, nicht Fehler von Personen.</p>") +
      facts([["Schweregrad", "SEV-…"], ["Beginn / Ende", ""], ["Dauer", ""], ["Erkannt durch", "Monitoring / Meldung / …"], ["Verantwortlich für den Bericht", ""]]) +
      "<h2>Zusammenfassung</h2><p>Was ist passiert, in zwei, drei Sätzen?</p>" +
      "<h2>Auswirkung</h2><ul><li><p>Betroffene Nutzende oder Kunden: </p></li><li><p>Betroffene Funktionen: </p></li><li><p>Datenverlust: ja / nein</p></li></ul>" +
      "<h2>Zeitverlauf</h2>" +
      table([["Uhrzeit", "Ereignis"], ["", "Erste Auffälligkeit"], ["", "Alarm / Meldung"], ["", "Ursache gefunden"], ["", "Behoben"], ["", "Entwarnung kommuniziert"]]) +
      "<h2>Ursachen</h2><ol><li><p>Warum? </p></li><li><p>Warum? </p></li><li><p>Warum? </p></li><li><p>Warum? </p></li><li><p>Warum? </p></li></ol>" +
      columns("<h3>Was lief gut?</h3><ul><li><p></p></li></ul>", "<h3>Was lief nicht gut?</h3><ul><li><p></p></li></ul>", "<h3>Wo hatten wir Glück?</h3><ul><li><p></p></li></ul>") +
      "<h2>Maßnahmen</h2>" +
      tasks(task("Sofortmaßnahme – verantwortlich – bis"), task("Vorbeugung – verantwortlich – bis"), task("Erkennung verbessern – verantwortlich – bis")),
  },
  {
    kind: "document",
    id: "onboarding-checklist",
    category: "knowledge",
    icon: "👋",
    title: { de: "Onboarding-Checkliste", en: "Onboarding checklist" },
    tags: ["Onboarding", "Einarbeitung", "Team", "HR"],
    summary: {
      de: "Einarbeitung neuer Teammitglieder: Vorbereitung, erster Tag, erste Woche, erster Monat – mit Ansprechpersonen und Feedbackgespräch.",
      en: "Onboarding new team members: preparation, first day, first week, first month – with contacts and a feedback conversation.",
    },
    description: {
      de: "Damit der Start gelingt und nichts vergessen wird.\n\n- **Vor dem ersten Tag**: Zugänge, Arbeitsplatz, Patenschaft\n- **Erster Tag**, **erste Woche**, **erster Monat** als Checklisten\n- **Ansprechpersonen** als Tabelle\n- **Feedbackgespräch** nach 30 Tagen\n\nPro neuer Person einmal kopieren; Aufgaben mit @ einer Person zuweisen.",
      en: "So the start goes well and nothing is forgotten.\n\n- **before day one**: accounts, workplace, buddy\n- **first day**, **first week**, **first month** as checklists\n- **contacts** as a table\n- a **feedback conversation** after 30 days\n\nCopy it once per new person; assign tasks with @.",
    },
    html:
      "<p><strong>Neues Teammitglied:</strong> · <strong>Start:</strong> · <strong>Pate/Patin:</strong> </p>" +
      "<h2>Vor dem ersten Tag</h2>" +
      tasks(task("Arbeitsplatz und Gerät vorbereiten"), task("Konten und Zugänge anlegen"), task("Pate oder Patin bestimmen"), task("Willkommensnachricht mit Ablauf des ersten Tages schicken")) +
      "<h2>Erster Tag</h2>" +
      tasks(task("Begrüßung und Rundgang"), task("Team vorstellen"), task("Gerät einrichten, Anmeldung testen"), task("Gemeinsames Mittagessen")) +
      "<h2>Erste Woche</h2>" +
      tasks(task("Team-Wiki und wichtige Abläufe lesen"), task("Kennenlerntermine mit Schlüsselpersonen"), task("Erste kleine Aufgabe abschließen")) +
      "<h2>Erster Monat</h2>" +
      tasks(task("Ziele für die ersten 90 Tage vereinbaren"), task("An allen Regelterminen teilgenommen"), task("Feedbackgespräch nach 30 Tagen")) +
      "<h2>Ansprechpersonen</h2>" +
      table([["Thema", "Person"], ["Fachliche Fragen", ""], ["Technik und Zugänge", ""], ["Personal und Verwaltung", ""]]) +
      toggle("Feedbackgespräch nach 30 Tagen", "<ul><li><p>Was hat beim Start geholfen?</p></li><li><p>Was hat gefehlt?</p></li><li><p>Was sollten wir für die nächste Person ändern?</p></li></ul>"),
  },
  // ------------------------------------------------------------- Persönlich
  {
    kind: "document",
    id: "weekly-review",
    category: "personal",
    icon: "🗓️",
    title: { de: "Wochenrückblick", en: "Weekly review" },
    tags: ["Review", "Woche", "Selbstorganisation"],
    summary: {
      de: "Die Woche in 20 Minuten abschließen: Eingänge leeren, Rückblick, Erkenntnisse und die drei wichtigsten Dinge der nächsten Woche.",
      en: "Close the week in 20 minutes: clear the inboxes, look back, lessons learned and the three most important things for next week.",
    },
    description: {
      de: "Ein fester Termin am Freitagnachmittag oder Sonntagabend.\n\n- **Aufräumen**: Postfächer, Notizen und Aufgaben durchgehen\n- **Rückblick**: was gut lief, was nicht, was ich gelernt habe\n- **Vorschau**: Termine und die **drei Prioritäten** der nächsten Woche\n- **Energie** von 1 bis 5\n\nPasst zum Journal: als Vorlage für den Wochentag einrichten.",
      en: "A fixed slot on Friday afternoon or Sunday evening.\n\n- **clear up**: go through inboxes, notes and tasks\n- **look back**: what went well, what didn't, what I learned\n- **look ahead**: appointments and the **three priorities** for next week\n- **energy** from 1 to 5\n\nWorks well with the journal: set it up as the template for that weekday.",
    },
    html:
      "<h2>Woche vom …</h2>" +
      "<h3>1. Aufräumen (5 min)</h3>" +
      tasks(task("E-Mail und Nachrichten auf null"), task("Notizen der Woche einsortieren"), task("Aufgabenliste durchgehen, Erledigtes abhaken"), task("Kalender der letzten Woche ansehen: was ist offen geblieben?")) +
      "<h3>2. Rückblick (10 min)</h3>" +
      columns("<p><strong>Gut gelaufen</strong></p><ul><li><p></p></li></ul>", "<p><strong>Nicht so gut</strong></p><ul><li><p></p></li></ul>") +
      "<p><strong>Was ich gelernt habe:</strong> </p><p><strong>Energie diese Woche (1–5):</strong> </p>" +
      "<h3>3. Vorschau (5 min)</h3><p><strong>Wichtige Termine:</strong> </p>" +
      callout("<p><strong>Die drei wichtigsten Dinge nächste Woche</strong></p><ol><li><p></p></li><li><p></p></li><li><p></p></li></ol>") +
      "<p><strong>Worauf ich mich freue:</strong> </p>",
  },
  {
    kind: "document",
    id: "reading-notes",
    category: "personal",
    icon: "🔖",
    title: { de: "Lesenotizen", en: "Reading notes" },
    tags: ["Lesen", "Buch", "Notizen", "Lernen"],
    summary: {
      de: "Notizen zu einem Buch oder Artikel: Kernaussage, wichtigste Ideen, Zitate, eigene Gedanken und was ich umsetzen will.",
      en: "Notes on a book or article: the main message, key ideas, quotes, own thoughts and what I want to put into practice.",
    },
    description: {
      de: "Mehr aus dem Gelesenen mitnehmen.\n\n- **Steckbrief** mit Autor·in, Art und Bewertung\n- **Kernaussage in einem Satz** – der beste Test, ob man es verstanden hat\n- **Wichtigste Ideen**, **Zitate** mit Seitenzahl, **eigene Gedanken**\n- **Umsetzen**: konkrete Aufgaben\n\nAls Inhalt eines Eintrags der Leseliste verwenden oder als eigene Seite mit @-Links zu verwandten Notizen.",
      en: "Get more out of what you read.\n\n- a **profile** with author, type and rating\n- the **main message in one sentence** – the best test of understanding\n- **key ideas**, **quotes** with page numbers, **own thoughts**\n- **put into practice**: concrete tasks\n\nUse it as the content of a reading-list entry or as its own page with @ links to related notes.",
    },
    html:
      facts([["Titel", ""], ["Autor·in", ""], ["Art", "Buch / Artikel / Podcast"], ["Gelesen", ""], ["Bewertung", "☆☆☆☆☆"]]) +
      callout("<p><strong>In einem Satz:</strong> Worum geht es, und was ist die wichtigste Botschaft?</p>") +
      "<h2>Wichtigste Ideen</h2><ol><li><p></p></li><li><p></p></li><li><p></p></li></ol>" +
      "<h2>Zitate</h2><blockquote><p>„…“ (S. …)</p></blockquote>" +
      "<h2>Eigene Gedanken</h2><p>Wo stimme ich zu, wo nicht? Woran erinnert mich das?</p>" +
      "<h2>Umsetzen</h2>" +
      tasks(task("")) +
      "<h2>Weiterlesen</h2><ul><li><p></p></li></ul>",
  },
  {
    kind: "document",
    id: "year-review",
    category: "personal",
    icon: "🎆",
    title: { de: "Jahresrückblick und Ausblick", en: "Year in review and outlook" },
    tags: ["Jahresrückblick", "Ziele", "Reflexion"],
    summary: {
      de: "Das Jahr reflektieren und das nächste planen: Höhepunkte, Lebensbereiche, Gelerntes, Loslassen, Ziele und ein Wort für das neue Jahr.",
      en: "Reflect on the year and plan the next: highlights, areas of life, lessons, letting go, goals and one word for the new year.",
    },
    description: {
      de: "Für einen ruhigen Abend zwischen den Jahren.\n\n- **Rückblick**: Höhepunkte, Herausforderungen, Gelerntes, Dankbarkeit\n- **Lebensbereiche** mit Bewertung von 1 bis 10\n- **Loslassen** und **Mitnehmen**\n- **Ausblick**: ein Wort für das Jahr, Ziele je Bereich, erste Schritte\n\nPasst zum Whiteboard „Lebensrad“.",
      en: "For a quiet evening between the years.\n\n- **look back**: highlights, challenges, lessons, gratitude\n- **areas of life** rated from 1 to 10\n- **let go** and **take along**\n- **look ahead**: a word for the year, goals per area, first steps\n\nGoes well with the “Wheel of life” whiteboard.",
    },
    html:
      "<h2>Rückblick auf das Jahr …</h2>" +
      columns("<h3>Höhepunkte</h3><ul><li><p></p></li></ul>", "<h3>Herausforderungen</h3><ul><li><p></p></li></ul>") +
      "<h3>Was ich gelernt habe</h3><ul><li><p></p></li></ul><h3>Wofür ich dankbar bin</h3><ul><li><p></p></li></ul>" +
      "<h2>Lebensbereiche</h2>" +
      table([["Bereich", "Zufriedenheit (1–10)", "Was hat dazu beigetragen?"], ["Gesundheit", "", ""], ["Beziehungen", "", ""], ["Arbeit", "", ""], ["Finanzen", "", ""], ["Lernen", "", ""], ["Freizeit", "", ""]]) +
      columns("<h3>Loslassen</h3><p>Was nehme ich nicht mit ins neue Jahr?</p>", "<h3>Mitnehmen</h3><p>Was soll bleiben?</p>") +
      "<h2>Ausblick</h2>" +
      callout("<p><strong>Mein Wort für das neue Jahr:</strong> </p>") +
      table([["Bereich", "Ziel", "Erster Schritt"], ["", "", ""], ["", "", ""], ["", "", ""]]) +
      tasks(task("Erste Schritte in den Kalender eintragen"), task("Rückblick in drei Monaten planen")),
  },
];
