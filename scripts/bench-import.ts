// Benchmark of a large Obsidian import (#594), not part of CI: a synthetic
// vault (tests/helpers/obsidian-vault.ts) imported into a fresh workspace,
// end to end through importFromSource and split into its two halves –
// reading (parseImportOffThread) and writing (writeImport).
//
//   node --import tsx scripts/bench-import.ts [--notes 2000] [--images 300] [--rounds 3]
//   DATABASE_URL=postgres://… node --import tsx scripts/bench-import.ts
//
// For a profile: node --cpu-prof --cpu-prof-dir=<dir> --import tsx scripts/bench-import.ts --rounds 1
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";

const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
};
const NOTES = arg("notes", 2000),
  IMAGES = arg("images", 300),
  ROUNDS = arg("rounds", 3);

const dir = mkdtempSync(join(tmpdir(), "flowplan-bench-import-"));
process.env.FLOWPLAN_DATA_DIR = dir;
const postgres = /^postgres(ql)?:\/\//i.test(process.env.DATABASE_URL || "");
if (postgres) await (await import("../tests/helpers/postgres-backend")).preparePostgres(process.env.DATABASE_URL!);
await import("../lib/i18n-catalogs-server");
const { run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { bootstrap } = await import("../lib/api");
const { importFromSource } = await import("../lib/importers");
const { parseImportOffThread } = await import("../lib/importers/parse-transfer");
const { writeImport } = await import("../lib/importers/write");
const { vaultZip } = await import("../tests/helpers/obsidian-vault");

const uid = id();
await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, "bench", "bench@example.test");
const user = { id: uid, name: "bench", email: "bench@example.test", groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
const target = async () => {
  const wid = await createWorkspace(uid, "Bench");
  return { wid, space: (await bootstrap(user, wid)).spaces[0].id };
};

const t0 = performance.now();
const bytes = await vaultZip({ notes: NOTES, images: IMAGES });
console.log(`vault: ${NOTES} notes, ${IMAGES} images, ${(bytes.length / 1024 / 1024).toFixed(1)} MB ZIP (built in ${(performance.now() - t0).toFixed(0)} ms), ${postgres ? "PostgreSQL" : "SQLite"}`);

const ms = (start: number) => performance.now() - start;
// CPU time of the process (all its threads), less at the mercy of other load on the machine.
const cpu = (start: NodeJS.CpuUsage) => {
  const used = process.cpuUsage(start);
  return (used.user + used.system) / 1000;
};
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const times = { parse: [] as number[], write: [] as number[], total: [] as number[], writeCpu: [] as number[], totalCpu: [] as number[] };
for (let round = 0; round < ROUNDS; round++) {
  {
    const { wid, space } = await target();
    let start = performance.now();
    const tree = await parseImportOffThread("vault.zip", bytes, "obsidian");
    times.parse.push(ms(start));
    start = performance.now();
    const used = process.cpuUsage();
    const result = await writeImport(user, wid, space, tree);
    times.write.push(ms(start));
    times.writeCpu.push(cpu(used));
    if (round === 0) console.log(`pages: ${result.pages}, folders: ${result.folders}, files: ${result.files}, tags: ${result.tags}`);
  }
  {
    const { wid, space } = await target();
    const start = performance.now();
    const used = process.cpuUsage();
    await importFromSource(user, wid, space, { name: "vault.zip", bytes }, { source: "obsidian" });
    times.total.push(ms(start));
    times.totalCpu.push(cpu(used));
  }
  console.log(
    `round ${round + 1}: parse ${times.parse.at(-1)!.toFixed(0)} ms, write ${times.write.at(-1)!.toFixed(0)} ms (cpu ${times.writeCpu.at(-1)!.toFixed(0)} ms), ` +
      `importFromSource ${times.total.at(-1)!.toFixed(0)} ms (cpu ${times.totalCpu.at(-1)!.toFixed(0)} ms)`,
  );
}
console.log(
  `median: parse ${median(times.parse).toFixed(0)} ms, write ${median(times.write).toFixed(0)} ms (cpu ${median(times.writeCpu).toFixed(0)} ms), ` +
    `importFromSource ${median(times.total).toFixed(0)} ms (cpu ${median(times.totalCpu).toFixed(0)} ms)`,
);
rmSync(dir, { recursive: true, force: true });
process.exit(0);
