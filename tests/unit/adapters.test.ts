import { afterEach, describe, expect, it } from "vitest";

import { LinkedInAdapter } from "@/server/platforms/linkedin/adapter";
import { FacebookAdapter } from "@/server/platforms/facebook/adapter";
import { XAdapter } from "@/server/platforms/x/adapter";
import { InstagramAdapter } from "@/server/platforms/instagram/adapter";
import type { PublishRequest } from "@/server/platforms/types";
import { isInternetReachable } from "@/server/platforms/validation";
import { emptyResponse, jsonResponse, stubFetch, type FetchStub } from "../helpers/fetch";

let stub: FetchStub | null = null;

afterEach(() => {
  stub?.restore();
  stub = null;
});

function imageMedia(): PublishRequest["media"] {
  return [
    {
      id: "m1",
      kind: "IMAGE",
      mimeType: "image/jpeg",
      byteSize: 120_000,
      width: 1080,
      height: 1080,
      durationSeconds: null,
      storageKey: "client/a/m1.jpg",
      publicUrl: "https://media.test/a/m1.jpg",
    },
  ];
}

function baseRequest(overrides: Partial<PublishRequest> = {}): PublishRequest {
  return {
    targetId: "t1",
    postId: "p1",
    platform: "LINKEDIN",
    caption: "A launch announcement",
    linkUrl: null,
    media: [],
    accessToken: "token-value",
    externalId: "12345",
    accountType: "ORGANIZATION",
    requestId: "req-1",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// LinkedIn
// ---------------------------------------------------------------------------

describe("LinkedIn adapter", () => {
  it("reads the post id from the x-restli-id header, not the body", async () => {
    // The body is empty: only the header carries the id. An implementation that
    // reads body.id reports failure here.
    stub = stubFetch(() =>
      emptyResponse(201, { "x-restli-id": "urn:li:share:6844785523593134080" }),
    );

    const result = await new LinkedInAdapter().publish(baseRequest());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.platformPostId).toBe("urn:li:share:6844785523593134080");
      expect(result.platformPostUrl).toContain("linkedin.com/feed/update");
    }
  });

  it("sends both required protocol headers", async () => {
    stub = stubFetch(() => emptyResponse(201, { "x-restli-id": "urn:li:share:1" }));

    await new LinkedInAdapter().publish(baseRequest());

    const call = stub.calls[0]!;
    expect(call.headers["Linkedin-Version"]).toBe("202601");
    expect(call.headers["X-Restli-Protocol-Version"]).toBe("2.0.0");
  });

  it("uses an organization URN for an organization account", async () => {
    stub = stubFetch(() => emptyResponse(201, { "x-restli-id": "urn:li:share:1" }));

    await new LinkedInAdapter().publish(
      baseRequest({ accountType: "ORGANIZATION", externalId: "5515715" }),
    );

    const body = stub.calls[0]!.json() as { author: string };
    expect(body.author).toBe("urn:li:organization:5515715");
  });

  it("uses a person URN for a member account", async () => {
    stub = stubFetch(() => emptyResponse(201, { "x-restli-id": "urn:li:share:2" }));

    await new LinkedInAdapter().publish(
      baseRequest({ accountType: "MEMBER", externalId: "abc123" }),
    );

    const body = stub.calls[0]!.json() as { author: string };
    expect(body.author).toBe("urn:li:person:abc123");
  });

  it("reports ambiguous when LinkedIn returns 201 without the header", async () => {
    stub = stubFetch(() => emptyResponse(201));

    const result = await new LinkedInAdapter().publish(baseRequest());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.errorClass).toBe("ambiguous");
  });

  it("classifies 400 as permanent", async () => {
    stub = stubFetch(() => jsonResponse({ message: "Invalid commentary" }, 400));

    const result = await new LinkedInAdapter().publish(baseRequest());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.errorClass).toBe("permanent");
      expect(result.error.message).toContain("Invalid commentary");
    }
  });

  it("classifies 401 as auth so a refresh is attempted", async () => {
    stub = stubFetch(() => jsonResponse({ message: "Invalid access token" }, 401));

    const result = await new LinkedInAdapter().publish(baseRequest());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.errorClass).toBe("auth");
  });

  it("uploads an image before creating the post", async () => {
    stub = stubFetch((call) => {
      if (call.url.includes("action=initializeUpload")) {
        return jsonResponse({
          value: { uploadUrl: "https://upload.test/abc", image: "urn:li:image:XYZ" },
        });
      }
      if (call.url === "https://upload.test/abc") {
        return emptyResponse(201);
      }
      if (call.url.endsWith("/rest/posts")) {
        return emptyResponse(201, { "x-restli-id": "urn:li:share:9" });
      }
      return jsonResponse({}, 200);
    });

    // The adapter reads image bytes from the public URL first.
    const result = await new LinkedInAdapter().publish(
      baseRequest({ media: imageMedia() }),
    );

    expect(result.ok).toBe(true);

    // Order: fetch bytes → initialise → PUT → create post.
    const urls = stub.calls.map((c) => c.url);
    const initIndex = urls.findIndex((u) => u.includes("initializeUpload"));
    const postsIndex = urls.findIndex((u) => u.endsWith("/rest/posts"));
    expect(initIndex).toBeGreaterThanOrEqual(0);
    expect(postsIndex).toBeGreaterThan(initIndex);

    const postBody = stub.calls[postsIndex]!.json() as {
      content?: { media?: { id?: string } };
    };
    expect(postBody.content?.media?.id).toBe("urn:li:image:XYZ");
  });
});

// ---------------------------------------------------------------------------
// Facebook
// ---------------------------------------------------------------------------

describe("Facebook adapter", () => {
  it("publishes a text post and returns the post id", async () => {
    stub = stubFetch(() => jsonResponse({ id: "12345_67890" }));

    const result = await new FacebookAdapter().publish(
      baseRequest({ platform: "FACEBOOK", accountType: "PAGE", externalId: "12345" }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.platformPostId).toBe("12345_67890");
      expect(result.platformPostUrl).toBe("https://www.facebook.com/12345_67890");
    }
  });

  it("passes a link parameter when the caption contains a URL", async () => {
    stub = stubFetch(() => jsonResponse({ id: "1_2" }));

    await new FacebookAdapter().publish(
      baseRequest({
        platform: "FACEBOOK",
        accountType: "PAGE",
        externalId: "1",
        caption: "Read more at https://colorwhistle.com/blog",
      }),
    );

    const body = stub.calls[0]!.json() as { link?: string };
    expect(body.link).toBe("https://colorwhistle.com/blog");
  });

  it("publishes a photo using the public URL", async () => {
    stub = stubFetch(() => jsonResponse({ id: "photo1", post_id: "9_9" }));

    const result = await new FacebookAdapter().publish(
      baseRequest({
        platform: "FACEBOOK",
        accountType: "PAGE",
        externalId: "9",
        media: imageMedia(),
      }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.platformPostId).toBe("9_9");

    const body = stub.calls[0]!.json() as { url?: string };
    expect(body.url).toBe("https://media.test/a/m1.jpg");
  });

  it("refuses video with a clear message rather than a confusing API error", async () => {
    const result = await new FacebookAdapter().publish(
      baseRequest({
        platform: "FACEBOOK",
        accountType: "PAGE",
        externalId: "9",
        media: [{ ...imageMedia()[0]!, kind: "VIDEO", mimeType: "video/mp4" }],
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VIDEO_NOT_ENABLED");
      expect(result.error.userMessage).toMatch(/not enabled/i);
    }
  });

  it("reports ambiguous when Meta returns no post id", async () => {
    stub = stubFetch(() => jsonResponse({}));

    const result = await new FacebookAdapter().publish(
      baseRequest({ platform: "FACEBOOK", accountType: "PAGE", externalId: "9" }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.errorClass).toBe("ambiguous");
  });
});

// ---------------------------------------------------------------------------
// Instagram
// ---------------------------------------------------------------------------

describe("Instagram adapter", () => {
  it("runs quota check, container, then publish in that order", async () => {
    stub = stubFetch((call) => {
      if (call.url.includes("content_publishing_limit")) {
        return jsonResponse({ data: [{ quota_usage: 3, config: { quota_total: 100 } }] });
      }
      if (call.url.endsWith("/media")) {
        return jsonResponse({ id: "container-1" });
      }
      if (call.url.includes("container-1")) {
        return jsonResponse({ status_code: "FINISHED" });
      }
      if (call.url.includes("media_publish")) {
        return jsonResponse({ id: "ig-media-1" });
      }
      return jsonResponse({});
    });

    const result = await new InstagramAdapter().publish(
      baseRequest({
        platform: "INSTAGRAM",
        accountType: "IG_PROFESSIONAL",
        externalId: "17841400000",
        media: imageMedia(),
      }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.platformPostId).toBe("ig-media-1");

    const urls = stub.calls.map((c) => c.url);
    expect(urls[0]).toContain("content_publishing_limit");

    const containerIndex = urls.findIndex((u) => u.endsWith("/media"));
    const publishIndex = urls.findIndex((u) => u.includes("media_publish"));
    expect(containerIndex).toBeGreaterThan(0);
    expect(publishIndex).toBeGreaterThan(containerIndex);
  });

  it("refuses a text-only post because Instagram cannot publish one", async () => {
    const result = await new InstagramAdapter().publish(
      baseRequest({
        platform: "INSTAGRAM",
        accountType: "IG_PROFESSIONAL",
        externalId: "17841400000",
        media: [],
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("MEDIA_REQUIRED");
  });

  it("refuses to publish when the 24h quota is exhausted", async () => {
    stub = stubFetch(() =>
      jsonResponse({ data: [{ quota_usage: 100, config: { quota_total: 100 } }] }),
    );

    const result = await new InstagramAdapter().publish(
      baseRequest({
        platform: "INSTAGRAM",
        accountType: "IG_PROFESSIONAL",
        externalId: "17841400000",
        media: imageMedia(),
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("QUOTA_EXHAUSTED");
      expect(result.error.userMessage).toMatch(/24-hour/i);
    }
  });

  it("builds one child container per carousel item, then a parent", async () => {
    stub = stubFetch((call) => {
      if (call.url.includes("content_publishing_limit")) {
        return jsonResponse({ data: [{ quota_usage: 0, config: { quota_total: 100 } }] });
      }
      if (call.url.includes("media_publish")) {
        return jsonResponse({ id: "ig-carousel-1" });
      }
      if (call.url.endsWith("/media")) {
        const body = call.json() as { media_type?: string };
        if (body.media_type === "CAROUSEL") return jsonResponse({ id: "parent-1" });
        return jsonResponse({ id: `child-${stub?.calls.length ?? 0}` });
      }
      // container status
      return jsonResponse({ status_code: "FINISHED" });
    });

    const result = await new InstagramAdapter().publish(
      baseRequest({
        platform: "INSTAGRAM",
        accountType: "IG_PROFESSIONAL",
        externalId: "17841400000",
        media: [
          { ...imageMedia()[0]!, id: "a" },
          { ...imageMedia()[0]!, id: "b" },
        ],
      }),
    );

    expect(result.ok).toBe(true);

    const mediaCalls = stub.calls.filter((c) => c.url.endsWith("/media"));
    const parentCall = mediaCalls.find(
      (c) => (c.json() as { media_type?: string }).media_type === "CAROUSEL",
    );

    expect(parentCall).toBeDefined();
    const parentBody = parentCall!.json() as { children?: string };
    expect(parentBody.children).toContain(",");
  });
});

// ---------------------------------------------------------------------------
// X
// ---------------------------------------------------------------------------

describe("X adapter", () => {
  it("publishes a text post and builds the status URL", async () => {
    stub = stubFetch(() => jsonResponse({ data: { id: "171234567890" } }, 201));

    const result = await new XAdapter().publish(
      baseRequest({ platform: "X", accountType: "X_ACCOUNT", externalId: "999" }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.platformPostId).toBe("171234567890");
      expect(result.platformPostUrl).toBe("https://x.com/i/web/status/171234567890");
    }
  });

  it("rejects a caption longer than 280 characters before any network call", () => {
    const result = new XAdapter().validate({
      caption: "a".repeat(281),
      media: [],
      accountType: "X_ACCOUNT",
    });

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("CAPTION_TOO_LONG");
  });

  it("counts every URL as 23 characters, not its real length", () => {
    const caption = `${"a".repeat(200)} https://colorwhistle.com/a/very/long/path/that/is/long`;
    const result = new XAdapter().validate({ caption, media: [], accountType: "X_ACCOUNT" });

    // 200 + space + 23 = 224, under 280.
    expect(result.ok).toBe(true);
  });

  it("refuses video with a clear reason", async () => {
    const result = await new XAdapter().publish(
      baseRequest({
        platform: "X",
        accountType: "X_ACCOUNT",
        media: [{ ...imageMedia()[0]!, kind: "VIDEO", mimeType: "video/mp4" }],
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VIDEO_NOT_ENABLED");
  });

  it("uploads media before creating the post", async () => {
    stub = stubFetch((call) => {
      if (call.url.includes("/media/upload")) {
        return jsonResponse({ data: { id: "media-77" } });
      }
      return jsonResponse({ data: { id: "tweet-1" } }, 201);
    });

    const result = await new XAdapter().publish(
      baseRequest({ platform: "X", accountType: "X_ACCOUNT", media: imageMedia() }),
    );

    expect(result.ok).toBe(true);

    const urls = stub.calls.map((c) => c.url);
    expect(urls.findIndex((u) => u.includes("/media/upload"))).toBe(0);
    expect(urls.findIndex((u) => u.endsWith("/2/tweets"))).toBe(1);

    const tweetBody = stub.calls[1]!.json() as { media?: { media_ids?: string[] } };
    expect(tweetBody.media?.media_ids).toEqual(["media-77"]);
  });
});

// ---------------------------------------------------------------------------
// Media reachability
// ---------------------------------------------------------------------------

describe("media the platform must download", () => {
  it("tells localhost and private addresses apart from real domains", () => {
    for (const url of [
      "http://localhost:9010/bucket/a.jpg",
      "http://127.0.0.1/a.jpg",
      "http://192.168.1.20/a.jpg",
      "http://10.0.0.5/a.jpg",
      "http://172.20.0.2/a.jpg",
      "http://[::1]/a.jpg",
      "http://nas.local/a.jpg",
    ]) {
      expect(isInternetReachable(url), url).toBe(false);
    }

    for (const url of [
      "https://media.colorwhistle.com/a.jpg",
      "https://fdomain.com/a.jpg",
      "https://abc.trycloudflare.com/a.jpg",
      "http://172.32.0.1/a.jpg",
    ]) {
      expect(isInternetReachable(url), url).toBe(true);
    }
  });

  it("blocks an Instagram post whose image only exists on localhost", () => {
    const [image] = imageMedia();
    const result = new InstagramAdapter().validate({
      caption: "Hello",
      media: [{ ...image!, publicUrl: "http://localhost:9010/cw-social-public/a.jpg" }],
      accountType: "IG_PROFESSIONAL",
    });

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("MEDIA_NOT_REACHABLE");
  });
});

