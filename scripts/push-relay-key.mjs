#!/usr/bin/env node
// The instance's signing key for the push relay (lib/push-identity.ts).
//
//   node --import tsx scripts/push-relay-key.mjs                 list the keys
//   node --import tsx scripts/push-relay-key.mjs rotate          new key; signs after ~1 h,
//                                                                 the old one stays listed 7 days
//   node --import tsx scripts/push-relay-key.mjs rotate --grace-days 2
//   node --import tsx scripts/push-relay-key.mjs rotate --immediate
//                                                                 a key that may have leaked:
//                                                                 the new one signs at once,
//                                                                 every old one is removed
//
// Run it with the instance's environment (FLOWPLAN_DATA_DIR, the encryption
// or secrets key), or use the administration API: POST /api/admin/operations
// { "action": "pushRelay.rotate", "immediate": false, "graceDays": 7 }.
// Prints key ids and dates only, never key material.
const args = process.argv.slice(2);
const { pushIdentityStatus, rotatePushIdentity } = await import("../lib/push-identity.ts");
const show = () => {
  for (const k of pushIdentityStatus())
    console.log(
      `${k.id}  created ${new Date(k.createdAt).toISOString()}  signs from ${new Date(k.activeFrom).toISOString()}` +
        (k.retireAt ? `  removed ${new Date(k.retireAt).toISOString()}` : "") +
        (k.signing ? "  (signing)" : ""),
    );
};
if (args[0] === "rotate") {
  const index = args.indexOf("--grace-days");
  const graceDays = index >= 0 ? Number(args[index + 1]) : 7;
  if (!Number.isInteger(graceDays) || graceDays < 0 || graceDays > 90) {
    console.error("--grace-days: 0–90");
    process.exit(1);
  }
  const rotated = rotatePushIdentity({ immediate: args.includes("--immediate"), graceMs: graceDays * 86_400_000 });
  console.log(`new key ${rotated.kid}, signs from ${new Date(rotated.activeFrom).toISOString()}`);
} else if (args.length) {
  console.error("usage: push-relay-key.mjs [rotate [--grace-days N] [--immediate]]");
  process.exit(1);
}
show();
