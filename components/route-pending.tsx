"use client";
// The placeholder rendered with the server's start page: hidden unless the
// address names another place (<html data-route-pending>, lib/route-pending.ts),
// then app/globals.css shows the one of that place's shape instead of the
// start page until the workspace has drawn it.
import { ListSkeleton, SettingsSkeleton } from "./skeleton";
import { PageSkeleton } from "./ui";

export function RoutePendingPlaceholder() {
  return (
    <div className="route-pending">
      <div className="route-pending-page page-content">
        <PageSkeleton />
      </div>
      <div className="route-pending-settings settings-loading">
        <SettingsSkeleton />
      </div>
      <div className="route-pending-list page-content">
        <ListSkeleton rows={6} />
      </div>
    </div>
  );
}
