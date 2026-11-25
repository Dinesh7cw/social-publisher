import { afterEach, describe, expect, it } from "vitest";

import { facebookAdapter } from "@/server/platforms/facebook/adapter";
import { instagramAdapter } from "@/server/platforms/instagram/adapter";
import type { AppCredentials } from "@/server/platforms/types";
import { renewalDecision, RENEW_WITHIN_DAYS } from "@/server/services/refresh-meta-tokens";
import { jsonResponse, stubFetch, type FetchStub } from "../helpers/fetch";

/**
 * The Meta OAuth rules that are easy to get subtly wrong and impossible to notice
 * until something is needed months later.
 *
 * These are regression tests for a real bug: the Instagram entry point requested
 * only the publishing scopes, so an account connected there could post but could
 * never be deleted. Publishing looked fine, which is exactly why it went unseen.
 */

const CREDENTIALS: AppCredentials = { appId: "app-123", appSecret: "secret", version: "v26.0" };

function scopesOf(url: string): string[] {
  const scope = new URL(url).searchParams.get("scope") ?? "";
  return scope.split(/[,\s]+/).filter(Boolean);
}

describe("Meta consent scopes", () => {
  it("asks for instagram_manage_contents, which is what deletion requires", () => {
    for (const adapter of [facebookAdapter, instagramAdapter]) {
      const scopes = scopesOf(
        adapter.buildAuthorizeUrl({
          state: "s",
          redirectUri: "https://app.test/callback",
          credentials: CREDENTIALS,
        }),
      );

      expect(scopes).toContain("instagram_manage_contents");
      expect(scopes).toContain("instagram_manage_comments");
      expect(scopes).toContain("instagram_content_publish");
      expect(scopes).toContain("instagram_basic");
      expect(scopes).toContain("pages_show_list");
      expect(scopes).toContain("pages_read_engagement");
      expect(scopes).toContain("business_management");
    }
  });

  it("requests the same permissions whether the user starts at Facebook or Instagram", () => {
    const params = { state: "s", redirectUri: "https://app.test/cb", credentials: CREDENTIALS };

    // Meta grants the Instagram permissions only through Facebook Login, so two
    // different scope sets would mean the account's abilities depend on which tab
    // someone happened to click.
    expect(new URL(instagramAdapter.buildAuthorizeUrl(params)).searchParams.get("scope")).toBe(
      new URL(facebookAdapter.buildAuthorizeUrl(params)).searchParams.get("scope"),
    );
  });

  it("pins the app id from credentials rather than the environment", () => {
    const url = instagramAdapter.buildAuthorizeUrl({
      state: "s",
      redirectUri: "https://app.test/cb",
      credentials: { appId: "from-the-ui", appSecret: "x", version: "v26.0" },
    });

    expect(new URL(url).searchParams.get("client_id")).toBe("from-the-ui");
  });
});

/**
 * Regression for a real bug: connecting Facebook stored the Page's linked
 * Instagram account as a FACEBOOK account too, so a draft aimed at "Facebook"
 * was really aimed at an Instagram id the Pages API cannot publish to.
 */
describe("Meta account discovery", () => {
  let stub: FetchStub | null = null;
  afterEach(() => {
    stub?.restore();
    stub = null;
  });

  function stubPagesListing() {
    stub = stubFetch(() =>
      jsonResponse({
        data: [
          {
            id: "page-1",
            name: "ColorWhistle",
            access_token: "page-token",
            tasks: ["CREATE_CONTENT"],
            instagram_business_account: { id: "ig-1", username: "colorwhistle" },
          },
        ],
      }),
    );
  }

  const tokens = { accessToken: "user-token", expiresAt: null, tokenType: "Bearer" };

  it("returns only Pages when connecting Facebook", async () => {
    stubPagesListing();
    const result = await facebookAdapter.listAccounts(tokens);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.accounts.map((a) => [a.externalId, a.accountType])).toEqual([["page-1", "PAGE"]]);
  });

  it("returns only Instagram accounts when connecting Instagram", async () => {
    stubPagesListing();
    const result = await instagramAdapter.listAccounts(tokens);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.accounts.map((a) => [a.externalId, a.accountType])).toEqual([
      ["ig-1", "IG_PROFESSIONAL"],
    ]);
    // Publishing to a Page-linked Instagram account uses the Page's token.
    expect(result.accounts[0]?.accessToken).toBe("page-token");
  });
});

describe("user-token renewal policy", () => {
  const now = new Date("2026-10-28T12:00:00Z");
  const inDays = (days: number) => new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  it("renews a token that is inside the renewal window", () => {
    expect(renewalDecision(inDays(RENEW_WITHIN_DAYS - 5), now)).toBe("renew");
  });

  it("leaves a fresh token alone", () => {
    expect(renewalDecision(inDays(59), now)).toBe("skip");
  });

  it("treats an unknown expiry as worth checking", () => {
    // Accounts connected before the expiry was recorded land here; one wasted
    // call is cheaper than a silently dead token.
    expect(renewalDecision(null, now)).toBe("renew");
  });

  it("gives up on an expired token instead of retrying forever", () => {
    expect(renewalDecision(inDays(-1), now)).toBe("expired");
    // Within the last hour: effectively unusable, and Meta will refuse.
    expect(renewalDecision(inDays(0.01), now)).toBe("expired");
  });
});
