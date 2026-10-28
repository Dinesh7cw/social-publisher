import { describe, expect, it, afterAll } from "vitest";
import { Queue } from "bullmq";
import Redis from "ioredis";

import { testDb, makeTwoClientsWithAccounts } from "../setup/db";
import { createPost } from "@/server/services/posts";
import { enqueueTarget, jobIdFor, PUBLISH_QUEUE, closeQueue } from "@/server/queue/publish-queue";

/**
 * Queue durability.
 *
 * The brief requires that scheduled jobs survive an application restart. That is a
 * property of Redis AOF plus a deterministic job id, not of any code path, so the
 * honest test is: put a delayed job in the queue, close the connection entirely
 * (simulating a process exit), reconnect with a *fresh* client, and find the job
 * still there with its delay intact.
 */

const connection = () => new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });

let cleanup: Queue | null = null;

afterAll(async () => {
  await closeQueue();
  if (cleanup) await cleanup.close();
});

describe("scheduled job persistence", () => {
  it("keeps a delayed job after the queue connection is closed and reopened", async () => {
    const { user, clientA, accountA } = await makeTwoClientsWithAccounts();
    const db = testDb();

    const { id: postId } = await createPost({
      clientId: clientA.id,
      baseCaption: "Scheduled for tomorrow",
      mediaAssetIds: [],
      targets: [{ socialAccountId: accountA.id }],
      authorId: user.id,
    });

    const target = await db.postTarget.findFirst({ where: { postId } });
    await db.postTarget.update({ where: { id: target!.id }, data: { status: "QUEUED" } });

    const delayMs = 6 * 60 * 60 * 1000; // six hours from now

    const { jobId, runAt } = await enqueueTarget({
      postTargetId: target!.id,
      postId,
      clientId: clientA.id,
      attemptNo: 1,
      requestId: "persist-test",
      delayMs,
    });

    expect(jobId).toBe(jobIdFor(target!.id, 1));

    // The mirror row exists, which is the system of record.
    const scheduled = await db.scheduledJob.findUnique({ where: { jobId } });
    expect(scheduled).not.toBeNull();
    expect(scheduled?.state).toBe("DELAYED");

    // Simulate a full restart: tear down every connection this process holds.
    await closeQueue();

    // Reconnect with a fresh client, as a new process would.
    const freshQueue = new Queue(PUBLISH_QUEUE(), { connection: connection() });
    cleanup = freshQueue;

    const job = await freshQueue.getJob(jobId);

    expect(job).toBeDefined();
    expect(job?.id).toBe(jobId);

    // The job is delayed, not lost.
    const state = await job!.getState();
    expect(["delayed", "waiting"]).toContain(state);

    // And its intended fire time is preserved (within a second of what we asked).
    expect(Math.abs((job!.opts.delay ?? 0) - delayMs)).toBeLessThan(2000);

    // The payload still identifies the exact target.
    expect(job!.data.postTargetId).toBe(target!.id);
    expect(job!.data.attemptNo).toBe(1);

    await freshQueue.close();
    cleanup = null;
    void runAt;
  });

  it("cannot enqueue the same target and attempt twice", async () => {
    const { user, clientA, accountA } = await makeTwoClientsWithAccounts();
    const db = testDb();

    const { id: postId } = await createPost({
      clientId: clientA.id,
      baseCaption: "Idempotent enqueue",
      mediaAssetIds: [],
      targets: [{ socialAccountId: accountA.id }],
      authorId: user.id,
    });

    const target = await db.postTarget.findFirst({ where: { postId } });

    const first = await enqueueTarget({
      postTargetId: target!.id,
      postId,
      clientId: clientA.id,
      attemptNo: 1,
      requestId: "a",
    });

    // Same target, same attempt: BullMQ de-duplicates on job id, so this must not
    // create a second job.
    const second = await enqueueTarget({
      postTargetId: target!.id,
      postId,
      clientId: clientA.id,
      attemptNo: 1,
      requestId: "b",
    });

    expect(second.jobId).toBe(first.jobId);

    const queue = new Queue(PUBLISH_QUEUE(), { connection: connection() });
    cleanup = queue;

    const jobs = await queue.getJobs(["waiting", "delayed", "active"]);
    const matching = jobs.filter((job) => job.id === first.jobId);

    expect(matching).toHaveLength(1);

    await queue.close();
    cleanup = null;

    // Clean up this job so it does not leak into another test's queue state.
    await closeQueue();
  });
});
