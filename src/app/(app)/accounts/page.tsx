import type { Metadata } from "next";

import { requirePageUser } from "@/server/auth/guards";
import { listAccountRows, platformAvailability } from "@/server/services/accounts";
import { prisma } from "@/server/db";
import { AccountsTable } from "./accounts-table";
import { ConnectAccounts } from "./connect-accounts";

export const metadata: Metadata = { title: "Social accounts" };
export const dynamic = "force-dynamic";

export default async function AccountsPage({
  searchParams,
}: {
  searchParams: Promise<{ connect_session?: string; connect_error?: string; platform?: string }>;
}) {
  const session = await requirePageUser();
  const { connect_session: connectSessionId, connect_error: connectError } = await searchParams;

  const rows = await listAccountRows();
  const platforms = await platformAvailability();
  const clients = await prisma.client.findMany({
    where: { status: "ACTIVE" },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Social accounts</h1>
          <p className="page-sub">
            {rows.length === 0
              ? "No accounts are connected yet."
              : `${rows.length} connected account${rows.length === 1 ? "" : "s"} across ${new Set(rows.map((r) => r.clientName)).size} client${new Set(rows.map((r) => r.clientName)).size === 1 ? "" : "s"}.`}
          </p>
        </div>
      </div>

      <ConnectAccounts
        platforms={platforms}
        clients={clients}
        connectSessionId={connectSessionId}
        connectError={connectError}
      />

      <AccountsTable
        rows={rows}
        platforms={platforms}
        canDisconnect={session.user.role === "ADMIN"}
      />
    </>
  );
}
