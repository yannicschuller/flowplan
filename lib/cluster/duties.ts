// Singleton duties that start at the opening of the database rather than on
// a timer: in cluster mode they wait until this instance leads
// (lib/cluster/leader.ts). Outside cluster mode they run at once, as before.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { isLeader, onLeadership } from "./leader";

const holder = globalThis as unknown as { flowplanRestoreDeferred?: boolean };

// A staged restore (a pg_dump or SQLite backup in <data>/restore-pending)
// truncates and refills the whole database: one instance at a time, the
// leader. It is staged in this instance's own data folder, so this instance
// applies it once it is elected; while another instance leads it waits
// (stop the others, or scale to one, to restore). The data steps run again
// for the restored data.
export function deferRestoreToLeader() {
  if (holder.flowplanRestoreDeferred) return;
  holder.flowplanRestoreDeferred = true;
  let running = false;
  const apply = async () => {
    if (running || !isLeader()) return;
    running = true;
    try {
      const { restorePendingIntoPostgres } = await import("../db-restore");
      if (await restorePendingIntoPostgres()) await (await import("../data-steps")).runDataSteps();
    } catch (error) {
      console.error("Wiederherstellung fehlgeschlagen", error);
    } finally {
      running = false;
    }
  };
  onLeadership((leader) => {
    if (leader) void apply();
  });
  void apply();
  if (!isLeader() && existsSync(resolve(/* turbopackIgnore: true */ process.env.FLOWPLAN_DATA_DIR || "./data", "restore-pending", "READY")))
    console.warn("Cluster: a restore is staged on this instance; it is applied once this instance leads (stop the other instances to restore now).");
}
