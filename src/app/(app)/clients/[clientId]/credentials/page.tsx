import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { requirePageUser } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { listAccountRows } from "@/server/services/accounts";
import { allCredentialStatuses } from "@/server/services/platform-credentials";
import { PLATFORMS } from "@/lib/domain";
import { CredentialsForm, type CredentialView } from "./credentials-form";
import "./credentials.css";

export const metadata: Metadata = { title: "Credentials" };
export const dynamic = "force-dynamic";

/**
 * Where the app for each network is set up.
 *
 * The values themselves are agency-wide — one Meta app authorises every client's
 * Pages — so this page says so plainly instead of implying a per-client app.
 * What is per client is the result: the accounts of this client that each app
 * currently allows publishing to, shown at the bottom of every panel.
 */
export default async function ClientCredentialsPage({
  params,
}: {
  params: Promise<{ clientId: string }>;
}) {
  const session = await requirePageUser();
  const { clientId } = await params;

  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { id: true, name: true },
  });

  if (!client) notFound();

  const [statuses, accounts] = await Promise.all([
    allCredentialStatuses(),
    listAccountRows(clientId),
  ]);

  const platforms: CredentialView[] = PLATFORMS.map((platform) => {
    const status = statuses.find((item) => item.platform === platform)!;

    return {
      platform,
      configured: status.configured,
      source: status.source,
      appIdHint: status.appIdHint,
      unreadable: status.unreadable,
      sharedWith: status.sharedWith,
      updatedAt: status.updatedAt,
      updatedByName: status.updatedByName,
      fields: {
        appLabel: status.fields.appLabel,
        appHint: status.fields.appHint,
        secretLabel: status.fields.secretLabel,
        secretHint: status.fields.secretHint,
        consoleUrl: status.fields.consoleUrl,
        scopes: status.fields.scopes,
        redirectHint: status.fields.redirectHint,
      },
      redirectUri: status.redirectUri,
      connected: accounts
        .filter((account) => account.platform === platform)
        .map((account) => ({ displayName: account.displayName, status: account.status })),
    };
  });

  const ready = platforms.filter((item) => item.configured).length;

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Credentials</h1>
          <p className="page-sub">
            {ready === 0
              ? `No platform app is set up yet, so no account can be connected for ${client.name}.`
              : `${ready} of ${PLATFORMS.length} platform apps are ready, and ${accounts.length} account${
                  accounts.length === 1 ? "" : "s"
                } ${accounts.length === 1 ? "is" : "are"} connected for ${client.name}.`}
          </p>
        </div>
      </div>

      <p className="form-banner cred-note" style={{ marginBottom: 16 }}>
        These are app-level credentials and they cover every client on this deployment, because one
        registered app holds the redirect URI and the approved permissions. Connecting a specific
        client&apos;s account still happens from <strong>Accounts</strong>.
      </p>

      <CredentialsForm platforms={platforms} canEdit={session.user.role === "ADMIN"} />
    </>
  );
}
