import type { Metadata } from "next";
import Link from "next/link";

import { requirePageUser } from "@/server/auth/guards";
import { listClients } from "@/server/services/clients";
import { PLATFORM_SHORT } from "@/lib/domain";
import "./compose-picker.css";

export const metadata: Metadata = { title: "Choose a client" };
export const dynamic = "force-dynamic";

/**
 * Entry point when no project is open.
 *
 * Deliberately not a client dropdown inside the composer: choosing a client is
 * choosing whose account you are about to post from, so it happens once, on its
 * own screen, and the composer that follows cannot be pointed at anyone else.
 *
 * This screen is a chooser and must look like one. When it was titled "Create
 * post" and laid out as a table, the team reasonably expected to find the photo
 * picker and caption box on it — so it now says what it is, and each client is a
 * card that opens the actual editor.
 */
export default async function ComposePickerPage() {
  await requirePageUser();

  const { items } = await listClients({ status: "ACTIVE", limit: 100 });

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Who are you posting for?</h1>
          <p className="page-sub">
            Pick a client to open the editor. Photos, captions and hashtags all live in the next
            screen, and each platform there gets its own content.
          </p>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="empty-state">
          <p className="empty-title">No active clients</p>
          <p className="small">Add a client first, because posts always belong to one.</p>
          <Link href="/clients" className="btn btn-secondary btn-sm">
            Go to clients
          </Link>
        </div>
      ) : (
        <ul className="picker-grid">
          {items.map((client) => (
            <li key={client.id} className="picker-card">
              <div className="picker-card-head">
                <h2 className="picker-card-name">{client.name}</h2>
                {client.contactName ? (
                  <span className="small faint">{client.contactName}</span>
                ) : null}
              </div>

              <dl className="picker-stats">
                <div>
                  <dt>Accounts</dt>
                  <dd className="num">{client.counts.accounts}</dd>
                </div>
                <div>
                  <dt>Drafts</dt>
                  <dd className="num">{client.counts.drafts}</dd>
                </div>
                <div>
                  <dt>Scheduled</dt>
                  <dd className="num">{client.counts.scheduled}</dd>
                </div>
              </dl>

              <div className="picker-actions">
                <Link href={`/clients/${client.id}/compose`} className="btn btn-primary btn-sm">
                  Write a post
                </Link>
                <Link href={`/clients/${client.id}`} className="btn btn-ghost btn-sm">
                  Open project
                </Link>
              </div>

              {client.counts.accounts === 0 ? (
                <p className="picker-warning">
                  No account connected yet, so nothing can publish.{" "}
                  <Link href={`/clients/${client.id}/accounts`}>Connect one</Link>.
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <p className="small faint picker-footnote">
        Platforms in this build:{" "}
        {(["FACEBOOK", "INSTAGRAM", "LINKEDIN", "X"] as const).map((p) => PLATFORM_SHORT[p]).join(", ")}
        . A platform becomes postable once its account is connected for that client.
      </p>
    </>
  );
}
