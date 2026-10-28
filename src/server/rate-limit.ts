/**
 * Rate limiting.
 *
 * Redis-backed sliding window so the limit is shared across every web process.
 * If Redis is unavailable we fall back to an in-process counter rather than
 * failing open completely: a single process still enforces a limit, which stops
 * scripted password guessing even during a Redis outage.
 */

import Redis from "ioredis";

import { env } from "@/lib/env";

let client: Redis | null = null;

function redis(): Redis | null {
  if (client) return client;
  try {
    client = new Redis(env().REDIS_URL, {
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
      lazyConnect: false,
      retryStrategy: (times) => (times > 3 ? null : Math.min(times * 200, 1000)),
    });
    // Never let a Redis error take down a request path.
    client.on("error", () => undefined);
    return client;
  } catch {
    return null;
  }
}

interface MemoryEntry {
  count: number;
  resetAt: number;
}

const memory = new Map<string, MemoryEntry>();

function memoryHit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  const entry = memory.get(key);

  if (!entry || entry.resetAt <= now) {
    memory.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: limit - 1, resetAt: now + windowMs };
  }

  entry.count += 1;
  return {
    allowed: entry.count <= limit,
    remaining: Math.max(0, limit - entry.count),
    resetAt: entry.resetAt,
  };
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

export interface RateLimitOptions {
  /** Bucket name, e.g. "login" or "mutation". */
  bucket: string;
  /** Caller identity, e.g. an IP hash or user id. */
  identifier: string;
  limit: number;
  windowMs: number;
}

export async function rateLimit(options: RateLimitOptions): Promise<RateLimitResult> {
  const key = `rl:${options.bucket}:${options.identifier}`;
  const r = redis();

  if (!r || r.status !== "ready") {
    return memoryHit(key, options.limit, options.windowMs);
  }

  try {
    const windowStart = Date.now() - options.windowMs;

    // Sliding window: drop entries older than the window, add this hit, count.
    const pipeline = r.multi();
    pipeline.zremrangebyscore(key, 0, windowStart);
    pipeline.zadd(key, Date.now(), `${Date.now()}-${Math.random()}`);
    pipeline.zcard(key);
    pipeline.pexpire(key, options.windowMs);

    const results = await pipeline.exec();
    const count = (results?.[2]?.[1] as number | undefined) ?? 0;

    return {
      allowed: count <= options.limit,
      remaining: Math.max(0, options.limit - count),
      resetAt: Date.now() + options.windowMs,
    };
  } catch {
    // Redis went away mid-request: degrade to the in-process limit.
    return memoryHit(key, options.limit, options.windowMs);
  }
}

/** Standard policy per route class. */
export const LIMITS = {
  login: { limit: 10, windowMs: 60_000 },
  mutation: { limit: 60, windowMs: 60_000 },
  read: { limit: 300, windowMs: 60_000 },
  oauth: { limit: 20, windowMs: 60_000 },
} as const;

/** Test helper. */
export function resetRateLimits(): void {
  memory.clear();
}

export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit().catch(() => undefined);
    client = null;
  }
}
