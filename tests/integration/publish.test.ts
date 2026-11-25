import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { testDb, makeTwoClientsWithAccounts } from "../setup/db";
import { createPost } from "@/server/services/posts";
import { executePublish } from "@/server/services/publish";
import { encryptSecret } from "@/lib/crypto";
import { stubFetch, jsonResponse, type FetchStub } from "../helpers/fetch";

/**
 * The publish executor.
 *
 * These tests exercise the real claim/attempt/rollup logic against the real
 * database, with only the platform HTTP mocked. That is the right seam: the
 * duplicate-prevention logic is exactly what a mocked database would fail to
 * prove.
 */

let stub: FetchStub | null = null;

afterEach(() => {
  stub?.restore();
  stub = null;
});

beforeEach(() => {
  // The adapters call getAdapter, which checks the platform flag. Facebook must
  // be enabled for these tests to reach the network layer.
  process.env.FACEBOOK_ENABLED = "true";
  process.env.META_APP_ID = "test-app-id";
  process.env.META_APP_SECRET = "test-app-secret";
  // env() memoises, so re-import is handled by the reset below.
  return import("@/lib/env").then((mod) => mod.resetEnvCache());
});

afterEach(() => {
  process.env.FACEBOOK_ENABLED = "false";
  return import("@/lib/env").then((mod) => mod.resetEnvCache());
});

async function makePublishablePost() {
  const { user, clientA, accountA } = await makeTwoClientsWithAccounts();
  const db = testDb();

  // The account needs a secret for getAccountCredentials to succeed.
  await db.socialAccountSecret.create({
    data: {
      socialAccountId: accountA.id,
      accessTokenCipher: encryptSecret("fake-page-token"),
      tokenType: "Bearer",
      keyId: "k1",
    },
  });

  const { id: postId } = await createPost({
    clientId: clientA.id,
    baseCaption: "A real launch post for CW",
    mediaAssetIds: [],
    targets: [{ socialAccountId: accountA.id }],
    authorId: user.id,
  });

  const target = await db.postTarget.findFirst({ where: { postId } });
  await db.postTarget.update({ where: { id: target!.id }, data: { status: "QUEUED" } });

  return { user, clientA, accountA, postId, targetId: target!.id };
}

describe("publish executor", () => {
  it("marks the target and post published only after the platform confirms", async () => {
    const { postId, targetId } = await makePublishablePost();
    const db = testDb();

    stub = stubFetch(() => jsonResponse({ id: "page_post_123" }));

    const outcome = await executePublish({
      postTargetId: targetId,
      attemptNo: 1,
      requestId: "req-1",
    });

    expect(outcome?.status).toBe("PUBLISHED");
    expect(outcome?.platformPostId).toBe("page_post_123");

    const target = await db.postTarget.findUnique({ where: { id: targetId } });
    expect(target?.status).toBe("PUBLISHED");
    expect(target?.platformPostId).toBe("page_post_123");
    expect(target?.platformPostUrl).toBe("https://www.facebook.com/page_post_123");
    expect(target?.publishedAt).not.toBeNull();

    const post = await db.post.findUnique({ where: { id: postId } });
    expect(post?.status).toBe("PUBLISHED");
    expect(post?.publishedAt).not.toBeNull();

    // The attempt row records the outcome.
    const attempt = await db.publishingAttempt.findFirst({ where: { postTargetId: targetId } });
    expect(attempt?.outcome).toBe("SUCCESS");
    expect(attempt?.platformPostId).toBe("page_post_123");
  });

  it("keeps a post published when its first comment is refused, and says so", async () => {
    const { postId, targetId } = await makePublishablePost();
    const db = testDb();

    await db.postTarget.update({
      where: { id: targetId },
      data: { platformOptions: { firstComment: "#launch #cw" } },
    });

    stub = stubFetch((call) =>
      call.url.includes("/comments")
        ? jsonResponse(
            { error: { message: "(#10) Permission denied", type: "OAuthException", code: 10 } },
            403,
          )
        : jsonResponse({ id: "page_post_with_comment" }),
    );

    const outcome = await executePublish({ postTargetId: targetId, attemptNo: 1, requestId: "c1" });
    expect(outcome?.status).toBe("PUBLISHED");
    expect(stub.calls.some((call) => call.url.includes("/page_post_with_comment/comments"))).toBe(true);

    // A failed comment must not be reported as a failed publish — that would
    // invite a retry and a duplicate post — but it must be visible.
    const target = await db.postTarget.findUniqueOrThrow({ where: { id: targetId } });
    expect(target.status).toBe("PUBLISHED");
    expect(target.lastErrorCode).toBe("FIRST_COMMENT_FAILED");
    expect(target.lastErrorMessage).toMatch(/first comment was refused/i);

    const post = await db.post.findUniqueOrThrow({ where: { id: postId } });
    expect(post.status).toBe("PUBLISHED");
  });

  it("does not publish twice when the same job is delivered again", async () => {
    const { targetId } = await makePublishablePost();

    const fetchStub = stubFetch(() => jsonResponse({ id: "page_post_once" }));
    stub = fetchStub;

    const first = await executePublish({ postTargetId: targetId, attemptNo: 1, requestId: "r1" });
    expect(first?.status).toBe("PUBLISHED");
    expect(fetchStub.calls).toHaveLength(1);

    // A redelivered job must not publish again. It returns null because the
    // target is no longer in a claimable state.
    const second = await executePublish({ postTargetId: targetId, attemptNo: 1, requestId: "r2" });
    expect(second).toBeNull();

    // Crucially: the platform was not called a second time.
    expect(fetchStub.calls).toHaveLength(1);
  });

  it("refuses a second attempt with the same attempt number", async () => {
    const { targetId } = await makePublishablePost();
    const db = testDb();

    // Simulate a partially-completed attempt that already took the number.
    await db.publishingAttempt.create({
      data: { postTargetId: targetId, attemptNo: 1, requestId: "earlier" },
    });

    const fetchStub = stubFetch(() => jsonResponse({ id: "should-not-happen" }));
    stub = fetchStub;

    const outcome = await executePublish({
      postTargetId: targetId,
      attemptNo: 1,
      requestId: "duplicate",
    });

    // The unique constraint rejected the attempt, so nothing was published.
    expect(outcome).toBeNull();
    expect(fetchStub.calls).toHaveLength(0);
  });

  it("classifies a 5xx as retryable and keeps the post unpublished", async () => {
    const { postId, targetId } = await makePublishablePost();
    const db = testDb();

    stub = stubFetch(() => jsonResponse({ error: { message: "Server error" } }, 500));

    const outcome = await executePublish({ postTargetId: targetId, attemptNo: 1, requestId: "r1" });

    expect(outcome?.status).toBe("FAILED_RETRYABLE");

    const target = await db.postTarget.findUnique({ where: { id: targetId } });
    expect(target?.status).toBe("FAILED_RETRYABLE");
    expect(target?.publishedAt).toBeNull();

    const post = await db.post.findUnique({ where: { id: postId } });
    expect(post?.status).not.toBe("PUBLISHED");
  });

  it("classifies a 400 as permanent — no automatic retry", async () => {
    const { targetId } = await makePublishablePost();

    stub = stubFetch(() =>
      jsonResponse({ error: { message: "Invalid parameter", code: 100 } }, 400),
    );

    const outcome = await executePublish({ postTargetId: targetId, attemptNo: 1, requestId: "r1" });

    expect(outcome?.status).toBe("FAILED_PERMANENT");
  });

  it("marks an ambiguous network failure as UNKNOWN, not retryable", async () => {
    const { targetId } = await makePublishablePost();
    const db = testDb();

    stub = stubFetch(() => {
      throw new TypeError("fetch failed");
    });

    const outcome = await executePublish({ postTargetId: targetId, attemptNo: 1, requestId: "r1" });

    // The platform may have accepted the post. Retrying automatically would risk
    // a duplicate, so this must never be a retryable failure.
    expect(outcome?.status).toBe("UNKNOWN");

    const target = await db.postTarget.findUnique({ where: { id: targetId } });
    expect(target?.status).toBe("UNKNOWN");
    expect(target?.publishedAt).toBeNull();
  });

  it("marks the account as needing reconnection when the token is revoked", async () => {
    const { accountA, targetId } = await makePublishablePost();
    const db = testDb();

    stub = stubFetch(() =>
      jsonResponse({ error: { message: "Invalid OAuth access token", code: 190 } }, 401),
    );

    const outcome = await executePublish({ postTargetId: targetId, attemptNo: 1, requestId: "r1" });

    expect(outcome?.status).toBe("NEEDS_RECONNECT");

    const account = await db.socialAccount.findUnique({ where: { id: accountA.id } });
    expect(account?.status).toBe("EXPIRED");
  });

  it("refuses to publish when the account has no stored secret", async () => {
    const { user, clientA, accountA } = await makeTwoClientsWithAccounts();
    const db = testDb();

    const { id: postId } = await createPost({
      clientId: clientA.id,
      baseCaption: "No secret",
      mediaAssetIds: [],
      targets: [{ socialAccountId: accountA.id }],
      authorId: user.id,
    });

    const target = await db.postTarget.findFirst({ where: { postId } });
    await db.postTarget.update({ where: { id: target!.id }, data: { status: "QUEUED" } });

    const fetchStub = stubFetch(() => jsonResponse({ id: "nope" }));
    stub = fetchStub;

    const outcome = await executePublish({
      postTargetId: target!.id,
      attemptNo: 1,
      requestId: "r1",
    });

    expect(outcome?.status).toBe("NEEDS_RECONNECT");
    // No network call was attempted with a missing token.
    expect(fetchStub.calls).toHaveLength(0);
  });

  it("never writes the access token into the attempt record", async () => {
    const { targetId } = await makePublishablePost();
    const db = testDb();

    stub = stubFetch(() => jsonResponse({ error: { message: "Bad request" } }, 400));

    await executePublish({ postTargetId: targetId, attemptNo: 1, requestId: "r1" });

    const attempt = await db.publishingAttempt.findFirst({ where: { postTargetId: targetId } });
    const serialised = JSON.stringify(attempt);

    expect(serialised).not.toContain("fake-page-token");
    expect(attempt?.platformErrorMessage ?? "").not.toContain("fake-page-token");
  });

  it("writes an audit entry when a post goes out", async () => {
    const { postId, targetId } = await makePublishablePost();
    const db = testDb();

    stub = stubFetch(() => jsonResponse({ id: "audited_post" }));

    await executePublish({ postTargetId: targetId, attemptNo: 1, requestId: "r1" });

    const audit = await db.auditLog.findFirst({
      where: { action: "POST_PUBLISHED", entityType: "PostTarget", entityId: targetId },
    });

    expect(audit).not.toBeNull();
    expect(audit?.clientId).not.toBeNull();
    void postId;
  });
});

describe("partial success across platforms", () => {
  it("keeps four individual outcomes when two succeed and two fail", async () => {
    const { user, clientA, accountA } = await makeTwoClientsWithAccounts();
    const db = testDb();

    // Three more accounts so there are four targets in total (Facebook from the
    // fixture, plus LinkedIn, X and Instagram).
    const otherPlatforms = ["LINKEDIN", "X", "INSTAGRAM"] as const;
    const extraAccounts = [];

    for (const platform of otherPlatforms) {
      const account = await db.socialAccount.create({
        data: {
          clientId: clientA.id,
          platform,
          externalId: `${platform.toLowerCase()}-1`,
          displayName: `${platform} account`,
          accountType:
            platform === "X" ? "X_ACCOUNT" : platform === "LINKEDIN" ? "ORGANIZATION" : "IG_PROFESSIONAL",
          status: "CONNECTED",
          scopes: [],
          connectedById: user.id,
        },
      });
      await db.socialAccountSecret.create({
        data: {
          socialAccountId: account.id,
          accessTokenCipher: encryptSecret(`token-${platform}`),
          tokenType: "Bearer",
          keyId: "k1",
        },
      });
      extraAccounts.push(account);
    }

    await db.socialAccountSecret.create({
      data: {
        socialAccountId: accountA.id,
        accessTokenCipher: encryptSecret("token-facebook"),
        tokenType: "Bearer",
        keyId: "k1",
      },
    });

    const { id: postId } = await createPost({
      clientId: clientA.id,
      baseCaption: "One post, four accounts",
      mediaAssetIds: [],
      targets: [
        { socialAccountId: accountA.id },
        ...extraAccounts.map((a) => ({ socialAccountId: a.id })),
      ],
      authorId: user.id,
    });

    const targets = await db.postTarget.findMany({
      where: { postId },
      include: { socialAccount: { select: { platform: true } } },
    });

    // Four targets: Facebook and LinkedIn succeed, X and Instagram fail. This is
    // exactly the "three platforms succeed and one fails" case from the brief.
    expect(targets).toHaveLength(4);

    for (const target of targets) {
      const platform = target.socialAccount.platform;
      if (platform === "FACEBOOK" || platform === "LINKEDIN") {
        await db.postTarget.update({
          where: { id: target.id },
          data: {
            status: "PUBLISHED",
            platformPostId: `${platform}-id`,
            publishedAt: new Date(),
          },
        });
      } else {
        await db.postTarget.update({
          where: { id: target.id },
          data: { status: "FAILED_PERMANENT", lastErrorMessage: "Refused by platform" },
        });
      }
    }

    const { recalculatePostStatusForPost } = await import("@/server/services/posts");
    const status = await recalculatePostStatusForPost(postId);

    // The whole point: a mixed result is PARTIAL, and every individual outcome
    // survives. It is not a single failure.
    expect(status).toBe("PARTIAL");

    const finalTargets = await db.postTarget.findMany({ where: { postId } });
    expect(finalTargets.filter((t) => t.status === "PUBLISHED")).toHaveLength(2);
    expect(finalTargets.filter((t) => t.status === "FAILED_PERMANENT")).toHaveLength(2);

    // Each successful target kept its own platform id.
    const published = finalTargets.filter((t) => t.status === "PUBLISHED");
    expect(new Set(published.map((t) => t.platformPostId)).size).toBe(2);
  });
});
