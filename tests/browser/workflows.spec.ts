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
  await page.getByRole("button", { name: "Auslöser wählen" }).click();
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
