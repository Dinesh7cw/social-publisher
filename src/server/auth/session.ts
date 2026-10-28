/**
 * Session management.
 *
 * Design notes:
 *  - Sessions are database rows, so a deactivated user or a role change takes
 *    effect immediately. A stateless JWT could not do that without a denylist.
 *  - The cookie carries `<id>.<hmac>`. The HMAC binds the id to our secret, so a
 *    guessed id alone is useless, and we can reject tampered cookies without a
 *    database round-trip.
 *  - Cookies are `__Host-` prefixed: the browser then requires Secure, no Domain
 *    attribute, and Path=/, which prevents a subdomain from setting a cookie
 *    our app would trust.
 *  - `SameSite=Lax` plus an Origin check on mutations gives CSRF protection
 *    without a separate token ceremony.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

import { env } from "@/lib/env";
import { hashIdentifier } from "@/lib/crypto";
import { prisma } from "@/server/db";
import type { Role } from "@/generated/prisma/enums";

/**
 * Cookie name.
 *
 * The `__Host-` prefix is a real hardening win: the browser then requires
 * `Secure`, forbids a `Domain` attribute, and pins `Path=/`, so a compromised
 * subdomain cannot set a cookie this app would trust. It also means the cookie
 * is rejected outright over plain http, so local development uses a different
 * name. The two names never coexist on one origin.
 */
export const SESSION_COOKIE =
  process.env.NODE_ENV === "production" ? "__Host-cw_session" : "cw_session_dev";

/** Secure is required by the __Host- prefix in production, and refused on dev http. */
export const SESSION_COOKIE_SECURE = process.env.NODE_ENV === "production";

export const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12 hours
const RENEW_THRESHOLD_MS = 1000 * 60 * 60; // renew when under 1 hour remains

function sign(id: string): string {
  return createHmac("sha256", env().SESSION_SECRET).update(id).digest("base64url");
}

function serialiseCookie(id: string): string {
  return `${id}.${sign(id)}`;
}

function parseCookieValue(value: string): string | null {
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;

  const id = value.slice(0, dot);
  const mac = value.slice(dot + 1);
  const expected = sign(id);

  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;

  return id;
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  timeZone: string;
}

export interface SessionContext {
  sessionId: string;
  user: SessionUser;
  expiresAt: Date;
}

export async function createSession(params: {
  userId: string;
  userAgent?: string | null;
  ip?: string | null;
}): Promise<{ cookieValue: string; expiresAt: Date; sessionId: string }> {
  const id = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await prisma.session.create({
    data: {
      id,
      userId: params.userId,
      expiresAt,
      userAgent: params.userAgent?.slice(0, 400) ?? null,
      ipHash: params.ip ? hashIdentifier(params.ip) : null,
    },
  });

  return { cookieValue: serialiseCookie(id), expiresAt, sessionId: id };
}

export function sessionCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    secure: SESSION_COOKIE_SECURE,
    sameSite: "lax" as const,
    path: "/",
    expires: expiresAt,
  };
}

/**
 * Resolve the current session from cookies.
 *
 * Returns null for any of: no cookie, tampered cookie, unknown session, expired
 * session, deactivated user. Callers all treat null as "not signed in".
 */
export async function getSession(): Promise<SessionContext | null> {
  const jar = await cookies();
  const raw = jar.get(SESSION_COOKIE)?.value;
  if (!raw) return null;

  const id = parseCookieValue(raw);
  if (!id) return null;

  const session = await prisma.session.findUnique({
    where: { id },
    include: {
      user: {
        select: { id: true, email: true, name: true, role: true, isActive: true, timeZone: true },
      },
    },
  });

  if (!session) return null;
  if (session.expiresAt.getTime() <= Date.now()) {
    // Opportunistic cleanup: never leave an expired row behind.
    await prisma.session.delete({ where: { id } }).catch(() => undefined);
    return null;
  }
  if (!session.user.isActive) return null;

  return {
    sessionId: session.id,
    expiresAt: session.expiresAt,
    user: {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
      role: session.user.role,
      timeZone: session.user.timeZone,
    },
  };
}

/** Extend a session that is close to expiry, so an active user is not logged out. */
export async function maybeRenewSession(session: SessionContext): Promise<void> {
  const remaining = session.expiresAt.getTime() - Date.now();
  if (remaining > RENEW_THRESHOLD_MS) return;

  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await prisma.session.update({ where: { id: session.sessionId }, data: { expiresAt } });

  const jar = await cookies();
  jar.set(SESSION_COOKIE, serialiseCookie(session.sessionId), sessionCookieOptions(expiresAt));
}

export async function destroySession(sessionId: string): Promise<void> {
  await prisma.session.delete({ where: { id: sessionId } }).catch(() => undefined);
}

/** Invalidate every session for a user (role change, deactivation, password reset). */
export async function destroyAllSessionsForUser(userId: string): Promise<number> {
  const result = await prisma.session.deleteMany({ where: { userId } });
  return result.count;
}

/** Housekeeping: remove expired session rows. Safe to run on a schedule. */
export async function pruneExpiredSessions(): Promise<number> {
  const result = await prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  return result.count;
}
