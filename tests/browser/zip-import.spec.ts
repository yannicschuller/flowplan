import { test, expect } from "@playwright/test";
import { ZipFile } from "yazl";

function writeZip(entries: Map<string, Buffer>) {
  const zip = new ZipFile();
  for (const [name, data] of entries) zip.addBuffer(data, name);
  zip.end();
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (c: Buffer) => chunks.push(c));
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on("error", reject);
  });
}

test("settings import a Notion-style Markdown/CSV ZIP into a chosen area", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const tag = `${testInfo.project.name}${Date.now()}`;
  const id = "a".repeat(32);
  const archive = await writeZip(
    new Map([
      [
        `Import ${tag} ${id}.md`,
        Buffer.from(`# Import\n\n- [ ] Aufgabe ${tag}\n`),
      ],
      [
        `Kunden ${tag} ${id}.csv`,
        Buffer.from("Name,Umsatz\nACME,10\nGlobex,20\n"),
      ],
    ]),
  );
  await page.goto("/#settings");
  await page.getByRole("button", { name: "Daten", exact: true }).click();
  await page.getByLabel("Export-ZIP importieren").setInputFiles({
    name: "notion.zip",
    mimeType: "application/zip",
    buffer: archive,
  });
  await expect(
    page.getByRole("status").filter({ hasText: "importiert" }),
  ).toContainText("2 Seiten, 2 Einträge");
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const pages = boot.pages.filter((p: { title: string }) =>
    p.title.includes(tag),
  );
  expect(pages.map((p: { title: string }) => p.title).sort()).toEqual([
    `Import ${tag}`,
    `Kunden ${tag}`,
  ]);
  const table = pages.find((p: { kind: string }) => p.kind === "database");
  await page.goto(`/#page=${table.id}`);
  await expect(page.locator("tbody .title-cell")).toHaveText([
    "ACME",
    "Globex",
  ]);
  await page.screenshot({
    path: `test-results/zip-import-verification/${testInfo.project.name}-table.png`,
  });
  expect(errors).toEqual([]);
  for (const p of pages)
    await page.request.post("/api/command", {
      headers: { origin },
      data: { action: "page.delete", pageId: p.id },
    });
});
