/**
 * Structured logging with redaction.
 *
 * Log lines are the most likely place for a token to escape: an adapter logs an
 * error object, the object happens to contain the request headers, and the token
 * lands in a log aggregator. The redaction here works on the serialised output,
 * so it catches secrets regardless of how deeply they were nested.
 */

import pino from "pino";

import { env, isProduction } from "@/lib/env";

const SECRET_KEY_PATTERN =
  /(access_?token|refresh_?token|token|authorization|password|passwordHash|secret|client_?secret|api_?key|cookie|code_?verifier|cipher)/i;

/** Walk a value and replace anything that looks like a credential. */
function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 10) return "[depth-limit]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    // Redact anything that looks like a bearer token inside a message.
    return value.replace(/Bearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi, "Bearer [redacted]");
  }
  if (typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: value.name, message: redactValue(value.message, depth + 1) };
  }

  if (Array.isArray(value)) {
    return value.slice(0, 40).map((item) => redactValue(item, depth + 1));
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY_PATTERN.test(key) ? "[redacted]" : redactValue(item, depth + 1);
  }
  return out;
}

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (isProduction() ? "info" : "debug"),
  base: { service: "cw-social" },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "*.accessToken",
      "*.refreshToken",
      "*.password",
      "*.secret",
    ],
    censor: "[redacted]",
  },
  formatters: {
    log(object) {
      return redactValue(object) as Record<string, unknown>;
    },
  },
  // Human-readable in development, JSON in production for the log collector.
  ...(isProduction() || env().NODE_ENV === "test"
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname,service" },
        },
      }),
});

/** Child logger scoped to a unit of work. */
export function scopedLogger(bindings: Record<string, string | number | undefined>) {
  return logger.child(bindings);
}
