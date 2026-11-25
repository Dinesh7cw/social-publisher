"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

import type { ClientSummary } from "@/server/services/clients";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

type StatusFilter = "ACTIVE" | "ARCHIVED" | "ALL";

export function ClientsManager({
  initialClients,
  canManage,
}: {
  initialClients: ClientSummary[];
  canManage: boolean;
}) {
  const [clients, setClients] = useState<ClientSummary[]>(initialClients);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("ACTIVE");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [editing, setEditing] = useState<ClientSummary | null>(null);
  const [creating, setCreating] = useState(false);
  const [archiving, setArchiving] = useState<ClientSummary | null>(null);

  const reload = useCallback(
    async (nextStatus: StatusFilter, nextQuery: string) => {
      setPending(true);
      setError(null);
      try {
        const params = new URLSearchParams({ status: nextStatus, limit: "100" });
        if (nextQuery.trim()) params.set("q", nextQuery.trim());

        const response = await fetch(`/api/clients?${params.toString()}`);
        if (!response.ok) {
          setError("Could not load clients. Please try again.");
          return;
        }
        const body = (await response.json()) as { items: ClientSummary[] };
        setClients(body.items);
      } catch {
        setError("Could not reach the server.");
      } finally {
        setPending(false);
      }
    },
    [],
  );

  // Debounce the search so typing does not fire a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => {
      void reload(status, query);
    }, 250);
    return () => clearTimeout(timer);
  }, [query, status, reload]);

  const totalAccounts = useMemo(
    () => clients.reduce((sum, client) => sum + client.counts.accounts, 0),
    [clients],
  );

  async function onArchive(client: ClientSummary) {
    const response = await fetch(`/api/clients/${client.id}/archive`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: window.location.origin },
      body: JSON.stringify({}),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
      setError(body?.error?.message ?? "Could not archive this client.");
      setArchiving(null);
      return;
    }

    setArchiving(null);
    await reload(status, query);
  }

  async function onRestore(client: ClientSummary) {
    const response = await fetch(`/api/clients/${client.id}/archive`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: window.location.origin },
      body: JSON.stringify({ restore: true }),
    });

    if (!response.ok) {
      setError("Could not restore this client.");
      return;
    }

    await reload(status, query);
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Clients</h1>
          <p className="page-sub">
            {clients.length === 0
              ? "No clients match this view yet."
              : `${clients.length} client${clients.length === 1 ? "" : "s"}, ${totalAccounts} connected account${totalAccounts === 1 ? "" : "s"}.`}
          </p>
        </div>
        {canManage ? (
          <div className="page-actions">
            <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
              Add client
            </button>
          </div>
        ) : null}
      </div>

      <div className="toolbar">
        <div className="toolbar-search">
          <SearchIcon />
          <input
            type="search"
            className="input"
            placeholder="Search clients"
            aria-label="Search clients"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <select
          className="select select-sm"
          aria-label="Filter by status"
          value={status}
          onChange={(e) => setStatus(e.target.value as StatusFilter)}
        >
          <option value="ACTIVE">Active</option>
          <option value="ARCHIVED">Archived</option>
          <option value="ALL">All</option>
        </select>

        <div className="toolbar-spacer" />

        {pending ? <span className="small faint">Loading…</span> : null}
      </div>

      {error ? (
        <div className="form-banner form-banner-error" role="alert" style={{ marginBottom: 16 }}>
          {error}
        </div>
      ) : null}

      {clients.length === 0 ? (
        <div className="empty-state">
          <p className="empty-title">
            {query ? "No clients match that search" : "No clients yet"}
          </p>
          <p className="small">
            {query
              ? "Try a different name, or clear the search."
              : canManage
                ? "Add the businesses CW manages to start connecting their accounts."
                : "An admin needs to add the first client."}
          </p>
          {canManage && !query ? (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setCreating(true)}>
              Add the first client
            </button>
          ) : null}
        </div>
      ) : (
        <div className="table-card">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Client</th>
                  <th scope="col">Contact</th>
                  <th scope="col" className="num">
                    Accounts
                  </th>
                  <th scope="col" className="num">
                    Scheduled
                  </th>
                  <th scope="col" className="num">
                    Published
                  </th>
                  <th scope="col">Status</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {clients.map((client) => (
                  <tr key={client.id}>
                    <td>
                      <div className="cell-stack">
                        <span className="cell-primary">{client.name}</span>
                        {client.notes ? <span className="cell-sub">{client.notes}</span> : null}
                      </div>
                    </td>
                    <td>
                      {client.contactName || client.contactEmail ? (
                        <div className="cell-stack">
                          {client.contactName ? <span>{client.contactName}</span> : null}
                          {client.contactEmail ? (
                            <span className="cell-sub">{client.contactEmail}</span>
                          ) : null}
                        </div>
                      ) : (
                        <span className="faint">—</span>
                      )}
                    </td>
                    <td className="num">{client.counts.accounts}</td>
                    <td className="num">{client.counts.scheduled}</td>
                    <td className="num">{client.counts.published}</td>
                    <td>
                      <span
                        className={`pill ${client.status === "ACTIVE" ? "pill-positive" : "pill-neutral"}`}
                      >
                        {client.status === "ACTIVE" ? "Active" : "Archived"}
                      </span>
                    </td>
                    <td>
                      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                        <Link href={`/clients/${client.id}`} className="btn btn-ghost btn-sm">
                          Open
                        </Link>
                        {canManage ? (
                          <>
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              onClick={() => setEditing(client)}
                            >
                              Edit
                            </button>
                            {client.status === "ACTIVE" ? (
                              <button
                                type="button"
                                className="btn btn-ghost btn-sm"
                                onClick={() => setArchiving(client)}
                              >
                                Archive
                              </button>
                            ) : (
                              <button
                                type="button"
                                className="btn btn-ghost btn-sm"
                                onClick={() => void onRestore(client)}
                              >
                                Restore
                              </button>
                            )}
                          </>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {creating || editing ? (
        <ClientDialog
          client={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={async () => {
            setCreating(false);
            setEditing(null);
            await reload(status, query);
          }}
        />
      ) : null}

      {archiving ? (
        <ConfirmDialog
          title={`Archive ${archiving.name}?`}
          body="Archived clients keep their history but are hidden from the post composer. You can restore one at any time."
          confirmLabel="Archive client"
          destructive
          onCancel={() => setArchiving(null)}
          onConfirm={() => void onArchive(archiving)}
        />
      ) : null}
    </>
  );
}

function ClientDialog({
  client,
  onClose,
  onSaved,
}: {
  client: ClientSummary | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState(client?.name ?? "");
  const [contactName, setContactName] = useState(client?.contactName ?? "");
  const [contactEmail, setContactEmail] = useState(client?.contactEmail ?? "");
  const [notes, setNotes] = useState(client?.notes ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSaving(true);

    const payload = {
      name: name.trim(),
      contactName: contactName.trim() || null,
      contactEmail: contactEmail.trim() || null,
      notes: notes.trim() || null,
    };

    try {
      const response = await fetch(client ? `/api/clients/${client.id}` : "/api/clients", {
        method: client ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json", Origin: window.location.origin },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setError(body?.error?.message ?? "Could not save this client.");
        setSaving(false);
        return;
      }

      await onSaved();
    } catch {
      setError("Could not reach the server.");
      setSaving(false);
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation" onClick={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="client-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <form onSubmit={onSubmit}>
          <div className="dialog-head">
            <h2 className="dialog-title" id="client-dialog-title">
              {client ? "Edit client" : "Add a client"}
            </h2>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
              Close
            </button>
          </div>

          <div className="dialog-body">
            <div className="form-grid">
              <div className="field">
                <label className="field-label" htmlFor="client-name">
                  Client name
                </label>
                <input
                  id="client-name"
                  className="input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  minLength={2}
                  maxLength={120}
                  autoFocus
                />
              </div>

              <div className="form-row">
                <div className="field">
                  <label className="field-label" htmlFor="client-contact">
                    Contact name <span className="faint">(optional)</span>
                  </label>
                  <input
                    id="client-contact"
                    className="input"
                    value={contactName}
                    onChange={(e) => setContactName(e.target.value)}
                    maxLength={120}
                  />
                </div>

                <div className="field">
                  <label className="field-label" htmlFor="client-email">
                    Contact email <span className="faint">(optional)</span>
                  </label>
                  <input
                    id="client-email"
                    type="email"
                    className="input"
                    value={contactEmail}
                    onChange={(e) => setContactEmail(e.target.value)}
                  />
                </div>
              </div>

              <div className="field">
                <label className="field-label" htmlFor="client-notes">
                  Notes <span className="faint">(optional)</span>
                </label>
                <textarea
                  id="client-notes"
                  className="textarea"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  maxLength={4000}
                  rows={3}
                />
                <span className="field-hint">Internal only. Never shown to the client.</span>
              </div>

              {error ? (
                <p className="form-banner form-banner-error" role="alert">
                  {error}
                </p>
              ) : null}
            </div>
          </div>

          <div className="dialog-foot">
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving || name.trim().length < 2}>
              {saving ? "Saving…" : client ? "Save changes" : "Add client"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function SearchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
