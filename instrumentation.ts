export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Sign-in through a reverse proxy (AUTH_PROXY_USER_HEADER): the address
    // of each request's connection, which Next.js does not pass on, is
    // stamped into the request (lib/proxy-auth-config.ts). As early as
    // possible; requests before it count as coming from an unknown peer.
    if (process.env.AUTH_PROXY_USER_HEADER?.trim()) {
      const [{ installPeerStamp }, http] = await Promise.all([import("./lib/proxy-auth-config"), import("node:http")]);
      installPeerStamp(http.Server);
    }
    // Before anything reads it: Node.js's localStorage without a file
    // (lib/node-web-storage.ts, #194).
    const { quietUnconfiguredLocalStorage } = await import("./lib/node-web-storage");
    quietUnconfiguredLocalStorage();
  }
  if (
    process.env.NEXT_RUNTIME === "nodejs" &&
    process.env.NEXT_PHASE !== "phase-production-build"
  ) {
    // The server log on disk and the heartbeat for the restart history
    // (Administration → Überwachung → Neustarts): before the first line, so
    // the copy has it; what the previous run left is taken over here, before
    // this run writes anything (lib/restarts/tracker.ts).
    const { installLogCapture } = await import("./lib/restarts/log-file");
    installLogCapture();
    // Several processes on this host (FLOWPLAN_PROCESSES, scripts/processes.mjs):
    // process 1 runs what must run once per host – the restart history, the
    // setup checks and every timed job below; the others only answer
    // requests (lib/cluster/processes.ts, docs/architecture/multi-process.md).
    const { primaryProcess, announceReady } = await import("./lib/cluster/processes");
    const primary = primaryProcess();
    const { buildInfo, versionLine } = await import("./lib/build-info");
    const { startRestartTracker, setTrackerInstance } = await import("./lib/restarts/tracker");
    if (primary) startRestartTracker({ version: buildInfo().version || null });
    // What is running, as the first line Flowplan writes (#194).
    console.log(versionLine());
    // Cluster mode (FLOWPLAN_CLUSTER=1): PostgreSQL, Redis and S3 are
    // checked first – the process exits naming what is missing – then the
    // bus, the leader election and the heartbeat start (lib/cluster). Both
    // modes: a graceful shutdown on SIGTERM/SIGINT.
    const { startInstance } = await import("./lib/cluster/runtime");
    const { poolStats } = await import("./lib/db-driver");
    await startInstance({ pool: poolStats, version: buildInfo().version || null });
    // Event-loop delay and SQLite time for load tests (FLOWPLAN_METRICS_LOOP=1).
    const { startRuntimeMetrics } = await import("./lib/runtime-metrics");
    startRuntimeMetrics();
    // Catalogues of further languages for server-side texts: loaded on first
    // use, not here (lib/i18n-catalogs-server.ts); this only sets up the
    // loader, so a text that comes before its catalogue logs once.
    await import("./lib/i18n-catalogs-server");
    if (!primary) {
      // Requests per minute and this process's CPU and memory (lib/metrics.ts).
      const { startMetricsWorker } = await import("./lib/metrics-worker");
      startMetricsWorker();
      return;
    }
    // The database opened (and migrated) before the other processes of the
    // host start (they wait for this; nothing waits outside a group).
    const { startOpening } = await import("./lib/db-driver");
    await startOpening();
    announceReady();
    // The previous run's end into the restart history, then every five
    // minutes runs of other containers on this data folder that went stale.
    const { instanceId } = await import("./lib/cluster/config");
    setTrackerInstance(instanceId());
    const { startRestartWorker } = await import("./lib/restarts/history");
    await startRestartWorker().catch((e) => console.error("Restart history failed:", (e as Error)?.message));
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
    // SMTP/LDAP certificates not verified on purpose (#286): never silent.
    const { warnUnverifiedTlsOnce } = await import("./lib/tls-trust");
    warnUnverifiedTlsOnce();
    const { startPushWorker, dispatchPush } = await import("./lib/push");
    startPushWorker();
    const { startReminderWorker } = await import("./lib/date-reminders");
    await startReminderWorker(() => void dispatchPush());
    // The daily study reminder of flashcards (lib/study-reminders.ts).
    const { startStudyReminderWorker } = await import("./lib/study-reminders");
    startStudyReminderWorker(() => void dispatchPush());
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
    // SQLite with Litestream: a stuck replica in the bucket, every 15 minutes,
    // and Litestream's memory, every minute (lib/litestream-health.ts).
    const { startLitestreamWorker } = await import("./lib/litestream-health");
    startLitestreamWorker();
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
  }
}

// An error Next.js caught itself (a route handler or server rendering that
// threw, a server action): the request it belongs to keeps it for the error
// details of the monitoring (lib/error-details.ts) – the 5xx answer that
// follows is captured with it. Synchronous and without I/O.
export async function onRequestError(error: unknown, request: { path: string; method: string }, context: { routePath?: string; routeType?: string }) {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { noteRequestError, requestContext } = await import("./lib/request-context");
  if (requestContext()) {
    noteRequestError(error);
    return;
  }
  // No request context (should not happen): kept on its own, with the
  // route file Next.js names – never the path as typed.
  const { captureError } = await import("./lib/error-details");
  const { routeKey } = await import("./lib/metrics");
  const route = String(request?.path || "").startsWith("/api/") ? routeKey(request.method, request.path) : `${/^[A-Z]{3,7}$/.test(request?.method || "") ? request.method : "GET"} (pages)`;
  captureError({ method: request?.method, route: context?.routePath ? `${route} [${String(context.routePath).slice(0, 80)}]` : route, status: 500, error });
}
