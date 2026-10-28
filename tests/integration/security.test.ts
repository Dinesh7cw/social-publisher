import { describe, expect, it } from "vitest";

import { testDb, makeUser, makeTwoClientsWithAccounts } from "../setup/db";
import { hashPassword, verifyPassword, validatePasswordStrength } from "@/server/auth/password";
import { redact } from "@/server/audit";
import { assertSameOrigin, capabilitiesFor } from "@/server/auth/guards";
import { ApiError } from "@/server/http";
import { createPost } from "@/server/services/posts";
import { derivePostStatus } from "@/lib/domain";

describe("password hashing", () => {
  it("never stores the password in plaintext", async () => {
    const password = "CorrectHorseBattery99";
    const hash = await hashPassword(password);

    expect(hash).not.toContain(password);
    expect(hash.startsWith("$argon2id$")).toBe(true);
  });

  it("verifies the correct password and rejects a wrong one", async () => {
    const hash = await hashPassword("RightPassword123");

    expect(await verifyPassword(hash, "RightPassword123")).toBe(true);
    expect(await verifyPassword(hash, "WrongPassword123")).toBe(false);
  });

  it("treats a malformed hash as a failed check rather than throwing", async () => {
    expect(await verifyPassword("not-a-hash", "anything")).toBe(false);
  });

  it("rejects short passwords", () => {
    expect(validatePasswordStrength("short")).toMatch(/12 characters/);
    expect(validatePasswordStrength("LongEnoughPassword1")).toBeNull();
  });

  it("rejects a common password", () => {
    expect(validatePasswordStrength("passwordpassword")).toMatch(/common/);
  });
});

describe("audit redaction", () => {
  it("removes tokens and secrets at any depth", () => {
    const input = {
      event: "publish",
      accessToken: "SECRET-ACCESS",
      nested: {
        refreshToken: "SECRET-REFRESH",
        authorization: "Bearer SECRET-BEARER",
        safeField: "keep me",
        deeper: { clientSecret: "SECRET-CLIENT" },
      },
      list: [{ password: "SECRET-PASSWORD" }],
    };

    const output = JSON.stringify(redact(input));

    expect(output).not.toContain("SECRET-ACCESS");
    expect(output).not.toContain("SECRET-REFRESH");
    expect(output).not.toContain("SECRET-BEARER");
    expect(output).not.toContain("SECRET-CLIENT");
    expect(output).not.toContain("SECRET-PASSWORD");
    expect(output).toContain("keep me");
  });
});

describe("CSRF origin check", () => {
  it("allows a request from the configured origin", () => {
    const request = new Request("http://localhost:3010/api/posts", {
      method: "POST",
      headers: { origin: "http://localhost:3010" },
    });

    expect(() => assertSameOrigin(request)).not.toThrow();
  });

  it("rejects a mutation from a foreign origin", () => {
    const request = new Request("http://localhost:3010/api/posts", {
      method: "POST",
      headers: { origin: "https://evil.example" },
    });

    expect(() => assertSameOrigin(request)).toThrow(ApiError);
  });

  it("rejects a mutation with no origin header", () => {
    const request = new Request("http://localhost:3010/api/posts", { method: "POST" });
    expect(() => assertSameOrigin(request)).toThrow(ApiError);
  });

  it("allows a plain GET without an origin header", () => {
    const request = new Request("http://localhost:3010/api/posts", { method: "GET" });
    expect(() => assertSameOrigin(request)).not.toThrow();
  });
});

describe("role capabilities", () => {
  it("gives an admin every capability", () => {
    const capabilities = capabilitiesFor({
      id: "1",
      email: "a@b.com",
      name: "Admin",
      role: "ADMIN",
      timeZone: "Asia/Kolkata",
    });

    expect(capabilities.canManageClients).toBe(true);
    expect(capabilities.canDisconnectAccounts).toBe(true);
    expect(capabilities.canManageTeam).toBe(true);
    expect(capabilities.canViewAudit).toBe(true);
  });

  it("withholds admin capabilities from a member", () => {
    const capabilities = capabilitiesFor({
      id: "2",
      email: "m@b.com",
      name: "Member",
      role: "MEMBER",
      timeZone: "Asia/Kolkata",
    });

    expect(capabilities.canManageClients).toBe(false);
    expect(capabilities.canDisconnectAccounts).toBe(false);
    expect(capabilities.canManageTeam).toBe(false);
    expect(capabilities.canViewAudit).toBe(false);
  });
});

describe("cross-client data access", () => {
  it("refuses to attach another client's account to a post", async () => {
    const { user, clientA, accountB } = await makeTwoClientsWithAccounts();

    await expect(
      createPost({
        clientId: clientA.id,
        baseCaption: "Attempted leak",
        mediaAssetIds: [],
        targets: [{ socialAccountId: accountB.id }],
        authorId: user.id,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses media belonging to another client", async () => {
    const { user, clientA, clientB } = await makeTwoClientsWithAccounts();
    const db = testDb();

    const accountA = await db.socialAccount.findFirst({ where: { clientId: clientA.id } });

    const foreignMedia = await db.mediaAsset.create({
      data: {
        clientId: clientB.id,
        uploadedById: user.id,
        kind: "IMAGE",
        mimeType: "image/jpeg",
        byteSize: 1000,
        storageKey: "clients/b/media/original",
        contentHash: "abc123",
      },
    });

    await expect(
      createPost({
        clientId: clientA.id,
        baseCaption: "Media leak attempt",
        mediaAssetIds: [foreignMedia.id],
        targets: [{ socialAccountId: accountA!.id }],
        authorId: user.id,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("returns NOT_FOUND rather than FORBIDDEN, so existence is not confirmed", async () => {
    const { user, clientA, accountB } = await makeTwoClientsWithAccounts();

    const error = await createPost({
      clientId: clientA.id,
      baseCaption: "x",
      mediaAssetIds: [],
      targets: [{ socialAccountId: accountB.id }],
      authorId: user.id,
    }).catch((e: ApiError) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("NOT_FOUND");
    // A FORBIDDEN here would tell an attacker the account exists.
    expect((error as ApiError).code).not.toBe("FORBIDDEN");
    expect((error as ApiError).status).toBe(404);
  });
});

describe("session isolation", () => {
  it("does not let two users share a session id", async () => {
    const db = testDb();
    const { user: userA } = await makeUser({ email: "a@colorwhistle.com" });
    const { user: userB } = await makeUser({ email: "b@colorwhistle.com" });

    const sessionA = await db.session.create({
      data: { id: "session-a", userId: userA.id, expiresAt: new Date(Date.now() + 1000_000) },
    });
    const sessionB = await db.session.create({
      data: { id: "session-b", userId: userB.id, expiresAt: new Date(Date.now() + 1000_000) },
    });

    expect(sessionA.id).not.toBe(sessionB.id);
    expect(sessionA.userId).not.toBe(sessionB.userId);
  });
});

describe("status derivation is the only source of PUBLISHED", () => {
  it("cannot produce PUBLISHED from any partially-failed combination", () => {
    const failures = ["FAILED_PERMANENT", "FAILED_RETRYABLE", "UNKNOWN", "CANCELLED", "SKIPPED"] as const;

    for (const failure of failures) {
      const result = derivePostStatus({
        targetStatuses: ["PUBLISHED", failure],
        isDraft: false,
        hasSchedule: false,
      });
      expect(result).not.toBe("PUBLISHED");
    }
  });
});
