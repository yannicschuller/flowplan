// The state the administration shows for one account (lib/user-activity.ts
// stores the times; this part runs in the browser too).

// A ping is due every minute; one missed ping still counts as open.
export const ONLINE_MS = 150_000;

export type ActivityState = "active" | "idle" | "offline" | "never";
export type UserActivity = {
  id: string;
  openAt: number | null;
  activeAt: number | null;
};

// Open and used in the last minutes, open but idle, closed, or never here.
export function activityState(
  a: Pick<UserActivity, "openAt" | "activeAt"> | undefined,
  now: number,
): ActivityState {
  if (!a || (!a.openAt && !a.activeAt)) return "never";
  if (a.openAt && now - a.openAt <= ONLINE_MS)
    return a.activeAt && now - a.activeAt <= ONLINE_MS ? "active" : "idle";
  return "offline";
}
