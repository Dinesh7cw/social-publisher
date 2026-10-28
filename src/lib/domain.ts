/**
 * Domain vocabulary shared by the server, the worker and the UI.
 *
 * These are the frozen names. Adapters, API routes and components all import
 * from here so that a status string is spelled one way in one place.
 */

export const PLATFORMS = ["FACEBOOK", "INSTAGRAM", "LINKEDIN", "X"] as const;
export type PlatformId = (typeof PLATFORMS)[number];

export const PLATFORM_LABELS: Record<PlatformId, string> = {
  FACEBOOK: "Facebook Page",
  INSTAGRAM: "Instagram",
  LINKEDIN: "LinkedIn",
  X: "X",
};

export const PLATFORM_SHORT: Record<PlatformId, string> = {
  FACEBOOK: "Facebook",
  INSTAGRAM: "Instagram",
  LINKEDIN: "LinkedIn",
  X: "X",
};

export const POST_STATUSES = [
  "DRAFT",
  "SCHEDULED",
  "PUBLISHING",
  "PUBLISHED",
  "PARTIAL",
  "FAILED",
  "CANCELLED",
] as const;
export type PostStatusId = (typeof POST_STATUSES)[number];

export const TARGET_STATUSES = [
  "PENDING",
  "QUEUED",
  "PUBLISHING",
  "PUBLISHED",
  "FAILED_RETRYABLE",
  "FAILED_PERMANENT",
  "UNKNOWN",
  "SKIPPED",
  "CANCELLED",
] as const;
export type TargetStatusId = (typeof TARGET_STATUSES)[number];

/** Targets in these states have not finished; the post is still in flight. */
export const IN_FLIGHT_TARGET_STATUSES: readonly TargetStatusId[] = [
  "PENDING",
  "QUEUED",
  "PUBLISHING",
];

/** Targets in these states will never publish without human action. */
export const TERMINAL_FAILURE_TARGET_STATUSES: readonly TargetStatusId[] = [
  "FAILED_PERMANENT",
  "UNKNOWN",
  "SKIPPED",
  "CANCELLED",
];

export const ACCOUNT_STATUSES = ["CONNECTED", "EXPIRED", "REVOKED", "ERROR"] as const;
export type AccountStatusId = (typeof ACCOUNT_STATUSES)[number];

/**
 * Derive the post status from its targets.
 *
 * This is the single implementation of the rule "never mark a post published
 * until every target confirms". It is pure so it can be unit-tested exhaustively
 * and reused by both the worker and the API.
 */
export function derivePostStatus(params: {
  targetStatuses: readonly TargetStatusId[];
  isDraft: boolean;
  hasSchedule: boolean;
  cancelled?: boolean;
}): PostStatusId {
  const { targetStatuses, isDraft, hasSchedule, cancelled } = params;

  if (cancelled) return "CANCELLED";

  if (targetStatuses.length === 0) {
    return isDraft ? "DRAFT" : "DRAFT";
  }

  const published = targetStatuses.filter((s) => s === "PUBLISHED").length;
  const inFlight = targetStatuses.filter((s) => IN_FLIGHT_TARGET_STATUSES.includes(s)).length;
  const failed = targetStatuses.filter((s) =>
    TERMINAL_FAILURE_TARGET_STATUSES.includes(s),
  ).length;

  // Anything still running wins: the post is not finished.
  if (inFlight > 0) {
    // A post that has started publishing is PUBLISHING even if it is also
    // scheduled; once every target settles we will settle on a final state.
    return published > 0 || targetStatuses.some((s) => s === "PUBLISHING")
      ? "PUBLISHING"
      : hasSchedule
        ? "SCHEDULED"
        : "DRAFT";
  }

  if (published === targetStatuses.length) return "PUBLISHED";
  if (published > 0) return "PARTIAL";
  if (failed === targetStatuses.length) return hasSchedule ? "FAILED" : "FAILED";

  // Mixed failure with no publications: still a failure.
  return "FAILED";
}

/** Human label for a target status, used in pills and the history table. */
export const TARGET_STATUS_LABEL: Record<TargetStatusId, string> = {
  PENDING: "Pending",
  QUEUED: "Queued",
  PUBLISHING: "Publishing",
  PUBLISHED: "Published",
  FAILED_RETRYABLE: "Failed — retrying",
  FAILED_PERMANENT: "Failed",
  UNKNOWN: "Needs checking",
  SKIPPED: "Skipped",
  CANCELLED: "Cancelled",
};

export const POST_STATUS_LABEL: Record<PostStatusId, string> = {
  DRAFT: "Draft",
  SCHEDULED: "Scheduled",
  PUBLISHING: "Publishing",
  PUBLISHED: "Published",
  PARTIAL: "Partly published",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
};

export type PillTone = "neutral" | "positive" | "negative" | "warning" | "accent" | "info";

export function targetStatusTone(status: TargetStatusId): PillTone {
  switch (status) {
    case "PUBLISHED":
      return "positive";
    case "FAILED_PERMANENT":
      return "negative";
    case "UNKNOWN":
      return "warning";
    case "FAILED_RETRYABLE":
      return "warning";
    case "PUBLISHING":
      return "accent";
    case "QUEUED":
      return "info";
    default:
      return "neutral";
  }
}

export function postStatusTone(status: PostStatusId): PillTone {
  switch (status) {
    case "PUBLISHED":
      return "positive";
    case "PARTIAL":
      return "warning";
    case "FAILED":
      return "negative";
    case "PUBLISHING":
      return "accent";
    case "SCHEDULED":
      return "info";
    default:
      return "neutral";
  }
}

/** A target can be retried by a human when it is in one of these states. */
export function isRetryable(status: TargetStatusId): boolean {
  return status === "FAILED_RETRYABLE" || status === "FAILED_PERMANENT" || status === "UNKNOWN";
}

/** Editable content states: a live post's caption must not change under it. */
export function isEditablePostStatus(status: PostStatusId): boolean {
  return status === "DRAFT" || status === "SCHEDULED" || status === "FAILED" || status === "PARTIAL";
}
