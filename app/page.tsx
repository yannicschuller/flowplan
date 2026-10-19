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
import { instanceSettings } from "@/lib/instance-settings";
import Login from "@/components/login";
import { TwoFactorRequired } from "@/components/two-factor";
import { loginOptions } from "@/lib/local-auth";
export const dynamic = "force-dynamic";
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ authError?: string; useTemplate?: string; invite?: string; confirmed?: string }>;
}) {
  const user = await currentUser();
  // Visitors sign in.
  if (!user)
    return (
      <Login
        legal={legalLinks()}
        {...loginOptions()}
        error={(await searchParams).authError}
        notice={(await searchParams).confirmed ? "confirmed" : undefined}
        instanceName={instanceSettings().name}
      />
    );
  // The instance requires a second factor this account does not have yet.
  if (user.twoFactorSetup) return <TwoFactorRequired name={user.name} instanceName={instanceSettings().name} />;
  const locale = await requestLocale();
  rememberLocale(user.id, locale);
  withContentLocale(locale, () => ensureWorkspace(user.id));
  const { useTemplate, invite } = await searchParams;
  // An invitation link: taken over by whoever opens it signed in, and the
  // app opens in that workspace.
  const invited = invite ? acceptInviteToken(one<User>("SELECT * FROM users WHERE id=?", user.id)!, invite) : null;
  return (
    <WorkspaceApp
      initial={bootstrap(user, invited || undefined) as never}
      inviteResult={invite ? (invited ? "accepted" : "invalid") : undefined}
      useTemplate={
        useTemplate && (/^[0-9a-f-]{36}$/i.test(useTemplate) || /^starter:[A-Za-z]{1,40}$/.test(useTemplate))
          ? useTemplate
          : undefined
      }
    />
  );
}
