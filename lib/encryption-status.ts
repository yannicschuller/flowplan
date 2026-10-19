// Admin → Versions and backup → Encryption: which key, what in the bucket is
// still plain, and what leaves the server unencrypted regardless.
import { encryptionKeyStatus } from "./encryption";
import { encryptExistingObjects, storageConfig, storageEncryption } from "./storage";
import { gitConfig } from "./git-export";
import { HttpError } from "./auth";
import type { Identity } from "./types";

export function encryptionOverview() {
  const key = encryptionKeyStatus();
  let git = false;
  try {
    git = !!gitConfig();
  } catch {}
  return {
    ...key,
    bucket: !!storageConfig(),
    objects: key.enabled ? storageEncryption() : null,
    // docker/entrypoint.sh sets these when it starts Litestream.
    litestream: process.env.FLOWPLAN_LITESTREAM_ACTIVE === "1",
    litestreamSseC: process.env.FLOWPLAN_LITESTREAM_SSE_C === "1",
    git,
  };
}

export function encryptExisting(admin: Identity) {
  if (!admin.isAdmin) throw new HttpError(403, "Administrator-Gruppe erforderlich.");
  if (!encryptionKeyStatus().enabled) throw new HttpError(400, "Kein Schlüssel eingerichtet (FLOWPLAN_ENCRYPTION_KEY).");
  if (!storageConfig()) throw new HttpError(400, "Kein S3-Speicher eingerichtet.");
  return { queued: encryptExistingObjects() };
}
