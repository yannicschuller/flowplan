// The backend part of the installation details for bug reports (#630; the
// text and the frontend part: lib/diagnostics-text.ts). Served by
// GET /api/diagnostics, the MCP tool get_diagnostics and the boot data of
// Settings → Über Flowplan.
//
// Everyone signed in: version, channel, build and build date. Instance
// admins (a browser session of the admin group – API tokens never carry
// admin rights) additionally: Node.js, the install method, the database
// (with PostgreSQL's major version), the storage and single instance or
// cluster. Nothing personal and nothing about the network: no host names,
// addresses, URLs, bucket names or secrets.
//
// The install method is FLOWPLAN_INSTALL_METHOD when set (free text,
// cleaned), otherwise detected: Kubernetes (KUBERNETES_SERVICE_HOST),
// Podman (/run/.containerenv), Docker (/.dockerenv or the cgroup of PID 1),
// else "no container".
import { existsSync, readFileSync } from "node:fs";
import { buildInfo } from "./build-info";
import { releaseChannel } from "./about";
import { postgresUrl } from "./db-driver/context";
import { clusterMode } from "./cluster/config";
import { backendLine, cleanInstallMethod, type BackendDiagnostics } from "./diagnostics-text";

type Env = Record<string, string | undefined>;

export type Probe = {
  exists: (path: string) => boolean;
  read: (path: string) => string | null;
  databaseKind: () => "sqlite" | "postgres";
  // PostgreSQL's major version, null when not known.
  postgresMajor: () => Promise<number | null>;
  storage: () => "local" | "s3";
  cluster: () => boolean;
};

const readText = (path: string) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

// Asked once per process: the server's version does not change while it runs.
let pgMajor: Promise<number | null> | null = null;
const defaultProbe: Probe = {
  exists: (path) => {
    try {
      return existsSync(path);
    } catch {
      return false;
    }
  },
  read: readText,
  databaseKind: () => (postgresUrl() ? "postgres" : "sqlite"),
  postgresMajor: () =>
    (pgMajor ??= (async () => {
      try {
        const { one } = await import("./db");
        const row = await one<{ v: string | number }>("SELECT current_setting('server_version_num') AS v");
        const major = Math.floor(Number(row?.v) / 10000);
        return Number.isFinite(major) && major > 0 ? major : null;
      } catch {
        return null;
      }
    })()),
  storage: () => (process.env.S3_BUCKET?.trim() ? "s3" : "local"),
  cluster: () => clusterMode(),
};

// Detected without the variable: what the process can see of its container.
export function detectInstallMethod(env: Env = process.env, probe: Pick<Probe, "exists" | "read"> = defaultProbe): string {
  if (env.KUBERNETES_SERVICE_HOST) return "kubernetes";
  if (probe.exists("/run/.containerenv")) return "podman";
  if (probe.exists("/.dockerenv")) return "docker";
  const cgroup = probe.read("/proc/1/cgroup") || "";
  if (/kubepods/.test(cgroup)) return "kubernetes";
  if (/docker|containerd/.test(cgroup)) return "docker";
  if (/libpod/.test(cgroup)) return "podman";
  return "no container";
}

export function installMethod(env: Env = process.env, probe: Pick<Probe, "exists" | "read"> = defaultProbe): { method: string; source: "setting" | "detected" } {
  const set = cleanInstallMethod(env.FLOWPLAN_INSTALL_METHOD);
  return set ? { method: set, source: "setting" } : { method: detectInstallMethod(env, probe), source: "detected" };
}

export async function backendDiagnostics(user: { isAdmin: boolean }, env: Env = process.env, probe: Probe = defaultProbe): Promise<BackendDiagnostics> {
  const build = buildInfo();
  const base = {
    version: build.version,
    channel: releaseChannel(env.FLOWPLAN_CHANNEL ?? process.env.FLOWPLAN_CHANNEL),
    commit: build.commit.slice(0, 7),
    builtAt: build.builtAt,
  };
  if (!user.isAdmin) return { scope: "member", ...base, text: backendLine(base) };
  const database = probe.databaseKind();
  const install = installMethod(env, probe);
  const full = {
    ...base,
    node: process.version,
    database,
    databaseVersion: database === "postgres" ? await probe.postgresMajor() : null,
    storage: probe.storage(),
    mode: probe.cluster() ? ("cluster" as const) : ("single" as const),
    installMethod: install.method,
    installMethodSource: install.source,
  };
  return { scope: "admin", ...full, text: backendLine(full) };
}
