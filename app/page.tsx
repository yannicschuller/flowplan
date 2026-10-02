import { currentUser } from "@/lib/auth";
import { bootstrap } from "@/lib/api";
import { ensureWorkspace } from "@/lib/seed";
import WorkspaceApp from "@/components/workspace-app";
import PublicHome from "@/components/landing/public-home";
import { instanceSettings } from "@/lib/instance-settings";
import { publicSite } from "@/lib/site";
import Login from "@/components/login";
import { loginOptions } from "@/lib/local-auth";
export const dynamic = "force-dynamic";
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ authError?: string; useTemplate?: string }>;
}) {
  const user = await currentUser();
  // Self-hosted: straight to signing in; the website is flowplan.org's.
  if (!user && !publicSite())
    return (
      <Login
        {...loginOptions()}
        error={(await searchParams).authError}
        instanceName={instanceSettings().name}
      />
    );
  if (!user)
    return (
      <PublicHome
        {...loginOptions()}
        error={(await searchParams).authError}
        instanceName={instanceSettings().name}
        demoEnabled={instanceSettings().publicDemo}
      />
    );
  ensureWorkspace(user.id);
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
