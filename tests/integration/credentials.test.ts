import { describe, expect, it } from "vitest";

import { testDb, makeUser } from "../setup/db";
import {
  allCredentialStatuses,
  credentialStatus,
  removeAppCredentials,
  resolveAppCredentials,
  saveAppCredentials,
} from "@/server/services/platform-credentials";
import { isPlatformAvailable, platformStatus } from "@/server/platforms/registry";

/**
 * Platform app credentials are the gate on connecting any account, and the one
 * place in the app where a secret is entered by hand. The tests that matter:
 * the secret is stored encrypted, it never leaves in a status payload, and
 * saving one actually makes the platform connectable.
 */

const APP_ID = "1234567890123456";
const APP_SECRET = "s3cr3t-value-that-must-not-leak";

describe("platform app credentials", () => {
  it("starts with nothing configured", async () => {
    const statuses = await allCredentialStatuses();

    expect(statuses).toHaveLength(4);
    expect(statuses.every((status) => !status.configured)).toBe(true);
    expect(await isPlatformAvailable("FACEBOOK")).toBe(false);
    expect((await platformStatus("FACEBOOK")).reason).toBe("not_configured");
  });

  it("stores the secret encrypted, not as plaintext", async () => {
    const { user } = await makeUser();

    await saveAppCredentials({
      platform: "FACEBOOK",
      appId: APP_ID,
      appSecret: APP_SECRET,
      actorId: user.id,
    });

    const row = await testDb().platformCredential.findUniqueOrThrow({
      where: { platform: "FACEBOOK" },
    });

    expect(row.appId).toBe(APP_ID);
    expect(row.appSecretCipher).not.toContain(APP_SECRET);
    expect(row.appSecretCipher.startsWith("v1.")).toBe(true);

    const resolved = await resolveAppCredentials("FACEBOOK");
    expect(resolved?.appSecret).toBe(APP_SECRET);
    expect(resolved?.source).toBe("saved");
  });

  it("never returns the secret in a status payload", async () => {
    const { user } = await makeUser();
    await saveAppCredentials({
      platform: "FACEBOOK",
      appId: APP_ID,
      appSecret: APP_SECRET,
      actorId: user.id,
    });

    const serialised = JSON.stringify(await allCredentialStatuses());

    expect(serialised).not.toContain(APP_SECRET);
    expect(serialised).not.toContain(APP_ID);
    expect(serialised).toContain("1234…3456");
  });

  it("makes the platform connectable and audit-safe once saved", async () => {
    const { user } = await makeUser();

    await saveAppCredentials({
      platform: "LINKEDIN",
      appId: "linkedin-client-id",
      appSecret: "linkedin-client-secret",
      actorId: user.id,
    });

    expect(await isPlatformAvailable("LINKEDIN")).toBe(true);

    const audit = await testDb().auditLog.findFirstOrThrow({
      where: { action: "CREDENTIALS_SAVED" },
    });
    expect(JSON.stringify(audit.metadata)).not.toContain("linkedin-client-secret");
  });

  it("rejects a missing or implausibly short secret", async () => {
    const { user } = await makeUser();

    await expect(
      saveAppCredentials({ platform: "X", appId: "id", appSecret: "", actorId: user.id }),
    ).rejects.toThrow(/secret is required/i);

    await expect(
      saveAppCredentials({ platform: "X", appId: "id", appSecret: "short", actorId: user.id }),
    ).rejects.toThrow(/too short/i);
  });

  it("replaces a saved secret rather than keeping the old one", async () => {
    const { user } = await makeUser();

    await saveAppCredentials({
      platform: "X",
      appId: "first-id",
      appSecret: "first-secret-value",
      actorId: user.id,
    });
    await saveAppCredentials({
      platform: "X",
      appId: "second-id",
      appSecret: "second-secret-value",
      actorId: user.id,
    });

    const resolved = await resolveAppCredentials("X");
    expect(resolved?.appId).toBe("second-id");
    expect(resolved?.appSecret).toBe("second-secret-value");
  });

  it("reports a saved secret as unreadable when it cannot be decrypted", async () => {
    const { user } = await makeUser();

    await testDb().platformCredential.create({
      data: {
        platform: "INSTAGRAM",
        appId: APP_ID,
        // Well-formed envelope, wrong key material.
        appSecretCipher: "v1.k1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA",
        updatedById: user.id,
      },
    });

    const status = await credentialStatus("INSTAGRAM");
    expect(status.unreadable).toBe(true);
    expect(status.configured).toBe(false);
    expect(await resolveAppCredentials("INSTAGRAM")).toBeNull();
  });

  it("removes credentials and closes the platform again", async () => {
    const { user } = await makeUser();

    await saveAppCredentials({
      platform: "FACEBOOK",
      appId: APP_ID,
      appSecret: APP_SECRET,
      actorId: user.id,
    });
    expect(await isPlatformAvailable("FACEBOOK")).toBe(true);

    await removeAppCredentials("FACEBOOK", user.id);

    expect(await isPlatformAvailable("FACEBOOK")).toBe(false);
    expect((await credentialStatus("FACEBOOK")).configured).toBe(false);
  });

  /**
   * Instagram publishing and deletion run on the Facebook app — one Meta app,
   * one consent screen. Storing the same values twice would invite a mismatch,
   * so Instagram reads the Facebook row.
   */
  describe("Instagram sharing the Facebook app", () => {
    it("resolves from the Facebook row and says so", async () => {
      const { user } = await makeUser();

      await saveAppCredentials({
        platform: "FACEBOOK",
        appId: APP_ID,
        appSecret: APP_SECRET,
        actorId: user.id,
      });

      const resolved = await resolveAppCredentials("INSTAGRAM");
      expect(resolved?.appId).toBe(APP_ID);
      expect(resolved?.appSecret).toBe(APP_SECRET);
      expect(resolved?.source).toBe("shared");

      const status = await credentialStatus("INSTAGRAM");
      expect(status.configured).toBe(true);
      expect(status.sharedWith).toBe("FACEBOOK");
      expect(await isPlatformAvailable("INSTAGRAM")).toBe(true);
    });

    it("does not share in the other direction", async () => {
      const { user } = await makeUser();

      await saveAppCredentials({
        platform: "INSTAGRAM",
        appId: APP_ID,
        appSecret: APP_SECRET,
        actorId: user.id,
      });

      // A separate Instagram row must not silently configure Facebook: they are
      // the same Meta app in practice, but pretending so would hide a real gap.
      expect(await resolveAppCredentials("FACEBOOK")).toBeNull();
      expect((await credentialStatus("FACEBOOK")).sharedWith).toBeNull();
    });

    it("prefers its own row when one exists", async () => {
      const { user } = await makeUser();

      await saveAppCredentials({
        platform: "FACEBOOK",
        appId: APP_ID,
        appSecret: APP_SECRET,
        actorId: user.id,
      });
      await saveAppCredentials({
        platform: "INSTAGRAM",
        appId: "9999999999999999",
        appSecret: "instagram-own-secret",
        actorId: user.id,
      });

      const resolved = await resolveAppCredentials("INSTAGRAM");
      expect(resolved?.appId).toBe("9999999999999999");
      expect(resolved?.source).toBe("saved");
      expect((await credentialStatus("INSTAGRAM")).sharedWith).toBeNull();
    });

    it("closes Instagram again when the Facebook app is removed", async () => {
      const { user } = await makeUser();

      await saveAppCredentials({
        platform: "FACEBOOK",
        appId: APP_ID,
        appSecret: APP_SECRET,
        actorId: user.id,
      });
      expect(await isPlatformAvailable("INSTAGRAM")).toBe(true);

      await removeAppCredentials("FACEBOOK", user.id);

      expect(await resolveAppCredentials("INSTAGRAM")).toBeNull();
      expect(await isPlatformAvailable("INSTAGRAM")).toBe(false);
    });
  });
});
