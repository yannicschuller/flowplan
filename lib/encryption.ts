// Encryption at rest for what leaves the server: objects in the S3 bucket
// (uploads mirror, scheduled backups, Markdown exports) and the instance
// backup download. AES-256-GCM with a key only the server has:
//   FLOWPLAN_ENCRYPTION_KEY          32 bytes, base64 (or 64 hex characters)
//   FLOWPLAN_ENCRYPTION_KEY_FILE     the same, read from a file (Docker secret)
//   FLOWPLAN_ENCRYPTION_KEY_PREVIOUS earlier keys, comma-separated; only for
//                                    reading what was written with them
// Without a key nothing changes. Plain and encrypted objects live side by
// side: reading looks at the first bytes, so turning encryption on needs no
// migration, and "Encrypt existing objects" catches up in the background.
//
// Format (scripts/decrypt.mjs reads it without a running instance):
//   "FPE1" | key id (8 bytes) | IV (12 bytes) | ciphertext | GCM tag (16 bytes)
// The first 12 bytes are authenticated too, so the key id cannot be swapped.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { closeSync, createReadStream, createWriteStream, openSync, readFileSync, readSync, statSync } from "node:fs";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";

const MAGIC = Buffer.from("FPE1");
const ID_BYTES = 8,
  IV_BYTES = 12,
  TAG_BYTES = 16;
export const HEADER_BYTES = MAGIC.length + ID_BYTES + IV_BYTES;
export const OVERHEAD = HEADER_BYTES + TAG_BYTES;

type Key = { id: Buffer; secret: Buffer };
const keyId = (secret: Buffer) => createHash("sha256").update("flowplan-encryption-key-id\0").update(secret).digest().subarray(0, ID_BYTES);
const hex = (id: Buffer) => id.toString("hex");

function parseKey(text: string, name: string): Key {
  const value = text.trim();
  const secret = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, "hex") : Buffer.from(value, "base64");
  if (secret.length !== 32 || (!/^[0-9a-f]{64}$/i.test(value) && !/^[A-Za-z0-9+/_-]{43}=?$/.test(value)))
    throw new Error(`${name} muss 32 Bytes lang sein (base64, z. B. aus „openssl rand -base64 32“).`);
  return { id: keyId(secret), secret };
}

// Read on every use, like the other settings from the environment.
export function encryptionKeys(): { current: Key | null; all: Key[] } {
  let text = process.env.FLOWPLAN_ENCRYPTION_KEY?.trim() || "";
  const file = process.env.FLOWPLAN_ENCRYPTION_KEY_FILE?.trim();
  if (!text && file) {
    try {
      text = readFileSync(file, "utf8").trim();
    } catch {
      throw new Error(`FLOWPLAN_ENCRYPTION_KEY_FILE kann nicht gelesen werden: ${file}`);
    }
  }
  const current = text ? parseKey(text, "FLOWPLAN_ENCRYPTION_KEY") : null;
  const previous = (process.env.FLOWPLAN_ENCRYPTION_KEY_PREVIOUS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => parseKey(s, "FLOWPLAN_ENCRYPTION_KEY_PREVIOUS"));
  return { current, all: current ? [current, ...previous] : previous };
}

export function encryptionEnabled() {
  return !!encryptionKeys().current;
}
export const isEncrypted = (data: Uint8Array) => data.length >= OVERHEAD && Buffer.from(data.subarray(0, MAGIC.length)).equals(MAGIC);

function header(key: Key) {
  return Buffer.concat([MAGIC, key.id, randomBytes(IV_BYTES)]);
}
function decipherFor(head: Buffer) {
  const id = head.subarray(MAGIC.length, MAGIC.length + ID_BYTES);
  const key = encryptionKeys().all.find((k) => k.id.equals(id));
  if (!key) throw new Error(`Verschlüsselt mit dem Schlüssel ${hex(id)}, der hier nicht eingerichtet ist.`);
  const decipher = createDecipheriv("aes-256-gcm", key.secret, head.subarray(MAGIC.length + ID_BYTES));
  decipher.setAAD(head.subarray(0, MAGIC.length + ID_BYTES));
  return decipher;
}
const broken = () => new Error("Entschlüsseln fehlgeschlagen: falscher Schlüssel oder beschädigte Datei.");

// Encrypts with the current key; without a key the data stays as it is.
export function seal(data: Uint8Array): Buffer {
  const key = encryptionKeys().current;
  if (!key) return Buffer.from(data);
  const head = header(key);
  const cipher = createCipheriv("aes-256-gcm", key.secret, head.subarray(MAGIC.length + ID_BYTES));
  cipher.setAAD(head.subarray(0, MAGIC.length + ID_BYTES));
  return Buffer.concat([head, cipher.update(data), cipher.final(), cipher.getAuthTag()]);
}

// Plain data comes back as it is; encrypted data with any configured key.
export function unseal(data: Uint8Array): Buffer {
  const buffer = Buffer.from(data);
  if (!isEncrypted(buffer)) return buffer;
  const decipher = decipherFor(buffer.subarray(0, HEADER_BYTES));
  decipher.setAuthTag(buffer.subarray(buffer.length - TAG_BYTES));
  try {
    return Buffer.concat([decipher.update(buffer.subarray(HEADER_BYTES, buffer.length - TAG_BYTES)), decipher.final()]);
  } catch {
    throw broken();
  }
}

// The same for streams (the instance backup can be many gigabytes).
export function sealStream(): Transform {
  const key = encryptionKeys().current;
  if (!key) throw new Error("Kein Schlüssel eingerichtet.");
  const head = header(key);
  const cipher = createCipheriv("aes-256-gcm", key.secret, head.subarray(MAGIC.length + ID_BYTES));
  cipher.setAAD(head.subarray(0, MAGIC.length + ID_BYTES));
  let started = false;
  return new Transform({
    transform(chunk: Buffer, _encoding, done: TransformCallback) {
      if (!started) {
        started = true;
        this.push(head);
      }
      done(null, cipher.update(chunk));
    },
    flush(done: TransformCallback) {
      if (!started) this.push(head);
      this.push(cipher.final());
      done(null, cipher.getAuthTag());
    },
  });
}

// Decrypts a file into another. The output is only complete (and only to be
// used) when the promise resolves: GCM checks the tag at the very end.
export async function unsealFile(source: string, target: string) {
  const size = statSync(source).size;
  const head = Buffer.alloc(HEADER_BYTES),
    tag = Buffer.alloc(TAG_BYTES);
  const fd = openSync(source, "r");
  try {
    readSync(fd, head, 0, HEADER_BYTES, 0);
    if (size >= OVERHEAD) readSync(fd, tag, 0, TAG_BYTES, size - TAG_BYTES);
  } finally {
    closeSync(fd);
  }
  if (size < OVERHEAD || !isEncrypted(Buffer.concat([head, tag]))) throw new Error("Keine verschlüsselte Flowplan-Datei.");
  const decipher = decipherFor(head);
  decipher.setAuthTag(tag);
  try {
    const body = size > OVERHEAD ? createReadStream(source, { start: HEADER_BYTES, end: size - TAG_BYTES - 1 }) : Readable.from([]);
    await pipeline(body, decipher, createWriteStream(target, { flags: "wx" }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw error;
    throw broken();
  }
}

export function fileIsEncrypted(path: string) {
  const head = Buffer.alloc(MAGIC.length);
  const fd = openSync(path, "r");
  try {
    return readSync(fd, head, 0, MAGIC.length, 0) === MAGIC.length && head.equals(MAGIC) && statSync(path).size >= OVERHEAD;
  } finally {
    closeSync(fd);
  }
}

// For the Admin page: which key, which earlier ones, or what is wrong.
export function encryptionKeyStatus() {
  try {
    const { current, all } = encryptionKeys();
    return { enabled: !!current, keyId: current ? hex(current.id) : null, previous: all.filter((k) => k !== current).map((k) => hex(k.id)), problem: null as string | null };
  } catch (error) {
    return { enabled: false, keyId: null, previous: [] as string[], problem: (error as Error).message };
  }
}
export const currentKeyId = () => {
  const key = encryptionKeys().current;
  return key ? hex(key.id) : "";
};
