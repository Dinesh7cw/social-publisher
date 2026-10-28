/**
 * Queue configuration and enqueueing.
 *
 * BullMQ is the transport, but Postgres remains the system of record. Every job
 * carries a `ScheduledJob` row so that:
 *   - the calendar can render without reading Redis,
 *   - a job lost from Redis can be found and re-enqueued,
 *   - the team can see a post that "should" be publishing but is not.
 *
 * Idempotency: the job id is derived from the target and the attempt number, so
 * enqueueing the same work twice is impossible. This is the first of the four
 * duplicate-prevention layers described in docs/ARCHITECTURE.md.
 */

import { Queue, type JobsOptions } from "bullmq";
import Redis from "ioredis";

import { env } from "@/lib/env";
import { prisma } from "@/server/db";

export const PUBLISH_QUEUE = () => env().PUBLISH_QUEUE_NAME;

export interface PublishJobData {
  postTargetId: string;
  postId: string;
  clientId: string;
  attemptNo: number;
  /** Recorded for tracing; also present on the attempt row. */
  requestId: string;
}

let connection: Redis | null = null;
let queue: Queue<PublishJobData> | null = null;

/**
 * The Redis connection used by BullMQ.
 *
 * BullMQ requires `maxRetriesPerRequest: null` on its blocking connections,
 * which is why this is separate from the rate limiter's client.
 */
export function bullConnection(): Redis {
  if (connection) return connection;

  connection = new Redis(env().REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    retryStrategy: (times) => Math.min(times * 200, 3000),
  });

  return connection;
}

export function publishQueue(): Queue<PublishJobData> {
  if (queue) return queue;

  queue = new Queue<PublishJobData>(PUBLISH_QUEUE(), {
    connection: bullConnection(),
    defaultJobOptions: {
      // Retries are handled by our own policy (which distinguishes transient from
      // permanent and ambiguous), so BullMQ's automatic retry is disabled: a
      // second automatic attempt could duplicate a post.
      attempts: 1,
      removeOnComplete: { age: 60 * 60 * 24, count: 1000 },
      removeOnFail: { age: 60 * 60 * 24 * 7, count: 5000 },
    },
  });

  return queue;
}

/** Stable, deterministic job id. Deterministic ids are what make re-enqueue safe. */
export function jobIdFor(postTargetId: string, attemptNo: number): string {
  return `publish:${postTargetId}:${attemptNo}`;
}

/**
 * Enqueue one target for immediate publishing.
 *
 * `delayMs` postpones the first attempt, which is how scheduled publishing is
 * implemented: one queue, one code path, with time expressed as a delay.
 */
export async function enqueueTarget(params: {
  postTargetId: string;
  postId: string;
  clientId: string;
  attemptNo: number;
  requestId: string;
  delayMs?: number;
}): Promise<{ jobId: string; runAt: Date }> {
  const jobId = jobIdFor(params.postTargetId, params.attemptNo);
  const delayMs = Math.max(0, params.delayMs ?? 0);
  const runAt = new Date(Date.now() + delayMs);

  const options: JobsOptions = {
    jobId,
    ...(delayMs > 0 ? { delay: delayMs } : {}),
    // A scheduled job that was delayed is still removed on completion, so the
    // queue does not grow without bound.
    removeOnComplete: { age: 60 * 60 * 24, count: 1000 },
  };

  await publishQueue().add(
    "publish-target",
    {
      postTargetId: params.postTargetId,
      postId: params.postId,
      clientId: params.clientId,
      attemptNo: params.attemptNo,
      requestId: params.requestId,
    },
    options,
  );

  // Mirror the schedule into Postgres so the system of record is complete even
  // if Redis is lost.
  await prisma.scheduledJob.upsert({
    where: { jobId },
    create: {
      postTargetId: params.postTargetId,
      jobId,
      runAt,
      state: delayMs > 0 ? "DELAYED" : "PENDING",
      attempts: 0,
    },
    update: {
      runAt,
      state: delayMs > 0 ? "DELAYED" : "PENDING",
    },
  });

  return { jobId, runAt };
}

/** Remove a not-yet-run job. Used by cancellation and rescheduling. */
export async function cancelJob(jobId: string): Promise<void> {
  const job = await publishQueue().getJob(jobId);
  if (job) {
    // Only a delayed/waiting job can be removed; a job already being processed
    // will finish, and the worker's claim check prevents a duplicate publish.
    await job.remove().catch(() => undefined);
  }

  await prisma.scheduledJob
    .update({ where: { jobId }, data: { state: "CANCELLED" } })
    .catch(() => undefined);
}

export async function closeQueue(): Promise<void> {
  if (queue) {
    await queue.close();
    queue = null;
  }
  if (connection) {
    await connection.quit().catch(() => undefined);
    connection = null;
  }
}
