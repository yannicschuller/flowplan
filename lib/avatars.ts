// Profile pictures from the identity provider. The picture claim is fetched
// once per sign-in on the server and stored in the database, so browsers
// never contact the provider, pictures work offline and are part of every
// backup. Only raster images are accepted (no SVG: it could carry scripts).
import { createHash } from "node:crypto";
import { one, run } from "./db";
import type { Identity } from "./types";

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 5000;

// Image type by its first bytes; the declared content type is not trusted.
export function sniffImage(data: Uint8Array): string | null {
  const b = (i: number) => data[i];
  if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47)
    return "image/png";
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return "image/jpeg";
  if (b(0) === 0x47 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x38)
    return "image/gif";
  if (
    String.fromCharCode(b(0), b(1), b(2), b(3)) === "RIFF" &&
    String.fromCharCode(b(8), b(9), b(10), b(11)) === "WEBP"
  )
    return "image/webp";
  return null;
}

function removeAvatar(userId: string) {
  run("DELETE FROM user_avatars WHERE user_id=?", userId);
  run("UPDATE users SET avatar=NULL WHERE id=? AND avatar IS NOT NULL", userId);
}

// Takes the `picture` claim after sign-in. Never throws: a picture that
// cannot be loaded keeps the previous one (or the initials).
export async function syncAvatar(userId: string, picture: unknown) {
  if (process.env.OIDC_PICTURE === "off") return;
  try {
    if (typeof picture !== "string" || !picture.trim()) {
      removeAvatar(userId);
      return;
    }
    const url = new URL(picture);
    if (url.protocol !== "https:" && url.protocol !== "http:") return;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Accept: "image/png,image/jpeg,image/webp,image/gif" },
    });
    if (!response.ok || !response.body) return;
    if (Number(response.headers.get("content-length") || 0) > MAX_BYTES) return;
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > MAX_BYTES) return;
      chunks.push(chunk);
    }
    const data = Buffer.concat(chunks);
    const mime = sniffImage(data);
    if (!mime) return;
    const version = createHash("sha256").update(data).digest("hex").slice(0, 16);
    if (one("SELECT 1 FROM users WHERE id=? AND avatar=?", userId, version)) return;
    run(
      "INSERT INTO user_avatars(user_id,mime,data) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET mime=excluded.mime,data=excluded.data",
      userId,
      mime,
      data,
    );
    run("UPDATE users SET avatar=? WHERE id=?", version, userId);
  } catch (error) {
    console.error(
      "Profilbild konnte nicht geladen werden:",
      error instanceof Error ? error.message : "unbekannter Fehler",
    );
  }
}

// Pictures are visible to people who share a workspace with the person.
export function avatarFor(viewer: Identity, userId: string) {
  const shared =
    viewer.id === userId ||
    viewer.isAdmin ||
    !!one(
      "SELECT 1 FROM members a JOIN members b ON a.workspace_id=b.workspace_id WHERE a.user_id=? AND b.user_id=? LIMIT 1",
      viewer.id,
      userId,
    );
  if (!shared) return null;
  return (
    one<{ mime: string; data: Uint8Array }>(
      "SELECT mime,data FROM user_avatars WHERE user_id=?",
      userId,
    ) || null
  );
}
