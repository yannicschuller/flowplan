export async function register() {
  if (
    process.env.NEXT_RUNTIME === "nodejs" &&
    process.env.NEXT_PHASE !== "phase-production-build"
  ) {
    const { startPushWorker, dispatchPush } = await import("./lib/push");
    startPushWorker();
    const { startReminderWorker } = await import("./lib/date-reminders");
    startReminderWorker(() => void dispatchPush());
    const { startSearchWorker } = await import("./lib/search-index");
    startSearchWorker();
    const { startFileTextWorker } = await import("./lib/file-text");
    startFileTextWorker();
    const { startRetentionWorker } = await import("./lib/version-history");
    startRetentionWorker();
  }
}
