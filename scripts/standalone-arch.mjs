// Makes a standalone build (built once on the build machine's architecture)
// fit another CPU: every package in its node_modules that declares a "cpu"
// in its package.json and doesn't match the target is replaced by its twin
// for the target from the npm registry (same name with the other
// architecture, same version), e.g. @img/sharp-linux-x64 →
// @img/sharp-linux-arm64. Everything else in the build is JavaScript and
// WebAssembly and runs anywhere – so the image for linux/arm64 no longer needs
// an emulated `next build` (Dockerfile, stage "standalone").
//
// Usage: node scripts/standalone-arch.mjs <standalone dir> <amd64|arm64>
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const [dir, target] = process.argv.slice(2);
const cpus = { amd64: "x64", arm64: "arm64" };
const cpu = cpus[target];
if (!dir || !cpu) {
  console.error("Usage: node scripts/standalone-arch.mjs <standalone dir> <amd64|arm64>");
  process.exit(2);
}

// Every package directory below node_modules (scoped ones included, nested
// node_modules too).
function* packages(modules) {
  if (!existsSync(modules)) return;
  for (const entry of readdirSync(modules, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const path = join(modules, entry.name);
    if (entry.name.startsWith("@")) {
      for (const scoped of readdirSync(path, { withFileTypes: true }))
        if (scoped.isDirectory()) yield* withNested(join(path, scoped.name));
    } else yield* withNested(path);
  }
}
function* withNested(path) {
  yield path;
  yield* packages(join(path, "node_modules"));
}

const other = Object.values(cpus).filter((c) => c !== cpu);
const work = mkdtempSync(join(tmpdir(), "standalone-arch-"));
let swapped = 0;
// Collected first: the loop replaces directories it would otherwise walk.
for (const path of [...packages(join(dir, "node_modules"))]) {
  const file = join(path, "package.json");
  if (!existsSync(file)) continue;
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(pkg.cpu) || pkg.cpu.includes(cpu)) continue;
  const from = other.find((c) => pkg.name.includes(c));
  if (!from) throw new Error(`${pkg.name}: cpu ${pkg.cpu.join(",")} without a known twin for ${cpu}`);
  const twin = pkg.name.replace(from, cpu);
  const tarball = execFileSync("npm", ["pack", `${twin}@${pkg.version}`, "--silent", "--pack-destination", work], {
    encoding: "utf8",
  }).trim().split("\n").pop();
  rmSync(path, { recursive: true, force: true });
  // The twin goes next to where the original was, under its own name: the
  // package loads the build for the CPU it runs on (e.g. sharp requires
  // @img/sharp-linux-arm64 on arm64).
  const dest = join(dirname(path), basename(twin));
  mkdirSync(dest, { recursive: true });
  execFileSync("tar", ["-xzf", join(work, tarball), "-C", dest, "--strip-components=1"]);
  console.log(`${pkg.name}@${pkg.version} → ${twin}`);
  swapped++;
}
rmSync(work, { recursive: true, force: true });
console.log(swapped ? `${swapped} package(s) for ${cpu}.` : `Nothing to change for ${cpu}.`);
