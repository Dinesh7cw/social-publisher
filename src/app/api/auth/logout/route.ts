import { NextResponse } from "next/server";

import { route } from "@/server/http";
import { assertSameOrigin } from "@/server/auth/guards";
import { getSession, destroySession, SESSION_COOKIE, SESSION_COOKIE_SECURE } from "@/server/auth/session";
import { recordAuditSafe } from "@/server/audit";
import { clientIp } from "@/server/request";

export const POST = route(async (request: Request) => {
  assertSameOrigin(request);
  const session = await getSession();

  if (session) {
    await destroySession(session.sessionId);
    await recordAuditSafe({
      actorId: session.user.id,
      action: "LOGOUT",
      entityType: "User",
      entityId: session.user.id,
      ip: clientIp(request),
    });
  }

  const response = new NextResponse(null, { status: 204 });
  response.cookies.set({
    name: SESSION_COOKIE,
    value: "",
    httpOnly: true,
    secure: SESSION_COOKIE_SECURE,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return response;
});
