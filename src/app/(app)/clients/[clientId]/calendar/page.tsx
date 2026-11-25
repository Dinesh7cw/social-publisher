import type { Metadata } from "next";

import { requirePageUser } from "@/server/auth/guards";
import { CalendarView } from "../../../calendar/calendar-view";

export const metadata: Metadata = { title: "Content calendar" };
export const dynamic = "force-dynamic";

export default async function ClientCalendarPage({
  params,
}: {
  params: Promise<{ clientId: string }>;
}) {
  const session = await requirePageUser();
  const { clientId } = await params;

  return (
    <CalendarView
      timeZone={session.user.timeZone}
      clientId={clientId}
      composeHref={`/clients/${clientId}/compose`}
      title="Calendar"
    />
  );
}
