import { currentUser } from "@/lib/auth";
import { bootstrap } from "@/lib/api";
import { ensureWorkspace } from "@/lib/seed";
import WorkspaceApp from "@/components/workspace-app";
import Login from "@/components/login";
export const dynamic = "force-dynamic";
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ authError?: string }>;
}) {
  const user = await currentUser();
  if (!user)
    return (
      <Login
        demo={process.env.NODE_ENV !== "production"}
        configured={!!process.env.OIDC_ISSUER}
        error={(await searchParams).authError}
      />
    );
  ensureWorkspace(user.id);
  return <WorkspaceApp initial={bootstrap(user) as never} />;
}
