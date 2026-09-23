import { PublishedPage } from "@/components/public-page";
export const dynamic = "force-dynamic";
export const metadata = { robots: { index: false, follow: false }, referrer: "no-referrer" as const };
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ row?: string }>;
}) {
  const { token } = await params;
  const { row } = await searchParams;
  return <PublishedPage token={token} rowId={row} />;
}
