export async function register() {
  if (
    process.env.NEXT_RUNTIME === "nodejs" &&
    process.env.NEXT_PHASE !== "phase-production-build"
  ) {
    const { startPushWorker, dispatchPush } = await import("./lib/push");
    startPushWorker();
    const { startReminderWorker } = await import("./lib/date-reminders");
    startReminderWorker(() => void dispatchPush());
    const { startTaskWorker } = await import("./lib/doc-tasks");
    startTaskWorker(() => void dispatchPush());
    const { startAutomationWorker } = await import("./lib/automations");
    startAutomationWorker(() => void dispatchPush());
    const { startSearchWorker } = await import("./lib/search-index");
    startSearchWorker();
    const { startFileTextWorker } = await import("./lib/file-text");
    startFileTextWorker();
    const { startRetentionWorker } = await import("./lib/version-history");
    startRetentionWorker();
    const { startMailWorker } = await import("./lib/mail");
    startMailWorker();
    const { startWebhookWorker } = await import("./lib/webhooks");
    startWebhookWorker();
    const { startBackupWorker } = await import("./lib/scheduled-backup");
    startBackupWorker();
    const { startInactiveWorker } = await import("./lib/inactive-accounts");
    startInactiveWorker();
  }
}
