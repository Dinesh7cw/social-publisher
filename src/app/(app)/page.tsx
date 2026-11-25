import type { Metadata } from "next";
import Link from "next/link";

import { requirePageUser } from "@/server/auth/guards";
import { getDashboardData } from "@/server/services/dashboard";
import { PLATFORM_SHORT } from "@/lib/domain";

export const metadata: Metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  const minutes = Math.round(diff / 60000);

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export default async function DashboardPage() {
  await requirePageUser();
  const data = await getDashboardData();
  const { counts } = data;

  const attention = data.recentActivity.filter((item) => item.kind === "FAILED");
  const nothingConnected = counts.accounts === 0;

  // The screen's one finding, stated plainly under the title.
  const finding =
    attention.length > 0
      ? `${attention.length} ${attention.length === 1 ? "post needs" : "posts need"} attention before it can go out.`
      : nothingConnected
        ? "No social accounts are connected yet, so nothing can publish."
        : counts.scheduled > 0
          ? `${counts.scheduled} ${counts.scheduled === 1 ? "post is" : "posts are"} scheduled and waiting.`
          : "Everything is clear. Nothing is waiting on you.";

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Dashboard</h1>
          <p className="page-sub">{finding}</p>
        </div>
        <div className="page-actions">
          <Link href="/compose" className="btn btn-primary">
            Create post
          </Link>
        </div>
      </div>

      {/* One container split by hairlines — not six cards. */}
      <section className="panel kpi-strip" aria-label="Publishing totals">
        <div className="kpi">
          <span className="kpi-label">Clients</span>
          <span className="kpi-value num">{counts.clients}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Connected accounts</span>
          <span className="kpi-value num">{counts.accounts}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Drafts</span>
          <span className="kpi-value num">{counts.drafts}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Scheduled</span>
          <span className="kpi-value num">{counts.scheduled}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Published</span>
          <span className="kpi-value num">{counts.published}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Failed</span>
          <span className="kpi-value num" data-tone={counts.failed > 0 ? "negative" : undefined}>
            {counts.failed}
          </span>
        </div>
      </section>

      <div className="dash-grid">
        <div className="dash-main">
          <section className="panel" aria-labelledby="activity-title">
            <div className="panel-head">
              <h2 className="panel-title" id="activity-title">
                Recent publishing activity
              </h2>
              <Link href="/history" className="btn btn-ghost btn-sm">
                View all
              </Link>
            </div>

            {data.recentActivity.length === 0 ? (
              <div className="panel-body">
                <div className="empty-state">
                  <p className="empty-title">Nothing has been published yet</p>
                  <p className="small">
                    Activity appears here once a post is scheduled or published.
                  </p>
                  <Link href="/compose" className="btn btn-secondary btn-sm">
                    Create the first post
                  </Link>
                </div>
              </div>
            ) : (
              <ul className="activity-list">
                {data.recentActivity.map((item) => (
                  <li key={item.id} className="activity-row">
                    <div className="activity-main">
                      <span className="activity-client">{item.clientName}</span>
                      <span className="activity-detail">{item.detail}</span>
                    </div>
                    <div className="activity-meta">
                      <span className="activity-platform">
                        {PLATFORM_SHORT[item.platform]} · {item.accountName}
                      </span>
                      <span className="activity-time">{formatRelative(item.at)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <aside className="dash-rail">
          <h2 className="rail-title">Accounts by platform</h2>
          <section className="panel">
            <ul className="platform-list">
              {data.accountsByPlatform.map((row) => (
                <li key={row.platform} className="platform-row">
                  <span className="platform-name">{PLATFORM_SHORT[row.platform]}</span>
                  <span className="platform-figures num">
                    {row.connected}
                    {row.needsAttention > 0 ? (
                      <span className="platform-attention">
                        {" "}
                        · {row.needsAttention} to fix
                      </span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <h2 className="rail-title">Next step</h2>
          <section className="panel panel-body next-step">
            {nothingConnected ? (
              <>
                <p className="next-step-text">
                  Connect a Facebook Page, Instagram account, LinkedIn page or X account to start
                  publishing.
                </p>
                <Link href="/accounts" className="btn btn-secondary btn-sm">
                  Connect an account
                </Link>
              </>
            ) : (
              <>
                <p className="next-step-text">
                  {counts.drafts > 0
                    ? `${counts.drafts} ${counts.drafts === 1 ? "draft is" : "drafts are"} waiting to be finished.`
                    : "Open a client project, then write the content each platform needs."}
                </p>
                <Link href={counts.drafts > 0 ? "/calendar" : "/compose"} className="btn btn-secondary btn-sm">
                  {counts.drafts > 0 ? "Open calendar" : "Create a post"}
                </Link>
              </>
            )}
          </section>
        </aside>
      </div>
    </>
  );
}
