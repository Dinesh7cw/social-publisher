# Known limitations

Deliberate scope decisions and honest gaps, so nobody is surprised later.

---

## 1. Not verified against live platforms

**No adapter in this build has published to a real account.** There are no Meta, LinkedIn or X
credentials in this repository or its environment.

Every adapter is unit-tested against mocked responses that model the documented shapes, including the
quirks that break naive implementations. That proves the code is shaped correctly. It does not prove the
integration works.

Each platform stays behind `FACEBOOK_ENABLED` / `INSTAGRAM_ENABLED` / `LINKEDIN_ENABLED` / `X_ENABLED`,
default `false`. The Social accounts screen shows which are unavailable and why.

Completing verification is a documented, repeatable procedure: `docs/TEST-REPORT.md` §7.

---

## 2. External approval blockers

These are not bugs. They are gates only a human at CW can pass.

| Platform | Blocker | Consequence |
| --- | --- | --- |
| LinkedIn organisation posting | `w_organization_social` requires the **Community Management API**, which LinkedIn reviews manually (typically weeks, sometimes months) | Organisation posting cannot work until approved. Member posting is available sooner. |
| Meta (Facebook + Instagram) | **App Review** for `pages_manage_posts`, `instagram_content_publish`, `pages_manage_engagement` | Until approved, only users with a role on the Meta app can authorise it |
| Instagram | **Page Publishing Authorization (PPA)** may be required on the Page | The API cannot detect PPA, so publishing can fail with an opaque error. Must be completed manually in Page Settings. |
| Instagram | Requires media on a **publicly reachable URL** | A private-only bucket makes Instagram publishing impossible. This build creates a public projection. |
| X | Pay-per-use credits; a post containing a URL costs materially more than a plain post | Costs must be funded and reconciled |

---

## 3. Features deliberately not built

| Feature | Why | What exists instead |
| --- | --- | --- |
| **Video publishing** | Each platform needs different upload/transcode flows and extra permissions (`publish_video`, chunked uploads, async processing) | Every adapter refuses video with a clear message. The schema and storage support video; the adapters do not publish it. |
| **Analytics / insights** | The brief defers it, and it needs additional per-platform permissions | Publishing history records platform post ids and URLs, which is the prerequisite for adding insights later |
| **Media upload in the composer UI** | The backend pipeline is complete (presign, magic-byte validation, EXIF stripping, public projection), but the composer does not yet expose a file picker | `POST /api/media/presign` and `POST /api/media/:id/finalize` are implemented and tested; the UI wiring is the remaining piece |
| **Editing a scheduled post's time from the calendar** | Cancel works; reschedule does not have its own control | Cancel and re-create. A dedicated reschedule endpoint is the natural next step. |
| **Bulk actions** | Not needed at CW's volume | One post, many accounts is already one action |
| **Client-facing logins** | Out of scope by the brief | — |
| **Real-time status updates** | Polling is adequate for this cadence | The history page has a Refresh control |
| **Draft autosave** | The composer keeps the draft server-side once submitted | An unsaved caption is lost on navigation; submit a draft first |

---

## 4. Behaviour worth understanding

### `UNKNOWN` is not a failure
When a connection drops after a publish request is sent, the platform may or may not have the post. The
system records `UNKNOWN` and **refuses to auto-retry**, because a blind retry is how an audience sees
the same post twice. A human must look at the account and confirm.

### Posts are never "probably published"
A post is marked `PUBLISHED` only when every target has a platform-confirmed id. A timeout, an
unparseable response, or a 2xx without an id does not count.

### Validation blocks the whole batch
If one of four targets fails validation, **nothing is enqueued** for any of them. This is intentional: a
post that goes out to three platforms and fails silently on the fourth is worse than one held back with
the reason shown.

### Archived clients keep their history
Archiving hides a client from the composer but never deletes posts, targets or attempts. Archiving is
refused while the client has work queued or publishing.

### One account, one client
`unique(platform, externalId)` makes it impossible to attach the same page to two clients. This is the
single most effective guard against posting the wrong brand's content.

### Retry budget
Transient failures retry automatically up to `PUBLISH_MAX_ATTEMPTS` (default 5) with exponential backoff
and jitter, honouring `Retry-After` when the platform sends it. After the budget is exhausted the target
stays retryable by hand — it is never silently promoted to permanent.

---

## 5. Constraints of this environment

| Constraint | Impact |
| --- | --- |
| No platform credentials | No live publishing (§1) |
| No VPS or domain | Deployment is documented and validated but not executed |
| MinIO images are no longer publicly pullable | Development storage uses RustFS, which speaks the same S3 API. Production can use AWS S3, R2, B2 or MinIO without a code change. |
| Non-default ports | 3000/5432/56379 are occupied by other local projects, so this stack uses 3010/55440/56390/9010 |
| Windows development host | Containers hold the data; the app and worker run natively for fast iteration |

---

## 6. Technical debt

Honest list, in rough priority order.

1. **Composer media picker** — the backend is done; the UI is not. This is the largest gap between "the
   pipeline works" and "the team can use it end to end".
2. **Reschedule control** — cancel-and-recreate works; a dedicated flow would be better.
3. **Video** — refused everywhere rather than half-implemented. Correct for now, a real limitation.
4. **Instagram carousel aspect-ratio validation** — Instagram crops carousel images to the first image's
   ratio. The composer does not warn about this yet.
5. **X character counting** — implemented for text and URLs. Emoji and complex scripts are approximated
   by code-point doubling, which matches X in most cases but is not the full official algorithm.
6. **`$executeRawUnsafe` in the dev cleanup script** — returns a row count that does not match
   expectations in this Prisma version. Used only in a development-only script; the production code path
   uses typed Prisma calls.
7. **No token re-encryption utility** — rotating `TOKEN_ENCRYPTION_KEY` currently requires reconnecting
   every account. The envelope format supports rotation (versioned, keyed); the migration script does
   not exist yet.
