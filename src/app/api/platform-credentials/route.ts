import { NextResponse } from "next/server";
import { z } from "zod";

import { route, invalid, ApiError } from "@/server/http";
import { requireUser, requireAdmin, assertSameOrigin } from "@/server/auth/guards";
import { PLATFORMS, type PlatformId } from "@/lib/domain";
import {
  allCredentialStatuses,
  removeAppCredentials,
  saveAppCredentials,
} from "@/server/services/platform-credentials";

/**
 * Platform app credentials.
 *
 * Read is available to anyone signed in: knowing whether a platform is set up is
 * not sensitive, and hiding it produces support tickets. Writing is admin-only,
 * and the secret is never returned — only a masked app id and where the value
 * came from.
 */

export const GET = route(async () => {
  await requireUser();
  return NextResponse.json({ platforms: await allCredentialStatuses() });
});

const saveSchema = z.object({
  platform: z.enum(["FACEBOOK", "INSTAGRAM", "LINKEDIN", "X"]),
  appId: z.string().trim().min(1).max(200),
  appSecret: z.string().trim().min(8).max(500),
  config: z.record(z.string(), z.string().max(40)).optional(),
});

export const POST = route(async (request: Request) => {
  assertSameOrigin(request);
  const session = await requireAdmin();

  const body = await request.json().catch(() => null);
  const parsed = saveSchema.safeParse(body);
  if (!parsed.success) {
    throw invalid("Check the app id and secret, then try again.");
  }

  await saveAppCredentials({
    platform: parsed.data.platform as PlatformId,
    appId: parsed.data.appId,
    appSecret: parsed.data.appSecret,
    config: parsed.data.config,
    actorId: session.user.id,
  });

  return NextResponse.json({ ok: true });
});

const removeSchema = z.object({
  platform: z.enum(["FACEBOOK", "INSTAGRAM", "LINKEDIN", "X"]),
});

export const DELETE = route(async (request: Request) => {
  assertSameOrigin(request);
  const session = await requireAdmin();

  const body = await request.json().catch(() => null);
  const parsed = removeSchema.safeParse(body);
  if (!parsed.success) throw invalid("Unknown platform.");

  const platform = parsed.data.platform as PlatformId;
  if (!PLATFORMS.includes(platform)) throw new ApiError("VALIDATION_FAILED", "Unknown platform.");

  await removeAppCredentials(platform, session.user.id);
  return NextResponse.json({ ok: true });
});
