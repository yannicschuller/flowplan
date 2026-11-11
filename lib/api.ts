import { withReadMemo } from "./read-memo";
import { deleteWorkspaceFont, plainLook, renameWorkspaceFont, saveWorkspaceTheme, setPlainLook, workspaceLook } from "./workspace-fonts";
import { requireDocumentSize } from "./document-size";
import { patchStillApplies } from "./row-patch";
import { bannersFor } from "./instance-banners";
import type { TransactionHook } from "./idempotency";
import { teamReply } from "./service-desk";
import { deletePlugin, updatePlugin } from "./plugins";
import { addDomain, removeDomain, savePublicationTheme } from "./custom-domains";
import { afterEncryptedPageCreate, e2eeCommand, encryptedPageData, guardEncryptedCommand, isEncryptedPage, makeSpaceEncrypted } from "./e2ee-server";
import { saveInstanceAi, saveUserAiPrefs, saveUserAiProvider, setUserAiPolicy } from "./ai/settings";
import { setAiBlock, setAiRule } from "./ai/access";
import { aiStatus } from "./ai/resolve";
import { markdownSource } from "./markdown";
import { markdownToHtml } from "./markdown-import";
import { legalLinks } from "./legal-links";
import { aboutInfo } from "./about";
import { knownUpdate } from "./update-check";
import { deleteAccount, deleteOwnAccount, deletionPlan, ownDeletionPlan, setUserDisabled } from "./account-deletion";
import { mergeAccounts, mergePreview } from "./account-merge";
import { confirmAddress } from "./local-auth";
import { assertMayCreateWorkspace, effectiveUserLimits, ownedWorkspaces, setUserLimits, userBytes, userStorageCheckpoint } from "./user-limits";
import { fixedLanguage, setFixedLanguage } from "./user-locale";
import { validateTicketPrefix } from "./ticket-refs";
import { prepareSubtaskFields } from "./subtasks-server";
import { timeCommand } from "./time-tracking";
import { sprintCommand } from "./sprints";
import { gitSetup } from "./git-integration";
import { gitAccessCommand } from "./git-backlinks";
import { issueSyncCommand } from "./issue-sync";
import { queueIssuePush } from "./issue-sync-queue";
import { deleteRecordView, saveRecordView } from "./cross-records";
import { createCalDavAccess, revokeCalDavAccess } from "./caldav";
import { deleteCalendarMapping, disconnectCalendar, saveCalendarMapping } from "./calendar-sync";
import { createMeetingNote } from "./meeting-notes";
import { createMonthSummary, saveAiSummary } from "./journal-summary";
import { restoreBlock } from "./restore-block";
import { saveSurvey } from "./survey-server";
import { transferRows } from "./row-transfer";
import { clientSettings, databaseSettings, updateDatabaseSettings } from "./database-settings";
import {
  restoreWhiteboardSnapshot,
  syncWhiteboard,
  whiteboardData,
} from "./whiteboard";
import { journalDate, rollJournal, rollJournals } from "./journal";
import { journalDayLink, pageCounts, removeEmptyJournalDays } from "./journal-days";
import { recentVisits, recordPageEdit, setFollowing } from "./page-activity";
import { commentRecipients, commentTextMentions } from "./comment-recipients";
import { MAX_ARCHIVE_ROWS } from "./archive-limits";
import { propertiesCollapsed, recordPropertiesCollapsed, setPropertiesCollapsed, setRecordPropertiesCollapsed } from "./page-view-prefs";
import { saveSidebarState, sidebarState } from "./sidebar-state";
import { changeDocTask, dueTaskCount, indexPageTasks, reindexRowTasks, syncDocTasks } from "./doc-tasks";
import { syncedUsage } from "./synced-blocks";
import { linkMention } from "./page-graph";
import { followRename } from "./link-titles";
import { captureRecord, setCaptureTarget } from "./capture";
import { deleteInboundAddress, rotateInboundToken, saveInboundAddress } from "./inbound-mail";
import { pageToRecord } from "./page-to-record";
import { recordToPage } from "./record-to-page";
import { textBacklinks } from "./text-backlinks";
import { hiddenFileIds } from "./row-files";
import { addBookmarks, bookmarksDatabase, parseBookmarksHtml } from "./web-clip";
import { transcriptionEnabled } from "./transcribe";
import { drawioConfig } from "./drawio";
import {
  dayEntry,
  inPinJournal,
  PIN_JOURNAL_NOT_SHARED,
  journalDayDetails,
  journalLocked,
  lockingJournal,
  LOCKED_NOTICE,
  lockedNotification,
  mayResetJournalLock,
  journalOf,
  journalSettings,
  journalSidebarModes,
  lockJournalNow,
  pinAttemptKey,
  pinSchema,
  requireUnlocked,
  saveDayEntry,
  setJournalCalendar,
  setJournalLock,
  setJournalOptions,
  setJournalTemplate,
  setJournalTrackers,
  templateFromDay,
  trackerSchema,
  unlockJournal,
} from "./journal-extras";
import { setCompletedMine } from "./journal-completed";
import { transferPages } from "./page-transfer";
import { demoAllows } from "./demo";
import { adminResetLink, isLocalAccount, setLocalAdmin } from "./local-auth";
import { isLdapAccount } from "./ldap-auth";
import { validWorkspaceIcon } from "./workspace-icon";
import { parseRecordLayout, recordLayoutSchema } from "./record-layout";
import { afterContactWrite, contactCellsFor, contactsPageData } from "./contacts";
import {
  assertRowAccess,
  canManageRow,
  hiddenRowIds,
  rowGrants,
  setRowAccess,
  visibleRows,
} from "./row-access";
import {
  assertFieldsWritable,
  hasFieldAccess,
  mergeHiddenFields,
  publicHiddenFieldIds,
  readOnlyFieldIds,
  stripCells,
  unwritableFieldIds,
  validateFieldAccess,
  visibleFields,
} from "./field-access";
import { cellText } from "./cell-text";
import { scheduleRow, cascadeTimeline, linkTimeline } from "./row-schedule";
import { recordDocumentAuthors } from "./document-authors";
import { importBibliography, removeFromBibliography } from "./citations-server";
import { rewriteFormulaReferences } from "./formula";
import { validateCalculations } from "./database-summary";
import { spaceColorSchema, spaceIconSchema } from "./space-appearance";
import { mutateLinkedDatabase } from "./linked-databases";
import { notesToRecords } from "./whiteboard-to-records";
import {
  manageSpace,
  duplicateSpace,
  manageWorkspace,
  canManageSpace,
  requireSpaceManager,
  removeFromWorkspace,
} from "./workspace-lifecycle";
import { saveSpaceGitExport, sweepSpaceGitCopies } from "./space-git-export";
import { reorderSpaces, SPACE_ORDER, visibleSpaces } from "./space-order";
import {
  coverSchema,
  appearanceSchema,
  pageAppearance,
  pageIconSchema,
  iconSizeSchema,
} from "./page-appearance";
import {
  pageImages,
  pageFiles,
  validateCover,
  validateIcon,
  applyAppearance,
  snapshotAppearance,
} from "./page-covers";
import { documentPreview } from "./document-preview";
import {
  moveRow,
  maintainRowOrders,
  validateViewRowOrders,
} from "./row-order-server";
import { remapViewReferences } from "./view-references";
import { remapLinkedAttributes } from "./linked-view-references";
import { transformFilterGroup } from "./database-filters";
import type { Filter } from "./types";
import { captureTemplateFiles } from "./template-files";
import { detachOccurrence } from "./recurrence-detach";
import { instanceSettings, saveInstanceSettings } from "./instance-settings";
import { incidentThreshold, notificationPrefs, resetNotificationPrefs, setEmailForAll, setNotificationPref } from "./notification-prefs";
import { setWeeklyDigest, weeklyDigestPrefs } from "./weekly-digest";
import { saveShortcuts, userShortcuts } from "./user-shortcuts";
import { homeLayout, resetHomeLayout, saveHomeConfig, saveHomeLayout, saveHomeNote, setTeamDefault } from "./home-layout";
import { sharePage, updatePageShare } from "./page-share";
import { limitInviter, mailAllowed } from "./action-limits";
import { templateCategoryIds } from "./template-categories";
import {
  createCollection,
  deleteCollection,
  duplicateCollection,
  listCollections,
  reorderCollections,
  restoreCollection,
  saveSearchAsCollection,
  updateCollection,
} from "./collections";
import {
  requireTemplate,
  applyPageTemplate,
  databaseTemplateExtras,
  managePageTemplate,
  copyPageTemplate,
  pageTemplateDependencies,
  requireTemplateScope,
  spaceRefsMessage,
  stripSpaceRefs,
  templateSpaceRefs,
} from "./page-templates";
import { formSettings, saveFormSubmission } from "./forms";
import { formConfigSchema } from "./form-settings";
import {
  bulkRows,
  databaseSnapshot,
  autoDatabaseSnapshot,
  validateCellPatch,
  validateImportedCells,
  addImportedOptions,
} from "./database-operations";
import { field, view } from "./database-schema";
import { publishPage, publicationSettings, protectPublication } from "./publication";
import { protectionChanges } from "./share-access";
import { adminResetTwoFactor } from "./two-factor";
import { manageShareLink, listShareLinks } from "./share-links";
import { relatedData, validateDatabaseRelations } from "./related-data";
import { configureRelation } from "./two-way-relations";
import { relationPairs, restoreRelationPairs } from "./relation-sync";
import { duplicatePageTree } from "./page-tree";
import { applyStarterTemplate, starterTemplates } from "./starter-templates";
import { templateKeys } from "./template-catalog";
import {
  requireRow,
  rowTemplates,
  selectedRowTemplate,
  replaceRowDocument,
  syncRowDocument,
  snapshotRow,
  restoreRow,
  saveRowTemplate,
  manageRowTemplate,
} from "./row-documents";
import { applyTemplate, fillNewRecord, prepareManualApply, rawTemplate, storeTemplateNames } from "./record-template-apply";
import { z } from "zod";
import * as Y from "yjs";
import { all, one, run, id, transaction, transactionKeepingRefusals, audit, db, nowText, sql, lockMembership } from "./db";
import { convertFormattedValues } from "./formatted-text";
import { applyOptionRenames } from "./option-renames-server";
import { restoreVersionSettings } from "./database-version-settings";
import { securityEvent } from "./security-events";
import { noteDangerousHtml } from "./security-events";
import { HttpError, acceptPendingInvites, inviteToken } from "./auth";
import {
  cleanHtml,
  htmlState,
  stateHtml,
  markdownHtml,
  escaped,
} from "./document-server";
import {
  isGuest,
  requireAdmin,
  requireMember,
  requirePage,
  spaceRole,
  pageRole,
} from "./permissions";
import {
  createPage,
  databaseKinds,
} from "./seed";
import type {
  Identity,
  Page,
  Space,
  Database,
  Row,
  Field,
  View,
} from "./types";
const str = z.string().min(1).max(500),
  uuid = z.string().uuid();
export async function database(pid: string): Promise<Database> {
  const raw = await one<{
    page_id: string;
    fields: string;
    views: string;
    version: number;
    record_layout?: string;
    settings?: string;
  }>("SELECT * FROM databases WHERE page_id=?", pid);
  if (!raw) throw new HttpError(404, "Datenbank nicht gefunden.");
  const { record_layout, settings: _settings, ...rest } = raw;
  return {
    ...rest,
    fields: JSON.parse(raw.fields),
    views: JSON.parse(raw.views),
    recordLayout: parseRecordLayout(record_layout),
    settings: clientSettings(await databaseSettings(pid)),
  };
}
export async function rows(pid: string): Promise<Row[]> {
  return (await all<Row & { cells: string }>(
    "SELECT * FROM rows WHERE page_id=? ORDER BY position",
    pid,
  )).map((r) => ({ ...r, cells: JSON.parse(r.cells) }));
}
// Records visible on public pages and share links: private ones stay hidden.
// Cells of properties with a read rule are left out (lib/field-access.ts).
export async function publicRows(pid: string): Promise<Row[]> {
  const hidden = publicHiddenFieldIds((await database(pid)).fields);
  return (await rows(pid))
    .filter((r) => r.access !== "private")
    .map((r) => ({ ...r, cells: stripCells(r.cells, hidden) }));
}
// `agent`: the request's user agent – the mobile apps get no sponsor link
// (lib/about.ts).
export async function bootstrap(user: Identity, wid?: string, agent?: string | null) {
  if (!user.demo && !user.apiScope) await acceptPendingInvites(user.id);
  const workspaces = (await all<{
    id: string;
    name: string;
    icon: string;
    role: string;
    guest: number;
    theme?: string | null;
  }>(
    "SELECT w.*,m.role,EXISTS(SELECT 1 FROM workspace_guests g WHERE g.workspace_id=w.id AND g.user_id=m.user_id) guest FROM workspaces w JOIN members m ON m.workspace_id=w.id WHERE m.user_id=? ORDER BY w.created_at",
    user.id,
    // The look comes once, parsed, for the open workspace (`look` below).
  )).map(({ theme: _theme, ...w }) => w);
  const workspace = workspaces.find((w) => w.id === wid) || workspaces[0];
  if (!workspace) throw new HttpError(404, "Kein Arbeitsbereich.");
  // Workflow pages are not for guests (#168).
  const guestHere = !!workspace.guest;
  const pages = await filterAsync(await all<Page>(
    // Synced blocks live inside the pages that show them, not in the tree.
    "SELECT * FROM pages WHERE workspace_id=? AND synced=0 ORDER BY position",
    workspace.id,
  ), async (p) => !(guestHere && p.kind === "workflow") && !!(await pageRole(user, p)));
  const visibleSpaceIds = new Set(pages.map((p) => p.space_id));
  const lockedInbox = await lockedNotification();
  return {
    user,
    // Signs in with e-mail and password (and passkeys) rather than SSO.
    localAccount: await isLocalAccount(user.id),
    // Sign-in methods (#101): a local account may have removed its
    // password; whether an SSO identity is connected.
    hasPassword: !!(await one("SELECT 1 FROM local_accounts WHERE user_id=? AND password_hash<>''", user.id)),
    ssoLinked: !!(await one("SELECT 1 FROM user_identities WHERE user_id=?", user.id)),
    ldapAccount: await isLdapAccount(user.id),
    workspaces,
    workspace,
    // The workspace's look (#196, lib/workspace-theme.ts) and whether this
    // person chose Flowplan's own look instead.
    look: await workspaceLook(workspace.id),
    plainLook: await plainLook(user.id),
    pages,
    pageCounts: await pageCounts(user, workspace.id, pages),
    // "Tage in der Seitenleiste" of journals that differ from the default.
    journalSidebar: await journalSidebarModes(workspace.id),
    // Pages owned by me whose review date has passed (lib/page-review.ts).
    reviewsDue: reviewsDue(user, pages),
    // In the workspace's order (lib/space-order.ts).
    spaces: await visibleSpaces(user, workspace.id, visibleSpaceIds),
    trashedSpaces: await filterAsync(await all<Space>(
      `SELECT * FROM spaces WHERE workspace_id=? AND deleted_at IS NOT NULL ORDER BY ${SPACE_ORDER}`,
      workspace.id,
    ), async (s) => await canManageSpace(user, s)),
    // Days pages stay in the trash (0 = until emptied; lib/trash.ts).
    trashDays: await trashDays(),
    managedSpaces: await filterAsync(await all<Space>(
      `SELECT * FROM spaces WHERE workspace_id=? AND deleted_at IS NULL ORDER BY ${SPACE_ORDER}`,
      workspace.id,
    ), async (s) => await canManageSpace(user, s)),
    favorites: (await all<{ page_id: string }>(
      "SELECT page_id FROM favorites WHERE user_id=?",
      user.id,
    )).map((f) => f.page_id),
    // Own and shared collections, in the person's order (lib/collections.ts).
    collections: await listCollections(user, workspace.id),
    // Tags and property definitions, and the tags of the pages shown
    // (lib/page-properties-server.ts).
    taxonomy: await workspaceTaxonomy(user, workspace.id, pages),
    recentVisits: await recentVisits(user, workspace.id, 8),
    dueTasks: await dueTaskCount(user, workspace.id),
    notificationPrefs: await notificationPrefs(user),
    ...(user.isAdmin ? { incidentThreshold: await incidentThreshold(user.id) } : {}),
    weeklyDigest: await weeklyDigestPrefs(user),
    // Own keyboard shortcuts (lib/keymap.ts), only those that differ.
    shortcuts: await userShortcuts(user),
    // What this person folded and unfolded in the sidebar (#97,
    // lib/sidebar-state.ts); null: nothing yet.
    sidebar: await sidebarState(user, workspace.id),
    // The start page of this workspace (lib/home-layout.ts).
    home: await homeLayout(user, workspace.id),
    instance: {
      name: (await instanceSettings()).name,
      announcement: (await instanceSettings()).announcement,
      // Banners to click away once (lib/instance-banners.ts).
      banners: await bannersFor(user),
      allowWorkspaceCreation:
        (await instanceSettings()).allowWorkspaceCreation || user.isAdmin,
      transcription: transcriptionEnabled() && !user.demo,
      // The draw.io editor (DRAWIO_URL, lib/drawio.ts); null when the
      // address set is not usable.
      drawio: drawioConfig(),
      mail: !!mailConfig(),
      legal: legalLinks(),
      // Settings → Über Flowplan; a newer release for administrators.
      about: { ...aboutInfo(agent), ...(user.isAdmin ? { update: knownUpdate() } : {}) },
    },
    // What applies to me: limits with my usage, and my fixed language.
    myLimits: user.isAdmin
      ? null
      : { ...(await effectiveUserLimits(user.id)), usedBytes: await userBytes(user.id), ownedWorkspaces: await ownedWorkspaces(user.id) },
    language: await fixedLanguage(user.id),
    // New accounts see the introduction once (components/onboarding.tsx).
    onboarding: !user.demo && !(await one<{ onboarded_at: number | null }>("SELECT onboarded_at FROM users WHERE id=?", user.id))?.onboarded_at,
    // Favourite records of readable databases in this workspace.
    favoriteRows: (await filterAsync(await all<Page & { row_id: string; row_icon: string | null; cells: string; fields: string }>(
      `SELECT p.*,r.id row_id,r.icon row_icon,r.cells,d.fields FROM row_favorites f
       JOIN rows r ON r.id=f.row_id JOIN pages p ON p.id=f.page_id
       JOIN databases d ON d.page_id=p.id
       WHERE f.user_id=? AND p.workspace_id=? AND p.deleted_at IS NULL`,
      user.id,
      workspace.id,
    ), async (p) => await pageRole(user, p)))
      .map((p) => ({
        pageId: p.id,
        rowId: p.row_id,
        // The record's own icon (the sidebar shows the file icon without one).
        icon: p.row_icon || "",
        title:
          cellText(
            JSON.parse(p.cells)[
              (JSON.parse(p.fields) as Field[])[0]?.id || "title"
            ],
          ) || "Ohne Titel",
      })),
    // Guests only see themselves; members see who is a guest.
    members: (await all(
      `SELECT u.id,u.name,u.email,u.disabled,u.avatar,m.role,
       EXISTS(SELECT 1 FROM workspace_guests g WHERE g.workspace_id=m.workspace_id AND g.user_id=u.id) guest
       FROM users u JOIN members m ON m.user_id=u.id WHERE m.workspace_id=?`,
      workspace.id,
    )).filter(
      (m) => !(workspace as { guest?: number }).guest || m.id === user.id,
    ),
    // Behind a journal PIN not entered: only that the journal is locked.
    notifications: await mapAsync(await all<Record<string, unknown> & { page_id: string | null; kind: string | null; body: string | null }>(
      "SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC,seq DESC LIMIT 100",
      user.id,
    ), async (n) => ((await lockedInbox(n, user.id)) ? { ...n, body: LOCKED_NOTICE } : n)),
    // Which AI features work here, with which provider, and which pages the
    // AI may not read (lib/ai). Never keys or addresses beyond the host.
    ai: await aiStatus(user, workspace.id, pages),
  };
}
export async function pageData(user: Identity, pid: string, options: { presence?: boolean } = {}) {
  const data = await pageContent(user, pid, options);
  // Tags and property values (#70); none behind a journal PIN or for
  // encrypted pages.
  if ((data as { locked?: unknown }).locked) return data;
  // Whether this person folds the properties of the records (#186), per
  // kind of device, so a record opens in the right state without a jump.
  const records = "database" in data && data.database ? { recordPropertiesCollapsed: await recordPropertiesCollapsed(user, data.page.id) } : {};
  const properties = await pageMetaFor(data.page);
  // Whether this person collapsed the bar (#83; null: the default applies),
  // so the bar opens in the right state without a jump.
  return properties ? { ...data, ...records, properties, propertiesCollapsed: await propertiesCollapsed(user, data.page.id) } : { ...data, ...records };
}
async function pageContent(user: Identity, pid: string, options: { presence?: boolean } = {}) {
  const p = await requirePage(user, pid);
  const role = await pageRole(user, p);
  // Behind a journal PIN: only what the lock screen needs.
  // Any page below the journal shows the lock screen of that journal.
  const lockedBy = await lockingJournal(user, p);
  if (lockedBy)
    return {
      page: p,
      role,
      // Owners of the workspace may reset the PIN from the lock screen.
      locked: { journalId: lockedBy, canReset: await mayResetJournalLock(user, (await one<Page>("SELECT * FROM pages WHERE id=?", lockedBy))!) },
      comments: [],
      snapshots: [],
      present: [],
      backlinks: [],
      images: [],
      shareLinks: [],
      html: "",
      state: null,
      generation: "1",
    };
  // End-to-end encrypted: the content comes as ciphertext through its own
  // log (lib/e2ee-server.ts); here only what the page shell needs.
  if (await isEncryptedPage(p)) return { ...(await encryptedPageData(user, p)) };
  // Pages and records whose text links here.
  const backlinks = await textBacklinks(user, p);
  const hidden = p.kind === "database" ? (await hiddenRowIds(user, p)) : new Set();
  const comments = await mapAsync((await all<{ id: string; row_id: string | null }>(
    `SELECT c.id,c.page_id,c.row_id,c.author_id,c.body,c.resolved,c.created_at,u.name FROM comments c JOIN users u ON u.id=c.author_id WHERE page_id=?
     UNION ALL SELECT id,page_id,row_id,NULL author_id,body,resolved,created_at,name || ' (Gast)' name FROM shared_comments WHERE page_id=? ORDER BY created_at`,
    pid,
    pid,
  ))
    .filter((c) => !c.row_id || !hidden.has(c.row_id)), async (c) => ({ ...c, reactions: await commentReactions(user, c.id) }));
  const snapshots = await all(
    "SELECT id,title,created_at,kind FROM snapshots WHERE page_id=? ORDER BY created_at DESC,seq DESC LIMIT 50",
    pid,
  );
  const present = await all(
    "SELECT u.id,u.name FROM presence p JOIN users u ON u.id=p.user_id WHERE p.page_id=? AND seen>?",
    pid,
    Date.now() - 45000,
  );
  if (options.presence !== false)
    await run(
      "INSERT INTO presence VALUES(?,?,?) ON CONFLICT(page_id,user_id) DO UPDATE SET seen=excluded.seen",
      pid,
      user.id,
      Date.now(),
    );
  if (p.kind === "database") {
    const data = await database(pid);
    // This database's own rows are already in rows (the client adds them).
    const relations = await relatedData(user, p, { rootRows: false });
    relations.related[pid] = [];
    const documentHtml = new Map(
      (await all<{ row_id: string; html: string }>(
        "SELECT d.row_id,d.html FROM row_documents d JOIN rows r ON r.id=d.row_id WHERE r.page_id=?",
        pid,
      )).map((d) => [d.row_id, d.html]),
    );
    return {
      page: p,
      images: await pageImages(pid),
      files: await pageFiles(pid, await hiddenFileIds(user, p)),
      publication: await publicationSettings(pid),
      shareLinks: role === "viewer" ? [] : (await listShareLinks(user, pid)),
      role,
      comments,
      snapshots,
      present,
      backlinks,
      // Properties hidden from this person are left out (lib/field-access.ts).
      database: { ...data, fields: await visibleFields(user, p, data.fields) },
      // Visible properties this person may not change.
      readOnlyFields: await readOnlyFieldIds(user, p, data.fields),
      relationPairs: await relationPairs(pid),
      // Each record carries the viewer's role; hidden ones are left out.
      rows: await mapAsync(await visibleRows(user, p, await rows(pid)), async (r) => ({
        ...r,
        preview: documentPreview(documentHtml.get(r.id) ?? r.content ?? ""),
        ...(r.access !== "inherit" && await canManageRow(user, p, r)
          ? { grants: await rowGrants(r.id) }
          : {}),
      })),
      rowTemplates: await rowTemplates(pid),
      // Groups for record permissions.
      groups:
        role === "viewer"
          ? []
          : (await all<{ id: string; name: string }>(
              "SELECT id,name FROM groups WHERE workspace_id=? ORDER BY name",
              p.workspace_id,
            )),
      reminders: await listDateReminders(user, pid),
      ...relations,
      form: await formSettings(pid),
      // Contacts databases: records kept by the LDAP directory (lib/contacts.ts).
      contacts: await contactsPageData(pid),
    };
  }
  if (p.kind === "dashboard")
    return {
      page: p,
      images: await pageImages(pid),
      publication: await publicationSettings(pid),
      shareLinks: role === "viewer" ? [] : (await listShareLinks(user, pid)),
      role,
      comments,
      snapshots,
      present,
      backlinks,
      dashboard: await dashboardData(user, p, role),
      html: "",
    };
  // Workflow pages (#168): their state, draft and check (lib/workflows/store.ts);
  // never for guests, never shared or published.
  if (p.kind === "workflow")
    return {
      page: p,
      images: [],
      publication: null,
      shareLinks: [],
      role,
      comments,
      snapshots,
      present,
      backlinks,
      workflow: await workflowState(user, pid),
      html: "",
    };
  if (p.kind === "notebook")
    return {
      page: p,
      images: await pageImages(pid),
      publication: await publicationSettings(pid),
      shareLinks: role === "viewer" ? [] : (await listShareLinks(user, pid)),
      role,
      comments,
      snapshots,
      present,
      backlinks,
      notebook: await notebookData(user, p),
      html: "",
    };
  if (p.kind === "whiteboard")
    return {
      page: p,
      images: await pageImages(pid),
      publication: await publicationSettings(pid),
      shareLinks: role === "viewer" ? [] : (await listShareLinks(user, pid)),
      role,
      comments,
      snapshots,
      present,
      backlinks,
      whiteboard: await whiteboardData(p),
      // Texts on the board, for search and previews.
      html: String(
        (await one("SELECT html FROM documents WHERE page_id=?", pid))?.html || "",
      ),
    };
  let doc = await one<{ state: Uint8Array | null; html: string; generation: string }>(
    "SELECT * FROM documents WHERE page_id=?",
    pid,
  );
  if (doc && !doc.state) {
    const state = htmlState(doc.html);
    await run(
      "UPDATE documents SET state=? WHERE page_id=? AND state IS NULL",
      state,
      pid,
    );
    doc = await one<{ state: Uint8Array | null; html: string; generation: string }>(
      "SELECT * FROM documents WHERE page_id=?",
      pid,
    );
  }
  return {
    page: p,
    images: await pageImages(pid),
    publication: await publicationSettings(pid),
    shareLinks: role === "viewer" ? [] : (await listShareLinks(user, pid)),
    role,
    comments,
    snapshots,
    present,
    backlinks,
    ...(p.kind === "journal"
      ? {
          journal: {
            days: await journalDayDetails(p.id),
            settings: (({ icsUrl, ...rest }) =>
              role === "viewer" ? rest : { ...rest, icsUrl })(
              await journalSettings(p.id),
            ),
          },
        }
      : {}),
    ...(p.synced ? { syncedUsage: await syncedUsage(user, p) } : {}),
    ...(p.journal_date && await journalOf(p)
      ? {
          journalDay: {
            journalId: p.parent_id,
            date: p.journal_date,
            trackers: (await journalSettings(p.parent_id!)).trackers,
            options: (await journalSettings(p.parent_id!)).options,
            entry: await dayEntry(p.id),
          },
        }
      : {}),
    state: doc?.state ? Buffer.from(doc.state).toString("base64") : null,
    html: doc?.html || "",
    generation: doc?.generation || "1",
  };
}
// Where page.move (and page.moveCheck) puts a page.
async function moveDestination(user: Identity, p: Page, b: Record<string, unknown>) {
  const placement = z
    .enum(["before", "after", "inside"])
    .parse(b.placement || "inside");
  const target = b.targetId
    ? (await requirePage(user, uuid.parse(b.targetId), true))
    : null;
  const parent = target
    ? placement === "inside"
      ? target.id
      : target.parent_id
    : b.parentId
      ? uuid.parse(b.parentId)
      : null;
  const destinationParent = parent
    ? (await requirePage(user, parent, true))
    : null;
  // Not into a journal (or below one) behind a PIN the person has not entered.
  if (destinationParent) await requireUnlocked(user, destinationParent);
  const sid: string =
    destinationParent?.space_id ||
    target?.space_id ||
    (b.spaceId ? uuid.parse(b.spaceId) : p.space_id);
  const destination = await one<Space>("SELECT * FROM spaces WHERE id=?", sid);
  return { placement, target, parent, destinationParent, sid, destination };
}
async function descendants(pid: string): Promise<string[]> {
  return (await all<{ id: string }>(
    "WITH RECURSIVE tree(id) AS (SELECT id FROM pages WHERE id=? UNION ALL SELECT p.id FROM pages p JOIN tree t ON p.parent_id=t.id) SELECT id FROM tree",
    pid,
  )).map((p) => p.id);
}
// Snapshot images whose file was removed meanwhile are dropped, not restored.
async function restorableImage(
  pageId: string,
  value: unknown,
  validate: (pageId: string, value: string) => void | Promise<void>,
) {
  const parsed = pageIconSchema.safeParse(value);
  if (!parsed.success || !parsed.data) return "";
  try {
    await validate(pageId, parsed.data);
    return parsed.data;
  } catch {
    return "";
  }
}
const GIT_EXPORT_ENDS = new Set([
  "space.gitExport",
  "space.delete",
  "space.purge",
  "trash.empty",
  "workspace.delete",
  "workspace.leave",
  "member.role",
  "member.guest",
  "account.delete",
  "admin.deleteUser",
  "admin.mergeUsers",
]);
export async function command(
  user: Identity,
  input: unknown,
  withinTransaction = false,
  // An Idempotency-Key, reserved and answered in the action's transaction
  // (lib/idempotency.ts idempotencyHook).
  keyed?: TransactionHook,
): Promise<unknown> {
  // Permission lookups are remembered until the next write (lib/read-memo.ts).
  return await withReadMemo(async () => await runCommand(user, input, withinTransaction, keyed));
}
async function runCommand(
  user: Identity,
  input: unknown,
  withinTransaction: boolean,
  keyed: TransactionHook | undefined,
): Promise<unknown> {
  const base = z.object({ action: str }).passthrough().parse(input);
  const action = base.action;
  const b = base as Record<string, unknown>;
  // Read tokens only read; tokens never administer the instance.
  if (user.apiScope === "read")
    throw new HttpError(403, "Dieses API-Token darf nur lesen.");
  if (user.apiScope && (action.startsWith("admin.") || action.startsWith("token.") || action.startsWith("ai.")))
    throw new HttpError(403, "Mit einem API-Token nicht erlaubt.");
  if (user.demo && !demoAllows(action, b))
    throw new HttpError(
      403,
      "In der Demo nicht verfügbar. Registriere dich, um das zu nutzen.",
    );
  const pid = () => uuid.parse(b.pageId);
  const wid = () => uuid.parse(b.workspaceId);
  const write = async () => {
    const p = await requirePage(user, pid(), true);
    await requireUnlocked(user, p);
    if (
      p.locked &&
      !["page.update", "page.delete", "page.snapshot"].includes(action)
    )
      throw new HttpError(409, "Diese Seite ist gesperrt.");
    return p;
  };
  // Work that must only happen once the transaction is committed.
  const afterCommit: (() => unknown)[] = [];
  // Workflow events of a move, once the page is in its new place.
  const afterMove: (() => Promise<unknown>)[] = [];
  const execute = async () => {
    let result: unknown = { ok: true };
    // Pages of encrypted spaces: only what works without plaintext.
    await guardEncryptedCommand(action, b);
    switch (action) {
      case "e2ee.identity.setup":
      case "e2ee.identity.update":
      case "e2ee.identity.reset":
      case "e2ee.member.add":
      case "e2ee.member.remove":
      case "e2ee.rotate":
      case "e2ee.append":
      case "e2ee.compact":
      case "e2ee.title":
        result = await e2eeCommand(user, action, b, afterCommit);
        break;
      case "workspace.create":
        if (!(await instanceSettings()).allowWorkspaceCreation && !user.isAdmin)
          throw new HttpError(
            403,
            "Neue Arbeitsbereiche legen auf dieser Instanz nur Admins an.",
          );
        await assertMayCreateWorkspace(user);
        result = { id: await createWorkspaceInner(user.id, str.parse(b.name)) };
        break;
      case "admin.settings":
        requireAdmin(user);
        result = await saveInstanceSettings(b.settings);
        break;
      // AI (lib/ai): administration, own settings, what the AI may read.
      case "admin.ai":
        result = await saveInstanceAi(user, b);
        break;
      case "admin.aiUser":
        result = await setUserAiPolicy(user, b);
        break;
      case "ai.settings":
        result = await saveUserAiPrefs(user, b);
        break;
      case "ai.provider":
        result = await saveUserAiProvider(user, b);
        break;
      case "ai.rule":
        result = await setAiRule(user, b);
        break;
      case "ai.block":
        result = await setAiBlock(user, b);
        break;
      case "profile.onboarded":
        await run("UPDATE users SET onboarded_at=? WHERE id=?", Date.now(), user.id);
        result = { ok: true };
        break;
      case "notification.reset":
        result = await resetNotificationPrefs(user);
        break;
      case "notification.email":
        result = await setEmailForAll(user, b.email);
        break;
      // The weekly digest e-mail (lib/weekly-digest.ts).
      case "notification.weekly":
        result = await setWeeklyDigest(user, b);
        break;
      // Own keyboard shortcuts (lib/user-shortcuts.ts).
      case "shortcuts.save":
        result = await saveShortcuts(user, b);
        break;
      // The personal start page (lib/home-layout.ts).
      case "home.save":
        result = await saveHomeLayout(user, b);
        break;
      case "home.reset":
        result = await resetHomeLayout(user, b);
        break;
      case "home.note":
        result = await saveHomeNote(user, b);
        break;
      case "home.config":
        result = await saveHomeConfig(user, b);
        break;
      case "home.default":
        result = await setTeamDefault(user, b);
        break;
      // Flowplan's own look instead of the workspaces' (#196).
      case "profile.plainLook":
        result = await setPlainLook(user, b.plain);
        break;
      // A workspace's look: read by its members (the settings list every
      // uploaded face), changed by its owners (lib/workspace-fonts.ts).
      case "workspace.look":
        await requireMember(user, wid());
        result = await workspaceLook(wid(), true);
        break;
      case "workspace.theme":
        result = await saveWorkspaceTheme(user, wid(), b.theme);
        break;
      case "workspace.font.rename":
        result = await renameWorkspaceFont(user, wid(), b.fontId, b.name);
        break;
      case "workspace.font.delete":
        result = await deleteWorkspaceFont(user, wid(), b.fontId);
        break;
      case "profile.language":
        result = { language: await setFixedLanguage(user.id, b.language) };
        break;
      case "account.deletePlan":
        result = await ownDeletionPlan(user);
        break;
      case "account.delete":
        result = await deleteOwnAccount(user, b);
        break;
      case "admin.deletePlan":
        requireAdmin(user);
        result = await deletionPlan(z.uuid().parse(b.userId));
        break;
      case "admin.deleteUser":
        requireAdmin(user);
        result = await deleteAccount(user, z.uuid().parse(b.userId));
        break;
      // Two accounts of one person (#101, lib/account-merge.ts): the
      // preview, then the merge in this transaction.
      case "admin.mergePlan":
        requireAdmin(user);
        result = await mergePreview(user, z.uuid().parse(b.sourceId), z.uuid().parse(b.targetId));
        break;
      case "admin.mergeUsers": {
        requireAdmin(user);
        const merged = await mergeAccounts(user, z.uuid().parse(b.sourceId), z.uuid().parse(b.targetId));
        afterCommit.push(...merged.publish);
        result = merged.preview;
        break;
      }
      case "admin.confirmEmail":
        requireAdmin(user);
        await confirmAddress(z.uuid().parse(b.userId));
        break;
      case "admin.userLimits":
        requireAdmin(user);
        result = await setUserLimits(z.uuid().parse(b.userId), b.limits);
        break;
      case "workspace.update": {
        await requireMember(user, wid(), "owner");
        if (b.name !== undefined)
          await run(
            "UPDATE workspaces SET name=? WHERE id=?",
            str.parse(b.name),
            wid(),
          );
        if (b.icon !== undefined) {
          const icon = validWorkspaceIcon(b.icon);
          if (icon === null)
            throw new HttpError(
              400,
              "Als Symbol sind ein Emoji, ein Bibliothekssymbol oder ein Bild (PNG, JPEG, WebP bis 100 KB) möglich.",
            );
          await run("UPDATE workspaces SET icon=? WHERE id=?", icon, wid());
        }
        break;
      }
      case "workspace.delete":
      case "workspace.leave":
        result = await manageWorkspace(user, b);
        break;
      case "space.delete":
      case "space.restore":
      case "space.purge":
        result = await manageSpace(user, b);
        break;
      case "page.import": {
        await requireMember(user, wid(), "editor");
        const sid = uuid.parse(b.spaceId),
          space = await one<Space>(
            "SELECT * FROM spaces WHERE id=? AND workspace_id=?",
            sid,
            wid(),
          );
        if (
          !space ||
          !["owner", "editor"].includes(await spaceRole(user, space) || "")
        )
          throw new HttpError(403, "Kein Zugriff");
        const content = z.string().max(2_000_000).parse(b.content);
        // Markdown: tags and properties of the frontmatter (#70); a
        // frontmatter with nothing else is not repeated in the text.
        const front = b.format === "markdown" ? splitFrontmatter(content) : null;
        const frontMeta = front
          ? (await frontmatterMeta(front.data, wid(), await memberByName(wid()), { createDefinitions: await canManageScope(user, wid(), sid), spaceId: sid }))
          : null;
        const frontTaken =
          !!front &&
          Object.keys(front.data).length > 0 &&
          Object.keys(front.data).every((key) => frontMeta!.consumed.includes(key) || ["aliases", "alias"].includes(key.trim().toLowerCase()));
        const html =
          b.format === "html"
            ? (noteDangerousHtml(content, { actorId: user.id, detail: "page import" }), cleanHtml(content))
            : b.format === "markdown"
              ? markdownHtml(frontTaken ? front!.body : content)
              : `<p>${escaped(content).replaceAll("\n", "</p><p>")}</p>`;
        const np = await createPage(wid(), sid, user.id, str.parse(b.title));
        if (front && frontMeta) {
          await applyPortableMeta(user, { id: np, workspace_id: wid(), space_id: sid }, frontMeta.meta, { createDefinitions: await canManageScope(user, wid(), sid) });
          const aliases = frontmatterAliases(front.data);
          if (aliases.length) await run("UPDATE pages SET aliases=? WHERE id=?", storedAliases(aliases), np);
        }
        await run(
          "UPDATE documents SET html=?,state=? WHERE page_id=?",
          html,
          htmlState(html),
          np,
        );
        // Tasks in the imported text appear under "Meine Aufgaben".
        await indexPageTasks(np);
        result = { id: np };
        break;
      }
      case "workspace.import": {
        await requireMember(user, wid(), "editor");
        const sid = uuid.parse(b.spaceId),
          space = await one<Space>(
            "SELECT * FROM spaces WHERE id=? AND workspace_id=?",
            sid,
            wid(),
          );
        if (
          !space ||
          !["owner", "editor"].includes(await spaceRole(user, space) || "")
        )
          throw new HttpError(403, "Kein Zugriff");
        const backup = z
          .object({
            format: z.literal("flowplan-1"),
            pages: z
              .array(
                z.object({
                  id: str,
                  parent_id: z.string().nullable(),
                  title: str,
                  kind: z.enum(["document", "database"]),
                  data: z.unknown(),
                }),
              )
              .max(500),
          })
          .parse(b.backup);
        const mapped = new Map<string, string>();
        for (const p of backup.pages) {
          if (mapped.has(p.id)) throw new HttpError(400, "Doppelte Seiten-ID");
          const np = await createPage(wid(), sid, user.id, p.title, p.kind);
          mapped.set(p.id, np);
        }
        const rowIds = new Map<string, string>();
        for (const page of backup.pages)
          if (page.kind === "database") {
            const { rows } = z
              .object({
                rows: z
                  .array(z.object({ id: z.string().optional() }))
                  .max(MAX_ARCHIVE_ROWS),
              })
              .parse(page.data);
            for (const [index, row] of rows.entries()) {
              const key = row.id || `${page.id}:row:${index}`;
              if (rowIds.has(key))
                throw new HttpError(400, "Doppelte Datensatz-ID");
              rowIds.set(key, id());
            }
          }
        const rewriteHtml = (html: string) =>
          cleanHtml(html, (tagName, attribs) => {
            const attrs = remapLinkedAttributes(
              { ...attribs },
              mapped,
              rowIds,
              (source) => {
                const p = backup.pages.find(
                  (p) => p.id === source && p.kind === "database",
                );
                if (!p) return;
                const data = z
                  .object({
                    database: z.object({ fields: z.array(field) }),
                    rows: z.array(z.object({ id: z.string().optional() })),
                  })
                  .parse(p.data);
                return {
                  fields: data.database.fields,
                  rows: data.rows.flatMap((r) => (r.id ? [{ id: r.id }] : [])),
                };
              },
            );
            if (attrs.href) {
              // Page links and block links (#88) to copied pages.
              const match = /^\/?#page=([^&]+)((?:&block=[\w-]{1,64})?)$/.exec(attrs.href);
              if (match && mapped.has(match[1]))
                attrs.href = `/#page=${mapped.get(match[1])}${match[2]}`;
            }
            return { tagName, attribs: attrs };
          });
        for (const p of backup.pages) {
          const np = mapped.get(p.id)!;
          if (p.parent_id && mapped.has(p.parent_id)) {
            let parent = p.parent_id;
            const seen = new Set([p.id]);
            while (parent) {
              if (seen.has(parent))
                throw new HttpError(400, "Zyklischer Seitenbaum");
              seen.add(parent);
              parent =
                backup.pages.find((x) => x.id === parent)?.parent_id || "";
            }
            await run(
              "UPDATE pages SET parent_id=? WHERE id=?",
              mapped.get(p.parent_id)!,
              np,
            );
          }
          if (p.kind === "document") {
            const doc = z
              .object({ html: z.string().max(2_000_000) })
              .parse(p.data);
            const html = rewriteHtml(doc.html);
            await run(
              "UPDATE documents SET html=?,state=? WHERE page_id=?",
              html,
              htmlState(html),
              np,
            );
          } else {
            const d = z
              .object({
                database: z.object({
                  fields: z.array(field).min(1).max(80),
                  views: z.array(view).min(1).max(30),
                }),
                rows: z
                  .array(
                    z.object({
                      id: z.string().optional(),
                      cells: z.record(z.string(), z.unknown()),
                      content: z.string().optional(),
                    }),
                  )
                  .max(MAX_ARCHIVE_ROWS),
              })
              .parse(p.data);
            const fields = d.database.fields.map((f) => ({
              ...f,
              relationPage: f.relationPage
                ? mapped.get(f.relationPage)
                : undefined,
            }));
            await run(
              "UPDATE databases SET fields=?,views=? WHERE page_id=?",
              JSON.stringify(fields),
              JSON.stringify(
                remapViewReferences(
                  d.database.views,
                  d.database.fields,
                  rowIds,
                  d.rows.flatMap((r) => (r.id ? [{ id: r.id }] : [])),
                ),
              ),
              np,
            );
            for (const [i, r] of d.rows.entries())
              await run(
                "INSERT INTO rows(id,page_id,cells,content,position,created_by,updated_by) VALUES(?,?,?,?,?,?,?)",
                rowIds.get(r.id || `${p.id}:row:${i}`)!,
                np,
                JSON.stringify(
                  Object.fromEntries(
                    Object.entries(r.cells).map(([key, value]) => [
                      key,
                      d.database.fields.find((f) => f.id === key)?.type ===
                      "relation"
                        ? (Array.isArray(value)
                            ? value
                            : typeof value === "string"
                              ? [value]
                              : []
                          )
                            .map((v) => rowIds.get(String(v)))
                            .filter(Boolean)
                        : value,
                    ]),
                  ),
                ),
                rewriteHtml(r.content || ""),
                i,
                user.id,
                user.id,
              );
            // Tag-backed properties use this workspace's tags (#79).
            await reconcileTagFields(user, np);
          }
        }
        result = {
          pages: backup.pages.length,
          pageIds: Object.fromEntries(mapped),
        };
        break;
      }
      case "space.duplicate":
        result = await duplicateSpace(user, b);
        break;
      // The order of the spaces in the sidebar (lib/space-order.ts).
      case "space.reorder":
        result = await reorderSpaces(user, b);
        break;
      // Git export of the space, by its owner (lib/space-git-export.ts).
      case "space.gitExport":
        result = await saveSpaceGitExport(user, b);
        break;
      case "space.create": {
        // Not while the creator is being removed: no space of a departed member.
        await lockMembership(wid());
        await requireMember(user, wid(), "editor");
        // An encrypted space comes with its id chosen in the browser: the
        // sealed space key names the space it belongs to.
        const sid = b.encrypted && b.id !== undefined ? uuid.parse(b.id) : id();
        // Pages and spaces share one id space (grants, links, trash): a
        // chosen id must be new to both.
        if (await one("SELECT 1 FROM spaces WHERE id=? UNION ALL SELECT 1 FROM pages WHERE id=?", sid, sid))
          throw new HttpError(409, "Ungültige Eingabe.");
        await run(
          "INSERT INTO spaces(id,workspace_id,name,visibility,owner_id,icon,icon_color) VALUES(?,?,?,?,?,?,?)",
          sid,
          wid(),
          str.parse(b.name),
          b.private ? "private" : "team",
          user.id,
          spaceIconSchema.parse(b.icon ?? "folder"),
          spaceColorSchema.parse(b.iconColor ?? "none"),
        );
        // "Verschlüsselter Bereich": the creator's sealed space key comes along.
        if (b.encrypted) await makeSpaceEncrypted(user, sid, b.encrypted);
        result = { id: sid };
        break;
      }
      case "space.update": {
        const sid = uuid.parse(b.spaceId);
        const s = await requireSpaceManager(user, sid);
        if (s.deleted_at)
          throw new HttpError(409, "Den Bereich zuerst wiederherstellen.");
        if (b.version !== undefined && b.version !== s.version)
          throw new HttpError(
            409,
            "Der Bereich wurde inzwischen geändert. Bitte neu laden.",
          );
        await run(
          "UPDATE spaces SET name=?,visibility=?,icon=?,icon_color=?,version=version+1 WHERE id=?",
          str.parse(b.name),
          b.private ? "private" : "team",
          spaceIconSchema.parse(b.icon ?? s.icon),
          spaceColorSchema.parse(b.iconColor ?? s.icon_color ?? "none"),
          sid,
        );
        break;
      }
      case "page.create": {
        await requireMember(user, wid(), "editor");
        const sid = uuid.parse(b.spaceId),
          s = await one<Space>(
            "SELECT * FROM spaces WHERE id=? AND workspace_id=?",
            sid,
            wid(),
          );
        if (!s || !["editor", "owner"].includes(await spaceRole(user, s) || ""))
          throw new HttpError(403, "Kein Zugriff auf Bereich.");
        const parent = b.parentId ? uuid.parse(b.parentId) : null;
        if (parent) {
          const p = await requirePage(user, parent, true);
          // Nothing new below a journal behind a PIN not entered.
          await requireUnlocked(user, p);
          if (p.space_id !== sid)
            throw new HttpError(
              400,
              "Übergeordnete Seite liegt in anderem Bereich.",
            );
        }
        const savedTemplate = b.templateId
          ? (await requireTemplate(user, b.templateId, wid()))
          : undefined;
        const kind =
          savedTemplate?.kind ||
          z
            .enum(["document", "database", "whiteboard", "journal", "dashboard", "notebook", "workflow"])
            .parse(b.kind || "document");
        // Workflows (#168): not when switched off on the instance.
        if (kind === "workflow") await assertWorkflowsEnabled();
        const created = await createPage(
          wid(),
          sid,
          user.id,
          str.parse(b.title),
          kind,
          parent,
          b.aiDatabase !== undefined ? "empty" : z.enum(databaseKinds).default("tasks").parse(b.databaseKind ?? undefined),
        );
        if (savedTemplate)
          await applyPageTemplate(
            user,
            await requirePage(user, created, true),
            savedTemplate,
            false,
            // Tags and definitions of the template's space (#136).
            parseMetaPlan(b.meta),
          );
        // A database proposed by the AI and reviewed by the person: checked
        // again here like any input (lib/ai/database-fields.ts).
        if (b.aiDatabase !== undefined) {
          if (kind !== "database" || savedTemplate || b.starterTemplate)
            throw new HttpError(400, "Ein KI-Vorschlag gilt nur für eine neue, leere Datenbank.");
          await applyDatabaseProposal(created, user.id, b.aiDatabase, { all: ct("Alle Einträge", "All records"), board: "Board" });
        }
        if (b.starterTemplate && savedTemplate)
          throw new HttpError(400, "Nur eine Vorlage auswählen.");
        if (b.starterTemplate) {
          const key = z.enum(templateKeys).parse(b.starterTemplate);
          if (starterTemplates[key].kind !== kind)
            throw new HttpError(400, "Vorlage passt nicht zum Seitentyp.");
          await applyStarterTemplate(created, user.id, key);
        }
        await afterEncryptedPageCreate(created, b);
        await pageCreatedEvent(created, user.id);
        result = { id: created };
        break;
      }
      case "page.update": {
        const p = await write();
        const data = z
          .object({
            title: str.optional(),
            icon: pageIconSchema.optional(),
            cover: coverSchema.optional(),
            cover_position: z.number().finite().min(0).max(100).optional(),
            locked: z.boolean().optional(),
            full_width: z.boolean().optional(),
            caption_numbers: z.boolean().optional(),
            font: z.enum(["sans", "serif", "mono"]).optional(),
            icon_size: iconSizeSchema.optional(),
          })
          .parse(b.patch);
        if (data.cover !== undefined || data.cover_position !== undefined) {
          if (p.locked && data.locked !== false)
            throw new HttpError(409, "Diese Seite ist gesperrt.");
          if (
            b.coverBase &&
            JSON.stringify(appearanceSchema.parse(b.coverBase)) !==
              JSON.stringify(pageAppearance(p))
          )
            throw new HttpError(
              409,
              "Das Cover wurde inzwischen geändert. Bitte neu öffnen.",
            );
          await validateCover(p.id, data.cover ?? p.cover);
          if (p.kind === "database") await databaseSnapshot(user, p);
          else
            await run(
              "INSERT INTO snapshots(id,page_id,state,html,title,created_by) SELECT ?,page_id,state,html,?,? FROM documents WHERE page_id=?",
              id(),
              p.title,
              user.id,
              p.id,
            );
        }
        if (data.icon !== undefined) await validateIcon(p.id, data.icon);
        if (data.title !== undefined && data.title !== p.title)
          afterCommit.push(...await followRename(user, p.workspace_id, { pageId: p.id }, p.title, data.title));
        for (const [key, val] of Object.entries(data))
          await run(
            `UPDATE pages SET ${key}=?,updated_at=? WHERE id=?`,
            typeof val === "boolean" ? Number(val) : val, nowText(),
            p.id,
          );
        break;
      }
      case "pages.bulk": {
        // Runs the single-page actions inside this transaction: all or nothing.
        const operation = z
          .enum(["delete", "duplicate", "move"])
          .parse(b.operation);
        const ids = [
          ...new Set(z.array(uuid).min(1).max(100).parse(b.pageIds)),
        ];
        const pages = await mapAsync(ids, async (pid) => {
          const p = await requirePage(user, pid, true);
          if (p.workspace_id !== wid())
            throw new HttpError(
              400,
              "Seiten aus einem anderen Arbeitsbereich.",
            );
          return p;
        });
        // Pages inside another selected page travel with their ancestor.
        const covered = new Set<string>();
        for (const p of pages)
          for (const child of await descendants(p.id))
            if (child !== p.id) covered.add(child);
        const roots = pages.filter((p) => !covered.has(p.id));
        const created: string[] = [];
        let previous: string | undefined;
        for (const p of roots) {
          if (operation === "delete")
            await command(user, { action: "page.delete", pageId: p.id }, true);
          else if (operation === "duplicate")
            created.push(
              (
                (await command(
                  user,
                  { action: "page.duplicate", pageId: p.id },
                  true,
                )) as { id: string }
              ).id,
            );
          else {
            // Keep the selection order: the first root goes to the target,
            // every further root directly after the previous one.
            await command(
              user,
              previous
                ? {
                    action: "page.move",
                    pageId: p.id,
                    targetId: previous,
                    placement: "after",
                    ...(b.meta !== undefined ? { meta: b.meta } : {}),
                  }
                : {
                    action: "page.move",
                    pageId: p.id,
                    ...(b.parentId
                      ? { targetId: b.parentId, placement: "inside" }
                      : { spaceId: b.spaceId, parentId: null }),
                    ...(b.meta !== undefined ? { meta: b.meta } : {}),
                  },
              true,
            );
            previous = p.id;
          }
        }
        result = { ok: true, count: roots.length, created };
        break;
      }
      // What a move would bring that its destination lacks (#136): the
      // source space's tags and definitions, to map, copy or remove first.
      case "page.moveCheck": {
        const p = await write();
        const { sid, destination, destinationParent } = await moveDestination(user, p, b);
        if (!destination || destination.deleted_at) throw new HttpError(400, "Ungültiges Verschieben.");
        // The same destination rights as page.move: nothing about a space
        // the person may not write in (its name, tags, workspace).
        if (!destinationParent && !["editor", "owner"].includes(await spaceRole(user, destination) || ""))
          throw new HttpError(403, "Keine Schreibrechte im Zielbereich.");
        result = {
          foreign: destination.id === p.space_id ? [] : (await moveForeignMeta(await descendants(p.id), { workspaceId: destination.workspace_id, spaceId: sid })),
          target: { workspaceId: destination.workspace_id, spaceId: sid, spaceName: destination.name },
        };
        break;
      }
      case "page.move": {
        const p = await write(),
          subtree = await descendants(p.id);
        afterMove.push(async () => await pageMovedEvent(p.id, user.id, p.parent_id, (await one<Page>("SELECT parent_id FROM pages WHERE id=?", p.id))?.parent_id ?? null));
        const { placement, target, parent, destinationParent, sid, destination } = await moveDestination(user, p, b);
        if (
          !destination ||
          destination.deleted_at ||
          target?.id === p.id ||
          (parent && subtree.includes(parent))
        )
          throw new HttpError(400, "Ungültiges Verschieben.");
        if (destinationParent?.locked)
          throw new HttpError(409, "Zielseite ist gesperrt.");
        if (
          !destinationParent &&
          !["editor", "owner"].includes(await spaceRole(user, destination) || "")
        )
          throw new HttpError(403, "Keine Schreibrechte im Zielbereich.");
        // Every page that goes along: editable, and behind no journal PIN
        // the person has not entered (a journal further down).
        await forEachAsync(subtree, async (child) => await requireUnlocked(user, await requirePage(user, child, true, true)));
        // Tags and definitions of the source space (or workspace) the
        // pages carry: mapped, copied or removed as chosen (`meta`), never
        // dropped silently (#136, lib/meta-scope-server.ts).
        const foreignMeta =
          sid === p.space_id ? [] : (await moveForeignMeta(subtree, { workspaceId: destination.workspace_id, spaceId: sid }));
        const metaPlan = parseMetaPlan(b.meta);
        if (foreignMeta.some((item) => !choiceFor(item, metaPlan))) throw new HttpError(409, needsPlanMessage(foreignMeta));
        // Into another workspace: rights, favourites and quota follow it.
        // Only full members take pages out; a guest edits what was shared
        // with them but cannot carry it off into a workspace of their own.
        if (destination.workspace_id !== p.workspace_id) {
          await requireMember(user, p.workspace_id, "editor");
          await transferPages(user, subtree, p.workspace_id, destination.workspace_id);
        }
        for (const child of subtree)
          await run("UPDATE pages SET space_id=? WHERE id=?", sid, child);
        await applyMovePlan(user, subtree, foreignMeta, metaPlan, { workspaceId: destination.workspace_id, spaceId: sid });
        await run(
          "UPDATE pages SET parent_id=?,updated_at=? WHERE id=?",
          parent, nowText(),
          p.id,
        );
        const siblings = (await all<{ id: string }>(
          "SELECT id FROM pages WHERE space_id=? AND parent_id IS NOT DISTINCT FROM ? AND deleted_at IS NULL AND id!=? ORDER BY position,id",
          sid,
          parent,
          p.id,
        )).map((x) => x.id);
        const index =
          target && placement !== "inside"
            ? siblings.indexOf(target.id) + (placement === "after" ? 1 : 0)
            : siblings.length;
        siblings.splice(Math.max(0, index), 0, p.id);
        await forEachAsync(siblings, async (sibling, i) =>
          await run("UPDATE pages SET position=? WHERE id=?", i, sibling),
        );
        for (const task of afterMove.splice(0)) await task();
        break;
      }
      case "task.update": {
        afterCommit.push(await changeDocTask(user, b));
        if (typeof b.pageId === "string") await recordPageEdit(user, b.pageId);
        break;
      }
      case "synced.create": {
        // The content of a new synced block: a document under the page that
        // first shows it (and so with its permissions). On a journal day
        // under its journal instead (a day stays removable as empty), so
        // the journal's PIN covers it too.
        const host = await write();
        const html = z.string().max(500_000).optional().parse(b.html) || "";
        const sid = await createPage(
          host.workspace_id,
          host.space_id,
          user.id,
          "Synchronisierter Block",
          "document",
          host.journal_date ? host.parent_id : host.id,
        );
        await run("UPDATE pages SET synced=1 WHERE id=?", sid);
        if (html)
          await run(
            "UPDATE documents SET html=?,state=? WHERE page_id=?",
            cleanHtml(html),
            htmlState(html),
            sid,
          );
        result = { id: sid };
        break;
      }
      case "table.toDatabase": {
        // "In Datenbank umwandeln" (#118): a table of a document (or of a
        // record's content) becomes a new database with its records; the
        // browser then puts an embedded view of it in the table's place.
        const limits = TABLE_DATABASE_LIMITS;
        const cell = z.object({
          text: z.string().max(limits.text),
          href: z.string().max(limits.href).optional(),
          // The cell's inline formatting (#126) for text properties.
          markdown: z.string().max(limits.text * 2).optional(),
        });
        const table = z
          .array(z.array(cell).max(limits.columns + 1))
          .min(1)
          .max(limits.rows + 1)
          .parse(b.rows);
        if (table.length > limits.rows + 1 || table.some((row) => row.length > limits.columns))
          throw new HttpError(413, "Die Tabelle ist zu groß für eine Datenbank (höchstens 80 Spalten und 5.000 Zeilen).");
        // The host: written to (the embed replaces the table) – a document,
        // or a record whose database the person may change.
        const rowId = b.rowId ? uuid.parse(b.rowId) : undefined;
        const host = rowId ? (await requireRow(user, pid(), rowId, true)).page : (await write());
        if (!rowId && host.kind !== "document") throw new HttpError(400, "Kein Dokument.");
        // Created like any page (rights in the space, encrypted spaces …):
        // below the document, or for a record at the top of its space.
        const title = z.string().trim().max(200).optional().parse(b.title) || ct("Tabelle", "Table");
        const created = (
          (await command(
            user,
            {
              action: "page.create",
              workspaceId: host.workspace_id,
              spaceId: host.space_id,
              ...(rowId || host.journal_date ? {} : { parentId: host.id }),
              title,
              kind: "database",
              databaseKind: "empty",
            },
            true,
          )) as { id: string }
        ).id;
        const converted = tableToDatabase(table, (n) => ct(`Spalte ${n}`, `Column ${n}`));
        const view: View = { id: id(), name: ct("Tabelle", "Table"), type: "table", filters: [], sorts: [] };
        await run(
          "UPDATE databases SET fields=?,views=?,version=version+1 WHERE page_id=?",
          JSON.stringify(converted.fields),
          JSON.stringify([view]),
          created,
        );
        const now = Date.now();
        await forEachAsync(converted.rows, async (cells, i) =>
          await run(
            "INSERT INTO rows(id,page_id,cells,position,created_by,updated_by) VALUES(?,?,?,?,?,?)",
            id(),
            created,
            JSON.stringify(cells),
            now + i,
            user.id,
            user.id,
          ),
        );
        result = { id: created, view, fields: converted.fields.length, rows: converted.rows.length };
        break;
      }
      case "mention.link": {
        afterCommit.push(
          await linkMention(
            user,
            { pageId: pid(), rowId: b.rowId ? uuid.parse(b.rowId) : undefined },
            { pageId: uuid.parse(b.targetId), rowId: b.targetRowId ? uuid.parse(b.targetRowId) : undefined },
          ),
        );
        await recordPageEdit(user, pid());
        break;
      }
      // Folded and unfolded in the sidebar (#97).
      case "sidebar.state":
        result = await saveSidebarState(user, b);
        break;
      // The bar with tags and properties, collapsed or open (#83).
      case "page.collapseProperties":
        result = await setPropertiesCollapsed(user, b);
        break;
      // The properties of a database's records, folded or open (#186).
      case "database.collapseRecordProperties":
        result = await setRecordPropertiesCollapsed(user, b);
        break;
      // "Alle / Nur meine" below a journal day (#169), the reader's choice.
      case "journal.completedMine":
        result = await setCompletedMine(user, b);
        break;
      case "page.follow": {
        const page = await requirePage(user, pid());
        await setFollowing(user, page.id, z.boolean().parse(b.follow));
        result = { following: z.boolean().parse(b.follow) };
        break;
      }
      case "journal.settings": {
        const journal = await write();
        if (journal.kind !== "journal")
          throw new HttpError(400, "Diese Seite ist kein Journal.");
        if (typeof b.template === "string") await setJournalTemplate(journal, b.template);
        if (b.options !== undefined) await setJournalOptions(journal, b.options);
        if (b.templateFromDay) await templateFromDay(journal, uuid.parse(b.templateFromDay));
        if (b.trackers !== undefined)
          await setJournalTrackers(journal, z.array(trackerSchema).parse(b.trackers));
        if (b.icsUrl !== undefined) {
          // The server would load foreign addresses for anonymous guests.
          if (user.demo)
            throw new HttpError(403, "In der Demo nicht verfügbar. Registriere dich, um das zu nutzen.");
          await setJournalCalendar(journal, z.string().parse(b.icsUrl));
        }
        result = await journalSettings(journal.id);
        break;
      }
      case "journal.lock": {
        // Not write(): its own PIN is checked by setJournalLock (the
        // current one, or a reset by a workspace owner).
        const journal = await requirePage(user, pid(), true);
        if (journal.locked) throw new HttpError(409, "Diese Seite ist gesperrt.");
        if (journal.kind !== "journal")
          throw new HttpError(400, "Diese Seite ist kein Journal.");
        // Setting a PIN revokes the journal's links and publications; the
        // answer says how many.
        result = await setJournalLock(
          user,
          journal,
          b.pin === null ? null : pinSchema.parse(b.pin),
          typeof b.current === "string" ? b.current : undefined,
        );
        break;
      }
      case "journal.unlock": {
        const journal = await requirePage(user, pid());
        if (journal.kind !== "journal")
          throw new HttpError(400, "Diese Seite ist kein Journal.");
        await unlockJournal(user, journal, z.string().max(20).parse(b.pin));
        break;
      }
      case "journal.relock": {
        const journal = await requirePage(user, pid());
        await lockJournalNow(user, journal);
        break;
      }
      case "journal.entry": {
        const day = await write();
        const journal = await journalOf(day);
        if (!journal || day.kind === "journal")
          throw new HttpError(400, "Diese Seite ist kein Journaltag.");
        result = await saveDayEntry(journal, day, b.entry);
        break;
      }
      case "journal.summary": {
        // A normal sub page with the month's review (lib/journal-summary.ts).
        result = await createMonthSummary(user, await write(), b);
        break;
      }
      case "journal.aiSummary": {
        // The review's AI summary, saved on request (#170, lib/journal-summary.ts).
        result = await saveAiSummary(user, await write(), b);
        break;
      }
      case "journal.roll": {
        // The client sends its own date: a new day starts at local midnight.
        const date = journalDate.parse(b.date);
        if (b.pageId) {
          const journal = await write();
          // `write`: the first keystroke, task, tracker value or file in a
          // draft day creates it (journals set to "beim ersten Schreiben").
          result = await rollJournal(user, journal, date, undefined, b.recreate === true, { write: b.write === true });
        } else {
          await requireMember(user, wid());
          result = { changed: await rollJournals(user, wid(), date) };
        }
        break;
      }
      // "@heute", "@gestern", "@2026-10-27": the journal day to link to.
      // Block links (#88): ids for the blocks of an older document, for
      // people who only read it (editors give a block its id themselves).
      case "block.ids": {
        const ensured = await ensureBlockIds(
          user,
          pid(),
          b.rowId ? uuid.parse(b.rowId) : null,
          z.number().int().min(0).max(100000).catch(0).parse(b.index),
          z.string().max(500).catch("").parse(b.text ?? ""),
        );
        if ("publish" in ensured && ensured.publish) afterCommit.push(ensured.publish);
        result = { blockId: ensured.blockId };
        break;
      }
      case "journal.link": {
        await requireMember(user, wid());
        result = await journalDayLink(user, wid(), {
          date: z.string().parse(b.date),
          today: z.string().parse(b.today),
          fromPageId: b.fromPageId ? uuid.parse(b.fromPageId) : null,
        });
        break;
      }
      // "Leere Tage entfernen": the days chosen from the preview go to the trash.
      case "journal.removeEmpty": {
        const journal = await write();
        result = await removeEmptyJournalDays(
          user,
          journal,
          z.array(uuid).max(5000).parse(b.dayIds),
          journalDate.parse(b.today),
        );
        break;
      }
      case "page.delete": {
        const p = await write();
        // Sub-pages already in the trash stay there with their own date, so
        // restoring this page does not bring them back (lib/trash.ts).
        const trashed = new Set((await all<{ id: string }>(
          "WITH RECURSIVE tree(id) AS (SELECT id FROM pages WHERE id=? UNION ALL SELECT p.id FROM pages p JOIN tree t ON p.parent_id=t.id) SELECT p.id FROM pages p JOIN tree t ON t.id=p.id WHERE p.deleted_at IS NOT NULL",
          p.id,
        )).map((r) => r.id));
        const subtree = (await descendants(p.id)).filter((child) => !trashed.has(child));
        const deletedAt = nowText();
        // Every page that goes along: editable, and behind no journal PIN
        // the person has not entered (a journal further down).
        await forEachAsync(subtree, async (child) => await requireUnlocked(user, await requirePage(user, child, true, true)));
        for (const child of subtree) {
          await run(
            "DELETE FROM publication_pages WHERE page_id=? OR root_id=?",
            child,
            child,
          );
          await run("DELETE FROM publications WHERE page_id=?", child);
          await dropLiveProjectionsOfRoot(child);
          await run("DELETE FROM share_links WHERE root_id=?", child);
          await run("DELETE FROM share_link_pages WHERE page_id=?", child);
          await run(
            "UPDATE pages SET deleted_at=?,public_token=NULL WHERE id=?", deletedAt,
            child,
          );
        }
        // Workflow pages in the trash behave as paused (#168).
        await trashWorkflows(subtree, user.id);
        break;
      }
      case "page.restore":
        await restoreTrashedPage(user, b);
        break;
      case "page.purge":
        result = await purgeTrashedPage(user, b);
        break;
      case "trash.empty":
        result = await emptyTrash(user, b);
        break;
      // Files in the trash (#164, lib/file-trash.ts): from the media
      // library into the trash, back, or deleted for good.
      case "file.delete":
        result = await trashFiles(user, b);
        break;
      case "files.deleteUnused":
        result = await trashUnusedFiles(user, b);
        break;
      case "file.restore":
        result = await restoreFile(user, b);
        break;
      case "file.purge":
        result = await purgeTrashedFile(user, b);
        break;
      case "page.duplicate": {
        result = await duplicatePageTree(user, await write());
        break;
      }
      case "favorite":
        await requirePage(user, pid());
        if (b.value)
          await run("INSERT INTO favorites(user_id,page_id) VALUES(?,?) ON CONFLICT DO NOTHING", user.id, pid());
        else
          await run(
            "DELETE FROM favorites WHERE user_id=? AND page_id=?",
            user.id,
            pid(),
          );
        break;
      case "linked.command":
        result = await mutateLinkedDatabase(user, b);
        break;
      case "document.sync": {
        const p = await write();
        if (p.kind !== "document") throw new HttpError(400, "Kein Dokument.");
        const update = z.string().max(8_000_000).parse(b.update);
        const d = new Y.Doc();
        // Locked until the commit (PostgreSQL): a second save of the same
        // document – another tab, another instance – waits and then merges
        // into this result instead of overwriting it from an older base.
        const existing = await one<{
          state: Uint8Array | null;
          html: string;
          generation: string;
        }>(`SELECT * FROM documents WHERE page_id=?${sql.forUpdate()}`, p.id);
        if (b.generation !== existing?.generation)
          throw new HttpError(
            409,
            "Eine neue Dokumentversion ist verfügbar. Die Seite wird neu geladen.",
          );
        if (
          existing?.state &&
          !(await one(
            "SELECT id FROM snapshots WHERE page_id=? AND created_at>?",
            p.id, nowText(Date.now() - 300_000),
          ))
        ) {
          await run(
            "INSERT INTO snapshots(id,page_id,state,html,title,created_by) VALUES(?,?,?,?,?,?)",
            id(),
            p.id,
            existing.state,
            existing.html,
            p.title,
            user.id,
          );
        }
        try {
          if (existing?.state) Y.applyUpdate(d, existing.state);
          const before = Y.encodeStateVector(d);
          Y.applyUpdate(d, Buffer.from(update, "base64"));
          // Who wrote what: the editor sessions in this update are this person's.
          await recordDocumentAuthors(p.id, null, existing!.generation, user.id, before, Y.encodeStateVector(d));
          const merged = Y.encodeStateAsUpdate(d);
          // Refused above the size cap (lib/document-size.ts) – before the
          // document is rendered or anything is written.
          requireDocumentSize(merged, existing?.state?.byteLength || 0);
          const canonical = stateHtml(d);
          // Tasks: people given a task are told once (not also as mention).
          const assigned = await syncDocTasks(user, p, null, d);
          for (const match of canonical.matchAll(/data-mention="([^"]+)"/g)) {
            const uid = match[1];
            if (
              uid !== user.id &&
              !assigned.has(uid) &&
              !existing?.html.includes('data-mention="' + uid + '"') &&
              await pageRole({ ...user, id: uid }, p)
            ) {
              await run(
                "INSERT INTO notifications(id,user_id,body,page_id,kind) VALUES(?,?,?,?,'mention')",
                id(),
                uid,
                `${user.name} hat dich in „${p.title}“ erwähnt`,
                p.id,
              );
              await mentionWebhook(p.workspace_id, p.id, null, uid, user.name, user.id);
            }
          }
          await run(
            "UPDATE documents SET state=?,html=?,updated_at=? WHERE page_id=?",
            merged,
            canonical, nowText(),
            p.id,
          );
          await run("UPDATE pages SET updated_at=? WHERE id=?", nowText(), p.id);
          result = { state: liveState(d, merged, b.vector) };
          const key = documentKey(p.id, null, existing!.generation);
          afterCommit.push(() => publishDocumentUpdate(key, update, liveClient(b.client)));
        } finally {
          d.destroy();
        }
        break;
      }
      // Source view (components/markdown-source.tsx): the page as Markdown,
      // with the blocks Markdown cannot hold kept aside. Reading suffices.
      case "document.markdown": {
        const p = await requirePage(user, pid());
        await requireUnlocked(user, p);
        if (p.kind !== "document") throw new HttpError(400, "Kein Dokument.");
        const linked = (await linkedBlockIds(p.workspace_id)).get(p.id);
        result = markdownSource(z.string().max(8_000_000).parse(b.html), (blockId) => !!linked?.has(blockId));
        break;
      }
      // …and back: the HTML the editor puts in place of its content (one
      // change, undoable there), and the kept blocks the text no longer
      // names. With check, only that; otherwise the page's current state is
      // kept as a version first.
      case "document.markdown.apply": {
        const p = await write();
        if (p.kind !== "document") throw new HttpError(400, "Kein Dokument.");
        const markdown = z.string().max(4_000_000).parse(b.markdown);
        const blocks = z.array(z.string().max(4_000_000)).max(5000).parse(b.blocks ?? []);
        const used = new Set<number>();
        const html = markdownToHtml(markdown, (href) => href, {
          source: true,
          // Each kept block once; a copied marker stays empty.
          blocks: (index) => {
            if (used.has(index) || blocks[index] === undefined) return null;
            used.add(index);
            return blocks[index];
          },
        });
        if (b.check !== true) {
          const current = await one<{ state: Uint8Array | null; html: string }>(
            "SELECT state,html FROM documents WHERE page_id=?",
            p.id,
          );
          if (current)
            await run(
              "INSERT INTO snapshots(id,page_id,state,html,title,created_by) VALUES(?,?,?,?,?,?)",
              id(),
              p.id,
              current.state || htmlState(current.html),
              current.html,
              p.title,
              user.id,
            );
        }
        result = { html, missing: blocks.map((_, index) => index).filter((index) => !used.has(index)) };
        break;
      }
      case "page.snapshot": {
        const p = await write(),
          d = await one<{ state: Uint8Array | null; html: string }>(
            "SELECT * FROM documents WHERE page_id=?",
            p.id,
          );
        if (p.kind === "database") {
          const sid = await databaseSnapshot(user, p);
          await run("UPDATE snapshots SET kind='manual' WHERE id=?", sid);
          result = { id: sid };
          break;
        }
        const sid = id();
        // Workflow pages: the draft's Yjs state (lib/workflows/store.ts).
        const draft = p.kind === "workflow" ? await one<{ state: Uint8Array }>("SELECT state FROM workflow_drafts WHERE page_id=?", p.id) : undefined;
        await run(
          "INSERT INTO snapshots(id,page_id,state,html,title,created_by,kind) VALUES(?,?,?,?,?,?,'manual')",
          sid,
          p.id,
          draft?.state || d?.state || null,
          d?.html || "",
          p.title,
          user.id,
        );
        result = { id: sid };
        break;
      }
      case "snapshot.restoreBlock":
        // One paragraph from an older version back into the document.
        afterCommit.push(await restoreBlock(user, b));
        break;
      case "snapshot.restore": {
        const p = await write(),
          s = await one<{
            state: Uint8Array | null;
            html: string;
            title: string;
            appearance: string | null;
          }>(
            "SELECT * FROM snapshots WHERE id=? AND page_id=?",
            uuid.parse(b.snapshotId),
            p.id,
          );
        if (!s) throw new HttpError(404, "Version nicht gefunden.");
        const appearance = await snapshotAppearance(p.id, s.appearance);
        if (appearance) await applyAppearance(p.id, appearance);
        if (p.kind === "workflow") {
          // Back into the draft, never the active version (#168).
          if (!s.state) throw new HttpError(400, "Version ohne Inhalt.");
          result = await restoreVersion(user, { pageId: p.id, versionId: uuid.parse(b.snapshotId) });
        } else if (p.kind === "whiteboard") {
          if (!s.state) throw new HttpError(400, "Version ohne Inhalt.");
          await restoreWhiteboardSnapshot(p, s.state);
        } else if (p.kind === "dashboard" || p.kind === "notebook") {
          // Versions of a dashboard or notebook only hold its appearance
          // (restored above); notebook sheets keep their own ink versions.
        } else if (p.kind === "document") {
          await run(
            "UPDATE documents SET state=?,html=?,generation=? WHERE page_id=?",
            htmlState(s.html),
            s.html,
            id(),
            p.id,
          );
          documentChanged(p.id);
        } else {
          const data = JSON.parse(s.html);
          // Versions with restricted records are restored by owners only.
          if (
            (await pageRole(user, p)) !== "owner" &&
            (await one(
              "SELECT 1 FROM rows WHERE page_id=? AND access!='inherit'",
              p.id,
            ) ||
              data.rows.some(
                (r: { access?: string }) => r.access && r.access !== "inherit",
              ))
          )
            throw new HttpError(
              403,
              "Diese Version enthält Einträge mit eigenen Rechten. Nur Besitzer stellen sie wieder her.",
            );
          // Likewise with properties only some people read or write.
          if (
            (await pageRole(user, p)) !== "owner" &&
            (hasFieldAccess((await database(p.id)).fields) ||
              hasFieldAccess(data.database?.fields || []))
          )
            throw new HttpError(
              403,
              "Diese Version enthält Eigenschaften mit eigener Sichtbarkeit. Nur Besitzer stellen sie wieder her.",
            );
          await run(
            "UPDATE databases SET fields=?,views=?,version=version+1 WHERE page_id=?",
            JSON.stringify(data.database.fields),
            JSON.stringify(data.database.views),
            p.id,
          );
          if (data.database.recordLayout)
            await run(
              "UPDATE databases SET record_layout=? WHERE page_id=?",
              JSON.stringify(parseRecordLayout(data.database.recordLayout)),
              p.id,
            );
          if (Array.isArray(data.comments))
            await run("DELETE FROM comments WHERE page_id=?", p.id);
          await run("DELETE FROM rows WHERE page_id=?", p.id);
          for (const r of data.rows)
            await run(
              "INSERT INTO rows(id,page_id,cells,position,created_by,updated_by,content,icon,cover,recurrence,access,repeat) VALUES(?,?,?,?,COALESCE((SELECT id FROM users WHERE id=?),?),?,?,?,?,?,?,?)",
              r.id,
              p.id,
              JSON.stringify(r.cells),
              r.position,
              typeof r.created_by === "string" ? r.created_by : "",
              user.id,
              user.id,
              r.content || "",
              await restorableImage(p.id, r.icon, validateIcon),
              await restorableImage(p.id, r.cover, validateCover),
              typeof r.recurrence === "string" ? r.recurrence : "",
              ["readonly", "private"].includes(r.access) ? r.access : "inherit",
              typeof r.repeat === "string" && parseRepeat(r.repeat) ? r.repeat : "",
            );
          for (const r of data.rows)
            for (const g of Array.isArray(r.grants) ? r.grants : [])
              await run(
                "INSERT INTO row_grants(row_id,user_id,group_id,role) SELECT ?,?,?,? WHERE ? IN ('viewer','editor') ON CONFLICT DO NOTHING",
                r.id,
                String(g.user_id || ""),
                String(g.group_id || ""),
                String(g.role),
                String(g.role),
              );
          // The restored records' tasks (removed with the old rows).
          await reindexRowTasks(user, p, data.rows.map((r: { id: string }) => r.id));
          if (Array.isArray(data.rowTemplates)) {
            await run("DELETE FROM row_templates WHERE page_id=?", p.id);
            for (const t of data.rowTemplates)
              await run(
                "INSERT INTO row_templates(id,page_id,name,cells,html,is_default,created_by) VALUES(?,?,?,?,?,?,?)",
                id(),
                p.id,
                t.name,
                JSON.stringify(t.cells),
                t.html,
                t.is_default,
                user.id,
              );
          }
          if (Array.isArray(data.inlineThreads)) {
            const restoredThreads = archivedThreadsSchema.parse(
              data.inlineThreads,
            );
            const restoredRows = new Map<string, string>(
              data.rows.map((r: { id: string }) => [r.id, r.id]),
            );
            for (const t of restoredThreads) {
              if (!t.row_id || !restoredRows.has(t.row_id))
                throw new HttpError(
                  400,
                  "Ungültiger Datensatzkommentar in der Version.",
                );
              await ensureRowDocument((await requireRow(user, p.id, t.row_id)).row);
            }
            await importInlineComments(p.id, restoredThreads, restoredRows, user.id);
          }
          if (data.formConfig)
            await run(
              "UPDATE forms SET config=? WHERE page_id=?",
              JSON.stringify(formConfigSchema.parse(data.formConfig)),
              p.id,
            );
          // Done rule, workflow, automations and the issue sync's status
          // mapping as they were with these options (#173).
          await restoreVersionSettings(user, p.id, data);
          if (Array.isArray(data.comments))
            for (const c of data.comments)
              await run(
                "INSERT INTO comments(id,page_id,row_id,author_id,body,resolved,created_at) VALUES(?,?,?,?,?,?,?)",
                c.id,
                p.id,
                c.row_id,
                c.author_id,
                c.body,
                c.resolved,
                c.created_at,
              );
          await restoreRelationPairs(user, p.id, data.relationPairs);
          // Tag-backed properties: values become tags again where allowed (#79).
          await reconcileTagFields(user, p.id);
        }
        await run(
          "UPDATE pages SET title=?,updated_at=? WHERE id=?",
          s.title, nowText(),
          p.id,
        );
        break;
      }
      case "database.update": {
        await autoDatabaseSnapshot(user, await write());
        const d = await database(pid());
        if (b.version !== d.version)
          throw new HttpError(
            409,
            "Die Datenbank wurde zwischenzeitlich geändert. Bitte neu laden.",
          );
        // Properties hidden from this person stay as they are; only owners
        // change who reads and writes a property (lib/field-access.ts).
        const fields = await mergeHiddenFields(
          user,
          await write(),
          z.array(field).min(1).max(80).parse(b.fields),
          d.fields,
        );
        if (fields.length > 80)
          throw new HttpError(400, "Zu viele Eigenschaften.");
        await validateFieldAccess(user, await write(), fields, d.fields);
        // AI properties: references, output types, who automatic updates run as.
        const aiChanges = await prepareAiFields(user, await write(), fields, d.fields);
        if (
          d.fields.some((old) =>
            fields.some((next) => next.id === old.id && next.name !== old.name),
          )
        ) {
          // Record templates saved before placeholders were stored by id:
          // their "{{Old name}}" becomes the id, so the rename keeps them.
          await storeTemplateNames(pid(), d.fields);
          for (const next of fields) {
            const old = d.fields.find((f) => f.id === next.id);
            if (
              next.type === "formula" &&
              next.formula &&
              next.formula === old?.formula
            )
              next.formula = field.shape.formula.parse(
                rewriteFormulaReferences(next.formula, d.fields, "store"),
              );
          }
        }
        const currentFields = new Set(fields.map((f) => f.id)),
          deletedFields = new Set(
            d.fields.filter((f) => !currentFields.has(f.id)).map((f) => f.id),
          );
        const cleanFilter = (f: Filter) => {
          if (deletedFields.has(f.field)) return null;
          if (!currentFields.has(f.field))
            throw new HttpError(
              400,
              "Filter verweist auf eine unbekannte Eigenschaft.",
            );
          return f;
        };
        const views = z
          .array(view)
          .min(1)
          .max(30)
          .parse(b.views)
          .map((v) => ({
            ...v,
            filters: v.filters.flatMap((f) => (cleanFilter(f) ? [f] : [])),
            sorts: v.sorts.filter((s) => !deletedFields.has(s.field)),
            ...(v.groupLevels
              ? {
                  groupLevels: v.groupLevels.filter(
                    (fid) => !deletedFields.has(fid),
                  ),
                }
              : {}),
            ...(v.filterGroup
              ? {
                  filterGroup: transformFilterGroup(v.filterGroup, cleanFilter),
                }
              : {}),
          }));
        if (
          new Set(fields.map((f) => f.id)).size !== fields.length ||
          new Set(views.map((v) => v.id)).size !== views.length
        )
          throw new HttpError(400, "Doppelte Eigenschaft oder Ansicht.");
        if (fields.filter((f) => f.type === "aliases").length > 1)
          throw new HttpError(400, "Eine Datenbank hat höchstens eine Alias-Eigenschaft.");
        // Aliases weigh like the title in the search: index the records again
        // when the aliases property changes.
        if (aliasField(fields)?.id !== aliasField(d.fields)?.id)
          await run("INSERT INTO search_dirty SELECT page_id,id FROM rows WHERE page_id=? ON CONFLICT DO NOTHING", pid());
        // Renamed options: records, views, settings and forms follow
        // (before the done rule is copied to progress properties).
        afterCommit.push(...(await applyOptionRenames(user, await write(), d.fields, fields, views, b.optionRenames)));
        prepareSubtaskFields(await write(), fields, await databaseSettings(pid()));
        // Multi-selects with the workspace's tags as options (#79).
        await prepareTagFields(user, await write(), fields, d.fields);
        await validateDatabaseRelations(user, await write(), fields, d.fields);
        await validateTicketPrefix(await write(), fields);
        for (const v of views) {
          try {
            if (v.calculations)
              v.calculations = validateCalculations(
                v.calculations,
                fields,
                d.fields,
              );
          } catch (error) {
            throw new HttpError(400, (error as Error).message);
          }
          if (
            v.gallery?.cover === "field" &&
            !fields.some(
              (f) => f.id === v.gallery!.fieldId && f.type === "files",
            )
          ) {
            if (d.fields.some((f) => f.id === v.gallery!.fieldId))
              v.gallery = { ...v.gallery, cover: "none", fieldId: undefined };
            else
              throw new HttpError(
                400,
                "Galerie verweist auf eine unbekannte Bildeigenschaft.",
              );
          }
        }
        await validateViewRowOrders(pid(), views);
        // Changed read rules change what search may index.
        if (
          JSON.stringify(d.fields.map((f) => [f.id, f.access?.read ?? null])) !==
          JSON.stringify(fields.map((f) => [f.id, f.access?.read ?? null]))
        ) {
          await run(
            "INSERT INTO search_dirty(page_id,row_id) SELECT page_id,id FROM rows WHERE page_id=? ON CONFLICT DO NOTHING",
            pid(),
          );
          await run(
            "INSERT INTO ai_embed_dirty(page_id,row_id) SELECT page_id,id FROM rows WHERE page_id=? UNION ALL SELECT ?,'' WHERE true ON CONFLICT DO NOTHING",
            pid(),
            pid(),
          );
        }
        // Formatted text (#126): a property that becomes or stops being
        // formatted text keeps its values' text.
        await convertFormattedValues(pid(), d.fields, fields);
        await run(
          "UPDATE databases SET fields=?,views=?,version=version+1 WHERE page_id=?",
          JSON.stringify(fields),
          JSON.stringify(views),
          pid(),
        );
        await forgetAiFields(pid(), aiChanges.removed);
        await configureRelation(user, pid(), d.version, b.relation);
        break;
      }
      case "row.schedule":
        result = await scheduleRow(user, pid(), b);
        break;
      case "timeline.cascade":
        result = await cascadeTimeline(user, pid(), b);
        break;
      case "timeline.link":
        result = await linkTimeline(user, pid(), b);
        break;
      // The workspace's bibliography (citations).
      case "citation.import":
        result = await importBibliography(user, b);
        break;
      case "citation.remove":
        result = await removeFromBibliography(user, b);
        break;
      case "row.move":
        result = await moveRow(user, pid(), b);
        break;
      case "rows.transfer": {
        // Copy or move records into another database.
        const p = await requirePage(user, pid());
        await autoDatabaseSnapshot(user, p);
        result = await transferRows(user, p.id, b);
        break;
      }
      case "rows.bulk":
        result = await bulkRows(user, pid(), b);
        break;
      case "row.create": {
        await autoDatabaseSnapshot(user, await write());
        const selectedTemplate = await selectedRowTemplate(pid(), b.templateId);
        // A template opened for editing keeps its placeholders, with the
        // properties' current names (lib/record-template-apply.ts).
        const template =
          selectedTemplate && b.rawTemplate === true
            ? { ...selectedTemplate, ...rawTemplate(selectedTemplate, (await database(pid())).fields) }
            : selectedTemplate;
        const given = z.record(z.string(), z.unknown()).parse(b.cells || {});
        await assertFieldsWritable(user, await write(), (await database(pid())).fields, Object.keys(given));
        // Tag-backed properties: tag names, new ones only where allowed (#79).
        Object.assign(given, await tagCells(user, await write(), (await database(pid())).fields, given, true));
        // Contacts: the display name from the names (lib/contacts.ts).
        // A template fills only properties this person may change, like
        // row.template.apply (lib/field-access.ts).
        const fromTemplate = template
          ? stripCells(JSON.parse(template.cells) as Record<string, unknown>, await unwritableFieldIds(user, await write(), (await database(pid())).fields))
          : {};
        const cells = await contactCellsFor(pid(), (await database(pid())).fields, {}, {
          ...fromTemplate,
          ...given,
        }, Object.keys(given));
        // Aliases follow their limits (lib/aliases.ts).
        const aliasProperty = aliasField((await database(pid())).fields);
        if (aliasProperty && cells[aliasProperty.id] !== undefined)
          cells[aliasProperty.id] = parseAliases(Array.isArray(cells[aliasProperty.id]) ? cells[aliasProperty.id] : aliasList(cells[aliasProperty.id]));
        if (JSON.stringify(cells).length > 200000)
          throw new HttpError(413, "Datensatz zu groß.");
        // Records created offline bring their own id; a repeat is a no-op.
        const rid = b.rowId ? uuid.parse(b.rowId) : id();
        if (b.rowId) {
          const existing = await one<{ page_id: string }>(
            "SELECT page_id FROM rows WHERE id=?",
            rid,
          );
          if (existing?.page_id === pid()) {
            result = { id: rid };
            break;
          }
          if (
            existing ||
            await one("SELECT 1 FROM row_trash WHERE id=?", rid)
          )
            throw new HttpError(409, "Diese Kennung ist bereits vergeben.");
        }
        await run(
          "INSERT INTO rows(id,page_id,cells,position,created_by,updated_by) VALUES(?,?,?,?,?,?)",
          rid,
          pid(),
          JSON.stringify(cells),
          Date.now(),
          user.id,
          user.id,
        );
        if (template)
          await replaceRowDocument(
            rid,
            b.rawTemplate === true
              ? template.html
              : (await fillNewRecord({ page: await write(), rowId: rid, template, actor: user, zone: typeof b.timeZone === "string" ? b.timeZone : undefined })),
            user.id,
          );
        await afterContactWrite(pid(), rid);
        await rowCreated(user, await requirePage(user, pid()), rid);
        result = { id: rid };
        break;
      }
      case "row.document.sync": {
        const synced = (await syncRowDocument(
          user,
          pid(),
          uuid.parse(b.rowId),
          b.generation,
          b.update,
        )) as { state: string };
        {
          const stored = await one<{ state: Uint8Array }>(
            "SELECT state FROM row_documents WHERE row_id=?",
            uuid.parse(b.rowId),
          );
          if (stored) {
            const rowDoc = new Y.Doc();
            Y.applyUpdate(rowDoc, stored.state);
            await syncDocTasks(user, await requirePage(user, pid()), uuid.parse(b.rowId), rowDoc);
            rowDoc.destroy();
          }
        }
        result = { ...synced, state: liveDiff(synced.state, b.vector) };
        const key = documentKey(pid(), uuid.parse(b.rowId), String(b.generation));
        const update = String(b.update);
        afterCommit.push(() => publishDocumentUpdate(key, update, liveClient(b.client)));
        break;
      }
      case "row.snapshot":
        result = await snapshotRow(user, pid(), uuid.parse(b.rowId));
        break;
      case "row.snapshot.restore":
        await restoreRow(user, pid(), uuid.parse(b.rowId), b.snapshotId);
        break;
      case "row.template.save":
        result = await saveRowTemplate(user, pid(), uuid.parse(b.rowId), b.name, b.replaceId);
        break;
      case "row.template.apply": {
        // A record template on an existing record, by hand: fills empty
        // properties and an empty document, or appends below the text.
        const { input, page: p, row, template } = await prepareManualApply(user, pid(), b);
        await autoDatabaseSnapshot(user, p);
        const fieldsNow = (await database(pid())).fields;
        const applied = await applyTemplate({
          page: p,
          row,
          template,
          actor: user,
          mode: input.mode,
          zone: input.timeZone,
          snapshotId: input.snapshotId,
          strict: true,
          // Only properties this person may change, with values that fit.
          keep: async (f, value) => {
            try {
              return (await validateCellPatch(user, p, fieldsNow, { [f.id]: value }))[f.id];
            } catch {
              return undefined;
            }
          },
        });
        if (Object.keys(applied.cells).length) {
          const before = JSON.parse(String(row.cells));
          const cells = await contactCellsFor(pid(), fieldsNow, before, { ...before, ...applied.cells }, Object.keys(applied.cells));
          await run(
            "UPDATE rows SET cells=?,updated_at=?,updated_by=?,version=version+1 WHERE id=?",
            JSON.stringify(cells), nowText(),
            user.id,
            row.id,
          );
          await rowChanged(user, p, row.id, before, cells, fieldsNow);
          await afterContactWrite(pid(), row.id);
        }
        result = { document: applied.document, cells: Object.keys(applied.cells) };
        break;
      }
      case "row.template.default":
        await manageRowTemplate(
          user,
          pid(),
          b.templateId,
          "default",
          b.enabled === true,
        );
        break;
      case "row.template.delete":
        await manageRowTemplate(user, pid(), b.templateId, "delete");
        break;
      case "rows.import": {
        await write();
        const imported = z
          .array(z.record(z.string(), z.unknown()))
          .max(5000)
          .parse(b.rows);
        await assertFieldsWritable(
          user,
          await write(),
          (await database(pid())).fields,
          new Set(imported.flatMap((cells) => Object.keys(cells))),
        );
        // Values missing from select properties become options (and a
        // different letter case takes the option's spelling).
        const options = addImportedOptions((await database(pid())).fields, imported);
        const importFields = options.fields;
        for (const cells of imported) validateImportedCells(importFields, cells);
        if (options.added.length) {
          await autoDatabaseSnapshot(user, await write());
          await run(
            "UPDATE databases SET fields=?,version=version+1 WHERE page_id=?",
            JSON.stringify(importFields),
            pid(),
          );
        }
        result = { imported: imported.length, newOptions: options.added };
        await forEachAsync(imported, async (cells, i) =>
          await run(
            "INSERT INTO rows(id,page_id,cells,position,created_by,updated_by) VALUES(?,?,?,?,?,?)",
            id(),
            pid(),
            // Tag-backed properties create missing tags where allowed (#79);
            // names that may not become tags are left out.
            JSON.stringify(await tagCells(user, await write(), importFields, cells, false)),
            Date.now() + i,
            user.id,
            user.id,
          ),
        );
        break;
      }
      case "row.update": {
        const p = await write();
        const rid = uuid.parse(b.rowId),
          row = await one<{
            id: string;
            version: number;
            cells: string;
            access: string;
            created_by: string;
          }>("SELECT * FROM rows WHERE id=? AND page_id=?", rid, pid());
        if (!row) throw new HttpError(404, "Datensatz fehlt.");
        await assertRowAccess(user, p, row, true);
        await autoDatabaseSnapshot(user, p);
        const before = JSON.parse(row.cells);
        // An older version still applies when the properties it changes
        // are as the person saw them (`base`, lib/row-patch.ts): the newer
        // version only changed others – e.g. their own save of the title
        // a moment ago (#104).
        if (
          b.version !== row.version &&
          !patchStillApplies(before, b.base, (b.cells as Record<string, unknown>) || {})
        )
          throw new HttpError(
            409,
            "Datensatz wurde geändert. Bitte neu laden.",
          );
        if (b.content !== undefined)
          throw new HttpError(
            400,
            "Dokumentinhalt über den Dokumenteditor bearbeiten.",
          );
        const fieldsNow = (await database(pid())).fields;
        const patch = await validateCellPatch(user, p, fieldsNow, b.cells || {});
        const cells = await contactCellsFor(pid(), fieldsNow, before, { ...before, ...patch }, Object.keys(patch));
        if (JSON.stringify(cells).length > 200000)
          throw new HttpError(413, "Datensatz zu groß.");
        await run(
          "UPDATE rows SET cells=?,content=COALESCE(?,content),updated_at=?,updated_by=?,version=version+1 WHERE id=?",
          JSON.stringify(cells),
          b.content === undefined
            ? null
            : z.string().max(200000).parse(b.content), nowText(),
          user.id,
          rid,
        );
        await rowChanged(user, p, rid, before, cells, fieldsNow);
        await afterContactWrite(pid(), rid);
        const titleField = fieldsNow[0]?.id || "title";
        const [oldTitle, newTitle] = [cellText(before[titleField]), cellText(cells[titleField])];
        if (oldTitle !== newTitle)
          afterCommit.push(...await followRename(user, p.workspace_id, { pageId: p.id, rowId: rid }, oldTitle, newTitle));
        break;
      }
      case "row.delete": {
        const p = await write();
        await requireRow(user, p.id, uuid.parse(b.rowId), true);
        await autoDatabaseSnapshot(user, p);
        await trashRow(user, p, uuid.parse(b.rowId));
        await maintainRowOrders(pid());
        break;
      }
      case "row.trash.restore":
        result = await restoreTrashedRow(user, b);
        break;
      case "database.settings": {
        // Optional settings (done rule, workflow, automations, sprints …).
        const p = await write();
        await autoDatabaseSnapshot(user, p);
        const before = (await database(p.id)).fields;
        const saved = await updateDatabaseSettings(user, p, before, b.settings);
        // Progress properties follow the done rule.
        const fieldsNow = prepareSubtaskFields(p, structuredClone(before), saved);
        if (JSON.stringify(fieldsNow) !== JSON.stringify(before))
          await run("UPDATE databases SET fields=? WHERE page_id=?", JSON.stringify(fieldsNow), p.id);
        result = clientSettings(saved);
        break;
      }
      case "database.recordLayout": {
        const p = await write();
        const fields = (await database(p.id)).fields;
        const layout = recordLayoutSchema.parse(b.layout);
        // The title stays visible; unknown properties are dropped.
        layout.hidden = [...new Set(layout.hidden)].filter(
          (fid) => fid !== fields[0]?.id && fields.some((f) => f.id === fid),
        );
        await run(
          "UPDATE databases SET record_layout=? WHERE page_id=?",
          JSON.stringify(layout),
          p.id,
        );
        await run("UPDATE pages SET updated_at=? WHERE id=?", nowText(), p.id);
        result = layout;
        break;
      }
      case "whiteboard.sync":
        result = await syncWhiteboard(user, b);
        break;
      // Workflows (#168, lib/workflows/commands.ts).
      case "workflow.sync":
      case "workflow.draft":
      case "workflow.validate":
      case "workflow.activate":
      case "workflow.pause":
      case "workflow.test":
      case "workflow.run":
      case "workflow.run.cancel":
      case "workflow.restore":
      case "workflow.fromRule":
      case "workflow.run.retry":
      case "workflow.approve":
      case "workflow.hook":
      case "workflow.credential.set":
      case "workflow.credential.remove":
      case "workflow.import":
      case "admin.workflowLimits":
        result = await workflowCommand(user, action, b);
        break;
      // Sticky notes → database records (lib/whiteboard-to-records.ts).
      case "whiteboard.toRecords":
        result = await notesToRecords(user, b);
        break;
      case "dashboard.save":
        result = await saveDashboard(await write(), b.tiles);
        break;
      // Notebooks: sheets, their order and paper, PDF import (lib/notebook.ts).
      case "notebook.paper":
      case "notebook.sheet.add":
      case "notebook.sheet.duplicate":
      case "notebook.sheet.delete":
      case "notebook.sheet.move":
      case "notebook.sheet.paper":
      case "notebook.import":
      // The page overview (lib/notebook-organize.ts).
      case "notebook.sheet.meta":
      case "notebook.sheet.links":
      case "notebook.outline":
      case "notebook.outline.add":
      case "notebook.sheets.duplicate":
      case "notebook.sheets.delete":
      case "notebook.trash.restore":
        result = await notebookCommand(user, await write(), action, b);
        break;
      // Pictures, own stickers and paper templates of notebooks (lib/notebook-library.ts).
      case "notebook.pictures":
        result = { pictures: await notebookPictures(user, b.pageId) };
        break;
      case "notebook.stickers":
        result = { stickers: await listStickers(user, b.pageId) };
        break;
      case "notebook.sticker.save":
        result = await saveSticker(user, b);
        break;
      case "notebook.sticker.rename":
        result = await renameSticker(user, b);
        break;
      case "notebook.sticker.delete":
        result = await deleteSticker(user, b);
        break;
      case "notebook.sticker.insert":
        result = await insertSticker(user, b);
        break;
      case "notebook.templates":
        result = { templates: await listTemplates(user, b.pageId) };
        break;
      case "notebook.template.update":
        result = await updateTemplate(user, b);
        break;
      case "notebook.template.delete":
        result = await deleteTemplate(user, b);
        break;
      // Copy or move sheets into another notebook: rights on both checked there.
      case "notebook.sheets.transfer":
        result = await transferSheets(user, b);
        break;
      case "row.access":
        result = await setRowAccess(user, b);
        break;
      case "row.trash.purge":
        result = await purgeTrashedRow(user, b);
        break;
      // Saved searches became collections (#86); the old actions stay.
      case "search.save":
        result = await saveSearchAsCollection(user, b);
        break;
      case "search.delete":
        await deleteCollection(user, b.searchId);
        break;
      case "collection.create":
        result = await createCollection(user, b);
        break;
      case "collection.update":
        result = await updateCollection(user, b);
        break;
      case "collection.delete":
        result = await deleteCollection(user, b.collectionId);
        break;
      case "collection.restore":
        result = await restoreCollection(user, b.collectionId);
        break;
      case "collection.duplicate":
        result = await duplicateCollection(user, b);
        break;
      case "collection.reorder":
        await reorderCollections(user, b);
        break;
      case "favorite.row": {
        const { row } = await requireRow(user, pid(), uuid.parse(b.rowId));
        if (b.value)
          await run(
            "INSERT INTO row_favorites(user_id,row_id,page_id) VALUES(?,?,?) ON CONFLICT DO NOTHING",
            user.id,
            row.id,
            pid(),
          );
        else
          await run(
            "DELETE FROM row_favorites WHERE user_id=? AND row_id=?",
            user.id,
            row.id,
          );
        break;
      }
      case "thread.create":
      case "thread.reply":
      case "thread.resolve":
      case "thread.edit":
      case "thread.deleteMessage":
      case "thread.react":
        result = await inlineCommentCommand(user, b);
        break;
      case "comment.react": {
        const p = await requirePage(user, pid());
        // Comments behind a journal PIN not entered stay as they are.
        await requireUnlocked(user, p);
        const commentId = uuid.parse(b.commentId);
        const comment = await one<{ row_id: string | null }>(
          "SELECT row_id FROM comments WHERE id=? AND page_id=?",
          commentId,
          p.id,
        );
        if (!comment) throw new HttpError(404, "Kommentar nicht gefunden.");
        if (comment.row_id) await requireRow(user, p.id, comment.row_id);
        const emoji = reactionEmoji.parse(b.emoji);
        if (b.active === false)
          await run(
            "DELETE FROM comment_reactions WHERE comment_id=? AND user_id=? AND emoji=?",
            commentId,
            user.id,
            emoji,
          );
        else {
          if (
            Number((await one<{ n: number }>("SELECT COUNT(DISTINCT emoji) n FROM comment_reactions WHERE comment_id=?", commentId))?.n || 0) >= 20 &&
            !(await one("SELECT 1 FROM comment_reactions WHERE comment_id=? AND emoji=?", commentId, emoji))
          )
            throw new HttpError(400, "Zu viele verschiedene Reaktionen.");
          await run(
            "INSERT INTO comment_reactions(comment_id,user_id,emoji,created_at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING",
            commentId,
            user.id,
            emoji,
            Date.now(),
          );
        }
        result = { reactions: await commentReactions(user, commentId) };
        break;
      }
      case "comment.create": {
        const p = await requirePage(user, pid());
        await requireUnlocked(user, p);
        if (b.rowId) await requireRow(user, p.id, uuid.parse(b.rowId));
        const body = z.string().trim().min(1).max(5000).parse(b.body);
        await run(
          "INSERT INTO comments(id,page_id,row_id,author_id,body) VALUES(?,?,?,?,?)",
          id(),
          p.id,
          b.rowId ? uuid.parse(b.rowId) : null,
          user.id,
          body,
        );
        await emitWebhook(p.workspace_id, "comment.created", { pageId: p.id, rowId: b.rowId ? uuid.parse(b.rowId) : null, text: body }, user.name);
        await commentEvent(p.id, b.rowId ? uuid.parse(b.rowId) : null, user.id, { id: null, text: body });
        if (b.rowId) await queueIssuePush(p.id, uuid.parse(b.rowId));
        // Followers, the owner, the record's people, earlier commenters and
        // whoever "@Name" names – not the whole workspace, and only who may
        // read the page and the record (lib/comment-recipients.ts). A
        // mentioned person hears of it once, as a mention.
        const commentRow = b.rowId ? uuid.parse(b.rowId) : null;
        const mentioned = await commentTextMentions(user, p, body);
        for (const recipient of await commentRecipients(user, p, commentRow, mentioned)) {
          const mention = mentioned.includes(recipient);
          await run(
            "INSERT INTO notifications(id,user_id,body,page_id,row_id,kind) VALUES(?,?,?,?,?,?)",
            id(),
            recipient,
            mention ? `${user.name} hat dich in einem Kommentar in „${p.title}“ erwähnt` : `${user.name} kommentiert „${p.title}“`,
            p.id,
            commentRow,
            mention ? "mention" : "comment",
          );
          if (mention) await mentionWebhook(p.workspace_id, p.id, commentRow, recipient, user.name, user.id);
        }
        break;
      }
      case "comment.resolve": {
        const p = await requirePage(user, pid(), true);
        await requireUnlocked(user, p);
        // A record's comment: only with access to the record (as react).
        const commentId = uuid.parse(b.commentId);
        const rowId =
          (await one<{ row_id: string | null }>("SELECT row_id FROM comments WHERE id=? AND page_id=?", commentId, p.id))?.row_id ??
          (await one<{ row_id: string | null }>("SELECT row_id FROM shared_comments WHERE id=? AND page_id=?", commentId, p.id))?.row_id;
        if (rowId) await requireRow(user, p.id, rowId);
        await run(
          "UPDATE comments SET resolved=? WHERE id=? AND page_id=?",
          b.resolved ? 1 : 0,
          commentId,
          p.id,
        );
        await run(
          "UPDATE shared_comments SET resolved=? WHERE id=? AND page_id=?",
          b.resolved ? 1 : 0,
          commentId,
          p.id,
        );
        break;
      }
      case "row.appearance":
        result = await setRowAppearance(user, b);
        break;
      case "row.recurrence":
        result = await setRowRecurrence(user, b);
        break;
      case "row.repeat":
        result = await setRowRepeat(user, b);
        break;
      case "page.owner":
        result = await setPageOwner(user, b);
        break;
      case "page.review":
        result = await setPageReview(user, b);
        break;
      case "page.aliases":
        result = await setPageAliases(user, b);
        break;
      // Tags and custom properties (#70, lib/page-properties-server.ts).
      case "page.properties":
      case "pages.tag":
      case "tag.save":
      case "tag.delete":
      case "tag.merge":
      case "tag.reorder":
      case "property.save":
      case "property.delete":
      case "property.reorder":
        result = await pagePropertiesCommand(user, action, b, write);
        break;
      // Scopes (#136, lib/meta-scope-server.ts).
      case "tag.scope":
      case "property.scope":
        result = await changeScope(user, action === "tag.scope" ? "tag" : "property", b);
        break;
      case "meta.usage":
        result = await metaUsage(user, b);
        break;
      case "row.detachOccurrence":
        result = await detachOccurrence(user, b);
        break;
      case "reminder.set":
        result = await setDateReminder(user, b);
        break;
      case "notification.prefs":
        result = await setNotificationPref(user, b);
        break;
      case "notification.read":
        await run(
          "UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL", nowText(),
          user.id,
        );
        break;
      // Single notifications: mark read/unread or remove; only your own.
      case "notification.mark":
      case "notification.delete": {
        const nid = z.string().min(1).max(100).parse(b.notificationId);
        const changed =
          action === "notification.delete"
            ? (await run(
                "DELETE FROM notifications WHERE id=? AND user_id=?",
                nid,
                user.id,
              )).changes
            : (await run(
                "UPDATE notifications SET read_at=? WHERE id=? AND user_id=?",
                z.boolean().parse(b.read)
                  ? new Date().toISOString().replace("T", " ").slice(0, 19)
                  : null,
                nid,
                user.id,
              )).changes;
        if (!changed)
          throw new HttpError(404, "Benachrichtigung nicht gefunden.");
        break;
      }
      case "share.create":
      case "share.revoke":
      case "share.protect":
        result = await manageShareLink(user, b);
        break;
      case "publication.protect":
        await protectPublication(await write(), protectionChanges(b));
        break;
      case "page.publish": {
        const p = await write();
        const enabled = z.boolean().parse(b.enabled);
        await publishPage(
          user,
          p,
          enabled,
          z.boolean().optional().parse(b.includeChildren) ?? false,
          z.boolean().optional().parse(b.allowCopy) ?? true,
        );
        if (enabled) securityEvent("share.public", { actorId: user.id, detail: `page ${p.id}${b.includeChildren === true ? " with subpages" : ""}` });
        break;
      }
      case "publication.copy":
        result = await copyPublication(user, b);
        break;
      // The look of a publication and its own domain (lib/custom-domains.ts).
      case "publication.theme":
        result = await savePublicationTheme(user, b);
        break;
      case "domain.add":
        result = await addDomain(user, b);
        break;
      case "domain.remove":
        result = await removeDomain(user, b);
        break;
      // Block extensions (lib/plugins.ts); registering is POST /api/plugins.
      case "plugin.update":
        result = await updatePlugin(user, b);
        break;
      case "plugin.delete":
        result = await deletePlugin(user, b);
        break;
      case "form.update": {
        await write();
        await database(pid());
        const previous = await formSettings(pid()),
          config =
            b.config === undefined
              ? previous?.config || formConfigSchema.parse({})
              : formConfigSchema.parse(b.config);
        const enabled = b.enabled === undefined ? previous?.enabled || 0 : b.enabled ? 1 : 0,
          internal = b.internal === undefined ? (previous?.internal ?? 1) : b.internal ? 1 : 0;
        // No public form in a journal with a PIN (lib/journal-extras.ts).
        if (enabled && !internal && await inPinJournal({ id: pid() })) throw new HttpError(423, PIN_JOURNAL_NOT_SHARED);
        await run(
          "INSERT INTO forms(page_id,token,enabled,internal,anonymous,config) VALUES(?,?,?,?,?,?) ON CONFLICT(page_id) DO UPDATE SET enabled=excluded.enabled,internal=excluded.internal,anonymous=excluded.anonymous,config=excluded.config",
          pid(),
          id(),
          enabled,
          internal,
          b.anonymous === undefined
            ? previous?.anonymous || 0
            : b.anonymous
              ? 1
              : 0,
          JSON.stringify(config),
        );
        break;
      }
      case "sprint.setup":
      case "sprint.create":
      case "sprint.update":
      case "sprint.start":
      case "sprint.complete":
      case "sprint.delete":
      case "sprint.points": {
        const p = await write();
        if (p.kind !== "database") throw new HttpError(400, "Keine Datenbank.");
        await autoDatabaseSnapshot(user, p);
        result = await sprintCommand(user, p, action, b);
        break;
      }
      case "survey.save": {
        // The survey builder saves questions (properties) and settings at once.
        const p = await write();
        if (p.kind !== "database") throw new HttpError(400, "Keine Datenbank.");
        await autoDatabaseSnapshot(user, p);
        result = await saveSurvey(p, b);
        break;
      }
      case "recordView.save":
        result = await saveRecordView(user, b);
        break;
      case "recordView.delete":
        result = await deleteRecordView(user, b);
        break;
      case "git.setup":
      case "git.disable":
        result = await gitSetup(await write(), action);
        break;
      // Access token for the back-link comments (#184, lib/git-backlinks.ts).
      case "git.token":
        result = await gitAccessCommand(user, await write(), b);
        break;
      // GitHub/GitLab/Forgejo issue sync: connections and database mappings.
      case "issueSync.connect":
      case "issueSync.disconnect":
      case "issueSync.map":
      case "issueSync.unmap":
        result = await issueSyncCommand(user, action, b);
        break;
      case "time.start":
      case "time.stop":
      case "time.add":
      case "time.delete":
        result = await timeCommand(user, await requirePage(user, pid()), action, b);
        break;
      case "ticket.reply":
        // A team answer to a customer request; e-mailed to the customer.
        await write();
        result = await teamReply(user, pid(), uuid.parse(b.rowId), b.body);
        break;
      case "form.submit":
        await write();
        await database(pid());
        result = await saveFormSubmission(
          pid(),
          user,
          z.record(z.string(), z.unknown()).parse(b.cells),
          true,
        );
        break;
      // Changes to who belongs to a workspace take turns per workspace
      // (lockMembership): first the lock, then every check – also of the
      // actor's own role, which a parallel command may be changing.
      case "member.invite": {
        await lockMembership(wid());
        await requireMember(user, wid(), "owner");
        limitInviter(user.id);
        const email = z.email().parse(b.email).toLowerCase(),
          role = z.enum(["editor", "viewer"]).parse(b.role);
        await run(
          "INSERT INTO invites(id,workspace_id,email,role,created_by,guest,created_at,token) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,email) DO UPDATE SET role=excluded.role,guest=excluded.guest,created_at=excluded.created_at,token=COALESCE(invites.token,excluded.token)",
          id(),
          wid(),
          email,
          role,
          user.id,
          b.guest === true ? 1 : 0,
          Date.now(),
          inviteToken(),
        );
        securityEvent("invite.created", { actorId: user.id, subject: email, detail: `${role}${b.guest === true ? " guest" : ""} workspace ${wid()}` });
        // With SMTP configured the person hears about it by e-mail.
        {
          const ws = await one<{ name: string }>("SELECT name FROM workspaces WHERE id=?", wid());
          const token = (await one<{ token: string }>("SELECT token FROM invites WHERE workspace_id=? AND email=?", wid(), email))?.token;
          const invite = { email, inviter: user.name, workspace: ws?.name || "Flowplan", guest: b.guest === true, token };
          if (mailAllowed(email))
            afterCommit.push(async () => {
              if (await queueInviteMail(invite)) void dispatchMail();
            });
        }
        break;
      }
      // Open invitations: withdraw (with the pages waiting for them) or send again.
      case "invite.cancel":
      case "invite.resend": {
        await lockMembership(wid());
        await requireMember(user, wid(), "owner");
        const invite = await one<{ email: string; guest: number }>("SELECT email,guest FROM invites WHERE id=? AND workspace_id=?", uuid.parse(b.inviteId), wid());
        if (!invite) throw new HttpError(404, "Einladung nicht gefunden.");
        if (action === "invite.cancel") {
          await run("DELETE FROM invite_grants WHERE workspace_id=? AND lower(email)=lower(?)", wid(), invite.email);
          await run("DELETE FROM invites WHERE id=?", uuid.parse(b.inviteId));
        } else {
          const ws = await one<{ name: string }>("SELECT name FROM workspaces WHERE id=?", wid());
          const page = await one<{ title: string }>(
            "SELECT p.title FROM invite_grants g JOIN pages p ON p.id=g.resource_id WHERE g.workspace_id=? AND lower(g.email)=lower(?) AND p.deleted_at IS NULL",
            wid(),
            invite.email,
          );
          let token = (await one<{ token: string | null }>("SELECT token FROM invites WHERE id=?", uuid.parse(b.inviteId)))?.token;
          if (!token) {
            token = inviteToken();
            await run("UPDATE invites SET token=? WHERE id=?", token, uuid.parse(b.inviteId));
          }
          const mail = { email: invite.email, inviter: user.name, workspace: ws?.name || "Flowplan", guest: !!invite.guest, page: invite.guest ? page?.title : undefined, token };
          limitInviter(user.id);
          if (!mailAllowed(invite.email)) throw new HttpError(429, "Zu viele Einladungen in kurzer Zeit. Bitte später erneut versuchen.");
          await run("UPDATE invites SET created_at=? WHERE id=?", Date.now(), uuid.parse(b.inviteId));
          afterCommit.push(async () => {
            if (await queueInviteMail(mail)) void dispatchMail();
          });
          result = { mail: !!mailConfig() };
        }
        break;
      }
      case "member.role": {
        // "The last owner stays" is read, then written: two owners demoting
        // each other at once would both pass on PostgreSQL – one at a time.
        await lockMembership(wid());
        await requireMember(user, wid(), "owner");
        const target = uuid.parse(b.userId),
          role = z.enum(["owner", "editor", "viewer", "remove"]).parse(b.role);
        const old = await one<{ role: string }>(
          "SELECT role FROM members WHERE workspace_id=? AND user_id=?",
          wid(),
          target,
        );
        if (
          old?.role === "owner" &&
          role !== "owner" &&
          (await all(
            "SELECT user_id FROM members WHERE workspace_id=? AND role=?",
            wid(),
            "owner",
          )).length <= 1
        )
          throw new HttpError(400, "Der letzte Eigentümer muss bleiben.");
        if (role === "owner" && await isGuest({ id: target }, wid()))
          throw new HttpError(
            400,
            "Gäste zuerst zu Mitgliedern machen, bevor sie Eigentümer werden.",
          );
        if (role === "remove") {
          // Grants, groups and spaces go too: re-inviting starts afresh.
          await removeFromWorkspace(target, wid(), user.id);
        } else {
          await run(
            "UPDATE members SET role=? WHERE workspace_id=? AND user_id=?",
            role,
            wid(),
            target,
          );
          securityEvent("role.changed", { actorId: user.id, severity: role === "owner" ? "warn" : "info", detail: `${target} → ${role} in workspace ${wid()}` });
          // An SSO-managed membership keeps its source: the next SSO
          // sign-in sets the mapped role again (lib/sso-mappings.ts).
        }
        break;
      }
      // SSO groups → membership and groups of this workspace (lib/sso-mappings.ts).
      // Only instance admins map SSO groups: a mapping brings people of the
      // whole instance into a workspace (and shows their addresses there).
      case "sso.mapping.add":
        await requireMember(user, wid(), "owner");
        requireAdmin(user);
        result = await addSsoMapping(wid(), b);
        break;
      case "sso.mapping.delete":
        await requireMember(user, wid(), "owner");
        requireAdmin(user);
        await deleteSsoMapping(wid(), b.id);
        break;
      // The same for any workspace, from the administration.
      case "admin.ssoMapping.add":
        requireAdmin(user);
        result = await addSsoMapping(wid(), b);
        break;
      case "admin.ssoMapping.delete":
        requireAdmin(user);
        await deleteSsoMapping(wid(), b.id);
        break;
      case "member.guest": {
        await lockMembership(wid());
        await requireMember(user, wid(), "owner");
        const target = uuid.parse(b.userId),
          guest = z.boolean().parse(b.guest);
        const member = await one<{ role: string }>(
          "SELECT role FROM members WHERE workspace_id=? AND user_id=?",
          wid(),
          target,
        );
        if (!member) throw new HttpError(404, "Mitglied nicht gefunden.");
        if (guest && member.role === "owner")
          throw new HttpError(400, "Eigentümer können keine Gäste sein.");
        // A guest manages no space: their spaces go to the owner acting.
        if (guest)
          await run("UPDATE spaces SET owner_id=?,version=version+1 WHERE workspace_id=? AND owner_id=?", user.id, wid(), target);
        if (guest)
          await run(
            "INSERT INTO workspace_guests(workspace_id,user_id) VALUES(?,?) ON CONFLICT DO NOTHING",
            wid(),
            target,
          );
        else
          await run(
            "DELETE FROM workspace_guests WHERE workspace_id=? AND user_id=?",
            wid(),
            target,
          );
        break;
      }
      // One page with a person, without the whole workspace (lib/page-share.ts).
      case "page.share": {
        const shared = await sharePage(user, b);
        if (shared.status === "invited") {
          const { mail, send, ...rest } = shared;
          if (send)
            afterCommit.push(async () => {
              if (await queueInviteMail(mail)) void dispatchMail();
            });
          result = rest;
        } else {
          if (shared.mailed) afterCommit.push(() => void dispatchMail());
          result = shared;
        }
        break;
      }
      case "page.shareUpdate":
        result = await updatePageShare(user, b);
        break;
      case "grant.set": {
        const resource = uuid.parse(b.resourceId);
        const p = await one<Page>("SELECT * FROM pages WHERE id=?", resource),
          s = await one<Space>("SELECT * FROM spaces WHERE id=?", resource);
        if (!p && !s) throw new HttpError(404, "Ressource fehlt.");
        await lockMembership((p || s)!.workspace_id);
        await requireMember(user, (p || s)!.workspace_id, "owner");
        const uid = b.userId ? uuid.parse(b.userId) : "",
          gid = b.groupId ? uuid.parse(b.groupId) : "";
        if (!uid && !gid)
          throw new HttpError(400, "Mitglied oder Gruppe erforderlich.");
        if (
          uid &&
          !(await one(
            "SELECT 1 FROM members WHERE workspace_id=? AND user_id=?",
            (p || s)!.workspace_id,
            uid,
          ))
        )
          throw new HttpError(400, "Mitglied fehlt.");
        if (
          gid &&
          !(await one(
            "SELECT 1 FROM groups WHERE id=? AND workspace_id=?",
            gid,
            (p || s)!.workspace_id,
          ))
        )
          throw new HttpError(400, "Gruppe fehlt.");
        await run(
          "DELETE FROM grants WHERE resource_id=? AND user_id=? AND group_id=?",
          resource,
          uid,
          gid,
        );
        // Bound to the resource it is for: the page (as checked above) or the space.
        if (b.role !== "remove")
          await run(
            "INSERT INTO grants(resource_id,user_id,group_id,role,resource_kind,workspace_id) VALUES(?,?,?,?,?,?)",
            resource,
            uid,
            gid,
            z.enum(["editor", "viewer"]).parse(b.role),
            p ? "page" : "space",
            (p || s)!.workspace_id,
          );
        break;
      }
      case "group.create": {
        await requireMember(user, wid(), "owner");
        const gid = id();
        await run("INSERT INTO groups VALUES(?,?,?)", gid, wid(), str.parse(b.name));
        result = { id: gid };
        break;
      }
      case "group.member": {
        const gid = uuid.parse(b.groupId),
          g = await one<{ workspace_id: string }>(
            "SELECT * FROM groups WHERE id=?",
            gid,
          );
        if (!g) throw new HttpError(404, "Gruppe fehlt");
        await lockMembership(g.workspace_id);
        await requireMember(user, g.workspace_id, "owner");
        const uid = uuid.parse(b.userId);
        if (
          !(await one(
            "SELECT 1 FROM members WHERE workspace_id=? AND user_id=?",
            g.workspace_id,
            uid,
          ))
        )
          throw new HttpError(400, "Mitglied fehlt");
        if (b.enabled)
          await run("INSERT INTO group_members VALUES(?,?) ON CONFLICT DO NOTHING", gid, uid);
        else
          await run(
            "DELETE FROM group_members WHERE group_id=? AND user_id=?",
            gid,
            uid,
          );
        break;
      }
      case "template.save": {
        const p = await write();
        // Workflows start from the gallery's templates (lib/workflows/templates.ts)
        // or an export (lib/workflows/portable.ts), not from saved page templates.
        if (p.kind === "workflow") throw new HttpError(409, "Workflow-Seiten lassen sich noch nicht als Vorlage speichern.");
        const payload =
          p.kind === "database"
            ? JSON.stringify({
                appearance: pageAppearance(p),
                database: await database(p.id),
                // Only the records this person sees go into the template.
                rows: await visibleRows(user, p, await rows(p.id)),
                ...(await databaseTemplateExtras(user, p)),
                // Tags and property values (lib/page-properties-server.ts).
                meta: await portableMeta(p.id),
              })
            : JSON.stringify({
                appearance: pageAppearance(p),
                html:
                  (await one<{ html: string }>(
                    "SELECT html FROM documents WHERE page_id=?",
                    p.id,
                  ))?.html || "",
                // Notebooks: their sheets' paper and handwriting.
                ...(p.kind === "notebook" ? { notebook: await notebookArchive(p.id) } : {}),
                meta: await portableMeta(p.id),
              });
        const templateId = id();
        if (payload.length > 20_000_000)
          throw new HttpError(413, "Vorlage zu groß.");
        // The scope (#136): the page's space by default, `spaceId: null` the
        // whole workspace – then only with the workspace's tags and
        // definitions (refused, or without the space's: `spaceMeta: "remove"`).
        const templateSpace = b.spaceId === null ? null : b.spaceId === undefined ? p.space_id : uuid.parse(b.spaceId);
        if (templateSpace && templateSpace !== p.space_id)
          throw new HttpError(400, "Eine Vorlage gehört zum Bereich ihrer Seite oder zum ganzen Arbeitsbereich.");
        await requireTemplateScope(user, p.workspace_id, templateSpace, b.private ? "private" : "workspace");
        let storedPayload = payload;
        if (!templateSpace) {
          const refs = await templateSpaceRefs(payload, p.workspace_id, p.space_id);
          if (refs.length && b.spaceMeta !== "remove") throw new HttpError(409, spaceRefsMessage(refs));
          if (refs.length) storedPayload = await stripSpaceRefs(payload, refs);
        }
        await run(
          "INSERT INTO templates(id,workspace_id,space_id,name,kind,payload,created_by,visibility,category) VALUES(?,?,?,?,?,?,?,?,?)",
          templateId,
          p.workspace_id,
          templateSpace,
          str.parse(b.name),
          p.kind,
          storedPayload,
          user.id,
          b.private ? "private" : "workspace",
          z
            .enum(templateCategoryIds)
            .or(z.literal(""))
            .catch("")
            .parse(b.category ?? ""),
        );
        const quota = await quotaCheckpoint(p.workspace_id);
        await captureTemplateFiles(user, templateId, storedPayload);
        await quota();
        result = { id: templateId };
        break;
      }
      case "template.copy":
        result = await copyPageTemplate(user, b);
        break;
      case "template.dependencies":
        result = await pageTemplateDependencies(user, b);
        break;
      case "template.purge":
        result = await purgeTemplate(user, b);
        break;
      case "template.update":
      case "template.delete":
      case "template.restore":
        result = await managePageTemplate(user, b);
        break;
      case "template.apply": {
        const p = await write();
        const template = await requireTemplate(user, b.templateId, p.workspace_id);
        if (p.kind === "database" && b.version !== (await database(p.id)).version)
          throw new HttpError(
            409,
            "Die Datenbank wurde zwischenzeitlich geändert. Bitte neu laden.",
          );
        result = await applyPageTemplate(user, p, template, true, parseMetaPlan(b.meta));
        break;
      }
      case "page.fromShare": {
        // "Teilen an Flowplan": text and link from another app as a page.
        await requireMember(user, wid(), "editor");
        const sid = uuid.parse(b.spaceId);
        const shareSpace = await one<Space>("SELECT * FROM spaces WHERE id=? AND workspace_id=? AND deleted_at IS NULL", sid, wid());
        if (!shareSpace) throw new HttpError(404, "Bereich nicht gefunden.");
        // A page (or bookmark) lands in the space: only for those who may
        // write there, as with page.create. A record goes into its database,
        // whose rights requirePage checks below.
        if (b.as !== "record" && !["editor", "owner"].includes(await spaceRole(user, shareSpace) || ""))
          throw new HttpError(403, "Kein Zugriff auf Bereich.");
        const shared = z
          .object({
            title: z.string().max(300).optional(),
            text: z.string().max(20_000).optional(),
            url: z.string().max(2000).optional(),
          })
          .parse(b);
        const esc = (v: string) =>
          v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
        // Apps often put the link into the text as well.
        const link = shared.url || shared.text?.match(/https?:\/\/\S+/)?.[0] || "";
        const text = (shared.text || "").replace(link, "").trim();
        const safeLink = /^https?:\/\//.test(link) ? link : "";
        const html = cleanHtml(
          [
            ...text.split(/\n{2,}/).filter(Boolean).map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`),
            safeLink ? `<p><a href="${esc(safeLink)}">${esc(safeLink)}</a></p>` : "",
          ].join(""),
        );
        const title =
          shared.title?.trim() ||
          text.split("\n")[0].slice(0, 120) ||
          (safeLink ? new URL(safeLink).hostname : "Geteilt");
        // Clipped article text (from /api/clip) follows the link.
        const article = typeof b.article === "string" ? cleanHtml(b.article.slice(0, 250_000)) : "";
        const body = article ? `${html}<hr>${article}` : html;
        if (b.as === "record") {
          const target = await requirePage(user, uuid.parse(b.databaseId));
          if (target.workspace_id !== wid()) throw new HttpError(400, "Nur innerhalb eines Arbeitsbereichs.");
          result = await captureRecord(user, { pageId: target.id, title: shared.title, text: shared.text, url: shared.url, article: article || undefined });
          break;
        }
        if (b.as === "bookmark") {
          if (!safeLink) throw new HttpError(400, "Ein Lesezeichen braucht einen Link.");
          const db = await bookmarksDatabase(wid(), sid, user.id);
          // The bookmarks database may lie below a journal with a PIN.
          await requireUnlocked(user, await requirePage(user, db, true));
          const saved = await addBookmarks(db, user.id, [
            { title: title.slice(0, 300), url: safeLink, note: text.slice(0, 2000), content: article },
          ]);
          if (!saved.added) throw new HttpError(409, "Dieser Link ist schon unter den Lesezeichen.");
          result = { id: db, rowId: saved.ids[0] };
          break;
        }
        const created = await createPage(wid(), sid, user.id, title.slice(0, 200), "document");
        await run("UPDATE documents SET html=?,state=? WHERE page_id=?", body, htmlState(body), created);
        result = { id: created };
        break;
      }
      case "page.toRecord": {
        const moved = await pageToRecord(user, pid(), uuid.parse(b.databaseId));
        afterCommit.push(...moved.publish);
        result = moved.result;
        break;
      }
      case "record.toPage": {
        // The reverse: a record becomes a page (lib/record-to-page.ts).
        const moved = await recordToPage(user, pid(), uuid.parse(b.rowId), {
          spaceId: uuid.parse(b.spaceId),
          parentId: b.parentId ? uuid.parse(b.parentId) : null,
          keepProperties: b.keepProperties !== false,
        });
        afterCommit.push(...moved.publish);
        result = moved.result;
        break;
      }
      case "capture.record":
        result = await captureRecord(user, b);
        break;
      case "capture.target":
        result = await setCaptureTarget(user, wid(), b.pageId ? uuid.parse(b.pageId) : null);
        break;
      case "bookmarks.import": {
        await requireMember(user, wid(), "editor");
        const sid = uuid.parse(b.spaceId);
        const importSpace = await one<Space>("SELECT * FROM spaces WHERE id=? AND workspace_id=? AND deleted_at IS NULL", sid, wid());
        if (!importSpace) throw new HttpError(404, "Bereich nicht gefunden.");
        // The bookmarks database is created in the space – rights first.
        if (!["editor", "owner"].includes(await spaceRole(user, importSpace) || ""))
          throw new HttpError(403, "Kein Zugriff auf Bereich.");
        const items = parseBookmarksHtml(z.string().max(20_000_000).parse(b.html));
        if (!items.length) throw new HttpError(400, "In der Datei wurden keine Lesezeichen gefunden.");
        const db = await bookmarksDatabase(wid(), sid, user.id);
        await requireUnlocked(user, await requirePage(user, db, true));
        const saved = await addBookmarks(db, user.id, items);
        result = { id: db, added: saved.added, skipped: saved.skipped };
        break;
      }
      case "calendar.feed":
        result = await createCalendarFeed(user, pid(), z.string().max(100).parse(b.viewId));
        break;
      case "calendar.feed.revoke":
        await revokeCalendarFeed(user, pid(), z.string().max(100).parse(b.viewId));
        break;
      case "calendar.caldav":
        result = await createCalDavAccess(user, pid(), z.string().max(100).parse(b.viewId));
        break;
      case "calendar.caldav.revoke":
        await revokeCalDavAccess(user, pid(), z.string().max(100).parse(b.viewId));
        break;
      // Google / Microsoft 365 calendar sync, per person (lib/calendar-sync.ts).
      case "calendarSync.map":
        result = await saveCalendarMapping(user, b);
        break;
      case "calendarSync.unmap":
        await deleteCalendarMapping(user, b);
        break;
      case "calendarSync.disconnect":
        await disconnectCalendar(user, b);
        break;
      // A meeting note for an appointment of a journal day (lib/meeting-notes.ts).
      case "meeting.note":
        result = await createMeetingNote(user, b);
        break;
      case "token.create":
        result = await createApiToken(user, b);
        break;
      case "token.revoke":
        await revokeApiToken(user, b.id);
        break;
      case "webhook.delete":
        await deleteWebhook(user, b);
        break;
      // E-mail inbound capture, by workspace owners (lib/inbound-mail.ts).
      case "inbound.save":
        result = await saveInboundAddress(user, b);
        break;
      case "inbound.rotate":
        result = await rotateInboundToken(user, b);
        break;
      case "inbound.delete":
        result = await deleteInboundAddress(user, b);
        break;
      case "admin.user": {
        requireAdmin(user);
        const uid = uuid.parse(b.userId);
        if (uid === user.id)
          throw new HttpError(
            400,
            "Eigenes Konto kann nicht deaktiviert werden.",
          );
        await setUserDisabled(uid, !!b.disabled);
        securityEvent("admin.user", { actorId: user.id, detail: `${b.disabled ? "disabled" : "enabled"} ${uid}` });
        break;
      }
      case "admin.quota": {
        requireAdmin(user);
        const quota = z
          .number()
          .int()
          .min(0)
          .max(10_000_000)
          .nullable()
          .parse(b.quotaMb);
        await setWorkspaceQuota(uuid.parse(b.workspaceId), quota);
        break;
      }
      // Accounts with e-mail and password: admin right, reset link.
      case "admin.localAdmin": {
        requireAdmin(user);
        const uid = uuid.parse(b.userId);
        if (uid === user.id && !b.admin)
          throw new HttpError(400, "Das eigene Admin-Recht kann nur eine andere Person entziehen.");
        await setLocalAdmin(uid, b.admin === true);
        securityEvent(b.admin === true ? "admin.granted" : "admin.revoked", { actorId: user.id, detail: `local account ${uid}` });
        break;
      }
      // Lost phone: the authenticator app of an account is turned off.
      case "admin.twoFactorReset":
        requireAdmin(user);
        await adminResetTwoFactor(uuid.parse(b.userId));
        securityEvent("admin.user", { actorId: user.id, detail: `two-factor reset ${b.userId}` });
        break;
      case "admin.resetLink":
        requireAdmin(user);
        result = { url: await adminResetLink(uuid.parse(b.userId)) };
        securityEvent("admin.user", { actorId: user.id, detail: `password reset link ${b.userId}` });
        break;
      case "admin.revoke":
        requireAdmin(user);
        await run("DELETE FROM sessions WHERE user_id=?", uuid.parse(b.userId));
        securityEvent("session.revoked", { actorId: user.id, detail: `all sessions of ${b.userId}` });
        break;
      default:
        throw new HttpError(400, "Unbekannte Aktion.");
    }
    // A change of one record answers with the record's version after it –
    // automations included –, so the next change of the same record can
    // carry it right away (lib/row-queue.ts, #104).
    if (rowVersionActions.has(action) && typeof b.rowId === "string" && result && typeof result === "object" && !Array.isArray(result)) {
      const changed = await one<{ version: number }>("SELECT version FROM rows WHERE id=?", b.rowId);
      if (changed) result = { ...result, rowVersion: changed.version };
    }
    // Content changes: who edited, and followers are told.
    if (editActions.has(action) && typeof b.pageId === "string")
      await recordPageEdit(user, b.pageId);
    // Workflows: a page's content or title changed (debounced, lib/workflows/hooks.ts).
    if ((action === "document.sync" || action === "whiteboard.sync") && typeof b.pageId === "string" && b.update)
      await pageChangedEvent(b.pageId, user.id, ["content"]);
    if (action === "page.update" && typeof b.pageId === "string" && (b.patch as { title?: unknown } | undefined)?.title !== undefined)
      await pageChangedEvent(b.pageId, user.id, ["title"]);
    // Whoever creates a page follows it.
    const createdId = (result as { id?: unknown } | null)?.id;
    if (action === "page.create" && typeof createdId === "string" && !user.apiScope)
      await setFollowing(user, createdId, true);
    if (
      ![
        "document.sync",
        "document.markdown",
        "row.document.sync",
        "whiteboard.sync",
        "workflow.sync",
        "workflow.validate",
        "notification.read",
        "favorite",
      ].includes(action)
    )
      await audit(
        user.id,
        action,
        String(b.pageId || b.spaceId || b.workspaceId || b.userId || ""),
      );
    return result;
  };
  // Files copied by a command count towards the person's storage.
  const checked = async () => {
    const check = await userStorageCheckpoint(user);
    const value = await execute();
    await check();
    return value;
  };
  // Commands that may end the Git export of a space: its working copy goes
  // once the settings are gone.
  if (GIT_EXPORT_ENDS.has(action)) afterCommit.push(sweepSpaceGitCopies);
  const applied = async () => {
    await keyed?.begin(action);
    const value = await checked();
    await keyed?.end(value, action);
    return value;
  };
  // Commands that check a secret (a journal PIN) keep the count of wrong
  // ones although they refuse (lib/db.ts refuseKeeping).
  const keeps = KEEPS_REFUSALS.get(action);
  const result = withinTransaction
    ? await applied()
    : keeps
      ? await transactionKeepingRefusals(applied, user, keeps(user, b))
      : await transaction(applied, user);
  try {
    await commandWebhooks(action, b, result, user.name);
  } catch (error) {
    console.error("Webhook-Ereignis fehlgeschlagen", error);
  }
  for (const task of afterCommit)
    try {
      await task();
    } catch (error) {
      console.error("Nachlauf eines Befehls fehlgeschlagen", error);
    }
  return result;
}
// One emoji (with modifiers and joiners), nothing else.
const reactionEmoji = z
  .string()
  .max(32)
  .regex(/^(?:\p{Extended_Pictographic}|\p{Emoji_Presentation}|\p{Regional_Indicator}|\p{Emoji_Modifier}|\u200d|\ufe0f)+$/u, "Nur ein Emoji.");
export async function commentReactions(user: Identity, commentId: string) {
  const rows = await all<{ emoji: string; user_id: string; name: string }>(
    "SELECT r.emoji,r.user_id,u.name FROM comment_reactions r JOIN users u ON u.id=r.user_id WHERE r.comment_id=? ORDER BY r.created_at",
    commentId,
  );
  const byEmoji = new Map<string, { emoji: string; count: number; mine: boolean; names: string[] }>();
  for (const row of rows) {
    const entry = byEmoji.get(row.emoji) || { emoji: row.emoji, count: 0, mine: false, names: [] };
    entry.count++;
    entry.names.push(row.name);
    if (row.user_id === user.id) entry.mine = true;
    byEmoji.set(row.emoji, entry);
  }
  return [...byEmoji.values()];
}
// Commands whose refusals keep their bookkeeping (wrong PINs counted,
// lib/journal-extras.ts): run in transactionKeepingRefusals, with the locks
// their checks take (held until the count is committed).
const pinLocks = (user: Identity, b: Record<string, unknown>) => (typeof b.pageId === "string" ? [pinAttemptKey(user, b.pageId)] : []);
const KEEPS_REFUSALS = new Map<string, (user: Identity, b: Record<string, unknown>) => string[]>([
  ["journal.unlock", pinLocks],
  ["journal.lock", pinLocks],
]);
// Commands that change one record (`rowId`) under its version.
const rowVersionActions = new Set([
  "row.update",
  "row.appearance",
  "row.recurrence",
  "row.repeat",
  "row.detachOccurrence",
  "row.move",
  "row.schedule",
]);
// Commands that change a page's content (`pageId`): recorded as an edit
// (lib/page-activity.ts); "My activity" counts them from the activity log
// (lib/my-activity.ts).
export const editActions = new Set([
  "document.sync",
  "database.update",
  "database.settings",
  "survey.save",
  "row.schedule",
  "timeline.cascade",
  "timeline.link",
  "row.move",
  "rows.bulk",
  "rows.transfer",
  "row.create",
  "row.document.sync",
  "rows.import",
  "row.update",
  "row.delete",
  "whiteboard.sync",
  "notebook.sheet.add",
  "notebook.sheet.duplicate",
  "notebook.sheet.delete",
  "notebook.sheet.move",
  "notebook.sheet.paper",
  "notebook.paper",
  "notebook.import",
  "notebook.sheet.meta",
  "notebook.sheet.links",
  "notebook.outline",
  "notebook.outline.add",
  "notebook.sheets.duplicate",
  "notebook.sheets.delete",
  "notebook.trash.restore",
  "notebook.sheets.transfer",
  "row.recurrence",
  "row.repeat",
  "row.detachOccurrence",
  "row.appearance",
  "snapshot.restore",
  "row.snapshot.restore",
  "page.update",
]);
// Webhooks for records and pages changed through commands.
async function commandWebhooks(action: string, b: Record<string, unknown>, result: unknown, actor?: string) {
  const created = (result as { id?: unknown } | null)?.id;
  // Shared or captured as a record (or bookmark): a new record, not a page.
  const capturedRow = (result as { rowId?: unknown } | null)?.rowId;
  if ((action === "page.fromShare" || action === "capture.record") && typeof capturedRow === "string")
    return await commandWebhooks("row.create", b, { id: capturedRow }, actor);
  if ((action === "page.create" || action === "page.fromShare") && typeof created === "string") {
    const page = await one<{ workspace_id: string; title: string; kind: string; parent_id: string | null }>(
      "SELECT workspace_id,title,kind,parent_id FROM pages WHERE id=?",
      created,
    );
    if (page)
      await emitWebhook(page.workspace_id, "page.created", {
        pageId: created,
        title: page.title,
        kind: page.kind,
        parentId: page.parent_id,
      }, actor);
    return;
  }
  const rowId = action === "row.create" ? created : action === "row.update" ? b.rowId : null;
  if (typeof rowId !== "string") return;
  const row = await one<{ page_id: string; cells: string; workspace_id: string }>(
    "SELECT r.page_id,r.cells,p.workspace_id FROM rows r JOIN pages p ON p.id=r.page_id WHERE r.id=?",
    rowId,
  );
  if (!row) return;
  await emitWebhook(row.workspace_id, action === "row.create" ? "row.created" : "row.updated", {
    pageId: row.page_id,
    rowId,
    cells: JSON.parse(row.cells),
    ...(action === "row.update" ? { changed: Object.keys((b.cells as object) || {}) } : {}),
  }, actor);
}
// Live editing: clients send their state vector, so the answer only holds
// what they are missing instead of the whole document.
function liveVector(vector: unknown) {
  if (typeof vector !== "string" || !vector || vector.length > 200_000) return null;
  return Buffer.from(vector, "base64");
}
function liveState(doc: Y.Doc, merged: Uint8Array, vector: unknown) {
  const v = liveVector(vector);
  return Buffer.from(v ? Y.encodeStateAsUpdate(doc, v) : merged).toString("base64");
}
function liveDiff(state: string, vector: unknown) {
  const v = liveVector(vector);
  if (!v) return state;
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, Buffer.from(state, "base64"));
    return Buffer.from(Y.encodeStateAsUpdate(doc, v)).toString("base64");
  } finally {
    doc.destroy();
  }
}
const liveClient = (client: unknown) =>
  typeof client === "string" && client.length <= 64 ? client : undefined;
async function createWorkspaceInner(user: string, name: string) {
  const wid = id(),
    sid = id();
  await run(
    "INSERT INTO workspaces(id,name,created_by) VALUES(?,?,?)",
    wid,
    name,
    user,
  );
  await run("INSERT INTO members VALUES(?,?,?)", wid, user, "owner");
  await run(
    "INSERT INTO spaces(id,workspace_id,name,owner_id) VALUES(?,?,?,?)",
    sid,
    wid,
    "Teamspace",
    user,
  );
  await createPage(wid, sid, user, "Willkommen");
  return wid;
}
import { inlineCommentCommand } from "./inline-comments";
import {
  archivedThreadsSchema,
  importInlineComments,
} from "./inline-comment-archive";
import { ensureRowDocument } from "./row-documents";
import { createCalendarFeed, revokeCalendarFeed } from "./calendar-feed";
import { createApiToken, revokeApiToken } from "./api-tokens";
import { deleteWebhook, emitWebhook, mentionWebhook } from "./webhooks";
import { addSsoMapping, deleteSsoMapping } from "./sso-mappings";
import { dispatchMail, mailConfig, queueInviteMail } from "./mail";
import { documentChanged, documentKey, publishDocumentUpdate } from "./document-live";
import { listDateReminders, setDateReminder } from "./date-reminders";
import { setRowAppearance, setRowRecurrence } from "./row-appearance";
import { setRowRepeat } from "./repeat-records";
import { parseRepeat } from "./recurrence";
import { reviewsDue, setPageOwner, setPageReview } from "./page-review";
import { parseAliases, setPageAliases } from "./page-aliases";
import {
  applyPortableMeta,
  canManageScope,
  frontmatterMeta,
  memberByName,
  pageMetaFor,
  pagePropertiesCommand,
  portableMeta,
  workspaceTaxonomy,
} from "./page-properties-server";
import { prepareTagFields, reconcileTagFields, tagCells } from "./tag-fields";
import { applyMovePlan, changeScope, metaUsage, moveForeignMeta, needsPlanMessage, parseMetaPlan } from "./meta-scope-server";
import { choiceFor } from "./meta-scope";
import { splitFrontmatter } from "./frontmatter";
import { frontmatterAliases, storedAliases } from "./aliases";
import { aliasField, aliasList } from "./aliases";
import { copyPublication } from "./publication-copy";
import { purgeTrashedRow, restoreTrashedRow, trashRow } from "./row-trash";
import { purgeTrashedFile, restoreFile, trashFiles, trashUnusedFiles } from "./file-trash";
import { emptyTrash, purgeTemplate, purgeTrashedPage, restoreTrashedPage, trashDays } from "./trash";
import { dashboardData, saveDashboard } from "./dashboard";
import { notebookArchive, notebookCommand, notebookData } from "./notebook";
import { deleteSticker, deleteTemplate, insertSticker, listStickers, listTemplates, notebookPictures, renameSticker, saveSticker, updateTemplate } from "./notebook-library";
import { transferSheets } from "./notebook-organize";
import { quotaCheckpoint, setWorkspaceQuota } from "./instance-ops";
import { rowChanged, rowCreated } from "./automations";
import { workflowCommand } from "./workflows/commands";
import { commentEvent, pageChangedEvent, pageCreatedEvent, pageMovedEvent } from "./workflows/hooks";
import { assertWorkflowsEnabled, restoreVersion, trashWorkflows, workflowState } from "./workflows/store";
import { applyDatabaseProposal, forgetAiFields, prepareAiFields } from "./ai/database-fields";
import { ct } from "./content-locale";
import { TABLE_DATABASE_LIMITS, tableToDatabase } from "./table-database";
import { ensureBlockIds, linkedBlockIds } from "./block-links";
import { filterAsync, forEachAsync, mapAsync } from "./each-async";
import { dropLiveProjectionsOfRoot } from "./shared-live";
