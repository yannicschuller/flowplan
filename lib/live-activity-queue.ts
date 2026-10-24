// The server-side hook for Live Activity pushes (lib/live-activity-push.ts):
// whatever changes a person's timer or focus session calls
// markLiveActivity, which queues an update for every app installation of
// theirs that registered a relay token for that Live Activity. The state is
// read when the push is sent, so several changes in a row become one push.
// Only the database, so lib/time-tracking.ts can import it.
import { run } from "./db";

export type LiveActivityChange = "focus" | "timer";

// `at`: when the state should be pushed (now, and e.g. when a focus phase ends).
export function markLiveActivity(userId: string, kind: LiveActivityChange, at: number[] = [Date.now()]) {
  for (const when of at)
    run(
      `INSERT OR IGNORE INTO push_live_queue(device_id,kind,available_at,attempts)
       SELECT l.device_id,l.kind,?,0 FROM mobile_live_activities l JOIN mobile_devices d ON d.id=l.device_id WHERE d.user_id=? AND l.kind=?`,
      Math.floor(when),
      userId,
      kind,
    );
}
