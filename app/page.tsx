import { currentUser } from "@/lib/auth";
import { bootstrap } from "@/lib/api";
import { ensureWorkspace } from "@/lib/seed";
import WorkspaceApp from "@/components/workspace-app";
import PublicHome from "@/components/landing/public-home";
import { instanceSettings } from "@/lib/instance-settings";
export const dynamic = "force-dynamic";
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ authError?: string; useTemplate?: string }>;
}) {
  const user = await currentUser();
  if (!user)
    return (
      <PublicHome
        demo={process.env.NODE_ENV !== "production"}
        configured={!!process.env.OIDC_ISSUER}
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
        useTemplate && /^[0-9a-f-]{36}$/i.test(useTemplate)
          ? useTemplate
          : undefined
      }
    />
  );
}
