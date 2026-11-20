import { notFound } from "next/navigation";
import { z } from "zod";
import { PageHeader } from "@/components/ui/page-header";
import { CheckInCodePanel } from "@/features/checkin/checkin-code-panel";

export const metadata = { title: "Check-in code" };

/**
 * Attendee check-in code for one ticket (XRPL-044/045). Interim standalone page until the
 * ticket detail page (XRPL-034, Agent C) embeds <CheckInCodePanel />.
 */
export default async function CheckInCodePage({ params }: { params: Promise<{ ticketId: string }> }) {
  const parsed = z.uuid().safeParse((await params).ticketId);
  if (!parsed.success) notFound();
  return (
    <div className="mx-auto max-w-md">
      <PageHeader title="Check in" description="Get a code for the door. It works once and only for this event." />
      <CheckInCodePanel ticketId={parsed.data} />
    </div>
  );
}
