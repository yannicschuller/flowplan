import { acceptInviteToken, currentUser } from "@/lib/auth";
import { one } from "@/lib/db";
import type { User } from "@/lib/types";
import { legalLinks } from "@/lib/legal-links";
import { bootstrap } from "@/lib/api";
import { ensureWorkspace } from "@/lib/seed";
import { withContentLocale } from "@/lib/content-locale";
import { rememberLocale } from "@/lib/user-locale";
import { requestLocale } from "@/lib/i18n-server";
import WorkspaceApp from "@/components/workspace-app";
import { MaintenanceBanner } from "@/components/maintenance-banner";
import { MoveBanner } from "@/components/move-banner";
import { readOnlyState } from "@/lib/instance-read-only";
import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { WORKSPACE_COOKIE, lastWorkspace } from "@/lib/last-workspace";
import { sourceUrl } from "@/lib/about";
import { maintenanceNotice } from "@/lib/admin-ops";
import { instanceSettings } from "@/lib/instance-settings";
import Login from "@/components/login";
import { TwoFactorRequired } from "@/components/two-factor";
import { loginOptions } from "@/lib/local-auth";
export const dynamic = "force-dynamic";
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ authError?: string; useTemplate?: string; invite?: string; confirmed?: string; setup?: string }>;
}) {
  // An instance that has moved (lib/instance-move.ts) may send the browser
  // to its new address; otherwise a banner says where it went.
  const move = await readOnlyState();
  if (move.redirect && move.movedTo) redirect(move.movedTo);
  const user = await currentUser();
  // Visitors sign in.
  if (!user)
    return (
      <>
        <MoveBanner initial={move} poll={false} />
        <Login
          legal={legalLinks()}
          {...await loginOptions((await searchParams).setup, (await searchParams).invite)}
          error={(await searchParams).authError}
          notice={(await searchParams).confirmed ? "confirmed" : undefined}
          instanceName={(await instanceSettings()).name}
          sourceUrl={sourceUrl()}
        />
      </>
    );
  // The instance requires a second factor this account does not have yet.
  if (user.twoFactorSetup) return <TwoFactorRequired name={user.name} instanceName={(await instanceSettings()).name} />;
  const locale = await requestLocale();
  await rememberLocale(user.id, locale);
  await withContentLocale(locale, async () => await ensureWorkspace(user.id));
  const { useTemplate, invite } = await searchParams;
  // An invitation link: taken over by whoever opens it signed in, and the
  // app opens in that workspace.
  const invited = invite ? (await acceptInviteToken((await one<User>("SELECT * FROM users WHERE id=?", user.id))!, invite)) : null;
  // Otherwise the workspace last open on this device (#188); bootstrap
  // falls back to the first one when the person is no longer a member.
  const remembered = lastWorkspace((await cookies()).get(WORKSPACE_COOKIE)?.value);
  return (
    <>
      {/* A scheduled maintenance announced in Administration → Operations. */}
      <MoveBanner initial={move} poll />
      <MaintenanceBanner initial={await maintenanceNotice()} />
      <WorkspaceApp
        initial={(await bootstrap(user, invited || remembered, (await headers()).get("user-agent"))) as never}
        inviteResult={invite ? (invited ? "accepted" : "invalid") : undefined}
        useTemplate={
          useTemplate && (/^[0-9a-f-]{36}$/i.test(useTemplate) || /^starter:[A-Za-z]{1,40}$/.test(useTemplate))
            ? useTemplate
            : undefined
        }
      />
    </>
  );
}
