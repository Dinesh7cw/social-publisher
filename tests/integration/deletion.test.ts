/**
 * Deleting posts.
 *
 * The two behaviours worth pinning down here are the ones a bug would make
 * dangerous: a deleted post must vanish from every list while its rows survive
 * for audit, and a platform that refuses to delete must not block the app-side
 * delete or be silently reported as success.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { testDb, makeTwoClientsWithAccounts } from "../setup/db";
import { createPost, recalculatePostStatusForPost, retryTarget } from "@/server/services/posts";
import { deletePost, deleteTargetFromPlatform } from "@/server/services/deletion";
import { resetEnvCache } from "@/lib/env";

async function makePostWithPublishedTarget() {
  const context = await makeTwoClientsWithAccounts();
  const db = testDb();

  const { id } = await createPost({
    clientId: context.clientA.id,
    baseCaption: "Delete me",
    mediaAssetIds: [],
    targets: [{ socialAccountId: context.accountA.id }],
    authorId: context.user.id,
  });

  await db.postTarget.updateMany({
    where: { postId: id },
    data: {
      status: "PUBLISHED",
      platformPostId: "page-post-123",
      platformPostUrl: "https://www.facebook.com/page-post-123",
      publishedAt: new Date(),
    },
  });
  await db.post.update({ where: { id }, data: { status: "PUBLISHED" } });

  return { ...context, postId: id };
}

describe("deleting a post from the app", () => {
  it("soft-deletes: the row survives, the lists no longer see it", async () => {
    const { postId, user } = await makePostWithPublishedTarget();
    const db = testDb();

    const result = await deletePost({
      postId,
      actorId: user.id,
      removeFromPlatforms: false,
    });

    expect(result.appDeleted).toBe(true);
    // No platform call was requested, so the live copy is untouched.
    expect(result.remote).toBeNull();

    const post = await db.post.findUnique({ where: { id: postId } });
    expect(post).not.toBeNull();
    expect(post?.deletedAt).not.toBeNull();
    expect(post?.deletedById).toBe(user.id);
    expect(post?.scheduledAt).toBeNull();

    // Nothing queued can fire after a delete.
    const targets = await db.postTarget.findMany({ where: { postId } });
    expect(targets.every((target) => target.status === "PUBLISHED")).toBe(true);
  });

  it("is idempotent: deleting twice does not fail or duplicate audit rows", async () => {
    const { postId, user } = await makePostWithPublishedTarget();
    const db = testDb();

    await deletePost({ postId, actorId: user.id, removeFromPlatforms: false });
    const before = await db.auditLog.count({
      where: { entityId: postId, action: "POST_DELETED" },
    });

    const second = await deletePost({ postId, actorId: user.id, removeFromPlatforms: false });

    expect(second.appDeleted).toBe(true);
    expect(
      await db.auditLog.count({ where: { entityId: postId, action: "POST_DELETED" } }),
    ).toBe(before);
  });

  it("cancels queued work rather than leaving it to fire", async () => {
    const { user, clientA, accountA } = await makeTwoClientsWithAccounts();
    const db = testDb();

    const { id } = await createPost({
      clientId: clientA.id,
      baseCaption: "Scheduled then deleted",
      mediaAssetIds: [],
      targets: [{ socialAccountId: accountA.id }],
      authorId: user.id,
    });

    await db.postTarget.updateMany({ where: { postId: id }, data: { status: "QUEUED" } });

    await deletePost({ postId: id, actorId: user.id, removeFromPlatforms: false });

    const target = await db.postTarget.findFirst({ where: { postId: id } });
    expect(target?.status).toBe("CANCELLED");
  });

  it("reports platform refusals separately without blocking the app delete", async () => {
    const { postId, user, clientA } = await makePostWithPublishedTarget();
    const db = testDb();

    // Facebook is not configured in the test environment, so the remote call
    // must fail in a way that is collected rather than thrown.
    const result = await deletePost({
      postId,
      actorId: user.id,
      removeFromPlatforms: true,
    });

    expect(result.appDeleted).toBe(true);
    expect(result.remote?.deleted).toHaveLength(0);
    expect(result.remote?.failed.length).toBe(1);

    const target = await db.postTarget.findFirst({ where: { post: { id: postId } } });
    // The platform copy is still live, so the target keeps saying PUBLISHED.
    expect(target?.status).toBe("PUBLISHED");

    const post = await db.post.findFirst({ where: { id: postId, clientId: clientA.id } });
    expect(post?.deletedAt).not.toBeNull();
  });
});

describe("removing one platform's copy", () => {
  beforeEach(() => {
    // Enabling the platform proves the failure comes from the network/token
    // layer rather than from the availability gate.
    process.env.FACEBOOK_ENABLED = "true";
    process.env.META_APP_ID = "test-meta-app-id";
    process.env.META_APP_SECRET = "test-meta-app-secret";
    resetEnvCache();
  });

  afterEach(() => {
    process.env.FACEBOOK_ENABLED = "false";
    process.env.META_APP_ID = "";
    process.env.META_APP_SECRET = "";
    resetEnvCache();
  });

  it("refuses a target that never published, instead of pretending to delete", async () => {
    const { user, clientA, accountA } = await makeTwoClientsWithAccounts();
    const db = testDb();

    const { id } = await createPost({
      clientId: clientA.id,
      baseCaption: "Never went out",
      mediaAssetIds: [],
      targets: [{ socialAccountId: accountA.id }],
      authorId: user.id,
    });

    const target = await db.postTarget.findFirst({ where: { postId: id } });

    await expect(
      deleteTargetFromPlatform({ postId: id, targetId: target!.id, actorId: user.id }),
    ).rejects.toThrow(/never published/i);
  });

  it("keeps the target PUBLISHED when the platform cannot be reached", async () => {
    const { postId, user } = await makePostWithPublishedTarget();
    const db = testDb();

    const target = await db.postTarget.findFirst({ where: { postId } });

    await expect(
      deleteTargetFromPlatform({ postId, targetId: target!.id, actorId: user.id }),
    ).rejects.toThrow();

    const after = await db.postTarget.findUnique({ where: { id: target!.id } });
    expect(after?.status).toBe("PUBLISHED");
    expect(after?.deletedAt).toBeNull();
  });
});

describe("post status after a removal", () => {
  it("rolls up to DELETED when every copy is gone", async () => {
    const { postId } = await makePostWithPublishedTarget();
    const db = testDb();

    await db.postTarget.updateMany({
      where: { postId },
      data: { status: "DELETED", deletedAt: new Date() },
    });

    expect(await recalculatePostStatusForPost(postId)).toBe("DELETED");
  });

  it("rolls up to PARTIAL when only some copies are gone", async () => {
    const { user, clientA, accountA } = await makeTwoClientsWithAccounts();
    const db = testDb();

    const second = await db.socialAccount.create({
      data: {
        clientId: clientA.id,
        platform: "LINKEDIN",
        externalId: "li-1",
        displayName: "CW LinkedIn",
        accountType: "MEMBER",
        status: "CONNECTED",
        connectedById: user.id,
      },
    });

    const { id } = await createPost({
      clientId: clientA.id,
      baseCaption: "Two platforms",
      mediaAssetIds: [],
      targets: [
        { socialAccountId: accountA.id },
        { socialAccountId: second.id },
      ],
      authorId: user.id,
    });

    await db.postTarget.updateMany({
      where: { postId: id, socialAccountId: accountA.id },
      data: { status: "DELETED", deletedAt: new Date() },
    });
    await db.postTarget.updateMany({
      where: { postId: id, socialAccountId: second.id },
      data: { status: "PUBLISHED", platformPostId: "urn:li:share:1", publishedAt: new Date() },
    });

    expect(await recalculatePostStatusForPost(id)).toBe("PARTIAL");
  });

  it("will not retry a removed copy, which would resurrect it", async () => {
    const { postId, user } = await makePostWithPublishedTarget();
    const db = testDb();

    await db.postTarget.updateMany({
      where: { postId },
      data: { status: "DELETED", deletedAt: new Date() },
    });

    const target = await db.postTarget.findFirst({ where: { postId } });

    await expect(
      retryTarget({ targetId: target!.id, actorId: user.id }),
    ).rejects.toThrow(/removed from the platform/i);
  });
});
