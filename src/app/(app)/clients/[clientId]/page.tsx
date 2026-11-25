import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { requirePageUser } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { listAccountRows } from "@/server/services/accounts";
import { DeletePostButton } from "@/components/ui/delete-post-button";
import { PLATFORM_SHORT, POST_STATUS_LABEL, postStatusTone, type PostStatusId } from "@/lib/domain";

export const metadata: Metadata = { title: "Client overview" };
export const dynamic = "force-dynamic";

function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default async function ClientOverviewPage({
  params,
}: {
  params: Promise<{ clientId: string }>;
}) {
  await requirePageUser();
  const { clientId } = await params;

  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { id: true, name: true, notes: true },
  });

  if (!client) notFound();

  const [posts, accounts, countsByStatus] = await Promise.all([
    prisma.post.findMany({
      where: { clientId, deletedAt: null },
      orderBy: [{ updatedAt: "desc" }],
      take: 6,
      select: {
        id: true,
        status: true,
        baseCaption: true,
        scheduledAt: true,
        publishedAt: true,
        createdAt: true,
        targets: {
          select: {
            status: true,
            socialAccount: { select: { platform: true, displayName: true } },
          },
        },
      },
    }),
    listAccountRows(clientId),
    prisma.post.groupBy({
      by: ["status"],
      where: { clientId, deletedAt: null },
      _count: { _all: true },
    }),
  ]);

  const counts = new Map(countsByStatus.map((row) => [row.status, row._count._all]));
  const draftCount = counts.get("DRAFT") ?? 0;
  const scheduledCount =
    (counts.get("SCHEDULED") ?? 0) + (counts.get("PUBLISHING") ?? 0);
  const publishedCount = counts.get("PUBLISHED") ?? 0;
  const failedCount = (counts.get("FAILED") ?? 0) + (counts.get("PARTIAL") ?? 0);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Overview</h1>
          <p className="page-sub">
            Everything below belongs to {client.name} only. Posts created here cannot be pointed at
            another client.
          </p>
        </div>
        <div className="page-actions">
          <Link href={`/clients/${client.id}/compose`} className="btn btn-primary">
            Create post
          </Link>
        </div>
      </div>

      {accounts.length === 0 ? (
        <div className="form-banner form-banner-error" role="status" style={{ marginBottom: 16 }}>
          No social account is connected for {client.name}, so nothing can publish yet.{" "}
          <Link href={`/clients/${client.id}/accounts`}>Connect an account</Link>.
        </div>
      ) : null}

      <section className="panel kpi-strip" data-kpis="5" aria-label="Post totals for this client">
        <div className="kpi">
          <span className="kpi-label">Accounts</span>
          <span className="kpi-value num">{accounts.length}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Drafts</span>
          <span className="kpi-value num">{draftCount}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Scheduled</span>
          <span className="kpi-value num">{scheduledCount}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Published</span>
          <span className="kpi-value num">{publishedCount}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Needs attention</span>
          <span className="kpi-value num" data-tone={failedCount > 0 ? "negative" : undefined}>
            {failedCount}
          </span>
        </div>
      </section>

      <div className="dash-grid">
        <div className="dash-main">
          <section className="panel" aria-labelledby="recent-title">
            <div className="panel-head">
              <h2 className="panel-title" id="recent-title">
                Recent posts
              </h2>
              <Link href={`/clients/${client.id}/calendar`} className="btn btn-ghost btn-sm">
                Open calendar
              </Link>
            </div>

            {posts.length === 0 ? (
              <div className="panel-body">
                <div className="empty-state">
                  <p className="empty-title">Nothing written for {client.name} yet</p>
                  <p className="small">
                    The first post will appear here with its per-platform outcome.
                  </p>
                  <Link href={`/clients/${client.id}/compose`} className="btn btn-secondary btn-sm">
                    Write the first post
                  </Link>
                </div>
              </div>
            ) : (
              <ul className="activity-list">
                {posts.map((post) => {
                  const when = post.publishedAt ?? post.scheduledAt ?? post.createdAt;
                  return (
                    <li key={post.id} className="activity-row">
                      <div className="activity-main">
                        <span className="activity-client">
                          {post.baseCaption.trim().slice(0, 96) || "No content yet"}
                        </span>
                        <span className="activity-detail">
                          {[...new Set(post.targets.map((t) => PLATFORM_SHORT[t.socialAccount.platform]))].join(
                            " · ",
                          ) || "No targets"}
                        </span>
                      </div>
                      <div className="activity-meta">
                        <span className={`pill pill-${postStatusTone(post.status as PostStatusId)}`}>
                          {POST_STATUS_LABEL[post.status as PostStatusId]}
                        </span>
                        <span className="activity-time">{formatWhen(when.toISOString())}</span>
                        {post.status === "DRAFT" ? (
                          <Link
                            href={`/clients/${client.id}/compose?post=${post.id}`}
                            className="btn btn-secondary btn-sm"
                          >
                            Edit
                          </Link>
                        ) : null}
                        <DeletePostButton
                          postId={post.id}
                          publishedPlatforms={[
                            ...new Set(
                              post.targets
                                .filter((target) => target.status === "PUBLISHED")
                                .map((target) => PLATFORM_SHORT[target.socialAccount.platform]),
                            ),
                          ]}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>

        <aside className="dash-rail">
          <h2 className="rail-title">Connected accounts</h2>
          <section className="panel">
            {accounts.length === 0 ? (
              <div className="panel-body">
                <p className="small muted">No accounts connected for this client.</p>
                <Link
                  href={`/clients/${client.id}/accounts`}
                  className="btn btn-secondary btn-sm"
                  style={{ marginTop: 10 }}
                >
                  Connect an account
                </Link>
              </div>
            ) : (
              <ul className="platform-list">
                {accounts.map((account) => (
                  <li key={account.id} className="platform-row">
                    <span className="platform-name">
                      {account.displayName}
                      <span className="small faint"> · {PLATFORM_SHORT[account.platform]}</span>
                    </span>
                    <span className="platform-figures">
                      <span
                        className={`pill ${
                          account.status === "CONNECTED" ? "pill-positive" : "pill-warning"
                        }`}
                      >
                        {account.status === "CONNECTED" ? "Connected" : "Needs reconnecting"}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {client.notes ? (
            <>
              <h2 className="rail-title">Internal notes</h2>
              <section className="panel panel-body">
                <p className="small muted" style={{ whiteSpace: "pre-wrap" }}>
                  {client.notes}
                </p>
              </section>
            </>
          ) : null}
        </aside>
      </div>
    </>
  );
}
