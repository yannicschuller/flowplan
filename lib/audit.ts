// The activity log on the asynchronous database (lib/db-driver): the same
// entry and listeners as audit() in lib/db.ts, for code that has moved to
// `db` (docs/architecture/database.md). Inside db.tx() it is part of the
// transaction.
import { auditListeners, id } from "./db";
import { db } from "./db-driver";

export async function auditAsync(actor: string, action: string, resource: string, detail = "") {
  await db.run("INSERT INTO audit(id,actor_id,action,resource_id,detail) VALUES(?,?,?,?,?)", id(), actor, action, resource, detail);
  for (const listener of auditListeners().values())
    try {
      listener(actor, action, resource, detail);
    } catch {}
}
