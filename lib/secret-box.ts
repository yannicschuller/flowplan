// Small secrets the server keeps at rest (the secrets of authenticator apps)
// and keys for signing short-lived values (a sign-in waiting for its second
// step, an unlocked share link). AES-256-GCM; the additional data binds a
// value to its place (e.g. "totp:<userId>"), so a value copied into another
// row does not open.
//
// The key, in this order:
//   FLOWPLAN_ENCRYPTION_KEY / _FILE   (lib/encryption.ts), when set
//   FLOWPLAN_SECRETS_KEY / FLOWPLAN_SECRETS_KEY_FILE   32 bytes, base64 or hex
//   secrets.key in the data folder, created on first use (mode 0600)
// The raw key is never used directly: HKDF derives one key per purpose.
// Sealed values name their key, so values sealed with an earlier key stay
// readable while that key is still around (FLOWPLAN_ENCRYPTION_KEY_PREVIOUS,
// or the key file).
//
// Format: "sb1.<key id>.<iv>.<ciphertext>.<tag>" (base64url).
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { encryptionKeys } from "./encryption";

function parseKey(text: string, name: string) {
  const value = text.trim();
  const hex = /^[0-9a-f]{64}$/i.test(value);
  const secret = hex ? Buffer.from(value, "hex") : Buffer.from(value, "base64");
  if (secret.length !== 32 || (!hex && !/^[A-Za-z0-9+/_-]{43}=?$/.test(value)))
    throw new Error(`${name} muss 32 Bytes lang sein (base64, z. B. aus „openssl rand -base64 32“).`);
  return secret;
}
function secretsKey(): Buffer | null {
  let text = process.env.FLOWPLAN_SECRETS_KEY?.trim() || "";
  const file = process.env.FLOWPLAN_SECRETS_KEY_FILE?.trim();
  if (!text && file) {
    try {
      text = readFileSync(file, "utf8").trim();
    } catch {
      throw new Error(`FLOWPLAN_SECRETS_KEY_FILE kann nicht gelesen werden: ${file}`);
    }
  }
  return text ? parseKey(text, "FLOWPLAN_SECRETS_KEY") : null;
}
const keyFile = () => resolve(/* turbopackIgnore: true */ process.env.FLOWPLAN_DATA_DIR || "./data", "secrets.key");
const fileKeys = new Map<string, Buffer>();
// The key file of the data folder; created only when it is needed for writing.
function fileKey(create: boolean): Buffer | null {
  const path = keyFile();
  const known = fileKeys.get(path);
  if (known) return known;
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create) return null;
    mkdirSync(resolve(path, ".."), { recursive: true });
    try {
      writeFileSync(path, randomBytes(32).toString("base64") + "\n", { mode: 0o600, flag: "wx" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    text = readFileSync(path, "utf8");
  }
  const key = parseKey(text, path);
  fileKeys.set(path, key);
  return key;
}
function currentKey(): Buffer {
  return encryptionKeys().current?.secret || secretsKey() || fileKey(true)!;
}
function knownKeys(): Buffer[] {
  const keys = [secretsKey(), ...encryptionKeys().all.map((k) => k.secret), fileKey(false)];
  return keys.filter((k): k is Buffer => !!k);
}
const keyId = (key: Buffer) => createHash("sha256").update("flowplan-secret-box-id\0").update(key).digest().subarray(0, 8).toString("base64url");
const derive = (key: Buffer, purpose: string) => Buffer.from(hkdfSync("sha256", key, "flowplan-secret-box", purpose, 32));

export function sealSecret(plain: string, aad: string): string {
  const key = currentKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", derive(key, "seal"), iv);
  cipher.setAAD(Buffer.from(aad));
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["sb1", keyId(key), iv.toString("base64url"), data.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(".");
}
export function openSecret(sealed: string, aad: string): string {
  const [kind, id, iv, data, tag] = sealed.split(".");
  if (kind !== "sb1" || !iv || !tag) throw new Error("Unbekanntes Format.");
  const key = knownKeys().find((k) => keyId(k) === id);
  if (!key) throw new Error("Der Schlüssel für dieses Geheimnis ist hier nicht eingerichtet.");
  const decipher = createDecipheriv("aes-256-gcm", derive(key, "seal"), Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}
// A signature over `data` for one purpose; changing the key ends all of them.
export function signValue(purpose: string, data: string) {
  return createHmac("sha256", derive(currentKey(), `sign:${purpose}`)).update(data).digest("base64url");
}
export function validSignature(purpose: string, data: string, signature: string) {
  const expected = Buffer.from(signValue(purpose, data));
  const actual = Buffer.from(signature || "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
