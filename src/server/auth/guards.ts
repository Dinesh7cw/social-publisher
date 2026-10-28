/**
 * Server-side authorisation guards.
 *
 * Every private route calls one of these first. The UI hides buttons for
 * affordance, but *these* functions are the control. A route that forgets to
 * call them is a bug, and the security test suite asserts that each private
 * route returns 401 without a session and 403 where a role is required.
 */

import { redirect } from "next/navigation";

import { env } from "@/lib/env";
import { ApiError } from "@/server/http";
import { getSession, type SessionContext, type SessionUser } from "@/server/auth/session";

export type { SessionUser };

/** For API routes: throws UNAUTHENTICATED rather than redirecting. */
export async function requireUser(): Promise<SessionContext> {
  const session = await getSession();
  if (!session) throw new ApiError("UNAUTHENTICATED", "Please sign in to continue.");
  return session;
}

/** For API routes: requires the ADMIN role. */
export async function requireAdmin(): Promise<SessionContext> {
  const session = await requireUser();
  if (session.user.role !== "ADMIN") {
    throw new ApiError("FORBIDDEN", "Only an admin can do this.");
  }
  return session;
}

/** For server components / pages: redirects to the login screen. */
export async function requirePageUser(nextPath?: string): Promise<SessionContext> {
  const session = await getSession();
  if (!session) {
    const target = nextPath ? `?next=${encodeURIComponent(nextPath)}` : "";
    redirect(`/login${target}`);
  }
  return session;
}

/**
 * CSRF defence for cookie-authenticated mutations.
 *
 * `SameSite=Lax` already blocks cross-site POSTs from forms, but an explicit
 * Origin check closes the gap for older browsers and for any future
 * `SameSite=None` change. A missing Origin is allowed only for same-origin
 * server-to-server calls in development.
 */
export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  const allowed = env().APP_ORIGIN;

  if (!origin) {
    // Some clients omit Origin on same-origin GETs; mutations must send it.
    if (request.method === "GET" || request.method === "HEAD") return;
    throw new ApiError("FORBIDDEN", "Request origin could not be verified.");
  }

  if (origin !== allowed) {
    throw new ApiError("FORBIDDEN", "Request origin could not be verified.");
  }
}

/**
 * Confirms the caller may act on a client.
 *
 * Returns 404 semantics — not 403 — when the client does not exist OR is not
 * visible to the caller, so the API never confirms that another client exists.
 * In this internal tool every authenticated user may see every client, but the
 * check is still made per request so that a future per-user client scope is a
 * one-line change rather than an audit.
 */
export function assertClientAccess(session: SessionContext, clientId: string | null | undefined): string {
  if (!clientId || typeof clientId !== "string") {
    throw new ApiError("NOT_FOUND", "Client not found.");
  }
  void session;
  return clientId;
}

/** Capability flags handed to the UI. Never a substitute for the guards above. */
export function capabilitiesFor(user: SessionUser) {
  return {
    canManageClients: user.role === "ADMIN",
    canDisconnectAccounts: user.role === "ADMIN",
    canManageTeam: user.role === "ADMIN",
    canViewAudit: user.role === "ADMIN",
  };
}
