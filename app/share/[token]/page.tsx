import { PublishedPage } from "@/components/public-page";
import { PublicLegalFooter } from "@/components/legal-footer-server";
import { publicationMetadata, requestCustomHost } from "@/lib/publication-meta";
export const dynamic = "force-dynamic";
export async function generateMetadata({ params }: { params: Promise<{ token: string }> }) {
  return publicationMetadata((await params).token);
}
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ row?: string; view?: string; month?: string }>;
}) {
  const { token } = await params;
  const { row, view, month } = await searchParams;
  return (
    <>
      <PublishedPage token={token} customHost={await requestCustomHost(token)} rowId={row} viewId={view} month={month} />
      <PublicLegalFooter />
    </>
  );
}
