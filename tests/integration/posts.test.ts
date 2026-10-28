import { describe, expect, it } from "vitest";

import { testDb, makeTwoClientsWithAccounts } from "../setup/db";
import { createPost, validatePost, cancelPost } from "@/server/services/posts";
import { recalculatePostStatusForPost } from "@/server/services/posts";

describe("post creation and cross-client isolation", () => {
  it("creates a draft with a target per account", async () => {
    const { user, clientA, accountA } = await makeTwoClientsWithAccounts();
    const db = testDb();

    const { id } = await createPost({
      clientId: clientA.id,
      baseCaption: "Hello from CW",
      mediaAssetIds: [],
      targets: [{ socialAccountId: accountA.id }],
      authorId: user.id,
    });

    const post = await db.post.findUnique({
      where: { id },
      include: { targets: true },
    });

    expect(post?.status).toBe("DRAFT");
    expect(post?.targets).toHaveLength(1);
    expect(post?.targets[0]?.caption).toBe("Hello from CW");
  });

  it("refuses an account that belongs to a different client", async () => {
    const { user, clientA, accountB } = await makeTwoClientsWithAccounts();

    // accountB belongs to clientB, but we claim it for clientA. This must fail
    // as NOT_FOUND so it does not confirm that account exists.
    await expect(
      createPost({
        clientId: clientA.id,
        baseCaption: "Cross-client attempt",
        mediaAssetIds: [],
        targets: [{ socialAccountId: accountB.id }],
        authorId: user.id,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses the same account twice in one post", async () => {
    const { user, clientA, accountA } = await makeTwoClientsWithAccounts();

    await expect(
      createPost({
        clientId: clientA.id,
        baseCaption: "Duplicate target",
        mediaAssetIds: [],
        targets: [{ socialAccountId: accountA.id }, { socialAccountId: accountA.id }],
        authorId: user.id,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("keeps per-target caption overrides", async () => {
    const { user, clientA, accountA } = await makeTwoClientsWithAccounts();
    const db = testDb();

    const { id } = await createPost({
      clientId: clientA.id,
      baseCaption: "Base caption",
      mediaAssetIds: [],
      targets: [{ socialAccountId: accountA.id, caption: "Shorter for X" }],
      authorId: user.id,
    });

    const target = await db.postTarget.findFirst({ where: { postId: id } });
    expect(target?.caption).toBe("Shorter for X");
  });

  it("refuses to create a post for an archived client", async () => {
    const { user, clientA, accountA } = await makeTwoClientsWithAccounts();
    const db = testDb();

    await db.client.update({
      where: { id: clientA.id },
      data: { status: "ARCHIVED", archivedAt: new Date() },
    });

    await expect(
      createPost({
        clientId: clientA.id,
        baseCaption: "Should not work",
        mediaAssetIds: [],
        targets: [{ socialAccountId: accountA.id }],
        authorId: user.id,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("validation before publishing", () => {
  it("reports a disconnected account as invalid", async () => {
    const { user, clientA, accountA } = await makeTwoClientsWithAccounts();
    const db = testDb();

    const { id } = await createPost({
      clientId: clientA.id,
      baseCaption: "Text",
      mediaAssetIds: [],
      targets: [{ socialAccountId: accountA.id }],
      authorId: user.id,
    });

    await db.socialAccount.update({ where: { id: accountA.id }, data: { status: "EXPIRED" } });

    const result = await validatePost(id);
    expect(result.ok).toBe(false);
    expect(result.results[0]?.issues[0]?.code).toBe("ACCOUNT_NOT_CONNECTED");
  });

  it("rejects a caption over the platform limit", async () => {
    const { user, clientA, accountA } = await makeTwoClientsWithAccounts();

    const { id } = await createPost({
      clientId: clientA.id,
      // Facebook's limit is 63,206. Exceed it.
      baseCaption: "a".repeat(63_207),
      mediaAssetIds: [],
      targets: [{ socialAccountId: accountA.id }],
      authorId: user.id,
    });

    const result = await validatePost(id);
    expect(result.ok).toBe(false);
    expect(result.results[0]?.issues.some((i) => i.code === "CAPTION_TOO_LONG")).toBe(true);
  });

  it("validates every target independently, so one bad platform is visible", async () => {
    const { user, clientA, accountA } = await makeTwoClientsWithAccounts();
    const db = testDb();

    const xAccount = await db.socialAccount.create({
      data: {
        clientId: clientA.id,
        platform: "X",
        externalId: "x-user-1",
        displayName: "@cw",
        accountType: "X_ACCOUNT",
        status: "CONNECTED",
        scopes: ["tweet.write"],
        connectedById: user.id,
      },
    });

    const { id } = await createPost({
      clientId: clientA.id,
      baseCaption: "a".repeat(300), // fine for Facebook, too long for X
      mediaAssetIds: [],
      targets: [
        { socialAccountId: accountA.id },
        { socialAccountId: xAccount.id },
      ],
      authorId: user.id,
    });

    const result = await validatePost(id);

    const facebook = result.results.find((r) => r.platform === "FACEBOOK");
    const x = result.results.find((r) => r.platform === "X");

    expect(facebook?.ok).toBe(true);
    expect(x?.ok).toBe(false);
    expect(result.ok).toBe(false);
  });
});

describe("post status rollup", () => {
  it("stays a draft while every target is pending", async () => {
    const { user, clientA, accountA } = await makeTwoClientsWithAccounts();

    const { id } = await createPost({
      clientId: clientA.id,
      baseCaption: "Draft",
      mediaAssetIds: [],
      targets: [{ socialAccountId: accountA.id }],
      authorId: user.id,
    });

    expect(await recalculatePostStatusForPost(id)).toBe("DRAFT");
  });

  it("never reports PUBLISHED until every target is published", async () => {
    const { user, clientA, accountA } = await makeTwoClientsWithAccounts();
    const db = testDb();

    const second = await db.socialAccount.create({
      data: {
        clientId: clientA.id,
        platform: "LINKEDIN",
        externalId: "li-1",
        displayName: "CW LinkedIn",
        accountType: "ORGANIZATION",
        status: "CONNECTED",
        scopes: ["w_organization_social"],
        connectedById: user.id,
      },
    });

    const { id } = await createPost({
      clientId: clientA.id,
      baseCaption: "Two platforms",
      mediaAssetIds: [],
      targets: [{ socialAccountId: accountA.id }, { socialAccountId: second.id }],
      authorId: user.id,
    });

    const targets = await db.postTarget.findMany({ where: { postId: id } });

    // One published, one still queued: not published yet.
    await db.postTarget.update({
      where: { id: targets[0]!.id },
      data: { status: "PUBLISHED", platformPostId: "1_1", publishedAt: new Date() },
    });
    await db.postTarget.update({ where: { id: targets[1]!.id }, data: { status: "QUEUED" } });

    expect(await recalculatePostStatusForPost(id)).toBe("PUBLISHING");

    // Both published: now it is published.
    await db.postTarget.update({
      where: { id: targets[1]!.id },
      data: { status: "PUBLISHED", platformPostId: "urn:li:share:1", publishedAt: new Date() },
    });

    expect(await recalculatePostStatusForPost(id)).toBe("PUBLISHED");
  });

  it("reports PARTIAL when one succeeded and one failed", async () => {
    const { user, clientA, accountA } = await makeTwoClientsWithAccounts();
    const db = testDb();

    const second = await db.socialAccount.create({
      data: {
        clientId: clientA.id,
        platform: "LINKEDIN",
        externalId: "li-2",
        displayName: "CW LinkedIn",
        accountType: "ORGANIZATION",
        status: "CONNECTED",
        scopes: [],
        connectedById: user.id,
      },
    });

    const { id } = await createPost({
      clientId: clientA.id,
      baseCaption: "Partial",
      mediaAssetIds: [],
      targets: [{ socialAccountId: accountA.id }, { socialAccountId: second.id }],
      authorId: user.id,
    });

    const targets = await db.postTarget.findMany({ where: { postId: id } });
    await db.postTarget.update({
      where: { id: targets[0]!.id },
      data: { status: "PUBLISHED", platformPostId: "1_1", publishedAt: new Date() },
    });
    await db.postTarget.update({
      where: { id: targets[1]!.id },
      data: { status: "FAILED_PERMANENT", lastErrorMessage: "Missing permission" },
    });

    expect(await recalculatePostStatusForPost(id)).toBe("PARTIAL");
  });
});

describe("cancellation", () => {
  it("marks queued targets as cancelled", async () => {
    const { user, clientA, accountA } = await makeTwoClientsWithAccounts();
    const db = testDb();

    const { id } = await createPost({
      clientId: clientA.id,
      baseCaption: "To cancel",
      mediaAssetIds: [],
      targets: [{ socialAccountId: accountA.id }],
      authorId: user.id,
    });

    await db.postTarget.updateMany({ where: { postId: id }, data: { status: "QUEUED" } });

    await cancelPost({ postId: id, actorId: user.id });

    const post = await db.post.findUnique({ where: { id } });
    const targets = await db.postTarget.findMany({ where: { postId: id } });

    expect(post?.status).toBe("CANCELLED");
    expect(targets[0]?.status).toBe("CANCELLED");
  });
});

describe("database constraints", () => {
  it("refuses two targets for the same account on one post", async () => {
    const { user, clientA, accountA } = await makeTwoClientsWithAccounts();
    const db = testDb();

    const { id } = await createPost({
      clientId: clientA.id,
      baseCaption: "One target",
      mediaAssetIds: [],
      targets: [{ socialAccountId: accountA.id }],
      authorId: user.id,
    });

    // Bypass the service and try to insert a duplicate directly.
    await expect(
      db.postTarget.create({
        data: { postId: id, socialAccountId: accountA.id, caption: "dup" },
      }),
    ).rejects.toThrow();
  });

  it("refuses the same platform account connected twice", async () => {
    const { clientA, accountA } = await makeTwoClientsWithAccounts();
    const db = testDb();

    await expect(
      db.socialAccount.create({
        data: {
          clientId: clientA.id,
          platform: accountA.platform,
          externalId: accountA.externalId,
          displayName: "Duplicate",
          accountType: "PAGE",
          status: "CONNECTED",
          scopes: [],
          connectedById: accountA.connectedById,
        },
      }),
    ).rejects.toThrow();
  });

  it("refuses two attempts with the same number for one target", async () => {
    const { user, clientA, accountA } = await makeTwoClientsWithAccounts();
    const db = testDb();

    const { id } = await createPost({
      clientId: clientA.id,
      baseCaption: "Attempts",
      mediaAssetIds: [],
      targets: [{ socialAccountId: accountA.id }],
      authorId: user.id,
    });

    const target = await db.postTarget.findFirst({ where: { postId: id } });

    await db.publishingAttempt.create({
      data: { postTargetId: target!.id, attemptNo: 1, requestId: "r1" },
    });

    await expect(
      db.publishingAttempt.create({
        data: { postTargetId: target!.id, attemptNo: 1, requestId: "r2" },
      }),
    ).rejects.toThrow();
  });
});
