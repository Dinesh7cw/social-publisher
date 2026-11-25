"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { PLATFORM_SHORT, type PlatformId } from "@/lib/domain";
import type { PlatformAvailability } from "@/server/services/accounts";
import "./connect.css";

const ACCOUNT_TYPE_LABEL: Record<string, string> = {
  PAGE: "Facebook Page",
  IG_PROFESSIONAL: "Instagram professional",
  MEMBER: "LinkedIn profile",
  ORGANIZATION: "LinkedIn page",
  X_ACCOUNT: "X account",
};

interface PendingAccount {
  externalId: string;
  displayName: string;
  accountType: string;
  handle: string | null;
}

interface ClientOption {
  id: string;
  name: string;
}

/**
 * Start an OAuth connection and show the accounts it discovered.
 *
 * The backend flow already existed but nothing in the UI called it, so a
 * configured platform had no way to actually connect. This component is that
 * missing step: it asks the server for an authorize URL, sends the browser to
 * the platform, and on return renders the picker for the accounts Meta (or
 * LinkedIn, or X) handed back.
 *
 * The client choice is fixed on a client-scoped page and asked for on the
 * agency-wide one, because an OAuth flow does not know which client the account
 * belongs to — a human does.
 */
export function ConnectAccounts({
  platforms,
  clients,
  fixedClientId,
  connectSessionId,
  connectError,
  returnTo,
}: {
  platforms: PlatformAvailability[];
  clients: ClientOption[];
  fixedClientId?: string;
  connectSessionId?: string;
  connectError?: string;
  /** Same-origin path the callback should come back to. */
  returnTo?: string;
}) {
  const router = useRouter();

  const [starting, setStarting] = useState<PlatformId | null>(null);
  const [error, setError] = useState<string | null>(connectError ?? null);
  const [sessionPlatform, setSessionPlatform] = useState<PlatformId | null>(null);
  const [pending, setPending] = useState<PendingAccount[] | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [clientId, setClientId] = useState(fixedClientId ?? clients[0]?.id ?? "");
  const [saving, setSaving] = useState(false);

  const available = platforms.filter((platform) => platform.available);

  // Load the accounts the callback stored. A session id only ever arrives in the
  // URL right after a redirect back from the platform.
  useEffect(() => {
    if (!connectSessionId) return;
    let cancelled = false;

    void (async () => {
      const response = await fetch(`/api/accounts/connect/session/${connectSessionId}`, {
        cache: "no-store",
      });

      if (cancelled) return;

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setError(body?.error?.message ?? "That connection could not be loaded. Start again.");
        return;
      }

      const body = (await response.json()) as {
        platform: PlatformId;
        accounts: PendingAccount[];
      };

      if (cancelled) return;
      setSessionPlatform(body.platform);
      setPending(body.accounts);
      // Everything found is selected by default: the common case is "connect the
      // account I just logged in as", and unticking is faster than ticking.
      setChosen(body.accounts.map((account) => account.externalId));
    })();

    return () => {
      cancelled = true;
    };
  }, [connectSessionId]);

  const dismissSession = useCallback(() => {
    setPending(null);
    setSessionPlatform(null);
    setError(null);
    // Drop the one-time params so a refresh cannot replay a consumed session.
    router.replace(window.location.pathname);
  }, [router]);

  async function start(platform: PlatformId) {
    setStarting(platform);
    setError(null);

    const response = await fetch(
      `/api/accounts/connect/${platform.toLowerCase()}${
        returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ""
      }`,
      {
        method: "GET",
        headers: { Accept: "application/json" },
      },
    );

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as
        | { error?: { message?: string } }
        | null;
      setError(body?.error?.message ?? `Could not start the ${PLATFORM_SHORT[platform]} login.`);
      setStarting(null);
      return;
    }

    const body = (await response.json()) as { authorizeUrl: string };
    // Full navigation, not router.push: this leaves the app for the platform's
    // own consent screen. assign() rather than assigning href because the React
    // compiler lint treats a mutation of an outside binding as an error.
    window.location.assign(body.authorizeUrl);
  }

  async function confirm() {
    if (!connectSessionId || chosen.length === 0) return;

    setSaving(true);
    setError(null);

    const response = await fetch("/api/accounts/connect/confirm", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: window.location.origin,
      },
      body: JSON.stringify({ connectSessionId, clientId, externalIds: chosen }),
    });

    setSaving(false);

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as
        | { error?: { message?: string } }
        | null;
      setError(body?.error?.message ?? "Those accounts could not be connected.");
      return;
    }

    setPending(null);
    setSessionPlatform(null);
    router.replace(window.location.pathname);
    // Re-run the server component so the new rows appear without a manual reload.
    router.refresh();
  }

  function toggle(externalId: string) {
    setChosen((current) =>
      current.includes(externalId)
        ? current.filter((id) => id !== externalId)
        : [...current, externalId],
    );
  }

  return (
    <>
      {error ? (
        <div className="form-banner form-banner-error" role="alert">
          {error}
        </div>
      ) : null}

      {available.length > 0 ? (
        <section className="panel connect-panel" aria-labelledby="connect-heading">
          <div className="panel-head">
            <h2 className="panel-title" id="connect-heading">
              Connect an account
            </h2>
          </div>
          <div className="panel-body">
            <p className="small muted connect-lede">
              Sign in to the platform and choose which accounts this client can publish to. You
              approve each account before it is added.
            </p>
            <div className="connect-actions">
              {available.map((platform) => (
                <button
                  key={platform.platform}
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => void start(platform.platform)}
                  disabled={starting !== null || saving}
                >
                  {starting === platform.platform
                    ? "Opening…"
                    : `Connect ${platform.short}`}
                </button>
              ))}
            </div>
          </div>
        </section>
      ) : null}

      {pending ? (
        <div className="dialog-backdrop" role="presentation" onClick={dismissSession}>
          <div
            className="dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="connect-picker-title"
            onClick={(event) => event.stopPropagation()}
            style={{ maxWidth: 480 }}
          >
            <div className="dialog-head">
              <h2 className="dialog-title" id="connect-picker-title">
                {sessionPlatform ? `Choose ${PLATFORM_SHORT[sessionPlatform]} accounts` : "Choose accounts"}
              </h2>
            </div>

            <div className="dialog-body">
              {pending.length === 0 ? (
                <p className="small muted">
                  That login did not return any account this app can publish to.
                </p>
              ) : (
                <>
                  <p className="small muted connect-picker-lede">
                    These were found on that login. Untick anything this client should not use.
                  </p>
                  <div className="connect-picker-list">
                    {pending.map((account) => (
                      <label key={account.externalId} className="account-row">
                        <input
                          type="checkbox"
                          checked={chosen.includes(account.externalId)}
                          onChange={() => toggle(account.externalId)}
                        />
                        <span className="account-row-main">
                          <span className="account-row-name">{account.displayName}</span>
                          <span className="account-row-meta">
                            {ACCOUNT_TYPE_LABEL[account.accountType] ?? account.accountType}
                            {account.handle ? ` · ${account.handle}` : ""}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>

                  {!fixedClientId ? (
                    <div className="field" style={{ marginTop: 16 }}>
                      <label className="field-label" htmlFor="connect-client">
                        Add to client
                      </label>
                      <select
                        id="connect-client"
                        className="input"
                        value={clientId}
                        onChange={(event) => setClientId(event.target.value)}
                      >
                        {clients.map((client) => (
                          <option key={client.id} value={client.id}>
                            {client.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : null}
                </>
              )}
            </div>

            <div className="dialog-foot">
              <button type="button" className="btn btn-secondary" onClick={dismissSession}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void confirm()}
                disabled={saving || chosen.length === 0 || !clientId}
              >
                {saving
                  ? "Connecting…"
                  : `Connect ${chosen.length === 1 ? "account" : `${chosen.length} accounts`}`}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
