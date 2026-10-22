// TXT lookups for verifying custom domains (lib/custom-domains.ts), behind a
// small wrapper so tests can answer without a network.
import { resolveTxt } from "node:dns/promises";

type TxtResolver = (name: string) => Promise<string[][]>;
const system: TxtResolver = (name) => resolveTxt(name);
let current: TxtResolver = system;

export function setTxtResolver(next: TxtResolver | null) {
  current = next || system;
}
// The TXT records of a name, each joined from its chunks; none when the name
// does not exist.
export async function txtRecords(name: string): Promise<string[]> {
  try {
    return (await current(name)).map((chunks) => chunks.join(""));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOTFOUND" || code === "ENODATA" || code === "NXDOMAIN") return [];
    throw error;
  }
}
