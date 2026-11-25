"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { PLATFORM_SHORT, type PlatformId } from "@/lib/domain";

export interface CredentialView {
  platform: PlatformId;
  configured: boolean;
  source: "saved" | "shared" | "environment" | null;
  appIdHint: string | null;
  unreadable: boolean;
  /** Set when this platform runs on another platform's saved app. */
  sharedWith: PlatformId | null;
  updatedAt: string | null;
  updatedByName: string | null;
  fields: {
    appLabel: string;
    appHint: string;
    secretLabel: string;
    secretHint: string;
    consoleUrl: string;
    scopes: string[];
    redirectHint: string;
  };
  redirectUri: string;
  /** This client's accounts on the platform, so the page shows the real effect. */
  connected: { displayName: string; status: string }[];
}

const STATUS_LABEL: Record<string, string> = {
  CONNECTED: "Connected",
  EXPIRED: "Needs reconnecting",
  REVOKED: "Revoked",
  ERROR: "Error",
};

export function CredentialsForm({
  platforms,
  canEdit,
}: {
  platforms: CredentialView[];
  canEdit: boolean;
}) {
  const [active, setActive] = useState<PlatformId>(platforms[0]?.platform ?? "FACEBOOK");
  const current = platforms.find((item) => item.platform === active) ?? platforms[0]!;

  return (
    <div className="cred">
      <div className="cred-tabs" role="tablist" aria-label="Platform">
        {platforms.map((item) => (
          <button
            key={item.platform}
            type="button"
            role="tab"
            aria-selected={item.platform === active}
            className="cred-tab"
            data-active={item.platform === active ? "true" : "false"}
            onClick={() => setActive(item.platform)}
          >
            <span className="cred-tab-name">{PLATFORM_SHORT[item.platform]}</span>
            <span className="cred-tab-state" data-on={item.configured ? "true" : "false"}>
              {item.sharedWith ? `Via ${PLATFORM_SHORT[item.sharedWith]}` : item.configured ? "Ready" : "Not set"}
            </span>
          </button>
        ))}
      </div>

      <PlatformPanel key={current.platform} view={current} canEdit={canEdit} />
    </div>
  );
}

function PlatformPanel({ view, canEdit }: { view: CredentialView; canEdit: boolean }) {
  const router = useRouter();
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [replacing, setReplacing] = useState(!view.configured);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const configured = view.configured;

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice(null);

    if (!appId.trim() || !appSecret.trim()) {
      setError("Both the app id and the app secret are needed.");
      return;
    }
    setPending(true);
    try {
      const response = await fetch("/api/platform-credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: window.location.origin },
        body: JSON.stringify({
          platform: view.platform,
          appId: appId.trim(),
          appSecret: appSecret.trim(),
        }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setError(body?.error?.message ?? "Could not save these credentials.");
        return;
      }

      setAppId("");
      setAppSecret("");
      setReplacing(false);
      setNotice(`${PLATFORM_SHORT[view.platform]} can now be connected.`);
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  async function remove() {
    setError(null);
    setNotice(null);
    setPending(true);
    try {
      const response = await fetch("/api/platform-credentials", {
        method: "DELETE",
        headers: { "Content-Type": "application/json", Origin: window.location.origin },
        body: JSON.stringify({ platform: view.platform }),
      });

      if (!response.ok) {
        setError("Could not remove these credentials.");
        return;
      }

      setNotice("Credentials removed. Accounts already connected keep working until their tokens expire.");
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  async function copyRedirect() {
    try {
      await navigator.clipboard.writeText(view.redirectUri);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Could not copy. Select the URL and copy it by hand.");
    }
  }

  return (
    <section className="panel cred-panel" aria-label={`${PLATFORM_SHORT[view.platform]} credentials`}>
      <div className="cred-head">
        <div>
          <h2 className="cred-title">{PLATFORM_SHORT[view.platform]} app credentials</h2>
          <p className="small muted cred-sub">
            {view.sharedWith
              ? `Runs on the ${PLATFORM_SHORT[view.sharedWith]} app — same app id, same secret, same redirect URI. Nothing to fill in here.`
              : configured
                ? view.source === "environment"
                  ? "Set from the server environment. Saving here overrides it for this deployment."
                  : `Saved${view.updatedByName ? ` by ${view.updatedByName}` : ""}${
                      view.updatedAt ? ` on ${new Date(view.updatedAt).toLocaleDateString("en-GB")}` : ""
                    }.`
                : "Not set yet, so no account on this platform can be connected."}
          </p>
        </div>
        <span className={`pill ${configured ? "pill-positive" : "pill-warning"}`}>
          {view.unreadable
            ? "Secret unreadable"
            : view.sharedWith
              ? `Via ${PLATFORM_SHORT[view.sharedWith]}`
              : configured
                ? "Ready"
                : "Not set"}
        </span>
      </div>

      {view.unreadable ? (
        <p className="form-banner form-banner-error">
          A saved secret cannot be decrypted with the current encryption key. Enter it again to fix
          this.
        </p>
      ) : null}

      {view.sharedWith ? (
        <div className="form-banner cred-note">
          This platform uses the <strong>{PLATFORM_SHORT[view.sharedWith]}</strong> app. Configure it
          once on the {PLATFORM_SHORT[view.sharedWith]} tab and both work — there is no separate
          Instagram app, and Meta grants the Instagram permissions through the same login.
        </div>
      ) : null}

      {!canEdit ? (
        <p className="form-banner cred-note">
          Only an admin can change platform credentials. Ask a CW admin to fill this in.
        </p>
      ) : null}

      {/* The redirect URI is the step people get wrong, so it is the first thing
          on the page and it copies with one click. */}
      <div className="cred-redirect">
        <div className="cred-redirect-head">
          <span className="field-label">Redirect URI to register</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={copyRedirect}>
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <code className="cred-code">{view.redirectUri}</code>
        <p className="field-hint">{view.fields.redirectHint}</p>
      </div>

      {configured ? (
        <dl className="cred-facts">
          <div>
            <dt>App id</dt>
            <dd className="num">{view.appIdHint}</dd>
          </div>
          <div>
            <dt>Source</dt>
            <dd>
              {view.source === "environment"
                ? "Server environment"
                : view.sharedWith
                  ? `Shared from ${PLATFORM_SHORT[view.sharedWith]}`
                  : "Saved here"}
            </dd>
          </div>
          <div>
            <dt>Secret</dt>
            <dd>Stored encrypted, never shown again</dd>
          </div>
        </dl>
      ) : null}

      {canEdit && !view.sharedWith ? (
        <form onSubmit={save} className="cred-form">
          {configured && !replacing ? (
            <div className="cred-actions">
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setReplacing(true)}>
                Replace credentials
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={remove}
                disabled={pending || view.source === "environment"}
                title={
                  view.source === "environment"
                    ? "These come from the server environment and cannot be removed here."
                    : undefined
                }
              >
                Remove
              </button>
            </div>
          ) : (
            <>
              <div className="field">
                <label className="field-label" htmlFor={`app-id-${view.platform}`}>
                  {view.fields.appLabel}
                </label>
                <input
                  id={`app-id-${view.platform}`}
                  className="input"
                  value={appId}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={view.appIdHint ?? "Paste the app id"}
                  onChange={(event) => setAppId(event.target.value)}
                />
                <span className="field-hint">{view.fields.appHint}</span>
              </div>

              <div className="field">
                <label className="field-label" htmlFor={`app-secret-${view.platform}`}>
                  {view.fields.secretLabel}
                </label>
                <input
                  id={`app-secret-${view.platform}`}
                  className="input"
                  type="password"
                  value={appSecret}
                  autoComplete="new-password"
                  placeholder={configured ? "Paste the secret again to replace it" : "Paste the app secret"}
                  onChange={(event) => setAppSecret(event.target.value)}
                />
                <span className="field-hint">
                  {view.fields.secretHint} Encrypted with AES-256-GCM before it is stored.
                </span>
              </div>

              <div className="cred-actions">
                <button type="submit" className="btn btn-primary btn-sm" disabled={pending}>
                  {pending ? "Saving…" : "Save credentials"}
                </button>
                {configured ? (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => {
                      setReplacing(false);
                      setAppId("");
                      setAppSecret("");
                    }}
                    disabled={pending}
                  >
                    Cancel
                  </button>
                ) : (
                  <a
                    className="btn btn-ghost btn-sm"
                    href={view.fields.consoleUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open developer console
                  </a>
                )}
              </div>
            </>
          )}

          {error ? <p className="form-banner form-banner-error">{error}</p> : null}
          {notice ? (
            <p className="form-banner form-banner-success" role="status">
              {notice}
            </p>
          ) : null}
        </form>
      ) : null}

      <div className="cred-scopes">
        <span className="field-label">Permissions the app must request</span>
        <ul className="cred-scope-list">
          {view.fields.scopes.map((scope) => (
            <li key={scope}>
              <code>{scope}</code>
            </li>
          ))}
        </ul>
        <p className="field-hint">
          Meta grants the Instagram permissions only through Facebook Login, which is why Instagram
          uses the same app and redirect URI as Facebook.
        </p>
      </div>

      <div className="cred-connected">
        <span className="field-label">This client on {PLATFORM_SHORT[view.platform]}</span>
        {view.connected.length === 0 ? (
          <p className="small muted">
            No account connected yet.{configured ? " Once the app above is saved you can connect one." : " Add the app credentials first."}
          </p>
        ) : (
          <ul className="cred-account-list">
            {view.connected.map((account) => (
              <li key={account.displayName} className="cred-account">
                <span className="cred-account-name">{account.displayName}</span>
                <span
                  className={`pill ${
                    account.status === "CONNECTED" ? "pill-positive" : "pill-warning"
                  }`}
                >
                  {STATUS_LABEL[account.status] ?? account.status}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
