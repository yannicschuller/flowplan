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
  searchParams: Promise<{ row?: string; view?: string; month?: string; cards?: string }>;
}) {
  const { token } = await params;
  const query = await searchParams;
  const { row, view, month, cards } = query;
  return (
    <>
      <PublishedPage token={token} customHost={await requestCustomHost(token)} rowId={row} viewId={view} month={month} cards={cards} query={query} />
      <PublicLegalFooter />
    </>
  );
}
