import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { z } from "zod";

import { PageHeader } from "@/components/ui/page-header";
import { SellerMerchSection } from "@/features/commerce/seller-merch-section";
import { getSellerProfile, ProfileNotFoundError } from "@/features/profiles/profile-store";
import { getDb } from "@/lib/db/client";

export const metadata = { title: "Merchandise" };

/** A seller's physical merchandise on its own page (XRPL-066), linked from product pages. */
export default async function SellerMerchPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) notFound();

  let displayName: string;
  try {
    displayName = (await getSellerProfile(getDb(), id.data)).displayName;
  } catch (error) {
    if (error instanceof ProfileNotFoundError) notFound();
    throw error;
  }

  return (
    <>
      <PageHeader
        title={`Merchandise from ${displayName}`}
        actions={
          <>
            <Link
              href={`/sellers/${id.data}`}
              className="rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-surface"
            >
              Seller profile
            </Link>
            <Link
              href="/cart"
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:opacity-90"
            >
              View cart
            </Link>
          </>
        }
      />
      <SellerMerchSection sellerId={id.data} />
    </>
  );
}
