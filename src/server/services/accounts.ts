/**
 * Account listing shared by the agency-wide accounts screen and the
 * client-scoped one.
 *
 * Keeping the token-state wording here means the same account reads identically
 * wherever it appears, which matters when someone is looking at an expiring
 * token from inside a client's project rather than the global list.
 */

import { PLATFORM_LABELS, PLATFORM_SHORT, type PlatformId } from "@/lib/domain";
import { prisma } from "@/server/db";
import { allPlatformStatuses } from "@/server/platforms/registry";

export interface AccountRow {
  id: string;
  clientName: string;
  platform: PlatformId;
  displayName: string;
  accountType: string;
  status: string;
  tokenLabel: string;
  tokenTone: "positive" | "warning" | "negative" | "neutral";
  lastVerifiedAt: string | null;
  postCount: number;
}

export interface PlatformAvailability {
  platform: PlatformId;
  available: boolean;
  reason: string;
  message: string | null;
  label: string;
  short: string;
}

export function tokenState(tokenExpiresAt: Date | null): {
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

/** Accounts as the table expects them, optionally narrowed to one client. */
export async function listAccountRows(clientId?: string): Promise<AccountRow[]> {
  const accounts = await prisma.socialAccount.findMany({
    where: clientId ? { clientId } : {},
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

  return accounts.map((account) => {
    const token = tokenState(account.tokenExpiresAt);
    return {
      id: account.id,
      clientName: account.client.name,
      platform: account.platform as PlatformId,
      displayName: account.displayName,
      accountType: account.accountType,
      status: account.status,
      tokenLabel: account.status === "CONNECTED" ? token.label : "Needs reconnecting",
      tokenTone: account.status === "CONNECTED" ? token.tone : ("negative" as const),
      lastVerifiedAt: account.lastVerifiedAt?.toISOString() ?? null,
      postCount: account._count.targets,
    };
  });
}

export async function platformAvailability(): Promise<PlatformAvailability[]> {
  const statuses = await allPlatformStatuses();
  return statuses.map((status) => ({
    ...status,
    label: PLATFORM_LABELS[status.platform],
    short: PLATFORM_SHORT[status.platform],
  }));
}
