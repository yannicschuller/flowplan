// Creates a record in the first database of your workspace and finds it again.
//   FLOWPLAN_URL=https://flowplan.example.com FLOWPLAN_TOKEN=fp_… node --experimental-strip-types example.ts
import { FlowplanClient, FlowplanError } from "./flowplan.js";

const client = new FlowplanClient({
  baseUrl: process.env.FLOWPLAN_URL ?? "http://localhost:3000",
  token: process.env.FLOWPLAN_TOKEN,
});

try {
  const { workspace, pages } = await client.bootstrap();
  console.log(`Workspace "${workspace.name}" with ${pages.length} pages`);

  const database = pages.find((page) => page.kind === "database");
  if (!database) throw new Error("Create a database first");
  const { database: schema, rows } = await client.getPage(database.id);
  console.log(`Database "${database.title}": ${rows?.length ?? 0} records, properties ${schema?.fields.map((f) => f.name).join(", ")}`);

  // Property values are keyed by property ID; the first property is the title.
  const titleField = schema?.fields[0]?.id ?? "title";
  const { id } = await client.command({ action: "row.create", pageId: database.id, cells: { [titleField]: "Created by the SDK" } });
  console.log(`Created record ${id}`);

  const matches = await client.search({ workspace: workspace.id, q: "Created by the SDK", kind: "row" });
  console.log(`Search found ${matches.length} match(es)`);

  await client.command({ action: "row.delete", pageId: database.id, rowId: id });
} catch (error) {
  if (error instanceof FlowplanError) console.error(`Flowplan answered ${error.status}: ${error.message}`);
  else throw error;
}
