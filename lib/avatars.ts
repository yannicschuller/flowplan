// Profile pictures. Accounts that sign in through an identity provider get
// theirs from its picture claim: fetched once per sign-in on the server and
// stored in the database, so browsers never contact the provider, pictures
// work offline and are part of every backup. Local accounts (e-mail and
// password, #559) upload their own in the settings. Only raster images are
// accepted (no SVG: it could carry scripts).
import { createHash } from "node:crypto";
import { HttpError } from "./auth";
import { one, run } from "./db";
import { isLocalAccount } from "./local-auth";
import { readBodyLimited } from "./request-body";
import { safeFetch } from "./safe-fetch";
import type { Identity } from "./types";

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const MAX_BYTES = AVATAR_MAX_BYTES;
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

async function removeAvatar(userId: string) {
  await run("DELETE FROM user_avatars WHERE user_id=?", userId);
  await run("UPDATE users SET avatar=NULL WHERE id=? AND avatar IS NOT NULL", userId);
}

// Stores a picture whose type was sniffed already. Its version (a hash of
// the bytes) goes into the picture's URL (?v=, components/ui.tsx), so a
// browser that cached the old one loads the new one. Returns the version.
async function storeAvatar(userId: string, mime: string, data: Uint8Array) {
  const version = createHash("sha256").update(data).digest("hex").slice(0, 16);
  if (await one("SELECT 1 FROM users WHERE id=? AND avatar=?", userId, version)) return version;
  await run(
    // A new picture gets its placeholder when first asked for
    // (lib/image-placeholders.ts).
    "INSERT INTO user_avatars(user_id,mime,data) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET mime=excluded.mime,data=excluded.data,width=NULL,height=NULL,thumbhash=NULL",
    userId,
    mime,
    data,
  );
  await run("UPDATE users SET avatar=? WHERE id=?", version, userId);
  return version;
}

// Own pictures (#559) only for local accounts and in the browser: an
// account of an identity provider gets its picture from there at each
// sign-in (an upload would be replaced), and API tokens do not change the
// profile.
async function requireOwnPicture(user: Identity) {
  if (user.apiScope) throw new HttpError(403, "Mit einem API-Token nicht erlaubt.");
  if (!(await isLocalAccount(user.id)))
    throw new HttpError(403, "Dein Profilbild kommt von deinem Identitätsanbieter und wird bei jeder Anmeldung aktualisiert.");
}

// POST /api/avatars: the picture as the raw body, at most 2 MB. The type
// comes from its first bytes, never from Content-Type.
export async function uploadAvatar(user: Identity, req: Request) {
  await requireOwnPicture(user);
  const data = await readBodyLimited(req, AVATAR_MAX_BYTES, "Das Bild darf höchstens 2 MB groß sein.");
  const mime = data.length ? sniffImage(data) : null;
  if (!mime) throw new HttpError(400, "Bitte ein Bild als PNG, JPEG, WebP oder GIF hochladen.");
  return { avatar: await storeAvatar(user.id, mime, new Uint8Array(data)) };
}

// DELETE /api/avatars: back to the initials.
export async function deleteAvatar(user: Identity) {
  await requireOwnPicture(user);
  await removeAvatar(user.id);
  return { avatar: null };
}

// Takes the `picture` claim after sign-in. Never throws: a picture that
// cannot be loaded keeps the previous one (or the initials).
export async function syncAvatar(userId: string, picture: unknown) {
  if (process.env.OIDC_PICTURE === "off") return;
  try {
    if (typeof picture !== "string" || !picture.trim()) {
      await removeAvatar(userId);
      return;
    }
    // Same protection as link previews: public HTTPS only, no internal
    // addresses on any redirect hop (the claim may be user-editable).
    const response = await safeFetch(picture, {
      maxBytes: MAX_BYTES,
      timeout: TIMEOUT_MS,
      accept: "image/png,image/jpeg,image/webp,image/gif",
      allowPrivate: process.env.OIDC_ALLOW_LOCAL_HTTP === "true",
    });
    if (response.status < 200 || response.status >= 300) return;
    const data = response.data;
    const mime = sniffImage(data);
    if (!mime) return;
    await storeAvatar(userId, mime, data);
  } catch (error) {
    console.error(
      "Profilbild konnte nicht geladen werden:",
      error instanceof Error ? error.message : "unbekannter Fehler",
    );
  }
}

// Pictures are visible to people who share a workspace with the person.
export async function avatarFor(viewer: Identity, userId: string) {
  const shared =
    viewer.id === userId ||
    viewer.isAdmin ||
    !!(await one(
      "SELECT 1 FROM members a JOIN members b ON a.workspace_id=b.workspace_id WHERE a.user_id=? AND b.user_id=? LIMIT 1",
      viewer.id,
      userId,
    ));
  if (!shared) return null;
  return (
    await one<{ mime: string; data: Uint8Array }>(
      "SELECT mime,data FROM user_avatars WHERE user_id=?",
      userId,
    ) || null
  );
}
