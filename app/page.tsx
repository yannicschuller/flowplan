import { currentUser } from "@/lib/auth";
import { bootstrap } from "@/lib/api";
import { ensureWorkspace } from "@/lib/seed";
import { withContentLocale } from "@/lib/content-locale";
import { rememberLocale } from "@/lib/user-locale";
import { requestLocale } from "@/lib/i18n-server";
import WorkspaceApp from "@/components/workspace-app";
import { instanceSettings } from "@/lib/instance-settings";
import Login from "@/components/login";
import { loginOptions } from "@/lib/local-auth";
export const dynamic = "force-dynamic";
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ authError?: string; useTemplate?: string }>;
}) {
  const user = await currentUser();
  // Visitors sign in.
  if (!user)
    return (
      <Login
        {...loginOptions()}
        error={(await searchParams).authError}
        instanceName={instanceSettings().name}
      />
    );
  const locale = await requestLocale();
  rememberLocale(user.id, locale);
  withContentLocale(locale, () => ensureWorkspace(user.id));
  const { useTemplate } = await searchParams;
  return (
    <WorkspaceApp
      initial={bootstrap(user) as never}
      useTemplate={
        useTemplate && (/^[0-9a-f-]{36}$/i.test(useTemplate) || /^starter:[A-Za-z]{1,40}$/.test(useTemplate))
          ? useTemplate
          : undefined
      }
    />
  );
}
