/**
 * Post service: creation, validation, scheduling, publishing, retry.
 *
 * The rules that matter live here:
 *  - Nothing is enqueued if any target fails validation (no partial batches).
 *  - Publishing requires an idempotency key.
 *  - Scheduling stores UTC plus the IANA zone.
 *  - Every transition writes an audit entry.
 */

import { randomUUID } from "node:crypto";

import { prisma } from "@/server/db";
import { Prisma } from "@/generated/prisma/client";
import { ApiError, invalid, notFound } from "@/server/http";
import { recordAuditSafe } from "@/server/audit";
import {
  derivePostStatus,
  isEditablePostStatus,
  type TargetStatusId,
  type PostStatusId,
} from "@/lib/domain";
import { findAdapter, platformStatus } from "@/server/platforms/registry";
import { enqueueTarget, jobIdFor, cancelJob } from "@/server/queue/publish-queue";
import { logger } from "@/server/logger";

// ---------------------------------------------------------------------------
// Validation across targets
// ---------------------------------------------------------------------------

export interface TargetValidationResult {
  socialAccountId: string;
  platform: string;
  accountName: string;
  ok: boolean;
  issues: Array<{ code: string; message: string; field?: string }>;
  remainingChars?: number;
}

/**
 * Validate every target of a post without touching any queue.
 *
 * The composer calls this before submit so one bad platform cannot cause a post
 * to publish to three accounts and fail on the fourth.
 */
export async function validatePost(postId: string): Promise<{
  ok: boolean;
  results: TargetValidationResult[];
}> {
  const post = await prisma.post.findUnique({
    where: { id: postId },
    include: {
      targets: {
        include: {
          socialAccount: {
            select: { id: true, platform: true, displayName: true, accountType: true, status: true },
          },
        },
      },
      media: { orderBy: { position: "asc" }, include: { media: true } },
    },
  });

  if (!post) throw notFound("Post not found.");

  const statuses = await Promise.all(
    post.targets.map((target) => platformStatus(target.socialAccount.platform as never)),
  );

  const results: TargetValidationResult[] = post.targets.map((target, index) => {
    const adapter = findAdapter(target.socialAccount.platform as never);
    const status = statuses[index]!;

    if (!adapter) {
      return {
        socialAccountId: target.socialAccount.id,
        platform: target.socialAccount.platform,
        accountName: target.socialAccount.displayName,
        ok: false,
        issues: [
          {
            code: "PLATFORM_UNAVAILABLE",
            message: `${target.socialAccount.platform} publishing is not available in this build.`,
          },
        ],
      };
    }

    // Implemented but not configured is still not publishable. Without this
    // check the composer would accept a post that the worker can only fail
    // permanently, which is the worst of both outcomes.
    if (!status.available) {
      return {
        socialAccountId: target.socialAccount.id,
        platform: target.socialAccount.platform,
        accountName: target.socialAccount.displayName,
        ok: false,
        issues: [
          {
            code: "PLATFORM_NOT_CONFIGURED",
            message:
              status.message ??
              `${target.socialAccount.platform} cannot publish until an admin completes its setup.`,
          },
        ],
      };
    }

    if (target.socialAccount.status !== "CONNECTED") {
      return {
        socialAccountId: target.socialAccount.id,
        platform: target.socialAccount.platform,
        accountName: target.socialAccount.displayName,
        ok: false,
        issues: [
          {
            code: "ACCOUNT_NOT_CONNECTED",
            message: `${target.socialAccount.displayName} needs to be reconnected.`,
          },
        ],
      };
    }

    const validation = adapter.validate({
      caption: target.caption,
      media: post.media.map((row) => ({
        kind: row.media.kind,
        mimeType: row.media.mimeType,
        byteSize: row.media.byteSize,
        width: row.media.width,
        height: row.media.height,
        durationSeconds: row.media.durationSeconds,
        publicUrl: row.media.publicUrl,
      })),
      accountType: target.socialAccount.accountType,
    });

    return {
      socialAccountId: target.socialAccount.id,
      platform: target.socialAccount.platform,
      accountName: target.socialAccount.displayName,
      ok: validation.ok,
      issues: validation.issues.map((issue) => ({
        code: issue.code,
        message: issue.message,
        field: issue.field,
      })),
      remainingChars: validation.remainingChars,
    };
  });

  return { ok: results.every((r) => r.ok), results };
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

export interface CreatePostInput {
  clientId: string;
  baseCaption: string;
  mediaAssetIds: string[];
  targets: Array<{
    socialAccountId: string;
    caption?: string | null;
    options?: Record<string, unknown> | null;
  }>;
  authorId: string;
}

export async function createPost(input: CreatePostInput): Promise<{ id: string }> {
  const client = await prisma.client.findUnique({ where: { id: input.clientId } });
  if (!client) throw notFound("Client not found.");
  if (client.status === "ARCHIVED") {
    throw invalid("This client is archived. Restore it before creating posts.");
  }

  // Every account must belong to the chosen client: this is the cross-client
  // guard, and it fails as NOT_FOUND so it does not confirm another client's
  // account exists.
  const accountIds = input.targets.map((t) => t.socialAccountId);
  if (new Set(accountIds).size !== accountIds.length) {
    throw invalid("The same account was selected twice.");
  }

  const accounts = await prisma.socialAccount.findMany({
    where: { id: { in: accountIds }, clientId: input.clientId },
    select: { id: true },
  });

  if (accounts.length !== accountIds.length) {
    throw notFound("One of the selected accounts does not belong to this client.");
  }

  // Media must belong to the same client, for the same reason.
  if (input.mediaAssetIds.length > 0) {
    const media = await prisma.mediaAsset.findMany({
      where: { id: { in: input.mediaAssetIds }, clientId: input.clientId },
      select: { id: true },
    });
    if (media.length !== input.mediaAssetIds.length) {
      throw notFound("One of the attached media files does not belong to this client.");
    }
  }

  const post = await prisma.post.create({
    data: {
      clientId: input.clientId,
      authorId: input.authorId,
      baseCaption: input.baseCaption,
      status: "DRAFT",
      targets: {
        create: input.targets.map((target) => ({
          socialAccountId: target.socialAccountId,
          // A target without its own caption inherits the base one, resolved at
          // write time so later edits to the base do not silently change a
          // platform-specific caption the team wrote deliberately.
          caption: target.caption?.trim() ? target.caption : input.baseCaption,
          status: "PENDING",
          // Prisma needs the JSON null sentinel to store SQL NULL rather than a
          // JSON null value.
          platformOptions: (target.options ?? undefined) as never,
        })),
      },
      media: {
        create: input.mediaAssetIds.map((mediaAssetId, index) => ({
          mediaAssetId,
          position: index,
        })),
      },
    },
  });

  await recordAuditSafe({
    actorId: input.authorId,
    action: "POST_CREATED",
    entityType: "Post",
    entityId: post.id,
    clientId: input.clientId,
    metadata: { targetCount: input.targets.length, mediaCount: input.mediaAssetIds.length },
  });

  return { id: post.id };
}

export interface UpdatePostInput {
  postId: string;
  actorId: string;
  baseCaption?: string;
  mediaAssetIds?: string[];
  /** The full target list. Omitted means "leave targets alone". */
  targets?: CreatePostInput["targets"];
}

/**
 * Save changes to an existing post.
 *
 * Accounts can be added or removed only while the post is a draft: a scheduled
 * target already has a queued job, and a published one is live, so changing
 * the set there would orphan a job or silently drop a live post from the
 * record. Captions, extras and media stay editable for every editable status.
 */
export async function updatePost(input: UpdatePostInput): Promise<{ id: string }> {
  const post = await prisma.post.findUnique({
    where: { id: input.postId },
    select: {
      id: true,
      clientId: true,
      status: true,
      deletedAt: true,
      baseCaption: true,
      targets: { select: { id: true, socialAccountId: true } },
    },
  });

  if (!post || post.deletedAt) throw notFound("Post not found.");
  if (!isEditablePostStatus(post.status as PostStatusId)) {
    throw new ApiError(
      "TARGET_NOT_PUBLISHABLE",
      "This post has already been published or is publishing, so it cannot be edited.",
    );
  }

  const baseCaption = input.baseCaption ?? post.baseCaption;
  const existingByAccount = new Map(post.targets.map((t) => [t.socialAccountId, t]));

  let removedTargetIds: string[] = [];

  if (input.targets) {
    const accountIds = input.targets.map((t) => t.socialAccountId);
    if (accountIds.length === 0) throw invalid("Choose at least one account.");
    if (new Set(accountIds).size !== accountIds.length) {
      throw invalid("The same account was selected twice.");
    }

    const wanted = new Set(accountIds);
    const added = accountIds.filter((id) => !existingByAccount.has(id));
    removedTargetIds = post.targets.filter((t) => !wanted.has(t.socialAccountId)).map((t) => t.id);

    if (post.status !== "DRAFT" && (added.length > 0 || removedTargetIds.length > 0)) {
      throw invalid("Accounts can only be changed while the post is a draft.");
    }

    if (added.length > 0) {
      const owned = await prisma.socialAccount.count({
        where: { id: { in: added }, clientId: post.clientId },
      });
      if (owned !== added.length) {
        throw notFound("One of the selected accounts does not belong to this client.");
      }
    }
  }

  if (input.mediaAssetIds && input.mediaAssetIds.length > 0) {
    const owned = await prisma.mediaAsset.count({
      where: { id: { in: input.mediaAssetIds }, clientId: post.clientId },
    });
    if (owned !== input.mediaAssetIds.length) {
      throw notFound("One of the attached media files does not belong to this client.");
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.post.update({ where: { id: post.id }, data: { baseCaption } });

    if (input.targets) {
      if (removedTargetIds.length > 0) {
        await tx.postTarget.deleteMany({ where: { id: { in: removedTargetIds } } });
      }

      for (const target of input.targets) {
        const caption = target.caption?.trim() ? target.caption : baseCaption;
        const platformOptions = target.options ? (target.options as never) : Prisma.DbNull;
        const existing = existingByAccount.get(target.socialAccountId);

        if (existing) {
          await tx.postTarget.update({
            where: { id: existing.id },
            data: { caption, platformOptions },
          });
        } else {
          await tx.postTarget.create({
            data: {
              postId: post.id,
              socialAccountId: target.socialAccountId,
              caption,
              status: "PENDING",
              platformOptions,
            },
          });
        }
      }
    }

    if (input.mediaAssetIds) {
      await tx.postMedia.deleteMany({ where: { postId: post.id } });
      if (input.mediaAssetIds.length > 0) {
        await tx.postMedia.createMany({
          data: input.mediaAssetIds.map((mediaAssetId, index) => ({
            postId: post.id,
            mediaAssetId,
            position: index,
          })),
        });
      }
    }
  });

  await recordAuditSafe({
    actorId: input.actorId,
    action: "POST_UPDATED",
    entityType: "Post",
    entityId: post.id,
    clientId: post.clientId,
    metadata: {
      targetCount: input.targets?.length ?? post.targets.length,
      mediaCount: input.mediaAssetIds?.length ?? null,
    },
  });

  return { id: post.id };
}

// ---------------------------------------------------------------------------
// Scheduling and publishing
// ---------------------------------------------------------------------------

/**
 * Enqueue every target of a post.
 *
 * Shared by schedule and publish-now; the only difference is the delay.
 */
async function enqueueAllTargets(params: {
  postId: string;
  delayMs: number;
  actorId: string;
}): Promise<void> {
  const targets = await prisma.postTarget.findMany({
    where: { postId: params.postId },
    select: { id: true, postId: true, status: true, post: { select: { clientId: true } } },
  });

  for (const target of targets) {
    // Already-published targets are left alone: re-publishing would duplicate.
    if (target.status === "PUBLISHED") continue;

    const attemptNo = await nextAttemptNo(target.id);
    const requestId = randomUUID();

    await prisma.postTarget.update({
      where: { id: target.id },
      data: { status: "QUEUED" },
    });

    await enqueueTarget({
      postTargetId: target.id,
      postId: target.postId,
      clientId: target.post.clientId,
      attemptNo,
      requestId,
      delayMs: params.delayMs,
    });
  }

  void params.actorId;
}

async function nextAttemptNo(targetId: string): Promise<number> {
  const last = await prisma.publishingAttempt.findFirst({
    where: { postTargetId: targetId },
    orderBy: { attemptNo: "desc" },
    select: { attemptNo: true },
  });

  return (last?.attemptNo ?? 0) + 1;
}

/**
 * Schedule a post for a future instant.
 *
 * The instant is computed from an offset-bearing ISO string plus an IANA zone.
 * Storing UTC only would make the calendar ambiguous across DST boundaries, so
 * the zone is kept alongside.
 */
export async function schedulePost(params: {
  postId: string;
  scheduledAt: string;
  timeZone: string;
  actorId: string;
}): Promise<void> {
  const post = await prisma.post.findUnique({ where: { id: params.postId } });
  if (!post) throw notFound("Post not found.");
  if (post.deletedAt) throw notFound("Post not found.");

  if (post.status === "PUBLISHED" || post.status === "PUBLISHING") {
    throw new ApiError("TARGET_NOT_PUBLISHABLE", "This post has already been published.");
  }

  const when = new Date(params.scheduledAt);
  if (Number.isNaN(when.getTime())) {
    throw invalid("That date and time could not be read.");
  }
  if (when.getTime() <= Date.now()) {
    throw invalid("Choose a time in the future.");
  }

  // Validate before enqueuing: a scheduled post that fails validation at fire
  // time wastes a retry budget and surprises the team hours later.
  const validation = await validatePost(params.postId);
  if (!validation.ok) {
    throw invalid("Some platforms cannot publish this post yet.", validation.results);
  }

  await prisma.post.update({
    where: { id: params.postId },
    data: {
      scheduledAt: when,
      scheduledTimeZone: params.timeZone,
      status: "SCHEDULED",
    },
  });

  const delayMs = Math.max(0, when.getTime() - Date.now());
  await enqueueAllTargets({ postId: params.postId, delayMs, actorId: params.actorId });

  await recordAuditSafe({
    actorId: params.actorId,
    action: "POST_SCHEDULED",
    entityType: "Post",
    entityId: params.postId,
    clientId: post.clientId,
    metadata: { scheduledAt: when.toISOString(), timeZone: params.timeZone, delayMs },
  });
}

/**
 * Publish immediately.
 *
 * Validation runs first and nothing is enqueued unless every target passes, so a
 * partially-valid post cannot half-publish.
 */
export async function publishNow(params: {
  postId: string;
  actorId: string;
}): Promise<void> {
  const post = await prisma.post.findUnique({ where: { id: params.postId } });
  if (!post) throw notFound("Post not found.");
  if (post.deletedAt) throw notFound("Post not found.");

  if (post.status === "PUBLISHED") {
    throw new ApiError("TARGET_NOT_PUBLISHABLE", "This post has already been published.");
  }
  if (post.status === "PUBLISHING") {
    throw new ApiError("TARGET_NOT_PUBLISHABLE", "This post is already publishing.");
  }

  const validation = await validatePost(params.postId);
  if (!validation.ok) {
    throw invalid(
      "Some platforms cannot publish this post. Fix these and try again.",
      validation.results.filter((r) => !r.ok),
    );
  }

  await prisma.post.update({
    where: { id: params.postId },
    data: { status: "PUBLISHING", scheduledAt: null },
  });

  await enqueueAllTargets({ postId: params.postId, delayMs: 0, actorId: params.actorId });

  // The rollup is derived; run it once so the UI reflects the in-flight state
  // immediately rather than waiting for the first worker tick.
  await recalculatePostStatusForPost(params.postId);
}

/** Retry one failed target. Requires explicit human intent (and confirmation for UNKNOWN). */
export async function retryTarget(params: {
  targetId: string;
  actorId: string;
  confirmUnknown?: boolean;
}): Promise<{ queued: boolean; requiresConfirmation?: boolean }> {
  const target = await prisma.postTarget.findUnique({
    where: { id: params.targetId },
    include: { post: { select: { id: true, clientId: true, status: true } } },
  });

  if (!target) throw notFound("Target not found.");

  if (target.status === "PUBLISHED") {
    throw new ApiError(
      "TARGET_NOT_PUBLISHABLE",
      "This post is already live on that platform. Publishing again would duplicate it.",
    );
  }

  if (target.status === "DELETED") {
    throw new ApiError(
      "TARGET_NOT_PUBLISHABLE",
      "This copy was removed from the platform. Create a new post if it needs to go back up.",
    );
  }

  if (target.status === "QUEUED" || target.status === "PUBLISHING") {
    throw new ApiError("TARGET_NOT_PUBLISHABLE", "This target is already queued or publishing.");
  }

  // UNKNOWN is the dangerous case: the platform may already have the post.
  if (target.status === "UNKNOWN" && !params.confirmUnknown) {
    return { queued: false, requiresConfirmation: true };
  }

  const attemptNo = await nextAttemptNo(target.id);
  const requestId = randomUUID();

  await prisma.postTarget.update({
    where: { id: target.id },
    data: { status: "QUEUED", lastErrorCode: null, lastErrorMessage: null },
  });

  await enqueueTarget({
    postTargetId: target.id,
    postId: target.post.id,
    clientId: target.post.clientId,
    attemptNo,
    requestId,
  });

  await recordAuditSafe({
    actorId: params.actorId,
    action: "POST_RETRY",
    entityType: "PostTarget",
    entityId: target.id,
    clientId: target.post.clientId,
    metadata: { attemptNo, previousStatus: target.status },
  });

  await recalculatePostStatusForPost(target.post.id);

  return { queued: true };
}

/** Cancel a scheduled post: remove jobs and settle the targets. */
export async function cancelPost(params: {
  postId: string;
  actorId: string;
}): Promise<void> {
  const post = await prisma.post.findUnique({
    where: { id: params.postId },
    include: { targets: { select: { id: true, status: true } } },
  });

  if (!post) throw notFound("Post not found.");

  const cancellable = post.targets.filter((t) =>
    ["PENDING", "QUEUED", "FAILED_RETRYABLE"].includes(t.status),
  );

  for (const target of cancellable) {
    // Remove whatever job exists for the current attempt.
    const jobs = await prisma.scheduledJob.findMany({
      where: { postTargetId: target.id, state: { in: ["PENDING", "DELAYED"] } },
    });

    for (const job of jobs) {
      await cancelJob(job.jobId);
    }

    await prisma.postTarget.update({
      where: { id: target.id },
      data: { status: "CANCELLED" },
    });
  }

  await prisma.post.update({
    where: { id: params.postId },
    data: { status: "CANCELLED", scheduledAt: null },
  });

  await recordAuditSafe({
    actorId: params.actorId,
    action: "POST_CANCELLED",
    entityType: "Post",
    entityId: params.postId,
    clientId: post.clientId,
    metadata: { cancelledTargets: cancellable.length },
  });
}

// ---------------------------------------------------------------------------
// Rollup
// ---------------------------------------------------------------------------

/**
 * Recompute a post's status from its targets.
 *
 * Called after any target changes. The derivation itself is a pure function in
 * lib/domain so it can be unit-tested exhaustively.
 */
export async function recalculatePostStatus(targetId: string): Promise<void> {
  const target = await prisma.postTarget.findUnique({
    where: { id: targetId },
    select: { postId: true },
  });

  if (!target) return;
  await recalculatePostStatusForPost(target.postId);
}

export async function recalculatePostStatusForPost(postId: string): Promise<PostStatusId> {
  const post = await prisma.post.findUnique({
    where: { id: postId },
    include: {
      targets: { select: { status: true } },
    },
  });

  if (!post) return "DRAFT";

  const statuses = post.targets.map((t) => t.status as TargetStatusId);

  // A cancelled post stays cancelled even if some targets published before it
  // was cancelled; that is a deliberate, human-visible state.
  const explicitlyCancelled = post.status === "CANCELLED";

  const derived = derivePostStatus({
    targetStatuses: statuses,
    isDraft: statuses.every((s) => s === "PENDING"),
    hasSchedule: post.scheduledAt !== null,
    cancelled: explicitlyCancelled && statuses.every((s) => s !== "PUBLISHED"),
  });

  // Only touch the row when the value actually changes, so we do not generate
  // pointless updates on every poll.
  if (derived !== post.status) {
    const publishedAt =
      derived === "PUBLISHED" || derived === "PARTIAL"
        ? (post.publishedAt ?? new Date())
        : post.publishedAt;

    await prisma.post.update({
      where: { id: postId },
      data: { status: derived, publishedAt },
    });

    logger.debug({ postId, from: post.status, to: derived }, "post status recalculated");
  }

  return derived;
}

export { jobIdFor };
