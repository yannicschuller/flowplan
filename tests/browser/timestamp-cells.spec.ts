import { test, expect } from "@playwright/test";

// "Created time" and "Edited time" (SQLite text in UTC) show in the viewer's
// time zone, like a date property with time.
test.use({ timezoneId: "America/New_York" });

test("created time cells show the viewer's local time", async ({ page }, info) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const db = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Times ${info.project.name}`, kind: "database" });
  const first = await (await page.request.get(`/api/pages/${db.id}`)).json();
  await command({
    action: "database.update",
    pageId: db.id,
    version: first.database.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "created", name: "Erstellt", type: "created_at" },
    ],
    views: [{ id: "table", name: "Tabelle", type: "table", filters: [], sorts: [] }],
  });
  await command({ action: "row.create", pageId: db.id, cells: { title: "A" } });
  const data = await (await page.request.get(`/api/pages/${db.id}`)).json();
  const stored: string = data.rows[0].created_at;
  expect(stored).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  // The same instant on a New York clock.
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "longOffset" })
      .formatToParts(new Date(stored.replace(" ", "T") + "Z"))
      .map((p) => [p.type, p.value]),
  );
  const expected = `${parts.hour}:${parts.minute} (UTC${parts.timeZoneName.replace("GMT", "")})`;
  await page.goto(`/#page=${db.id}`);
  const cell = page.locator(".date-cell").filter({ hasText: /\d{4}, \d{2}:\d{2}/ }).first();
  await expect(cell).toContainText(expected);
  await expect(cell).not.toContainText(stored);
  expect(errors).toEqual([]);
});
