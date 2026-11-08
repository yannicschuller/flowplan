import { test, expect, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync } from "node:fs";

// Workflows wave 3 (#168, docs/specs/workflows.md §10.6–10.9): every
// template of the gallery is created through its assistant, dry-run and
// activated once; the AI builder drafts from a sentence for review (a stub
// OpenAI-compatible model); the workflow button on a page starts a run; on
// a phone the approval is decided from the approvals tab. Screenshots go to
// WF_SHOTS when set.

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const shots = process.env.WF_SHOTS || "";
const shot = async (page: Page, name: string) => {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: `${shots}/${name}.png` });
};

type Mock = { base: string; close: () => Promise<void>; builder: (user: string) => unknown };
async function startMock(): Promise<Mock> {
  const mock: Mock = { base: "", close: async () => {}, builder: () => ({}) };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (!req.url?.endsWith("/chat/completions")) return void res.writeHead(404).end();
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const messages = (body.messages || []) as { role: string; content: string }[];
      const system = messages.find((m) => m.role === "system")?.content || "";
      const user = messages.filter((m) => m.role !== "system").map((m) => m.content).join("\n");
      // The builder gets a graph; every AI node one JSON answer that fits all
      // of them (a summary takes it as text).
      const answer = system.startsWith("You design automation workflows")
        ? JSON.stringify(mock.builder(user))
        : JSON.stringify({ category: "Bug", categories: ["Bug"], confidence: "high", fields: { title: "Drucker kaputt", summary: "Der Drucker im 2. Stock druckt nicht.", urgent: true }, missing: [], summary: "Eine kurze Zusammenfassung." });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  mock.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  mock.close = () => new Promise((resolve) => server.close(() => resolve()));
  return mock;
}

async function setup(page: Page, mock: Mock | null) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const r = await page.request.post("/api/command", { headers: { origin }, data });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  };
  const where = { workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id };
  await command({ action: "profile.onboarded" });
  if (mock) {
    await command({ action: "admin.ai", settings: { enabled: true, provider: { kind: "openai", baseUrl: mock.base, model: "mock-model", embeddingModel: "" } } });
    await command({ action: "ai.settings", enabled: true });
  }
  return { command, where };
}
async function open(page: Page, id: string) {
  await page.goto(`/#page=${id}`);
  const welcome = page.getByRole("dialog", { name: "Willkommen bei Flowplan" });
  await welcome.waitFor({ timeout: 3000 }).then(() => page.keyboard.press("Escape"), () => {});
}

test("every template: created through its assistant, dry-run and activated", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Editing is for tablets and computers.");
  test.setTimeout(400_000);
  const mock = await startMock();
  try {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const { command, where } = await setup(page, mock);
    const stamp = Date.now().toString(36);
    const dbId = (await command({ action: "page.create", ...where, kind: "database", title: `Tickets ${stamp}`, databaseKind: "empty" })).id as string;
    const db = (await (await page.request.get(`/api/pages/${dbId}`)).json()).database as { version: number; views: unknown[]; fields: { id: string }[] };
    const titleId = db.fields[0].id;
    await command({
      action: "database.update",
      pageId: dbId,
      version: db.version,
      views: db.views,
      fields: [
        { id: titleId, name: "Titel", type: "text" },
        { id: "status", name: "Status", type: "select", options: ["Offen", "In Arbeit", "Erledigt"] },
        { id: "category", name: "Kategorie", type: "select", options: ["Bug", "Frage", "Wunsch"] },
        { id: "owner", name: "Zuständig", type: "person" },
        { id: "due", name: "Fällig", type: "date" },
        { id: "doneAt", name: "Erledigt am", type: "date" },
        { id: "body", name: "Beschreibung", type: "text" },
      ],
    });
    await command({ action: "form.update", pageId: dbId, enabled: true, internal: true });
    // A real record for the record-triggered templates' dry runs.
    const record = (await command({ action: "row.create", pageId: dbId, cells: { [titleId]: "Drucker kaputt", status: "Offen", due: "2030-01-10" } })).id as string;
    const overview = (await command({ action: "page.create", ...where, kind: "document", title: `Compose-Übersicht ${stamp}` })).id as string;
    const reports = (await command({ action: "page.create", ...where, kind: "document", title: `Berichte ${stamp}` })).id as string;

    const templates: [string, string, (dialog: ReturnType<Page["getByRole"]>) => Promise<void>][] = [
      [
        "subpages-overview",
        "Unterseiten auf der Übersicht verlinken",
        async (d) => {
          await d.getByLabel("Übersichtsseite *").selectOption(overview);
        },
      ],
      [
        "due-reminder",
        "Erinnerung vor Fälligkeit",
        async (d) => {
          await d.getByLabel("Datenbank *").selectOption(dbId);
          await d.getByLabel("Fälligkeitsdatum *").selectOption("due");
          await d.getByLabel("Verantwortliche *").selectOption("owner");
          await d.getByLabel("Status (optional)").selectOption("status");
          await d.getByLabel("Wert für erledigt").selectOption("Erledigt");
        },
      ],
      [
        "form-triage",
        "Formular → KI-Kategorie → Zuweisung",
        async (d) => {
          await d.getByLabel("Datenbank mit Formular *").selectOption(dbId);
          await d.getByLabel("Kategorie *").selectOption("category");
          await d.getByLabel("Zuständig (optional)").selectOption("owner");
          await d.getByLabel("Zuständig für Bug").selectOption({ index: 1 });
          await d.getByLabel("Teamleitung *").selectOption({ index: 1 });
        },
      ],
      [
        "weekly-report",
        "Wochenbericht",
        async (d) => {
          await d.getByLabel("Datenbank *").selectOption(dbId);
          await d.getByLabel("Datum der Erledigung *").selectOption("doneAt");
          await d.getByLabel("Berichte ablegen unter *").selectOption(reports);
        },
      ],
      [
        "mail-ticket",
        "Eingehende Mail → Ticket",
        async (d) => {
          await d.getByLabel("Erlaubter Absender (Adresse oder Domain)").fill("example.com");
          await d.getByRole("button", { name: "Adresse anlegen" }).click();
          await expect(d.getByLabel("E-Mail-Adresse *")).not.toHaveValue("", { timeout: 10_000 });
          await d.getByLabel("Ticket-Datenbank *").selectOption(dbId);
          await d.getByLabel("Beschreibung (optional)").selectOption("body");
        },
      ],
      [
        "webhook-record",
        "Webhook → Eintrag",
        async (d) => {
          await d.getByLabel("Datenbank *").selectOption(dbId);
          await d.getByLabel("Beschreibung (optional)").selectOption("body");
        },
      ],
    ];
    for (const [id, name, fill] of templates) {
      const workflow = (await command({ action: "page.create", ...where, kind: "workflow", title: `${name} ${stamp}` })).id as string;
      await open(page, workflow);
      await expect(page.getByRole("heading", { name: "Wie soll der Workflow beginnen?" })).toBeVisible({ timeout: 20_000 });
      if (id === "subpages-overview") await shot(page, "templates-gallery");
      await page.locator(`[data-template="${id}"]`).click();
      const dialog = page.getByRole("dialog", { name });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Als Entwurf anlegen" })).toBeDisabled();
      await fill(dialog);
      if (id === "form-triage") await shot(page, "templates-assistant");
      await dialog.getByRole("button", { name: "Als Entwurf anlegen" }).click();
      await expect(dialog).toBeHidden();
      await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 10_000 });
      await expect(page.locator(".wf-check-state")).toHaveText(/Keine Probleme|Warnung/, { timeout: 15_000 });
      if (id === "subpages-overview") await shot(page, "templates-draft");
      // A dry run with sample data.
      await page.getByRole("button", { name: "Probelauf", exact: true }).click();
      const dry = page.getByRole("dialog", { name: "Probelauf" });
      if (id === "due-reminder" || id === "form-triage") {
        await dry.getByLabel("Daten des Auslösers").selectOption("record");
        await dry.getByLabel("Eintrag", { exact: true }).selectOption(record);
      }
      await dry.getByRole("button", { name: "Probelauf starten" }).click();
      await expect(page.locator(".wf-testbar")).toContainText("Probelauf: erfolgreich", { timeout: 30_000 });
      // Activated.
      await page.getByRole("button", { name: "Aktivieren", exact: true }).click();
      const activate = page.getByRole("dialog", { name: "Workflow aktivieren" });
      await activate.getByRole("button", { name: "Aktivieren", exact: true }).click();
      await expect(activate).toBeHidden();
      await expect(page.locator(".wf-head .status-badge")).toHaveText("Aktiv");
      const state = await (await page.request.get(`/api/workflows/${workflow}`)).json();
      expect(state.status, id).toBe("active");
    }
    expect(errors).toEqual([]);
  } finally {
    await mock.close();
  }
});

test("the AI builder drafts from a sentence for review and never activates", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Editing is for tablets and computers.");
  test.setTimeout(120_000);
  const mock = await startMock();
  try {
    const { command, where } = await setup(page, mock);
    const stamp = Date.now().toString(36);
    const overview = (await command({ action: "page.create", ...where, kind: "document", title: `Docker ${stamp}` })).id as string;
    mock.builder = (user) => {
      const id = new RegExp(`Docker ${stamp} \\(([0-9a-f-]{36})`).exec(user)?.[1] || "";
      return {
        title: "Docker-Seiten verlinken",
        explanation: "Neue Seiten unter Docker kommen mit einem Satz auf die Übersicht.",
        nodes: [
          { id: "1", type: "trigger.page.created", label: "Neue Seite unter Docker", config: { scope: { kind: "below", pageId: id, depth: "children" }, kinds: ["document"] } },
          { id: "2", type: "ai.summarize", label: "Ein Satz", config: { text: "{{1.page.title}}: {{1.page.text}}", length: "sentence" } },
          { id: "3", type: "action.page.append", label: "Auf Übersicht", config: { page: id, blocks: [{ type: "bullet", text: "{{1.page.link}} – {{2.summary}}" }], noDuplicate: true } },
        ],
        edges: [
          { from: "1", to: "2" },
          { from: "2", to: "3" },
        ],
      };
    };
    const workflow = (await command({ action: "page.create", ...where, kind: "workflow", title: `KI-Entwurf ${stamp}` })).id as string;
    await open(page, workflow);
    await page.getByRole("button", { name: "Mit KI entwerfen" }).click();
    const dialog = page.getByRole("dialog", { name: "Mit KI entwerfen" });
    await dialog.getByLabel("Was soll der Workflow tun?").fill(`Wenn unter Docker ${stamp} eine Seite entsteht, trage sie mit einem Satz Beschreibung auf der Übersicht ein`);
    await dialog.getByRole("button", { name: "Entwerfen" }).click();
    await expect(dialog.getByRole("heading", { name: "Docker-Seiten verlinken" })).toBeVisible({ timeout: 20_000 });
    await expect(dialog.locator(".wf-ai-nodes li")).toHaveCount(3);
    await shot(page, "ai-builder");
    await dialog.getByRole("button", { name: "In den Entwurf übernehmen" }).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(3, { timeout: 10_000 });
    await expect(page.locator(".wf-check-state")).toHaveText(/Keine Probleme|Warnung/, { timeout: 15_000 });
    await shot(page, "ai-builder-draft");
    // A draft – not active – with the overview as the page it names.
    await expect.poll(async () => (await (await page.request.get(`/api/workflows/${workflow}`)).json()).draft.graph.nodes.length, { timeout: 10_000 }).toBe(3);
    const state = await (await page.request.get(`/api/workflows/${workflow}`)).json();
    expect(state.status).toBe("draft");
    expect(state.draft.graph.nodes[2].config.page).toBe(overview);
    // Undo takes it back.
    await page.getByRole("button", { name: "Rückgängig" }).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(0);
  } finally {
    await mock.close();
  }
});

test("the workflow button on a page starts a run", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Editing is for tablets and computers.");
  test.setTimeout(120_000);
  const { command, where } = await setup(page, null);
  const stamp = Date.now().toString(36);
  const notes = (await command({ action: "page.create", ...where, kind: "document", title: `Notizen ${stamp}` })).id as string;
  const workflow = (await command({ action: "page.create", ...where, kind: "workflow", title: `Knopf ${stamp}` })).id as string;
  const t = { id: "n_button01", type: "trigger.manual", typeVersion: 1, label: "Knopf", note: "", position: { x: 0, y: 0 }, disabled: false, config: { inputs: [{ name: "Notiz", type: "text", required: true }] } };
  const a = { id: "n_append01", type: "action.page.append", typeVersion: 1, label: "Anhängen", note: "", position: { x: 300, y: 0 }, disabled: false, config: { page: notes, blocks: [{ type: "bullet", text: "Vom Knopf: {{n_button01.inputs.Notiz}}" }] } };
  await command({ action: "workflow.draft", pageId: workflow, graph: { nodes: [t, a], edges: [{ id: "e_1", from: { node: t.id, port: "out" }, to: { node: a.id, port: "in" } }] } });
  expect((await command({ action: "workflow.activate", pageId: workflow })).ok).toBe(true);
  const host = (await command({ action: "page.create", ...where, kind: "document", title: `Mit Knopf ${stamp}` })).id as string;
  await open(page, host);
  const editor = page.locator(".ProseMirror").first();
  await editor.click();
  await page.keyboard.type("/Workflow-Knopf");
  await page.keyboard.press("Enter");
  const block = page.locator(".workflow-button-block").first();
  await block.getByRole("combobox", { name: "Workflow" }).selectOption(workflow);
  await block.getByRole("textbox", { name: "Beschriftung" }).fill("Notiz ablegen");
  await block.getByRole("button", { name: "Übernehmen" }).click();
  await expect(block.getByRole("button", { name: "Notiz ablegen" })).toBeVisible({ timeout: 10_000 });
  await block.getByRole("textbox", { name: "Notiz *" }).fill("Server neu gestartet");
  await shot(page, "page-button");
  await block.getByRole("button", { name: "Notiz ablegen" }).click();
  await expect(block.getByRole("status")).toContainText("Gestartet.", { timeout: 10_000 });
  await expect(block.getByRole("button", { name: "Läufe ansehen" })).toBeVisible();
  await shot(page, "page-button-started");
  await expect.poll(async () => (await (await page.request.get(`/api/pages/${notes}`)).json()).html as string, { timeout: 30_000 }).toContain("Vom Knopf: Server neu gestartet");
  // The stored block: only the workflow and the label.
  await expect.poll(async () => (await (await page.request.get(`/api/pages/${host}`)).json()).html as string, { timeout: 15_000 }).toContain(`data-workflow-button="${workflow}"`);
});

test("phones: the approval from the approvals tab, the runs and the switch", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "The phone view.");
  test.setTimeout(120_000);
  const { command, where } = await setup(page, null);
  const stamp = Date.now().toString(36);
  const workflow = (await command({ action: "page.create", ...where, kind: "workflow", title: `Freigabe ${stamp}` })).id as string;
  const t = { id: "n_start001", type: "trigger.manual", typeVersion: 1, label: "Start", note: "", position: { x: 0, y: 0 }, disabled: false, config: {} };
  const ap = { id: "n_approve1", type: "logic.approval", typeVersion: 1, label: "Freigeben", note: "", position: { x: 300, y: 0 }, disabled: false, config: { approvers: ["@runner"], message: "Darf der Server neu starten?" } };
  const n = { id: "n_tellme01", type: "notify.person", typeVersion: 1, label: "Bescheid", note: "", position: { x: 600, y: 0 }, disabled: false, config: { to: ["@runner"], title: "Genehmigt" } };
  await command({
    action: "workflow.draft",
    pageId: workflow,
    graph: { nodes: [t, ap, n], edges: [{ id: "e_1", from: { node: t.id, port: "out" }, to: { node: ap.id, port: "in" } }, { id: "e_2", from: { node: ap.id, port: "approved" }, to: { node: n.id, port: "in" } }] },
  });
  expect((await command({ action: "workflow.activate", pageId: workflow })).ok).toBe(true);
  await command({ action: "workflow.run", pageId: workflow, inputs: {} });
  // The approval waits (the worker reaches it within a few seconds).
  await expect.poll(async () => ((await (await page.request.get(`/api/workflows/${workflow}/approvals`)).json()).approvals || []).length, { timeout: 30_000 }).toBe(1);
  await open(page, workflow);
  // Opened with a waiting approval: the approvals tab first.
  await expect(page.getByRole("tab", { name: /Freigaben 1/ })).toHaveAttribute("aria-selected", "true", { timeout: 15_000 });
  await expect(page.getByText("Darf der Server neu starten?")).toBeVisible();
  await shot(page, "phone-approval");
  await page.getByRole("button", { name: "Genehmigen" }).click();
  await expect(page.getByText("Genehmigt").first()).toBeVisible({ timeout: 10_000 });
  // The runs and the flow as a list; the switch pauses.
  await page.getByRole("tab", { name: "Läufe" }).click();
  await expect(page.locator(".wf-run-list li").first()).toBeVisible();
  await shot(page, "phone-runs");
  await page.getByRole("tab", { name: "Ablauf" }).click();
  await expect(page.locator(".wf-list-node")).toHaveCount(3);
  await shot(page, "phone-flow");
  await page.getByRole("switch", { name: "Workflow aktiv" }).click();
  await page.getByRole("dialog", { name: "Workflow pausieren" }).getByRole("button", { name: "Pausieren", exact: true }).click();
  await expect(page.getByRole("switch", { name: "Workflow aktiv" })).toHaveAttribute("aria-checked", "false");
  await shot(page, "phone-paused");
});
