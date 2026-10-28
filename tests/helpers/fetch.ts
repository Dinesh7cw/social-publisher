/**
 * Test helpers for intercepting platform HTTP calls.
 *
 * Adapters call the global fetch, so tests replace it and assert on what was
 * sent. Wrapping the mock in a typed helper avoids casting `mock.calls[0][1]`
 * at every assertion site.
 */

import { vi } from "vitest";

export interface FetchCall {
  url: string;
  init: RequestInit;
  headers: Record<string, string>;
  json: () => unknown;
}

export interface FetchStub {
  calls: FetchCall[];
  /** The first call that targeted a URL containing `fragment`. */
  find: (fragment: string) => FetchCall | undefined;
  restore: () => void;
}

const originalFetch = globalThis.fetch;

/**
 * Replace fetch with a handler that returns a Response.
 *
 * The handler receives the parsed call, so a test can switch on the URL to
 * emulate a multi-step flow (Instagram's container → publish, for example).
 */
export function stubFetch(
  handler: (call: FetchCall) => Response | Promise<Response>,
): FetchStub {
  const calls: FetchCall[] = [];

  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

    // Preserve the original header casing for assertions, while still allowing
    // case-insensitive lookup (HTTP header names are case-insensitive).
    const rawHeaders: Record<string, string> = {};
    const initHeaders = init?.headers;
    if (initHeaders instanceof Headers) {
      initHeaders.forEach((value, key) => {
        rawHeaders[key] = value;
      });
    } else if (Array.isArray(initHeaders)) {
      for (const [key, value] of initHeaders) rawHeaders[key] = String(value);
    } else if (initHeaders) {
      for (const [key, value] of Object.entries(initHeaders)) {
        if (value !== undefined) rawHeaders[key] = String(value);
      }
    }

    const lookup = new Map(Object.entries(rawHeaders).map(([k, v]) => [k.toLowerCase(), v]));
    const headers = new Proxy(rawHeaders, {
      get(target, prop: string) {
        if (prop in target) return target[prop];
        return lookup.get(prop.toLowerCase());
      },
    });
    const call: FetchCall = {
      url,
      init: init ?? {},
      headers,
      json: () => {
        const body = init?.body;
        if (typeof body !== "string") return null;
        try {
          return JSON.parse(body);
        } catch {
          return null;
        }
      },
    };

    calls.push(call);
    return handler(call);
  });

  globalThis.fetch = mock as unknown as typeof fetch;

  return {
    calls,
    find: (fragment: string) => calls.find((call) => call.url.includes(fragment)),
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

/** Build a JSON response. */
export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Build an empty response, e.g. LinkedIn's 201 that only carries a header. */
export function emptyResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}
