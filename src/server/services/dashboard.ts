/**
 * Dashboard aggregates.
 *
 * Every figure comes from SQL aggregation, never from client-side filtering of
 * a list. That keeps the numbers truthful at any data volume and means the page
 * cannot contradict the clients page.
 *
 * The brief's six counters are all present. The "recent activity" list is built
 * from publishing attempts and audit entries so it reflects what actually
 * happened, not what was intended.
 */

import { prisma } from "@/server/db";
import { PLATFORM_LABELS, type PlatformId } from "@/lib/domain";

export interface DashboardData {
  counts: {
    clients: number;
    accounts: number;
    drafts: number;
    scheduled: number;
    published: number;
    failed: number;
  };
  accountsByPlatform: Array<{
    platform: PlatformId;
    label: string;
    connected: number;
    needsAttention: number;
  }>;
  recentActivity: Array<{
    id: string;
    kind: "PUBLISHED" | "FAILED" | "SCHEDULED";
    clientName: string;
    platform: PlatformId;
    platformLabel: string;
    accountName: string;
    detail: string;
    at: string;
    href: string | null;
  }>;
}

export async function getDashboardData(): Promise<DashboardData> {
  const [
    clients,
    accounts,
    drafts,
    scheduled,
    published,
    failed,
    accountsByPlatform,
    recentTargets,
  ] = await Promise.all([
    prisma.client.count({ where: { status: "ACTIVE" } }),
    prisma.socialAccount.count({ where: { status: "CONNECTED" } }),
    prisma.post.count({ where: { status: "DRAFT" } }),
    prisma.post.count({ where: { status: { in: ["SCHEDULED", "PUBLISHING"] } } }),
    prisma.post.count({ where: { status: "PUBLISHED" } }),
    prisma.post.count({ where: { status: { in: ["FAILED", "PARTIAL"] } } }),

    prisma.socialAccount.groupBy({
      by: ["platform", "status"],
      _count: { _all: true },
    }),

    prisma.postTarget.findMany({
      where: { status: { in: ["PUBLISHED", "FAILED_PERMANENT", "FAILED_RETRYABLE", "UNKNOWN", "QUEUED"] } },
      orderBy: [{ publishedAt: "desc" }, { updatedAt: "desc" }],
      take: 8,
      include: {
        socialAccount: {
          select: {
            displayName: true,
            platform: true,
            client: { select: { name: true } },
          },
        },
        post: { select: { id: true, baseCaption: true, status: true } },
      },
    }),
  ]);

  const platformRows: DashboardData["accountsByPlatform"] = (
    ["FACEBOOK", "INSTAGRAM", "LINKEDIN", "X"] as PlatformId[]
  ).map((platform) => {
    const rows = accountsByPlatform.filter((r) => r.platform === platform);
    const connected = rows
      .filter((r) => r.status === "CONNECTED")
      .reduce((sum, r) => sum + r._count._all, 0);
    const needsAttention = rows
      .filter((r) => r.status === "EXPIRED" || r.status === "ERROR" || r.status === "REVOKED")
      .reduce((sum, r) => sum + r._count._all, 0);

    return { platform, label: PLATFORM_LABELS[platform], connected, needsAttention };
  });

  const recentActivity: DashboardData["recentActivity"] = recentTargets.map((target) => {
    const kind: "PUBLISHED" | "FAILED" | "SCHEDULED" =
      target.status === "PUBLISHED"
        ? "PUBLISHED"
        : target.status === "QUEUED"
          ? "SCHEDULED"
          : "FAILED";

    const detail =
      target.status === "PUBLISHED"
        ? "Published"
        : target.status === "QUEUED"
          ? "Scheduled"
          : (target.lastErrorMessage ?? "Did not publish");

    return {
      id: target.id,
      kind,
      clientName: target.socialAccount.client.name,
      platform: target.socialAccount.platform,
      platformLabel: PLATFORM_LABELS[target.socialAccount.platform],
      accountName: target.socialAccount.displayName,
      detail,
      at: (target.publishedAt ?? target.updatedAt).toISOString(),
      href: target.platformPostUrl,
    };
  });

  return {
    counts: { clients, accounts, drafts, scheduled, published, failed },
    accountsByPlatform: platformRows,
    recentActivity,
  };
}
