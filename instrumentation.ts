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
    // Page owners are reminded once a review date has passed.
    const { startReviewWorker } = await import("./lib/page-review");
    startReviewWorker(() => void dispatchPush());
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
    // GitHub/GitLab issue sync: the 10-minute poll and quick pushes.
    const { startIssueSyncWorker } = await import("./lib/issue-sync");
    startIssueSyncWorker();
    const { startBackupWorker } = await import("./lib/scheduled-backup");
    startBackupWorker();
    const { startInactiveWorker } = await import("./lib/inactive-accounts");
    startInactiveWorker();
    // LDAP groups and account state, hourly (only with LDAP_URL).
    const { startLdapSyncWorker } = await import("./lib/ldap-auth");
    startLdapSyncWorker();
    // AI properties (automatic updates, queued values) and the semantic index.
    const { startAiWorker } = await import("./lib/ai/database");
    startAiWorker();
    // E-mail inbound capture over IMAP (INBOUND_IMAP_*), every two minutes.
    const { startInboundMailWorker } = await import("./lib/inbound-mail");
    startInboundMailWorker();
    // Google / Microsoft 365 calendar sync (lib/calendar-sync.ts), every ten minutes.
    const { startCalendarSyncWorker } = await import("./lib/calendar-sync");
    startCalendarSyncWorker();
  }
}
