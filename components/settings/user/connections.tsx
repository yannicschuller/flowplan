"use client";
// Settings → Kalender & Issues: Google and Microsoft calendars, Apple
// Calendar by configuration profile (CalDAV), GitHub and GitLab issues.
import { CalendarConnections } from "../../calendar-connections";
import { CalDavProfile } from "../../caldav-profile";
import { IssueSyncSettings } from "../../issue-sync-settings";
import { useUserSettings } from "../user-context";

export default function ConnectionsSection() {
  const { boot, onError } = useUserSettings();
  return (
    <>
      {!boot.user.demo && <CalendarConnections onError={onError} />}
      {!boot.user.demo && <CalDavProfile onError={onError} />}
      <IssueSyncSettings workspaceId={boot.workspace.id} onError={onError} />
    </>
  );
}
