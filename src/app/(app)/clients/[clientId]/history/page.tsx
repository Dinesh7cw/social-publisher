import type { Metadata } from "next";

import { requirePageUser } from "@/server/auth/guards";
import { HistoryTable } from "../../../history/history-table";

export const metadata: Metadata = { title: "Publishing history" };
export const dynamic = "force-dynamic";

export default async function ClientHistoryPage({
  params,
}: {
  params: Promise<{ clientId: string }>;
}) {
  await requirePageUser();
  const { clientId } = await params;

  return <HistoryTable clientId={clientId} />;
}
