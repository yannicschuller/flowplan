import { PublishedPage } from "@/components/public-page";
import { PublicLegalFooter } from "@/components/legal-footer-server";
import { publicationMetadata, requestCustomHost } from "@/lib/publication-meta";
export const dynamic = "force-dynamic";
export async function generateMetadata({ params }: { params: Promise<{ token: string; pageId: string }> }) {
  const { token, pageId } = await params;
  return publicationMetadata(token, pageId);
}
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ token: string; pageId: string }>;
  searchParams: Promise<{ row?: string; view?: string; month?: string }>;
}) {
  const { token, pageId } = await params;
  const { row, view, month } = await searchParams;
  return (
    <>
      <PublishedPage
        token={token}
        customHost={await requestCustomHost(token)}
        pageId={pageId}
        rowId={row}
        viewId={view}
        month={month}
      />
      <PublicLegalFooter />
    </>
  );
}
