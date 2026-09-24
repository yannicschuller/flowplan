import { PublishedPage } from "@/components/public-page";
export const dynamic = "force-dynamic";
export const metadata = {
  robots: { index: false, follow: false },
  referrer: "no-referrer" as const,
};
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ token: string; pageId: string }>;
  searchParams: Promise<{ row?: string; view?: string }>;
}) {
  const { token, pageId } = await params;
  const { row, view } = await searchParams;
  return (
    <PublishedPage token={token} pageId={pageId} rowId={row} viewId={view} />
  );
}
