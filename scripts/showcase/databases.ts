// The databases of the showcase: team, clients, projects (every property
// type and the classic views), tickets (sprints, epics, workflow,
// automations, time tracking), a content calendar, a client survey and a
// project request form.
import { one, run, id } from "../../lib/db";
import { database } from "../../lib/api";
import { storeSettings } from "../../lib/database-settings";
import { newQuestion, validateSurvey } from "../../lib/survey";
import { formSettings } from "../../lib/forms";
import type { Field } from "../../lib/types";
import { Ctx, view } from "./context";
import { avatar, briefPdf, illustration, palette, screen } from "./assets";
import { h, p, ul, tasks, callout, quote, table } from "./html";

export async function teamDatabase(c: Ctx) {
  const { t } = c;
  const team = c.page("team", "studio", "Team", "database", null, "👥");
  const roles = [t("Design", "Design"), t("Entwicklung", "Engineering"), t("Produkt", "Product"), t("Marketing", "Marketing"), t("Studioleitung", "Studio lead")];
  const fields: Field[] = [
    { id: "title", name: "Name", type: "text" },
    { id: "role", name: t("Rolle", "Role"), type: "select", options: roles },
    { id: "rate", name: t("Stundensatz", "Hourly rate"), type: "number", format: "eur" },
    { id: "email", name: t("E-Mail", "Email"), type: "email" },
    { id: "phone", name: t("Telefon", "Phone"), type: "phone" },
    { id: "location", name: t("Standort", "Location"), type: "select", options: ["Hamburg", "Berlin", t("Remote", "Remote")] },
    { id: "skills", name: t("Fähigkeiten", "Skills"), type: "multiselect", options: ["Figma", "TypeScript", "Research", "SEO", "Motion", "Swift", t("Workshops", "Workshops")] },
    { id: "since", name: t("Dabei seit", "Joined"), type: "date" },
    { id: "member", name: t("Konto", "Account"), type: "person" },
  ];
  c.schema(team, fields, [
    view("gallery", t("Karten", "Cards"), "gallery", { gallery: { cover: "record", fit: "cover", size: "medium" }, hiddenFields: ["phone", "member"] }),
    view("table", t("Tabelle", "Table"), "table", { calculations: { rate: "average" } }),
    view("board", t("Nach Standort", "By location"), "board", { groupBy: "location" }),
  ]);
  const people: [string, string, number, string, string[], string, string][] = [
    ["Mara Klein", roles[0], 95, "Hamburg", ["Figma", "Research", t("Workshops", "Workshops")], "MK", "#e0782c"],
    ["Jonas Weber", roles[1], 105, "Berlin", ["TypeScript", "Swift"], "JW", "#3a6ea5"],
    ["Aylin Demir", roles[2], 100, "Hamburg", ["Research", t("Workshops", "Workshops")], "AD", "#7b5ea7"],
    ["Lukas Brandt", roles[3], 85, t("Remote", "Remote"), ["SEO", "Motion"], "LB", "#2f9e44"],
    [t("Du", "You"), roles[4], 120, "Hamburg", ["Figma", "TypeScript", t("Workshops", "Workshops")], "★", "#14213d"],
  ];
  c.rows.team = {};
  for (const [i, [name, role, rate, location, skills, initials, color]] of people.entries()) {
    const fid = c.file(team, `${initials === "★" ? "you" : initials.toLowerCase()}.jpg`, "image/jpeg", await avatar(initials, color));
    const handle = name.split(" ")[0].toLowerCase().replace("du", "you");
    const rid = c.row(
      team,
      {
        title: name,
        role,
        rate,
        email: `${handle}@northwind.example`,
        phone: `+49 40 5550 10${i}`,
        location,
        skills,
        since: c.day(-(900 - i * 170)),
        ...(i === 4 ? { member: c.me.id } : {}),
      },
      {
        cover: c.url(fid),
        html:
          h(2, t("Steckbrief", "Profile")) +
          p(
            i === 4
              ? t("Das bist du: Nach dem Import zeigen alle Zuweisungen dieses Showcase-Arbeitsbereichs auf dein Konto.", "This is you: after the import every assignment of this showcase workspace points to your account.")
              : t(`${name} ist eine fiktive Person – ein Platzhalter für das Showcase.`, `${name} is a fictional person – a placeholder for the showcase.`),
          ) +
          ul(t("Lieblingswerkzeug: ", "Favourite tool: ") + skills[0], t("Erreichbar: Mo–Do, 9–17 Uhr", "Reachable: Mon–Thu, 9 am–5 pm")),
      },
    );
    c.rows.team[handle] = rid;
  }
  run("UPDATE pages SET icon=? WHERE id=?", "👥", team);
}

export async function clientsAndProjects(c: Ctx) {
  const { t } = c;
  // ---- Clients ------------------------------------------------------------
  const clients = c.page("clients", "studio", t("Kunden", "Clients"), "database", null, "🤝");
  const stages = ["Lead", t("Aktiv", "Active"), t("Pausiert", "Paused")];
  c.schema(
    clients,
    [
      { id: "title", name: t("Firma", "Company"), type: "text" },
      { id: "stage", name: t("Phase", "Stage"), type: "select", options: stages },
      { id: "industry", name: t("Branche", "Industry"), type: "select", options: [t("Mobilität", "Mobility"), t("Gastronomie", "Hospitality"), t("Gesundheit", "Health"), t("Bildung", "Education")] },
      { id: "city", name: t("Stadt", "City"), type: "text" },
      { id: "website", name: "Website", type: "url" },
      { id: "email", name: t("Ansprechpartner E-Mail", "Contact email"), type: "email" },
      { id: "phone", name: t("Telefon", "Phone"), type: "phone" },
      { id: "nextcall", name: t("Nächster Termin", "Next call"), type: "date" },
    ],
    [
      view("gallery", t("Logos", "Logos"), "gallery", { gallery: { cover: "record", fit: "contain", size: "small" } }),
      view("table", t("Alle Kunden", "All clients"), "table"),
      view("board", "Pipeline", "board", { groupBy: "stage" }),
    ],
  );
  const clientData: [string, number, number, string, string][] = [
    ["Velo Urban GmbH", 1, 0, "Hamburg", "#2f9e44"],
    ["Café Lindgren", 1, 1, "Berlin", "#e0782c"],
    ["Praxis am Park", 0, 2, "Köln", "#3a6ea5"],
    ["Lernwerk e.V.", 2, 3, "Leipzig", "#7b5ea7"],
  ];
  const industries = database(clients).fields.find((f) => f.id === "industry")!.options!;
  c.rows.clients = {};
  for (const [i, [name, stage, industry, city, color]] of clientData.entries()) {
    const logo = c.file(clients, `${name.split(" ")[0].toLowerCase()}-logo.jpg`, "image/jpeg", await avatar(name.split(" ").map((w) => w[0]).join("").slice(0, 2), color));
    const slug = name.toLowerCase().replace(/[^a-z]+/g, "-").replace(/^-|-$/g, "");
    c.rows.clients[String(i)] = c.row(
      clients,
      {
        title: name,
        stage: stages[stage],
        industry: industries[industry],
        city,
        website: `https://${slug}.example`,
        email: `kontakt@${slug}.example`,
        phone: `+49 30 5550 2${i}0`,
        nextcall: c.at(2 + i * 3, "10:00"),
      },
      { cover: c.url(logo), icon: ["🚲", "☕", "🩺", "🎓"][i] },
    );
  }

  // ---- Projects: every property type ---------------------------------------
  const projects = c.page("projects", "studio", t("Projekte", "Projects"), "database", null, "🚀");
  const statuses = [t("Idee", "Idea"), t("Angebot", "Proposal"), t("In Arbeit", "In progress"), "Review", t("Abgeschlossen", "Done")];
  const prios = [t("Hoch", "High"), t("Mittel", "Medium"), t("Niedrig", "Low")];
  const N = {
    hours: t("Aufwand (h)", "Effort (h)"),
    rate: t("Ø Stundensatz", "Avg. hourly rate"),
    cost: t("Kosten", "Cost"),
    budget: "Budget",
    margin: t("Marge %", "Margin %"),
    due: t("Deadline", "Deadline"),
  };
  const projectFields: Field[] = [
    { id: "title", name: t("Projekt", "Project"), type: "text" },
    { id: "key", name: "ID", type: "id", prefix: "PRJ" },
    { id: "status", name: "Status", type: "select", options: statuses },
    { id: "priority", name: t("Priorität", "Priority"), type: "select", options: prios },
    { id: "client", name: t("Kunde", "Client"), type: "relation", relationPage: clients },
    { id: "lead", name: t("Leitung", "Lead"), type: "person" },
    { id: "team", name: "Team", type: "relation", relationPage: c.pages.team },
    { id: "start", name: "Start", type: "date" },
    { id: "due", name: N.due, type: "date" },
    { id: "blocked", name: t("Wartet auf", "Waits for"), type: "relation", relationPage: "self" },
    { id: "budget", name: N.budget, type: "number", format: "eur", decimals: 0 },
    { id: "hours", name: N.hours, type: "number", decimals: 1 },
    { id: "rate", name: N.rate, type: "rollup", relationField: "team", rollupField: "rate", aggregate: "average" },
    { id: "cost", name: N.cost, type: "formula", formula: `round(prop("${N.hours}") * prop("${N.rate}"), 0)`, format: "eur" },
    { id: "margin", name: N.margin, type: "formula", formula: `if(prop("${N.budget}") > 0, round((prop("${N.budget}") - prop("${N.cost}")) / prop("${N.budget}") * 100, 0), 0)` },
    { id: "health", name: t("Ampel", "Health"), type: "formula", formula: `if(prop("${N.budget}") > 0, if(prop("${N.margin}") < 15, "🔴", if(prop("${N.margin}") < 30, "🟡", "🟢")), "⚪")` },
    { id: "daysleft", name: t("Tage bis Deadline", "Days to deadline"), type: "formula", formula: `dateBetween(prop("${N.due}"), today(), "days")` },
    { id: "teamsize", name: t("Teamgröße", "Team size"), type: "rollup", relationField: "team", rollupField: "title", aggregate: "count" },
    { id: "tags", name: "Tags", type: "multiselect", options: ["Branding", "Web", "App", "Research", "Content"] },
    { id: "brief", name: "Brief", type: "url" },
    { id: "contact", name: t("Kontakt-E-Mail", "Contact email"), type: "email" },
    { id: "hotline", name: t("Hotline", "Hotline"), type: "phone" },
    { id: "deliverables", name: t("Lieferumfang", "Deliverables"), type: "checklist" },
    { id: "files", name: t("Dateien", "Files"), type: "files" },
    { id: "signed", name: t("Vertrag unterschrieben", "Contract signed"), type: "checkbox" },
    { id: "kickoff", name: t("Kickoff-Zeit", "Kickoff time"), type: "date" },
    { id: "aliases", name: t("Auch bekannt als", "Also known as"), type: "aliases" },
    {
      id: "summary",
      name: t("KI-Kurzfassung", "AI summary"),
      type: "text",
      ai: { prompt: t("Fasse {Projekt} für {Kunde} in einem Satz zusammen. Berücksichtige Status {Status} und Deadline {Deadline}.", "Summarise {Project} for {Client} in one sentence. Consider status {Status} and deadline {Deadline}.") },
    },
    { id: "created", name: t("Erstellt", "Created"), type: "created_at" },
    { id: "edited", name: t("Bearbeitet", "Edited"), type: "updated_at" },
    { id: "creator", name: t("Erstellt von", "Created by"), type: "created_by" },
    { id: "editor", name: t("Bearbeitet von", "Edited by"), type: "updated_by" },
  ];
  projectFields.find((f) => f.id === "blocked")!.relationPage = projects;
  const d0 = database(projects);
  // The client relation is two-way: clients get a "Projects" column.
  c.act({
    action: "database.update",
    pageId: projects,
    version: d0.version,
    fields: projectFields,
    views: d0.views,
    relation: { fieldId: "client", enabled: true, name: t("Projekte", "Projects"), targetVersion: database(clients).version },
  });
  const cf = database(clients).fields;
  const back = cf.find((f) => f.type === "relation")!;
  c.schema(
    clients,
    [
      ...cf,
      { id: "volume", name: t("Auftragsvolumen", "Order volume"), type: "rollup", relationField: back.id, rollupField: "budget", aggregate: "sum", format: "eur" },
      { id: "count", name: t("Anzahl Projekte", "Number of projects"), type: "rollup", relationField: back.id, rollupField: "title", aggregate: "count", rollupDisplay: "bar", rollupMax: 3 },
    ],
    database(clients).views,
  );

  const covers = [
    [palette.sand, palette.clay, palette.rose, palette.sage],
    [palette.night, palette.sky, palette.plum, palette.clay],
    ["#eaf4ef", palette.sage, "#2f9e44", palette.sky],
    ["#f3eefb", palette.plum, palette.rose, palette.sky],
    ["#fff4e6", palette.clay, "#ffd43b", palette.sage],
    ["#e7f5ff", palette.sky, palette.night, palette.sage],
    ["#fdf2f4", palette.rose, palette.plum, palette.sand],
  ];
  const me = c.me.id;
  const tm = c.rows.team;
  type P = { title: string; status: number; prio: number; client: number; team: string[]; start: number; due: number; budget: number; hours: number; tags: string[]; signed: boolean; deliver: [string, boolean][]; html: string; aliases?: string[]; summary: string };
  const list: P[] = [
    {
      title: t("Atlas App – Relaunch", "Atlas app – relaunch"),
      status: 2,
      prio: 0,
      client: 0,
      team: ["mara", "jonas", "aylin"],
      start: -24,
      due: 30,
      budget: 68000,
      hours: 410,
      tags: ["App", "Research"],
      signed: true,
      deliver: [[t("Discovery-Workshop", "Discovery workshop"), true], [t("Klickprototyp", "Clickable prototype"), true], [t("iOS-Beta", "iOS beta"), false], [t("Launch-Kampagne", "Launch campaign"), false]],
      aliases: ["Atlas", "Velo App"],
      summary: t("Neue Leih-App für Velo Urban: Prototyp steht, Beta folgt in vier Wochen.", "New rental app for Velo Urban: prototype done, beta follows in four weeks."),
      html:
        h(2, t("Ziel", "Goal")) +
        p(t("Fahrräder in unter 30 Sekunden ausleihen – ohne Konto-Hürden.", "Rent a bike in under 30 seconds – without account hurdles.")) +
        callout("tip", t("Die Tickets dieses Projekts findest du in der Datenbank „Tickets“ (Präfix ATL).", "The tickets of this project live in the “Tickets” database (prefix ATL).")) +
        h(2, t("Meilensteine", "Milestones")) +
        tasks(
          { text: t("Discovery abgeschlossen", "Discovery finished"), done: true },
          { text: t("Prototyp getestet (8 Interviews)", "Prototype tested (8 interviews)"), done: true },
          { text: t("Beta im TestFlight", "Beta in TestFlight"), due: c.day(12), who: { id: me, name: t("Du", "You") } },
          { text: t("Launch-Kampagne freigeben", "Approve launch campaign"), due: c.day(26) },
        ),
    },
    {
      title: t("Café Lindgren – Markenauftritt", "Café Lindgren – brand identity"),
      status: 3,
      prio: 1,
      client: 1,
      team: ["mara", "lukas"],
      start: -40,
      due: 6,
      budget: 18500,
      hours: 160,
      tags: ["Branding", "Content"],
      signed: true,
      deliver: [[t("Logo und Farben", "Logo and colours"), true], [t("Speisekarte", "Menu"), true], [t("Social-Media-Vorlagen", "Social media templates"), false]],
      summary: t("Neuer Markenauftritt fürs Café, Speisekarte fertig, Review läuft.", "New brand for the café, menu done, review in progress."),
      html: h(2, "Moodboard") + p(t("Skandinavisch, warm, handgemacht. Siehe Whiteboard und Notizbuch.", "Scandinavian, warm, handmade. See the whiteboard and the notebook.")) + quote(t("„Wie ein Sonntagmorgen in Stockholm.“ – Kundin im Kickoff", "“Like a Sunday morning in Stockholm.” – client at the kickoff")),
    },
    {
      title: t("Praxis am Park – Website", "Praxis am Park – website"),
      status: 1,
      prio: 1,
      client: 2,
      team: ["jonas", "lukas"],
      start: 8,
      due: 52,
      budget: 24000,
      hours: 40,
      tags: ["Web"],
      signed: false,
      deliver: [[t("Angebot verschicken", "Send proposal"), true], [t("Sitemap", "Sitemap"), false]],
      summary: t("Angebot für barrierefreie Praxis-Website mit Online-Termin liegt beim Kunden.", "Proposal for an accessible practice website with online booking is with the client."),
      html: h(2, t("Angebot", "Proposal")) + table([[t("Paket", "Package"), t("Tage", "Days"), t("Preis", "Price")], ["Design", "8", "8.800 €"], [t("Entwicklung", "Development"), "12", "13.200 €"], ["SEO", "2", "2.000 €"]]),
    },
    {
      title: t("Lernwerk – Kursplattform", "Lernwerk – course platform"),
      status: 0,
      prio: 2,
      client: 3,
      team: ["aylin"],
      start: 30,
      due: 120,
      budget: 42000,
      hours: 0,
      tags: ["Web", "Research"],
      signed: false,
      deliver: [],
      summary: t("Erste Idee für eine Lernplattform, Gespräch im nächsten Quartal.", "First idea for a learning platform, conversation next quarter."),
      html: p(t("Noch eine Idee – Notizen aus dem Erstgespräch folgen.", "Still an idea – notes from the first call follow.")),
    },
    {
      title: t("Studio-Website 2.0", "Studio website 2.0"),
      status: 2,
      prio: 2,
      client: -1,
      team: ["lukas", "you"],
      start: -10,
      due: 18,
      budget: 8000,
      hours: 70,
      tags: ["Web", "Content"],
      signed: true,
      deliver: [[t("Fallstudien schreiben", "Write case studies"), false], [t("Neue Fotos", "New photos"), true]],
      summary: t("Eigene Website mit neuen Fallstudien, Fotos sind fertig.", "Own website with new case studies, photos are done."),
      html: p(t("Internes Projekt. Texte entstehen im Content-Kalender.", "Internal project. Copy is written in the content calendar.")),
    },
    {
      title: t("Velo Urban – Nutzerforschung", "Velo Urban – user research"),
      status: 4,
      prio: 0,
      client: 0,
      team: ["aylin", "mara"],
      start: -70,
      due: -28,
      budget: 12000,
      hours: 96,
      tags: ["Research"],
      signed: true,
      deliver: [[t("12 Interviews", "12 interviews"), true], [t("Personas", "Personas"), true], [t("Bericht", "Report"), true]],
      summary: t("Abgeschlossene Studie mit 12 Interviews und drei Personas.", "Finished study with 12 interviews and three personas."),
      html: h(2, t("Ergebnis", "Outcome")) + ul(t("Drei Personas", "Three personas"), t("Top-Problem: Kaution bei der Ausleihe", "Top problem: deposit when renting")),
    },
    {
      title: t("Café Lindgren – Onlineshop", "Café Lindgren – online shop"),
      status: 0,
      prio: 2,
      client: 1,
      team: ["jonas"],
      start: 45,
      due: 90,
      budget: 15000,
      hours: 0,
      tags: ["Web"],
      signed: false,
      deliver: [],
      summary: t("Idee: Kaffeebohnen online verkaufen – wartet auf den Markenauftritt.", "Idea: selling coffee beans online – waits for the brand identity."),
      html: p(t("Hängt vom Markenauftritt ab (siehe „Wartet auf“).", "Depends on the brand identity (see “Waits for”).")),
    },
  ];
  c.rows.projects = {};
  const projectIds: string[] = [];
  for (const [i, x] of list.entries()) {
    const coverFile = c.file(projects, `projekt-${i + 1}.jpg`, "image/jpeg", await illustration(covers[i % covers.length], 100 + i));
    const brief =
      i === 0
        ? c.file(
            projects,
            t("Atlas-Briefing.pdf", "Atlas-brief.pdf"),
            "application/pdf",
            await briefPdf({
              title: t("Briefing: Atlas App", "Brief: Atlas app"),
              subtitle: t("Velo Urban GmbH · Relaunch der Leih-App", "Velo Urban GmbH · relaunch of the rental app"),
              footer: t("Fiktives Beispiel für das Flowplan-Showcase", "Fictional example for the Flowplan showcase"),
              sections: [
                { heading: t("Ausgangslage", "Situation"), lines: [t("Die bestehende App braucht im Schnitt 3:40 Minuten bis zur ersten Ausleihe. 38 % brechen bei der Kaution ab.", "The current app takes 3:40 minutes on average until the first rental. 38% drop out at the deposit step.")] },
                { heading: t("Ziel", "Goal"), lines: [t("Ausleihe in unter 30 Sekunden, ohne Kaution, mit Apple Pay und Google Pay.", "Rent in under 30 seconds, without a deposit, with Apple Pay and Google Pay.")] },
                { heading: t("Rahmen", "Scope"), lines: [t("Budget 68.000 €, Beta in acht Wochen, Launch zum Saisonstart.", "Budget €68,000, beta in eight weeks, launch at the start of the season.")] },
              ],
            }),
          )
        : null;
    const rid = c.row(
      projects,
      {
        title: x.title,
        status: statuses[x.status],
        priority: prios[x.prio],
        ...(x.client >= 0 ? { client: [c.rows.clients[String(x.client)]] } : {}),
        lead: me,
        team: x.team.map((k) => tm[k]),
        start: c.day(x.start),
        due: c.day(x.due),
        budget: x.budget,
        hours: x.hours,
        tags: x.tags,
        brief: `https://northwind.example/briefs/${i + 1}`,
        contact: `projekt${i + 1}@northwind.example`,
        hotline: "+49 40 5550 1000",
        deliverables: x.deliver.map(([text, done]) => ({ text, done })),
        files: brief ? [c.url(coverFile), c.url(brief)] : [c.url(coverFile)],
        signed: x.signed,
        kickoff: c.at(x.start, "09:30"),
        ...(x.aliases ? { aliases: x.aliases } : {}),
        summary: x.summary,
      },
      { html: x.html, cover: c.url(coverFile), icon: ["📱", "☕", "🩺", "🎓", "🌐", "🔎", "🛒"][i], created: x.start - 5 },
    );
    projectIds.push(rid);
  }
  // Dependencies for the timeline: the shop waits for the brand identity,
  // the website for the user research.
  c.update(projects, projectIds[6], { blocked: [projectIds[1]] });
  c.update(projects, projectIds[0], { blocked: [projectIds[5]] });
  c.update(projects, projectIds[4], { blocked: [projectIds[1]] });
  c.rows.projects = Object.fromEntries(projectIds.map((rid, i) => [String(i), rid]));
  // A private record: only you (and those you share it with) see it.
  const secret = c.row(
    projects,
    { title: t("Vertraulich: Pitch für „Projekt Nordlicht“", "Confidential: pitch for “Project Northern Light”"), status: statuses[0], priority: prios[0], lead: me, start: c.day(14), due: c.day(21), budget: 90000, hours: 0, tags: ["Branding"] },
    { html: callout("caution", t("Dieser Datensatz ist privat (Datensatz-Menü → Zugriff). Andere Mitglieder sehen ihn nicht.", "This record is private (record menu → Access). Other members do not see it.")), icon: "🔒" },
  );
  c.act({ action: "row.access", pageId: projects, rowId: secret, access: "private", grants: [] });

  // Views: all classic types with filters, groups, calculations.
  const done = statuses[4];
  c.views(projects, [
    view("table", t("Übersicht", "Overview"), "table", {
      default: true,
      calculations: { budget: "sum", hours: "sum", cost: "sum", signed: "percent_checked", margin: "average" },
      hiddenFields: ["contact", "hotline", "kickoff", "creator", "editor", "aliases", "brief"],
      fieldOrder: ["title", "key", "health", "status", "priority", "client", "lead", "team", "start", "due", "daysleft", "budget", "hours", "rate", "cost", "margin", "summary"],
      columnWidths: { title: 280, summary: 360 },
      sorts: [{ field: "due", direction: "asc" }],
    }),
    view("focus", t("Fokus: dringend oder teuer", "Focus: urgent or big"), "table", {
      filterGroup: {
        kind: "group",
        join: "and",
        rules: [
          { kind: "condition", field: "status", op: "neq", value: done },
          {
            kind: "group",
            join: "or",
            rules: [
              { kind: "condition", field: "priority", op: "eq", value: prios[0] },
              { kind: "condition", field: "budget", op: "gte", value: "20000" },
              { kind: "condition", field: "due", op: "in_relative", value: "next_days", days: 14, timeZone: "Europe/Berlin" },
            ],
          },
        ],
      },
      groupBy: "priority",
      groupSettings: { hideEmpty: true, sort: "manual", collapsed: [], order: prios },
    }),
    view("board", "Board", "board", { groupBy: "status", wip: { [statuses[2]]: { max: 3 } }, hiddenFields: ["contact", "hotline"] }),
    view("calendar", t("Kalender", "Calendar"), "calendar", { dateField: "due", calendar: { mode: "month", timeZone: "Europe/Berlin", weekStart: "monday", showWeekends: false } }),
    view("timeline", "Timeline", "timeline", {
      dateField: "start",
      endDateField: "due",
      timeline: { scale: "month", showWeekends: false, dependencyField: "blocked", dependencyType: "fs", moveSuccessors: true, criticalPath: true },
    }),
    view("gallery", t("Galerie", "Gallery"), "gallery", { gallery: { cover: "record", fit: "cover", size: "large" } }),
    view("list", t("Liste nach Kunde", "List by client"), "list", { groupBy: "client" }),
    view("feed", "Feed", "feed", { feed: { content: "compact", showAuthor: true, showDate: true, showComments: true } }),
    view("chart", t("Budget vs. Kosten", "Budget vs. cost"), "chart", {
      chart: { kind: "bar", xField: "status", yField: "budget", aggregate: "sum", dateBucket: "month", order: "label_asc", includeEmpty: false, showValues: true, measures: [{ field: "cost", aggregate: "sum" }], showLegend: true, palette: "warm", valueAxisLabel: "€" },
    }),
    view("form", t("Projekt anlegen", "New project"), "form"),
  ]);
  c.layout(projects, { open: "side", properties: "side", hideEmpty: true, hidden: ["editor", "creator"] });

  // Record templates.
  const tpl = c.row(projects, { title: t("Neues Kundenprojekt", "New client project"), status: statuses[1], priority: prios[1], lead: me, tags: [], deliverables: [{ text: t("Kickoff-Termin", "Kickoff meeting"), done: false }, { text: t("Angebot", "Proposal"), done: false }] }, {
    html: h(2, t("Ziel", "Goal")) + p("") + h(2, t("Ansprechpartner", "Contacts")) + p("") + h(2, t("Offene Fragen", "Open questions")) + tasks({ text: t("Budgetrahmen klären", "Clarify budget") }, { text: t("Entscheider identifizieren", "Identify decision makers") }),
  });
  const tplId = c.act<{ id: string }>({ action: "row.template.save", pageId: projects, rowId: tpl, name: t("Kundenprojekt", "Client project") }).id;
  c.act({ action: "row.template.default", pageId: projects, templateId: tplId, value: true });
  c.act({ action: "row.delete", pageId: projects, rowId: tpl });
  run("DELETE FROM row_trash WHERE id=?", tpl);

  // A repeating entry (series in calendar/timeline) and a repeating task.
  const weekly = c.row(projects, { title: t("Studio-Weekly", "Studio weekly"), status: statuses[2], priority: prios[2], lead: me, start: c.day(-((new Date().getDay() + 6) % 7)), due: c.day(-((new Date().getDay() + 6) % 7)), tags: [] }, { icon: "🔁" });
  run("UPDATE rows SET recurrence=? WHERE id=?", JSON.stringify({ freq: "weekly", interval: 1, count: 26 }), weekly);

  // Discussion on a record.
  const [mara, jonas, aylin] = c.team;
  c.act({ action: "comment.create", pageId: projects, rowId: projectIds[0], body: t("Die Beta-Tester sind eingeladen – 40 Zusagen bisher. 🎉", "Beta testers are invited – 40 sign-ups so far. 🎉") }, jonas.identity);
  c.act({ action: "comment.create", pageId: projects, rowId: projectIds[0], body: t("Super! Ich bereite die Onboarding-Screens für Runde 2 vor.", "Great! I'll prepare the onboarding screens for round 2.") }, mara.identity);
  c.act({ action: "comment.create", pageId: projects, rowId: projectIds[1], body: t("Kundin wünscht die Speisekarte zusätzlich auf Englisch.", "The client also wants the menu in English.") }, aylin.identity);
  return { projects, clients, projectIds };
}

export async function ticketsDatabase(c: Ctx) {
  const { t } = c;
  const tickets = c.page("tickets", "studio", "Tickets – Atlas App", "database", null, "🎫");
  const st = ["Backlog", t("Zu erledigen", "To do"), t("In Arbeit", "In progress"), "Review", t("Erledigt", "Done")];
  const types = ["Epic", "Story", "Bug", t("Aufgabe", "Task")];
  const fields: Field[] = [
    { id: "title", name: t("Titel", "Title"), type: "text" },
    { id: "key", name: "Key", type: "id", prefix: "ATL" },
    { id: "status", name: "Status", type: "select", options: st },
    { id: "type", name: t("Typ", "Type"), type: "select", options: types },
    { id: "parent", name: t("Übergeordnet", "Parent"), type: "relation", parent: true, relationPage: "self" },
    { id: "progress", name: t("Fortschritt", "Progress"), type: "progress" },
    { id: "points", name: "Story Points", type: "number" },
    { id: "assignee", name: t("Zuständig", "Assignee"), type: "person" },
    { id: "due", name: t("Fällig", "Due"), type: "date" },
    { id: "time", name: t("Zeit", "Time"), type: "time" },
    { id: "project", name: t("Projekt", "Project"), type: "relation", relationPage: c.pages.projects },
    { id: "labels", name: "Labels", type: "multiselect", options: ["iOS", "Android", "Backend", "UX", "Copy"] },
  ];
  fields.find((f) => f.id === "parent")!.relationPage = tickets;
  c.schema(tickets, fields, [view("board", "Board", "board", { groupBy: "status" })]);
  const me = c.me.id;
  const atlas = c.rows.projects["0"];
  type T = { title: string; type: number; status: number; points?: number; parent?: number; labels: string[]; due?: number; minutes?: number[]; html?: string; sprint?: number };
  const items: T[] = [
    { title: t("Ausleihe in 30 Sekunden", "Rent in 30 seconds"), type: 0, status: 2, labels: ["UX"], html: p(t("Epic: alles, was die Ausleihe beschleunigt.", "Epic: everything that makes renting faster.")) },
    { title: t("Konto & Bezahlung", "Account & payment"), type: 0, status: 1, labels: ["Backend"] },
    { title: t("QR-Code am Rad scannen", "Scan the QR code on the bike"), type: 1, status: 4, points: 5, parent: 0, labels: ["iOS", "Android"], sprint: 2, minutes: [180, 95] },
    { title: t("Kaution durch Vorautorisierung ersetzen", "Replace deposit with pre-authorisation"), type: 1, status: 3, points: 8, parent: 1, labels: ["Backend"], sprint: 2, minutes: [240, 120, 60], due: 2 },
    { title: t("Onboarding auf drei Screens kürzen", "Cut onboarding to three screens"), type: 1, status: 2, points: 5, parent: 0, labels: ["UX", "Copy"], sprint: 2, minutes: [150], due: 4 },
    { title: t("Karte zeigt freie Räder live", "Map shows available bikes live"), type: 1, status: 4, points: 8, parent: 0, labels: ["iOS", "Backend"], sprint: 2, minutes: [300, 200] },
    { title: t("Absturz beim Öffnen der Karte (iOS 18)", "Crash when opening the map (iOS 18)"), type: 2, status: 4, points: 3, parent: 0, labels: ["iOS"], sprint: 2, minutes: [75], html: h(3, t("Schritte", "Steps")) + p(t("1. App starten 2. Karte öffnen 3. Absturz", "1. Start app 2. Open map 3. Crash")) },
    { title: t("Apple Pay und Google Pay", "Apple Pay and Google Pay"), type: 1, status: 1, points: 8, parent: 1, labels: ["iOS", "Android", "Backend"], sprint: 2, due: 9 },
    { title: t("Fehlermeldungen verständlich formulieren", "Write clear error messages"), type: 3, status: 1, points: 2, parent: 0, labels: ["Copy"], sprint: 2, due: -1 },
    { title: t("Push bei Rückgabe-Erinnerung", "Push for return reminder"), type: 1, status: 0, points: 3, parent: 0, labels: ["iOS", "Android"], sprint: 3 },
    { title: t("Rechnungen als PDF", "Invoices as PDF"), type: 1, status: 0, points: 5, parent: 1, labels: ["Backend"], sprint: 3 },
    { title: t("Dunkler Modus", "Dark mode"), type: 1, status: 0, points: 3, labels: ["UX"] },
    { title: t("Barrierefreiheit prüfen (VoiceOver)", "Accessibility audit (VoiceOver)"), type: 3, status: 0, points: 3, labels: ["UX", "iOS"] },
    // Done in the earlier sprints.
    { title: t("Designsystem in Figma aufsetzen", "Set up the design system in Figma"), type: 3, status: 4, points: 5, labels: ["UX"], sprint: 0, minutes: [240] },
    { title: t("API für Stationen", "API for stations"), type: 1, status: 4, points: 8, labels: ["Backend"], sprint: 0, minutes: [360, 180] },
    { title: t("Login mit Magic Link", "Login with magic link"), type: 1, status: 4, points: 5, parent: 1, labels: ["Backend", "iOS"], sprint: 1, minutes: [200] },
    { title: t("Klickprototyp testen", "Test the clickable prototype"), type: 3, status: 4, points: 3, parent: 0, labels: ["UX"], sprint: 1, minutes: [420] },
  ];
  const ids: string[] = [];
  for (const [i, x] of items.entries()) {
    const rid = c.row(tickets, {
      title: x.title,
      status: st[x.status],
      type: types[x.type],
      ...(x.points ? { points: x.points } : {}),
      ...(x.parent !== undefined ? { parent: [ids[x.parent]] } : {}),
      assignee: me,
      ...(x.due !== undefined ? { due: c.day(x.due) } : {}),
      project: [atlas],
      labels: x.labels,
    }, { html: x.html, created: -40 + i });
    ids.push(rid);
  }
  // Sprints: two closed (velocity), the running one, the next one.
  const today = c.day(0);
  const sprintStart = c.day(-8);
  const sprints = [
    { id: id(), name: "Sprint 12", start: c.day(-36), end: c.day(-23), goal: t("Grundlagen: Designsystem und API", "Foundations: design system and API"), state: "closed" as const, committed: 16, completed: 13, closedAt: new Date(Date.parse(c.day(-22))).toISOString() },
    { id: id(), name: "Sprint 13", start: c.day(-22), end: c.day(-9), goal: t("Login und Prototyp-Test", "Login and prototype test"), state: "closed" as const, committed: 11, completed: 8, closedAt: new Date(Date.parse(c.day(-8))).toISOString() },
    { id: id(), name: "Sprint 14", start: sprintStart, end: c.day(5), goal: t("Ausleihe ohne Kaution – Beta-reif", "Renting without a deposit – ready for beta"), state: "active" as const },
    { id: id(), name: "Sprint 15", start: c.day(6), end: c.day(19), goal: t("Bezahlen und Erinnerungen", "Payments and reminders"), state: "planned" as const },
  ];
  c.act({ action: "sprint.setup", pageId: tickets, viewName: "Sprints" });
  const sprintField = database(tickets).fields.find((f) => f.type === "sprint")!;
  storeSettings(tickets, { sprints, pointsField: "points" });
  void today;
  for (const [i, x] of items.entries()) if (x.sprint !== undefined) c.update(tickets, ids[i], { [sprintField.id]: sprints[x.sprint].id });
  // Done tickets of the running sprint were finished on these days (burndown).
  const doneDays: Record<number, number> = { 2: -6, 5: -3, 6: -2 };
  run("DELETE FROM row_status_log WHERE page_id=?", tickets);
  for (const [i, offset] of Object.entries(doneDays)) run("INSERT INTO row_status_log(id,page_id,row_id,done,at) VALUES(?,?,?,?,?)", id(), tickets, ids[Number(i)], 1, c.ms(offset, 16));
  // Time worked (time tracking with entries).
  for (const [i, x] of items.entries())
    (x.minutes || []).forEach((minutes, n) =>
      c.act({ action: "time.add", pageId: tickets, rowId: ids[i], fieldId: "time", minutes, date: c.day(-30 + i * 2 + n), note: n ? t("Nacharbeit", "Follow-up") : t("Umsetzung", "Implementation") }),
    );
  // Views: board with WIP limits, the sprint view, a tree, a chart, a list.
  const sprintView = database(tickets).views.find((v) => v.type === "sprint")!;
  c.views(tickets, [
    view("board", "Board", "board", { groupBy: "status", default: true, wip: { [st[2]]: { max: 3 }, Review: { max: 2, lock: true } }, hiddenFields: ["project", "time"] }),
    { ...sprintView, name: "Sprints" },
    view("tree", t("Epics & Unteraufgaben", "Epics & subtasks"), "table", { tree: true, hiddenFields: ["project"], calculations: { points: "sum" } }),
    view("open", t("Offen", "Open"), "table", { filters: [{ field: "status", op: "neq", value: st[4] }], sorts: [{ field: "due", direction: "asc" }], hiddenFields: ["project", "parent"] }),
    view("bytype", t("Nach Typ", "By type"), "list", { groupBy: "type", sorts: [{ field: "key", direction: "asc" }] }),
    view("chart", t("Punkte je Status", "Points per status"), "chart", {
      chart: { kind: "bar", xField: "status", yField: "points", aggregate: "sum", dateBucket: "month", order: "label_asc", includeEmpty: false, showValues: true, seriesField: "type", seriesMode: "stacked", showLegend: true },
    }),
    view("cal", t("Fälligkeiten", "Due dates"), "calendar", { dateField: "due" }),
  ]);
  c.layout(tickets, { open: "center", properties: "top", hideEmpty: true, hidden: [] });

  // Record template for the scheduled automation.
  const tpl = c.row(tickets, { title: t("Release-Check", "Release check"), status: st[1], type: types[3], assignee: me, labels: [] }, {
    html: tasks({ text: t("Changelog geschrieben", "Changelog written") }, { text: t("TestFlight-Build hochgeladen", "TestFlight build uploaded") }, { text: t("Crash-Rate geprüft", "Crash rate checked") }),
  });
  const tplId = c.act<{ id: string }>({ action: "row.template.save", pageId: tickets, rowId: tpl, name: t("Release-Check", "Release check") }).id;
  c.act({ action: "row.delete", pageId: tickets, rowId: tpl });
  run("DELETE FROM row_trash WHERE id=?", tpl);

  // Workflow, done rule and automations (after the records, so nothing fires now).
  c.act({
    action: "database.settings",
    pageId: tickets,
    settings: {
      done: { field: "status", values: [st[4]] },
      workflow: {
        field: "status",
        transitions: { Backlog: [st[1]], [st[1]]: [st[2], "Backlog"], [st[2]]: ["Review", st[1]], Review: [st[4], st[2]], [st[4]]: [st[2]] },
        required: { Review: ["assignee", "points"] },
        ownersOnly: [],
      },
      automations: [
        { id: "a-new", name: t("Neue Tickets landen im Backlog", "New tickets land in the backlog"), enabled: true, trigger: { type: "created" }, conditions: [], actions: [{ type: "set", field: "status", value: "Backlog" }, { type: "set", field: "assignee", value: "@actor" }] },
        { id: "a-review", name: t("Review: Zuständige benachrichtigen", "Review: notify the assignee"), enabled: true, trigger: { type: "changed", field: "status", to: "Review" }, conditions: [], actions: [{ type: "notify", to: "field:assignee", message: t("Bitte reviewen 🙏", "Please review 🙏") }] },
        { id: "a-due", name: t("Überfällig: Ersteller informieren", "Overdue: tell the creator"), enabled: true, trigger: { type: "overdue", field: "due" }, conditions: [], actions: [{ type: "notify", to: "@creator", message: t("Ticket ist überfällig.", "Ticket is overdue.") }] },
        { id: "a-bug", name: t("Bugs bekommen das Label iOS", "Bugs get the iOS label"), enabled: false, trigger: { type: "changed", field: "type", to: "Bug" }, conditions: [], actions: [{ type: "set", field: "labels", value: ["iOS"] }] },
        { id: "a-weekly", name: t("Jeden Montag: Release-Check anlegen", "Every Monday: create a release check"), enabled: true, trigger: { type: "schedule", freq: "weekly", interval: 1, weekday: 1, day: 1, time: "09:00", timeZone: "Europe/Berlin" }, conditions: [], actions: [{ type: "create", template: tplId, cells: { type: types[3], labels: ["iOS", "Android"] }, dates: { due: 4 } }] },
      ],
    },
  });
  c.act({ action: "comment.create", pageId: tickets, rowId: ids[3], body: t("Payment-Provider bestätigt: Vorautorisierung über 50 € ist möglich.", "Payment provider confirmed: pre-authorisation of €50 is possible.") }, c.team[1].identity);
  return { tickets, ids };
}

export async function contentCalendar(c: Ctx) {
  const { t } = c;
  const cal = c.page("content", "studio", t("Content-Kalender", "Content calendar"), "database", null, "🗓️");
  const channels = ["Blog", "Newsletter", "LinkedIn", "Instagram"];
  const st = [t("Idee", "Idea"), t("Entwurf", "Draft"), t("Geplant", "Scheduled"), t("Veröffentlicht", "Published")];
  c.schema(
    cal,
    [
      { id: "title", name: t("Beitrag", "Post"), type: "text" },
      { id: "channel", name: t("Kanal", "Channel"), type: "select", options: channels },
      { id: "status", name: "Status", type: "select", options: st },
      { id: "publish", name: t("Veröffentlichung", "Publish at"), type: "date" },
      { id: "author", name: t("Autor:in", "Author"), type: "person" },
      { id: "image", name: t("Bild", "Image"), type: "files" },
      { id: "words", name: t("Wörter", "Words"), type: "number" },
      { id: "project", name: t("Projekt", "Project"), type: "relation", relationPage: c.pages.projects },
    ],
    [view("calendar", t("Monat", "Month"), "calendar", { dateField: "publish", calendar: { mode: "month", timeZone: "Europe/Berlin", weekStart: "monday", showWeekends: true }, default: true })],
  );
  const posts: [string, number, number, number, string, string][] = [
    [t("Fallstudie: Atlas App", "Case study: Atlas app"), 0, 1, 9, "10:00", t("Wie wir die Ausleihe auf 30 Sekunden gekürzt haben.", "How we cut renting down to 30 seconds.")],
    [t("Hinter den Kulissen: Café Lindgren", "Behind the scenes: Café Lindgren"), 3, 2, 3, "12:30", t("Moodboard, Skizzen, finale Farben.", "Moodboard, sketches, final colours.")],
    [t("5 Learnings aus 12 Nutzerinterviews", "5 learnings from 12 user interviews"), 2, 3, -6, "08:00", t("Was wir über Fahrradverleih gelernt haben.", "What we learned about bike rental.")],
    [t("Studio-Update Oktober", "Studio update October"), 1, 3, -12, "09:00", t("Neue Kunden, neues Teammitglied, neue Website.", "New clients, a new team member, a new website.")],
    [t("Barrierefreiheit ist kein Extra", "Accessibility is not an extra"), 0, 0, 20, "10:00", t("Warum wir WCAG ab Tag eins mitdenken.", "Why we consider WCAG from day one.")],
    [t("Teamfoto vom Offsite", "Team photo from the offsite"), 3, 3, -2, "17:00", t("Zwei Tage Ostsee, viele Ideen.", "Two days at the Baltic Sea, lots of ideas.")],
    [t("Designsystem in 10 Minuten erklärt", "Design system explained in 10 minutes"), 2, 1, 15, "08:00", t("Karussell mit 8 Slides.", "Carousel with 8 slides.")],
  ];
  const colors = [[palette.sand, palette.clay, palette.rose, palette.plum], ["#e7f5ff", palette.sky, palette.night, palette.sage], [palette.paper, palette.sage, "#2f9e44", palette.clay]];
  for (const [i, [title, channel, status, offset, time, teaser]] of posts.entries()) {
    const img = c.file(cal, `beitrag-${i + 1}.jpg`, "image/jpeg", i === 0 ? await screen("Atlas", palette.clay, 7) : await illustration(colors[i % 3], 300 + i));
    c.row(
      cal,
      { title, channel: channels[channel], status: st[status], publish: c.at(offset, time), author: c.me.id, image: [c.url(img)], words: [1200, 0, 600, 900, 1500, 0, 400][i], project: i === 0 ? [c.rows.projects["0"]] : i === 1 ? [c.rows.projects["1"]] : [] },
      { html: p(teaser) + (status === 3 ? callout("note", t("Veröffentlicht – Kennzahlen im Dashboard.", "Published – numbers on the dashboard.")) : h(2, t("Entwurf", "Draft")) + p(t("Einleitung … Kernaussage … Call-to-Action.", "Intro … key message … call to action."))), created: Math.min(-1, offset - 10) },
    );
  }
  // A weekly newsletter as a series, a monthly report as a repeating task.
  const nl = c.row(cal, { title: t("Wöchentlicher Newsletter", "Weekly newsletter"), channel: "Newsletter", status: st[2], publish: c.at(((4 - new Date().getDay() + 7) % 7) || 7, "07:30"), author: c.me.id, words: 500 }, { icon: "📬" });
  run("UPDATE rows SET recurrence=? WHERE id=?", JSON.stringify({ freq: "weekly", interval: 1, count: 12 }), nl);
  const rep = c.row(cal, { title: t("Monatsbericht Social Media", "Monthly social media report"), channel: "LinkedIn", status: st[1], publish: c.at(10, "09:00"), author: c.me.id }, { icon: "📈" });
  c.act({ action: "row.repeat", pageId: cal, rowId: rep, version: one<{ version: number }>("SELECT version FROM rows WHERE id=?", rep)!.version, repeat: { freq: "monthly", interval: 1, day: Number(c.day(10).slice(8)), field: "publish" } });
  c.views(cal, [
    view("calendar", t("Monat", "Month"), "calendar", { dateField: "publish", default: true, calendar: { mode: "month", timeZone: "Europe/Berlin", weekStart: "monday", showWeekends: true } }),
    view("week", t("Woche", "Week"), "calendar", { dateField: "publish", calendar: { mode: "week", timeZone: "Europe/Berlin", weekStart: "monday", showWeekends: false } }),
    view("gallery", t("Bilder", "Images"), "gallery", { gallery: { cover: "field", fieldId: "image", fit: "cover", size: "medium" } }),
    view("feed", "Feed", "feed", { feed: { content: "full", showAuthor: true, showDate: true, showComments: true }, sorts: [{ field: "publish", direction: "desc" }] }),
    view("bychannel", t("Nach Kanal", "By channel"), "board", { groupBy: "channel", subGroupBy: "status" }),
    view("chart", t("Beiträge je Monat", "Posts per month"), "chart", { chart: { kind: "line", xField: "publish", aggregate: "count", dateBucket: "month", order: "label_asc", includeEmpty: true, showValues: true, seriesField: "channel", showLegend: true } }),
  ]);
  c.layout(cal, { open: "full", properties: "top", hideEmpty: true, hidden: [] });
  return cal;
}

export async function surveyDatabase(c: Ctx) {
  const { t } = c;
  const survey = c.page("survey", "studio", t("Kundenumfrage 2026", "Client survey 2026"), "database", null, "📋");
  c.schema(survey, [{ id: "title", name: t("Antwort", "Response"), type: "text" }], [view("table", t("Antworten", "Responses"), "table")]);
  const q = (type: Parameters<typeof newQuestion>[0]) => newQuestion(type, c.lang);
  const nps = q("nps"),
    reason = q("long"),
    stars = q("rating"),
    service = q("single"),
    matrix = q("matrix"),
    again = q("yesno"),
    rank = q("ranking"),
    mail = q("email");
  nps.question.required = true;
  reason.question.showIf = { field: nps.question.field, op: "lte", value: "6" };
  service.question.other = true;
  matrix.question.columns = [t("Schwach", "Poor"), t("Okay", "Okay"), t("Gut", "Good"), t("Sehr gut", "Great")];
  matrix.question.rows = [
    { field: `new:${matrix.question.id}-1`, label: t("Kommunikation", "Communication") },
    { field: `new:${matrix.question.id}-2`, label: t("Termintreue", "Timeliness") },
    { field: `new:${matrix.question.id}-3`, label: t("Qualität", "Quality") },
  ];
  mail.question.showIf = { field: again.question.field, op: "is", value: t("Ja", "Yes") };
  const items = [
    { kind: "text" as const, id: "intro", title: t("Danke für die Zusammenarbeit!", "Thanks for working with us!"), body: t("Zwei Minuten, sieben Fragen. Deine Antworten helfen uns, besser zu werden.", "Two minutes, seven questions. Your answers help us improve.") },
    nps.question,
    reason.question,
    stars.question,
    { kind: "page" as const, id: "p2", title: t("Details", "Details") },
    service.question,
    matrix.question,
    rank.question,
    { kind: "page" as const, id: "p3", title: t("Zum Schluss", "Finally") },
    again.question,
    mail.question,
  ];
  const services = [t("Branding", "Branding"), t("Website", "Website"), t("App", "App"), t("Research", "Research")];
  const rankOptions = [t("Preis", "Price"), t("Qualität", "Quality"), t("Tempo", "Speed"), t("Kommunikation", "Communication")];
  const questions = {
    [nps.question.id]: { title: t("Wie wahrscheinlich empfiehlst du Northwind weiter?", "How likely are you to recommend Northwind?") },
    [reason.question.id]: { title: t("Was sollten wir besser machen?", "What should we do better?") },
    [stars.question.id]: { title: t("Wie zufrieden bist du mit dem Ergebnis?", "How satisfied are you with the result?") },
    [service.question.id]: { title: t("Welche Leistung hast du genutzt?", "Which service did you use?"), options: services },
    [matrix.question.id]: { title: t("Wie bewertest du …", "How do you rate …"), options: matrix.question.columns },
    [rank.question.id]: { title: t("Was ist dir am wichtigsten?", "What matters most to you?"), options: rankOptions },
    [again.question.id]: { title: t("Dürfen wir uns für ein Gespräch melden?", "May we contact you for a short call?"), options: [t("Ja", "Yes"), t("Nein", "No")] },
    [mail.question.id]: { title: t("Deine E-Mail-Adresse", "Your email address") },
  };
  c.act({
    action: "survey.save",
    pageId: survey,
    version: database(survey).version,
    survey: { enabled: true, items, onePerPerson: false, progress: true, accent: "orange", welcome: { enabled: true, title: t("Kundenumfrage 2026", "Client survey 2026"), text: t("Anonym, sieben Fragen, zwei Minuten.", "Anonymous, seven questions, two minutes."), button: t("Los geht's", "Let's go") } },
    questions,
    form: { title: t("Kundenumfrage 2026", "Client survey 2026"), submitLabel: t("Absenden", "Submit"), successTitle: t("Danke! 🧡", "Thank you! 🧡"), successMessage: t("Deine Antwort hilft uns sehr.", "Your answer helps us a lot.") },
  });
  const config = formSettings(survey)!.config;
  const stored = config.survey!;
  const fields = database(survey).fields;
  const fid = (draftId: string) => (stored.items.find((i) => i.kind === "question" && i.id === draftId) as { field: string }).field;
  const mq = stored.items.find((i) => i.kind === "question" && i.type === "matrix") as { rows: { field: string }[]; columns: string[] };
  const answers: [number, string, number, number, number[], number, string][] = [
    [10, "", 5, 2, [3, 3, 3], 0, "ana@kunde.example"],
    [9, "", 5, 0, [3, 2, 3], 0, ""],
    [8, "", 4, 1, [2, 2, 3], 1, ""],
    [6, t("Zwischenstände öfter teilen.", "Share progress more often."), 3, 1, [1, 2, 2], 0, "bernd@kunde.example"],
    [10, "", 5, 2, [3, 3, 3], 1, ""],
    [7, "", 4, 3, [2, 3, 2], 1, ""],
    [9, "", 5, 0, [3, 3, 2], 0, ""],
    [4, t("Die Deadline wurde knapp, Kommunikation war zäh.", "The deadline got tight, communication was slow."), 2, 1, [0, 0, 2], 0, "chris@kunde.example"],
    [9, "", 4, 2, [3, 2, 3], 1, ""],
    [10, "", 5, 3, [3, 3, 3], 0, "dana@kunde.example"],
    [8, "", 4, 0, [2, 3, 3], 1, ""],
    [5, t("Preis war höher als gedacht.", "Price was higher than expected."), 3, 1, [2, 1, 3], 1, ""],
  ];
  answers.forEach(([score, why, star, svc, mx, yes, email], i) => {
    const values: Record<string, unknown> = {
      [fid(nps.question.id)]: score,
      ...(why ? { [fid(reason.question.id)]: why } : {}),
      [fid(stars.question.id)]: star,
      [fid(service.question.id)]: services[svc],
      ...Object.fromEntries(mq.rows.map((r, k) => [r.field, mq.columns[mx[k]]])),
      [fid(rank.question.id)]: i % 2 ? [rankOptions[1], rankOptions[3], rankOptions[2], rankOptions[0]] : [rankOptions[1], rankOptions[2], rankOptions[0], rankOptions[3]],
      [fid(again.question.id)]: yes ? t("Nein", "No") : t("Ja", "Yes"),
      ...(email && !yes ? { [fid(mail.question.id)]: email } : {}),
    };
    const checked = validateSurvey(stored, fields, values);
    if (Object.keys(checked.errors).length) throw new Error(`survey answer ${i}: ${JSON.stringify(checked.errors)}`);
    const rid = c.row(survey, { ...checked.cells, title: t(`Antwort ${i + 1}`, `Response ${i + 1}`) }, { created: -20 + i });
    void rid;
  });
  const npsField = fid(nps.question.id);
  const d = database(survey);
  // Averages with one decimal (table footer, dashboard).
  c.schema(survey, d.fields.map((f) => (f.id === npsField || f.id === fid(stars.question.id) ? { ...f, decimals: 1 } : f)), d.views);
  c.views(survey, [
    view("table", t("Antworten", "Responses"), "table", { default: true, sorts: [{ field: npsField, direction: "desc" }], calculations: { [npsField]: "average", [fid(stars.question.id)]: "average" } }),
    view("form", t("Umfrage", "Survey"), "form"),
    view("nps", t("NPS-Verteilung", "NPS distribution"), "chart", { chart: { kind: "bar", xField: npsField, aggregate: "count", dateBucket: "month", order: "label_asc", includeEmpty: false, showValues: true, palette: "cool" } }),
    view("svc", t("Leistungen", "Services"), "chart", { chart: { kind: "donut", xField: fid(service.question.id), aggregate: "count", dateBucket: "month", order: "value_desc", includeEmpty: false, showValues: true, showLegend: true } }),
    view("critics", t("Kritiker (0–6)", "Detractors (0–6)"), "list", { filters: [{ field: npsField, op: "lte", value: "6" }] }),
  ]);
  void d;
  return survey;
}

export async function requestForm(c: Ctx) {
  const { t } = c;
  const req = c.page("requests", "studio", t("Projektanfragen", "Project requests"), "database", null, "📨");
  const kinds = ["Website", "App", "Branding", t("Beratung", "Consulting")];
  const budgets = ["< 10.000 €", "10–30.000 €", "30–80.000 €", "> 80.000 €"];
  const st = [t("Neu", "New"), t("In Prüfung", "Reviewing"), t("Angebot", "Proposal"), t("Abgelehnt", "Declined")];
  c.schema(
    req,
    [
      { id: "title", name: t("Name", "Name"), type: "text" },
      { id: "company", name: t("Firma", "Company"), type: "text" },
      { id: "email", name: t("E-Mail", "Email"), type: "email" },
      { id: "phone", name: t("Telefon", "Phone"), type: "phone" },
      { id: "kind", name: t("Was brauchst du?", "What do you need?"), type: "select", options: kinds },
      { id: "platforms", name: t("Plattformen", "Platforms"), type: "multiselect", options: ["iOS", "Android", "Web"] },
      { id: "budget", name: "Budget", type: "select", options: budgets },
      { id: "deadline", name: t("Wunschtermin", "Target date"), type: "date" },
      { id: "brief", name: t("Worum geht es?", "What is it about?"), type: "text" },
      { id: "nda", name: t("NDA gewünscht", "NDA wanted"), type: "checkbox" },
      { id: "status", name: "Status", type: "select", options: st },
      { id: "owner", name: t("Bearbeitet von", "Handled by"), type: "person" },
    ],
    [view("board", t("Eingang", "Inbox"), "board", { groupBy: "status", default: true }), view("form", t("Anfrageformular", "Request form"), "form"), view("table", t("Tabelle", "Table"), "table")],
  );
  const config = {
    title: t("Projekt anfragen", "Request a project"),
    description: t("Erzähl uns kurz von deinem Vorhaben – wir melden uns innerhalb von zwei Werktagen.", "Tell us briefly about your project – we get back to you within two working days."),
    submitLabel: t("Anfrage senden", "Send request"),
    successTitle: t("Danke, {Name}!", "Thanks, {Name}!"),
    successMessage: t("Wir melden uns bei {E-Mail}.", "We'll get back to you at {Email}."),
    fieldOrder: ["title", "company", "email", "phone", "kind", "platforms", "budget", "deadline", "brief", "nda"],
    hiddenFields: ["status", "owner"],
    requiredFields: ["title", "email", "kind"],
    descriptions: { brief: t("Ziele, Zielgruppe, was es schon gibt.", "Goals, audience, what already exists.") },
    questionStyles: { kind: "buttons", brief: "long" },
    logic: { platforms: { field: "kind", op: "is", value: "App" }, nda: { field: "budget", op: "is", value: budgets[3] } },
    blocks: [
      { id: "b1", kind: "text", before: "title", title: t("Über dich", "About you"), body: "" },
      { id: "b2", kind: "page", before: "kind", title: t("Dein Projekt", "Your project"), body: "" },
      { id: "b3", kind: "text", before: "budget", title: t("Rahmen", "Scope"), body: t("Grobe Angaben reichen völlig.", "Rough numbers are fine.") },
    ],
    progress: true,
    confirmation: { enabled: true, subject: t("Deine Anfrage bei Northwind", "Your request to Northwind"), message: t("Danke für deine Anfrage! Hier eine Kopie deiner Angaben.", "Thanks for your request! Here is a copy of your answers.") },
    notifyMembers: [c.me.id],
  };
  c.act({ action: "form.update", pageId: req, enabled: false, internal: false, anonymous: false, config });
  const sample: [string, string, number, number, string, string, number][] = [
    ["Nina Hoffmann", "Grünzeug Gartenbau", 0, 0, t("Neue Website mit Terminbuchung", "New website with appointment booking"), "", 0],
    ["Tom Becker", "Hafenwerk Logistik", 1, 2, t("Fahrer-App für 300 Mitarbeitende", "Driver app for 300 employees"), "iOS,Android", 1],
    ["Lea Schmitt", "Kaffeerösterei Bohne", 2, 0, t("Verpackungsdesign für drei Sorten", "Packaging design for three blends"), "", 2],
  ];
  for (const [i, [name, company, kind, budget, brief, platforms, status]] of sample.entries())
    c.row(
      req,
      { title: name, company, email: `${name.split(" ")[0].toLowerCase()}@${company.split(" ")[0].toLowerCase()}.example`, kind: kinds[kind], platforms: platforms ? platforms.split(",") : [], budget: budgets[budget], deadline: c.day(40 + i * 20), brief, nda: false, status: st[status], ...(status ? { owner: c.me.id } : {}) },
      { created: -6 + i * 2 },
    );
  return req;
}

