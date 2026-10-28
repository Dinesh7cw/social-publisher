import { z } from "zod";
import { NextResponse } from "next/server";

import { prisma } from "@/server/db";
import { route, ApiError, jsonError } from "@/server/http";
import { verifyPassword } from "@/server/auth/password";
import { createSession, sessionCookieOptions, SESSION_COOKIE } from "@/server/auth/session";
import { capabilitiesFor } from "@/server/auth/guards";
import { assertSameOrigin } from "@/server/auth/guards";
import { rateLimit, LIMITS } from "@/server/rate-limit";
import { parseJson, clientIp } from "@/server/request";
import { recordAuditSafe } from "@/server/audit";

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().min(3).max(320),
  password: z.string().min(1).max(200),
});

export const POST = route(async (request: Request) => {
  assertSameOrigin(request);

  const ip = clientIp(request);

  const limit = await rateLimit({
    bucket: "login:ip",
    identifier: ip,
    ...LIMITS.login,
  });

  if (!limit.allowed) {
    return NextResponse.json(
      { error: { code: "RATE_LIMITED", message: "Too many attempts. Please wait a minute." } },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }

  const { email, password } = await parseJson(request, loginSchema);

  // Per-account limiting as well as per-IP: a shared office IP must not let one
  // person's failures lock out the team, and a distributed attempt must still
  // be throttled per account.
  const emailLimit = await rateLimit({
    bucket: "login:email",
    identifier: email,
    limit: 10,
    windowMs: 60_000,
  });

  if (!emailLimit.allowed) {
    return NextResponse.json(
      { error: { code: "RATE_LIMITED", message: "Too many attempts. Please wait a minute." } },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      isActive: true,
      passwordHash: true,
      timeZone: true,
    },
  });

  // One message and one timing profile for every failure mode: an unknown email
  // must not be distinguishable from a wrong password.
  const genericFailure = () =>
    jsonError(new ApiError("UNAUTHENTICATED", "Email or password is incorrect."));

  if (!user) {
    // Still run a hash comparison so the response time does not leak existence.
    await verifyPassword(
      "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzYWx0c2FsdA$0000000000000000000000000000000000000000000",
      password,
    );
    await recordAuditSafe({
      actorId: null,
      action: "LOGIN_FAILED",
      entityType: "User",
      entityId: "unknown",
      metadata: { email },
      ip,
    });
    return genericFailure();
  }

  if (!user.isActive) {
    await recordAuditSafe({
      actorId: user.id,
      action: "LOGIN_FAILED",
      entityType: "User",
      entityId: user.id,
      metadata: { reason: "inactive" },
      ip,
    });
    return genericFailure();
  }

  const valid = await verifyPassword(user.passwordHash, password);
  if (!valid) {
    await recordAuditSafe({
      actorId: user.id,
      action: "LOGIN_FAILED",
      entityType: "User",
      entityId: user.id,
      metadata: { reason: "bad_password" },
      ip,
    });
    return genericFailure();
  }

  const session = await createSession({
    userId: user.id,
    userAgent: request.headers.get("user-agent"),
    ip,
  });

  await recordAuditSafe({
    actorId: user.id,
    action: "LOGIN_SUCCEEDED",
    entityType: "User",
    entityId: user.id,
    ip,
  });

  const response = NextResponse.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      timeZone: user.timeZone,
    },
    capabilities: capabilitiesFor({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      timeZone: user.timeZone,
    }),
  });

  const cookie = sessionCookieOptions(session.expiresAt);
  response.cookies.set({
    name: SESSION_COOKIE,
    value: session.cookieValue,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: cookie.sameSite,
    path: cookie.path,
    expires: cookie.expires,
  });

  return response;
});
