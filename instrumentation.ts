export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Before anything reads it: Node.js's localStorage without a file
    // (lib/node-web-storage.ts, #194).
    const { quietUnconfiguredLocalStorage } = await import("./lib/node-web-storage");
    quietUnconfiguredLocalStorage();
  }
  if (
    process.env.NEXT_RUNTIME === "nodejs" &&
    process.env.NEXT_PHASE !== "phase-production-build"
  ) {
    // What is running, as the first line Flowplan writes (#194).
    const { buildInfo, versionLine } = await import("./lib/build-info");
    console.log(versionLine());
    // Cluster mode (FLOWPLAN_CLUSTER=1): PostgreSQL, Redis and S3 are
    // checked first – the process exits naming what is missing – then the
    // bus, the leader election and the heartbeat start (lib/cluster). Both
    // modes: a graceful shutdown on SIGTERM/SIGINT.
    const { startInstance } = await import("./lib/cluster/runtime");
    const { poolStats } = await import("./lib/db-driver");
    await startInstance({ pool: poolStats, version: buildInfo().version || null });
    // A new instance on a public address without FLOWPLAN_SETUP_TOKEN: the
    // first visitor could create the administrator (lib/local-auth.ts).
    // With the token: where the first account is created (without the token).
    try {
      const { setupHint, setupWarning } = await import("./lib/local-auth");
      const warning = await setupWarning();
      if (warning) console.warn(warning);
      const hint = await setupHint();
      if (hint) console.log(hint);
    } catch (e) {
      console.error("Setup check failed:", (e as Error)?.message);
    }
    // Catalogues of further languages for server-side texts (lib/i18n-catalogs.ts).
    await import("./lib/i18n-catalogs-server");
    const { startPushWorker, dispatchPush } = await import("./lib/push");
    startPushWorker();
    const { startReminderWorker } = await import("./lib/date-reminders");
    await startReminderWorker(() => void dispatchPush());
    const { startTaskWorker } = await import("./lib/doc-tasks");
    await startTaskWorker(() => void dispatchPush());
    const { startAutomationWorker } = await import("./lib/automations");
    startAutomationWorker(() => void dispatchPush());
    // Workflows (#168): the queue of steps, the event dispatcher, schedules.
    const { startWorkflowWorker } = await import("./lib/workflows/queue");
    startWorkflowWorker();
    // Page owners are reminded once a review date has passed.
    const { startReviewWorker } = await import("./lib/page-review");
    startReviewWorker(() => void dispatchPush());
    // Emergency access (#281): waiting periods that end, reminders, expiry.
    const { startEmergencyWorker } = await import("./lib/emergency-access");
    startEmergencyWorker(() => void dispatchPush());
    // The inactivity message (#282): warnings, sending, re-arming.
    const { startDeadmanWorker } = await import("./lib/dead-man-switch");
    startDeadmanWorker(() => void dispatchPush());
    const { startSearchWorker } = await import("./lib/search-index");
    startSearchWorker();
    const { startFileTextWorker } = await import("./lib/file-text");
    startFileTextWorker();
    const { startRetentionWorker } = await import("./lib/version-history");
    await startRetentionWorker();
    const { startMailWorker } = await import("./lib/mail");
    startMailWorker();
    // Chat apps (Telegram, Gotify, ntfy, Matrix) and the Telegram bot's
    // connection codes (lib/messengers.ts).
    const { startMessengerWorker } = await import("./lib/messengers");
    startMessengerWorker();
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
    // Contacts from the LDAP directory (lib/contacts-ldap.ts), hourly by default.
    const { startContactsSyncWorker } = await import("./lib/contacts-ldap");
    startContactsSyncWorker();
    // AI properties (automatic updates, queued values) and the semantic index.
    const { startAiWorker } = await import("./lib/ai/database");
    startAiWorker();
    // Meeting notes (#199): kept audio past the workspace's retention.
    const { startMeetingWorker } = await import("./lib/meetings");
    startMeetingWorker();
    // … and the reminder when a meeting block's calendar event starts.
    const { startMeetingReminderWorker } = await import("./lib/meeting-reminders");
    startMeetingReminderWorker(() => void dispatchPush());
    // E-mail inbound capture over IMAP (INBOUND_IMAP_*), every two minutes.
    const { startInboundMailWorker } = await import("./lib/inbound-mail");
    startInboundMailWorker();
    // Google / Microsoft 365 calendar sync (lib/calendar-sync.ts), every ten minutes.
    const { startCalendarSyncWorker } = await import("./lib/calendar-sync");
    startCalendarSyncWorker();
    // Operations dashboard: refusal counters, daily sweep and health alerts.
    const { startOpsWorker } = await import("./lib/admin-ops");
    startOpsWorker();
    // Usage statistics: requests per minute, active people, storage per day
    // (lib/metrics.ts; FLOWPLAN_METRICS=off switches them off).
    const { startMetricsWorker } = await import("./lib/metrics-worker");
    startMetricsWorker();
    // Event-loop delay and SQLite time for load tests (FLOWPLAN_METRICS_LOOP=1).
    const { startRuntimeMetrics } = await import("./lib/runtime-metrics");
    startRuntimeMetrics();
  }
}
