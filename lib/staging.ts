// Parts of an upload that spans several requests – the chunks of a long
// transcription, the pieces of a meeting recording, a notebook recording,
// an import file kept between its preview and the import – and the small
// state files next to them.
//
// A single container keeps them in its data folder (data/tmp/<area>/…), as
// it always did. In cluster mode each request may reach another instance,
// so they live in the bucket instead, under <prefix>/tmp/<area>/… – sealed
// with FLOWPLAN_ENCRYPTION_KEY like the files – and every instance sees the
// same parts: no sticky sessions. What is left behind (an upload nobody
// finished) is removed by each area's own sweep after its time limit; a
// lifecycle rule on <prefix>/tmp/ in the bucket (e.g. 8 days) is the
// safety net for that.
//
//   const parts = staging("transcribe");
//   await parts.put("u1/<id>/0", bytes);
//   (await parts.list("u1/<id>")).map((o) => o.name)   // ["0", …]
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { clusterMode } from "./cluster/config";
import { encryptionEnabled, OVERHEAD, seal, unseal } from "./encryption";
import { bucketFetch, storageConfig } from "./storage";

export type StagedObject = { name: string; size: number; at: number };
export type Staging = {
  // Where the parts are: "local" (data folder) or "bucket".
  where: "local" | "bucket";
  put(path: string, data: Uint8Array): Promise<void>;
  get(path: string): Promise<Buffer | null>;
  // The objects directly in `dir` (not in folders below it).
  list(dir: string): Promise<StagedObject[]>;
  // The folders directly in `dir`, with the newest change below each.
  folders(dir: string): Promise<{ name: string; at: number; size: number }[]>;
  // Every object below `dir`, with its path relative to it.
  walk(dir: string): Promise<StagedObject[]>;
  remove(dir: string): Promise<void>;
  removeObject(path: string): Promise<void>;
};

const SEGMENT = /^[A-Za-z0-9._-]{1,120}$/;
function clean(path: string) {
  const parts = path.split("/").filter(Boolean);
  if (parts.some((p) => !SEGMENT.test(p) || p === "." || p === "..")) throw new Error(`Ungültiger Pfad: ${path.slice(0, 80)}`);
  return parts.join("/");
}

// In the bucket when cluster mode has one (it always has: it is required),
// otherwise in the data folder.
export const stagingInBucket = () => clusterMode() && !!storageConfig();

export function staging(area: string): Staging {
  return stagingInBucket() ? bucketStaging(clean(area)) : localStaging(clean(area));
}

// ---- Data folder ----

function localStaging(area: string): Staging {
  const root = () => resolve(process.env.FLOWPLAN_DATA_DIR || "./data", "tmp", area);
  const at = (path: string) => resolve(root(), clean(path));
  const walk = async (dir: string, base = ""): Promise<StagedObject[]> => {
    const out: StagedObject[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await walk(path, `${base}${entry.name}/`)));
      else
        try {
          const info = await stat(path);
          out.push({ name: `${base}${entry.name}`, size: info.size, at: info.mtimeMs });
        } catch {}
    }
    return out;
  };
  return {
    where: "local",
    async put(path, data) {
      const target = at(path);
      await mkdir(resolve(target, ".."), { recursive: true });
      await writeFile(target, data);
    },
    async get(path) {
      return await readFile(at(path)).catch(() => null);
    },
    async list(dir) {
      const base = dir ? at(dir) : root();
      const out: StagedObject[] = [];
      for (const entry of await readdir(base, { withFileTypes: true }).catch(() => []))
        if (entry.isFile())
          try {
            const info = await stat(resolve(base, entry.name));
            out.push({ name: entry.name, size: info.size, at: info.mtimeMs });
          } catch {}
      return out;
    },
    async folders(dir) {
      const base = dir ? at(dir) : root();
      const out: { name: string; at: number; size: number }[] = [];
      for (const entry of await readdir(base, { withFileTypes: true }).catch(() => []))
        if (entry.isDirectory()) {
          const below = await walk(resolve(base, entry.name));
          const own = await stat(resolve(base, entry.name)).catch(() => null);
          out.push({ name: entry.name, at: Math.max(own?.mtimeMs ?? 0, ...below.map((o) => o.at)), size: below.reduce((sum, o) => sum + o.size, 0) });
        }
      return out;
    },
    async walk(dir) {
      return await walk(dir ? at(dir) : root());
    },
    async remove(dir) {
      await rm(dir ? at(dir) : root(), { recursive: true, force: true }).catch(() => {});
    },
    async removeObject(path) {
      await rm(at(path), { force: true }).catch(() => {});
    },
  };
}

// ---- Bucket ----

type Listed = { key: string; size: number; at: number };
// ListObjectsV2 below `prefix` (relative to the instance's prefix); with a
// delimiter also the "folders" one level down.
async function listObjects(prefix: string, delimiter = false): Promise<{ objects: Listed[]; folders: string[] }> {
  const config = storageConfig()!;
  const full = [config.prefix, prefix].filter(Boolean).join("/");
  const objects: Listed[] = [];
  const folders: string[] = [];
  let token = "";
  for (let page = 0; page < 1000; page++) {
    const response = await bucketFetch(
      `?list-type=2&prefix=${encodeURIComponent(full)}${delimiter ? "&delimiter=%2F" : ""}${token ? `&continuation-token=${encodeURIComponent(token)}` : ""}`,
      { method: "GET" },
    );
    if (!response.ok) throw new Error(`Zwischenablage im Bucket: HTTP ${response.status}`);
    const xml = await response.text();
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = /<Key>([^<]+)<\/Key>/.exec(m[1])?.[1];
      if (!key) continue;
      objects.push({
        key: key.slice(config.prefix ? config.prefix.length + 1 : 0),
        size: Number(/<Size>(\d+)<\/Size>/.exec(m[1])?.[1] || 0),
        at: Date.parse(/<LastModified>([^<]+)<\/LastModified>/.exec(m[1])?.[1] || "") || 0,
      });
    }
    for (const m of xml.matchAll(/<CommonPrefixes>\s*<Prefix>([^<]+)<\/Prefix>\s*<\/CommonPrefixes>/g)) folders.push(m[1].slice(full.length).replace(/\/$/, ""));
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? (/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1] ?? "") : "";
    if (!token) break;
  }
  return { objects, folders };
}

function bucketStaging(area: string): Staging {
  const base = (path: string) => ["tmp", area, clean(path)].filter(Boolean).join("/");
  // The plain size: sealed objects carry the header and tag.
  const plain = (size: number) => (encryptionEnabled() ? Math.max(0, size - OVERHEAD) : size);
  const below = async (dir: string) => {
    const prefix = `${base(dir)}/`;
    return (await listObjects(prefix)).objects.map((o) => ({ ...o, name: o.key.slice(prefix.length), size: plain(o.size) }));
  };
  return {
    where: "bucket",
    async put(path, data) {
      let last: unknown = null;
      const body = new Uint8Array(seal(data));
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt) await new Promise((r) => setTimeout(r, 250 * 4 ** (attempt - 1)));
        try {
          const response = await bucketFetch(base(path), { method: "PUT", body });
          if (response.ok) return;
          last = new Error(`PUT ${response.status}`);
        } catch (error) {
          last = error;
        }
      }
      throw last;
    },
    async get(path) {
      const response = await bucketFetch(base(path), { method: "GET" });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`GET ${response.status}`);
      return unseal(Buffer.from(await response.arrayBuffer()));
    },
    async list(dir) {
      return (await below(dir)).filter((o) => !o.name.includes("/"));
    },
    async folders(dir) {
      const all = await below(dir);
      const byFolder = new Map<string, { name: string; at: number; size: number }>();
      for (const o of all) {
        const slash = o.name.indexOf("/");
        if (slash < 0) continue;
        const name = o.name.slice(0, slash);
        const entry = byFolder.get(name) ?? { name, at: 0, size: 0 };
        entry.at = Math.max(entry.at, o.at);
        entry.size += o.size;
        byFolder.set(name, entry);
      }
      return [...byFolder.values()];
    },
    async walk(dir) {
      return await below(dir);
    },
    async remove(dir) {
      for (const o of await below(dir)) await bucketFetch(`${base(dir)}/${o.name}`, { method: "DELETE" }).catch(() => {});
    },
    async removeObject(path) {
      await bucketFetch(base(path), { method: "DELETE" }).catch(() => {});
    },
  };
}
