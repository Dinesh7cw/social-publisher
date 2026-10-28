import type { Metadata } from "next";

import { requirePageUser } from "@/server/auth/guards";
import { CalendarView } from "./calendar-view";

export const metadata: Metadata = { title: "Content calendar" };
export const dynamic = "force-dynamic";

export default async function CalendarPage() {
  const session = await requirePageUser();

  return <CalendarView timeZone={session.user.timeZone} />;
}
