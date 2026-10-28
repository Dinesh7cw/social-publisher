import type { Metadata } from "next";

import { requirePageUser } from "@/server/auth/guards";
import { HistoryTable } from "./history-table";

export const metadata: Metadata = { title: "Publishing history" };
export const dynamic = "force-dynamic";

export default async function HistoryPage() {
  await requirePageUser();

  return <HistoryTable />;
}
