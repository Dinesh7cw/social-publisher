/**
 * Idempotency for operations that must not run twice.
 *
 * Publishing, retrying and duplicating are the operations where a double submit
 * has a real-world consequence: a second post on a client's page. The unique
 * constraint on (key, userId, operation) turns a replay into a database conflict
 * instead of a duplicate action.
 *
 * The flow is deliberately simple rather than a full request-replay cache:
 * claim the key first, and if the claim fails return the stored response. That is
 * enough for a form double-submit, and it never leaves a key claimed with no
 * action recorded because the caller completes it in the same request.
 */

import { prisma } from "@/server/db";
import { ApiError } from "@/server/http";

const TTL_MS = 10 * 60 * 1000; // 10 minutes

export type IdempotentOutcome<T> =
  | { replayed: false; run: () => Promise<T> }
  | { replayed: true; body: unknown };

/**
 * Claim an idempotency key and, if it is new, run the action.
 *
 * If the key was already used, the previously stored response is returned so the
 * caller behaves exactly as it did the first time.
 */
export async function withIdempotency<T>(params: {
  key: string;
  userId: string;
  operation: string;
  entityId: string;
  action: () => Promise<T>;
  /** Status code to remember for the replay. */
  successStatus?: number;
}): Promise<{ replayed: boolean; result: T | null; stored: unknown }> {
  // Opportunistic cleanup keeps the table small without a separate cron.
  await prisma.idempotencyRecord
    .deleteMany({ where: { expiresAt: { lt: new Date() } } })
    .catch(() => undefined);

  try {
    await prisma.idempotencyRecord.create({
      data: {
        key: params.key,
        userId: params.userId,
        operation: params.operation,
        entityId: params.entityId,
        responseStatus: params.successStatus ?? 202,
        expiresAt: new Date(Date.now() + TTL_MS),
      },
    });
  } catch (error) {
    // Unique violation: this key was already claimed.
    if (isUniqueViolation(error)) {
      const existing = await prisma.idempotencyRecord.findUnique({
        where: {
          key_userId_operation: {
            key: params.key,
            userId: params.userId,
            operation: params.operation,
          },
        },
      });

      // A record pointing at a different entity means the client reused a key
      // for a different post. That is a genuine conflict, not a replay.
      if (existing && existing.entityId !== params.entityId) {
        throw new ApiError(
          "IDEMPOTENCY_CONFLICT",
          "This request key was already used for a different post. Refresh and try again.",
        );
      }

      return { replayed: true, result: null, stored: existing?.responseBody ?? null };
    }

    throw error;
  }

  const result = await params.action();
  return { replayed: false, result, stored: null };
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === "P2002";
}
