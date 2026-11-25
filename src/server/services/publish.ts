/**
 * The publish executor.
 *
 * This is the heart of the system and the place where correctness matters most.
 * It runs inside the worker, one target at a time.
 *
 * The four duplicate-prevention layers, in order:
 *
 *  1. Deterministic job id      → the same work cannot be queued twice (queue.ts)
 *  2. Transactional claim       → below; only one worker can move a target from
 *                                 QUEUED to PUBLISHING
 *  3. Unique attempt number     → the database refuses a second attempt row for
 *                                 the same (target, attemptNo)
 *  4. Ambiguous-failure rule    → a network drop after sending is never retried
 *                                 automatically, because the post may exist
 *
 * A post is only recorded as published once the platform has returned an id.
 */

import { prisma } from "@/server/db";
import { logger } from "@/server/logger";
import { recordAuditSafe } from "@/server/audit";
import { ApiError } from "@/server/http";
import { getAccountCredentials, isTokenExpired } from "@/server/auth/token-access";
import { getAdapter } from "@/server/platforms/registry";
import { resolveAppCredentials } from "@/server/services/platform-credentials";
import { PlatformError, type PlatformAdapter, type PlatformOptions, type PublishRequest } from "@/server/platforms/types";
import { findLinks } from "@/server/platforms/capabilities";
import { encryptSecret } from "@/lib/crypto";
import { derivePostStatus, type TargetStatusId } from "@/lib/domain";
import { recalculatePostStatus } from "@/server/services/posts";

export interface PublishOutcome {
  targetId: string;
  status: "PUBLISHED" | "FAILED_RETRYABLE" | "FAILED_PERMANENT" | "UNKNOWN" | "NEEDS_RECONNECT";
  platformPostId?: string;
  platformPostUrl?: string | null;
  errorCode?: string;
  errorMessage?: string;
  retryAfterSeconds?: number | null;
}

/**
 * Claim a target for publishing.
 *
 * The conditional update is the lock. If another worker already moved the target
 * out of QUEUED, zero rows change and this call returns false — the other worker
 * owns it. This is why two workers racing on the same job cannot double-post.
 */
async function claimTarget(targetId: string): Promise<boolean> {
  const result = await prisma.postTarget.updateMany({
    where: {
      id: targetId,
      status: { in: ["QUEUED", "FAILED_RETRYABLE"] },
    },
    data: { status: "PUBLISHING" },
  });

  return result.count === 1;
}

/**
 * Refresh a token when it is expired or nearly so, persisting the new secret.
 *
 * Returns the usable access token, or null when the account must be reconnected.
 */
async function ensureFreshToken(params: {
  socialAccountId: string;
  platform: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
}): Promise<{ accessToken: string; reconnect: false } | { accessToken: null; reconnect: true }> {
  if (!isTokenExpired(params.expiresAt)) {
    return { accessToken: params.accessToken, reconnect: false };
  }

  const adapter = await getAdapter(params.platform as never);
  if (!adapter.refresh || !params.refreshToken) {
    // No way to refresh: the team must reconnect.
    return { accessToken: null, reconnect: true };
  }

  const appCredentials = await resolveAppCredentials(params.platform as never);
  if (!appCredentials) return { accessToken: null, reconnect: true };

  const refreshed = await adapter.refresh(params.refreshToken, {
    appId: appCredentials.appId,
    appSecret: appCredentials.appSecret,
    version: appCredentials.config.version,
  });
  if (!refreshed.ok || !refreshed.tokens) {
    return { accessToken: null, reconnect: true };
  }

  // Persist rotated tokens. X in particular issues a new refresh token on every
  // refresh; losing it would break the next refresh.
  await prisma.socialAccountSecret.update({
    where: { socialAccountId: params.socialAccountId },
    data: {
      accessTokenCipher: encryptSecret(refreshed.tokens.accessToken),
      ...(refreshed.tokens.refreshToken
        ? { refreshTokenCipher: encryptSecret(refreshed.tokens.refreshToken) }
        : {}),
      rotatedAt: new Date(),
    },
  });

  await prisma.socialAccount.update({
    where: { id: params.socialAccountId },
    data: {
      tokenExpiresAt: refreshed.tokens.expiresAt ?? null,
      status: "CONNECTED",
      lastVerifiedAt: new Date(),
    },
  });

  return { accessToken: refreshed.tokens.accessToken, reconnect: false };
}

/**
 * Post the composer's "first comment" after a successful publish.
 *
 * Failure here never fails the publish: the post itself is live, and reporting
 * it as a failed publish would invite a duplicate. It returns a message instead,
 * which is kept on the published target so the History tab shows that the
 * comment is missing — otherwise it disappears into a log nobody reads.
 */
async function postFirstComment(params: {
  adapter: PlatformAdapter;
  request: PublishRequest;
  platformPostId: string;
}): Promise<string | null> {
  const body = params.request.options?.firstComment?.trim();
  if (!body) return null;

  if (!params.adapter.commentOnPost) {
    logger.warn(
      { platform: params.request.platform, targetId: params.request.targetId },
      "first comment requested but this platform adapter cannot comment",
    );
    return "Published, but this platform cannot take a first comment. Add it by hand.";
  }

  try {
    const result = await params.adapter.commentOnPost({
      platformPostId: params.platformPostId,
      externalId: params.request.externalId,
      accountType: params.request.accountType,
      accessToken: params.request.accessToken,
      body,
      requestId: `${params.request.requestId}:comment`,
      signal: params.request.signal,
    });

    if (!result.ok) {
      logger.warn(
        {
          platform: params.request.platform,
          targetId: params.request.targetId,
          code: result.error?.code,
          message: result.error?.message,
        },
        "published, but the first comment was refused",
      );
      return `Published, but the first comment was refused: ${
        result.error?.userMessage ?? "the platform did not say why"
      } Reconnecting the account usually fixes this.`;
    }
    return null;
  } catch (error) {
    logger.warn(
      {
        platform: params.request.platform,
        targetId: params.request.targetId,
        error: error instanceof Error ? error.message : "unknown",
      },
      "published, but the first comment could not be sent",
    );
    return "Published, but the first comment could not be sent. Add it by hand.";
  }
}

/** Mark an account as needing the team's attention. */
async function markAccountNeedsReconnect(accountId: string, reason: string): Promise<void> {  await prisma.socialAccount.update({
    where: { id: accountId },
    data: { status: "EXPIRED" },
  });

  logger.warn({ accountId, reason }, "social account needs reconnecting");
}

/**
 * Execute one publish attempt for one target.
 *
 * Returns the outcome rather than throwing, because the caller (the worker) needs
 * to decide whether to re-enqueue and must never lose the failure detail.
 */
export async function executePublish(params: {
  postTargetId: string;
  attemptNo: number;
  requestId: string;
  signal?: AbortSignal;
}): Promise<PublishOutcome | null> {
  const target = await prisma.postTarget.findUnique({
    where: { id: params.postTargetId },
    include: {
      post: { select: { id: true, clientId: true, baseCaption: true, deletedAt: true } },
      socialAccount: {
        select: {
          id: true,
          platform: true,
          externalId: true,
          accountType: true,
          displayName: true,
          clientId: true,
        },
      },
    },
  });

  if (!target) {
    logger.error({ targetId: params.postTargetId }, "publish job references a missing target");
    return null;
  }

  // Deleted between enqueue and delivery. Publishing now would create a post the
  // team believes they removed, so this is a hard stop rather than a retry.
  if (target.post.deletedAt) {
    logger.info({ targetId: target.id }, "publish skipped: post was deleted");
    return null;
  }

  // --- Layer 2: the claim --------------------------------------------------
  const claimed = await claimTarget(target.id);
  if (!claimed) {
    // Another worker has it, or it is already terminal. Either way: do nothing.
    logger.info(
      { targetId: target.id, status: target.status },
      "publish skipped: target is not in a claimable state",
    );
    return null;
  }

  // --- Open an attempt row -------------------------------------------------
  // The unique (postTargetId, attemptNo) constraint means a duplicate attempt
  // cannot be recorded twice even if a job were somehow delivered twice.
  let attempt;
  try {
    attempt = await prisma.publishingAttempt.create({
      data: {
        postTargetId: target.id,
        attemptNo: params.attemptNo,
        outcome: "IN_PROGRESS",
        requestId: params.requestId,
      },
    });
  } catch {
    logger.warn(
      { targetId: target.id, attemptNo: params.attemptNo },
      "attempt row already exists; refusing to publish twice",
    );
    return null;
  }

  const startedAt = Date.now();

  try {
    // --- Credentials -------------------------------------------------------
    const credentials = await getAccountCredentials(target.socialAccount.id);

    const fresh = await ensureFreshToken({
      socialAccountId: target.socialAccount.id,
      platform: target.socialAccount.platform,
      accessToken: credentials.accessToken,
      refreshToken: credentials.refreshToken,
      expiresAt: credentials.expiresAt,
    });

    if (fresh.reconnect) {
      await markAccountNeedsReconnect(
        target.socialAccount.id,
        "token expired and could not be refreshed",
      );
      return await finishAttempt({
        attemptId: attempt.id,
        targetId: target.id,
        startedAt,
        outcome: "NEEDS_RECONNECT",
        errorCode: "NEEDS_RECONNECT",
        errorMessage: `${target.socialAccount.displayName} needs to be reconnected before it can publish.`,
        httpStatus: null,
      });
    }

    // --- Media -------------------------------------------------------------
    const media = await prisma.postMedia.findMany({
      where: { postId: target.post.id },
      orderBy: { position: "asc" },
      include: { media: true },
    });

    // --- Dispatch ----------------------------------------------------------
    const adapter = await getAdapter(target.socialAccount.platform as never);

    const request: PublishRequest = {
      targetId: target.id,
      postId: target.post.id,
      platform: target.socialAccount.platform as never,
      caption: target.caption,
      linkUrl: findLinks(target.caption)[0] ?? null,
      media: media.map((row) => ({
        id: row.media.id,
        kind: row.media.kind,
        mimeType: row.media.mimeType,
        byteSize: row.media.byteSize,
        width: row.media.width,
        height: row.media.height,
        durationSeconds: row.media.durationSeconds,
        storageKey: row.media.storageKey,
        publicUrl: row.media.publicUrl,
      })),
      accessToken: fresh.accessToken,
      externalId: target.socialAccount.externalId,
      accountType: target.socialAccount.accountType,
      options: (target.platformOptions as PlatformOptions | null) ?? null,
      requestId: params.requestId,
      signal: params.signal,
    };

    const result = await adapter.publish(request);

    if (result.ok) {
      const commentNotice = await postFirstComment({
        adapter,
        request,
        platformPostId: result.platformPostId,
      });

      return await finishAttempt({
        attemptId: attempt.id,
        targetId: target.id,
        startedAt,
        outcome: "PUBLISHED",
        platformPostId: result.platformPostId,
        platformPostUrl: result.platformPostUrl,
        httpStatus: 200,
        publishedNotice: commentNotice,
      });
    }

    // --- Failure classification --------------------------------------------
    const error = result.error;
    const outcome =
      error.errorClass === "transient"
        ? "FAILED_RETRYABLE"
        : error.errorClass === "ambiguous"
          ? "UNKNOWN"
          : error.errorClass === "auth"
            ? "NEEDS_RECONNECT"
            : "FAILED_PERMANENT";

    if (error.errorClass === "auth") {
      await markAccountNeedsReconnect(target.socialAccount.id, error.code);
    }

    return await finishAttempt({
      attemptId: attempt.id,
      targetId: target.id,
      startedAt,
      outcome,
      errorCode: error.code,
      errorMessage: error.userMessage,
      httpStatus: error.httpStatus,
      retryAfterSeconds: error.retryAfterSeconds,
      platformErrorCode: error.code,
    });
  } catch (error) {
    // A determinate failure we already understand: the account cannot
    // authenticate. This is not ambiguous — nothing was sent — so it must not be
    // recorded as UNKNOWN.
    if (error instanceof ApiError && error.code === "PLATFORM_AUTH_EXPIRED") {
      return await finishAttempt({
        attemptId: attempt.id,
        targetId: target.id,
        startedAt,
        outcome: "NEEDS_RECONNECT",
        errorCode: "NEEDS_RECONNECT",
        errorMessage: error.message,
        httpStatus: null,
      });
    }

    if (error instanceof ApiError && error.code === "PLATFORM_DISABLED") {
      // The platform was turned off after the post was queued. Nothing was sent.
      return await finishAttempt({
        attemptId: attempt.id,
        targetId: target.id,
        startedAt,
        outcome: "FAILED_PERMANENT",
        errorCode: "PLATFORM_DISABLED",
        errorMessage: error.message,
        httpStatus: null,
      });
    }

    // A programming error or an unexpected failure. It is not safe to assume the
    // post did not go out, so the target is marked UNKNOWN and a human checks.
    logger.error(
      {
        targetId: target.id,
        attemptNo: params.attemptNo,
        error: error instanceof Error ? error.message : "unknown",
      },
      "unexpected error while publishing",
    );

    const message =
      error instanceof PlatformError
        ? error.userMessage
        : "Something went wrong while publishing. Check the platform before retrying.";

    return await finishAttempt({
      attemptId: attempt.id,
      targetId: target.id,
      startedAt,
      outcome: "UNKNOWN",
      errorCode: error instanceof PlatformError ? error.code : "UNEXPECTED",
      errorMessage: message,
      httpStatus: null,
    });
  }
}

/**
 * Close the attempt row, update the target and recompute the post.
 *
 * All three happen in one transaction so a crash cannot leave an attempt closed
 * while the target still says PUBLISHING.
 */
async function finishAttempt(params: {
  attemptId: string;
  targetId: string;
  startedAt: number;
  outcome:
    | "PUBLISHED"
    | "FAILED_RETRYABLE"
    | "FAILED_PERMANENT"
    | "UNKNOWN"
    | "NEEDS_RECONNECT";
  platformPostId?: string;
  platformPostUrl?: string | null;
  errorCode?: string;
  errorMessage?: string;
  platformErrorCode?: string;
  httpStatus: number | null;
  retryAfterSeconds?: number | null;
  /** A published post that still needs a human, e.g. its first comment failed. */
  publishedNotice?: string | null;
}): Promise<PublishOutcome> {
  const durationMs = Date.now() - params.startedAt;

  const attemptOutcome =
    params.outcome === "PUBLISHED"
      ? "SUCCESS"
      : params.outcome === "FAILED_RETRYABLE"
        ? "RETRYABLE_FAILURE"
        : params.outcome === "UNKNOWN"
          ? "UNKNOWN"
          : "PERMANENT_FAILURE";

  const targetStatus: TargetStatusId =
    params.outcome === "PUBLISHED"
      ? "PUBLISHED"
      : params.outcome === "FAILED_RETRYABLE"
        ? "FAILED_RETRYABLE"
        : params.outcome === "UNKNOWN"
          ? "UNKNOWN"
          : "FAILED_PERMANENT";

  await prisma.$transaction(async (tx) => {
    await tx.publishingAttempt.update({
      where: { id: params.attemptId },
      data: {
        finishedAt: new Date(),
        outcome: attemptOutcome,
        httpStatus: params.httpStatus,
        platformErrorCode: params.platformErrorCode ?? null,
        platformErrorMessage: params.errorMessage ?? null,
        durationMs,
        platformPostId: params.platformPostId ?? null,
      },
    });

    await tx.postTarget.update({
      where: { id: params.targetId },
      data: {
        status: targetStatus,
        attemptCount: { increment: 1 },
        ...(params.outcome === "PUBLISHED"
          ? {
              platformPostId: params.platformPostId,
              platformPostUrl: params.platformPostUrl ?? null,
              publishedAt: new Date(),
              lastErrorCode: params.publishedNotice ? "FIRST_COMMENT_FAILED" : null,
              lastErrorMessage: params.publishedNotice ?? null,
            }
          : {
              lastErrorCode: params.errorCode ?? null,
              lastErrorMessage: params.errorMessage ?? null,
            }),
      },
    });
  });

  // Recompute the parent post outside the transaction so the rollup sees the
  // committed target state.
  await recalculatePostStatus(params.targetId);

  if (params.outcome === "PUBLISHED") {
    const target = await prisma.postTarget.findUnique({
      where: { id: params.targetId },
      select: { postId: true, post: { select: { clientId: true } } },
    });

    await recordAuditSafe({
      actorId: null,
      action: "POST_PUBLISHED",
      entityType: "PostTarget",
      entityId: params.targetId,
      clientId: target?.post.clientId ?? null,
      metadata: {
        postId: target?.postId,
        platformPostId: params.platformPostId,
        durationMs,
      },
    });
  }

  logger.info(
    {
      targetId: params.targetId,
      outcome: params.outcome,
      durationMs,
      errorCode: params.errorCode,
    },
    "publish attempt finished",
  );

  return {
    targetId: params.targetId,
    status: params.outcome,
    platformPostId: params.platformPostId,
    platformPostUrl: params.platformPostUrl ?? null,
    errorCode: params.errorCode,
    errorMessage: params.errorMessage,
    retryAfterSeconds: params.retryAfterSeconds ?? null,
  };
}

/** Re-exported so the worker can log the derived status without duplicating logic. */
export { derivePostStatus };
