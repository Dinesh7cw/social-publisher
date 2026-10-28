"use client";

import { useState } from "react";

import { ConfirmDialog } from "@/components/ui/confirm-dialog";

export interface TeamMember {
  id: string;
  name: string;
  email: string;
  role: "ADMIN" | "MEMBER";
  isActive: boolean;
  timeZone: string;
  createdAt: string;
  postCount: number;
  isSelf: boolean;
}

export function TeamSettings({ members }: { members: TeamMember[] }) {
  const [inviting, setInviting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDeactivate, setConfirmDeactivate] = useState<TeamMember | null>(null);
  const [pending, setPending] = useState(false);
  const [localMembers, setLocalMembers] = useState(members);

  async function patchMember(member: TeamMember, body: Record<string, unknown>) {
    setPending(true);
    setError(null);
    setNotice(null);

    const response = await fetch(`/api/users/${member.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Origin: window.location.origin },
      body: JSON.stringify(body),
    });

    setPending(false);

    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as
        | { error?: { message?: string } }
        | null;
      setError(payload?.error?.message ?? "Could not update this team member.");
      return false;
    }

    return true;
  }

  async function onRoleChange(member: TeamMember, role: "ADMIN" | "MEMBER") {
    const ok = await patchMember(member, { role });
    if (ok) {
      setLocalMembers((current) =>
        current.map((m) => (m.id === member.id ? { ...m, role } : m)),
      );
      setNotice(`${member.name} is now ${role === "ADMIN" ? "an admin" : "a team member"}.`);
    }
  }

  async function onDeactivate(member: TeamMember) {
    const ok = await patchMember(member, { isActive: false });
    setConfirmDeactivate(null);
    if (ok) {
      setLocalMembers((current) =>
        current.map((m) => (m.id === member.id ? { ...m, isActive: false } : m)),
      );
      setNotice(`${member.name} can no longer sign in.`);
    }
  }

  async function onReactivate(member: TeamMember) {
    const ok = await patchMember(member, { isActive: true });
    if (ok) {
      setLocalMembers((current) =>
        current.map((m) => (m.id === member.id ? { ...m, isActive: true } : m)),
      );
      setNotice(`${member.name} can sign in again.`);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Team settings</h1>
          <p className="page-sub">
            {localMembers.filter((m) => m.isActive).length} active team member
            {localMembers.filter((m) => m.isActive).length === 1 ? "" : "s"}.
          </p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn btn-primary" onClick={() => setInviting(true)}>
            Add team member
          </button>
        </div>
      </div>

      {error ? (
        <div className="form-banner form-banner-error" role="alert" style={{ marginBottom: 16 }}>
          {error}
        </div>
      ) : null}

      {notice ? (
        <div className="form-banner form-banner-success" role="status" style={{ marginBottom: 16 }}>
          {notice}
        </div>
      ) : null}

      <div className="table-card">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Person</th>
                <th scope="col">Role</th>
                <th scope="col">Time zone</th>
                <th scope="col" className="num">
                  Posts
                </th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {localMembers.map((member) => (
                <tr key={member.id}>
                  <td>
                    <div className="cell-stack">
                      <span className="cell-primary">
                        {member.name}
                        {member.isSelf ? <span className="faint"> (you)</span> : null}
                      </span>
                      <span className="cell-sub">{member.email}</span>
                    </div>
                  </td>
                  <td>
                    <select
                      className="select select-sm"
                      value={member.role}
                      aria-label={`Role for ${member.name}`}
                      disabled={member.isSelf || !member.isActive || pending}
                      onChange={(e) => void onRoleChange(member, e.target.value as "ADMIN" | "MEMBER")}
                    >
                      <option value="MEMBER">Team member</option>
                      <option value="ADMIN">Admin</option>
                    </select>
                  </td>
                  <td className="small muted">{member.timeZone}</td>
                  <td className="num">{member.postCount}</td>
                  <td>
                    <span className={`pill ${member.isActive ? "pill-positive" : "pill-neutral"}`}>
                      {member.isActive ? "Active" : "Deactivated"}
                    </span>
                  </td>
                  <td>
                    <div style={{ display: "flex", justifyContent: "flex-end" }}>
                      {/* You cannot deactivate yourself: that would lock the team out. */}
                      {!member.isSelf ? (
                        member.isActive ? (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => setConfirmDeactivate(member)}
                          >
                            Deactivate
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => void onReactivate(member)}
                          >
                            Reactivate
                          </button>
                        )
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <section className="panel" style={{ marginTop: 24 }}>
        <div className="panel-head">
          <h2 className="panel-title">Security notes</h2>
        </div>
        <div className="panel-body">
          <ul className="small muted" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
            <li>Deactivating a member ends their sessions immediately.</li>
            <li>Changing a role also ends that person&rsquo;s sessions, so the new role applies at once.</li>
            <li>Social account tokens are encrypted and never shown in the browser.</li>
            <li>Every sign-in, publish, connect and disconnect is written to the audit log.</li>
          </ul>
        </div>
      </section>

      {inviting ? (
        <InviteDialog
          onClose={() => setInviting(false)}
          onCreated={(member) => {
            setLocalMembers((current) => [...current, member]);
            setInviting(false);
            setNotice(`${member.name} can now sign in.`);
          }}
        />
      ) : null}

      {confirmDeactivate ? (
        <ConfirmDialog
          title={`Deactivate ${confirmDeactivate.name}?`}
          body="They will be signed out immediately and cannot sign in again until reactivated. Their posts and history are kept."
          confirmLabel="Deactivate"
          destructive
          pending={pending}
          onCancel={() => setConfirmDeactivate(null)}
          onConfirm={() => void onDeactivate(confirmDeactivate)}
        />
      ) : null}
    </>
  );
}

function InviteDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (member: TeamMember) => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"ADMIN" | "MEMBER">("MEMBER");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSaving(true);

    const response = await fetch("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: window.location.origin },
      body: JSON.stringify({ name, email, password, role }),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as
        | { error?: { message?: string; details?: Array<{ path: string; message: string }> } }
        | null;
      const details = body?.error?.details?.map((d) => d.message).join(" ");
      setError(details || body?.error?.message || "Could not add this team member.");
      setSaving(false);
      return;
    }

    const created = (await response.json()) as TeamMember;
    onCreated(created);
  }

  return (
    <div className="dialog-backdrop" role="presentation" onClick={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="invite-title"
        onClick={(e) => e.stopPropagation()}
      >
        <form onSubmit={onSubmit}>
          <div className="dialog-head">
            <h2 className="dialog-title" id="invite-title">
              Add team member
            </h2>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
              Close
            </button>
          </div>

          <div className="dialog-body">
            <div className="form-grid">
              <div className="field">
                <label className="field-label" htmlFor="invite-name">
                  Full name
                </label>
                <input
                  id="invite-name"
                  className="input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  autoFocus
                  maxLength={120}
                />
              </div>

              <div className="field">
                <label className="field-label" htmlFor="invite-email">
                  Work email
                </label>
                <input
                  id="invite-email"
                  type="email"
                  className="input"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="off"
                />
              </div>

              <div className="field">
                <label className="field-label" htmlFor="invite-password">
                  Temporary password
                </label>
                <input
                  id="invite-password"
                  type="text"
                  className="input"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={12}
                  autoComplete="new-password"
                />
                <span className="field-hint">
                  At least 12 characters. Share it with them over a secure channel and ask them to
                  change it.
                </span>
              </div>

              <div className="field">
                <label className="field-label" htmlFor="invite-role">
                  Role
                </label>
                <select
                  id="invite-role"
                  className="select"
                  value={role}
                  onChange={(e) => setRole(e.target.value as "ADMIN" | "MEMBER")}
                >
                  <option value="MEMBER">Team member: can create and publish posts</option>
                  <option value="ADMIN">Admin: can also manage clients, accounts and the team</option>
                </select>
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
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? "Adding…" : "Add member"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
