/**
 * Audit logging.
 *
 * Every meaningful action is recorded with its actor and a before/after pair.
 * Metadata is redacted before it reaches the database: an audit table is read by
 * more people than a secrets table, so it must be safe by construction rather
 * than by reviewer discipline.
 */

import { prisma } from "@/server/db";
import { hashIdentifier } from "@/lib/crypto";
import type { AuditAction } from "@/generated/prisma/enums";

/** Keys whose values must never be persisted in an audit entry. */
const REDACTED_KEYS = new Set([
  "accesstoken",
  "refreshtoken",
  "token",
  "authorization",
  "password",
  "passwordhash",
  "secret",
  "clientsecret",
  "code",
  "codeverifier",
  "cookie",
  "setcookie",
  "apikey",
  "cipher",
  "accessTokenCipher",
  "refreshTokenCipher",
]);

function isSecretKey(key: string): boolean {
  const normalised = key.toLowerCase().replace(/[_-]/g, "");
  for (const banned of REDACTED_KEYS) {
    if (normalised.includes(banned.toLowerCase().replace(/[_-]/g, ""))) return true;
  }
  return false;
}

/** Deep-copy a metadata object with every secret-looking value replaced. */
export function redact<T>(value: T, depth = 0): T {
  if (depth > 8) return "[truncated]" as unknown as T;
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value;
  if (typeof value !== "object") return value;
  if (value instanceof Date) return value;

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => redact(item, depth + 1)) as unknown as T;
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSecretKey(key) ? "[redacted]" : redact(item, depth + 1);
  }
  return out as unknown as T;
}

export interface AuditInput {
  actorId: string | null;
  action: AuditAction;
  entityType: string;
  entityId: string;
  clientId?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

export async function recordAudit(input: AuditInput): Promise<void> {
  await prisma.auditLog.create({
    data: {
      actorId: input.actorId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      clientId: input.clientId ?? null,
      metadata: redact(input.metadata ?? {}) as object,
      ipHash: input.ip ? hashIdentifier(input.ip) : null,
    },
  });
}

/**
 * Audit writes must never break the action they describe. A failed audit insert
 * is logged and swallowed: losing an audit line is bad, but failing a publish
 * because of it is worse, and the publishing attempt table is the real record.
 */
export async function recordAuditSafe(input: AuditInput): Promise<void> {
  try {
    await recordAudit(input);
  } catch (error) {
    console.error("[audit] failed to record entry", {
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      error: error instanceof Error ? error.message : "unknown",
    });
  }
}
