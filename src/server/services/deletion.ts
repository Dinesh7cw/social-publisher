/**
 * Deleting posts.
 *
 * There are two separate ideas here, and conflating them is what makes this
 * feature dangerous:
 *
 *  1. **Remove from the app.** Always available, for any post in any state.
 *     The row is kept with `deletedAt` set so the audit trail survives and a
 *     forgotten platform id can still be found later.
 *  2. **Remove from the platform.** Only possible once a target has actually
 *     published and only when the adapter supports it. This is irreversible, so
 *     the platform is asked first and the app is only updated from a confirmed
 *     answer — never optimistically.
 *
 * A partial failure is reported per target rather than as one opaque error: if
 * Instagram refuses and LinkedIn succeeds, the team needs to know exactly which
 * copy is still live.
 */

import { prisma } from "@/server/db";
import { ApiError, notFound } from "@/server/http";
import { logger } from "@/server/logger";
import { recordAuditSafe } from "@/server/audit";
import { getAccountCredentials } from "@/server/auth/token-access";
import { findAdapter } from "@/server/platforms/registry";
import { PlatformError } from "@/server/platforms/types";
import { cancelJob } from "@/server/queue/publish-queue";
import { recalculatePostStatusForPost } from "@/server/services/posts";
import { randomUUID } from "node:crypto";

export interface RemoteDeleteFailure {
  targetId: string;
  platform: string;
  accountName: string;
  message: string;
}

export interface RemoteDeleteOutcome {
  deleted: Array<{ targetId: string; platform: string; accountName: string }>;
  failed: RemoteDeleteFailure[];
}

/**
 * Delete one published target from its platform.
 *
 * Throws on failure so a single-target action has a single clear error.
 */
export async function deleteTargetFromPlatform(params: {
  postId: string;
  targetId: string;
  actorId: string;
}): Promise<{ ok: true }> {
  const target = await prisma.postTarget.findUnique({
    where: { id: params.targetId },
    include: {
      post: { select: { id: true, clientId: true, deletedAt: true } },
      socialAccount: { select: { id: true, platform: true, displayName: true } },
    },
  });

  if (!target || target.postId !== params.postId) throw notFound("Target not found.");

  if (target.status === "DELETED") {
    // Idempotent: asking twice is not an error, it is the desired state.
    return { ok: true };
  }

  if (!target.platformPostId) {
    throw new ApiError(
      "TARGET_NOT_PUBLISHABLE",
      "This account never published, so there is nothing to remove from the platform.",
    );
  }

  const adapter = findAdapter(target.socialAccount.platform as never);
  if (!adapter) {
    throw new ApiError(
      "PLATFORM_DISABLED",
      `${target.socialAccount.platform} is not available on this deployment.`,
    );
  }
  if (!adapter.deletePublished || !adapter.capabilities.supportsDelete) {
    throw new ApiError(
      "PLATFORM_DELETE_UNSUPPORTED",
      `${target.socialAccount.platform} does not allow deleting posts through the API. Remove it on the platform itself.`,
    );
  }

  const credentials = await getAccountCredentials(target.socialAccount.id);

  const result = await adapter.deletePublished({
    platformPostId: target.platformPostId,
    externalId: credentials.externalId,
    accountType: credentials.accountType,
    accessToken: credentials.accessToken,
    userAccessToken: credentials.userAccessToken,
    requestId: `delete:${target.id}:${randomUUID()}`,
  });

  if (!result.ok) {
    logger.warn(
      { targetId: target.id, code: result.error.code, errorClass: result.error.errorClass },
      "platform refused to delete the post",
    );
    throw new ApiError("PLATFORM_DELETE_FAILED", result.error.userMessage);
  }

  await prisma.postTarget.update({
    where: { id: target.id },
    data: {
      status: "DELETED",
      deletedAt: new Date(),
      lastErrorCode: null,
      lastErrorMessage: null,
    },
  });

  await recordAuditSafe({
    actorId: params.actorId,
    action: "POST_UNPUBLISHED",
    entityType: "PostTarget",
    entityId: target.id,
    clientId: target.post.clientId,
    metadata: {
      postId: target.postId,
      platform: target.socialAccount.platform,
      accountName: target.socialAccount.displayName,
      platformPostId: target.platformPostId,
    },
  });

  await recalculatePostStatusForPost(target.post.id);

  return { ok: true };
}

/** Attempt every published target, collecting failures instead of stopping. */
async function deleteAllFromPlatforms(params: {
  postId: string;
  actorId: string;
}): Promise<RemoteDeleteOutcome> {
  const targets = await prisma.postTarget.findMany({
    where: {
      postId: params.postId,
      platformPostId: { not: null },
      status: { in: ["PUBLISHED", "UNKNOWN"] },
    },
    include: {
      socialAccount: { select: { platform: true, displayName: true } },
    },
  });

  const outcome: RemoteDeleteOutcome = { deleted: [], failed: [] };

  for (const target of targets) {
    try {
      await deleteTargetFromPlatform({
        postId: params.postId,
        targetId: target.id,
        actorId: params.actorId,
      });
      outcome.deleted.push({
        targetId: target.id,
        platform: target.socialAccount.platform,
        accountName: target.socialAccount.displayName,
      });
    } catch (error) {
      outcome.failed.push({
        targetId: target.id,
        platform: target.socialAccount.platform,
        accountName: target.socialAccount.displayName,
        message:
          error instanceof ApiError
            ? error.message
            : error instanceof PlatformError
              ? error.userMessage
              : "That copy could not be removed from the platform.",
      });
    }
  }

  return outcome;
}

/**
 * Delete a post from the app.
 *
 * Queued work is cancelled first, so nothing can be published between the
 * decision and the delete. The platform copies are attempted next when asked
 * for, and the row is soft-deleted either way: a platform that refuses must not
 * stop the team from clearing the post out of their own workspace.
 */
export async function deletePost(params: {
  postId: string;
  actorId: string;
  removeFromPlatforms: boolean;
}): Promise<{
  appDeleted: true;
  remote: RemoteDeleteOutcome | null;
}> {
  const post = await prisma.post.findUnique({
    where: { id: params.postId },
    include: {
      targets: { select: { id: true, status: true } },
    },
  });

  if (!post) throw notFound("Post not found.");
  if (post.deletedAt) {
    return { appDeleted: true, remote: null };
  }

  // 1. Stop anything in flight. The worker's conditional claim means a job that
  //    already started will finish, but nothing new will be delivered.
  const pendingTargets = post.targets.filter((target) =>
    ["PENDING", "QUEUED", "FAILED_RETRYABLE"].includes(target.status),
  );

  for (const target of pendingTargets) {
    const jobs = await prisma.scheduledJob.findMany({
      where: { postTargetId: target.id, state: { in: ["PENDING", "DELAYED", "ACTIVE"] } },
    });
    for (const job of jobs) {
      await cancelJob(job.jobId).catch(() => undefined);
      await prisma.scheduledJob
        .update({ where: { jobId: job.jobId }, data: { state: "CANCELLED" } })
        .catch(() => undefined);
    }
  }

  await prisma.postTarget.updateMany({
    where: { postId: post.id, status: { in: ["PENDING", "QUEUED", "FAILED_RETRYABLE"] } },
    data: { status: "CANCELLED" },
  });

  // 2. Ask the platforms to take their copies down, when requested.
  const remote = params.removeFromPlatforms
    ? await deleteAllFromPlatforms({ postId: post.id, actorId: params.actorId })
    : null;

  // 3. Soft delete. The row and its history stay for audit.
  await prisma.post.update({
    where: { id: post.id },
    data: {
      deletedAt: new Date(),
      deletedById: params.actorId,
      scheduledAt: null,
    },
  });

  await recordAuditSafe({
    actorId: params.actorId,
    action: "POST_DELETED",
    entityType: "Post",
    entityId: post.id,
    clientId: post.clientId,
    metadata: {
      removeFromPlatforms: params.removeFromPlatforms,
      cancelledTargets: pendingTargets.length,
      remoteDeleted: remote?.deleted.length ?? 0,
      remoteFailed: remote?.failed.length ?? 0,
    },
  });

  logger.info(
    { postId: post.id, removeFromPlatforms: params.removeFromPlatforms },
    "post deleted",
  );

  return { appDeleted: true, remote };
}

/** Which targets of these posts can still be removed from their platform. */
export function describeDeleteCapability(platform: string): {
  supported: boolean;
  note: string | null;
} {
  const adapter = findAdapter(platform as never);
  if (!adapter) return { supported: false, note: "This platform is not available." };
  return {
    supported: adapter.capabilities.supportsDelete && Boolean(adapter.deletePublished),
    note: adapter.capabilities.deleteNote,
  };
}
