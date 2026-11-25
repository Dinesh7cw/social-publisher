import { NextResponse } from "next/server";

import { route } from "@/server/http";
import { prisma } from "@/server/db";
import { resolveAppCredentials } from "@/server/services/platform-credentials";
import type { PlatformId } from "@/lib/domain";

export const dynamic = "force-dynamic";

/**
 * Health check.
 *
 * Unauthenticated by design so a load balancer can reach it, and deliberately
 * vague: it reports reachability, never versions, hosts or error text that would
 * help an attacker map the stack.
 */
export const GET = route(async () => {
  const [database, redis] = await Promise.all([
    prisma
      .$queryRaw`SELECT 1`
      .then(() => "ok" as const)
      .catch(() => "down" as const),
    checkRedis(),
  ]);

  const healthy = database === "ok" && redis === "ok";

  const platforms = await Promise.all(
    (["FACEBOOK", "INSTAGRAM", "LINKEDIN", "X"] as PlatformId[]).map(async (platform) => {
      const configured = (await resolveAppCredentials(platform)) !== null;
      return [platform, configured ? "enabled" : "disabled"] as const;
    }),
  );

  return NextResponse.json(
    {
      status: healthy ? "ok" : "degraded",
      database,
      redis,
      platforms: Object.fromEntries(platforms) as Record<PlatformId, string>,
    },
    { status: healthy ? 200 : 503 },
  );
});

async function checkRedis(): Promise<"ok" | "down"> {
  try {
    const Redis = (await import("ioredis")).default;
    const client = new Redis(process.env.REDIS_URL ?? "", {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 1500,
    });
    await client.connect();
    const pong = await client.ping();
    await client.quit();
    return pong === "PONG" ? "ok" : "down";
  } catch {
    return "down";
  }
}
