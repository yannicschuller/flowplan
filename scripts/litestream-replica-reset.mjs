#!/usr/bin/env node
// Deletes the Litestream replica in the bucket – every object under
// <S3_PREFIX>/db/ and nothing else – so that Litestream starts afresh with a
// full snapshot. docker/entrypoint.sh runs it with the data folder lock held
// and before `litestream replicate`, when <data>/litestream-reset says
// "remote" (lib/litestream-health.ts). The uploads (<prefix>/uploads/) and
// the scheduled backups (<prefix>/backups/) stay.
//
//   node /app/scripts/litestream-replica-reset.mjs
//
// Reads the same variables as the app (S3_BUCKET, S3_ENDPOINT, S3_REGION,
// S3_PREFIX, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY) and signs with the same
// library (aws4fetch). Lists the prefix page by page, then deletes in
// batches of at most 1000 (DeleteObjects; one by one where a provider does
// not offer it), only keys that start with the prefix. Exit codes: 0 done
// (also when there was nothing to delete), 1 the bucket failed, 2 refused
// (no bucket, or a prefix that is not plainly <prefix>/db/). Never logs a
// key or secret.
import "./drop-root.mjs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { AwsClient } from "aws4fetch";

const TIMEOUT_MS = 30_000;
const MAX_PAGES = 10_000;

/** The replica's prefix from S3_PREFIX (as lib/storage.ts reads it), or an error. */
export function replicaPrefixFrom(env) {
  const raw = env.S3_PREFIX ?? "flowplan";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return { error: "S3_PREFIX contains control characters or a backslash." };
  const prefix = raw.replace(/^\/+|\/+$/g, "");
  const parts = prefix ? prefix.split("/") : [];
  if (parts.some((p) => p === "" || p === "." || p === "..")) return { error: "S3_PREFIX has an empty, . or .. segment." };
  const db = `${prefix ? `${prefix}/` : ""}db/`;
  // The one shape this script deletes: <prefix>/db/ (or db/ without a prefix).
  if (!(db === "db/" || db.endsWith("/db/"))) return { error: "Not a replica prefix." };
  return { prefix: db };
}

const unxml = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const xml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Deletes every object under the replica prefix. Returns { deleted, prefix }
 * or throws; `log` gets the progress lines.
 */
export async function resetReplica(env = process.env, log = console.log) {
  const bucket = env.S3_BUCKET?.trim();
  if (!bucket) throw Object.assign(new Error("S3_BUCKET is not set."), { code: 2 });
  const found = replicaPrefixFrom(env);
  if (found.error) throw Object.assign(new Error(found.error), { code: 2 });
  const prefix = found.prefix;
  const region = env.S3_REGION?.trim() || "us-east-1";
  const endpoint = (env.S3_ENDPOINT?.trim() || `https://s3.${region}.amazonaws.com`).replace(/\/+$/, "");
  const aws = new AwsClient({ accessKeyId: env.S3_ACCESS_KEY_ID || "", secretAccessKey: env.S3_SECRET_ACCESS_KEY || "", service: "s3", region, retries: 2 });
  const base = `${endpoint}/${encodeURIComponent(bucket)}`;
  const request = (url, init = {}) => aws.fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });

  // 1. List (all pages first: deleting while listing could skip keys).
  const keys = [];
  let token = "";
  for (let page = 0; ; page++) {
    if (page >= MAX_PAGES) throw new Error("Too many pages while listing the replica.");
    const response = await request(`${base}?list-type=2&max-keys=1000&prefix=${encodeURIComponent(prefix)}${token ? `&continuation-token=${encodeURIComponent(token)}` : ""}`);
    if (!response.ok) throw new Error(`Listing the replica: HTTP ${response.status}`);
    const text = await response.text();
    for (const m of text.matchAll(/<Key>([^<]+)<\/Key>/g)) {
      const key = unxml(m[1]);
      // Only what lies under the prefix, whatever the server answered.
      if (key.startsWith(prefix) && key.length > prefix.length) keys.push(key);
    }
    token = /<IsTruncated>true<\/IsTruncated>/.test(text) ? unxml(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(text)?.[1] ?? "") : "";
    if (!token) break;
  }
  if (!keys.length) {
    log(`Litestream replica reset: nothing under ${prefix} in the bucket.`);
    return { deleted: 0, prefix };
  }

  // 2. Delete, 1000 keys per request.
  let deleted = 0;
  let single = false;
  const deleteOne = async (key) => {
    const response = await request(`${base}/${key.split("/").map(encodeURIComponent).join("/")}`, { method: "DELETE" });
    if (!response.ok && response.status !== 404) throw new Error(`Deleting an object of the replica: HTTP ${response.status}`);
    deleted++;
  };
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    if (!batch.every((k) => k.startsWith(prefix))) throw new Error("Refusing to delete outside the replica prefix.");
    if (!single) {
      const body = `<?xml version="1.0" encoding="UTF-8"?><Delete><Quiet>true</Quiet>${batch.map((k) => `<Object><Key>${xml(k)}</Key></Object>`).join("")}</Delete>`;
      const response = await request(`${base}?delete`, {
        method: "POST",
        body,
        headers: { "Content-Type": "application/xml", "Content-MD5": createHash("md5").update(body).digest("base64") },
      });
      // A provider without DeleteObjects: one by one from here.
      if (response.status === 501 || response.status === 405) single = true;
      else {
        if (!response.ok) throw new Error(`Deleting the replica: HTTP ${response.status}`);
        const errors = [...(await response.text()).matchAll(/<Error>/g)].length;
        if (errors) throw new Error(`Deleting the replica: ${errors} of ${batch.length} objects could not be deleted.`);
        deleted += batch.length;
        continue;
      }
    }
    for (const key of batch) await deleteOne(key);
  }
  log(`Litestream replica reset: deleted ${deleted} objects under ${prefix} in the bucket.`);
  return { deleted, prefix };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await resetReplica();
  } catch (error) {
    console.error(`Litestream replica reset failed: ${error?.message || error}`);
    process.exit(error?.code === 2 ? 2 : 1);
  }
}
