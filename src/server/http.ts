/**
 * The HTTP response shape for every API route.
 *
 * One error format everywhere means the client has one place to read messages
 * from, and the codes are stable so tests can assert on them.
 */

import { NextResponse } from "next/server";
import { ZodError } from "zod";

import type { PlatformError } from "@/server/platforms/types";

export type ApiErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION_FAILED"
  | "RATE_LIMITED"
  | "PLATFORM_DISABLED"
  | "PLATFORM_AUTH_EXPIRED"
  | "TARGET_NOT_PUBLISHABLE"
  | "PLATFORM_DELETE_UNSUPPORTED"
  | "PLATFORM_DELETE_FAILED"
  | "IDEMPOTENCY_CONFLICT"
  | "CONFLICT"
  | "INTERNAL";

const STATUS_FOR_CODE: Record<ApiErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 422,
  RATE_LIMITED: 429,
  PLATFORM_DISABLED: 409,
  PLATFORM_AUTH_EXPIRED: 409,
  TARGET_NOT_PUBLISHABLE: 409,
  PLATFORM_DELETE_UNSUPPORTED: 409,
  PLATFORM_DELETE_FAILED: 502,
  IDEMPOTENCY_CONFLICT: 409,
  CONFLICT: 409,
  INTERNAL: 500,
};

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ApiErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = STATUS_FOR_CODE[code];
    this.details = details;
  }
}

export const notFound = (what = "Not found") => new ApiError("NOT_FOUND", what);
export const unauthenticated = () => new ApiError("UNAUTHENTICATED", "Please sign in to continue.");
export const forbidden = (message = "You do not have permission to do this.") =>
  new ApiError("FORBIDDEN", message);
export const invalid = (message: string, details?: unknown) =>
  new ApiError("VALIDATION_FAILED", message, details);

export function jsonOk<T>(data: T, init?: ResponseInit): NextResponse<T> {
  return NextResponse.json(data, init);
}

export function jsonError(error: unknown): NextResponse {
  if (error instanceof ApiError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message, details: error.details } },
      { status: error.status },
    );
  }

  if (error instanceof ZodError) {
    return NextResponse.json(
      {
        error: {
          code: "VALIDATION_FAILED",
          message: "Some fields need attention.",
          details: error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
      },
      { status: 422 },
    );
  }

  // Anything unexpected is logged in full server-side and reported vaguely to
  // the client: stack traces and database messages must not reach a browser.
  console.error("[api] unhandled error", error);

  return NextResponse.json(
    {
      error: {
        code: "INTERNAL",
        message: "Something went wrong on our side. Please try again.",
      },
    },
    { status: 500 },
  );
}

/**
 * Wraps a route handler so every thrown ApiError, ZodError or unexpected
 * exception becomes the standard error envelope.
 */
export function route<T extends unknown[]>(
  handler: (...args: T) => Promise<NextResponse>,
): (...args: T) => Promise<NextResponse> {
  return async (...args: T) => {
    try {
      return await handler(...args);
    } catch (error) {
      return jsonError(error);
    }
  };
}

/** Map a normalised platform failure onto an API error for the UI. */
export function fromPlatformError(error: PlatformError): ApiError {
  switch (error.errorClass) {
    case "auth":
      return new ApiError("PLATFORM_AUTH_EXPIRED", error.userMessage);
    default:
      return new ApiError("VALIDATION_FAILED", error.userMessage);
  }
}
