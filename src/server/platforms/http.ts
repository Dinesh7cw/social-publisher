/**
 * The one place platform HTTP happens.
 *
 * Centralising this means error classification is written once and behaves
 * identically for all four adapters — which matters, because the retry policy's
 * correctness depends on `ambiguous` vs `transient` vs `permanent` being right,
 * and a per-adapter guess would get it wrong in at least one place.
 *
 * Token handling: the token is passed in and used in a header. It is never
 * logged, never included in an error message, and never attached to a
 * PlatformError.
 */

import type { PlatformId } from "@/lib/domain";
import { PlatformError, type ErrorClass } from "./types";

const DEFAULT_TIMEOUT_MS = 30_000;

export interface PlatformRequest {
  platform: PlatformId;
  url: string;
  method?: "GET" | "POST" | "DELETE" | "PUT";
  /** Sent as a Bearer token unless `authHeader` overrides the format. */
  accessToken?: string;
  authHeader?: string;
  body?: string | URLSearchParams | Record<string, unknown>;
  headers?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  requestId: string;
  /**
   * True when the request is a publish action. An ambiguous failure on a
   * publish must never be retried automatically, because the platform may have
   * accepted the post before the connection dropped.
   */
  isPublish?: boolean;
}

export interface PlatformResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  json: unknown;
  text: string;
}

/**
 * Parse a platform error body into a class + code + safe message.
 *
 * Meta returns `{ error: { message, type, code, error_subcode } }`.
 * LinkedIn returns `{ message, status }` or a plain string.
 * X returns `{ title, detail, type, status }` with an optional `errors` array.
 * The parsers are deliberately defensive: an unexpected body must still produce
 * a usable message rather than a crash.
 */
function classify(
  platform: PlatformId,
  status: number,
  body: unknown,
  isPublish: boolean,
): { errorClass: ErrorClass; code: string; message: string; userMessage?: string; retryAfterSeconds: number | null } {
  const record = (body ?? {}) as Record<string, unknown>;

  // --- Pull out a platform code and message -------------------------------
  let platformCode = String(status);
  let message = `Request failed with status ${status}.`;

  const nestedError = record.error as Record<string, unknown> | undefined;
  if (nestedError && typeof nestedError === "object") {
    // Meta shape
    if (nestedError.code !== undefined) platformCode = String(nestedError.code);
    if (typeof nestedError.message === "string") message = nestedError.message;
    else if (typeof nestedError.error_user_msg === "string") message = nestedError.error_user_msg;
  } else if (typeof record.detail === "string") {
    // X shape
    message = record.detail;
    if (typeof record.type === "string") platformCode = record.type;
  } else if (typeof record.message === "string") {
    // LinkedIn shape
    message = record.message;
  } else if (typeof body === "string" && body.trim().length > 0) {
    message = body.slice(0, 500);
  }

  // --- Classify ------------------------------------------------------------
  // 429: rate limited. Retry after the platform's own hint.
  if (status === 429) {
    return {
      errorClass: "transient",
      code: "RATE_LIMITED",
      message,
      userMessage: "The platform is rate limiting us. This will retry automatically.",
      retryAfterSeconds: null,
    };
  }

  // 401 / 403: token or permission. 403 is usually a missing scope, which a
  // retry cannot fix, so it is auth (try one refresh) only for 401.
  if (status === 401) {
    return {
      errorClass: "auth",
      code: platformCode,
      message,
      userMessage: "The account's authorisation has expired. Reconnect the account.",
      retryAfterSeconds: null,
    };
  }

  if (status === 403) {
    return {
      errorClass: "permanent",
      code: platformCode,
      message,
      userMessage:
        "The platform refused this post for this account. This is usually a missing permission on the connected account.",
      retryAfterSeconds: null,
    };
  }

  // 5xx: the platform had a problem. Safe to retry.
  if (status >= 500) {
    return {
      errorClass: "transient",
      code: platformCode,
      message,
      userMessage: "The platform had a temporary problem. This will retry automatically.",
      retryAfterSeconds: null,
    };
  }

  // 4xx other than the above: our request was wrong. Retrying will not help.
  if (status >= 400) {
    return {
      errorClass: "permanent",
      code: platformCode,
      message,
      userMessage: message,
      retryAfterSeconds: null,
    };
  }

  // A 2xx that we could not interpret during a publish is genuinely ambiguous:
  // the post may exist. Never auto-retry this.
  return {
    errorClass: isPublish ? "ambiguous" : "transient",
    code: "UNEXPECTED_RESPONSE",
    message,
    userMessage: isPublish
      ? "The platform did not confirm the post. Check the account before retrying."
      : "Unexpected response from the platform.",
    retryAfterSeconds: null,
  };
}

function parseRetryAfter(headers: Headers): number | null {
  const raw = headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, Math.trunc(seconds));
  const asDate = Date.parse(raw);
  if (Number.isFinite(asDate)) return Math.max(0, Math.round((asDate - Date.now()) / 1000));
  return null;
}

export async function platformRequest(request: PlatformRequest): Promise<PlatformResponse> {
  const {
    platform,
    url,
    method = "GET",
    accessToken,
    authHeader,
    body,
    headers = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
    requestId,
    isPublish = false,
  } = request;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  // Honour an outer abort (worker shutdown) as well as our timeout.
  const onOuterAbort = () => controller.abort();
  signal?.addEventListener("abort", onOuterAbort, { once: true });

  const finalHeaders: Record<string, string> = {
    Accept: "application/json",
    ...headers,
  };

  if (accessToken) {
    finalHeaders.Authorization = authHeader ?? `Bearer ${accessToken}`;
  }

  let payload: BodyInit | undefined;
  if (body instanceof URLSearchParams) {
    payload = body.toString();
    finalHeaders["Content-Type"] = "application/x-www-form-urlencoded";
  } else if (typeof body === "string") {
    payload = body;
  } else if (body) {
    payload = JSON.stringify(body);
    finalHeaders["Content-Type"] = "application/json";
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: finalHeaders,
      body: payload,
      signal: controller.signal,
      // Never follow a redirect on an API call: a redirect here usually means a
      // misconfigured URL, and silently following it would send the token to an
      // unexpected host.
      redirect: "manual",
    });
  } catch (error) {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onOuterAbort);

    const aborted = error instanceof Error && error.name === "AbortError";

    // For a publish, a timeout or dropped connection is ambiguous: the platform
    // may have accepted the post. For a read it is simply transient.
    if (aborted || error instanceof TypeError) {
      throw new PlatformError({
        platform,
        errorClass: isPublish ? "ambiguous" : "transient",
        code: aborted ? "TIMEOUT" : "NETWORK_ERROR",
        message: aborted
          ? `Request to ${platform} timed out.`
          : `Could not reach ${platform}.`,
        userMessage: isPublish && !aborted
          ? `Could not confirm whether ${platform} received the post. Check the account before retrying.`
          : `Could not reach ${platform}. This will retry automatically.`,
      });
    }

    throw new PlatformError({
      platform,
      errorClass: "permanent",
      code: "REQUEST_FAILED",
      message: error instanceof Error ? error.message : "Unknown request failure",
    });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onOuterAbort);
  }

  const text = await response.text().catch(() => "");
  let json: unknown = null;
  if (text.length > 0) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }

  if (!response.ok) {
    const info = classify(platform, response.status, json ?? text, isPublish);
    const retryAfter = parseRetryAfter(response.headers) ?? info.retryAfterSeconds;

    throw new PlatformError({
      platform,
      errorClass: info.errorClass,
      code: info.code,
      message: info.message,
      userMessage: info.userMessage,
      httpStatus: response.status,
      retryAfterSeconds: retryAfter,
    });
  }

  // A 2xx with an unreadable body during a publish is ambiguous, not success.
  if (isPublish && text.length > 0 && json === null) {
    throw new PlatformError({
      platform,
      errorClass: "ambiguous",
      code: "UNPARSEABLE_RESPONSE",
      message: "The platform returned a successful status but an unreadable body.",
      userMessage: `Could not confirm the ${platform} post. Check the account before retrying.`,
      httpStatus: response.status,
      retryAfterSeconds: null,
    });
  }

  void requestId; // available for correlation log lines at the call site

  return {
    status: response.status,
    ok: response.ok,
    headers: response.headers,
    json,
    text,
  };
}

/** Build a query string, skipping null/undefined values. */
export function withQuery(url: string, params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs.length > 0 ? `${url}${url.includes("?") ? "&" : "?"}${qs}` : url;
}
