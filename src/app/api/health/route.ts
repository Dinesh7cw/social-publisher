import { NextResponse } from "next/server";

import { route } from "@/server/http";
import { prisma } from "@/server/db";
import { platformFlags } from "@/lib/env";
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

  return NextResponse.json(
    {
      status: healthy ? "ok" : "degraded",
      database,
      redis,
      platforms: (["FACEBOOK", "INSTAGRAM", "LINKEDIN", "X"] as PlatformId[]).reduce(
        (acc, platform) => {
          acc[platform] = platformFlags[platform]() ? "enabled" : "disabled";
          return acc;
        },
        {} as Record<PlatformId, string>,
      ),
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
