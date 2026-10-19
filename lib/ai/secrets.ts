// Secrets at rest (API keys of AI providers): AES-256-GCM with a random IV,
// a key id and additional authenticated data that binds the ciphertext to
// its owner and purpose ("ai-key:instance", "ai-key:user:<id>") – a value
// copied into another row does not decrypt.
//
// The master key, in this order:
//   FLOWPLAN_ENCRYPTION_KEY / _FILE   the instance's encryption key (lib/encryption.ts)
//   FLOWPLAN_SECRETS_KEY / _FILE      a key just for stored secrets
//   <data dir>/secrets.key            generated on first use (32 random bytes, mode 0600)
// The secret key is derived from it with HKDF, so it is never the same as
// the key that encrypts backups. Every configured key can decrypt (by key
// id), the first one encrypts. secrets.key is not part of the instance
// backup: a backup restored elsewhere needs the API keys entered again.
//
// Format: "fps1:" + base64url(key id (8) | IV (12) | ciphertext | tag (16))
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { encryptionKeys } from "../encryption";

const PREFIX = "fps1:";
const ID_BYTES = 8,
  IV_BYTES = 12,
  TAG_BYTES = 16;
type Key = { id: Buffer; secret: Buffer };

const dataDir = () => resolve(/* turbopackIgnore: true */ process.env.FLOWPLAN_DATA_DIR || "./data");
export const secretsKeyFile = () => resolve(dataDir(), "secrets.key");

function derive(master: Buffer): Key {
  const secret = Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), "flowplan-secrets-v1", 32));
  return { id: createHash("sha256").update("flowplan-secret-key-id\0").update(secret).digest().subarray(0, ID_BYTES), secret };
}
function parseMaster(text: string, name: string) {
  const value = text.trim();
  const bytes = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, "hex") : Buffer.from(value, "base64");
  if (bytes.length !== 32) throw new Error(`${name} muss 32 Bytes lang sein (base64, z. B. aus „openssl rand -base64 32“).`);
  return bytes;
}
function envSecretsKey(): Buffer | null {
  let text = process.env.FLOWPLAN_SECRETS_KEY?.trim() || "";
  const file = process.env.FLOWPLAN_SECRETS_KEY_FILE?.trim();
  if (!text && file) {
    try {
      text = readFileSync(file, "utf8").trim();
    } catch {
      throw new Error(`FLOWPLAN_SECRETS_KEY_FILE kann nicht gelesen werden: ${file}`);
    }
  }
  return text ? parseMaster(text, "FLOWPLAN_SECRETS_KEY") : null;
}
function fileKey(create: boolean): Buffer | null {
  const path = secretsKeyFile();
  if (existsSync(path)) return parseMaster(readFileSync(path, "utf8"), "secrets.key");
  if (!create) return null;
  mkdirSync(dataDir(), { recursive: true });
  try {
    writeFileSync(path, randomBytes(32).toString("base64") + "\n", { mode: 0o600, flag: "wx" });
  } catch (error) {
    // Another process was faster: use its key.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  try {
    chmodSync(path, 0o600);
  } catch {}
  return parseMaster(readFileSync(path, "utf8"), "secrets.key");
}
// All keys that may decrypt; the first one encrypts. Read on every use.
function keys(create: boolean): Key[] {
  const masters: Buffer[] = [];
  const { all } = encryptionKeys();
  masters.push(...all.map((k) => k.secret));
  const env = envSecretsKey();
  if (env) masters.push(env);
  const own = fileKey(create && !masters.length);
  if (own) masters.push(own);
  return masters.map(derive);
}
// Where the key for new secrets comes from (shown to admins).
export function secretsKeySource(): "encryption-key" | "secrets-key" | "file" {
  if (encryptionKeys().current) return "encryption-key";
  if (envSecretsKey()) return "secrets-key";
  return "file";
}

export function sealSecret(plain: string, aad: string): string {
  const key = keys(true)[0];
  if (!key) throw new Error("Kein Schlüssel für gespeicherte Geheimnisse.");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key.secret, iv);
  cipher.setAAD(Buffer.concat([Buffer.from(`${PREFIX}${aad}\0`), key.id]));
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return PREFIX + Buffer.concat([key.id, iv, body, cipher.getAuthTag()]).toString("base64url");
}

// Throws when the value was sealed for another owner or purpose, with an
// unknown key, or was changed.
export function openSecret(sealed: string, aad: string): string {
  if (!sealed.startsWith(PREFIX)) throw new Error("Kein verschlüsseltes Geheimnis.");
  const data = Buffer.from(sealed.slice(PREFIX.length), "base64url");
  if (data.length < ID_BYTES + IV_BYTES + TAG_BYTES) throw new Error("Kein verschlüsseltes Geheimnis.");
  const id = data.subarray(0, ID_BYTES);
  const key = keys(false).find((k) => k.id.equals(id));
  if (!key) throw new Error("Das Geheimnis wurde mit einem Schlüssel verschlüsselt, der hier nicht eingerichtet ist.");
  const decipher = createDecipheriv("aes-256-gcm", key.secret, data.subarray(ID_BYTES, ID_BYTES + IV_BYTES));
  decipher.setAAD(Buffer.concat([Buffer.from(`${PREFIX}${aad}\0`), id]));
  decipher.setAuthTag(data.subarray(data.length - TAG_BYTES));
  try {
    return Buffer.concat([decipher.update(data.subarray(ID_BYTES + IV_BYTES, data.length - TAG_BYTES)), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("Entschlüsseln fehlgeschlagen: falscher Schlüssel oder beschädigte Datei.");
  }
}

// "…abcd": the only part of a key that is ever shown again.
export const keyHint = (key: string) => (key.length >= 12 ? key.slice(-4) : "");
