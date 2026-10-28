import { afterEach, describe, expect, it } from "vitest";

import { PlatformError } from "@/server/platforms/types";
import { platformRequest } from "@/server/platforms/http";
import { jsonResponse, stubFetch, type FetchStub } from "../helpers/fetch";

/**
 * These tests pin down the error classification, because the retry policy is
 * only correct if transient / permanent / auth / ambiguous are right.
 */

let stub: FetchStub | null = null;

afterEach(() => {
  stub?.restore();
  stub = null;
});

describe("platform HTTP error classification", () => {
  it("classifies 429 as transient and honours the retry hint", async () => {
    stub = stubFetch(() =>
      jsonResponse({ error: { message: "Too many calls" } }, 429, { "retry-after": "42" }),
    );

    const error = (await platformRequest({
      platform: "FACEBOOK",
      url: "https://example.test/x",
      requestId: "t1",
    }).catch((e) => e)) as PlatformError;

    expect(error).toBeInstanceOf(PlatformError);
    expect(error.errorClass).toBe("transient");
    expect(error.code).toBe("RATE_LIMITED");
    expect(error.retryAfterSeconds).toBe(42);
    expect(error.httpStatus).toBe(429);
  });

  it("classifies 401 as auth so a refresh is attempted", async () => {
    stub = stubFetch(() => jsonResponse({ error: { message: "Invalid token", code: 190 } }, 401));

    const error = (await platformRequest({
      platform: "FACEBOOK",
      url: "https://example.test/x",
      requestId: "t2",
    }).catch((e) => e)) as PlatformError;

    expect(error.errorClass).toBe("auth");
  });

  it("classifies 403 as permanent with a permission message", async () => {
    stub = stubFetch(() => jsonResponse({ error: { message: "Missing permission" } }, 403));

    const error = (await platformRequest({
      platform: "FACEBOOK",
      url: "https://example.test/x",
      requestId: "t3",
    }).catch((e) => e)) as PlatformError;

    expect(error.errorClass).toBe("permanent");
    expect(error.userMessage).toMatch(/permission/i);
  });

  it("classifies 5xx as transient", async () => {
    stub = stubFetch(() => jsonResponse({ error: { message: "Unavailable" } }, 503));

    const error = (await platformRequest({
      platform: "LINKEDIN",
      url: "https://example.test/x",
      requestId: "t4",
    }).catch((e) => e)) as PlatformError;

    expect(error.errorClass).toBe("transient");
  });

  it("classifies 400 as permanent — retrying cannot fix a bad request", async () => {
    stub = stubFetch(() => jsonResponse({ message: "Invalid commentary" }, 400));

    const error = (await platformRequest({
      platform: "LINKEDIN",
      url: "https://example.test/x",
      requestId: "t5",
    }).catch((e) => e)) as PlatformError;

    expect(error.errorClass).toBe("permanent");
    expect(error.message).toContain("Invalid commentary");
  });

  it("classifies a network failure during publish as ambiguous, never transient", async () => {
    stub = stubFetch(() => {
      throw new TypeError("fetch failed");
    });

    const error = (await platformRequest({
      platform: "X",
      url: "https://example.test/x",
      method: "POST",
      requestId: "t6",
      isPublish: true,
    }).catch((e) => e)) as PlatformError;

    // This is the duplicate-post hazard: the platform may already have the post.
    expect(error.errorClass).toBe("ambiguous");
    expect(error.userMessage).toMatch(/check the account/i);
  });

  it("classifies a network failure during a read as transient", async () => {
    stub = stubFetch(() => {
      throw new TypeError("fetch failed");
    });

    const error = (await platformRequest({
      platform: "X",
      url: "https://example.test/x",
      requestId: "t7",
    }).catch((e) => e)) as PlatformError;

    expect(error.errorClass).toBe("transient");
  });

  it("treats an unparseable 2xx publish body as ambiguous, not success", async () => {
    stub = stubFetch(() => new Response("<html>ok</html>", { status: 200 }));

    const error = (await platformRequest({
      platform: "FACEBOOK",
      url: "https://example.test/x",
      method: "POST",
      requestId: "t8",
      isPublish: true,
    }).catch((e) => e)) as PlatformError;

    expect(error.errorClass).toBe("ambiguous");
  });

  it("never puts the token in the error message", async () => {
    const token = "SUPER-SECRET-TOKEN-VALUE";
    stub = stubFetch(() => jsonResponse({ error: { message: "bad token" } }, 401));

    const error = (await platformRequest({
      platform: "FACEBOOK",
      url: "https://example.test/x",
      accessToken: token,
      requestId: "t9",
    }).catch((e) => e)) as PlatformError;

    expect(error.message).not.toContain(token);
    expect(error.userMessage).not.toContain(token);
    expect(JSON.stringify(error.toRecord())).not.toContain(token);
  });

  it("does not follow redirects, so a token cannot leak to another host", async () => {
    stub = stubFetch(() =>
      new Response(null, { status: 302, headers: { location: "https://evil.test" } }),
    );

    await platformRequest({
      platform: "FACEBOOK",
      url: "https://example.test/x",
      requestId: "t10",
    }).catch(() => undefined);

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]!.init.redirect).toBe("manual");
  });

  it("sends the access token as a bearer header", async () => {
    stub = stubFetch(() => jsonResponse({ ok: true }));

    await platformRequest({
      platform: "FACEBOOK",
      url: "https://example.test/x",
      accessToken: "abc123",
      requestId: "t11",
    });

    expect(stub.calls[0]!.headers.authorization).toBe("Bearer abc123");
  });
});
