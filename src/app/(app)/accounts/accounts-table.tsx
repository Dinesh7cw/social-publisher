"use client";

import { useState } from "react";
import Link from "next/link";

import { PLATFORM_SHORT } from "@/lib/domain";
import type { AccountRow, PlatformAvailability } from "@/server/services/accounts";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

export type { AccountRow, PlatformAvailability };

const ACCOUNT_TYPE_LABEL: Record<string, string> = {
  PAGE: "Facebook Page",
  IG_PROFESSIONAL: "Instagram professional",
  MEMBER: "LinkedIn profile",
  ORGANIZATION: "LinkedIn page",
  X_ACCOUNT: "X account",
};

export function AccountsTable({
  rows,
  platforms,
  canDisconnect,
  credentialsHref,
}: {
  rows: AccountRow[];
  platforms: PlatformAvailability[];
  canDisconnect: boolean;
  /** Where to send someone to add app credentials, when that page is in reach. */
  credentialsHref?: string;
}) {
  const [disconnecting, setDisconnecting] = useState<AccountRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [localRows, setLocalRows] = useState(rows);

  const unavailable = platforms.filter((p) => !p.available);

  async function onDisconnect(row: AccountRow) {
    setPending(true);
    setError(null);

    const response = await fetch(`/api/accounts/${row.id}/disconnect`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: window.location.origin },
      body: JSON.stringify({}),
    });

    setPending(false);

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as
        | { error?: { message?: string } }
        | null;
      setError(body?.error?.message ?? "Could not disconnect this account.");
      setDisconnecting(null);
      return;
    }

    setLocalRows((current) => current.filter((r) => r.id !== row.id));
    setDisconnecting(null);
  }

  return (
    <>
      {/* Honest, not hidden: explaining which platforms cannot connect yet is
          more useful than an empty state that pretends everything is possible. */}
      {unavailable.length > 0 ? (
        <section className="panel" style={{ marginBottom: 24 }} aria-labelledby="setup-needed">
          <div className="panel-head">
            <h2 className="panel-title" id="setup-needed">
              Not available yet
            </h2>
          </div>
          <div className="panel-body">
            <ul style={{ margin: 0, paddingLeft: 0, listStyle: "none", display: "grid", gap: 10 }}>
              {unavailable.map((platform) => (
                <li
                  key={platform.platform}
                  style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}
                >
                  <span className="pill pill-neutral">{platform.short}</span>
                  <span className="small muted">
                    {platform.message ?? "Unavailable"}
                    {platform.reason === "not_configured" ? (
                      <>
                        . {credentialsHref ? (
                          <Link href={credentialsHref}>Add the app credentials</Link>
                        ) : (
                          "The platform app credentials have not been added to this deployment"
                        )}
                        .
                      </>
                    ) : (
                      "."
                    )}
                  </span>
                </li>
              ))}
            </ul>
            <p className="small faint" style={{ marginTop: 12 }}>
              Setup for each platform is documented in <code>docs/PLATFORM-ACCESS.md</code>. A
              platform cannot publish until its credentials and approval are in place.
            </p>
          </div>
        </section>
      ) : null}

      {error ? (
        <div className="form-banner form-banner-error" role="alert" style={{ marginBottom: 16 }}>
          {error}
        </div>
      ) : null}

      {localRows.length === 0 ? (
        <div className="empty-state">
          <p className="empty-title">No accounts connected</p>
          <p className="small">
            Once a platform is configured, you can connect its accounts here and attach each one to a
            client.
          </p>
        </div>
      ) : (
        <div className="table-card">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Account</th>
                  <th scope="col">Client</th>
                  <th scope="col">Platform</th>
                  <th scope="col">Status</th>
                  <th scope="col">Token</th>
                  <th scope="col" className="num">
                    Posts
                  </th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {localRows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <div className="cell-stack">
                        <span className="cell-primary">{row.displayName}</span>
                        <span className="cell-sub">
                          {ACCOUNT_TYPE_LABEL[row.accountType] ?? row.accountType}
                        </span>
                      </div>
                    </td>
                    <td>{row.clientName}</td>
                    <td>{PLATFORM_SHORT[row.platform]}</td>
                    <td>
                      <span
                        className={`pill ${
                          row.status === "CONNECTED"
                            ? "pill-positive"
                            : row.status === "EXPIRED"
                              ? "pill-warning"
                              : "pill-negative"
                        }`}
                      >
                        {row.status === "CONNECTED"
                          ? "Connected"
                          : row.status === "EXPIRED"
                            ? "Needs reconnecting"
                            : row.status === "REVOKED"
                              ? "Disconnected"
                              : "Error"}
                      </span>
                    </td>
                    <td>
                      <span className={`pill pill-${row.tokenTone === "negative" ? "negative" : row.tokenTone === "warning" ? "warning" : "neutral"}`}>
                        {row.tokenLabel}
                      </span>
                    </td>
                    <td className="num">{row.postCount}</td>
                    <td>
                      {canDisconnect ? (
                        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => setDisconnecting(row)}
                          >
                            Disconnect
                          </button>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {disconnecting ? (
        <ConfirmDialog
          title={`Disconnect ${disconnecting.displayName}?`}
          body={`CW will stop being able to publish to this ${PLATFORM_SHORT[disconnecting.platform]} account. Existing published posts stay where they are. You can connect it again with the client's permission.`}
          confirmLabel="Disconnect account"
          destructive
          pending={pending}
          onCancel={() => setDisconnecting(null)}
          onConfirm={() => void onDisconnect(disconnecting)}
        />
      ) : null}
    </>
  );
}
