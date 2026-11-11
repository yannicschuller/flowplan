import { test, expect, type Page } from "@playwright/test";

// The issue's example (#168) without AI, end to end in the browser: built on
// the canvas – "a new sub-page below the overview → append a link to it on
// the overview" –, test-run, activated; a new sub-page gets its link.
// Phones see the flow as a list, the runs and the switch, no editor.

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

async function setup(page: Page, title: string) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const where = { workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id };
  const overview = (await command({ action: "page.create", ...where, title: `Docker Compose ${title}`, kind: "document" })).id as string;
  const workflow = (await command({ action: "page.create", ...where, title: `Compose verlinken ${title}`, kind: "workflow" })).id as string;
  return { command, where, overview, workflow };
}
async function open(page: Page, id: string) {
  await page.goto(`/#page=${id}`);
  const welcome = page.getByRole("dialog", { name: "Willkommen bei Flowplan" });
  await welcome.waitFor({ timeout: 3000 }).then(() => page.keyboard.press("Escape"), () => {});
}
const overviewHtml = async (page: Page, id: string) => (await (await page.request.get(`/api/pages/${id}`)).json()).html as string;

test("the issue's example: built on the canvas, tested, activated, a new sub-page is linked", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Editing is for tablets and computers.");
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { command, where, overview, workflow } = await setup(page, "Desktop");
  const before = (await command({ action: "page.create", ...where, parentId: overview, title: "Portainer" })).id as string;
  await open(page, workflow);

  // 1. The trigger: a new page directly below the overview.
  await page.getByRole("button", { name: "Leer beginnen" }).click();
  const add = page.getByRole("dialog", { name: "Knoten hinzufügen" });
  await add.getByRole("combobox", { name: "Knoten suchen" }).fill("Neue Seite");
  await add.getByRole("combobox", { name: "Knoten suchen" }).press("Enter");
  const panel = page.locator(".wf-panel");
  await expect(panel.getByRole("heading", { name: "Neue Seite" })).toBeVisible();
  await panel.getByLabel("Wo", { exact: true }).selectOption("below");
  await panel.getByLabel("Seite", { exact: true }).selectOption(overview);
  await panel.getByLabel("Bezeichnung").fill("Neue Compose-Seite");

  // 2. Appended behind it from the palette: the link on the overview.
  await page.locator(".wf-side").getByRole("option", { name: "An Seite anhängen" }).click();
  await expect(panel.getByRole("heading", { name: "An Seite anhängen" })).toBeVisible();
  await panel.getByRole("radio", { name: "Aus Platzhalter" }).check();
  // The placeholder through the picker: the trigger's parent page.
  await panel.getByRole("button", { name: /Platzhalter einfügen in „Platzhalter oder Seiten-ID“/ }).click();
  const picker = panel.getByRole("dialog", { name: "Platzhalter wählen" });
  await picker.getByRole("combobox", { name: "Platzhalter suchen" }).fill("Elternseite");
  await picker.getByRole("combobox", { name: "Platzhalter suchen" }).press("Enter");
  await expect(panel.getByRole("textbox", { name: "Platzhalter oder Seiten-ID" })).toHaveValue("{{Neue Compose-Seite.page.parent}}");
  // Typed in the display form: the link to the new page.
  await panel.getByRole("textbox", { name: "Block 1: Text" }).fill("{{Neue Compose-Seite.page.link}} – neu");
  await panel.getByLabel("Nicht doppelt (Link schon da: nichts anhängen)").check();
  await expect(page.locator(".wf-check-state")).toHaveText("Keine Probleme", { timeout: 10_000 });

  // The canvas shows both nodes, connected, reachable by keyboard.
  const nodes = page.locator(".react-flow__node");
  await expect(nodes).toHaveCount(2);
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  await expect(nodes.first()).toHaveAttribute("aria-label", /Neue Seite: Neue Compose-Seite/);
  // Keyboard: C connects, Ctrl+D duplicates and Ctrl+Z takes it back, L shows the list.
  await nodes.first().focus();
  await page.keyboard.press("c");
  await expect(page.getByRole("dialog", { name: "„Neue Compose-Seite“ verbinden" })).toBeVisible();
  await page.keyboard.press("Escape");
  await nodes.nth(1).focus();
  await page.keyboard.press("Control+d");
  await expect(nodes).toHaveCount(3);
  await page.locator(".react-flow__node").nth(2).focus();
  await page.keyboard.press("Control+z");
  await expect(nodes).toHaveCount(2);
  await nodes.first().focus();
  await page.keyboard.press("l");
  await expect(page.getByRole("list", { name: "Ablauf als Liste" }).getByRole("button")).toHaveCount(2);
  await page.getByRole("list", { name: "Ablauf als Liste" }).getByRole("button").first().press("l");
  await expect(nodes).toHaveCount(2);

  // 3. A test run with an existing sub-page: real, as me.
  await page.getByRole("button", { name: "Testlauf", exact: true }).click();
  const testDialog = page.getByRole("dialog", { name: "Testlauf" });
  await testDialog.getByLabel("Daten des Auslösers").selectOption("page");
  await testDialog.getByLabel("Seite", { exact: true }).selectOption(before);
  await testDialog.getByRole("button", { name: "Testlauf starten" }).click();
  await expect(page.locator(".wf-testbar")).toContainText("Testlauf: erfolgreich", { timeout: 30_000 });
  await expect(page.locator(".wf-card.status-succeeded")).toHaveCount(2);
  expect(await overviewHtml(page, overview)).toContain(`href="/#page=${before}"`);

  // 4. Activate: the check, the summary, who it runs as.
  await page.getByRole("button", { name: "Aktivieren", exact: true }).click();
  const activate = page.getByRole("dialog", { name: "Workflow aktivieren" });
  await expect(activate.getByText(/Läuft als du/)).toBeVisible();
  await activate.getByRole("button", { name: "Aktivieren", exact: true }).click();
  await expect(activate).toBeHidden();
  await expect(page.locator(".wf-head .status-badge")).toHaveText("Aktiv");

  // 5. A new sub-page: its link appears on the overview.
  const child = (await command({ action: "page.create", ...where, parentId: overview, title: "Traefik" })).id as string;
  await expect.poll(async () => overviewHtml(page, overview), { timeout: 30_000 }).toContain(`href="/#page=${child}"`);
  // In the runs: one live run that succeeded.
  await page.getByRole("tab", { name: "Läufe" }).click();
  await expect(page.locator(".wf-run-list li")).toHaveCount(2, { timeout: 15_000 });
  await page.locator(".wf-run-list button").first().click();
  await expect(page.locator(".wf-run-head")).toContainText("Echter Lauf");
  await expect(page.locator(".wf-timeline > li")).toHaveCount(2);
  // The overview shows the link.
  await open(page, overview);
  await expect(page.locator(".ProseMirror a", { hasText: "Traefik" })).toBeVisible();
  expect(errors).toEqual([]);
});

// #209: the check in "Workflow aktivieren" did not reach the server (the
// desktop app on Windows) – the dialog stayed at "Wird geprüft …" with
// "Aktivieren" off and no way on but closing it. The message now offers to
// try again, and the check runs once more.
test("a failed check in the activate dialog can be run again", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Editing is for tablets and computers.");
  test.setTimeout(120_000);
  const { command, workflow, overview } = await setup(page, "Check");
  const trigger = { id: "n_trigger1", type: "trigger.page.created", typeVersion: 1, label: "Neue Seite", note: "", position: { x: 0, y: 0 }, disabled: false, config: { scope: { kind: "below", pageId: overview, depth: "children" } } };
  const append = { id: "n_append01", type: "action.page.append", typeVersion: 1, label: "Verlinken", note: "", position: { x: 300, y: 0 }, disabled: false, config: { page: "{{n_trigger1.page.parent}}", blocks: [{ type: "bullet", text: "{{n_trigger1.page.link}}" }] } };
  await command({ action: "workflow.draft", pageId: workflow, graph: { nodes: [trigger, append], edges: [{ id: "e_1", from: { node: trigger.id, port: "out" }, to: { node: append.id, port: "in" } }] } });
  await open(page, workflow);
  // The dialog's own check (without a graph) fails once at the network level.
  let failures = 0;
  await page.route("**/api/command", (route) => {
    const body = route.request().postData() || "";
    if (failures === 0 && body.includes('"workflow.validate"') && !body.includes('"graph"')) {
      failures++;
      return route.abort("failed");
    }
    return route.continue();
  });
  await page.getByRole("button", { name: "Aktivieren", exact: true }).click();
  const activate = page.getByRole("dialog", { name: "Workflow aktivieren" });
  await expect(activate.getByRole("alert")).toContainText("Keine Verbindung");
  await expect(activate.getByText("Wird geprüft …")).toHaveCount(0);
  await expect(activate.getByRole("button", { name: "Aktivieren", exact: true })).toBeDisabled();
  await activate.getByRole("button", { name: "Erneut versuchen" }).click();
  await expect(activate.getByText(/Läuft als du/)).toBeVisible();
  await expect(activate.getByRole("alert")).toHaveCount(0);
  expect(failures).toBe(1);
  await activate.getByRole("button", { name: "Aktivieren", exact: true }).click();
  await expect(activate).toBeHidden();
  await expect(page.locator(".wf-head .status-badge")).toHaveText("Aktiv");
});

test("phones: the flow as a list, the switch and the runs, no editor", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "The phone view.");
  test.setTimeout(120_000);
  const { command, workflow, overview } = await setup(page, "Phone");
  const trigger = { id: "n_trigger1", type: "trigger.page.created", typeVersion: 1, label: "Neue Seite", note: "", position: { x: 0, y: 0 }, disabled: false, config: { scope: { kind: "below", pageId: overview, depth: "children" } } };
  const append = { id: "n_append01", type: "action.page.append", typeVersion: 1, label: "Verlinken", note: "", position: { x: 300, y: 0 }, disabled: false, config: { page: "{{n_trigger1.page.parent}}", blocks: [{ type: "bullet", text: "{{n_trigger1.page.link}}" }] } };
  await command({ action: "workflow.draft", pageId: workflow, graph: { nodes: [trigger, append], edges: [{ id: "e_1", from: { node: trigger.id, port: "out" }, to: { node: append.id, port: "in" } }] } });
  await open(page, workflow);
  await expect(page.getByText("Bearbeiten auf Tablet oder Computer.")).toBeVisible();
  await expect(page.locator(".react-flow")).toHaveCount(0);
  await expect(page.locator(".wf-list-node")).toHaveCount(2);
  await page.getByRole("switch", { name: "Workflow aktiv" }).click();
  const activate = page.getByRole("dialog", { name: "Workflow aktivieren" });
  await activate.getByRole("button", { name: "Aktivieren", exact: true }).click();
  await expect(page.getByRole("switch", { name: "Workflow aktiv" })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("tab", { name: "Läufe" }).click();
  await expect(page.getByText(/Noch keine Läufe/)).toBeVisible();
});

test("a database rule opens in the canvas; once activated, the rule links to its workflow", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Editing is for tablets and computers.");
  test.setTimeout(120_000);
  const { command, where } = await setup(page, "Rule");
  const db = (await command({ action: "page.create", ...where, title: "Tickets Rule", kind: "database" })).id as string;
  const rule = { id: "rule1", name: "Neue Tickets melden", enabled: true, trigger: { type: "created" }, conditions: [], actions: [{ type: "notify", to: "@creator", message: "Neu" }] };
  await command({ action: "database.settings", pageId: db, settings: { automations: [rule] } });
  await open(page, db);
  await page.getByRole("button", { name: "Weitere Werkzeuge" }).click();
  await page.getByRole("menuitem", { name: /Automationen/ }).click();
  await page.getByRole("button", { name: "„Neue Tickets melden“ im Canvas öffnen und erweitern" }).click();
  // The workflow page next to the database, the rule as its draft.
  await expect(page.locator(".react-flow__node")).toHaveCount(2, { timeout: 20_000 });
  await expect(page.locator(".react-flow__node").first()).toHaveAttribute("aria-label", /Neuer Eintrag/);
  await page.getByRole("button", { name: "Aktivieren", exact: true }).click();
  const activate = page.getByRole("dialog", { name: "Workflow aktivieren" });
  await activate.getByRole("button", { name: "Aktivieren", exact: true }).click();
  await expect(page.locator(".wf-head .status-badge")).toHaveText("Aktiv");
  await open(page, db);
  await page.getByRole("button", { name: "Weitere Werkzeuge" }).click();
  await page.getByRole("menuitem", { name: /Automationen/ }).click();
  await expect(page.getByRole("button", { name: "Erweitert als Workflow → öffnen" })).toBeVisible();
});

/* ---------- Wave 2 ---------- */

const n = (id: string, type: string, label: string, config: Record<string, unknown>, x = 0, y = 0) => ({ id, type, typeVersion: 1, label, note: "", position: { x, y }, disabled: false, config });
const e = (id: string, from: string, to: string, port = "out") => ({ id, from: { node: from, port }, to: { node: to, port: "in" } });

test("approvals: the request opens the approvals tab, the decision lets the run go on (desktop and phone)", async ({ page }, info) => {
  test.setTimeout(120_000);
  const { command, workflow } = await setup(page, `Approve ${info.project.name}`);
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const graph = {
    nodes: [n("n_start001", "trigger.manual", "Start", { inputs: [] }), n("n_ask00001", "logic.approval", "Freigabe", { approvers: [boot.user.id], message: "Darf der Bericht raus?" }, 300), n("n_done0001", "logic.set", "Danach", { values: [{ name: "ok", value: "ja", type: "text" }] }, 600)],
    edges: [e("e_1", "n_start001", "n_ask00001"), e("e_2", "n_ask00001", "n_done0001", "approved")],
  };
  await command({ action: "workflow.draft", pageId: workflow, graph });
  expect((await command({ action: "workflow.activate", pageId: workflow })).ok).toBe(true);
  await command({ action: "workflow.run", pageId: workflow, inputs: {} });
  // The request arrives as a notification of the kind workflow_ops.
  await expect.poll(async () => JSON.stringify(await (await page.request.get("/api/notifications")).json()), { timeout: 20_000 }).toContain("Darf der Bericht raus?");
  await open(page, workflow);
  const tab = page.getByRole("tab", { name: /Freigaben 1/ });
  await expect(tab).toHaveAttribute("aria-selected", "true", { timeout: 15_000 });
  const card = page.locator(".wf-approval.open");
  await expect(card).toContainText("Darf der Bericht raus?");
  await card.getByLabel("Kommentar (optional)").fill("passt");
  await card.getByRole("button", { name: "Genehmigen" }).click();
  await expect(page.locator(".wf-approval").first()).toContainText("Genehmigt");
  await expect(page.locator(".wf-approval").first()).toContainText("passt");
  await page.getByRole("tab", { name: "Läufe" }).click();
  await expect(page.locator(".wf-run-list li").first()).toContainText("Erfolgreich", { timeout: 20_000 });
});

test("the editor for wave 2: switch cases, nested conditions, chips with filters, custom test values, changes and versions", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Editing is for tablets and computers.");
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (x) => errors.push(x.message));
  const { command, workflow } = await setup(page, "Editor 2");
  const graph = {
    nodes: [
      n("n_start001", "trigger.manual", "Start", { inputs: [{ name: "name", type: "text", required: true }] }),
      n("n_if000001", "logic.if", "Wenn", { condition: { kind: "group", join: "and", rules: [{ kind: "condition", left: "{{n_start001.inputs.name}}", op: "notempty", value: "" }] } }, 300),
      n("n_say00001", "logic.set", "Gruß", { values: [{ name: "text", value: "Hallo {{n_start001.inputs.name}}", type: "text" }] }, 600),
    ],
    edges: [e("e_1", "n_start001", "n_if000001"), e("e_2", "n_if000001", "n_say00001", "true")],
  };
  await command({ action: "workflow.draft", pageId: workflow, graph });
  expect((await command({ action: "workflow.activate", pageId: workflow, note: "erste" })).ok).toBe(true);
  await open(page, workflow);
  const panel = page.locator(".wf-panel");

  // A nested group in the conditions.
  await page.locator(".react-flow__node", { hasText: "Wenn" }).click();
  await panel.getByRole("button", { name: "Gruppe", exact: true }).click();
  await expect(panel.locator(".wf-cond-group.depth-1")).toHaveCount(1);
  await expect(panel.getByLabel("Gruppe 2: Verknüpfung")).toHaveValue("or");

  // The draft's changes are marked on the canvas.
  await page.getByRole("button", { name: /Entwurf · 1 Änderung seit Version 1/ }).click();
  await expect(page.locator(".wf-card.wf-mark-changed")).toHaveCount(1);
  await expect(page.locator(".wf-changesbar")).toContainText("Wenn");

  // A switch from the palette, with a case.
  await page.locator(".react-flow__node", { hasText: "Gruß" }).click();
  await page.locator(".wf-side").getByRole("option", { name: "Unterscheiden" }).click();
  await expect(panel.getByRole("heading", { name: "Unterscheiden" })).toBeVisible();
  await panel.getByLabel("Fall 1: Bezeichnung").fill("Ada");
  await expect(page.locator(".react-flow__node", { hasText: "Unterscheiden" }).locator(".wf-port-label", { hasText: "Ada" })).toBeVisible();

  // Chips: the placeholder in the greeting, its filter popover.
  await page.locator(".react-flow__node", { hasText: "Gruß" }).click();
  const chip = panel.locator(".wf-chip").first();
  await expect(chip).toContainText("Start");
  await chip.click();
  const pop = panel.getByRole("dialog", { name: /Filter von/ });
  await pop.getByLabel("Filter hinzufügen").selectOption("upper");
  await expect(chip).toContainText("| groß");
  await pop.getByRole("button", { name: "Schließen" }).click();
  await expect.poll(async () => JSON.stringify((await (await page.request.get(`/api/workflows/${workflow}`)).json()).draft.graph), { timeout: 10_000 }).toContain("| upper");

  // A test run with own values in the trigger's form.
  await page.getByRole("button", { name: "Probelauf", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Probelauf" });
  await dialog.getByLabel("Daten des Auslösers").selectOption("custom");
  await dialog.getByLabel("name *").fill("Ada");
  await dialog.getByRole("button", { name: "Probelauf starten" }).click();
  await expect(page.locator(".wf-testbar")).toContainText("erfolgreich", { timeout: 30_000 });

  // Versions: the activated one, opened with its difference; restored as the draft.
  await page.getByRole("tab", { name: "Versionen" }).click();
  await page.getByRole("button", { name: /Version 1 · aktiv/ }).click();
  await expect(page.locator(".wf-diff")).toContainText("Unterscheiden", { timeout: 15_000 });
  await page.getByRole("button", { name: "Als Entwurf wiederherstellen" }).click();
  await expect.poll(async () => (await (await page.request.get(`/api/workflows/${workflow}`)).json()).draft.changed, { timeout: 10_000 }).toBe(false);
  expect(errors).toEqual([]);
});

test("runs: search, retry from the failed node, pause with cancelling", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Desktop.");
  test.setTimeout(120_000);
  const { command, workflow, where } = await setup(page, "Retry");
  const db = (await command({ action: "page.create", ...where, title: "Retry DB", kind: "database" })).id as string;
  const graph = {
    nodes: [
      n("n_start001", "trigger.manual", "Start", { inputs: [{ name: "row", type: "text", required: false }] }),
      n("n_upd00001", "action.record.update", "Ändern", { record: "{{n_start001.inputs.row}}", database: db, values: {} }, 300),
    ],
    edges: [e("e_1", "n_start001", "n_upd00001")],
  };
  await command({ action: "workflow.draft", pageId: workflow, graph });
  expect((await command({ action: "workflow.activate", pageId: workflow })).ok).toBe(true);
  await command({ action: "workflow.run", pageId: workflow, inputs: { row: "00000000-0000-4000-8000-00000000abcd" } });
  await open(page, workflow);
  await page.getByRole("tab", { name: "Läufe" }).click();
  await expect(page.locator(".wf-run-list li").first()).toContainText("Fehlgeschlagen", { timeout: 20_000 });
  await page.getByLabel("Läufe durchsuchen").fill("zzz-nichts");
  await expect(page.getByText("Keine Läufe mit diesem Filter.")).toBeVisible();
  await page.getByLabel("Läufe durchsuchen").fill("");
  await page.locator(".wf-run-list button").first().click();
  await page.getByRole("button", { name: "Wiederholen ab „Ändern“" }).click();
  await expect(page.locator(".wf-timeline")).toContainText("Versuch 2", { timeout: 20_000 });
  // Pause: the dialog offers to cancel open runs.
  await page.getByRole("button", { name: "Pausieren" }).click();
  const pause = page.getByRole("dialog", { name: "Workflow pausieren" });
  await pause.getByRole("button", { name: "Pausieren", exact: true }).click();
  await expect(page.locator(".wf-head .status-badge")).toHaveText("Pausiert");
});

test("tablets: connect by tapping an output, then the target", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "A tablet context of its own.");
  test.setTimeout(120_000);
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: true, locale: "de-DE", extraHTTPHeaders: { "Accept-Language": "de-DE,de;q=0.9" } });
  const page = await context.newPage();
  const { command, workflow } = await setup(page, "Tablet");
  const graph = {
    nodes: [n("n_start001", "trigger.manual", "Start", { inputs: [] }), n("n_set00001", "logic.set", "Ziel", { values: [] }, 320, 120)],
    edges: [],
  };
  await command({ action: "workflow.draft", pageId: workflow, graph });
  await open(page, workflow);
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  await expect(page.locator(".react-flow__edge")).toHaveCount(0);
  await page.locator(".react-flow__node", { hasText: "Start" }).getByRole("button", { name: "weiter" }).tap();
  await expect(page.locator(".wf-tapbar")).toContainText("Ziel für „Start“");
  await page.locator(".react-flow__node", { hasText: "Ziel" }).tap();
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  await context.close();
});
