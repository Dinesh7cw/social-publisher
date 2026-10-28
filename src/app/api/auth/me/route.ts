import { NextResponse } from "next/server";

import { route, unauthenticated } from "@/server/http";
import { getSession, maybeRenewSession } from "@/server/auth/session";
import { capabilitiesFor } from "@/server/auth/guards";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const session = await getSession();
  if (!session) throw unauthenticated();

  // Keeps an active user signed in without a fixed re-login every 12 hours.
  await maybeRenewSession(session);

  return NextResponse.json({
    user: session.user,
    capabilities: capabilitiesFor(session.user),
    expiresAt: session.expiresAt.toISOString(),
  });
});
