/**
 * The publishing worker.
 *
 * A separate process from the web app for two reasons:
 *  - BullMQ consumers must not live in a request-serving process that can be
 *    scaled horizontally, or a job could be picked up twice.
 *  - A publishing stall must not take the UI down with it.
 *
 * Responsibilities:
 *  - consume publish jobs,
 *  - apply the retry policy (backoff, jitter, max attempts),
 *  - re-enqueue work that should exist but does not (the reconciler),
 *  - shut down gracefully without abandoning an in-flight publish.
 */

import { Worker, type Job } from "bullmq";

import { env } from "@/lib/env";
import { prisma } from "@/server/db";
import { logger } from "@/server/logger";
import { executePublish } from "@/server/services/publish";
import { enqueueTarget, PUBLISH_QUEUE, bullConnection, jobIdFor } from "@/server/queue/publish-queue";
import type { PublishJobData } from "@/server/queue/publish-queue";

const log = logger.child({ process: "worker" });

/** Exponential backoff with jitter, capped. */
function backoffMs(attemptNo: number, retryAfterSeconds?: number | null): number {
  if (retryAfterSeconds && retryAfterSeconds > 0) {
    // Respect the platform's own hint, but never wait longer than an hour.
    return Math.min(retryAfterSeconds * 1000, 60 * 60 * 1000);
  }

  // 30s, 2m, 8m, 32m — roughly ×4, capped.
  const base = 30_000;
  const raw = base * Math.pow(4, Math.max(0, attemptNo - 1));
  const capped = Math.min(raw, 60 * 60 * 1000);
  // ±20% jitter so a batch that failed together does not retry in lockstep.
  const jitter = capped * 0.2 * (Math.random() * 2 - 1);
  return Math.max(5_000, Math.round(capped + jitter));
}

async function handleJob(job: Job<PublishJobData>): Promise<void> {
  const { postTargetId, postId, clientId, attemptNo, requestId } = job.data;

  log.info({ postTargetId, postId, attemptNo, requestId }, "publish job started");

  // Reflect "actively running" in the mirror table.
  await prisma.scheduledJob
    .update({ where: { jobId: job.id! }, data: { state: "ACTIVE", attempts: { increment: 1 } } })
    .catch(() => undefined);

  const outcome = await executePublish({ postTargetId, attemptNo, requestId });

  if (!outcome) {
    // Not claimable: another worker has it, or it is terminal. Nothing to do.
    await prisma.scheduledJob
      .update({ where: { jobId: job.id! }, data: { state: "COMPLETED" } })
      .catch(() => undefined);
    return;
  }

  if (outcome.status === "FAILED_RETRYABLE") {
    // Only transient failures are retried automatically. Permanent, ambiguous and
    // auth failures all stop here and wait for a human.
    if (attemptNo < env().PUBLISH_MAX_ATTEMPTS) {
      const delay = backoffMs(attemptNo, outcome.retryAfterSeconds);

      log.info(
        { postTargetId, attemptNo, nextAttempt: attemptNo + 1, delayMs: delay },
        "scheduling automatic retry",
      );

      await enqueueTarget({
        postTargetId,
        postId,
        clientId,
        attemptNo: attemptNo + 1,
        requestId,
        delayMs: delay,
      });
    } else {
      log.warn(
        { postTargetId, attemptNo },
        "retry budget exhausted; leaving the target for the team",
      );

      // The target stays FAILED_RETRYABLE so the team can retry manually; the
      // UI labels it clearly. It is not silently promoted to permanent.
    }
  }

  await prisma.scheduledJob
    .update({
      where: { jobId: job.id! },
      data: { state: outcome.status === "PUBLISHED" ? "COMPLETED" : "FAILED" },
    })
    .catch(() => undefined);
}

/**
 * The reconciler.
 *
 * Covers the case where Redis lost data (eviction, a flush, a restore from an
 * older snapshot) but Postgres still knows a post should have gone out. Without
 * this, a scheduled post could silently never publish — the worst possible
 * outcome for an agency.
 */
async function reconcile(): Promise<void> {
  const cutoff = new Date(Date.now() - 2 * 60 * 1000); // 2 minutes late

  const stranded = await prisma.postTarget.findMany({
    where: {
      status: "QUEUED",
      updatedAt: { lt: cutoff },
      post: { status: { in: ["SCHEDULED", "PUBLISHING"] } },
    },
    include: { post: { select: { clientId: true, scheduledAt: true } } },
    take: 50,
  });

  for (const target of stranded) {
    const attemptNo =
      (
        await prisma.publishingAttempt.findFirst({
          where: { postTargetId: target.id },
          orderBy: { attemptNo: "desc" },
          select: { attemptNo: true },
        })
      )?.attemptNo ?? 0;

    // Is there a live job for it?
    const existing = await prisma.scheduledJob.findFirst({
      where: {
        postTargetId: target.id,
        state: { in: ["PENDING", "DELAYED", "ACTIVE"] },
      },
    });

    if (existing) continue;

    const nextAttempt = attemptNo + 1;

    log.warn(
      { postTargetId: target.id, nextAttempt },
      "reconciler re-enqueueing a stranded target",
    );

    await enqueueTarget({
      postTargetId: target.id,
      postId: target.postId,
      clientId: target.post.clientId,
      attemptNo: nextAttempt,
      requestId: `reconcile-${Date.now()}`,
    });
  }
}

async function main() {
  log.info(
    { queue: PUBLISH_QUEUE(), concurrency: env().WORKER_CONCURRENCY },
    "worker starting",
  );

  const worker = new Worker<PublishJobData>(PUBLISH_QUEUE(), handleJob, {
    connection: bullConnection(),
    concurrency: env().WORKER_CONCURRENCY,
    // A publish that has not finished in 5 minutes is stuck. BullMQ will mark it
    // failed and our claim logic keeps a redelivery from double-posting.
    lockDuration: 5 * 60 * 1000,
    maxStalledCount: 2,
  });

  worker.on("failed", (job, error) => {
    log.error(
      { jobId: job?.id, error: error.message },
      "job failed at the queue level",
    );
  });

  worker.on("error", (error) => {
    log.error({ error: error.message }, "worker error");
  });

  // Run the reconciler on boot and periodically.
  await reconcile().catch((error) => {
    log.error({ error: error instanceof Error ? error.message : "unknown" }, "initial reconcile failed");
  });

  const interval = setInterval(() => {
    reconcile().catch((error) => {
      log.error(
        { error: error instanceof Error ? error.message : "unknown" },
        "reconcile failed",
      );
    });
  }, 5 * 60 * 1000);

  // --- Graceful shutdown ---------------------------------------------------
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    log.info({ signal }, "worker shutting down; finishing in-flight jobs");

    clearInterval(interval);

    // close() waits for active jobs to finish. Jobs that were waiting stay in
    // Redis and are picked up on the next start, which is the whole point of a
    // persistent queue.
    await worker.close();
    await prisma.$disconnect();

    log.info("worker stopped");
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error) => {
  log.error({ error: error instanceof Error ? error.message : "unknown" }, "worker crashed on start");
  process.exit(1);
});

export { handleJob, backoffMs, reconcile, jobIdFor };
