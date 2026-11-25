import type { Metadata } from "next";
import Link from "next/link";

import { requirePageUser } from "@/server/auth/guards";
import { listAccountRows, platformAvailability } from "@/server/services/accounts";
import { AccountsTable } from "../../../accounts/accounts-table";
import { ConnectAccounts } from "../../../accounts/connect-accounts";

export const metadata: Metadata = { title: "Client accounts" };
export const dynamic = "force-dynamic";

export default async function ClientAccountsPage({
  params,
  searchParams,
}: {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<{ connect_session?: string; connect_error?: string }>;
}) {
  const session = await requirePageUser();
  const { clientId } = await params;
  const { connect_session: connectSessionId, connect_error: connectError } = await searchParams;

  const rows = await listAccountRows(clientId);
  const platforms = await platformAvailability();

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Accounts</h1>
          <p className="page-sub">
            {rows.length === 0
              ? "No platform account is connected for this client yet."
              : `${rows.length} account${rows.length === 1 ? "" : "s"} this client can publish to.`}
          </p>
        </div>
        <div className="page-actions">
          <Link href="/accounts" className="btn btn-secondary btn-sm">
            Agency-wide view
          </Link>
        </div>
      </div>

      <ConnectAccounts
        platforms={platforms}
        // On a client page the target is decided already, so no picker dropdown.
        clients={[]}
        fixedClientId={clientId}
        connectSessionId={connectSessionId}
        connectError={connectError}
        returnTo={`/clients/${clientId}/accounts`}
      />

      <AccountsTable
        rows={rows}
        platforms={platforms}
        canDisconnect={session.user.role === "ADMIN"}
        credentialsHref={`/clients/${clientId}/credentials`}
      />
    </>
  );
}
