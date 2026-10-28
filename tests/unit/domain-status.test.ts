import { describe, expect, it } from "vitest";

import {
  derivePostStatus,
  isEditablePostStatus,
  isRetryable,
  type TargetStatusId,
} from "@/lib/domain";

const T = (statuses: TargetStatusId[], overrides: Partial<Parameters<typeof derivePostStatus>[0]> = {}) =>
  derivePostStatus({
    targetStatuses: statuses,
    isDraft: false,
    hasSchedule: false,
    ...overrides,
  });

describe("derivePostStatus", () => {
  it("treats a post with no targets as a draft", () => {
    expect(T([])).toBe("DRAFT");
  });

  it("never reports PUBLISHED before every target confirms", () => {
    expect(T(["PUBLISHED", "PUBLISHED", "QUEUED"])).not.toBe("PUBLISHED");
    expect(T(["PUBLISHED", "PUBLISHING"])).not.toBe("PUBLISHED");
  });

  it("reports PUBLISHED only when all targets are published", () => {
    expect(T(["PUBLISHED", "PUBLISHED", "PUBLISHED"])).toBe("PUBLISHED");
  });

  it("reports SCHEDULED while every target is still queued", () => {
    expect(T(["QUEUED", "QUEUED"], { hasSchedule: true })).toBe("SCHEDULED");
  });

  it("reports PUBLISHING once any target has started", () => {
    expect(T(["QUEUED", "PUBLISHING"])).toBe("PUBLISHING");
    expect(T(["PUBLISHED", "PUBLISHING"])).toBe("PUBLISHING");
  });

  it("reports PARTIAL when some succeeded and the rest failed", () => {
    expect(T(["PUBLISHED", "FAILED_PERMANENT"])).toBe("PARTIAL");
    expect(T(["PUBLISHED", "FAILED_RETRYABLE"])).toBe("PARTIAL");
    expect(T(["PUBLISHED", "UNKNOWN"])).toBe("PARTIAL");
    expect(T(["PUBLISHED", "CANCELLED"])).toBe("PARTIAL");
  });

  it("reports FAILED when nothing published and everything failed", () => {
    expect(T(["FAILED_PERMANENT", "FAILED_PERMANENT"])).toBe("FAILED");
    expect(T(["FAILED_RETRYABLE"])).toBe("FAILED");
    expect(T(["UNKNOWN"])).toBe("FAILED");
  });

  it("reports CANCELLED when the post was cancelled outright", () => {
    expect(T(["CANCELLED", "CANCELLED"], { cancelled: true })).toBe("CANCELLED");
    expect(T(["PUBLISHED", "CANCELLED"], { cancelled: true })).toBe("CANCELLED");
  });

  it("keeps a mixed terminal state as FAILED rather than inventing a status", () => {
    expect(T(["CANCELLED", "SKIPPED"])).toBe("FAILED");
  });

  it("is order-independent", () => {
    const a = T(["PUBLISHED", "FAILED_PERMANENT", "PUBLISHING"]);
    const b = T(["FAILED_PERMANENT", "PUBLISHING", "PUBLISHED"]);
    expect(a).toBe(b);
  });
});

describe("retry eligibility", () => {
  it("allows retry for retryable, permanent and unknown failures", () => {
    expect(isRetryable("FAILED_RETRYABLE")).toBe(true);
    expect(isRetryable("FAILED_PERMANENT")).toBe(true);
    expect(isRetryable("UNKNOWN")).toBe(true);
  });

  it("refuses retry for published, in-flight and cancelled targets", () => {
    expect(isRetryable("PUBLISHED")).toBe(false);
    expect(isRetryable("PUBLISHING")).toBe(false);
    expect(isRetryable("QUEUED")).toBe(false);
    expect(isRetryable("CANCELLED")).toBe(false);
    expect(isRetryable("PENDING")).toBe(false);
    expect(isRetryable("SKIPPED")).toBe(false);
  });
});

describe("editability", () => {
  it("allows editing drafts, scheduled and failed posts", () => {
    expect(isEditablePostStatus("DRAFT")).toBe(true);
    expect(isEditablePostStatus("SCHEDULED")).toBe(true);
    expect(isEditablePostStatus("FAILED")).toBe(true);
    expect(isEditablePostStatus("PARTIAL")).toBe(true);
  });

  it("refuses editing a published or in-flight post", () => {
    expect(isEditablePostStatus("PUBLISHED")).toBe(false);
    expect(isEditablePostStatus("PUBLISHING")).toBe(false);
    expect(isEditablePostStatus("CANCELLED")).toBe(false);
  });
});
