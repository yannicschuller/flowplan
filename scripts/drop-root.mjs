// Flowplan's helper scripts in the Docker image (#193). The image starts as
// root so that docker/entrypoint.sh can give the data folder to PUID:PGID,
// so docker exec runs as root as well. A file a script wrote as root – a
// staged move, a decrypted backup, SQLite's -wal and -shm – would belong to
// root and the app could not write it any more. Imported before anything
// else: started as root in the image (FLOWPLAN_DROP_ROOT=1, Dockerfile), the
// script continues as PUID:PGID (default 1000:1000, PGID defaults to PUID),
// the user the app runs as, the same as the entrypoint; PUID/PGID 0 are
// refused. Outside the image, or started as any other user, it does nothing.
import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** The user and group a script started as root continues as, or an error. */
export function dropRootTarget(env) {
  const id = (value) =>
    /^[0-9]{1,10}$/.test(value) &&
    Number(value) > 0 &&
    Number(value) < 4294967295
      ? Number(value)
      : null;
  const uid = id(env.PUID || "1000");
  const gid = id(env.PGID || env.PUID || "1000");
  if (uid === null || gid === null)
    return {
      error: `PUID and PGID must be numeric user and group IDs other than 0 (PUID=${env.PUID || ""}, PGID=${env.PGID || ""}).`,
    };
  return { uid, gid };
}

if (process.env.FLOWPLAN_DROP_ROOT === "1" && process.getuid?.() === 0) {
  const target = dropRootTarget(process.env);
  if (target.error) {
    console.error(target.error);
    process.exit(1);
  }
  const { uid, gid } = target;
  // As the entrypoint: only when an owner differs, of the folder or of
  // something directly in it (docker run --rm … node /app/move.mjs on a
  // folder that is not the app's yet).
  const data = process.env.FLOWPLAN_DATA_DIR || "/app/data";
  try {
    const paths = [data, ...readdirSync(data).map((name) => join(data, name))];
    if (
      paths.some((path) => {
        const s = lstatSync(path);
        return s.uid !== uid || s.gid !== gid;
      })
    )
      execFileSync("chown", ["-R", `${uid}:${gid}`, data]);
  } catch {
    // No data folder (yet), or chown failed: the script reports what it cannot write.
  }
  process.setgroups([]);
  process.setgid(gid);
  process.setuid(uid);
  process.env.HOME = uid === 1000 ? "/home/node" : "/tmp";
}
