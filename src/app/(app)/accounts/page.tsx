import type { Metadata } from "next";

import { requirePageUser } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { allPlatformStatuses } from "@/server/platforms/registry";
import { PLATFORM_LABELS, PLATFORM_SHORT, type PlatformId } from "@/lib/domain";
import { AccountsTable, type AccountRow } from "./accounts-table";

export const metadata: Metadata = { title: "Social accounts" };
export const dynamic = "force-dynamic";

function tokenState(tokenExpiresAt: Date | null): {
  label: string;
  tone: "positive" | "warning" | "negative" | "neutral";
} {
  if (!tokenExpiresAt) return { label: "Does not expire", tone: "neutral" };

  const remainingMs = tokenExpiresAt.getTime() - Date.now();
  if (remainingMs <= 0) return { label: "Expired", tone: "negative" };

  const days = Math.floor(remainingMs / 86_400_000);
  if (days <= 0) {
    const hours = Math.max(1, Math.floor(remainingMs / 3_600_000));
    return { label: `Expires in ${hours} hr`, tone: "warning" };
  }
  if (days <= 7) return { label: `Expires in ${days} day${days === 1 ? "" : "s"}`, tone: "warning" };
  return { label: `Expires in ${days} days`, tone: "positive" };
}

export default async function AccountsPage() {
  const session = await requirePageUser();

  const accounts = await prisma.socialAccount.findMany({
    orderBy: [{ platform: "asc" }, { displayName: "asc" }],
    select: {
      id: true,
      platform: true,
      displayName: true,
      accountType: true,
      status: true,
      tokenExpiresAt: true,
      lastVerifiedAt: true,
      client: { select: { name: true } },
      _count: { select: { targets: true } },
    },
  });

  const rows: AccountRow[] = accounts.map((account) => {
    const token = tokenState(account.tokenExpiresAt);
    return {
      id: account.id,
      clientName: account.client.name,
      platform: account.platform as PlatformId,
      displayName: account.displayName,
      accountType: account.accountType,
      status: account.status,
      tokenLabel: account.status === "CONNECTED" ? token.label : "Needs reconnecting",
      tokenTone:
        account.status === "CONNECTED"
          ? token.tone
          : ("negative" as const),
      lastVerifiedAt: account.lastVerifiedAt?.toISOString() ?? null,
      postCount: account._count.targets,
    };
  });

  const platforms = allPlatformStatuses().map((status) => ({
    ...status,
    label: PLATFORM_LABELS[status.platform],
    short: PLATFORM_SHORT[status.platform],
  }));

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

      <AccountsTable
        rows={rows}
        platforms={platforms}
        canDisconnect={session.user.role === "ADMIN"}
      />
    </>
  );
}
