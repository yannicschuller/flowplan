// The templates that come with Flowplan, in English (same keys, ids and
// structure as lib/template-catalog.ts). Client-safe: plain data only.
import type { View } from "./types";
import {
  callout,
  table,
  task,
  tasks,
  toggle,
  view,
  type CatalogTemplate,
  type TemplateKey,
} from "./template-catalog";

export const templateCatalogEn: Record<TemplateKey, CatalogTemplate> = {
  // ---------------------------------------------------------------- Projects
  project: {
    name: "Project plan",
    category: "projects",
    icon: "🚀",
    kind: "database",
    description: "Tasks with status, period, effort and a timeline for one project.",
    fields: [
      { id: "title", name: "Task", type: "text" },
      { id: "status", name: "Status", type: "select", options: ["Not started", "In progress", "Done"] },
      { id: "priority", name: "Priority", type: "select", options: ["High", "Medium", "Low"] },
      { id: "start", name: "Start", type: "date" },
      { id: "date", name: "Due", type: "date" },
      { id: "assignee", name: "Assignee", type: "person" },
      { id: "effort", name: "Effort (h)", type: "number" },
    ],
    views: [
      view("table", "All tasks", "table"),
      view("board", "Board", "board", { groupBy: "status" }),
      view("timeline", "Timeline", "timeline", { dateField: "start", endDateField: "date" }),
      view("calendar", "Calendar", "calendar", { dateField: "date" }),
    ],
    rows: [
      { cells: { title: "Set the project goal and success criteria", status: "Done", priority: "High", start: "@-6", date: "@-4", effort: 4 }, content: "<h2>Outcome</h2><p>One sentence that says how we measure success.</p>" },
      { cells: { title: "Plan milestones", status: "In progress", priority: "High", start: "@-2", date: "@+3", effort: 6 } },
      { cells: { title: "Build phase 1", status: "Not started", priority: "Medium", start: "@+3", date: "@+14", effort: 24 } },
      { cells: { title: "Document the project close", status: "Not started", priority: "Low", start: "@+14", date: "@+16", effort: 3 } },
    ],
  },
  roadmap: {
    name: "Product roadmap",
    category: "projects",
    icon: "🎯",
    kind: "database",
    description: "Topics by quarter and status, with a board and a timeline for planning.",
    fields: [
      { id: "title", name: "Topic", type: "text" },
      { id: "status", name: "Status", type: "select", options: ["Idea", "Planned", "In progress", "Shipped"] },
      { id: "quarter", name: "Quarter", type: "select", options: ["Q1", "Q2", "Q3", "Q4"] },
      { id: "area", name: "Area", type: "multiselect", options: ["Design", "Product", "Engineering", "Marketing"] },
      { id: "start", name: "Start", type: "date" },
      { id: "end", name: "End", type: "date" },
      { id: "impact", name: "Impact (1–5)", type: "number" },
    ],
    views: [
      view("board", "By status", "board", { groupBy: "status" }),
      view("quarters", "By quarter", "board", { groupBy: "quarter" }),
      view("timeline", "Timeline", "timeline", { dateField: "start", endDateField: "end" }),
      view("table", "Table", "table"),
    ],
    rows: [
      { cells: { title: "New onboarding", status: "In progress", quarter: "Q3", area: ["Design", "Product"], start: "@-10", end: "@+20", impact: 5 } },
      { cells: { title: "Mobile app", status: "Planned", quarter: "Q4", area: ["Engineering"], start: "@+25", end: "@+80", impact: 4 } },
      { cells: { title: "Rework the pricing page", status: "Idea", quarter: "Q4", area: ["Marketing"], impact: 3 } },
      { cells: { title: "Dark theme", status: "Shipped", quarter: "Q2", area: ["Design"], start: "@-60", end: "@-30", impact: 2 } },
    ],
  },
  sprint: {
    name: "Sprint board",
    category: "projects",
    icon: "⚡",
    kind: "database",
    description: "Kanban for two-week sprints with story points and assignees.",
    fields: [
      { id: "title", name: "Story", type: "text" },
      { id: "status", name: "Status", type: "select", options: ["Backlog", "Ready", "In progress", "Review", "Done"] },
      { id: "points", name: "Story points", type: "number" },
      { id: "assignee", name: "Assignee", type: "person" },
      { id: "type", name: "Type", type: "select", options: ["Feature", "Bug", "Tech"] },
    ],
    views: [
      view("board", "Sprint", "board", { groupBy: "status" }),
      view("table", "Backlog", "table", { sorts: [{ field: "points", direction: "desc" }] } as Partial<View>),
      view("chart", "Points by status", "chart", {
        chart: { kind: "bar", xField: "status", yField: "points", aggregate: "sum", dateBucket: "month", order: "label_asc", includeEmpty: false, showValues: true },
      } as Partial<View>),
    ],
    rows: [
      { cells: { title: "As a user I want to sign in with SSO", status: "In progress", points: 5, type: "Feature" } },
      { cells: { title: "Crash when exporting large files", status: "Review", points: 3, type: "Bug" } },
      { cells: { title: "Filter search by tags", status: "Ready", points: 2, type: "Feature" } },
      { cells: { title: "Update dependencies", status: "Backlog", points: 1, type: "Tech" } },
      { cells: { title: "Design empty states", status: "Done", points: 2, type: "Feature" } },
    ],
  },
  brief: {
    name: "Project brief",
    category: "projects",
    icon: "📋",
    kind: "document",
    description: "Goal, scope, people and risks of a project on one page.",
    html:
      "<h2>What is it about?</h2><p>One or two sentences on the problem and why it matters now.</p>" +
      callout("<p><strong>Goal:</strong> What is different at the end? How do we measure it?</p>") +
      "<h2>Scope</h2><h3>In scope</h3><ul><li><p>…</p></li></ul><h3>Out of scope</h3><ul><li><p>…</p></li></ul>" +
      "<h2>People</h2>" +
      table([["Role", "Person", "Task"], ["Owner", "", "Decides and reports"], ["Team", "", "Does the work"], ["Advisory", "", "Is consulted"]]) +
      "<h2>Milestones</h2><ol><li><p>Start</p></li><li><p>Midpoint</p></li><li><p>Close</p></li></ol>" +
      "<h2>Risks</h2>" +
      table([["Risk", "Likelihood", "Mitigation"], ["", "", ""]]),
  },
  // ---------------------------------------------------------------- Meetings
  meeting: {
    name: "Meeting notes",
    category: "meetings",
    icon: "👥",
    kind: "document",
    description: "Agenda, decisions and tasks of a meeting.",
    html:
      "<h2>Meeting</h2><p><strong>Date:</strong> </p><p><strong>Attendees:</strong> </p><h2>Goal</h2><p>What do we want to achieve in this meeting?</p><h2>Agenda</h2><ol><li><p>Current status</p></li><li><p>Open questions</p></li><li><p>Next steps</p></li></ol><h2>Decisions</h2><p>Write down what was decided and why.</p><h2>Tasks</h2>" +
      tasks(task("Set the task, owner and date")),
  },
  oneOnOne: {
    name: "1:1 meeting",
    category: "meetings",
    icon: "💬",
    kind: "document",
    description: "A regular talk between two people: mood, topics, agreements.",
    html:
      callout("<p>Tip: one document for all talks – add new dates at the top so the history stays visible.</p>") +
      "<h2>Talk on …</h2><h3>How are you?</h3><p></p><h3>Your topics</h3><ul><li><p></p></li></ul><h3>My topics</h3><ul><li><p></p></li></ul><h3>Feedback</h3><p>What is going well? What can we do differently?</p><h3>Agreements</h3>" +
      tasks(task("")) +
      toggle("Earlier talks", "<p>Move older notes here.</p>"),
  },
  retro: {
    name: "Retrospective",
    category: "meetings",
    icon: "🔄",
    kind: "document",
    description: "A look back on a sprint or project, with actions.",
    html:
      "<h2>Retrospective: sprint …</h2><p><strong>Period:</strong> </p>" +
      '<div data-columns="true"><div data-column="true"><h3>What went well?</h3><ul><li><p></p></li></ul></div><div data-column="true"><h3>What did not go well?</h3><ul><li><p></p></li></ul></div></div>' +
      "<h3>What do we learn from it?</h3><p></p><h2>Actions</h2>" +
      tasks(task("Action with an owner")) +
      callout("<p>Next time, check first: were the actions of the last retrospective done?</p>"),
  },
  meetingLog: {
    name: "Meeting log",
    category: "meetings",
    icon: "📅",
    kind: "database",
    description: "All meetings as a database – with a calendar and minutes per date.",
    fields: [
      { id: "title", name: "Meeting", type: "text" },
      { id: "date", name: "Date", type: "date" },
      { id: "type", name: "Type", type: "select", options: ["Team", "Client", "Planning", "1:1"] },
      { id: "people", name: "Attendees", type: "person" },
      { id: "done", name: "Minutes done", type: "checkbox" },
    ],
    views: [
      view("calendar", "Calendar", "calendar", { dateField: "date" }),
      view("feed", "Minutes", "feed"),
      view("table", "All", "table"),
    ],
    rows: [
      { cells: { title: "Week kickoff", date: "@-3", type: "Team", done: true }, content: "<h2>Decisions</h2><ul><li><p>Release on Thursday</p></li></ul>" },
      { cells: { title: "Check-in with the client", date: "@+1", type: "Client", done: false } },
      { cells: { title: "Quarterly planning", date: "@+8", type: "Planning", done: false } },
    ],
  },
  // --------------------------------------------------------------- Knowledge
  wiki: {
    name: "Team wiki",
    category: "knowledge",
    icon: "📘",
    kind: "document",
    description: "Home page for a team's knowledge, processes and contacts.",
    html:
      "<h2>Welcome to the team</h2><p>Here you find the knowledge we need for working together every day.</p><h2>Our mission</h2><p>Describe what your team is responsible for.</p><h2>Working together</h2><h3>Communication</h3><p>Which channels do we use? When is an answer needed?</p><h3>Decisions</h3><p>How do we make and document decisions?</p><h2>Key contacts</h2>" +
      table([["Topic", "Contact"], ["Onboarding", ""], ["Processes", ""]]) +
      "<h2>Knowledge base</h2><p>Create sub-pages for processes, projects and frequent questions. Link them with @.</p>",
  },
  howto: {
    name: "How-to guide",
    category: "knowledge",
    icon: "🔧",
    kind: "document",
    description: "Step-by-step guide with prerequisites, commands and troubleshooting.",
    html:
      "<p>In short: what is this guide for, and who needs it?</p>" +
      callout("<p><strong>Prerequisites:</strong> access to …, role …</p>") +
      "<h2>Steps</h2><ol><li><p>Describe the first step.</p></li><li><p>Describe the second step.</p></li><li><p>Check the result.</p></li></ol>" +
      '<pre><code class="language-bash"># Example command\ndocker compose up -d</code></pre>' +
      "<h2>Common problems</h2>" +
      toggle("Error message “…”", "<p>Cause and solution.</p>") +
      toggle("Nothing happens", "<p>Check whether …</p>"),
  },
  decisions: {
    name: "Decision log",
    category: "knowledge",
    icon: "⚖️",
    kind: "database",
    description: "Collect important decisions with reasons, status and date so they stay traceable.",
    fields: [
      { id: "title", name: "Decision", type: "text" },
      { id: "status", name: "Status", type: "select", options: ["Proposed", "Decided", "Rejected", "Superseded"] },
      { id: "date", name: "Date", type: "date" },
      { id: "owner", name: "Decided by", type: "person" },
      { id: "area", name: "Area", type: "select", options: ["Engineering", "Product", "Organisation"] },
    ],
    views: [view("table", "All decisions", "table", { sorts: [{ field: "date", direction: "desc" }] } as Partial<View>), view("board", "By status", "board", { groupBy: "status" })],
    rows: [
      {
        cells: { title: "SQLite instead of Postgres", status: "Decided", date: "@-30", area: "Engineering" },
        content: "<h2>Context</h2><p>One instance per organisation, little operating effort wanted.</p><h2>Decision</h2><p>SQLite with Litestream backups.</p><h2>Consequences</h2><p>No horizontal scaling; one container instead.</p>",
      },
      { cells: { title: "Weekly release rhythm", status: "Proposed", date: "@-2", area: "Organisation" } },
    ],
  },
  faq: {
    name: "FAQ",
    category: "knowledge",
    icon: "❓",
    kind: "document",
    description: "Frequent questions as toggles – quick to search and to maintain.",
    html:
      "<p>Answers to the questions that keep coming up. Something missing? Comment on the page.</p><h2>General</h2>" +
      toggle("Where do I find …?", "<p>…</p>") +
      toggle("Whom do I ask about …?", "<p>…</p>") +
      "<h2>Technical</h2>" +
      toggle("How do I get access to …?", "<p>…</p>") +
      toggle("What if … does not work?", "<p>…</p>"),
  },
  // -------------------------------------------------------- Planning & goals
  okr: {
    name: "OKRs",
    category: "planning",
    icon: "🏁",
    kind: "database",
    description: "Objectives and key results with progress, owners and quarter.",
    fields: [
      { id: "title", name: "Key result", type: "text" },
      { id: "objective", name: "Objective", type: "select", options: ["Delight customers", "Ship faster", "Grow the team"] },
      { id: "progress", name: "Progress", type: "number", format: "percent" },
      { id: "quarter", name: "Quarter", type: "select", options: ["Q1", "Q2", "Q3", "Q4"] },
      { id: "owner", name: "Owner", type: "person" },
    ],
    views: [
      view("board", "By objective", "board", { groupBy: "objective" }),
      view("table", "All", "table"),
      view("chart", "Progress", "chart", {
        chart: { kind: "horizontal", xField: "objective", yField: "progress", aggregate: "average", dateBucket: "month", order: "label_asc", includeEmpty: false, showValues: true },
      } as Partial<View>),
    ],
    rows: [
      { cells: { title: "Satisfaction (NPS) from 30 to 45", objective: "Delight customers", progress: 0.6, quarter: "Q3" } },
      { cells: { title: "Support response time under 4 hours", objective: "Delight customers", progress: 0.8, quarter: "Q3" } },
      { cells: { title: "A release every two weeks", objective: "Ship faster", progress: 0.4, quarter: "Q3" } },
      { cells: { title: "Two new colleagues onboarded", objective: "Grow the team", progress: 0.5, quarter: "Q3" } },
    ],
  },
  quarter: {
    name: "Quarterly planning",
    category: "planning",
    icon: "📅",
    kind: "document",
    description: "Review, priorities, capacity and risks for the next three months.",
    html:
      "<h2>Looking back on last quarter</h2><ul><li><p>Achieved: …</p></li><li><p>Not achieved because …</p></li></ul><h2>Priorities</h2><ol><li><p>…</p></li><li><p>…</p></li><li><p>…</p></li></ol>" +
      callout("<p>At most three priorities. Everything else is explicitly <em>not</em> a goal of this quarter.</p>") +
      "<h2>Capacity</h2>" +
      table([["Person", "Available (days)", "Of which priorities"], ["", "", ""]]) +
      "<h2>Risks and dependencies</h2><ul><li><p></p></li></ul>",
  },
  content: {
    name: "Content calendar",
    category: "planning",
    icon: "📣",
    kind: "database",
    description: "Plan posts for the blog and social media – in a calendar and by channel.",
    fields: [
      { id: "title", name: "Post", type: "text" },
      { id: "date", name: "Publication", type: "date" },
      { id: "channel", name: "Channel", type: "multiselect", options: ["Blog", "Newsletter", "LinkedIn", "Instagram"] },
      { id: "status", name: "Status", type: "select", options: ["Idea", "Draft", "Approval", "Published"] },
      { id: "author", name: "Author", type: "person" },
      { id: "link", name: "Link", type: "url" },
    ],
    views: [
      view("calendar", "Calendar", "calendar", { dateField: "date" }),
      view("board", "Status", "board", { groupBy: "status" }),
      view("table", "All", "table"),
    ],
    rows: [
      { cells: { title: "Five tips for better meetings", date: "@+2", channel: ["Blog", "LinkedIn"], status: "Approval" } },
      { cells: { title: "Monthly review", date: "@+9", channel: ["Newsletter"], status: "Draft" } },
      { cells: { title: "Behind the scenes", date: "@+5", channel: ["Instagram"], status: "Idea" } },
    ],
  },
  budget: {
    name: "Budget plan",
    category: "planning",
    icon: "💶",
    kind: "database",
    description: "Items with plan, actual and an automatically calculated difference in euros.",
    fields: [
      { id: "title", name: "Item", type: "text" },
      { id: "category", name: "Category", type: "select", options: ["People", "Software", "Travel", "Marketing"] },
      { id: "plan", name: "Plan", type: "number", format: "eur" },
      { id: "actual", name: "Actual", type: "number", format: "eur" },
      { id: "delta", name: "Difference", type: "formula", formula: 'prop("Actual") - prop("Plan")', format: "eur" },
    ],
    views: [
      view("table", "Overview", "table", { calculations: { plan: "sum", actual: "sum", delta: "sum" } } as Partial<View>),
      view("chart", "Plan and actual", "chart", {
        chart: { kind: "bar", xField: "category", yField: "plan", aggregate: "sum", dateBucket: "month", order: "label_asc", includeEmpty: false, showValues: true, measures: [{ field: "actual", aggregate: "sum" }] },
      } as Partial<View>),
    ],
    rows: [
      { cells: { title: "Licences", category: "Software", plan: 2400, actual: 2150 } },
      { cells: { title: "Conference", category: "Travel", plan: 1800, actual: 2100 } },
      { cells: { title: "Autumn campaign", category: "Marketing", plan: 5000, actual: 3200 } },
      { cells: { title: "Working students", category: "People", plan: 12000, actual: 12000 } },
    ],
  },
  // ---------------------------------------------------------------- Personal
  tasks: {
    name: "Task list",
    category: "personal",
    icon: "✅",
    kind: "database",
    description: "Personal tasks with priority, due date, board and calendar.",
    fields: [
      { id: "title", name: "Task", type: "text" },
      { id: "status", name: "Status", type: "select", options: ["Not started", "In progress", "Done"] },
      { id: "priority", name: "Priority", type: "select", options: ["High", "Medium", "Low"] },
      { id: "date", name: "Due", type: "date" },
      { id: "assignee", name: "Assignee", type: "person" },
    ],
    views: [view("table", "All tasks", "table"), view("board", "Board", "board", { groupBy: "status" }), view("calendar", "Calendar", "calendar", { dateField: "date" }), view("list", "List", "list")],
    rows: [{ cells: { title: "Set priorities for this week", status: "Not started", priority: "High", date: "@+1" } }],
  },
  reading: {
    name: "Reading list",
    category: "personal",
    icon: "📚",
    kind: "database",
    description: "Books and articles with status, rating and notes – as a gallery.",
    fields: [
      { id: "title", name: "Title", type: "text" },
      { id: "author", name: "Author", type: "text" },
      { id: "status", name: "Status", type: "select", options: ["Want to read", "Reading", "Read"] },
      { id: "rating", name: "Rating (1–5)", type: "number" },
      { id: "type", name: "Type", type: "select", options: ["Book", "Article", "Podcast"] },
    ],
    views: [view("gallery", "Gallery", "gallery"), view("board", "Status", "board", { groupBy: "status" }), view("table", "Table", "table")],
    rows: [
      { cells: { title: "Deep Work", author: "Cal Newport", status: "Read", rating: 4, type: "Book" }, content: "<h2>Notes</h2><ul><li><p>Deep work needs fixed times.</p></li></ul>" },
      { cells: { title: "Shape Up", author: "Ryan Singer", status: "Reading", type: "Book" } },
      { cells: { title: "The Art of Thinking Clearly", author: "Rolf Dobelli", status: "Want to read", type: "Book" } },
    ],
  },
  habits: {
    name: "Habit tracker",
    category: "personal",
    icon: "🌱",
    kind: "database",
    description: "One record per day: tick off habits and see the share.",
    fields: [
      { id: "title", name: "Day", type: "text" },
      { id: "date", name: "Date", type: "date" },
      { id: "sport", name: "Exercise", type: "checkbox" },
      { id: "read", name: "Read", type: "checkbox" },
      { id: "water", name: "Drank enough", type: "checkbox" },
      { id: "mood", name: "Mood (1–5)", type: "number" },
    ],
    views: [
      view("table", "Days", "table", { sorts: [{ field: "date", direction: "desc" }], calculations: { sport: "percent_checked", read: "percent_checked", water: "percent_checked", mood: "average" } } as Partial<View>),
      view("calendar", "Calendar", "calendar", { dateField: "date" }),
    ],
    rows: [
      { cells: { title: "Monday", date: "@-2", sport: true, read: true, water: false, mood: 4 } },
      { cells: { title: "Tuesday", date: "@-1", sport: false, read: true, water: true, mood: 3 } },
      { cells: { title: "Today", date: "@+0", sport: false, read: false, water: false } },
    ],
  },
  travel: {
    name: "Trip planner",
    category: "personal",
    icon: "✈️",
    kind: "document",
    description: "Itinerary, packing list, accommodation and budget in one document.",
    html:
      "<h2>Trip to …</h2><p><strong>Dates:</strong> </p>" +
      table([["Day", "Place", "Plan"], ["1", "", ""], ["2", "", ""], ["3", "", ""]]) +
      '<div data-columns="true"><div data-column="true"><h3>Packing list</h3>' +
      tasks(task("ID card"), task("Charging cable"), task("First-aid kit")) +
      '</div><div data-column="true"><h3>Before leaving</h3>' +
      tasks(task("Confirm the accommodation"), task("Save the tickets"), task("Arrange for the plants to be watered")) +
      "</div></div>" +
      "<h2>Accommodation</h2><ul><li><p></p></li></ul><h2>Budget</h2><p>Planned: … € · Spent: … €</p>",
  },
  // ------------------------------------------------------------------- Other
  crm: {
    name: "Contacts & clients",
    category: "other",
    icon: "📇",
    kind: "database",
    description: "A simple CRM: contacts with company, stage, next step and value.",
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "company", name: "Company", type: "text" },
      { id: "stage", name: "Stage", type: "select", options: ["Contact", "Conversation", "Offer", "Won", "Lost"] },
      { id: "value", name: "Value", type: "number", format: "eur" },
      { id: "email", name: "Email", type: "email" },
      { id: "next", name: "Next step", type: "date" },
    ],
    views: [
      view("board", "Pipeline", "board", { groupBy: "stage" }),
      view("table", "All contacts", "table", { calculations: { value: "sum" } } as Partial<View>),
      view("chart", "Value by stage", "chart", {
        chart: { kind: "bar", xField: "stage", yField: "value", aggregate: "sum", dateBucket: "month", order: "label_asc", includeEmpty: false, showValues: true },
      } as Partial<View>),
    ],
    rows: [
      { cells: { title: "Mara Klein", company: "Nordlicht Ltd", stage: "Offer", value: 8400, email: "mara@example.com", next: "@+2" } },
      { cells: { title: "Jonas Weber", company: "Studio Weber", stage: "Conversation", value: 3200, email: "jonas@example.com", next: "@+5" } },
      { cells: { title: "Aylin Demir", company: "Demir & Partners", stage: "Won", value: 12000, email: "aylin@example.com" } },
    ],
  },
  hiring: {
    name: "Applications",
    category: "other",
    icon: "💼",
    kind: "database",
    description: "The hiring process as a board – from application to offer, with a form.",
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "role", name: "Role", type: "select", options: ["Design", "Engineering", "Sales"] },
      { id: "stage", name: "Stage", type: "select", options: ["Received", "First interview", "Assignment", "Second interview", "Offer", "Rejected"] },
      { id: "email", name: "Email", type: "email" },
      { id: "cv", name: "CV", type: "files" },
      { id: "date", name: "Received", type: "date" },
    ],
    views: [view("board", "Process", "board", { groupBy: "stage" }), view("table", "All", "table"), view("form", "Application form", "form")],
    rows: [
      { cells: { title: "Lena Hoffmann", role: "Design", stage: "First interview", email: "lena@example.com", date: "@-5" } },
      { cells: { title: "Tim Berger", role: "Engineering", stage: "Received", email: "tim@example.com", date: "@-1" } },
    ],
  },
  survey: {
    name: "Survey",
    category: "other",
    icon: "📊",
    kind: "database",
    description: "A survey with a builder: stars, NPS, scales, matrix, conditions – shareable in public, with results.",
    survey: true,
    fields: [{ id: "title", name: "Response", type: "text" }],
    views: [view("survey", "Survey", "form"), view("table", "Responses", "table")],
    rows: [],
  },
  inventory: {
    name: "Inventory",
    category: "other",
    icon: "📦",
    kind: "database",
    description: "Equipment and material with location, condition, count and value.",
    fields: [
      { id: "title", name: "Item", type: "text" },
      { id: "location", name: "Location", type: "select", options: ["Office", "Storage", "Home office"] },
      { id: "condition", name: "Condition", type: "select", options: ["New", "Good", "Repair"] },
      { id: "count", name: "Count", type: "number" },
      { id: "price", name: "Unit price", type: "number", format: "eur" },
      { id: "total", name: "Total value", type: "formula", formula: 'prop("Count") * prop("Unit price")', format: "eur" },
    ],
    views: [view("table", "Stock", "table", { calculations: { count: "sum", total: "sum" } } as Partial<View>), view("board", "By location", "board", { groupBy: "location" })],
    rows: [
      { cells: { title: "Laptop", location: "Office", condition: "Good", count: 6, price: 1200 } },
      { cells: { title: "27-inch monitor", location: "Office", condition: "New", count: 8, price: 320 } },
      { cells: { title: "Projector", location: "Storage", condition: "Repair", count: 1, price: 650 } },
    ],
  },
  event: {
    name: "Event planner",
    category: "other",
    icon: "🎉",
    kind: "document",
    description: "Checklist, schedule and responsibilities for an event.",
    html:
      "<h2>Event</h2><p><strong>Date and place:</strong> </p><p><strong>Guests:</strong> about … people</p>" +
      "<h2>Schedule</h2>" +
      table([["Time", "Item", "Responsible"], ["18:00", "Doors open", ""], ["18:30", "Welcome", ""], ["19:00", "Dinner", ""]]) +
      "<h2>Checklist</h2><h3>Four weeks before</h3>" +
      tasks(task("Book the venue"), task("Send invitations")) +
      "<h3>One week before</h3>" +
      tasks(task("Confirm attendance"), task("Settle the catering")) +
      "<h3>On the day</h3>" +
      tasks(task("Set up"), task("Check the tech")) +
      callout("<p>Note emergency contacts and access details for the venue here.</p>"),
  },
};
